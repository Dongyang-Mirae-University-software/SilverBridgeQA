/**
 * 최종 QA - 관리자(ADM) P2: AI 통계 · 디바이스 · 데모 시드 · AI 상태 카드
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. Redis 는 이 임시 관리자 id 가 붙은 속도 제한 키만 지운다.
 *  - AI 서버는 챗봇 통계 조회를 최소(기간당 1~2번)로만 부른다. AI 서버를 끊거나 설정을 바꾸는 케이스는 test.fixme.
 *  - 카메라 행은 CAM_SIGNAL_ALLOWED=1 일 때만 만든다.
 *  - 화면 케이스는 진짜 응답의 data 만 바꿔서 "모르는 값(null)을 화면이 어떻게 그리는가"를 본다.
 */
import { psql, sqlStr } from '../../../src/remote';
import {
  adminLogCount, aiStatsKeys, allKeys, CAM_SIGNAL_ALLOWED, CAM_SKIP_REASON, deleteAuditOf, deleteOwnKeys, enc, expect, expectCode,
  getBody, insertCamera, kstDate, psqlOne, TAGS, test, uniq, waitOutKstMidnight,
} from './_helpers-adm-p2';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

test.fixme('ADM-N49 데모 시드 실행 후 관리자 화면에 데이터가 채워짐', TAGS, async () => {
  // 자동화 불가: BE·AI 설명서 어디에도 관리자 데모 시드의 실행 방법(주소·권한·환경 제한·결과)이 없다(Grep 결과 없음).
  //   설명서 4006행 근처의 prisma seed 는 병원 예약 서비스 얘기라 이 케이스와 별개다.
  // 개발팀에 실행 방법을 확인한 뒤 기대값(시드 데이터가 화면 숫자에 반영, 실제 알림·문자는 나가지 않음)을 정해야 한다.
  // 시드를 dev 에서 돌리면 다른 영역의 공용 숫자도 바뀌므로, 방법이 정해져도 전용 환경에서 수동으로 확인한다.
});

test('ADM-N51 기간 31일 경계, 60초 캐시, 챗 킬 스위치와 무관', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const keys = aiStatsKeys(admin.id);
  deleteOwnKeys(keys);
  later(() => deleteOwnKeys(keys));
  later(() => deleteAuditOf([admin.id]));
  test.info().annotations.push({
    type: '수동 확인',
    description: "'챗 킬 스위치(chat.relay.enabled)=false 에서도 통계는 조회된다'는 서버 설정을 바꿔 재기동해야 해서 자동화하지 않는다(서버 설정·컨테이너 변경 금지). 코드상 AdminAiChatStatsService 는 그 스위치를 읽지 않는다(문서 BE 2441-2449). 여기서는 31일 경계와 60초 캐시만 확인한다.",
  });

  // 다른 시험의 캐시와 겹치지 않게, 이 시험만 쓰는 무작위 31일 구간(2024~2025년)을 쓴다
  const startMs = Date.UTC(2024, 0, 1) + Math.floor(Math.random() * 700) * 86_400_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const from = day(startMs);
  const to = day(startMs + 30 * 86_400_000);
  const over = day(startMs + 31 * 86_400_000);
  const path = `/api/admin/ai-stats/chat?from=${from}&to=${to}`;

  // 정확히 31일(시작·종료 포함)은 성공한다. 하루 더한 32일은 거절된다
  expectCode(await getBody(a.api, `/api/admin/ai-stats/chat?from=${from}&to=${over}`), 400, 'AI_STATS_INVALID_RANGE', '32일 구간');
  const first = await getBody(a.api, path);
  expect(first.status, `31일 구간 첫 호출 응답 상태 ${first.status}`).toBe(200);
  expect(first.json.data.from).toBe(from);
  expect(first.json.data.to).toBe(to);
  const dates = (first.json.data.daily as { date: string }[]).map(d => d.date);
  expect(dates.length, 'daily 는 31일').toBe(31);
  expect(dates[0]).toBe(from);
  expect(dates[30]).toBe(to);
  await expect.poll(() => adminLogCount(admin.id, 'cached=false'), { timeout: 30_000, message: '첫 호출은 AI 를 부른다(cached=false)' }).toBe(1);

  // 같은 기간을 바로 다시: 캐시로 답한다(AI 를 다시 부르지 않는다)
  const second = await getBody(a.api, path);
  expect(second.status, `31일 구간 두 번째 호출 응답 상태 ${second.status}`).toBe(200);
  expect(second.text, '캐시이므로 두 번째 응답은 첫 응답과 똑같다(기준 시각 포함)').toBe(first.text);
  await expect.poll(() => adminLogCount(admin.id, 'cached=true'), { timeout: 30_000, message: '두 번째 호출은 캐시(cached=true)' }).toBe(1);
  expect(adminLogCount(admin.id, 'cached=false'), 'AI 를 다시 부르면 안 된다(cached=false 는 1번 그대로)').toBe(1);
});

