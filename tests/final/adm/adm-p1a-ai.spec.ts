/**
 * 최종 QA - 관리자(ADM) P1a: AI 상태 카드 · AI 통계
 *
 * 안전:
 *  - 임시 관리자(tempUser)만 쓴다. 고정 계정·setup 은 쓰지 않는다.
 *  - Redis 는 이 임시 관리자 id 가 붙은 속도 제한 키만 읽고 지운다(rate:* 전체 삭제 없음).
 *  - AI 서버를 끊거나 지연시키고, 서버 설정(환경변수)을 바꿔 재기동해야 하는 케이스는 test.fixme(자동화 불가)로 남긴다.
 *  - 챗봇 통계 조회는 실제 AI 서버를 부르므로 기간을 바꿔 가며 반복하지 않고 최소로만 부른다.
 *  - 화면 케이스는 진짜 응답의 data 만 바꿔 화면 표시 규칙을 본다(CORS 등은 진짜 응답 그대로).
 */
import { redis } from '../../../src/remote';
import {
  adminLogCount, aiItem, aiStatsKeys, allKeys, bodyOf, deleteOwnKeys, expect, expectError, fulfillJsonError, kstDate,
  patchDashboard, redisCounter, settle, TAGS, test,
} from './_helpers-adm-p1a';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const KST_OFFSET = /\+09:00$/;

// ─────────────────────────────────────────────────────────────────────────────
// AI 상태 카드
// ─────────────────────────────────────────────────────────────────────────────

test.fixme('ADM-A33 AI 확인 실패는 \'끊김\'이 아니라 null(확인 불가)', TAGS, async () => {
  // 자동화 불가: AI 서버를 응답 없게 만들고 챗봇 확인 주소를 5초 넘게 지연시키려면 서버 설정·컨테이너를 바꿔야 한다(금지).
  // 수동 확인: AI 챗봇 확인이 실패하면 chatbot.status=null(DISCONNECTED 아님), 응답은 최대 약 5초 안에 와야 한다
  //   (BE AdminAiStatusService 의 chatbotState: 확인 실패는 null, AiServerHealthClient 호출 5초 제한).
});

test('ADM-N46 AI 상태 3종 정상 응답', TAGS, async ({ tempUser, signIn }) => {
  const a = await signIn(await tempUser('ADMIN'));
  const read = async () => bodyOf(await a.api.raw('GET', '/api/admin/dashboard/ai-status'));
  // 재접속 직후 첫 세션 목록 전에는 이상감지가 null(확인 중)일 수 있어, OK 가 될 때까지 기다린다
  const res = await settle(read, r => r.status === 200 && r.json.data?.anomalyDetection?.status === 'OK', 20_000, 1_500);
  expect(res.status, `ai-status 응답 상태 ${res.status}`).toBe(200);
  const data = res.json.data;
  test.info().annotations.push({
    type: '문서와 코드 차이',
    description: '문서는 {anomalyDetection:OK,...} 로 적었지만 실제 응답은 칸마다 {status, checkedAt} 객체다. status 값으로 고정한다. 챗봇은 BE 가 AI 의 GET /api/v1/live-streams 로 확인한다(AiServerHealthClient).',
  });
  expect(data.anomalyDetection?.status, '이상감지').toBe('OK');
  expect(data.chatbot?.status, '챗봇').toBe('OK');
  expect(data.companion?.status, '말벗').toBe('OK');
  for (const key of ['anomalyDetection', 'chatbot', 'companion']) {
    expect(String(data[key]?.checkedAt ?? ''), `${key}.checkedAt 은 KST(+09:00)`).toMatch(KST_OFFSET);
  }
  expect(String(data.generatedAt ?? ''), 'generatedAt 은 KST(+09:00)').toMatch(KST_OFFSET);
});

test.fixme('ADM-N47 챗봇·말벗을 끄면 \'정상\'이 아니라 DISABLED', TAGS, async () => {
  // 자동화 불가: chat.relay.enabled=false, companion.enabled=false 로 서버를 재기동해야 한다(서버 설정·컨테이너 변경 금지).
  // 수동 확인: chatbot.status=DISABLED, companion.status=DISABLED(AI 를 부르지 않음), anomalyDetection 은 별개로 OK
  //   (BE AdminAiStatusService.chatbotState / startCompanionCheck 가 스위치가 꺼져 있으면 AI 호출 없이 DISABLED).
});

