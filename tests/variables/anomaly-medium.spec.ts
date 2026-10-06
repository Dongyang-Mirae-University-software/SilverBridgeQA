/**
 * 변수 QA - 이상감지(화재) 중간 심각도 발견 항목
 *
 * 안전 원칙
 * - 임시 사용자(tempUser)와 이 파일이 만든 행만 쓴다. 실제 화재 신호(사진)는 ANOM-G10 만 보낸다(사용자 승인 2026-10-05, src/fire.ts).
 * - AI 서버(/api/streams)는 현재 내려가 있어(AI-6) 화면 테스트는 page.route 로 응답을 흉내 낸다.
 * - 판정 동시성 테스트는 임시 보호자에게 재확인 안내가 나가지 않도록 anomaly_review_conflict_log 를 미리 채운다.
 */
import { spawn } from 'node:child_process';

import { Page } from '@playwright/test';

import { env } from '../../src/env';
import {
  fireImage,
  listenAnomalyEvents,
  sendFireFrames,
  startManualSession,
  stopManualSession,
  suppressAnomalySmsFallback,
  waitSubscribed,
} from '../../src/fire';
import { expect, test, waitForRealtime } from '../../src/fixtures';
import { psql, psqlRows, sqlStr } from '../../src/remote';
import { connect } from '../../src/variables';

/** AI 서버 프록시(/api/streams) 요청을 가로채 흉내 낸다. 실제 AI 세션은 만들어지지 않는다. */
interface AiStub {
  /** 화면이 AI 에 만든 세션 요청 body(sessionId 등) */
  createdSessions: { sessionId?: string; cameraIdentifier?: string }[];
}

async function stubAiStreams(
  page: Page,
  options: { sessions?: { session_id: string; ward_name: string }[]; analysis?: Record<string, unknown> } = {},
): Promise<AiStub> {
  const stub: AiStub = { createdSessions: [] };
  await page.route('**/api/streams/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*\/api\/streams/, '');
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (request.method() === 'POST' && path === '/v1/stream-sessions') {
      const body = (request.postDataJSON() ?? {}) as { sessionId?: string; cameraIdentifier?: string };
      stub.createdSessions.push(body);
      return json({ session_id: body.sessionId ?? 'e2e_stub', status: 'running' });
    }
    if (request.method() === 'POST') return json({ ok: true });
    if (path === '/v1/live-streams') return json(options.sessions ?? []);
    if (/\/latest-analysis$/.test(path)) return json(options.analysis ?? {});
    if (/\/status$/.test(path)) return json({ status: 'running', fps: 5, isAnalyzing: true });
    if (/\/mjpeg$/.test(path)) return route.abort();
    return json({});
  });
  return stub;
}

/** 이상감지 상황 1건을 DB 에 직접 만든다 (AI 화재 신호 없이). */
function insertIncident(wardId: string, sessionId: string): number {
  return Number(
    psql(`INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status)
          VALUES (${sqlStr(wardId)}, ${sqlStr(sessionId)}, 'FIRE', now(), now(), 1, 0.9, 'PENDING') RETURNING id;`)
      .split('\n')[0],
  );
}

/**
 * 이 테스트가 만든 상황 행 1개에만 FOR UPDATE 잠금을 seconds 초 동안 잡는 별도 DB 세션을 띄운다 (ANOM-G03 용).
 * 다른 행·테이블은 잠그지 않는다. acquired 는 잠금을 잡고 pg_sleep 에 들어간 뒤, done 은 세션이 끝나 잠금이 풀린 뒤 풀린다.
 */
function holdIncidentRowLock(incidentId: number, seconds: number): { tag: string; acquired: Promise<void>; done: Promise<void> } {
  const tag = `e2e_anomrev_${incidentId}_${Date.now().toString(36)}`;
  const sql = `SET application_name = '${tag}';
BEGIN;
SELECT id FROM anomaly_incident WHERE id = ${incidentId} FOR UPDATE;
SELECT pg_sleep(${seconds});
COMMIT;`;
  const script = [
    `docker exec -i ${env.dbContainer} sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -q' <<'__E2E_SQL__'`,
    sql,
    '__E2E_SQL__',
    '',
  ].join('\n');
  const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', env.sshHost, 'bash -s'], { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => (stderr += String(chunk)));
  const done = new Promise<void>((resolve, reject) =>
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`잠금 세션 실패 (exit ${code}): ${stderr}`)))),
  );
  child.stdin.end(script);
  const acquired = (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const n = psql(`SELECT count(*) FROM pg_stat_activity WHERE application_name = ${sqlStr(tag)} AND state = 'active' AND query LIKE '%pg_sleep%';`);
      if (n === '1') return;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('상황 행 잠금 세션이 시작되지 않았다');
  })();
  return { tag, acquired, done };
}