test.fixme('ADM-N52 역할별 집계·null 유지·탈퇴 회원 제외', TAGS, async () => {
  // 자동화 불가: 집계는 AI 서버가 가진 상담 기록으로 센다. 역할이 섞인 상담, 옛 기록(2026-10-08~12, 역할 unknown),
  //   AI 가 일부러 null 을 주는 항목, 탈퇴 회원의 상담을 만들려면 AI 서버 쪽 데이터를 직접 만들거나 지워야 한다
  //   (실제 Claude 상담 호출이 필요하고, AI 서버 DB 는 이 QA 의 범위 밖이다).
  // 수동 확인: 보호자·피보호자 상담이 섞인 기간의 byRole 합 = totalChats, 옛 기록은 byRole.unknown, AI 가 null 로 준 칸은
  //   응답에서도 null(0 아님), 탈퇴 회원 상담은 빠짐(BE 2447-2451, AdminAiChatStatsService 의 허용 목록 변환).
  // API 모양과 화면의 null 표시는 ADM-N50(P1a)·ADM-N54(이 파일)가 따로 본다.
});

test('ADM-N53 안부 말벗 통계(오늘 집계)', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  await waitOutKstMidnight();
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null, name: `QA말벗${uniq()}` });
  const a = await signIn(admin);
  const g = await signIn(guardian);
  const w = await signIn(ward);
  later(() => {
    psql(`DELETE FROM companion_prompt_log WHERE ward_id = ${sqlStr(ward.id)};`);
  });
  later(() => deleteAuditOf([admin.id]));

  type Stats = {
    date: string; askedCount: number; responseRate: number | null; noDialogueWardCount: number; alertSentCount: number;
    moodDistribution: Record<string, number>; continuingWards: unknown[]; generatedAt: string;
    noDialogueWards: { wardId: string; name: string | null; lastDialogueAt: string | null }[];
  };
  const read = async () => {
    const res = await getBody(a.api, '/api/admin/ai-stats/companion');
    expect(res.status, `말벗 통계 응답 상태 ${res.status}`).toBe(200);
    return res.json.data as Stats;
  };

  const before = await read();
  expect(before.date, '집계 날짜는 한국 시간 오늘').toBe(kstDate());
  // 오늘 안부 질문 안내를 2번 받았지만 대답은 없는 피보호자(AI 서버를 거치지 않고 우리 DB 기록만 만든다)
  psql(
    `INSERT INTO companion_prompt_log (ward_id, prompt_date, slot, sent_at)
     VALUES (${sqlStr(ward.id)}, (now() AT TIME ZONE 'Asia/Seoul')::date, '09:00', now()),
            (${sqlStr(ward.id)}, (now() AT TIME ZONE 'Asia/Seoul')::date, '12:00', now());`,
  );
  const after = await read();
  // 공용 집계라 다른 곳이 동시에 늘리면 더 클 수 있어 '이상'으로 본다(내 기록 2건이 빠지면 안 된다)
  expect(after.askedCount, '오늘 보낸 안부 질문 수에 내 2건이 더해진다').toBeGreaterThanOrEqual(before.askedCount + 2);
  expect(after.noDialogueWardCount, '대답 없는 어르신 수에 내 피보호자 1명이 더해진다').toBeGreaterThanOrEqual(before.noDialogueWardCount + 1);
  const mine = after.noDialogueWards.filter(item => item.wardId === ward.id);
  expect(mine, '오늘 대화가 없는 어르신 목록에 내 피보호자가 한 번 들어 있다').toHaveLength(1);
  expect(mine[0].name, '이름').toBe(ward.name);
  expect(mine[0].lastDialogueAt, '한 번도 대답한 적 없으면 null').toBeNull();
  expect(after.responseRate === null || Number.isInteger(after.responseRate), '응답률은 정수(%) 또는 보낸 질문이 없을 때 null').toBe(true);
  expect(after.generatedAt, '집계 시각은 KST(+09:00)').toMatch(/\+09:00$/);

  // 상담 원문·요약이 없다: 응답에 나오는 칸 이름은 문서의 집계 칸뿐
  const allowed = new Set([
    'date', 'askedCount', 'responseRate', 'noDialogueWardCount', 'alertSentCount', 'moodDistribution', 'wardCount', 'joy', 'calm', 'worry',
    'depressed', 'unknown', 'continuingWards', 'wardId', 'name', 'mood', 'days', 'noDialogueWards', 'lastDialogueAt', 'generatedAt',
  ]);
  expect([...allKeys(after)].filter(key => !allowed.has(key)), '문서에 없는 칸(대답 원문·요약 등)이 섞였다').toEqual([]);

  // 관리자 외에는 403
  expect((await g.api.raw('GET', '/api/admin/ai-stats/companion')).status(), '보호자 호출').toBe(403);
  expect((await w.api.raw('GET', '/api/admin/ai-stats/companion')).status(), '피보호자 호출').toBe(403);
});