test('ADM-N48 AI 상태 카드 화면 표시', TAGS, async ({ tempUser, signIn, openAs }) => {
  test.setTimeout(180_000);
  const a = await signIn(await tempUser('ADMIN'));
  const page = await openAs(a.who, null);

  // 칸마다 응답을 바꿔 가며 화면이 어떻게 그리는지 본다 (정상 · 끔 · 확인 불가 · 끊김)
  let scenario = { anomaly: 'OK' as string | null, chat: 'OK' as string | null, companion: 'OK' as string | null };
  await patchDashboard(page, {
    aiStatus: data => ({
      ...data,
      anomalyDetection: aiItem(scenario.anomaly),
      chatbot: aiItem(scenario.chat),
      companion: aiItem(scenario.companion),
    }),
  });

  const bar = page.getByRole('region', { name: 'AI 서비스 상태' });
  const card = (name: string) => bar.getByText(name, { exact: true }).locator('xpath=..');
  const read = async (name: string) => {
    const el = card(name);
    await expect(el).toBeVisible();
    const result = el.locator(':scope > span').last();
    return {
      label: ((await result.innerText()) ?? '').trim(),
      cls: (await el.getAttribute('class')) ?? '',
      style: await result.evaluate(node => {
        const css = getComputedStyle(node);
        const dot = node.querySelector('i');
        return `${css.color}|${dot ? getComputedStyle(dot).backgroundColor : ''}`;
      }),
    };
  };
  const toneOf = (cls: string) => (/safe/.test(cls) ? 'safe' : /warn/.test(cls) ? 'warn' : /mute/.test(cls) ? 'mute' : cls);
  const load = async () => {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { level: 1, name: '대시보드', exact: true })).toBeVisible();
    await expect(bar).toBeVisible();
  };

  // 1) 모두 정상
  await load();
  await expect.poll(async () => (await read('AI 이상감지')).label, { message: '이상감지 정상', timeout: 20_000 }).toBe('정상');
  expect((await read('AI 의료 챗봇')).label).toBe('정상');
  expect((await read('안부 말벗 · 기분 분석')).label).toBe('정상');

  // 2) 이상감지 정상 · 챗봇 꺼 둠(DISABLED) · 말벗 확인 불가(null) - 세 칸이 서로 다른 문구·색이어야 한다
  scenario = { anomaly: 'OK', chat: 'DISABLED', companion: null };
  await load();
  await expect.poll(async () => (await read('AI 의료 챗봇')).label, { timeout: 20_000 }).not.toBe('정상');
  const anomaly = await read('AI 이상감지');
  const chat = await read('AI 의료 챗봇');
  const companion = await read('안부 말벗 · 기분 분석');
  test.info().annotations.push({
    type: '문서와 코드 차이',
    description: `문서는 DISABLED 를 '꺼 둠'으로 적었지만 화면 문구는 '${chat.label}'. 이상감지의 null 은 '확인 중'(재접속 직후), 챗봇·말벗의 null 은 '확인 불가'로 그린다.`,
  });
  expect(anomaly.label).toBe('정상');
  expect(chat.label, "DISABLED 는 '정상'이 아니라 중단 표시").toBe('일시 중단');
  expect(companion.label, 'null 은 확인 불가').toBe('확인 불가');
  expect(new Set([anomaly.label, chat.label, companion.label]).size, '세 칸의 문구가 서로 달라야 한다').toBe(3);
  expect(new Set([toneOf(anomaly.cls), toneOf(chat.cls), toneOf(companion.cls)]).size, '세 칸의 색 구분(정상·주의·확인 불가)이 서로 달라야 한다').toBe(3);
  expect(new Set([anomaly.style, chat.style, companion.style]).size, '세 칸의 실제 글자·점 색이 서로 달라야 한다').toBe(3);

  // 3) 끊김(DISCONNECTED)은 확인 불가와 따로 구분
  scenario = { anomaly: 'DISCONNECTED', chat: null, companion: null };
  await load();
  await expect.poll(async () => (await read('AI 이상감지')).label, { timeout: 20_000 }).toBe('연결 끊김');
  const cut = await read('AI 이상감지');
  const unknownChat = await read('AI 의료 챗봇');
  expect(unknownChat.label).toBe('확인 불가');
  expect(cut.label, '끊김과 확인 불가는 문구가 달라야 한다').not.toBe(unknownChat.label);
  expect(toneOf(cut.cls), '끊김은 확인 불가와 다른 색').not.toBe(toneOf(unknownChat.cls));

  // 4) 이상감지 null 은 '끊김'이 아니라 확인 중
  scenario = { anomaly: null, chat: 'OK', companion: 'OK' };
  await load();
  await expect.poll(async () => (await read('AI 이상감지')).label, { timeout: 20_000 }).toBe('확인 중');
});