/**
 * tag 세션이 잡은 잠금 때문에 기다리고 있는 다른 DB 세션 수.
 * 같은 행을 기다리는 두 번째 세션은 첫 대기 세션 뒤에 줄을 서므로(튜플 락 대기열) 한 단계 간접 대기도 센다.
 */
function countBlockedBy(tag: string): number {
  return Number(
    psql(`WITH h AS (SELECT pid FROM pg_stat_activity WHERE application_name = ${sqlStr(tag)}),
               d AS (SELECT w.pid FROM pg_stat_activity w WHERE pg_blocking_pids(w.pid) && ARRAY(SELECT pid FROM h))
          SELECT count(DISTINCT w.pid) FROM pg_stat_activity w
          WHERE w.pid IN (SELECT pid FROM d) OR pg_blocking_pids(w.pid) && ARRAY(SELECT pid FROM d);`),
  );
}

/** 잠금에 막힌 세션이 어떤 쿼리에서 멈췄는지 (증거 기록용) */
function describeBlocked(tag: string): string {
  return psql(`WITH h AS (SELECT pid FROM pg_stat_activity WHERE application_name = ${sqlStr(tag)}),
                    d AS (SELECT w.pid FROM pg_stat_activity w WHERE pg_blocking_pids(w.pid) && ARRAY(SELECT pid FROM h))
               SELECT w.wait_event || ' :: ' || regexp_replace(left(w.query, 40) || ' ... ' || right(w.query, 60), '\\s+', ' ', 'g') FROM pg_stat_activity w
               WHERE w.pid IN (SELECT pid FROM d) OR pg_blocking_pids(w.pid) && ARRAY(SELECT pid FROM d);`).replace(/\n/g, ' / ');
}

