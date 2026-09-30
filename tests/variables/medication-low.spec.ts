/**
 * 변수 QA - 복약 (low)
 *
 * 부작용 차단: 모든 약·설정은 임시 사용자에게만 만든다. 임시 사용자는 FCM 토큰이 없고 SMS 채널은 기본 꺼짐이라
 * (전화번호도 미배정 국번) 스케줄러가 알림을 골라도 실제 발송은 없다.
 * 피보호자 복약 알림은 꺼 두고, 미복용 요약은 발송 창 밖이거나 이미 나간 것으로 기록해 억제한다.
 */
import { Page } from '@playwright/test';

import { expect, test, waitForRealtime } from '../../src/fixtures';
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

/** 약을 DB 로 바로 만든다 */
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

/** 오늘(KST) 이미 요약이 나간 것으로 기록해 두어 미복용 요약 발송을 막는다 */
function markMissedAlertSentToday(guardianId: string, wardId: string) {
  psql(`INSERT INTO medication_missed_alert_log (guardian_id, ward_id, dose_date, missed_count, total_count, sent_at)
        VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, 1, now())
        ON CONFLICT DO NOTHING;`);
}

/** 보호자 복약 화면에서 한 피보호자의 카드 */
function guardianCard(page: Page, wardName: string) {
  return page.getByRole('listitem').filter({ has: page.getByText(wardName) }).first();
}

function intakeCount(medicationId: number) {
  return Number(psql(`SELECT count(*) FROM medication_intake WHERE medication_id = ${medicationId};`));
}

test.describe('동시 요청 (멱등·UPSERT)', () => {
  test('[MED-G04] 같은 약을 동시에 여러 번 체크·해제해도 모두 200 이고 최종 상태가 하나로 정해진다', async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const ward = await tempUser('WARD');
    const medicationId = insertMedication({ wardId: ward.id, createdBy: ward.id, name: 'E2E동시체크약' });
    const { api } = await loginAs(ward);

    const checkStatuses: number[] = [];
    const checkMessages = new Set<string>();
    const uncheckStatuses: number[] = [];
    const uncheckMessages = new Set<string>();

    // 실제로 겹쳐야 재현되므로 확률적이다: 최대 4회 시도한다
    for (let round = 0; round < 4; round++) {
      psql(`DELETE FROM medication_intake WHERE medication_id = ${medicationId};`);
      const checks = await Promise.all(
        Array.from({ length: 10 }, () => api.raw('POST', `/api/ward/medication/${medicationId}/intake`)),
      );
      for (const res of checks) {
        checkStatuses.push(res.status());
        if (!res.ok()) checkMessages.add(`${res.status()} ${(await res.text()).slice(0, 120)}`);
      }
      expect.soft(intakeCount(medicationId), `동시 체크 뒤 복용 기록은 정확히 1개 (round ${round + 1})`).toBe(1);

      // 해제: 체크된 상태에서 동시에 해제
      const unchecks = await Promise.all(
        Array.from({ length: 10 }, () => api.raw('DELETE', `/api/ward/medication/${medicationId}/intake`)),
      );
      for (const res of unchecks) {
        uncheckStatuses.push(res.status());
        if (!res.ok()) uncheckMessages.add(`${res.status()} ${(await res.text()).slice(0, 120)}`);
      }
      expect.soft(intakeCount(medicationId), `동시 해제 뒤 복용 기록은 0개 (round ${round + 1})`).toBe(0);

      if (checkStatuses.some(status => status !== 200) && uncheckStatuses.some(status => status !== 200)) break;
    }

    expect
      .soft(
        checkStatuses.filter(status => status !== 200),
        `동시 체크가 멱등(항상 200)이어야 하는데 일부가 실패했다: ${[...checkMessages].join(' / ')}`,
      )
      .toEqual([]);
    expect
      .soft(
        uncheckStatuses.filter(status => status !== 200),
        `동시 해제가 멱등(항상 200)이어야 하는데 일부가 실패했다: ${[...uncheckMessages].join(' / ')}`,
      )
      .toEqual([]);
  });

  test('[MED-G13] 설정 행이 없을 때 동시에 저장해도 모두 200 이다 (UPSERT)', async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const { api } = await loginAs(guardian);

    const alertStatuses: number[] = [];
    const alertMessages = new Set<string>();
    const settingStatuses: number[] = [];
    const settingMessages = new Set<string>();

    for (let round = 0; round < 4; round++) {
      // 첫 저장 경쟁을 만들기 위해 설정 행을 지운다. 알림은 끄는 값만 보내 발송이 생기지 않는다
      psql(`DELETE FROM guardian_medication_setting WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};
            DELETE FROM medication_setting WHERE user_id = ${sqlStr(ward.id)};`);

      const [alerts, settings] = await Promise.all([
        Promise.all(
          Array.from({ length: 5 }, () =>
            api.raw('PUT', `/api/guardian/ward/${ward.id}/medication-alert-setting`, { missedAlertEnabled: false }),
          ),
        ),
        Promise.all(
          Array.from({ length: 5 }, () =>
            api.raw('PUT', `/api/guardian/ward/${ward.id}/medication-setting`, { alarmEnabled: false }),
          ),
        ),
      ]);
      for (const res of alerts) {
        alertStatuses.push(res.status());
        if (!res.ok()) alertMessages.add(`${res.status()} ${(await res.text()).slice(0, 120)}`);
      }
      for (const res of settings) {
        settingStatuses.push(res.status());
        if (!res.ok()) settingMessages.add(`${res.status()} ${(await res.text()).slice(0, 120)}`);
      }
      if (alertStatuses.some(status => status !== 200) && settingStatuses.some(status => status !== 200)) break;
    }

    expect
      .soft(
        alertStatuses.filter(status => status !== 200),
        `미복용 요약 설정(guardian_medication_setting) 첫 저장 동시 요청이 UNIQUE 위반으로 실패했다: ${[...alertMessages].join(' / ')}`,
      )
      .toEqual([]);
    expect
      .soft(
        settingStatuses.filter(status => status !== 200),
        `복약 알림 설정(medication_setting) 첫 저장 동시 요청이 UNIQUE 위반으로 실패했다: ${[...settingMessages].join(' / ')}`,
      )
      .toEqual([]);
  });
});