// ─────────────────────────────────────────────────────────────────────────────
// AI 통계
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A36 기간 검증 실패는 AI와 속도 제한을 건드리지 않음', TAGS, async ({ tempUser, signIn, later }) => {
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const [minuteKey, hourKey] = aiStatsKeys(admin.id);
  deleteOwnKeys([minuteKey, hourKey]);
  later(() => deleteOwnKeys([minuteKey, hourKey]));
  const today = kstDate();

  // 각 경우는 "한 가지 이유"만 걸리게 짧은 기간(하루)으로 잡는다(31일 초과 규칙이 대신 막아 주지 못하게)
  const bad: Array<[string, string]> = [
    ['from=2026-1-1&to=2026-1-1', '날짜 형식 틀림(0 채움 없음)'],
    ['from=1999-12-31&to=1999-12-31', '1999년(2000년 이전)'],
    ['from=2999-12-31&to=3000-01-01', '3000년(2999년 이후)'],
    ['from=2026-11-13&to=2026-11-01', '시작이 끝보다 늦음'],
    ['from=2026-10-01&to=2026-11-01', '32일 범위'],
    ['from=2026-11-01', 'to 누락'],
  ];
  for (const [query, label] of bad) {
    const res = await bodyOf(await a.api.raw('GET', `/api/admin/ai-stats/chat?${query}`));
    expectError(res, 400, 'AI_STATS_INVALID_RANGE', label);
  }

  // AI 호출 0회: 이 관리자 id 로 "챗 집계 조회"·"챗 집계 실패" 로그가 하나도 없다
  expect(adminLogCount(admin.id, '챗 집계 조회'), '검증 실패인데 AI 집계 조회 로그가 있다').toBe(0);
  expect(adminLogCount(admin.id, '챗 집계 실패'), '검증 실패인데 AI 호출 실패 로그가 있다').toBe(0);
  // 속도 제한 횟수 소모 없음: 키가 아예 없어야 한다
  expect(redisCounter(minuteKey), '분 단위 속도 제한 횟수가 소모됐다').toBe(0);
  expect(redisCounter(hourKey), '시간 단위 속도 제한 횟수가 소모됐다').toBe(0);

  // 대조: 올바른 요청 1번은 횟수를 정확히 1 소모한다(위 0 이 "측정이 안 되어서"가 아님을 확인)
  const ok = await bodyOf(await a.api.raw('GET', `/api/admin/ai-stats/chat?from=${today}&to=${today}`));
  expect(ok.status, `대조 요청 응답 상태 ${ok.status}`).toBe(200);
  expect(redisCounter(minuteKey), '올바른 요청 1번 뒤 분 단위 횟수').toBe(1);
  expect(redisCounter(hourKey), '올바른 요청 1번 뒤 시간 단위 횟수').toBe(1);
  await expect.poll(() => adminLogCount(admin.id, '챗 집계 조회'), { timeout: 30_000, message: '대조 요청의 AI 조회 로그' }).toBe(1);

  // 경계: 31일은 통과(거부된 32일과 한 칸 차이). 올바른 요청이라 횟수 1을 더 쓴다
  const edge = await bodyOf(await a.api.raw('GET', '/api/admin/ai-stats/chat?from=2026-10-02&to=2026-11-01'));
  expect(edge.status, `31일 범위 응답 상태 ${edge.status}`).toBe(200);
  expect(redisCounter(minuteKey), '31일 요청까지 분 단위 횟수').toBe(2);
  await expect.poll(() => adminLogCount(admin.id, '챗 집계 조회'), { timeout: 30_000, message: '31일 요청의 AI 조회 로그' }).toBe(2);
});