test('ADM-N54 AI 통계 화면', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(300_000);
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteOwnKeys(aiStatsKeys(admin.id)));
  later(() => deleteAuditOf([admin.id]));
  test.info().annotations.push({
    type: '문서와 다름(팀 확인 필요)',
    description: "문서는 'null 값은 모름으로 표시'라고 적었지만 화면 코드(AdminAiStatsContent formatCount)는 null 을 '-' 로 그린다(라우터 실패 칸만 '정보 없음'). 0 으로 보이지 않는 것이 핵심이라 '-' 로 고정한다. 화면 안내문에는 역할 '모름' 이라고 적혀 있어 사용자가 헷갈릴 수 있으니 문서와 화면 중 어느 쪽을 맞출지 팀이 정해야 한다. 31일 초과는 화면이 요청을 보내지 않고 안내 문구를 띄운다.",
  });

  const page = await openAs(a.who, null);
  let mode: 'real' | 'nulls' = 'real';
  let chatRequests = 0;
  page.on('request', request => {
    if (/\/api\/admin\/ai-stats\/chat\?/.test(request.url())) chatRequests++;
  });
  // 진짜 응답을 받아 data 만 바꿔 돌려준다(nulls 모드): 모르는 값(null)이 화면에서 0 이 되지 않는지 본다
  await page.route(/\/api\/admin\/ai-stats\/chat(\?|$)/, async route => {
    if (route.request().method() !== 'GET' || mode === 'real') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { data: Record<string, any> };
    const d = body.data;
    d.totalChats = null;
    d.emergencyGuidance = null;
    d.byRole = { ...d.byRole, unknown: null };
    d.byRoute = { ...d.byRoute, reservation: null };
    d.daily = (d.daily as { date: string }[]).map(item => ({ ...item, totalChats: null }));
    return route.fulfill({ response, json: body });
  });

  await page.goto('/admin/ai-stats');
  await expect(page.getByRole('heading', { level: 1, name: 'AI 통계', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'AI 의료 챗봇' }).click();
  const cards = page.getByRole('region', { name: 'AI 의료 챗봇 집계' });
  await expect(cards, '기본 기간(최근 7일) 집계 카드').toBeVisible({ timeout: 90_000 });

  // 라벨(span) 바로 뒤의 strong 이 그 칸의 값이다
  const cardValue = (label: string) => cards.getByText(label, { exact: true }).locator('xpath=following-sibling::strong[1]');
  const section = (title: string) => page.locator('section').filter({ has: page.getByText(title, { exact: true }) }).last();
  const rowValue = (title: string, label: string) =>
    section(title).locator('span', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::strong[1]');
  const fmt = (n: number) => `${n.toLocaleString('ko-KR')}건`;

  await test.step('카드·역할·경로·일별 그래프가 응답 숫자와 같다 (최근 7일)', async () => {
    const from = kstDate(-6);
    const to = kstDate();
    const api = await getBody(a.api, `/api/admin/ai-stats/chat?from=${from}&to=${to}`);
    expect(api.status, `같은 기간 API 응답 상태 ${api.status}`).toBe(200);
    const d = api.json.data;
    await expect(cardValue('기간 내 대화')).toHaveText(fmt(d.totalChats));
    await expect(cardValue('쓴 사람')).toHaveText(fmt(d.users));
    await expect(cardValue('예약 완료')).toHaveText(fmt(d.reservationCompleted));
    await expect(cardValue('119 안내')).toHaveText(fmt(d.emergencyGuidance));
    await expect(cardValue('기본 안내로 대신 답한 상담')).toHaveText(fmt(d.fallbackReplies));
    await expect(rowValue('상담 사용자 역할', '보호자')).toHaveText(fmt(d.byRole.guardian));
    await expect(rowValue('상담 사용자 역할', '피보호자')).toHaveText(fmt(d.byRole.ward));
    await expect(rowValue('상담 사용자 역할', '역할 모름')).toHaveText(fmt(d.byRole.unknown));
    await expect(rowValue('상담 경로', '병원 예약')).toHaveText(fmt(d.byRoute.reservation));
    await expect(rowValue('상담 경로', '증상 상담')).toHaveText(fmt(d.byRoute.symptom));
    await expect(rowValue('상담 경로', '일반 상담')).toHaveText(fmt(d.byRoute.general));
    await expect(rowValue('상담 경로', '분류 미확인')).toHaveText(fmt(d.byRoute.unknown));
    const chart = page.getByRole('img', { name: '일별 AI 의료 챗봇 상담 수' });
    await expect(chart.locator('circle'), '일별 점은 응답의 날짜 수와 같다').toHaveCount((d.daily as unknown[]).length);
    expect((d.daily as unknown[]).length, '7일').toBe(7);
  });

  await test.step('모르는 값(null)은 0 이 아니라 - 로 보인다', async () => {
    mode = 'nulls';
    await page.getByRole('button', { name: '오늘', exact: true }).click();
    await expect(cardValue('기간 내 대화'), "null 인 '기간 내 대화' 는 0건이 아니라 -").toHaveText('-');
    await expect(cardValue('119 안내'), "null 인 '119 안내' 는 -").toHaveText('-');
    await expect(rowValue('상담 사용자 역할', '역할 모름'), "null 인 '역할 모름' 은 -").toHaveText('-');
    await expect(rowValue('상담 경로', '병원 예약'), "null 인 '병원 예약' 은 -").toHaveText('-');
    await expect(page.getByText('AI가 일별 상담 수를 집계하지 못했습니다.'), '일별 값이 전부 null 이면 그래프 대신 안내').toBeVisible();
  });

  await test.step('31일은 조회되고, 31일을 넘으면 요청을 보내지 않고 안내한다', async () => {
    mode = 'real';
    const to = kstDate();
    const toMs = Date.parse(`${to}T00:00:00Z`);
    const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const sent = chatRequests;
    await page.getByLabel('시작일').fill(dayStr(toMs - 30 * 86_400_000)); // 시작·종료 포함 31일
    await expect.poll(() => chatRequests, { timeout: 30_000, message: '31일 구간은 요청을 보낸다' }).toBeGreaterThan(sent);
    await expect(cards, '31일 구간 집계 카드').toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('시작일과 종료일을 확인해 주세요.'), '31일은 안내가 없다').toHaveCount(0);

    const beforeInvalid = chatRequests; // 32일로 바꾸기 전에 센 요청 수
    await page.getByLabel('시작일').fill(dayStr(toMs - 31 * 86_400_000)); // 32일
    await expect(page.getByText('시작일과 종료일을 확인해 주세요. 최대 31일까지 조회할 수 있습니다.'), '32일 안내').toBeVisible();
    await expect(page.getByText('올바른 조회 기간을 선택해 주세요.'), '집계 대신 기간 안내').toBeVisible();
    await expect(cards, '32일 구간에는 집계 카드가 없다').toHaveCount(0);
    // 안내가 뜬 뒤에도 늦게 나가는 요청이 없는지 잠시 더 기다린 다음, fill 전 값과 비교한다
    await page.waitForTimeout(3_000);
    await expect(page.getByText('올바른 조회 기간을 선택해 주세요.')).toBeVisible();
    expect(chatRequests, '32일 구간은 서버로 요청을 보내지 않는다(fill 전과 같은 요청 수)').toBe(beforeInvalid);
  });
});