test.describe('보호자 화면 안내', () => {
  test('[MED-G10] 미복용 요약 안내는 요약에 실제로 포함될 약만 세고, 알림이 꺼져 있으면 발송 예정 문구를 쓰지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    // 알림은 켜 둔 채 재알림만 끈다 (미복약 알림 섹션은 alarmEnabled 가 켜져 있어야 보인다)
    psql(`INSERT INTO medication_setting (user_id, alarm_enabled, remind_again_enabled) VALUES (${sqlStr(ward.id)}, true, false);`);
    markMissedAlertSentToday(guardian.id, ward.id);
    insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E아침약', timeSlot: 'MORNING', doseTime: '08:00:00' });
    insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E취침약', timeSlot: 'BEDTIME', doseTime: '22:00:00' });
    const { who, api } = await loginAs(guardian);

    const page = await openAs(who, '/guardian/medication');
    const card = guardianCard(page, ward.name);
    await expect(card.getByText('미복약 알림', { exact: true })).toBeVisible();
    await expect(card.locator('input[type="time"]')).toHaveValue('21:00');

    await test.step('요약 시각 21:00 - 22:00 약은 요약에서 빠진다', async () => {
      const notice = card.getByText(/에 보호자에게 미복용 \d+건/);
      await expect(notice).toBeVisible();
      const text = await notice.innerText();
      const shown = Number(text.match(/미복용 (\d+)건/)?.[1]);
      // BE 는 doseTime <= 21:00 인 약(08:00 1건)만 세어 "1건 중 1건" 으로 보낸다
      expect
        .soft(shown, `화면은 "${text.trim()}" 이라 안내하지만 실제 요약은 22:00 약을 제외한 1건이다`)
        .toBe(1);
      await expect
        .soft(card.locator('em', { hasText: /^예정/ }), '요약에 포함되지 않는 22:00 약까지 발송 예정 목록에 나열된다 (요약 대상은 08:00 약 1건)')
        .toHaveCount(1);
    });

    await test.step('미복약 알림을 끄면 발송 예정 문구가 사라지고 꺼짐으로 표시된다', async () => {
      const res = await api.raw('PUT', `/api/guardian/ward/${ward.id}/medication-alert-setting`, { missedAlertEnabled: false });
      expect(res.ok()).toBe(true);
      await page.reload();
      await expect(card.getByText('미복약 알림', { exact: true })).toBeVisible();
      const text = await card.innerText();
      expect.soft(text, '알림이 꺼져 있는데 "발송 예정" 문구가 그대로 나온다').not.toContain('발송 예정');
      expect.soft(text, '알림이 꺼져 있는데 "알림 발송" 안내가 그대로 나온다').not.toMatch(/미복용 \d+건\s*알림 발송/);
      expect.soft(text, '알림이 꺼졌음을 나타내는 "꺼짐" 표시가 없다').toContain('꺼짐');
    });
  });
});

