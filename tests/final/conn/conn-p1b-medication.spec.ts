/**
 * 최종 QA - 복약(CONN) P1 묶음 b: N32 A37 N30 N31.
 *
 * 임시 사용자만 쓴다. 약은 복용 시각이 지금과 멀리 떨어지게 등록하고(알림 유예 창 밖), 미복용 요약은 끈다.
 * 임시 사용자에게는 푸시 토큰이 없어 실제 푸시·문자는 나가지 않는다. DB 는 임시 사용자 id 로 거른 행만 읽는다.
 */
import { env } from '../../../src/env';
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import { logLineCount } from './_helpers-conn';
import {
  addMed, call, expectRes, frameBodies, intakeRows, kstAfter, kstMinutesNow, kstToday, medDeleted, notiRows, sleep, TAGS, watchWs, watchWsInjectable,
} from './_helpers-conn-p1b';

interface Card {
  wardId: string;
  wardName: string;
  age: number | null;
  remindAgainEnabled: boolean;
  missedAlertEnabled: boolean;
  missedAlertTime: string;
  doseDate: string;
  takenCount: number;
  totalCount: number;
  medications: { medicationId: number; name: string; timeSlot: string; doseTime: string; taken: boolean; takenAt: string | null; createdAt: string }[];
}
interface Today {
  doseDate: string;
  takenCount: number;
  totalCount: number;
  medications: { medicationId: number; name: string; doseTime: string; taken: boolean; takenAt: string | null }[];
}
interface Alert {
  wardId: string;
  missedAlertEnabled: boolean;
  missedAlertTime: string;
}

const alertPath = (wardId: string) => `/api/guardian/ward/${wardId}/medication-alert-setting`;
function settingRows(guardianId: string, wardId: string): { enabled: string; time: string }[] {
  return psql(
    `SELECT missed_alert_enabled::text || '|' || coalesce(to_char(missed_alert_time, 'HH24:MI:SS'), '') FROM guardian_medication_setting
     WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)};`,
  )
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [enabled, time] = line.split('|');
      return { enabled, time };
    });
}

