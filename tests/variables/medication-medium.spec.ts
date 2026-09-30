/**
 * 변수 QA - 복약 (medium)
 *
 * 부작용 차단: 모든 약은 임시 사용자에게만 만든다. 임시 사용자는 FCM 토큰도 SMS 채널도 없어서(전화번호는 미배정 국번)
 * 스케줄러가 알림을 골라도 notification_log 에 NOT_SENT 만 남고 실제 발송은 없다.
 * 화면 테스트는 복용 시각이 지금과 멀리 떨어진 약을 쓰거나, 피보호자 알림을 꺼 둔다.
 */
import { Page } from '@playwright/test';

import { expect, test } from '../../src/fixtures';
import { psql, sqlStr } from '../../src/remote';
import { connect } from '../../src/variables';

type Slot = 'MORNING' | 'LUNCH' | 'DINNER' | 'BEDTIME';

/** KST 기준 현재 시각에서 offset 만큼 이동한 시각 ("HH:MM:00")과 그 시각의 자정 이후 분 */
function kstTime(interval: string): { time: string; minutes: number } {
  const [time, minutes] = psql(
    `SELECT to_char((now() AT TIME ZONE 'Asia/Seoul') + interval '${interval}', 'HH24:MI:00') || '|' ||
            (extract(hour from (now() AT TIME ZONE 'Asia/Seoul')) * 60 + extract(minute from (now() AT TIME ZONE 'Asia/Seoul')))::int;`,
  ).split('|');
  return { time, minutes: Number(minutes) };
}

/** 지금과 6시간 떨어진 복용 시각 - 알림 유예 창(지금-30분~지금)에 절대 들지 않는다 */
function farDoseTime() {
  return kstTime('6 hours').time;
}

/** 약을 DB 로 바로 만든다 (등록 화면·API 는 흐름 테스트가 검증) */
function insertMedication(o: {
  wardId: string; createdBy: string; name: string; timeSlot?: Slot; doseTime?: string; doseAmount?: number;
}): number {
  return Number(
    psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time, dose_amount)
          VALUES (${sqlStr(o.wardId)}, ${sqlStr(o.createdBy)}, ${sqlStr(o.name)}, ${sqlStr(o.timeSlot ?? 'MORNING')},
                  ${sqlStr(o.doseTime ?? farDoseTime())}, ${o.doseAmount ?? 1}) RETURNING id;`),
  );
}

/** 피보호자에게 가는 복약 알림(최초·재알림)을 꺼 둔다. 시각 도래 때 스케줄러가 건드리지 않게 하는 용도 */
function muteWardReminders(wardId: string) {
  psql(`INSERT INTO medication_setting (user_id, alarm_enabled, remind_again_enabled)
        VALUES (${sqlStr(wardId)}, false, false)
        ON CONFLICT (user_id) DO UPDATE SET alarm_enabled = false, remind_again_enabled = false;`);
}

function reminderLogCount(medicationId: number) {
  return Number(psql(`SELECT count(*) FROM medication_reminder_log WHERE medication_id = ${medicationId} AND attempt = 1;`));
}

function reminderNotificationCount(wardId: string) {
  return Number(psql(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(wardId)} AND type = 'MEDICATION_REMINDER';`));
}

/** 보호자 복약 화면에서 한 피보호자의 카드 */
function guardianCard(page: Page, wardName: string) {
  return page.getByRole('listitem').filter({ has: page.getByText(wardName) }).first();
}

/** 화면에 실패 원인이나 안내가 떴는지 (정확한 문구는 정해져 있지 않아 넓게 본다) */
const FEEDBACK = /찾을 수 없|실패|오류|삭제된|삭제되었|권한|연결이 해제|연결되지|다시 시도|불러오지/;

/**
 * 스케줄러(1분 주기)가 통제군 약의 최초 알림을 선점할 때까지 기다린다.
 * 통제군이 끝내 안 나가면 스케줄러가 꺼진 환경이라 실험 자체가 성립하지 않는다.
 */
async function waitForScheduler(controlMedicationId: number) {
  return expect
    .poll(() => reminderLogCount(controlMedicationId), { timeout: 170_000, intervals: [10_000] })
    .toBe(1)
    .then(() => true, () => false);
}

