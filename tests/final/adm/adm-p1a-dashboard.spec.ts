/**
 * 최종 QA - 관리자(ADM) P1a: 안전 대시보드 · 디바이스 관리 · 데모 시드
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 이상감지 상황·알림 이력 행은 임시 피보호자·보호자 id 로만 DB 에 넣는다(사용자 삭제 때 같이 지워지고, 끝에서도 직접 지운다).
 *  - 카메라 행을 만드는 케이스(N14, N43, N44)는 CAM_SIGNAL_ALLOWED=1 일 때만 돈다. 이 묶음에서는 돌리지 않았다.
 *  - AI 서버를 끊거나 서버 설정을 바꿔야 하는 케이스는 test.fixme 로 남겼다.
 *  - 화면 케이스는 진짜 응답의 data 만 바꿔 표시 규칙만 본다.
 *  - 공용 대시보드 숫자는 다른 영역이 동시에 바꿀 수 있어, 만들기 전후를 바로 이어서 재고 "차이"만 비교한다(3번까지 다시 잰다).
 */
import { sqlStr, psql } from '../../../src/remote';
import {
  allKeys, bodyOf, CAM_SIGNAL_ALLOWED, CAM_SKIP_REASON, deleteAuditOf, expect, fulfillJsonError, insertCamera, insertIncident, insertNotificationLog,
  patchDashboard, pendingConnection, settle, TAGS, test, uniq,
} from './_helpers-adm-p1a';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

type Json = Record<string, any>;
const KST_OFFSET = /\+09:00$/;

// ─────────────────────────────────────────────────────────────────────────────
// 안전 대시보드(API)
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-N10 안전 현황 기본 응답', TAGS, async ({ tempUser, signIn }) => {
  const a = await signIn(await tempUser('ADMIN'));
  // 재접속 직후 첫 세션 목록 전에는 이상감지가 null(확인 중)이고 송출·끊김 카메라도 null 이라(ADM-N12), OK 가 될 때까지 기다린 뒤 숫자로 고정한다
  const status = await settle(
    async () => bodyOf(await a.api.raw('GET', '/api/admin/dashboard/ai-status')),
    r => r.status === 200 && r.json.data?.anomalyDetection?.status === 'OK',
    20_000,
    1_500,
  );
  expect(status.json.data?.anomalyDetection?.status, 'AI 이상감지가 정상이 될 때까지 기다린 뒤 본다(전제)').toBe('OK');
  const res = await settle(
    async () => bodyOf(await a.api.raw('GET', '/api/admin/dashboard/safety')),
    r => r.status === 200 && Number.isInteger(r.json.data?.streamingCameras) && Number.isInteger(r.json.data?.safetyEvents?.disconnectedCameras),
    20_000,
    1_500,
  );
  expect(res.status, `안전 현황 응답 상태 ${res.status}`).toBe(200);
  const d = res.json.data as Json;
  expect(d.aiConnected, 'AI 연결된 상태(전제)').toBe(true);
  expect(Number.isInteger(d.subscribedSessions) && d.subscribedSessions >= 0, 'subscribedSessions 는 0 이상 정수').toBe(true);
  expect(Number.isInteger(d.totalCameras) && d.totalCameras >= 0, 'totalCameras 는 0 이상 정수').toBe(true);
  expect(Number.isInteger(d.streamingCameras) && d.streamingCameras >= 0, 'AI 연결·세션 목록 수신 뒤 streamingCameras 는 0 이상 정수').toBe(true);
  expect(Object.keys(d.safetyEvents ?? {}).sort(), 'safetyEvents 칸').toEqual([
    'disconnectedCameras', 'stalePendingConnections', 'todayFailedNotifications', 'wardsWithoutCamera', 'wardsWithoutGuardian', 'wardsWithoutReachableGuardian',
  ].sort());
  for (const [key, value] of Object.entries(d.safetyEvents as Json)) {
    expect(Number.isInteger(value) && (value as number) >= 0, `safetyEvents.${key} 는 0 이상 정수(AI 연결 상태에서 null 이 아니다)`).toBe(true);
  }
  const t = d.todayAnomaly as Json;
  expect(Number.isInteger(t?.total) && t.total >= 0, 'todayAnomaly.total 은 0 이상 정수').toBe(true);
  expect(Array.isArray(t?.byType), 'todayAnomaly.byType 은 배열').toBe(true);
  expect(Object.keys(t?.review ?? {}).sort(), 'todayAnomaly.review 칸(판정 4가지)').toEqual(['conflicted', 'falseAlarm', 'pending', 'real']);
  for (const [key, value] of Object.entries(t.review as Json)) expect(Number.isInteger(value) && (value as number) >= 0, `review.${key} 는 0 이상 정수`).toBe(true);
  expect(Object.keys(t?.aiConfidence ?? {}).sort(), 'todayAnomaly.aiConfidence 칸').toEqual(['average', 'basis']);
  expect(Number.isInteger(t.aiConfidence.basis) && t.aiConfidence.basis >= 0, 'aiConfidence.basis 는 0 이상 정수').toBe(true);
  expect(String(d.generatedAt), 'generatedAt 은 KST(+09:00)').toMatch(KST_OFFSET);
});