test.describe('CONN 복약 P1 묶음 b', () => {
  test('CONN-N32 보호자별 미체크 요약 설정 저장', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const g1 = await tempUser('GUARDIAN');
    const g2 = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD');
    const w2 = await tempUser('WARD');
    connect(g1.id, w1.id);
    connect(g2.id, w1.id);
    const a = await loginAs(g1);
    const b = await loginAs(g2);

    await test.step('설정한 적이 없으면 기본값(켜짐, 21:00:00)이고 카드에도 같은 값이 온다', async () => {
      const r = await call(a.api, 'GET', alertPath(w1.id));
      expectRes(r, 200, undefined, '기본값 조회');
      expect(r.data).toEqual({ wardId: w1.id, missedAlertEnabled: true, missedAlertTime: '21:00:00' });
      const cards = await a.api.get<Card[]>('/api/guardian/medication');
      expect(cards.find(c => c.wardId === w1.id)).toMatchObject({ missedAlertEnabled: true, missedAlertTime: '21:00:00' });
      expect(settingRows(g1.id, w1.id), '조회만으로는 행이 생기지 않는다').toHaveLength(0);
    });

    await test.step('화면: 시각을 오후 7시 30분으로 정하면 분 단위로 저장된다 (19:30:00)', async () => {
      const page = await openAs(a.who, '/guardian/medication');
      const alertCard = page.getByRole('region', { name: '알림 설정' });
      await expect(alertCard).toBeVisible();
      await alertCard.getByRole('button', { name: /안 드시면 알림 받을 시각 오후 9:00/ }).click();
      await page.getByRole('group', { name: '오전 오후' }).getByRole('button', { name: '오후', exact: true }).click();
      await page.getByRole('group', { name: '시' }).getByRole('button', { name: '7', exact: true }).click();
      await page.getByRole('group', { name: '분' }).getByRole('button', { name: '30', exact: true }).click();
      const put = page.waitForResponse(res => res.request().method() === 'PUT' && res.url().endsWith(alertPath(w1.id)));
      await page.getByRole('button', { name: '오후 7:30로 정하기' }).click();
      const res = await put;
      expect(res.status()).toBe(200);
      expect(JSON.parse(res.request().postData() ?? '{}'), '화면이 보내는 값').toEqual({ missedAlertTime: '19:30:00', missedAlertEnabled: true });
      await expect(alertCard.getByRole('button', { name: /안 드시면 알림 받을 시각 오후 7:30/ })).toBeVisible();
      expect(settingRows(g1.id, w1.id)).toEqual([{ enabled: 'true', time: '19:30:00' }]);
    });

    await test.step('초·나노는 버리고 분 단위로 저장한다 (19:45:59 -> 19:45:00), 안 보낸 칸은 그대로', async () => {
      const r = await call(a.api, 'PUT', alertPath(w1.id), { missedAlertTime: '19:45:59' });
      expectRes(r, 200, undefined, '초 포함 저장');
      expect((r.data as Alert).missedAlertTime).toBe('19:45:00');
      expect(settingRows(g1.id, w1.id)[0].time, '저장된 값').toBe('19:45:00');
      const off = await call(a.api, 'PUT', alertPath(w1.id), { missedAlertEnabled: false });
      expect(off.data).toEqual({ wardId: w1.id, missedAlertEnabled: false, missedAlertTime: '19:45:00' });
      const back = await call(a.api, 'PUT', alertPath(w1.id), { missedAlertEnabled: true, missedAlertTime: '19:30:00' });
      expect((back.data as Alert).missedAlertTime).toBe('19:30:00');
    });

    await test.step('시각 형식이 틀리면 400, 저장은 바뀌지 않는다', async () => {
      const r = await call(a.api, 'PUT', alertPath(w1.id), { missedAlertTime: '저녁 7시' });
      expect(r.status, '500 이면 안 된다').not.toBe(500);
      expectRes(r, 400, undefined, '잘못된 시각');
      expect(settingRows(g1.id, w1.id)).toEqual([{ enabled: 'true', time: '19:30:00' }]);
    });

    await test.step('다른 보호자는 자기 설정을 따로 가진다: g2 가 끄고 시각을 바꿔도 g1 설정·카드는 그대로', async () => {
      const r = await call(b.api, 'PUT', alertPath(w1.id), { missedAlertEnabled: false, missedAlertTime: '08:15:00' });
      expect(r.data).toEqual({ wardId: w1.id, missedAlertEnabled: false, missedAlertTime: '08:15:00' });
      expect((await call(a.api, 'GET', alertPath(w1.id))).data, 'g1 설정').toEqual({ wardId: w1.id, missedAlertEnabled: true, missedAlertTime: '19:30:00' });
      const cardsA = await a.api.get<Card[]>('/api/guardian/medication');
      const cardsB = await b.api.get<Card[]>('/api/guardian/medication');
      expect(cardsA.find(c => c.wardId === w1.id), 'g1 카드').toMatchObject({ missedAlertEnabled: true, missedAlertTime: '19:30:00' });
      expect(cardsB.find(c => c.wardId === w1.id), 'g2 카드').toMatchObject({ missedAlertEnabled: false, missedAlertTime: '08:15:00' });
      expect(settingRows(g1.id, w1.id)).toHaveLength(1);
      expect(settingRows(g2.id, w1.id)).toEqual([{ enabled: 'false', time: '08:15:00' }]);
    });

    await test.step('화면: 다른 보호자가 꺼도 내 카드에는 설정 칸과 내 시각이 계속 보인다 (MED-G06)', async () => {
      const page = await openAs(a.who, '/guardian/medication');
      const alertCard = page.getByRole('region', { name: '알림 설정' });
      await expect(alertCard.getByRole('button', { name: /안 드시면 알림 받을 시각 오후 7:30/ })).toBeVisible();
      await expect(alertCard.getByText('이 시간까지 안 드시면 알려 드려요')).toBeVisible();
    });

    await test.step('피보호자별로 따로: 같은 보호자가 다른 피보호자(w2)를 연결하면 그쪽은 기본값 21:00:00', async () => {
      connect(g1.id, w2.id);
      expect((await call(a.api, 'GET', alertPath(w2.id))).data).toEqual({ wardId: w2.id, missedAlertEnabled: true, missedAlertTime: '21:00:00' });
      expectRes(await call(a.api, 'PUT', alertPath(w2.id), { missedAlertTime: '22:10:00' }), 200, undefined, 'w2 저장');
      const cards = await a.api.get<Card[]>('/api/guardian/medication');
      expect(cards.find(c => c.wardId === w1.id)?.missedAlertTime, 'w1 시각 그대로').toBe('19:30:00');
      expect(cards.find(c => c.wardId === w2.id)?.missedAlertTime, 'w2 시각').toBe('22:10:00');
    });

    await test.step('처음 저장이 동시에 몰려도 모두 200 이고 행은 1개 (MED-G13)', async () => {
      const g3 = await tempUser('GUARDIAN');
      connect(g3.id, w2.id);
      const c = await loginAs(g3);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => call(c.api, 'PUT', alertPath(w2.id), { missedAlertEnabled: true, missedAlertTime: '20:00:00' })),
      );
      expect(results.map(r => r.status)).toEqual([200, 200, 200, 200, 200]);
      expect(settingRows(g3.id, w2.id)).toEqual([{ enabled: 'true', time: '20:00:00' }]);
    });
    test.info().annotations.push({
      type: '화면 변경으로 확인하지 않은 옛 항목',
      description:
        'MED-G08(시각 칸을 비우면 ":00" 전송)과 FEUX-G37(조회 실패 때 토글 막기)은 v13 화면이 시각 고르기(오전/오후·시·분 선택 후 "로 정하기")로 바뀌고 켜고 끄는 스위치가 없어져 해당 동작이 화면에 없다. 시각 저장은 위 단계로 확인했다.',
    });
  });

  test('CONN-A37 중복·동시 체크 해제 멱등', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const g1 = await tempUser('GUARDIAN');
    const g2 = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const a = await loginAs(g1);
    const b = await loginAs(g2);
    const w = await loginAs(ward);
    // 미복용 요약이 가지 않게 끈다 (임시 보호자)
    await call(a.api, 'PUT', alertPath(ward.id), { missedAlertEnabled: false });
    await call(b.api, 'PUT', alertPath(ward.id), { missedAlertEnabled: false });
    const medId = await addMed(a.api, ward.id, 'E2E멱등약', kstAfter(6));
    const events = (taken: boolean) => logLineCount(env.apiContainer, ['복약 체크 실시간 반영', `medicationId=${medId},`, `taken=${taken}`], 600);

    await test.step('같은 약을 두 번 체크: 둘 다 200, 기록 1개, 보호자 화면 신호는 1번만', async () => {
      const first = await call(w.api, 'POST', `/api/ward/medication/${medId}/intake`);
      const second = await call(w.api, 'POST', `/api/ward/medication/${medId}/intake`);
      expectRes(first, 200, undefined, '첫 체크');
      expectRes(second, 200, undefined, '두 번째 체크');
      expect((first.data as { taken: boolean }).taken).toBe(true);
      expect(Date.parse((second.data as { takenAt: string }).takenAt), '두 번째는 기존 기록(같은 체크 시각)을 그대로 돌려준다').toBe(Date.parse((first.data as { takenAt: string }).takenAt));
      expect(intakeRows(medId)).toBe(1);
      await expect.poll(() => events(true), { message: '체크 신호 로그', timeout: 20_000, intervals: [1000, 2000] }).toBe(1);
    });

    await test.step('체크 안 한 약을 해제: 200, 신호 없음. 체크한 약은 1번 해제되고 신호 1번', async () => {
      const other = await addMed(a.api, ward.id, 'E2E미체크약', kstAfter(7));
      const noop = await call(w.api, 'DELETE', `/api/ward/medication/${other}/intake`);
      expectRes(noop, 200, undefined, '미체크 해제');
      expect((noop.data as { taken: boolean }).taken).toBe(false);
      expect(intakeRows(other)).toBe(0);
      const real = await call(w.api, 'DELETE', `/api/ward/medication/${medId}/intake`);
      expectRes(real, 200, undefined, '체크 해제');
      expect(intakeRows(medId)).toBe(0);
      expectRes(await call(w.api, 'DELETE', `/api/ward/medication/${medId}/intake`), 200, undefined, '해제 한 번 더');
      await expect.poll(() => events(false), { message: '해제 신호 로그', timeout: 20_000, intervals: [1000, 2000] }).toBe(1);
      const logsOther = logLineCount(env.apiContainer, ['복약 체크 실시간 반영', `medicationId=${other},`], 600);
      expect(logsOther, '체크한 적 없는 약의 해제는 신호를 만들지 않는다').toBe(0);
    });

    await test.step('같은 약을 동시에 체크 6번, 이어서 동시에 해제 6번: 전부 200, 기록은 1개 -> 0개', async () => {
      const checks = await Promise.all(Array.from({ length: 6 }, () => call(w.api, 'POST', `/api/ward/medication/${medId}/intake`)));
      expect(checks.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(intakeRows(medId)).toBe(1);
      const unchecks = await Promise.all(Array.from({ length: 6 }, () => call(w.api, 'DELETE', `/api/ward/medication/${medId}/intake`)));
      expect(unchecks.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(intakeRows(medId)).toBe(0);
      // 신호는 실제로 바뀐 횟수만: 앞 단계 체크 1 + 해제 1 에 더해 동시 체크 1 + 동시 해제 1
      await expect.poll(() => events(true), { message: '체크 신호', timeout: 20_000, intervals: [1000, 2000] }).toBe(2);
      await expect.poll(() => events(false), { message: '해제 신호', timeout: 20_000, intervals: [1000, 2000] }).toBe(2);
    });

    await test.step('두 보호자가 같은 약을 동시에 수정·삭제: 삭제가 수정에 의해 되돌려지지 않는다', async () => {
      for (let round = 1; round <= 6; round++) {
        const id = await addMed(a.api, ward.id, `E2E경합약${round}`, kstAfter(6));
        const [patch, del] = await Promise.all([
          call(a.api, 'PATCH', `/api/guardian/medication/${id}`, { name: `E2E수정됨${round}`, memo: '동시 수정' }),
          call(b.api, 'DELETE', `/api/guardian/medication/${id}`),
        ]);
        expect(del.status, `${round}회차 삭제 응답`).toBe(200);
        // 수정이 삭제보다 먼저면 200, 삭제 뒤면 404 MEDICATION_NOT_FOUND. 이 둘 말고는 없다.
        expect([200, 404], `${round}회차 수정 응답 상태 코드 ${patch.status}`).toContain(patch.status);
        if (patch.status === 404) expect(patch.code, `${round}회차 수정이 늦었을 때 오류 코드`).toBe('MEDICATION_NOT_FOUND');
        expect(medDeleted(id), `${round}회차: 수정이 삭제를 되돌리면 안 된다`).toBe(true);
      }
      // 동시에 둘이 삭제해도 500 이 없고 삭제 상태
      const id = await addMed(a.api, ward.id, 'E2E이중삭제약', kstAfter(6));
      const results = await Promise.all([call(a.api, 'DELETE', `/api/guardian/medication/${id}`), call(b.api, 'DELETE', `/api/guardian/medication/${id}`)]);
      // 동시 삭제는 잠금이 없어 둘 다 200 일 수도 있다(배포 코드 delete 는 조회 후 soft delete). 5xx 가 아니라 200/404 로만 끝나고 적어도 한 건은 성공해야 한다.
      test.info().annotations.push({ type: '동시 이중 삭제 응답', description: `상태 코드 ${results.map(r => r.status).sort().join(', ')}` });
      for (const r of results) expect([200, 404], `이중 삭제 응답 상태 코드 ${r.status}`).toContain(r.status);
      expect(results.some(r => r.status === 200), '둘 중 하나는 삭제 성공').toBe(true);
      for (const r of results.filter(x => x.status === 404)) expect(r.code, '늦은 삭제의 오류 코드').toBe('MEDICATION_NOT_FOUND');
      expect(medDeleted(id)).toBe(true);
      // 순서대로 두 번 지우는 경우는 정해져 있다: 처음 200, 두 번째 404 MEDICATION_NOT_FOUND
      const seq = await addMed(a.api, ward.id, 'E2E순차삭제약', kstAfter(6));
      expectRes(await call(a.api, 'DELETE', `/api/guardian/medication/${seq}`), 200, undefined, '첫 삭제');
      expectRes(await call(b.api, 'DELETE', `/api/guardian/medication/${seq}`), 404, 'MEDICATION_NOT_FOUND', '이미 지운 약 다시 삭제');
    });

    await test.step('보호자 알림 재발송 없음: 두 보호자와 피보호자 모두 알림 이력(푸시)이 0건', async () => {
      expect(notiRows(g1.id), '보호자1 알림 이력').toHaveLength(0);
      expect(notiRows(g2.id), '보호자2 알림 이력').toHaveLength(0);
      expect(notiRows(ward.id), '피보호자 알림 이력').toHaveLength(0);
    });

    await test.step('화면: 어제 날짜 체크 신호가 늦게 와도 오늘 약은 체크된 것으로 바뀌지 않는다 (MED-G15)', async () => {
      const guardianPage = await openAs(a.who, null);
      const ws = await watchWsInjectable(guardianPage);
      await guardianPage.goto('/guardian/medication');
      await waitForRealtime(guardianPage);
      await expect.poll(() => ws.subscriptionId('medication-taken'), { message: 'medication-taken 구독 id', timeout: 15_000 }).toBeTruthy();
      await expect(guardianPage.getByText('E2E멱등약')).toBeVisible();
      await expect(guardianPage.getByText('드셨어요'), '준비: 아직 체크가 없다').toHaveCount(0);

      const yesterday = psql(`SELECT ((now() AT TIME ZONE 'Asia/Seoul')::date - 1)::text;`);
      ws.inject(g1.id, 'medication-taken', {
        medicationId: String(medId), wardId: ward.id, medicationName: 'E2E멱등약', doseDate: yesterday, taken: 'true', takenAt: `${yesterday}T23:59:59+09:00`,
      });
      // 대조: 같은 신호를 오늘 날짜로 넣으면 화면이 바뀐다. 이 표식이 보인 뒤에는 앞 신호(지난 날짜)도 이미 처리된 것이다.
      ws.inject(g1.id, 'medication-taken', {
        medicationId: String(medId), wardId: ward.id, medicationName: 'E2E멱등약', doseDate: kstToday(), taken: 'true', takenAt: new Date().toISOString(),
      });
      await expect(guardianPage.getByText('드셨어요').first(), '대조: 오늘 날짜 신호는 적용되어 "드셨어요"가 뜬다(신호 처리가 끝났다는 표식)').toBeVisible({ timeout: 15_000 });
      expect(intakeRows(medId), '실제 복용 기록은 없다').toBe(0);
      await guardianPage.reload();
      await waitForRealtime(guardianPage);
      await expect(guardianPage.getByText('E2E멱등약')).toBeVisible();
      await expect(guardianPage.getByText('드셨어요'), '준비: 새로고침하면 체크가 없는 상태로 돌아온다').toHaveCount(0);
      await expect.poll(() => ws.subscriptionId('medication-taken'), { message: 'medication-taken 구독 id', timeout: 15_000 }).toBeTruthy();
      ws.inject(g1.id, 'medication-taken', {
        medicationId: String(medId), wardId: ward.id, medicationName: 'E2E멱등약', doseDate: yesterday, taken: 'true', takenAt: `${yesterday}T23:59:59+09:00`,
      });
      // 지난 날짜 신호는 3초 동안 여러 번 확인해도 오늘 약을 바꾸지 않아야 한다 (바뀌면 바로 실패)
      for (let i = 0; i < 6; i++) {
        await expect(
          guardianPage.getByText('드셨어요'),
          `doseDate(${yesterday})가 오늘 목록과 다른 신호인데 그대로 적용돼 오늘 약이 "드셨어요"로 바뀌었다`,
        ).toHaveCount(0, { timeout: 500 });
        await sleep(500);
      }
      expect(intakeRows(medId), '실제 복용 기록도 없다').toBe(0);
    });

    test.info().annotations.push({
      type: '보류 항목 기록',
      description:
        'MED-G07(자정을 넘겨 전날 화면에서 체크하면 오늘 기록으로 저장됨): 체크 API 는 날짜 칸이 없고 서버가 항상 "오늘(KST)"에 기록한다. 그래서 어제 화면에서 보낸 체크 요청은 서버에서 막을 수단이 없다. 위 화면 단계는 늦게 온 지난 날짜 "신호"만 확인한다.',
    });
  });

  test('CONN-N30 피보호자 오늘 약 조회·체크·해제·묶음 체크', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const g2 = await tempUser('GUARDIAN');
    const ward2 = await tempUser('WARD');
    connect(guardian.id, ward.id);
    connect(g2.id, ward2.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const gb = await loginAs(g2);
    const w2 = await loginAs(ward2);
    await call(g.api, 'PUT', alertPath(ward.id), { missedAlertEnabled: false });
    await call(gb.api, 'PUT', alertPath(ward2.id), { missedAlertEnabled: false });

    // 일부러 시각 순서와 등록 순서를 다르게 한다
    const times = [kstAfter(7), kstAfter(5), kstAfter(6)];
    const names = ['E2E일곱시', 'E2E다섯시', 'E2E여섯시'];
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) ids.push(await addMed(g.api, ward.id, names[i], times[i]));
    const expectedOrder = [...ids.keys()].sort((x, y) => times[x].localeCompare(times[y])).map(i => ids[i]);

    await test.step('오늘 약 조회: 먹는 시각 순, 0/3', async () => {
      const today = await w.api.get<Today>('/api/ward/medication/today');
      expect(today.doseDate).toBe(kstToday());
      expect(today.medications.map(m => m.medicationId), '먹는 시각 순').toEqual(expectedOrder);
      expect(today.medications.map(m => m.doseTime)).toEqual([...times].sort());
      expect([today.takenCount, today.totalCount]).toEqual([0, 3]);
    });

    await test.step('한 개 체크·해제: takenCount 가 바뀌고 takenAt 이 생겼다 사라진다', async () => {
      const checked = await call(w.api, 'POST', `/api/ward/medication/${ids[0]}/intake`);
      expectRes(checked, 200, undefined, '체크');
      expect(checked.data).toMatchObject({ medicationId: ids[0], taken: true });
      expect((checked.data as { takenAt: string | null }).takenAt).not.toBeNull();
      expect(((await w.api.get<Today>('/api/ward/medication/today')).takenCount)).toBe(1);
      const unchecked = await call(w.api, 'DELETE', `/api/ward/medication/${ids[0]}/intake`);
      expectRes(unchecked, 200, undefined, '해제');
      expect(unchecked.data).toMatchObject({ taken: false, takenAt: null });
      expect(((await w.api.get<Today>('/api/ward/medication/today')).takenCount)).toBe(0);
    });

    await test.step('묶음 체크(taken true/false): 요청한 순서대로 갱신된 항목, takenCount 3 -> 0', async () => {
      const all = await call(w.api, 'POST', '/api/ward/medication/intake/batch', { medicationIds: ids, taken: true });
      expectRes(all, 200, undefined, '묶음 체크');
      expect((all.data as { medicationId: number; taken: boolean }[]).map(m => [m.medicationId, m.taken])).toEqual(ids.map(id => [id, true]));
      const today = await w.api.get<Today>('/api/ward/medication/today');
      expect([today.takenCount, today.totalCount]).toEqual([3, 3]);
      const none = await call(w.api, 'POST', '/api/ward/medication/intake/batch', { medicationIds: ids, taken: false });
      expectRes(none, 200, undefined, '묶음 해제');
      expect(((await w.api.get<Today>('/api/ward/medication/today')).takenCount)).toBe(0);
      expectRes(await call(w.api, 'POST', '/api/ward/medication/intake/batch', { medicationIds: [ids[0], ids[0]], taken: true }), 400, 'MEDICATION_INTAKE_BATCH_DUPLICATE', '같은 약 두 번');
      expect(intakeRows(ids[0]), '중복 요청은 아무것도 체크하지 않는다').toBe(0);
    });

    await test.step('화면: 피보호자가 시간대 묶음으로 체크·되돌리면 보호자 화면이 새로고침 없이 바뀐다', async () => {
      const sameTime = kstAfter(6);
      const idsUi = [await addMed(gb.api, ward2.id, 'E2E묶음가', sameTime), await addMed(gb.api, ward2.id, 'E2E묶음나', sameTime)];
      const wardPage = await openAs(w2.who, null);
      await watchWs(wardPage);
      await wardPage.goto('/ward/medication');
      await waitForRealtime(wardPage);
      const guardianPage = await openAs(gb.who, null);
      const guardianFrames = await watchWs(guardianPage);
      await guardianPage.goto('/guardian/medication');
      await waitForRealtime(guardianPage);
      await expect(guardianPage.getByText('E2E묶음가')).toBeVisible();
      await expect(guardianPage.getByText('드셨어요')).toHaveCount(0);

      const batch = wardPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/ward/medication/intake/batch'));
      await wardPage.getByRole('button', { name: /약 먹었어요$/ }).click();
      expect((await batch).status()).toBe(200);
      expect(idsUi.map(intakeRows)).toEqual([1, 1]);
      await expect(guardianPage.getByText('오늘 약을 모두 드셨어요'), '보호자 화면 즉시 갱신').toBeVisible();
      await expect.poll(() => frameBodies(guardianFrames, 'medication-taken').filter(f => f.taken === 'true').length, { message: '체크 신호 2건', timeout: 15_000 }).toBe(2);

      const undo = wardPage.waitForResponse(r => r.request().method() !== 'GET' && r.url().includes('/api/ward/medication/'));
      await wardPage.getByRole('button', { name: /복용 체크 되돌리기/ }).click();
      expect((await undo).status()).toBe(200);
      expect(idsUi.map(intakeRows)).toEqual([0, 0]);
      await expect(guardianPage.getByText('드셨어요'), '보호자 화면도 되돌아간다').toHaveCount(0);
      await expect.poll(() => frameBodies(guardianFrames, 'medication-taken').filter(f => f.taken === 'false').length, { message: '해제 신호 2건', timeout: 15_000 }).toBe(2);
    });

    await test.step('푸시·문자 없음: 체크·해제로 두 보호자와 두 피보호자에게 알림 이력이 하나도 생기지 않는다', async () => {
      for (const user of [guardian, ward, g2, ward2]) {
        expect(notiRows(user.id), '알림 이력').toHaveLength(0);
      }
    });
    test.info().annotations.push({
      type: '확인하지 않은 옛 항목',
      description: 'FEUX-G20·MED-G05(체크 실패 때 서버 안내 문구 표시, 404 면 목록 재조회)는 변수 QA 의 tests/variables/feux-a-low.spec.ts 가 같은 화면 흐름을 다룬다. v13 화면은 시간대 묶음 버튼으로 바뀌어 이 묶음에서는 정상 흐름만 확인했다.',
    });
  });

  test('CONN-N31 보호자 복약 현황 카드', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    test.skip(kstMinutesNow() < 150, '한국 시간 새벽 2시 30분 전에는 "2시간 전 복용 시각" 약을 오늘 날짜로 만들 수 없다');
    const guardian = await tempUser('GUARDIAN');
    const wardA = await tempUser('WARD', { name: '가나다' });
    const wardB = await tempUser('WARD', { name: '라마바' });
    const wardPending = await tempUser('WARD');
    const wardGone = await tempUser('WARD');
    const other = await tempUser('GUARDIAN');
    connect(guardian.id, wardA.id);
    connect(guardian.id, wardB.id);
    connect(guardian.id, wardGone.id);
    psql(`UPDATE connection SET status = 'DISCONNECTED' WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(wardGone.id)};`);
    psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, relation) VALUES (${sqlStr(guardian.id)}, ${sqlStr(wardPending.id)}, 'PENDING', ${sqlStr(guardian.id)}, '딸');`);
    const g = await loginAs(guardian);
    const o = await loginAs(other);
    const wa = await loginAs(wardA);
    for (const id of [wardA.id, wardB.id]) await call(g.api, 'PUT', alertPath(id), { missedAlertEnabled: false });
    await addMedViaDb(guardian.id, wardPending.id, 'E2E대기중약');
    const foreignMed = await addMedViaDb(guardian.id, wardGone.id, 'E2E해제된약');
    const normal = await addMed(g.api, wardA.id, 'E2E저녁약', kstAfter(6));
    const early = await addMed(g.api, wardA.id, 'E2E등록전약', kstAfter(-2));

    await test.step('연결된 피보호자 전원 카드: 대기 중·해제된 피보호자는 없다', async () => {
      const cards = await g.api.get<Card[]>('/api/guardian/medication');
      expect(cards.map(c => c.wardId).sort()).toEqual([wardA.id, wardB.id].sort());
    });

    await test.step('약이 있는 카드: 기본 설정값·오늘 날짜·시각 순, 등록 시각은 한국 시간(+09:00)', async () => {
      const cards = await g.api.get<Card[]>('/api/guardian/medication');
      const card = cards.find(c => c.wardId === wardA.id)!;
      expect(card.wardName).toBe(wardA.name);
      expect(card.age, '만 나이(생년월일 1970-01-01)').toBe(Number(kstToday().slice(0, 4)) - 1970);
      expect(card.doseDate).toBe(kstToday());
      expect(card.remindAgainEnabled, '재알림 기본 켜짐').toBe(true);
      expect(card.missedAlertTime).toBe('21:00:00');
      expect([card.takenCount, card.totalCount]).toEqual([0, 2]);
      expect(card.medications.map(m => m.medicationId)).toEqual([early, normal]);
      for (const m of card.medications) {
        expect(m.createdAt, `약 ${m.medicationId} 등록 시각은 한국 시간 표기`).toMatch(/\+09:00$/);
        expect(Number.isNaN(Date.parse(m.createdAt))).toBe(false);
      }
      const early1 = card.medications[0];
      expect(Date.parse(card.medications.find(m => m.medicationId === early)!.createdAt), '등록 시각이 지금 근처').toBeGreaterThan(Date.now() - 600_000);
      expect(early1.doseTime < kstAfter(0), '등록 전 약의 복용 시각은 지금보다 이르다').toBe(true);
    });

    await test.step('약이 없는 피보호자: 카드는 나오고 0/0, 빈 목록', async () => {
      const card = (await g.api.get<Card[]>('/api/guardian/medication')).find(c => c.wardId === wardB.id)!;
      expect(card.wardName).toBe(wardB.name);
      expect([card.takenCount, card.totalCount]).toEqual([0, 0]);
      expect(card.medications).toEqual([]);
      expect(card.missedAlertEnabled).toBe(false);
    });

    await test.step('안내 문구는 보는 사람의 역할별로 다르다', async () => {
      const guardianSide = await call(o.api, 'GET', alertPath(wardA.id));
      expectRes(guardianSide, 403, 'MEDICATION_NOT_AUTHORIZED', '연결 안 된 보호자');
      expect(guardianSide.message).toBe('연결된 피보호자의 복약 정보만 볼 수 있습니다.');
      const wardSide = await call(wa.api, 'POST', `/api/ward/medication/${foreignMed}/intake`);
      expectRes(wardSide, 403, 'MEDICATION_NOT_OWNED', '남의 약 체크');
      expect(wardSide.message).toBe('본인의 약만 체크할 수 있습니다.');
    });

    await test.step('화면: 약이 없으면 "등록된 약이 없어요", 오늘 등록 전이던 약은 회색으로 "오늘은 등록 전이었어요"', async () => {
      const page = await openAs(g.who, '/guardian/medication');
      await page.getByRole('tab', { name: /가나다/ }).click();
      const earlyItem = (await g.api.get<Card[]>('/api/guardian/medication')).find(c => c.wardId === wardA.id)!.medications.find(m => m.medicationId === early)!;
      const slotLabel = ({ MORNING: '아침', LUNCH: '점심', DINNER: '저녁', BEDTIME: '취침 전' } as Record<string, string>)[earlyItem.timeSlot];
      const tile = page.getByRole('group', { name: '시간대 고르기' }).getByRole('button', { name: new RegExp(`^${slotLabel}`) });
      await expect(tile, '등록 전이던 약의 시간대 칸이 보인다').toBeVisible();
      await tile.click();
      await expect(page.getByText('오늘은 등록 전이었어요')).toBeVisible();
      await page.getByRole('tab', { name: /라마바/ }).click();
      await expect(page.getByText('등록된 약이 없어요')).toBeVisible();
    });
  });
});

/** 약을 DB 로 만든다 (연결이 없는 피보호자에게 만드는 조건 준비용). id 를 돌려준다 */
async function addMedViaDb(createdBy: string, wardId: string, name: string): Promise<number> {
  return Number(
    psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time, dose_amount)
          VALUES (${sqlStr(wardId)}, ${sqlStr(createdBy)}, ${sqlStr(name)}, 'MORNING', ${sqlStr(kstAfter(6))}, 1) RETURNING id;`),
  );
}