test.describe('연결·역할 변경 뒤 남는 약', () => {
  test('[MED-G01] 보호자와 연결이 끊긴 피보호자에게 그 보호자가 등록한 약의 복약 알림이 계속 나가지 않는다', async ({ tempUser }) => {
    test.setTimeout(300_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const controlGuardian = await tempUser('GUARDIAN');
    const controlWard = await tempUser('WARD');
    connect(guardian.id, ward.id);
    connect(controlGuardian.id, controlWard.id);

    // 스케줄러가 아직 못 집도록 먼 시각으로 만들어 두고, 연결을 끊은 뒤에 복용 시각을 지금으로 당긴다
    const orphanMed = insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E고아약' });
    const controlMed = insertMedication({ wardId: controlWard.id, createdBy: controlGuardian.id, name: 'E2E통제약' });
    // 재알림(15분 뒤)까지 가지 않도록 끈다. 최초 알림은 그대로
    for (const id of [ward.id, controlWard.id]) {
      psql(`INSERT INTO medication_setting (user_id, alarm_enabled, remind_again_enabled) VALUES (${sqlStr(id)}, true, false);`);
    }

    // 마지막 ACTIVE 보호자와 연결 해제 (알림 발송 없이 DB 상태만 바꾼다: 해제 처리에 복약 정리가 없다는 것이 이 항목의 전제)
    psql(`UPDATE connection SET status = 'DISCONNECTED', updated_at = now() WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`);

    const past = kstTime('-2 minutes');
    test.skip(past.minutes < 35, '자정 직후에는 알림 유예 창이 자정에서 잘려 시나리오를 만들 수 없다');
    psql(`UPDATE medication SET dose_time = ${sqlStr(past.time)} WHERE id IN (${orphanMed}, ${controlMed});`);

    const schedulerRan = await waitForScheduler(controlMed);
    test.skip(!schedulerRan, 'dev 스케줄러가 통제군(연결 유지 중인 피보호자) 약의 알림도 선점하지 않아 실험이 성립하지 않는다');

    expect
      .soft(reminderLogCount(orphanMed), '관리하는 보호자가 아무도 없는 약인데 복용 시각마다 최초 알림이 선점(발송)된다 (연결 해제 시 약 알림 중지·정리가 없음)')
      .toBe(0);
    expect
      .soft(reminderNotificationCount(ward.id), '연결이 끊긴 피보호자에게 MEDICATION_REMINDER 알림이 기록됐다')
      .toBe(0);
  });

  test('[MED-G02] 관리자가 피보호자를 보호자로 바꾸면 그 계정에 남은 약의 복약 알림이 나가지 않는다', async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const admin = await tempUser('ADMIN');
    const ward = await tempUser('WARD');
    const author = await tempUser('GUARDIAN');
    const controlGuardian = await tempUser('GUARDIAN');
    const controlWard = await tempUser('WARD');
    connect(controlGuardian.id, controlWard.id);

    const staleMed = insertMedication({ wardId: ward.id, createdBy: author.id, name: 'E2E역할변경약' });
    const controlMed = insertMedication({ wardId: controlWard.id, createdBy: controlGuardian.id, name: 'E2E통제약' });
    for (const id of [ward.id, controlWard.id]) {
      psql(`INSERT INTO medication_setting (user_id, alarm_enabled, remind_again_enabled) VALUES (${sqlStr(id)}, true, false);`);
    }

    await test.step('관리자가 피보호자를 보호자로 역할 변경', async () => {
      const { api } = await loginAs(admin);
      await api.call('PATCH', `/api/admin/user/${ward.id}`, { role: 'GUARDIAN' });
      expect(psql(`SELECT role FROM users WHERE id = ${sqlStr(ward.id)};`)).toBe('GUARDIAN');
    });

    const past = kstTime('-2 minutes');
    test.skip(past.minutes < 35, '자정 직후에는 알림 유예 창이 자정에서 잘려 시나리오를 만들 수 없다');
    psql(`UPDATE medication SET dose_time = ${sqlStr(past.time)} WHERE id IN (${staleMed}, ${controlMed});`);

    const schedulerRan = await waitForScheduler(controlMed);
    test.skip(!schedulerRan, 'dev 스케줄러가 통제군 약의 알림도 선점하지 않아 실험이 성립하지 않는다');

    expect
      .soft(reminderLogCount(staleMed), '보호자가 된 계정의 약이 살아 있어 복용 시각에 최초 알림이 선점(발송)된다 (역할 변경 시 약 정리 없음)')
      .toBe(0);
    expect
      .soft(reminderNotificationCount(ward.id), '보호자가 된 계정에 MEDICATION_REMINDER 알림이 기록됐다 (체크 API 는 403 이라 재알림까지 반복됨)')
      .toBe(0);
  });
});