test.describe('이상감지 - 중간 심각도', () => {
  test('[ANOM-G02] 화면 송출은 BE 에 카메라를 등록한 세션으로만 송출하거나, 미등록 세션이면 경고한다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const page = await openAs(who, null);
    const cameraRegisterPosts: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/ward\/camera/.test(request.url())) cameraRegisterPosts.push(request.url());
    });
    const ai = await stubAiStreams(page);
    await page.goto('/guardian/stream');

    await page.getByRole('button', { name: /카메라 미리보기 켜기/ }).click();
    const start = page.getByRole('button', { name: '송출 시작' });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByRole('button', { name: '송출 종료' })).toBeVisible();

    const sessionId = ai.createdSessions[0]?.sessionId ?? '';
    const registeredInBe = psql(`SELECT count(*) FROM camera WHERE session_id = ${sqlStr(sessionId)};`);
    const warned = await page.getByText(/등록되지 않|미등록|카메라를 먼저 등록/).count();

    await page.getByRole('button', { name: '송출 종료' }).click();

    expect(
      cameraRegisterPosts.length > 0 || warned > 0,
      `송출 시작 시 BE 카메라 등록(POST /api/ward/camera) 요청도, 미등록 경고도 없었다. AI 에는 사용자가 입력한 세션 "${sessionId}" 로 바로 세션을 만들었고 ` +
        `BE camera 테이블에는 그 세션이 ${registeredInBe}건이라 이 송출의 화재는 감지 이력·알림이 조용히 유실된다`,
    ).toBe(true);
  });

  test('[ANOM-G03] 두 보호자가 동시에 REAL 과 FALSE_ALARM 으로 응답하면 항상 CONFLICTED(동수)가 된다', async ({ tempUser, loginAs }) => {
    test.setTimeout(480_000);
    const ward = await tempUser('WARD');
    const guardianA = await tempUser('GUARDIAN');
    const guardianB = await tempUser('GUARDIAN');
    connect(guardianA.id, ward.id);
    connect(guardianB.id, ward.id);
    const [a, b] = [await loginAs(guardianA), await loginAs(guardianB)];

    const sessionId = `e2e_race_${Date.now().toString(36)}`;
    const incidentId = insertIncident(ward.id, sessionId);
    // 동수 안내(재확인 푸시)가 임시 보호자에게 나가지 않도록 두 보호자 모두 "이미 처리됨" 으로 기록해 둔다
    psql(`INSERT INTO anomaly_review_conflict_log (incident_id, guardian_id, sent, created_at)
          VALUES (${incidentId}, ${sqlStr(guardianA.id)}, true, now()), (${incidentId}, ${sqlStr(guardianB.id)}, true, now());`);

    // 네트워크 도착 간격(수~수십 ms)이 BE 트랜잭션(수 ms)보다 길어 자연 경합만으로는 겹치지 않는다(60회 시도 0건).
    // 그래서 이 테스트가 만든 상황 행 1개에만 잠시 FOR UPDATE 를 잡아 "두 응답이 동시에 진행 중" 인 순간을 만든다.
    // - 락 없는 코드(소스 미러 기준): findById·응답 목록 조회는 통과하고 응답 insert 의 FK 검사(FOR KEY SHARE)에서 둘 다 멈춘다
    //   -> 풀리면 각자 빈 목록 기준으로 계산해 나중 커밋이 이긴다 (REAL 또는 FALSE_ALARM)
    // - 올바른 코드(상황 행 SELECT FOR UPDATE 후 재조회, 또는 @Version 재시도): 직렬화되어 두 번째 응답이 첫 응답을 보고 CONFLICTED
    // 어느 쿼리에서 멈췄는지를 '경합 확인' 주석에 남긴다 (2026-09-30 dev 는 상황 조회가 FOR NO KEY UPDATE 로 바뀌어 있었다)
    const rounds = 3;
    const wrong: string[] = [];
    const blockedPerRound: string[] = [];
    for (let round = 1; round <= rounds; round++) {
      psql(`DELETE FROM anomaly_incident_feedback WHERE incident_id = ${incidentId};
            UPDATE anomaly_incident SET review_status = 'PENDING' WHERE id = ${incidentId};`);
      const holder = holdIncidentRowLock(incidentId, 8);
      await holder.acquired;
      const responses = Promise.all([
        a.api.raw('POST', `/api/guardian/anomaly/${incidentId}/feedback`, { verdict: 'REAL' }),
        b.api.raw('POST', `/api/guardian/anomaly/${incidentId}/feedback`, { verdict: 'FALSE_ALARM' }),
      ]);
      // 두 요청이 모두 이 잠금에 막힌 것을 확인한 뒤 잠금이 풀리기를 기다린다 (요청이 먼저 나가도록 잠시 양보)
      await new Promise(r => setTimeout(r, 500));
      let blocked = 0;
      await expect
        .poll(() => (blocked = countBlockedBy(holder.tag)), { timeout: 7_000, message: `${round}회차 두 응답 요청이 모두 진행 중인 상태를 만들지 못했다` })
        .toBeGreaterThanOrEqual(2);
      blockedPerRound.push(`${round}회차 대기 ${blocked}건 [${describeBlocked(holder.tag)}]`);
      await holder.done;
      const [resA, resB] = await responses;
      expect([resA.status(), resB.status()], `${round}회차 응답 저장 실패`).toEqual([200, 200]);
      const [[status, feedbackCount]] = psqlRows(
        `SELECT review_status, (SELECT count(*) FROM anomaly_incident_feedback WHERE incident_id = ${incidentId})
         FROM anomaly_incident WHERE id = ${incidentId};`,
      );
      const bodies = `A=${(await resA.text()).slice(0, 200)} B=${(await resB.text()).slice(0, 200)}`;
      test.info().annotations.push({ type: '회차', description: `${round}회차: 응답 ${feedbackCount}건, reviewStatus=${status}, ${bodies}` });
      if (feedbackCount === '2' && status !== 'CONFLICTED') wrong.push(`${round}회차:${status}`);
    }
    test.info().annotations.push({ type: '경합 확인', description: blockedPerRound.join(', ') });

    expect(
      wrong,
      `응답이 1:1(REAL 1, FALSE_ALARM 1)인데 reviewStatus 가 CONFLICTED 가 아닌 회차가 있다 (${wrong.length}/${rounds}회). ` +
        '동시에 진행된 두 응답이 서로의 insert 를 보지 못하고 각자 계산한 뒤 나중 커밋이 덮어쓴다 (상황 행 락·버전 없음). ' +
        '동수가 동수로 표시되지 않아 재확인 흐름도 빠진다',
    ).toEqual([]);
  });

  test('[ANOM-G10] 이용 제한(RESTRICTED)된 보호자는 이상감지 실시간(WS) 이벤트를 더 이상 받지 않는다', async ({
    tempUser,
    loginAs,
    openAs,
  }) => {
    // 공유 AI 서버에 실제 화재 사진을 보낸다(사용자 승인 2026-10-05). 임시 사용자라 실제 푸시·문자는 나가지 않는다
    test.setTimeout(240_000);
    const ward = await tempUser('WARD');
    const active = await tempUser('GUARDIAN'); // 대조군: 정상 보호자는 이벤트를 받아야 한다
    const target = await tempUser('GUARDIAN'); // 이용 제한할 보호자
    const admin = await tempUser('ADMIN');
    connect(active.id, ward.id);
    connect(target.id, ward.id);
    suppressAnomalySmsFallback(ward.id); // FCM 토큰 없는 임시 계정이라 문자 대체 발송을 막는다(실시간 이벤트는 그대로)
    const w = await loginAs(ward);
    const a = await loginAs(active);
    const t = await loginAs(target);
    const ad = await loginAs(admin);

    // 두 보호자 모두 화면을 열어 실시간 연결을 붙여 둔다
    const activePage = await openAs(a.who, '/guardian');
    await waitForRealtime(activePage);
    const activeEvents = await listenAnomalyEvents(activePage, active.id);
    const targetPage = await openAs(t.who, '/guardian');
    await waitForRealtime(targetPage);
    const targetEvents = await listenAnomalyEvents(targetPage, target.id);

    // 연결이 열린 상태에서 관리자가 이용 제한
    const restrict = await ad.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: 'qa' });
    expect(restrict.status(), '준비: 관리자가 보호자를 이용 제한').toBe(200);

    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: '거실' });
    const streamer = await openAs(a.who, '/guardian/stream');
    try {
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);
      await sendFireFrames(streamer, camera.sessionId, fireImage());
      await expect
        .poll(async () => (await activeEvents()).length, { timeout: 30_000, message: '준비: 정상 보호자에게 화재 이벤트가 와야 한다' })
        .toBeGreaterThan(0);
      // 같은 방송이 제한된 보호자에게도 갔는지 조금 더 기다린 뒤 확인
      await new Promise(resolve => setTimeout(resolve, 5_000));
    } finally {
      await stopManualSession(streamer, camera.sessionId);
      await w.api.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
    }

    // 0건이 "서버가 걸러서"인지 "연결이 끊겨서"인지 구분해 남긴다
    const targetState = await targetPage
      .evaluate(() => ({
        url: location.pathname,
        connected: (window as unknown as { __connectionStompClient?: { connected: boolean } }).__connectionStompClient?.connected ?? null,
      }))
      .catch(error => ({ url: 'evaluate 실패', connected: null, error: String(error) }));
    test.info().annotations.push({ type: '제한된 보호자 화면 상태', description: JSON.stringify(targetState) });
    const received = await targetEvents().catch(() => [] as Record<string, unknown>[]);
    test.info().annotations.push({ type: '제한된 보호자가 받은 이벤트', description: `${received.length}건` });
    expect(
      received.length,
      `이용 제한된 보호자의 열린 실시간 연결로 화재 이벤트가 ${received.length}건 도착했다(피보호자 이름·위치 포함). ` +
        '실시간 방송 대상도 이용 가능한 계정만 고르거나, 제한할 때 실시간 연결을 끊어야 한다',
    ).toBe(0);
  });

  test('[ANOM-G11] 이상감지 모니터는 분석 불가(unknown)와 AI 연결 끊김을 "이상 없음"으로 보여주지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const page = await openAs(who, null);
    const sessionId = `e2e_mon_${Date.now().toString(36)}`;

    // AI 실시간 소켓(NEXT_PUBLIC_STREAM_WS_URL)을 가로채 서버가 연결을 곧 끊는 상황을 만든다. BE STOMP 소켓은 건드리지 않는다.
    const aiSockets: { url: string; closedByServer: boolean }[] = [];
    await page.routeWebSocket(url => !/^api\./.test(url.hostname) && !/webpack-hmr|_next/.test(url.pathname), ws => {
      const record = { url: ws.url(), closedByServer: false };
      aiSockets.push(record);
      ws.onMessage(() => undefined);
      // 접속 직후에는 unknown 분석 결과를 한 번 보낸 뒤, 잠시 후 서버가 끊는다
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'latest_analysis', data: { session_id: sessionId, detectedType: 'unknown', confidence: 0, danger: false } }));
      }, 500);
      setTimeout(() => {
        record.closedByServer = true;
        ws.close();
      }, 4_000);
    });
    await stubAiStreams(page, {
      sessions: [{ session_id: sessionId, ward_name: 'E2E' }],
      analysis: { detectedType: 'unknown', confidence: 0, danger: false },
    });
    await page.goto('/guardian/detection');
    await page.getByRole('button', { name: new RegExp(sessionId) }).click();

    const safeText = page.getByText('이상 없음', { exact: true });
    await test.step('(a) 분석 결과가 unknown 이면 "이상 없음" 이 아니라 분석 불가로 구분한다', async () => {
      await expect(page.getByText('최신 감지 결과')).toBeVisible();
      await page.waitForTimeout(1_500);
      await expect.soft(safeText, 'AI 가 unknown(프레임 디코드 실패·모델 미로드)을 보냈는데 화면은 "이상 없음" 으로 표시한다 (안전 착시)').toHaveCount(0);
    });

    await test.step('(c) AI 소켓이 끊기면 "연결 끊김" 을 표시하거나 다시 연결한다', async () => {
      test.info().annotations.push({ type: '참고', description: `가로챈 AI 소켓: ${aiSockets.map(s => s.url).join(', ') || '없음(환경변수 미설정 가능)'}` });
      await expect.poll(() => aiSockets.some(s => s.closedByServer), { timeout: 15_000, message: 'AI 소켓 연결이 화면에서 시도되지 않았다' }).toBe(true);
      await page.waitForTimeout(2_000);
      const notice = await page.getByText(/연결 끊김|연결이 끊|재연결|연결 중/).count();
      const reconnected = aiSockets.length > 1;
      expect.soft(notice > 0 || reconnected, 'AI 소켓이 끊겨도 화면에 연결 끊김 표시도, 재연결 시도도 없다 (마지막 결과가 그대로 남음)').toBe(true);
    });
  });

  test('[ANOM-G12] 카메라 방 이름을 빈 값이나 공백으로 수정할 수 없다', async ({ tempUser, loginAs }) => {
    const ward = await tempUser('WARD');
    const { api } = await loginAs(ward);
    const camera = await api.post<{ id: number; label: string }>('/api/ward/camera', { label: '거실' });

    const results: string[] = [];
    for (const label of ['', '   ']) {
      const res = await api.raw('PATCH', `/api/ward/camera/${camera.id}`, { label });
      results.push(`label=${JSON.stringify(label)} -> ${res.status()}`);
    }
    const [[savedLabel]] = psqlRows(`SELECT '[' || label || ']' FROM camera WHERE id = ${camera.id};`);
    const responses = results.join(', ');

    expect(
      results.every(line => line.endsWith('-> 400')),
      `빈 방 이름 수정이 거부되지 않았다 (${responses}). DB 에 저장된 방 이름: ${savedLabel}. ` +
        '이 상태로 화재가 나면 알림 문구가 "댁 에서 화재가 감지되었습니다" 처럼 위치가 빠진다',
    ).toBe(true);
    await expect(api.get<{ id: number; label: string }[]>('/api/ward/camera').then(list => list.find(c => c.id === camera.id)?.label)).resolves.toBe('거실');
  });

  test('[ANOM-G16] 보호자 앱에 이상감지 이력·판정 화면과 판정 요청 푸시 처리 경로가 있다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const page = await openAs(who, null);
    const anomalyApiCalls: string[] = [];
    page.on('request', request => {
      if (/\/api\/guardian\/anomaly/.test(request.url())) anomalyApiCalls.push(request.url());
    });
    await stubAiStreams(page);

    await test.step('보호자가 이상감지 메뉴에서 이력을 보고 REAL/FALSE_ALARM 으로 판정할 수 있다', async () => {
      await page.goto('/guardian/detection');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.waitForTimeout(2_000);
      const historyLink = await page.getByRole('link', { name: /이상감지 (이력|내역|기록)|판정/ }).count();
      const verdictButtons = await page.getByRole('button', { name: /실제 (상황|화재)|오탐|오인|화재 아님/ }).count();
      expect.soft(
        historyLink + verdictButtons + anomalyApiCalls.length,
        '이상감지 화면에 판정 이력 링크·판정 버튼이 없고 /api/guardian/anomaly/* 도 호출하지 않는다 (판정 데이터가 쌓일 수 없음)',
      ).toBeGreaterThan(0);
    });

    await test.step('푸시(ANOMALY_REVIEW_REQUIRED, ANOMALY_REVIEW_CONFLICTED)를 눌렀을 때 처리 분기가 서비스워커에 있다', async () => {
      const res = await page.request.get(`${env.baseUrl}/firebase-messaging-sw.js`);
      const source = res.ok() ? await res.text() : '';
      expect.soft(source, '서비스워커를 읽지 못함').not.toBe('');
      expect.soft(source, '서비스워커 notificationclick 에 ANOMALY_REVIEW_REQUIRED 처리가 없다').toMatch(/ANOMALY_REVIEW_REQUIRED/);
      expect.soft(source, '서비스워커 notificationclick 에 ANOMALY_REVIEW_CONFLICTED 처리가 없다').toMatch(/ANOMALY_REVIEW_CONFLICTED/);
    });
  });
});