test('ADM-A37 속도 제한 429', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const adminA = await tempUser('ADMIN');
  const adminB = await tempUser('ADMIN');
  const adminC = await tempUser('ADMIN');
  const a = await signIn(adminA);
  const b = await signIn(adminB);
  const c = await signIn(adminC);
  const keys = [adminA, adminB, adminC].flatMap(admin => aiStatsKeys(admin.id));
  deleteOwnKeys(keys);
  later(() => deleteOwnKeys(keys));
  // 다른 시험이 만든 캐시와 겹치지 않게 이 시험 전용 기간을 쓴다(과거 7일)
  const range = 'from=2026-09-01&to=2026-09-07';
  const path = `/api/admin/ai-stats/chat?${range}`;

  // 분당 30회: 같은 기간을 30번 부르면 모두 200, 31번째는 429 (한도 안의 재호출은 캐시라 AI 를 거의 안 부른다)
  for (let i = 1; i <= 30; i++) {
    const res = await a.api.raw('GET', path);
    expect(res.status(), `${i}번째 호출 응답 상태`).toBe(200);
  }
  const over = await bodyOf(await a.api.raw('GET', path));
  expectError(over, 429, 'TOO_MANY_REQUESTS', '31번째 호출');
  expect(redisCounter(aiStatsKeys(adminA.id)[0]), '분 단위 횟수가 한도를 넘어 쌓였다').toBeGreaterThan(30);

  // 같은 기간이라 AI 는 많아야 1번만 불렀다(나머지 29번은 캐시)
  await expect
    .poll(() => adminLogCount(adminA.id, '챗 집계 조회'), { timeout: 30_000, message: '성공한 30번의 조회 로그' })
    .toBe(30);
  expect(adminLogCount(adminA.id, 'cached=true'), '캐시로 답한 호출 수(29 이상이어야 AI 호출이 1번 이하)').toBeGreaterThanOrEqual(29);

  // 제한은 관리자 기준: 다른 관리자는 같은 기간을 바로 부를 수 있다
  const other = await b.api.raw('GET', path);
  expect(other.status(), '다른 관리자의 호출 응답 상태').toBe(200);

  // 시간당 600회: 이 관리자 전용 시간 키를 600 으로 만들어 두면 다음 호출이 601번째가 된다(600번을 실제로 부르지 않는다)
  redis('SET', aiStatsKeys(adminC.id)[1], '600', 'EX', '3600');
  const hourly = await bodyOf(await c.api.raw('GET', path));
  expectError(hourly, 429, 'TOO_MANY_REQUESTS', '시간당 601번째 호출');
});

test('ADM-A38 AI 통계 장애(503·504) 화면 표시', TAGS, async ({ tempUser, signIn, openAs }) => {
  test.setTimeout(180_000);
  test.info().annotations.push({
    type: '수동 확인',
    description: '서버 쪽(AI 통계 서버를 내리면 503 AI_STATS_UNAVAILABLE, 8초 넘게 지연되면 504 AI_STATS_TIMEOUT, 실패는 캐시되지 않아 복구 후 바로 200)은 서버·AI 설정을 바꿔야 해서 자동화하지 않는다. 여기서는 브라우저에서 503·504 응답을 대신 돌려줘 화면 표시만 본다(서버로 요청이 가지 않는다).',
  });
  const a = await signIn(await tempUser('ADMIN'));
  const page = await openAs(a.who, null);

  // 화면은 응답 상태 숫자가 아니라 에러 code(AI_STATS_UNAVAILABLE / AI_STATS_TIMEOUT)로 문구를 고른다(FE ChatStats errorCode).
  // 공용 감시(fixtures)가 /api 의 5xx 를 전부 버그로 세므로, 대신 돌려주는 응답은 상태를 424 로 두고 code 만 실제와 같게 쓴다.
  let mode: { code: string; message: string } = { code: 'AI_STATS_UNAVAILABLE', message: 'AI 통계를 불러올 수 없습니다.' };
  await page.route(/\/api\/admin\/ai-stats\/chat(\?|$)/, route =>
    fulfillJsonError(route, 424, { success: false, code: mode.code, message: mode.message, data: null }),
  );

  await page.goto('/admin/ai-stats');
  await page.getByRole('tab', { name: 'AI 의료 챗봇' }).click();

  // 503: 0 으로 채우지 않고 화면 전체가 "불러올 수 없음"
  await expect(page.getByText('AI 통계를 지금 불러올 수 없습니다.'), '503 안내').toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('region', { name: 'AI 의료 챗봇 집계' }), '503 인데 집계 카드가 0 으로 그려졌다').toHaveCount(0);
  await expect(page.getByText('기간 내 대화'), '503 인데 집계 칸이 보인다').toHaveCount(0);
  await expect(page.getByText(/상담 서버/), "상담용 문구('상담 서버')가 나오면 안 된다").toHaveCount(0);

  // 504: 다시 시도하면 시간 초과 안내로 바뀐다
  mode = { code: 'AI_STATS_TIMEOUT', message: 'AI 응답이 늦습니다.' };
  await page.getByRole('button', { name: '다시 시도' }).first().click();
  await expect(page.getByText('AI 응답이 늦습니다. 잠시 후 다시 시도해 주세요.'), '504 안내').toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('기간 내 대화'), '504 인데 집계 칸이 보인다').toHaveCount(0);
  await expect(page.getByText(/상담 서버/), "상담용 문구('상담 서버')가 나오면 안 된다").toHaveCount(0);
});