test.describe('보호자 약 수정·추가 폼', () => {
  test('[MED-G03] 수정 폼에서 시간대만 저녁으로 바꾸면 복용 시각이 저녁 기본 시각 18:00 이 된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    muteWardReminders(ward.id);
    const name = 'E2E시간대약';
    const medicationId = insertMedication({ wardId: ward.id, createdBy: guardian.id, name, timeSlot: 'MORNING', doseTime: '08:00:00' });
    const { who } = await loginAs(guardian);

    const page = await openAs(who, '/guardian/medication');
    const patches: string[] = [];
    page.on('request', request => {
      if (request.method() === 'PATCH' && request.url().includes('/api/guardian/medication/')) patches.push(request.postData() ?? '');
    });

    const card = guardianCard(page, ward.name);
    await expect(card.getByText('아침 08:00 · 1정')).toBeVisible();
    await card.getByRole('button', { name: `${name} 아침 08:00 · 1정` }).click();

    const dialog = page.getByRole('dialog', { name: '약 수정' });
    await expect(dialog.getByLabel('복용 시각')).toHaveValue('08:00');
    await dialog.locator('select').selectOption('DINNER');
    const save = page.waitForResponse(res => res.request().method() === 'PATCH' && res.url().includes('/api/guardian/medication/'));
    await dialog.getByRole('button', { name: '수정', exact: true }).click();
    expect((await save).ok()).toBe(true);

    expect
      .soft(patches[0], '시간대만 바꿨는데 FE 가 기존 시각 doseTime(08:00:00)을 함께 보내 BE 의 "시간대 기본 시각" 규칙이 무력화된다')
      .not.toContain('doseTime');
    await expect(
      card.getByText(/저녁 08:00/),
      '목록이 "저녁 08:00" 이라는 어긋난 상태로 남는다',
    ).toHaveCount(0);
    await expect(card.getByText('저녁 18:00 · 1정')).toBeVisible();
    expect(psql(`SELECT to_char(dose_time, 'HH24:MI') FROM medication WHERE id = ${medicationId};`), '저장된 복용 시각').toBe('18:00');
  });

  test('[MED-G09] 용량 칸을 지우고 2 를 입력하면 12 가 아니라 2정으로 저장된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    muteWardReminders(ward.id);
    const { who } = await loginAs(guardian);

    const page = await openAs(who, '/guardian/medication');
    const card = guardianCard(page, ward.name);
    await card.getByRole('button', { name: '+ 약 추가' }).click();

    const dialog = page.getByRole('dialog', { name: '약 추가' });
    await dialog.getByLabel('약 이름').fill('E2E용량약');
    const dose = dialog.getByRole('spinbutton', { name: '용량(정)' });
    await expect(dose).toHaveValue('1');
    await dose.click();
    await dose.press('Control+a');
    await dose.press('Backspace');
    await dose.pressSequentially('2');
    await expect
      .soft(dose, '지운 순간 값이 1 로 되돌아가 뒤에 2 가 붙어 12 가 된다 (onChange: Number(value) || 1)')
      .toHaveValue('2');

    const save = page.waitForResponse(res => res.request().method() === 'POST' && res.url().includes('/medication'));
    await dialog.getByRole('button', { name: '추가', exact: true }).click();
    expect((await save).ok()).toBe(true);

    const saved = () => psql(`SELECT dose_amount FROM medication WHERE ward_id = ${sqlStr(ward.id)} AND name = 'E2E용량약';`);
    await expect.poll(saved).not.toBe('');
    expect(saved(), '저장된 복용량(정)').toBe('2');
  });
});

