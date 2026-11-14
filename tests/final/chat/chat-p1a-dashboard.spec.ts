/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1a: 보호자 홈 대시보드 (GET /api/guardian/dashboard)
 * 근거: BE 프로젝트_설명.txt 3-15 (2216-2238행), GuardianDashboardService, FE 배포본 a8666240 GuardianDashboardContent
 * 임시 사용자와 그 사용자의 행(약·SOS·카메라·상황)만 만든다. 보호자 알림(푸시·문자)은 쿨다운·기록으로 막는다.
 */
import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import {
  CAM_SIGNAL_ALLOWED, callFull, cleanupChat, connectOld, dashboardPath, insertCamera, insertIncident, insertMedication, loginSafe,
  marker, quietMedication, sendSos, setConnectionStatus, TAGS,
} from './_helpers-chat-p1a';
import { psql, sqlStr } from '../../../src/remote';

const dash = async (api: Parameters<typeof callFull>[0], query = '') => callFull(api, 'GET', dashboardPath(query), undefined, 30_000);

test.describe('CHAT P1a - 보호자 대시보드', () => {
  test.afterEach(async () => {
    await cleanupChat(test.info());
  });

  test('CHAT-A06 wardId 가 숫자·특수문자 등 형식 틀림', TAGS, async ({ tempUser }) => {
    const gUser = await tempUser('GUARDIAN');
    const wUser = await tempUser('WARD', { name: '큐에이한울' });
    connect(gUser.id, wUser.id);
    const other = await tempUser('WARD', { name: '큐에이남남' });
    const g = await loginSafe(gUser);

    const values: Array<[string, string]> = [
      ['abc!@#', 'abc!@#'],
      ['매우 긴 값(300자)', 'a'.repeat(300)],
      ['../1', '../1'],
      ['7자', 'abcdefg'],
      ['한글', '가나다'],
      ['숫자만 긴 값', '1234567890'],
    ];
    for (const [label, value] of values) {
      const res = await dash(g.api, `?wardId=${encodeURIComponent(value)}`);
      expect(res.status, `wardId ${label}`).toBe(403); // 문서에는 코드가 없음 - 코드 기준 403
      expect(res.json?.code, `wardId ${label} code`).toBe('DASHBOARD_NOT_AUTHORIZED');
      expect(res.json?.data, `wardId ${label}: 데이터가 같이 오지 않는다`).toBeUndefined();
      expect(res.text, `wardId ${label}: 내 피보호자 이름도 안 온다`).not.toContain('큐에이한울');
      expect(res.text, `wardId ${label}: 남의 이름도 안 온다`).not.toContain(other.name);
    }
    test.info().annotations.push({ type: '문서와 다른 점', description: '문서는 "4xx, 코드 없음(확인 필요)". 배포 코드는 형식이 틀린 wardId 를 403 DASHBOARD_NOT_AUTHORIZED 로 거절한다(원문은 로그에 안 남김). 이 값으로 고정했다.' });
    // 형식은 맞지만 없는 ID 도 같은 403
    const missing = await dash(g.api, '?wardId=zzzzzz');
    expect(missing.status).toBe(403);
    expect(missing.json?.code).toBe('DASHBOARD_NOT_AUTHORIZED');
    // 대조: 올바른 연결 ID 는 200
    expect((await dash(g.api, `?wardId=${wUser.id}`)).status, '올바른 wardId').toBe(200);
  });

  test('CHAT-N01 wardId 없이 연결된 피보호자 전원 합산', TAGS, async ({ tempUser }) => {
    const gUser = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD', { name: '큐에이한울' });
    const w2 = await tempUser('WARD', { name: '큐에이다솜' });
    const wOff = await tempUser('WARD', { name: '큐에이해제' }); // 연결 해제됨 - 합산 제외
    const wPending = await tempUser('WARD', { name: '큐에이대기' }); // 요청 대기 중 - 합산 제외
    connectOld(gUser.id, w1.id);
    connectOld(gUser.id, w2.id);
    connectOld(gUser.id, wOff.id);
    setConnectionStatus(gUser.id, wOff.id, 'DISCONNECTED');
    psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, relation)
          VALUES (${sqlStr(gUser.id)}, ${sqlStr(wPending.id)}, 'PENDING', ${sqlStr(gUser.id)}, '기타');`);
    for (const w of [w1, w2, wOff]) quietMedication(gUser.id, w.id);
    insertMedication({ wardId: w1.id, createdBy: gUser.id, name: 'E2E약일', createdYesterday: true });
    insertMedication({ wardId: w2.id, createdBy: gUser.id, name: 'E2E약이', createdYesterday: true });
    insertMedication({ wardId: wOff.id, createdBy: gUser.id, name: 'E2E약삼', createdYesterday: true });
    const g = await loginSafe(gUser);
    const ward1 = await loginSafe(w1);
    await sendSos(ward1);

    const res = await dash(g.api);
    expect(res.status).toBe(200);
    const d = res.json.data;
    expect(Object.keys(d).sort(), '응답 칸').toEqual(['anomalyDetection', 'medication', 'pendingActions', 'sos', 'unavailable', 'wards']);
    expect(Object.keys(d.pendingActions).sort(), 'pendingActions 칸').toEqual(['anomaly', 'medication', 'total']);
    expect(d.unavailable, '조회 실패 칸 없음').toEqual([]);
    expect(d.wards.map((w: { wardId: string }) => w.wardId).sort(), 'ACTIVE 연결 피보호자 전원').toEqual([w1.id, w2.id].sort());
    expect(d.wards.map((w: { wardName: string }) => w.wardName).sort()).toEqual(['큐에이다솜', '큐에이한울']);
    for (const chip of d.wards) expect(chip.pendingCount, `${chip.wardName} 칩 건수`).toBe(1);
    expect(d.pendingActions, '합산').toEqual({ total: 2, anomaly: 0, medication: 2 });
    expect(d.anomalyDetection).toEqual({ needsReviewCount: 0, latest: null });
    expect(d.medication.uncheckedCount, '복약 미체크 합산').toBe(2);
    expect(d.medication.mostUrgent, '가장 이른 1건').toBeTruthy();
    expect(d.sos.thisMonthCount, '이번 달 SOS').toBe(1);
    expect(d.sos.latest, '가장 최근 SOS').toBeTruthy();
    expect(res.text, '해제·대기 피보호자는 합산에 없다').not.toContain('큐에이해제');
    expect(res.text).not.toContain('큐에이대기');
  });

  test('CHAT-N02 wardId 지정 시 그 피보호자만 집계', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(240_000);
    const gUser = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD', { name: '큐에이한울' });
    const w2 = await tempUser('WARD', { name: '큐에이다솜' });
    connectOld(gUser.id, w1.id);
    connectOld(gUser.id, w2.id);
    for (const w of [w1, w2]) quietMedication(gUser.id, w.id);
    insertMedication({ wardId: w1.id, createdBy: gUser.id, name: 'E2E약일', createdYesterday: true });
    insertMedication({ wardId: w2.id, createdBy: gUser.id, name: 'E2E약이', createdYesterday: true });
    insertMedication({ wardId: w2.id, createdBy: gUser.id, name: 'E2E약삼', createdYesterday: true });
    const g = await loginSafe(gUser);
    await sendSos(await loginSafe(w2)); // SOS 는 w2 에만

    const one = (await dash(g.api, `?wardId=${w1.id}`)).json.data;
    expect(one.wards, '지정한 피보호자 칩만').toEqual([{ wardId: w1.id, wardName: '큐에이한울', pendingCount: 1 }]);
    expect(one.pendingActions).toEqual({ total: 1, anomaly: 0, medication: 1 });
    expect(one.medication.uncheckedCount).toBe(1);
    expect(one.sos.thisMonthCount, 'w1 에는 SOS 가 없다').toBe(0);
    const two = (await dash(g.api, `?wardId=${w2.id}`)).json.data;
    expect(two.wards).toEqual([{ wardId: w2.id, wardName: '큐에이다솜', pendingCount: 2 }]);
    expect(two.pendingActions).toEqual({ total: 2, anomaly: 0, medication: 2 });
    expect(two.sos.thisMonthCount, 'w2 의 SOS').toBe(1);
    const all = (await dash(g.api)).json.data;
    expect(all.pendingActions, '전체 합산').toEqual({ total: 3, anomaly: 0, medication: 3 });
    const chipCounts = Object.fromEntries(all.wards.map((w: { wardId: string; pendingCount: number }) => [w.wardId, w.pendingCount]));
    expect(chipCounts, '전체 응답의 칩 건수').toEqual({ [w1.id]: 1, [w2.id]: 2 });

    // 화면: 피보호자 칩(탭)을 누르면 그 사람 숫자만 보이고, 칩 배지는 전체 기준 건수와 맞는다
    const page = await openAs(g.who, null);
    await page.goto('/guardian');
    const tablist = page.getByRole('tablist', { name: '피보호자 선택' });
    const tab1 = tablist.getByRole('tab', { name: /큐에이한울/ });
    const tab2 = tablist.getByRole('tab', { name: /큐에이다솜/ });
    await expect(tab1).toBeVisible();
    await expect(tab1.locator('i'), '한울 칩 배지').toHaveText('1');
    await expect(tab2.locator('i'), '다솜 칩 배지').toHaveText('2');
    const badge = page.locator('span[class*="attentionBadge"]');
    const quick = page.getByRole('navigation', { name: '빠른 이동' });

    // 처음에 어느 칩이 선택돼 있는지는 연결 시각 순서라, 선택돼 있지 않은 칩만 눌러 요청을 기다린다
    const choose = async (tab: typeof tab1, wardId: string) => {
      if ((await tab.getAttribute('aria-selected')) !== 'true') {
        // 이미 한 번 받은 피보호자는 화면 캐시를 쓰므로 요청을 기다리지 않고, 아래에서 화면 값을 직접 본다
        await tab.click();
      }
      await expect(tab, `${wardId} 칩 선택됨`).toHaveAttribute('aria-selected', 'true');
    };
    await choose(tab2, w2.id);
    await expect(badge, '다솜 선택: 확인이 필요한 일').toHaveText(/확인이 필요한 일 2건/);
    await expect(quick.getByRole('link', { name: /이번 달 SOS 1건/ }), '다솜 SOS').toBeVisible();

    await choose(tab1, w1.id);
    await expect(badge, '한울 선택: 확인이 필요한 일').toHaveText(/확인이 필요한 일 1건/);
    await expect(quick.getByRole('link', { name: /이번 달 SOS/ }), '한울에게는 SOS 가 없다').toHaveCount(0);
    // 다시 다솜을 고르면 처음 값으로 돌아온다 (한울 -> 다솜 방향도 확인)
    await choose(tab2, w2.id);
    await expect(badge).toHaveText(/확인이 필요한 일 2건/);
  });

  test('CHAT-N03 확인이 필요한 일 = 이상감지 확인 필요 + 복약 미체크 (SOS 제외)', TAGS, async ({ tempUser }) => {
    const gUser = await tempUser('GUARDIAN');
    const wUser = await tempUser('WARD', { name: '큐에이한울' });
    connectOld(gUser.id, wUser.id);
    quietMedication(gUser.id, wUser.id);
    insertMedication({ wardId: wUser.id, createdBy: gUser.id, name: 'E2E약일', createdYesterday: true });
    const g = await loginSafe(gUser);
    await sendSos(await loginSafe(wUser));

    // 이상감지 없이: 복약 1 + SOS 1건 -> total 은 1 (SOS 는 안 센다)
    const base = (await dash(g.api)).json.data;
    expect(base.sos.thisMonthCount, '이번 달 SOS 1건').toBe(1);
    expect(base.pendingActions, 'SOS 는 total 에 안 들어간다').toEqual({ total: 1, anomaly: 0, medication: 1 });

    test.info().annotations.push({ type: '확인 범위', description: '이 테스트는 복약 1·SOS 1 으로 "SOS 제외(total=1)"만 확인한다. 이상감지 합산(anomaly=2, total=3)은 아래 별도 테스트(CHAT-N03 이상감지 합산)에서 CAM_SIGNAL_ALLOWED=1 일 때만 돈다.' });
  });

  test('CHAT-N03 이상감지 합산: PENDING 1 + CONFLICTED 1 = anomaly 2, total 3', TAGS, async ({ tempUser }) => {
    test.skip(!CAM_SIGNAL_ALLOWED, '카메라 행·이상감지 상황을 만드는 케이스라 CAM_SIGNAL_ALLOWED=1 일 때만 돈다 (이번 실행에서는 확인 안 함)');
    const gUser = await tempUser('GUARDIAN');
    const wUser = await tempUser('WARD', { name: '큐에이한울' });
    connectOld(gUser.id, wUser.id);
    quietMedication(gUser.id, wUser.id);
    insertMedication({ wardId: wUser.id, createdBy: gUser.id, name: 'E2E약일', createdYesterday: true });
    const g = await loginSafe(gUser);
    await sendSos(await loginSafe(wUser));

    // 이상감지: PENDING 1 + CONFLICTED 1 (+ 세지 않는 확인 끝난 상황 2)
    const session = marker('qan3');
    insertCamera(wUser.id, session);
    insertIncident(wUser.id, session, 'PENDING');
    insertIncident(wUser.id, session, 'CONFLICTED');
    insertIncident(wUser.id, session, 'REAL');
    insertIncident(wUser.id, session, 'FALSE_ALARM');
    const d = (await dash(g.api)).json.data;
    expect(d.pendingActions, 'anomaly=2, medication=1, total=3').toEqual({ total: 3, anomaly: 2, medication: 1 });
    expect(d.anomalyDetection.needsReviewCount).toBe(2);
    expect(d.sos.thisMonthCount, 'SOS 는 그대로 1건이고 total 에는 없다').toBe(1);
  });

  test('CHAT-N04 지금 등록된 카메라 상황만 이상감지 확인 필요로 센다', TAGS, async ({ tempUser }) => {
    test.skip(!CAM_SIGNAL_ALLOWED, '카메라 행·이상감지 상황을 만드는 케이스라 CAM_SIGNAL_ALLOWED=1 일 때만 돈다');
    const gUser = await tempUser('GUARDIAN');
    const wUser = await tempUser('WARD', { name: '큐에이한울' });
    connectOld(gUser.id, wUser.id);
    const g = await loginSafe(gUser);
    const live = marker('qan4a');
    const gone = marker('qan4b');
    insertCamera(wUser.id, live);
    insertIncident(wUser.id, live, 'PENDING');
    insertIncident(wUser.id, gone, 'PENDING'); // 등록된 카메라가 없는 세션 = 지워진 카메라의 상황
    const d = (await dash(g.api)).json.data;
    expect(d.anomalyDetection.needsReviewCount, '지금 등록된 카메라의 상황만').toBe(1);
    expect(d.pendingActions.anomaly).toBe(1);

    // 사용 중지(비활성)한 카메라의 상황은 코드상 그대로 센다 ("사용 중지 포함")
    psql(`UPDATE camera SET is_active = false WHERE ward_id = ${sqlStr(wUser.id)} AND session_id = ${sqlStr(live)};`);
    const inactive = (await dash(g.api)).json.data;
    expect(inactive.anomalyDetection.needsReviewCount, '사용 중지한 카메라 상황(코드 기준: 센다)').toBe(1);
    test.info().annotations.push({ type: '문서와 다른 점', description: '케이스 단계는 "지우거나 사용 중지"인데, 배포 코드(CameraRepository.findSessionIdsByWardIdIn)는 사용 중지 카메라도 등록된 것으로 센다. 지운 카메라만 빠진다. 코드 값으로 고정했다.' });

    // 카메라를 지우면 그 상황은 안 센다
    psql(`DELETE FROM camera WHERE ward_id = ${sqlStr(wUser.id)} AND session_id = ${sqlStr(live)};`);
    const removed = (await dash(g.api)).json.data;
    expect(removed.anomalyDetection.needsReviewCount, '지운 카메라 상황은 안 센다').toBe(0);
    expect(removed.pendingActions, '합계도 0').toEqual({ total: 0, anomaly: 0, medication: 0 });
    expect(removed.anomalyDetection.latest, '최신 1건도 없다').toBeNull();
  });

  test('CHAT-N05 복약 미체크에서 복용 시각 뒤에 등록한 약은 뺀다', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(180_000);
    const gUser = await tempUser('GUARDIAN');
    const wUser = await tempUser('WARD', { name: '큐에이한울' });
    connectOld(gUser.id, wUser.id);
    quietMedication(gUser.id, wUser.id);
    const g = await loginSafe(gUser);

    // 복용 시각(00:00)이 지난 뒤 오늘 새로 등록한 약만 있을 때: 미체크로 안 센다
    insertMedication({ wardId: wUser.id, createdBy: gUser.id, name: 'E2E오늘등록약' });
    const onlyNew = (await dash(g.api)).json.data;
    expect(onlyNew.medication, '오늘 등록한 약은 안 센다(registeredAfterDose)').toEqual({ uncheckedCount: 0, mostUrgent: null });
    expect(onlyNew.pendingActions).toEqual({ total: 0, anomaly: 0, medication: 0 });
    expect(onlyNew.wards[0].pendingCount).toBe(0);

    // 어제 등록한 약을 더하면 그 약만 센다
    const oldId = insertMedication({ wardId: wUser.id, createdBy: gUser.id, name: 'E2E어제등록약', createdYesterday: true });
    const both = (await dash(g.api)).json.data;
    expect(both.medication.uncheckedCount, '어제 등록한 약만').toBe(1);
    expect(both.medication.mostUrgent.medicationId).toBe(oldId);
    expect(both.pendingActions).toEqual({ total: 1, anomaly: 0, medication: 1 });
    expect(JSON.stringify(both.medication), '응답에 "안 드셨습니다" 같은 단정 문구가 없다').not.toContain('안 드셨');

    // 안내 문구: 화면은 "체크되지 않았어요" 로 말하고 "안 드셨습니다" 로 단정하지 않는다
    const page = await openAs(g.who, '/guardian/medication');
    await expect(page.getByText('E2E어제등록약').first()).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text, '미복용 단정 문구가 없다').not.toContain('안 드셨');
    expect(text, '"체크되지 않았" 안내').toContain('체크되지 않았');
    test.info().annotations.push({ type: '문서와 다른 점', description: '문서 표기는 "체크되지 않았습니다", 배포본 FE 는 "체크되지 않았어요". 뜻이 같아 "체크되지 않았" 으로 확인했다.' });
  });

  test('CHAT-N07 연결된 피보호자 0명이면 null 이 아니라 0', TAGS, async ({ tempUser }) => {
    const g = await loginSafe(await tempUser('GUARDIAN')); // 연결 없음
    const res = await dash(g.api);
    expect(res.status).toBe(200);
    expect(res.json.data, '모든 칸이 0·빈 값(null 아님)').toEqual({
      pendingActions: { total: 0, anomaly: 0, medication: 0 },
      wards: [],
      anomalyDetection: { needsReviewCount: 0, latest: null },
      sos: { thisMonthCount: 0, latest: null },
      medication: { uncheckedCount: 0, mostUrgent: null },
      unavailable: [],
    });
  });
});