test('ADM-N50 AI 의료 챗봇 통계 조회', TAGS, async ({ tempUser, signIn, later }) => {
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteOwnKeys(aiStatsKeys(admin.id)));
  const from = '2026-11-01';
  const to = '2026-11-13';
  const res = await bodyOf(await a.api.raw('GET', `/api/admin/ai-stats/chat?from=${from}&to=${to}`));
  expect(res.status, `챗봇 통계 응답 상태 ${res.status}`).toBe(200);
  const d = res.json.data;

  expect(d.from).toBe(from);
  expect(d.to).toBe(to);
  // AI 가 정상인 상태이므로 문서의 필수 개수 칸은 모두 0 이상 정수다(null 이면 AI 가 칸을 빠뜨린 회귀)
  const isCount = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;
  for (const key of ['totalChats', 'users', 'emergencyGuidance', 'reservationCompleted', 'fallbackReplies']) {
    expect(isCount(d[key]), `${key} 는 0 이상의 정수여야 한다`).toBe(true);
  }
  expect(Object.keys(d.byRole ?? {}).sort(), 'byRole 칸').toEqual(['guardian', 'unknown', 'ward']);
  expect(Object.keys(d.byRoute ?? {}).sort(), 'byRoute 칸').toEqual(['general', 'reservation', 'symptom', 'unknown']);
  for (const v of [...Object.values(d.byRole), ...Object.values(d.byRoute)]) expect(isCount(v), 'byRole·byRoute 값').toBe(true);
  // 13일 = 11/01 ~ 11/13 이 하루도 빠짐없이 순서대로
  const days = d.daily as { date: string; totalChats: number | null }[];
  expect(days.map(day => day.date), 'daily 날짜').toEqual(Array.from({ length: 13 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`));
  for (const day of days) expect(isCount(day.totalChats), 'daily.totalChats').toBe(true);
  expect(String(d.generatedAt), 'generatedAt 은 KST(+09:00)').toMatch(KST_OFFSET);

  // 상담 내용·사용자 ID 없음: 칸 이름과 값 모두 본다
  const keys = [...allKeys(d)];
  const allowed = new Set([
    'from', 'to', 'totalChats', 'users', 'byRole', 'guardian', 'ward', 'unknown', 'byRoute', 'reservation', 'symptom', 'general',
    'emergencyGuidance', 'reservationCompleted', 'fallbackReplies', 'daily', 'date', 'generatedAt',
    // 라우터 상태 칸(2026-11-09 추가, 문서 목록에는 없지만 BE 가 선택 칸으로 낸다)
    'routerFailures', 'routerFailuresByKind', 'credit', 'auth', 'timeout', 'other', 'routerStatus', 'state', 'recentFailures', 'windowSec',
  ]);
  expect(keys.filter(key => !allowed.has(key)), '문서에 없는 칸(상담 내용·사용자 ID 등)이 섞였다').toEqual([]);
  expect(keys.filter(key => /user.?id|content|message|question|answer|text|reply|name|phone/i.test(key) && key !== 'users'), '상담 내용·사용자 식별 칸').toEqual([]);
  expect(res.text, '응답에 임시 관리자 id 가 섞였다').not.toContain(admin.id);
});

test.fixme('ADM-A10 AI가 응답 없어도 안전 현황이 지연되지 않음', TAGS, async () => {
  // 자동화 불가: AI 서버를 응답 없음으로 만들어야 한다(서버 설정·컨테이너 변경 금지).
  // 수동 확인: /safety 는 AI 를 기다리지 않고 바로 200(null 포함), 느린 쪽은 /ai-status 뿐이며 최대 약 5초
  //   (BE AdminDashboardService.getSafetyDashboard 는 AI 구독 메모리 상태만 읽고, AdminAiStatusService 가 AI 호출을 맡는다).
});