test.fixme('ADM-N11 AI 끊기면 모르는 값을 0이 아닌 null로 응답', TAGS, async () => {
  // 자동화 불가: AI 서버 연결을 끊은 상태를 만들어야 한다(서버·AI 설정 변경 금지).
  // 수동 확인: /safety 200, subscribedSessions=0, streamingCameras=null, disconnectedCameras=null(0 아님), 화면은 '확인 불가'
  //   (BE AdminDashboardService.getSafetyDashboard: liveSessionSnapshot 이 비면 null). 화면 쪽은 ADM-A08 이 응답을 고쳐 확인한다.
});

test.fixme('ADM-N12 AI 재연결 직후 첫 세션 목록 전에도 null', TAGS, async () => {
  // 자동화 불가: AI 를 다시 연결한 직후 몇 초의 상태를 만들어야 한다(AI 연결 조작 금지).
  // 수동 확인: streamingCameras=null, disconnectedCameras=null, ai-status.anomalyDetection.status=null(확인 중), 목록을 받은 뒤 실제 숫자.
});

test('ADM-N14 7일 넘은 연결 요청 집계(카메라 없이)', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const guardian2 = await tempUser('GUARDIAN', { phone: null });
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));
  const safety = async () => ((await bodyOf(await a.api.raw('GET', '/api/admin/dashboard/safety'))).json.data as Json);

  // 8일 전 대기 요청은 +1, 방금 만든 대기 요청(0일)은 세지 않는다. 공용 숫자라 전후 차이만 보고 3번까지 다시 잰다
  let note = '';
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    psql(`DELETE FROM connection WHERE ward_id = ${sqlStr(ward.id)};`);
    const before = await safety();
    pendingConnection(guardian.id, ward.id, 8); // 8일 전 대기 요청
    pendingConnection(guardian2.id, ward.id, 0); // 오늘 만든 대기 요청(7일 안)
    const after = await safety();
    const stale = after.safetyEvents.stalePendingConnections - before.safetyEvents.stalePendingConnections;
    note = `시도 ${attempt}: 오래된 연결 요청 +${stale}(기대 +1: 8일 전 것만)`;
    ok = stale === 1;
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(ok, `집계가 기대와 다르다. ${note}`).toBe(true);
});

test('ADM-N14 꺼 둔 카메라는 끊김에서 제외', TAGS, async ({ tempUser, signIn, later }) => {
  test.skip(!CAM_SIGNAL_ALLOWED, CAM_SKIP_REASON);
  test.setTimeout(240_000);
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));
  later(() => void psql(`DELETE FROM camera WHERE ward_id = ${sqlStr(ward.id)};`));
  const safety = async () => ((await bodyOf(await a.api.raw('GET', '/api/admin/dashboard/safety'))).json.data as Json);

  let note = '';
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    psql(`DELETE FROM camera WHERE ward_id = ${sqlStr(ward.id)};`);
    const before = await safety();
    insertCamera(ward.id, `qa-p1a-${tag}-on`, '거실', true);
    insertCamera(ward.id, `qa-p1a-${tag}-off`, '안방', false); // 꺼 둔 카메라
    const after = await safety();
    const dc = (after.safetyEvents.disconnectedCameras as number) - (before.safetyEvents.disconnectedCameras as number);
    note = `시도 ${attempt}: 끊김 카메라 +${dc}(기대 +1: 켜 둔 것만)`;
    ok = dc === 1;
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(ok, `집계가 기대와 다르다. ${note}`).toBe(true);
});