test.describe('복약 화면의 실패 안내', () => {
  test('[MED-G05] 삭제된 약 체크·삭제, 연결 해제 뒤 알림 토글이 실패하면 화면에 원인이 표시된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const wardMed = insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E피보호자체크약' });
    const guardianMed = insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E보호자삭제약' });
    const [g, w] = [await loginAs(guardian), await loginAs(ward)];

    const wardPage = await openAs(w.who, '/ward/medication');
    const guardianPage = await openAs(g.who, '/guardian/medication');
    const wardItem = wardPage.getByRole('listitem').filter({ hasText: 'E2E피보호자체크약' });
    await expect(wardItem).toBeVisible();
    const card = guardianCard(guardianPage, ward.name);
    const guardianMedName = card.locator('strong', { hasText: 'E2E보호자삭제약' });
    await expect(guardianMedName).toBeVisible();

    await test.step('피보호자 화면이 열린 채 보호자가 약을 삭제 -> 피보호자가 복용 체크', async () => {
      psql(`UPDATE medication SET deleted_at = now() WHERE id = ${wardMed};`);
      const res = wardPage.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/api/ward/medication/${wardMed}/intake`));
      await wardItem.getByRole('button', { name: '복용 체크' }).click();
      expect((await res).status(), 'BE 는 삭제된 약 체크를 404 로 거절한다').toBe(404);

      // 올바른 동작: 오류 안내가 뜨거나, 목록을 다시 불러와 삭제된 카드가 사라진다
      await expect
        .configure({ soft: true })
        .poll(
          async () =>
            (await wardItem.count()) === 0 || FEEDBACK.test(await wardPage.locator('body').innerText()),
          { message: '404 인데 아무 안내도 없고 카드가 그대로 남는다 (onError 가 API 오류를 삼킴)', timeout: 4_000 },
        )
        .toBe(true);
    });

    await test.step('보호자 화면이 열린 채 약이 이미 삭제됨 -> 보호자가 삭제 X', async () => {
      psql(`UPDATE medication SET deleted_at = now() WHERE id = ${guardianMed};`);
      guardianPage.once('dialog', dialog => void dialog.accept());
      const res = guardianPage.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes(`/api/guardian/medication/${guardianMed}`));
      await card.getByRole('button', { name: 'E2E보호자삭제약 삭제' }).click();
      expect((await res).status(), 'BE 는 이미 삭제된 약 삭제를 404 로 거절한다').toBe(404);

      await expect
        .configure({ soft: true })
        .poll(
          async () =>
            (await guardianMedName.count()) === 0 || FEEDBACK.test(await guardianPage.locator('body').innerText()),
          { message: '404 인데 아무 안내도 없고 약이 그대로 남는다 (삭제 mutation 에 onError·재조회 없음)', timeout: 4_000 },
        )
        .toBe(true);
    });

    await test.step('연결이 해제된 뒤 보호자가 알림 토글', async () => {
      psql(`UPDATE connection SET status = 'DISCONNECTED', updated_at = now() WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`);
      const toggle = card.getByRole('checkbox').first();
      const res = guardianPage.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/medication-setting'));
      await toggle.click({ force: true });
      expect((await res).status(), 'BE 는 연결 해제된 피보호자의 설정 변경을 403 으로 거절한다').toBe(403);

      await expect
        .configure({ soft: true })
        .poll(
          async () => (await guardianPage.locator('body').innerText()).match(FEEDBACK) !== null || (await card.count()) === 0,
          { message: '403 인데 토글만 원위치로 돌아가고 이유 안내가 없다', timeout: 4_000 },
        )
        .toBe(true);
    });
  });
});

test.describe('미복약 알림 설정 UI', () => {
  test('[MED-G06] 다른 보호자가 피보호자 알림을 꺼도 내 카드의 미복약 알림 설정은 계속 보인다', async ({ tempUser, loginAs, openAs }) => {
    const g1 = await tempUser('GUARDIAN');
    const g2 = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    insertMedication({ wardId: ward.id, createdBy: g1.id, name: 'E2E공유알림약' });
    // 오늘 요약이 이미 나간 것으로 기록해 두어, 발송 시각과 겹쳐도 요약이 나가지 않게 한다
    psql(`INSERT INTO medication_missed_alert_log (guardian_id, ward_id, dose_date, missed_count, total_count, sent_at)
          VALUES (${sqlStr(g1.id)}, ${sqlStr(ward.id)}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, 1, now());`);
    const [first, second] = [await loginAs(g1), await loginAs(g2)];

    const page = await openAs(first.who, '/guardian/medication');
    const card = guardianCard(page, ward.name);
    await expect(card.getByText('미복약 알림', { exact: true }), '기준 상태: 알림이 켜져 있으면 미복약 알림 설정이 보인다').toBeVisible();

    await test.step('보호자 2 가 피보호자 복약 알림을 끔 (피보호자 단위 공유값)', async () => {
      const res = await second.api.raw('PUT', `/api/guardian/ward/${ward.id}/medication-setting`, { alarmEnabled: false });
      expect(res.ok()).toBe(true);
    });

    await page.reload();
    await expect(card.getByText('알림 꺼짐')).toBeVisible();
    await expect(
      card.getByText('미복약 알림', { exact: true }),
      '미복약 요약은 보호자 본인 설정(alarmEnabled 와 독립)인데 화면에서 숨겨져 끌 방법이 없다',
    ).toBeVisible();
    await expect(card.locator('input[type="time"]')).toBeVisible();
  });

  test('[MED-G08] 발송 시각 칸을 비우거나 바꾸는 중에는 잘못된 값이 저장 요청으로 나가지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E발송시각약' });

    // 발송 창 [시각, 시각+120분] 밖의 시각으로만 저장해 요약 발송을 막고, 오늘 요약이 나간 것으로도 기록해 둔다
    const now = kstTime('0 minutes').minutes;
    const candidate = [3 * 60 + 10, 9 * 60 + 10, 15 * 60 + 10].find(start => !(now >= start && now <= start + 120 + 5) && !(now >= start - 5 && now <= start));
    const hhmm = `${String(Math.floor(candidate! / 60)).padStart(2, '0')}:${String(candidate! % 60).padStart(2, '0')}`;
    psql(`INSERT INTO medication_missed_alert_log (guardian_id, ward_id, dose_date, missed_count, total_count, sent_at)
          VALUES (${sqlStr(guardian.id)}, ${sqlStr(ward.id)}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, 1, now());`);
    const { who } = await loginAs(guardian);

    const page = await openAs(who, '/guardian/medication');
    const puts: string[] = [];
    const statuses: number[] = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && request.url().includes('/medication-alert-setting')) puts.push(request.postData() ?? '');
    });
    page.on('response', response => {
      if (response.request().method() === 'PUT' && response.url().includes('/medication-alert-setting')) statuses.push(response.status());
    });

    const card = guardianCard(page, ward.name);
    const time = card.locator('input[type="time"]');
    await expect(time).toHaveValue('21:00');

    await test.step('시각 칸을 지운다', async () => {
      await time.fill('');
      await page.waitForTimeout(2_000);
      expect
        .soft(puts.filter(body => body.includes('":00"')), '빈 값을 ":00" 으로 만들어 서버에 보내 400 이 난다 (빈 값 검사 없음)')
        .toEqual([]);
      expect.soft(statuses.filter(status => status >= 400), '저장 요청이 4xx 로 실패했다').toEqual([]);
      expect
        .soft(await card.innerText(), '저장이 실패했는데 화면에 오류 표시가 없다')
        .toMatch(/오류|실패|올바른 시각|입력/);
    });

    await test.step('시각을 바꾸는 동안에는 확정 전까지 저장하지 않는다', async () => {
      puts.length = 0;
      await time.fill(hhmm);
      await page.waitForTimeout(1_500);
      expect
        .soft(puts, '입력을 확정(blur/저장 버튼)하기 전인데 변경 즉시 PUT 이 나간다. 키보드로 시·분을 차례로 바꾸면 중간값이 저장되어 창 안이면 조기 발송 후 그날 소진')
        .toEqual([]);
    });
  });
});