test.describe('약 등록 입력 정규화', () => {
  test('[MED-G11] 등록 시에도 이름은 trim, 공백·빈 메모는 null 로 저장된다 (수정 API 와 동일)', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    muteWardReminders(ward.id);
    const { api } = await loginAs(guardian);
    const doseTime = farDoseTime();

    const spaced = await api.post<{ medicationId: number; name: string; memo: string | null }>(
      `/api/guardian/ward/${ward.id}/medication`,
      { name: ' 혈압약 ', timeSlot: 'MORNING', doseTime, memo: '   ' },
    );
    expect.soft(spaced.name, '등록 응답의 이름 앞뒤 공백이 그대로다').toBe('혈압약');
    expect.soft(spaced.memo, '공백뿐인 메모가 null 이 아닌 값으로 저장됐다 (피보호자 화면에 "1정 ·    " 로 보임)').toBeNull();
    expect
      .soft(psql(`SELECT '[' || name || ']' FROM medication WHERE id = ${spaced.medicationId};`), 'DB 에 저장된 이름')
      .toBe('[혈압약]');
    expect
      .soft(psql(`SELECT coalesce(memo, '<NULL>') FROM medication WHERE id = ${spaced.medicationId};`).replace(/^$/, '<EMPTY>'), 'DB 메모')
      .toBe('<NULL>');

    // FE 추가 폼은 메모를 비워도 "" 를 보낸다
    const empty = await api.post<{ medicationId: number; memo: string | null }>(
      `/api/guardian/ward/${ward.id}/medication`,
      { name: 'E2E빈메모약', timeSlot: 'LUNCH', doseTime, memo: '' },
    );
    expect
      .soft(
        psql(`SELECT CASE WHEN memo IS NULL THEN '<NULL>' WHEN memo = '' THEN '<EMPTY>' ELSE memo END FROM medication WHERE id = ${empty.medicationId};`),
        '메모를 비웠는데 DB 에 null 이 아닌 빈 문자열이 저장됐다 (수정 API 는 null 로 정규화)',
      )
      .toBe('<NULL>');
  });

  test('[MED-G16] 제로폭 문자만으로 된 약 이름은 등록할 수 없다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    muteWardReminders(ward.id);
    const { api, who } = await loginAs(guardian);

    await test.step('API: 이름이 U+200B 뿐이면 400', async () => {
      const res = await api.raw('POST', `/api/guardian/ward/${ward.id}/medication`, {
        name: '​',
        timeSlot: 'LUNCH',
        doseTime: farDoseTime(),
      });
      const body = await res.text();
      expect.soft(res.status(), `제로폭 문자만 있는 이름이 통과했다 (응답 ${body.slice(0, 150)})`).toBe(400);
      expect
        .soft(
          Number(psql(`SELECT count(*) FROM medication WHERE ward_id = ${sqlStr(ward.id)} AND name = E'\\u200b';`)),
          '이름이 보이지 않는 약이 저장됐다',
        )
        .toBe(0);
    });

    await test.step('화면: 제로폭 문자만 입력하면 추가 버튼이 비활성', async () => {
      const page = await openAs(who, '/guardian/medication');
      const card = guardianCard(page, ward.name);
      await card.getByRole('button', { name: '+ 약 추가' }).click();
      const dialog = page.getByRole('dialog', { name: '약 추가' });
      await dialog.getByLabel('약 이름').fill('​');
      await expect
        .soft(dialog.getByRole('button', { name: '추가', exact: true }), '제로폭 문자만 입력했는데 추가 버튼이 활성화된다 (JS trim 이 U+200B 를 공백으로 보지 않음)')
        .toBeDisabled();
    });
  });
});