test('ADM-N15 오늘 이상감지: 종류별은 실제 감지만, 판정 4가지, AI 신뢰도', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { name: `QA이상${tag}`, phone: null });
  const a = await signIn(admin);
  later(() => void psql(`DELETE FROM anomaly_incident WHERE ward_id = ${sqlStr(ward.id)};`));
  later(() => deleteAuditOf([admin.id]));
  const today = async () => ((await bodyOf(await a.api.raw('GET', '/api/admin/dashboard/safety'))).json.data.todayAnomaly as Json);
  const countOf = (t: Json, type: string) => (t.byType as { detectedType: string; count: number }[]).find(item => item.detectedType === type)?.count ?? 0;

  // 화재 2건(답 없음 1·진짜 1) · 흉기 1건(잘못 봄) - 공용 숫자라 전후 차이만 비교
  let note = '';
  let ok = false;
  let last: Json = {};
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    psql(`DELETE FROM anomaly_incident WHERE ward_id = ${sqlStr(ward.id)};`);
    const before = await today();
    insertIncident(ward.id, tag, 'FIRE', 'PENDING', 0.5);
    insertIncident(ward.id, tag, 'FIRE', 'REAL', 0.8);
    insertIncident(ward.id, tag, 'WEAPON', 'FALSE_ALARM', 0.6);
    last = await today();
    const d = {
      total: last.total - before.total, fire: countOf(last, 'FIRE') - countOf(before, 'FIRE'), weapon: countOf(last, 'WEAPON') - countOf(before, 'WEAPON'),
      pending: last.review.pending - before.review.pending, real: last.review.real - before.review.real,
      falseAlarm: last.review.falseAlarm - before.review.falseAlarm, conflicted: last.review.conflicted - before.review.conflicted,
    };
    note = `시도 ${attempt}: ${JSON.stringify(d)} (기대 total 3, fire 2, weapon 1, pending 1, real 1, falseAlarm 1, conflicted 0)`;
    ok = d.total === 3 && d.fire === 2 && d.weapon === 1 && d.pending === 1 && d.real === 1 && d.falseAlarm === 1 && d.conflicted === 0;
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(ok, `오늘 이상감지 집계가 기대와 다르다. ${note}`).toBe(true);
  expect(Object.keys(last.review).sort(), '판정 4가지가 모두 있어야 한다(0건이어도)').toEqual(['conflicted', 'falseAlarm', 'pending', 'real']);
  for (const item of last.byType as { count: number }[]) expect(item.count, "byType 에는 실제 감지된 종류만(0건 항목 없음)").toBeGreaterThan(0);

  // 내 피보호자로만 좁힌 요약: 종류·판정·AI 신뢰도(판정 난 건 = 진짜+잘못 본 건의 평균)
  const mine = await bodyOf(await a.api.raw('GET', `/api/admin/anomaly/summary?period=TODAY&keyword=${encodeURIComponent(`QA이상${tag}`)}`));
  expect(mine.status, `내 요약 응답 상태 ${mine.status}`).toBe(200);
  const s = mine.json.data as Json;
  expect((s.byType as { type: string; count: number }[]).map(item => `${item.type}:${item.count}`).sort(), '내 종류별(낙상 0건 항목 없음)').toEqual(['FIRE:2', 'WEAPON:1']);
  expect(s.review, '내 판정별').toEqual({ pending: 1, real: 1, falseAlarm: 1, conflicted: 0 });
  expect(s.aiConfidence.basis, '신뢰도 분모는 판정 난 2건').toBe(2);
  expect(s.aiConfidence.average, '판정 난 건 평균(0.8+0.6)/2').toBeCloseTo(0.7, 3);

  // 대시보드의 신뢰도는 이상감지 요약(오늘)과 같은 값
  let same = false;
  let pair = '';
  for (let i = 0; i < 3 && !same; i++) {
    const dash = (await today()).aiConfidence as Json;
    const sum = ((await bodyOf(await a.api.raw('GET', '/api/admin/anomaly/summary?period=TODAY'))).json.data as Json).aiConfidence as Json;
    pair = `대시보드 basis ${dash.basis}, 요약 basis ${sum.basis}`;
    same = dash.basis === sum.basis && Math.abs((dash.average ?? 0) - (sum.average ?? 0)) < 1e-9;
  }
  expect(same, `대시보드 AI 신뢰도가 이상감지 요약과 다르다. ${pair}`).toBe(true);

  // 판정 난 건이 없으면 0 이 아니라 null
  test.info().annotations.push({
    type: '한계',
    description: "판정 난 건이 없는 상태의 null 은 이상감지 요약(/api/admin/anomaly/summary)으로만 본다. 공용 /safety 는 다른 영역 데이터가 섞여 있어 '판정 0건'을 만들 수 없다. 화면의 '-' 표시는 ADM-A08 이 응답을 바꿔 확인한다.",
  });
  psql(`UPDATE anomaly_incident SET review_status = 'PENDING' WHERE ward_id = ${sqlStr(ward.id)};`);
  const none = await bodyOf(await a.api.raw('GET', `/api/admin/anomaly/summary?period=TODAY&keyword=${encodeURIComponent(`QA이상${tag}`)}`));
  expect(none.json.data.aiConfidence.basis, '판정 난 건 없음').toBe(0);
  expect(none.json.data.aiConfidence.average, '판정 난 건이 없으면 0 이 아니라 null').toBeNull();
  expect(allKeys(none.json.data.review).size).toBe(4);
});