test('ADM-A32 디바이스 쓰기 요청·잘못된 값', TAGS, async ({ tempUser, signIn, later }) => {
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  let cameraId = 999_999_999;
  let ownCamera = false;
  if (CAM_SIGNAL_ALLOWED) {
    const ward = await tempUser('WARD', { phone: null });
    const session = `qa-p2a32-${uniq()}`;
    later(() => {
      psql(`DELETE FROM camera WHERE ward_id = ${sqlStr(ward.id)};`);
    });
    insertCamera(ward.id, session, '거실', true);
    cameraId = Number(psqlOne(`SELECT id FROM camera WHERE ward_id = ${sqlStr(ward.id)} AND session_id = ${sqlStr(session)};`));
    ownCamera = true;
  } else {
    test.info().annotations.push({ type: '확인 안 함', description: `'카메라가 그대로 남음' 단계: ${CAM_SKIP_REASON}. 이 실행에서는 쓰기 주소가 없다는 것과 잘못된 값 처리만 확인했다.` });
  }

  // 쓰기 주소가 없다: 삭제·수정 모두 같은 거절(문서는 404/405 둘 중 하나로 적었으나 배포 코드 값 하나로 고정)
  const del = await a.api.raw('DELETE', `/api/admin/camera/${cameraId}`);
  const patch = await a.api.raw('PATCH', `/api/admin/camera/${cameraId}`, { label: '바꿈' });
  const put = await a.api.raw('PUT', `/api/admin/camera/${cameraId}`, { label: '바꿈' });
  const post = await a.api.raw('POST', '/api/admin/camera', { label: '새 카메라' });
  expect(del.status(), `DELETE 응답 상태 ${del.status()}`).toBe(404);
  expect(patch.status(), `PATCH 응답 상태 ${patch.status()}`).toBe(404);
  expect(put.status(), `PUT 응답 상태 ${put.status()}`).toBe(404);
  expect(post.status(), `POST 응답 상태 ${post.status()}`).toBe(405);
  if (ownCamera) {
    expect(psqlOne(`SELECT count(*) FROM camera WHERE id = ${cameraId};`), '쓰기 요청 뒤에도 카메라는 그대로 남아 있다').toBe('1');
    expect(psqlOne(`SELECT label FROM camera WHERE id = ${cameraId};`), '이름도 그대로').toBe('거실');
  }

  // 잘못된 값: status 는 400, size·page 는 보정(500 없음)
  expectCode(await getBody(a.api, '/api/admin/camera?status=XYZ'), 400, 'INVALID_INPUT', 'status=XYZ');
  expectCode(await getBody(a.api, '/api/admin/camera?status=live'), 400, 'INVALID_INPUT', 'status=live(소문자)');
  const sizes = async (query: string) => {
    const res = await getBody(a.api, `/api/admin/camera?${query}`);
    expect(res.status, `${query} 응답 상태 ${res.status}`).toBe(200);
    return res.json.data as { size: number; page: number; content: unknown[] };
  };
  expect((await sizes('size=0')).size, 'size=0 은 20').toBe(20);
  expect((await sizes('size=1000')).size, 'size=1000 은 50').toBe(50);
  expect((await sizes('page=-1')).page, 'page=-1 은 0 쪽').toBe(0);
  expect((await sizes(`q=${enc(`QA없는카메라${uniq()}`)}&size=-3`)).size, 'size=-3 은 20').toBe(20);
});