test.describe('알림 집계·재발송', () => {
  test('[MED-G12] 복용 시각을 이미 지난 시각으로 고쳐도 이미 남은 최초 알림 발송 기록은 유지된다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    // 피보호자 알림을 꺼 두어 발송은 없고, 발송 기록의 삭제 여부만 본다
    muteWardReminders(ward.id);
    const before = kstTime('-5 minutes');
    test.skip(before.minutes < 35, '자정 직후에는 시각을 과거로 잡을 수 없다');
    const medicationId = insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E시각수정약', doseTime: before.time });
    const logId = () =>
      psql(`INSERT INTO medication_reminder_log (medication_id, dose_date, attempt, sent_at)
            VALUES (${medicationId}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, now()) RETURNING id;`);
    const existing = () =>
      Number(psql(`SELECT count(*) FROM medication_reminder_log WHERE medication_id = ${medicationId} AND attempt = 1;`));
    const { api } = await loginAs(guardian);

    const firstLogId = logId();
    const patch = await api.raw('PATCH', `/api/guardian/medication/${medicationId}`, { doseTime: kstTime('-2 minutes').time });
    expect(patch.ok(), '복용 시각 수정 요청').toBe(true);
    expect
      .soft(
        Number(psql(`SELECT count(*) FROM medication_reminder_log WHERE id = ${firstLogId};`)),
        '이미 나간 최초 알림 기록이 시각 수정으로 지워져 다음 스케줄러 주기에 같은 알림이 다시 나간다 (새 시각도 이미 지난 시각)',
      )
      .toBe(1);

    await test.step('대조군: 새 시각이 미래이면 기록을 초기화하는 것이 정상', async () => {
      test.skip(before.minutes > 20 * 60, '밤 시간대에는 +3시간이 다음 날로 넘어가 미래 시각을 잡을 수 없다');
      psql(`DELETE FROM medication_reminder_log WHERE medication_id = ${medicationId};`);
      logId();
      const res = await api.raw('PATCH', `/api/guardian/medication/${medicationId}`, { doseTime: kstTime('3 hours').time });
      expect(res.ok()).toBe(true);
      expect(existing(), '새 시각이 미래이면 오늘 발송 기록을 지워 새 시각에 다시 판정한다').toBe(0);
    });
  });

  test('[MED-G14] 복용 시각이 지난 뒤 오늘 새로 등록한 약은 그날 미복용 요약 집계에서 제외된다', async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    muteWardReminders(ward.id);
    const now = kstTime('0 minutes');
    test.skip(now.minutes < 60 || now.minutes > 22 * 60, '자정 근처에는 발송 창·복용 시각을 과거로 잡을 수 없다');
    const { api } = await loginAs(guardian);

    // 어제 등록된 기존 약(집계 대상) - 스케줄러가 돌았는지 알려 주는 통제 역할도 한다
    const oldMedicationId = insertMedication({
      wardId: ward.id, createdBy: guardian.id, name: 'E2E기존약', doseTime: kstTime('-40 minutes').time,
    });
    psql(`UPDATE medication SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day' WHERE id = ${oldMedicationId};`);

    // 요약 시각을 1분 전으로 잡아 다음 스케줄러 주기에 발송 창 안이 되게 한다
    const alertTime = kstTime('-1 minutes').time;
    const setting = await api.raw('PUT', `/api/guardian/ward/${ward.id}/medication-alert-setting`, {
      missedAlertEnabled: true,
      missedAlertTime: alertTime,
    });
    expect(setting.ok(), '미복용 요약 시각 설정').toBe(true);

    // 복용 시각(20분 전)이 이미 지난 뒤에 오늘 새로 등록한 약 - 피보호자는 복용할 기회가 없었다
    const created = await api.post<{ medicationId: number }>(`/api/guardian/ward/${ward.id}/medication`, {
      name: 'E2E오늘등록약',
      timeSlot: 'MORNING',
      doseTime: kstTime('-20 minutes').time,
    });
    expect(created.medicationId).toBeGreaterThan(0);

    const rowQuery = `SELECT missed_count || '/' || total_count FROM medication_missed_alert_log
                      WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`;
    const found = await expect
      .poll(() => psql(rowQuery), { timeout: 200_000, intervals: [10_000] })
      .not.toBe('')
      .then(() => true, () => false);
    test.skip(!found, 'dev 스케줄러가 200초 안에 미복용 요약을 선점하지 않아 실험이 성립하지 않는다');

    // 올바른 동작: 기존 약만 집계되어 1/1. 현재는 오늘 등록한 약도 집계되어 2/2
    expect(psql(rowQuery), '미복용 요약의 (미체크/전체) - 오늘 등록한 약은 집계에서 빠져야 한다').toBe('1/1');
  });
});