test('ADM-N16 오늘 전달 실패 알림 수', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const guardian = await tempUser('GUARDIAN', { name: `QA알림${tag}`, phone: null });
  const a = await signIn(admin);
  later(() => void psql(`DELETE FROM notification_log WHERE recipient_id = ${sqlStr(guardian.id)};`));
  later(() => deleteAuditOf([admin.id]));
  const failed = async () => ((await bodyOf(await a.api.raw('GET', '/api/admin/dashboard/safety'))).json.data.safetyEvents.todayFailedNotifications as number);

  let note = '';
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    psql(`DELETE FROM notification_log WHERE recipient_id = ${sqlStr(guardian.id)};`);
    const before = await failed();
    insertNotificationLog(guardian.id, ward.id, 'FAILED', null); // 전달 실패 1건
    insertNotificationLog(guardian.id, ward.id, 'NOT_SENT', 'RESTRICTED_ACCOUNT'); // 보내지 않음: 정지 계정
    insertNotificationLog(guardian.id, ward.id, 'NOT_SENT', 'NO_ENABLED_CHANNEL'); // 보내지 않음: 수신자가 꺼 둠
    const after = await failed();
    note = `시도 ${attempt}: 전달 실패 +${after - before}(기대 +1)`;
    ok = after - before === 1;
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(ok, `todayFailedNotifications 가 기대와 다르다. ${note}`).toBe(true);

  // 알림 이력 화면(요약)의 '오늘 · 전송 실패'와 같은 수: 내 수신자로 좁혀서 정확히, 전체는 바로 이어서 대조
  const mine = await bodyOf(await a.api.raw('GET', `/api/admin/notification/summary?period=TODAY&keyword=${encodeURIComponent(`QA알림${tag}`)}`));
  expect(mine.status).toBe(200);
  expect(mine.json.data.failed, '내 수신자의 전송 실패').toBe(1);
  expect(mine.json.data.notSent, '내 수신자의 보내지 않음(실패에 안 셈)').toBe(2);
  let same = false;
  let pair = '';
  for (let i = 0; i < 3 && !same; i++) {
    const dash = await failed();
    const hist = (await bodyOf(await a.api.raw('GET', '/api/admin/notification/summary?period=TODAY'))).json.data.failed as number;
    pair = `대시보드 ${dash}, 이력 ${hist}`;
    same = dash === hist;
  }
  expect(same, `대시보드 전달 실패 수가 알림 이력 '오늘 · 전송 실패'와 다르다. ${pair}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 안전 대시보드(화면)
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A08 화면이 null을 0·\'이상 없음\'으로 바꿔 보이지 않음', TAGS, async ({ tempUser, signIn, openAs }) => {
  test.setTimeout(180_000);
  const a = await signIn(await tempUser('ADMIN'));
  const page = await openAs(a.who, null);
  await patchDashboard(page, {
    safety: d => ({
      ...d,
      aiConnected: false,
      subscribedSessions: 0,
      streamingCameras: null,
      safetyEvents: { ...d.safetyEvents, disconnectedCameras: null },
      todayAnomaly: { total: 0, byType: [], review: { pending: 0, real: 0, falseAlarm: 0, conflicted: 0 }, aiConfidence: { average: null, basis: 0 } },
    }),
    operation: d => ({ ...d, unansweredInquiries: { count: 0, longestWaitingHours: null } }),
    aiStatus: d => ({
      ...d,
      anomalyDetection: { status: 'DISCONNECTED', checkedAt: d.generatedAt },
      chatbot: { status: null, checkedAt: d.generatedAt },
      companion: { status: null, checkedAt: d.generatedAt },
    }),
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드', exact: true })).toBeVisible();

  const device = page.getByRole('link', { name: '디바이스 관리 페이지로 이동' });
  await expect(device).toBeVisible();
  const valueOf = (scope: import('@playwright/test').Locator, label: string) =>
    scope.locator('div').filter({ has: page.getByText(label, { exact: true }) }).last().locator('b');
  await expect(valueOf(device, '꺼진 카메라'), '끊김 카메라 칸은 확인 불가').toHaveText('확인 불가');
  await expect(device.getByText('AI 수신기 연결이 끊겨 켜짐·꺼짐 대수를 알 수 없습니다.')).toBeVisible();
  await expect(device.getByText(/켜짐 0대|꺼짐 0대/), '0대로 그리면 안 된다').toHaveCount(0);
  // 송출(켜짐) 칸도 확인 불가: 켜짐·꺼짐 막대 대신 안내문만 나온다
  await expect(device.getByText('켜짐', { exact: true }), '송출(켜짐) 칸은 숫자 대신 확인 불가 안내여야 한다').toHaveCount(0);
  await expect(device.getByText('꺼짐', { exact: true }), '꺼짐 칸도 숫자로 그려지면 안 된다').toHaveCount(0);

  const bar = page.getByRole('region', { name: 'AI 서비스 상태' });
  await expect(bar.getByText('연결 끊김'), '이상감지 끊김 표시').toBeVisible();
  await expect(bar.getByText('확인 불가').first(), '챗봇·말벗 확인 불가').toBeVisible();
  await expect(bar.getByText('정상'), 'AI 가 끊겼는데 정상으로 보인다').toHaveCount(0);

  const support = page.getByRole('link', { name: '고객센터 페이지로 이동' });
  test.info().annotations.push({
    type: '문서와 코드 차이',
    description: "[문서-코드 불일치 보고] 문서는 문의 대기시간 null 을 '없음'으로 적었지만 화면은 '-'로 그린다(0시간 아님). 코드 값('-')으로 고정한다. AI 신뢰도(null='-')는 대시보드가 아니라 AI 통계 화면의 '보호자 응답 · AI 신뢰도' 칸이라 아래에서 따로 확인한다.",
  });
  await expect(valueOf(support, '최장 대기'), '대기 문의가 없으면 0시간이 아니라 -').toHaveText('-');
  await expect(support.getByText('0시간')).toHaveCount(0);
  const aiStats = page.getByRole('link', { name: 'AI 통계 페이지로 이동' });
  await expect(valueOf(aiStats, 'AI 오탐률'), '판정 응답이 없으면 0%가 아니라 -').toHaveText('-');
  await expect(aiStats.getByText('오늘 감지된 상황이 없습니다.')).toBeVisible();

  // AI 신뢰도: 판정 난 건이 없으면(average=null) 0%가 아니라 '-'. 이 값을 그리는 AI 통계 화면에서 본다
  await page.route(/\/api\/admin\/anomaly\/summary(\?|$)/, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    try {
      const response = await route.fetch();
      const body = (await response.json()) as Json;
      body.data = { ...(body.data ?? {}), aiConfidence: { average: null, basis: 0 } };
      await route.fulfill({ response, json: body });
    } catch {
      // 이전 화면이 닫히며 끊긴 요청이다(무시). 새 화면의 요청은 이 핸들러가 다시 받는다
    }
  });
  await page.goto('/admin/ai-stats');
  const quality = page.locator('section').filter({ has: page.getByRole('heading', { name: '보호자 응답 · AI 신뢰도' }) }).last();
  const confidence = quality.locator('div').filter({ has: page.getByText('AI 신뢰도', { exact: true }) }).last().locator('strong');
  await expect(confidence, 'AI 신뢰도가 null 이면 0%가 아니라 -').toHaveText('-', { timeout: 30_000 });
});

test('ADM-N19 대시보드 화면: 잘못 본 비율은 응답률과 함께 표시', TAGS, async ({ tempUser, signIn, openAs }) => {
  test.setTimeout(180_000);
  const a = await signIn(await tempUser('ADMIN'));
  const page = await openAs(a.who, null);
  // 오늘 5건 중 3건 답변(미판정 2, 위험 2, 오탐 1), 안전 현황은 3분 전 확인
  await patchDashboard(page, {
    safety: d => ({
      ...d,
      todayAnomaly: {
        total: 5,
        byType: [{ detectedType: 'FIRE', count: 4 }, { detectedType: 'WEAPON', count: 1 }],
        review: { pending: 2, real: 2, falseAlarm: 1, conflicted: 0 },
        aiConfidence: { average: 0.7, basis: 3 },
      },
      generatedAt: new Date(Date.now() - 3 * 60_000 - 5_000).toISOString(),
    }),
  });
  await page.goto('/admin');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드', exact: true })).toBeVisible();

  const stats = page.getByRole('article').filter({ has: page.getByRole('heading', { level: 3, name: 'AI 이상감지' }) });
  const valueOf = (label: string) => stats.locator('div').filter({ has: page.getByText(label, { exact: true }) }).last().locator('b');
  await expect(valueOf('오늘 감지')).toHaveText('5건');
  await expect(valueOf('위험')).toHaveText('2건');
  await expect(valueOf('AI 오탐률'), '오탐은 판정 응답 3건 중 1건 = 33%').toHaveText('33%');
  await expect(stats.getByText('판정 응답 3 / 5건 (응답률 60%) 기준'), '응답률과 같이 표시').toBeVisible();
  await expect(page.getByText(/안전 현황 3분 전/), "'N분 전 확인' 표시").toBeVisible();
  await expect(page.getByText(/^오탐 \d+건$/), '오탐 건수만 덜렁 표시되면 안 된다').toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 디바이스 관리
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A31 AI 끊김 시 LIVE/OFFLINE 필터 503 화면 표시', TAGS, async ({ tempUser, signIn, openAs }) => {
  test.setTimeout(180_000);
  test.info().annotations.push({
    type: '수동 확인',
    description: '서버 쪽(AI 연결을 끊으면 status=ALL 은 liveStatus=null 로 200, LIVE·OFFLINE 은 빈 목록이 아니라 503 CAMERA_LIVE_STATUS_UNKNOWN, summary 는 aiConnected=false·live·offline=null)은 AI 연결을 끊어야 해서 자동화하지 않는다(BE AdminCameraService.getCameras / getSummary). 여기서는 브라우저에서 503 을 대신 돌려줘 화면 표시만 본다(서버로 요청이 가지 않는다).',
  });
  const a = await signIn(await tempUser('ADMIN'));
  const page = await openAs(a.who, null);
  // 정상 작동·끊긴 카메라 필터(status=LIVE|OFFLINE)만 대신 답한다. 전체 목록(status=ALL)과 summary 는 진짜 응답 그대로.
  // 화면은 503 이거나 에러 code 가 CAMERA_LIVE_STATUS_UNKNOWN 이면 확인 불가로 그린다(FE isLiveStatusUnknown).
  // 공용 감시(fixtures)가 /api 의 5xx 를 전부 버그로 세므로, 대신 돌려주는 응답은 상태를 424 로 두고 code 만 실제와 같게 쓴다.
  await page.route(/\/api\/admin\/camera\?(?=.*status=(LIVE|OFFLINE))/, route =>
    fulfillJsonError(route, 424, { success: false, code: 'CAMERA_LIVE_STATUS_UNKNOWN', message: '카메라 연결 상태를 확인할 수 없습니다.', data: null }),
  );

  await page.goto('/admin/devices');
  await expect(page.getByRole('heading', { level: 1, name: '디바이스 관리', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /정상 작동/ }).click();
  await expect(page.getByText('지금 연결 상태를 확인할 수 없습니다.'), 'LIVE 필터 503 은 확인 불가 안내').toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('조건에 맞는 카메라가 없습니다.'), '503 을 빈 목록(없음)으로 그리면 안 된다').toHaveCount(0);

  // 전체 보기로 돌아가면 목록이 다시 보인다(전체 목록은 AI 가 끊겨도 조회 가능)
  await page.getByRole('button', { name: '전체 보기' }).click();
  await expect(page.getByText('지금 연결 상태를 확인할 수 없습니다.'), '전체 보기에서는 확인 불가 안내가 없어야 한다').toHaveCount(0, { timeout: 30_000 });

  await page.getByRole('button', { name: /연결이 끊긴 카메라/ }).click();
  await expect(page.getByText('지금 연결 상태를 확인할 수 없습니다.'), 'OFFLINE 필터 503 은 확인 불가 안내').toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('조건에 맞는 카메라가 없습니다.'), '503 을 빈 목록(없음)으로 그리면 안 된다').toHaveCount(0);
});

test('ADM-N43 카메라 목록·상태 필터·검색', TAGS, async ({ tempUser, signIn, later }) => {
  test.skip(!CAM_SIGNAL_ALLOWED, CAM_SKIP_REASON);
  test.setTimeout(240_000);
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { name: `QA카메라${tag}`, phone: null });
  const a = await signIn(admin);
  later(() => void psql(`DELETE FROM camera WHERE ward_id = ${sqlStr(ward.id)};`));
  later(() => deleteAuditOf([admin.id]));
  insertCamera(ward.id, `qa-p1a-${tag}-1`, '거실', true);
  psql('SELECT pg_sleep(1.1);');
  insertCamera(ward.id, `qa-p1a-${tag}-2`, '안방', true);
  const get = async (query: string) => bodyOf(await a.api.raw('GET', `/api/admin/camera?${query}`));

  // q: 공백 제거·소문자 부분 일치 (이름 일부를 공백·대문자로 섞어서)
  const q = `qa 카메라 ${tag.toUpperCase()}`;
  const all = await get(`status=ALL&q=${encodeURIComponent(q)}`);
  expect(all.status, `목록 응답 상태 ${all.status}`).toBe(200);
  const page = all.json.data as Json;
  expect(Object.keys(page).sort(), 'PageResponse 칸').toEqual(['content', 'last', 'page', 'size', 'totalElements', 'totalPages']);
  expect(page.totalElements).toBe(2);
  const items = page.content as Json[];
  expect(items.map(item => item.room), '등록 최신순').toEqual(['안방', '거실']);
  const wardAddress = psql(`SELECT address FROM users WHERE id = ${sqlStr(ward.id)};`);
  for (const item of items) {
    expect(Object.keys(item).sort(), '카메라 한 건의 칸').toEqual(
      ['cameraId', 'isActive', 'liveStatus', 'registeredAt', 'room', 'sessionId', 'wardAddress', 'wardId', 'wardName'],
    );
    expect(item.wardAddress, '주소만(상세 주소 없음)').toBe(wardAddress);
    expect(String(item.registeredAt), 'registeredAt 은 KST').toMatch(KST_OFFSET);
  }
  test.info().annotations.push({ type: '한계', description: '내 카메라는 AI 가 영상을 받지 않아 OFFLINE 이다. 실제 송출 중(LIVE) 카메라는 CAM 영역에서 확인한다.' });
  const offline = await get(`status=OFFLINE&q=${encodeURIComponent(tag)}`);
  expect(offline.status, `OFFLINE 필터 응답 상태 ${offline.status}`).toBe(200);
  expect(offline.json.data.totalElements, '구독 중이 아닌 카메라는 OFFLINE').toBe(2);
  for (const item of offline.json.data.content as Json[]) expect(item.liveStatus).toBe('OFFLINE');
  const live = await get(`status=LIVE&q=${encodeURIComponent(tag)}`);
  expect(live.json.data.totalElements, '구독 중이 아니므로 LIVE 에는 없다').toBe(0);
  const session = await get(`q=${encodeURIComponent(` QA-P1A-${tag.toUpperCase()}-1 `)}`);
  expect(session.json.data.totalElements, '세션 ID 일부로 검색').toBe(1);
  const bad = await get('status=NOPE');
  expect(bad.status, '잘못된 status 값').toBe(400);
});

test('ADM-N44 카메라 summary 합계와 꺼 둔·탈퇴 처리 중 카메라', TAGS, async ({ tempUser, signIn, later }) => {
  test.skip(!CAM_SIGNAL_ALLOWED, CAM_SKIP_REASON);
  test.setTimeout(240_000);
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const leaving = await tempUser('WARD', { phone: null, status: 'INACTIVE' });
  const a = await signIn(admin);
  later(() => void psql(`DELETE FROM camera WHERE ward_id IN (${sqlStr(ward.id)}, ${sqlStr(leaving.id)});`));
  later(() => deleteAuditOf([admin.id]));
  const summary = async () => ((await bodyOf(await a.api.raw('GET', '/api/admin/camera/summary'))).json.data as Json);

  let note = '';
  let ok = false;
  let last: Json = {};
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    psql(`DELETE FROM camera WHERE ward_id IN (${sqlStr(ward.id)}, ${sqlStr(leaving.id)});`);
    const before = await summary();
    insertCamera(ward.id, `qa-p1a-${tag}-on`, '거실', true);
    insertCamera(ward.id, `qa-p1a-${tag}-off`, '안방', false); // 꺼 둔 카메라도 센다
    insertCamera(leaving.id, `qa-p1a-${tag}-leaving`, '거실', true); // 탈퇴 처리 중: 제외
    last = await summary();
    note = `시도 ${attempt}: 등록 +${last.registered - before.registered}(기대 +2)`;
    ok = last.registered - before.registered === 2;
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(ok, `등록 수가 기대와 다르다. ${note}`).toBe(true);
  expect(last.aiConnected, 'AI 연결(전제)').toBe(true);
  expect(last.live + last.offline, 'live + offline = registered').toBe(last.registered);
  expect(last.maxTotal, '서비스 전체 등록 상한').toBe(3);
});

// ─────────────────────────────────────────────────────────────────────────────
// 데모 시드
// ─────────────────────────────────────────────────────────────────────────────

test.fixme('ADM-A35 데모 시드 권한과 운영 환경 보호', TAGS, async () => {
  // 자동화 불가: 배포 코드(BE dfe536b4 작업 트리, FE a8666240, AI 9cf51d6)와 설명서 어디에도 "데모 시드" 실행 주소·기능이 없다
  //   (grep 결과 없음). 호출할 주소를 알 수 없고 운영(prod) 설정에서 실행해 볼 수도 없다.
  // 확인 필요: 기능이 있다면 주소·권한(비로그인 401, 일반 회원 403)·운영 환경 차단 규칙을 문서로 확정한 뒤 케이스를 채운다.
});