test.fixme('ADM-A34 말벗 주소·키 없음 또는 키 불일치', TAGS, async () => {
  // 자동화 불가: companion 주소·키 설정을 비우거나 잘못된 키로 바꾸려면 BE 서버 설정(환경변수)을 바꿔 재기동해야 한다
  //   (서버 설정·컨테이너 변경 금지). 목 AI 서버로 401 AUTH_INVALID_KEY 를 돌려주려면 BE 가 그 주소를 보게 해야 하므로 마찬가지다.
  // 수동 확인(값은 적지 말고 설정 이름만 확인): 말벗 주소 또는 키가 비어 있거나 AI 가 401 AUTH_INVALID_KEY 를 주면
  //   /api/admin/dashboard/ai-status 의 companion.status=null(확인 불가)이고 OK 로 표시되지 않는다
  //   (BE AdminAiStatusService.startCompanionCheck, 문서 BE 1786-1789).
  // 정상 상태의 3종 표시는 ADM-N46·ADM-N48(P1a)이 본다.
});

test.fixme('ADM-A39 AI 응답이 약속과 다르면 503', TAGS, async () => {
  // 자동화 불가: 칸 누락·타입 다른 값·다른 기간·날짜 불일치·64KB 초과·리다이렉트 응답을 주는 목 AI 서버를 만들고
  //   BE 가 그 주소로 AI 통계를 부르게 하려면 BE 서버 설정을 바꿔 재기동해야 한다(서버 설정·컨테이너 변경 금지).
  // 수동 확인(전용 환경 + 목 서버): 위 여섯 경우 모두 503 AI_STATS_UNAVAILABLE, 응답에는 허용 목록 칸만 실리고(추가 칸 없음),
  //   리다이렉트를 따라가지 않으며, X-API-Key 는 헤더로만 보낸다(BE 2444-2448, AdminAiChatStatsService).
  // 화면이 503 을 어떻게 그리는지는 ADM-A38(P1a)이 응답을 대신 돌려줘 본다.
});