test.describe('실시간 복약 이벤트', () => {
  test('[MED-G15] 어제 날짜(doseDate)의 복용함 이벤트가 늦게 도착해도 오늘 목록의 약은 미복용으로 남는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    muteWardReminders(ward.id);
    const medicationId = insertMedication({ wardId: ward.id, createdBy: guardian.id, name: 'E2E지연이벤트약' });
    const yesterday = psql(`SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date - 1)::text;`);
    const { who } = await loginAs(guardian);

    // 보호자 페이지의 WebSocket 을 중계하면서, 서버가 보낸 것처럼 지난 날짜의 이벤트를 주입한다
    const page = await openAs(who, null);
    let subscriptionId: string | undefined;
    let inject: ((frame: string) => void) | undefined;
    await page.routeWebSocket(/\/ws(\?|$)/, ws => {
      const server = ws.connectToServer();
      ws.onMessage(message => {
        const frame = typeof message === 'string' ? message : message.toString();
        if (frame.startsWith('SUBSCRIBE') && frame.includes('/medication-taken')) {
          subscriptionId = frame.match(/^id:(.*)$/m)?.[1]?.trim();
        }
        server.send(message);
      });
      server.onMessage(message => ws.send(message));
      inject = frame => ws.send(frame);
    });
    await page.goto('/guardian/medication');
    await waitForRealtime(page);
    await expect.poll(() => subscriptionId, { message: 'medication-taken 구독 id 확보' }).toBeTruthy();

    const card = guardianCard(page, ward.name);
    const item = card.getByRole('listitem').filter({ hasText: 'E2E지연이벤트약' });
    await expect(item.getByText('미복용', { exact: true })).toBeVisible();

    const payload = {
      medicationId: String(medicationId),
      wardId: ward.id,
      medicationName: 'E2E지연이벤트약',
      doseDate: yesterday,
      taken: 'true',
      takenAt: `${yesterday}T23:59:59+09:00`,
    };
    const frame = [
      'MESSAGE',
      `destination:/topic/${who.login.userId}/medication-taken`,
      `subscription:${subscriptionId}`,
      'message-id:e2e-stale-1',
      'content-type:application/json',
      '',
      `${JSON.stringify(payload)}\0`,
    ].join('\n');
    expect(inject, 'WebSocket 중계가 연결됐다').toBeDefined();
    inject!(frame);

    await page.waitForTimeout(1_500);
    await expect
      .soft(
        item.getByText('미복용', { exact: true }),
        `doseDate(${yesterday})가 오늘 목록과 다른 이벤트인데 그대로 적용되어 오늘 약이 "복용함" 으로 바뀐다 (DB 복용 기록 ${intakeCount(medicationId)}건)`,
      )
      .toBeVisible();
    expect(intakeCount(medicationId), '실제 복용 기록은 없다').toBe(0);
  });
});
