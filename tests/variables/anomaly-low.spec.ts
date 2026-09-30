/**
 * 변수 QA - 이상감지(화재) 낮은 심각도 발견 항목
 *
 * 안전 원칙
 * - 임시 사용자(tempUser)와 이 파일이 만든 행만 쓴다. 실제 화재 신호(사진)는 보내지 않는다(AI 서버도 내려가 있음, AI-6).
 * - 재촉 스케줄러(5분 주기)는 공유 서버 것을 그대로 쓰되, 임시 보호자에게는 FCM 토큰이 없어 실제 푸시는 나가지 않는다.
 *   동수 재확인 안내가 나가지 않도록 anomaly_review_conflict_log 를 미리 채운다.
 */
import { spawn } from 'node:child_process';

import { request } from '@playwright/test';

import { env } from '../../src/env';
import { expect, test } from '../../src/fixtures';
import { psql, psqlRows, sqlStr } from '../../src/remote';
import { connect } from '../../src/variables';

/** 이 테스트가 만든 상황 행 1개에만 FOR UPDATE 잠금을 seconds 초 동안 잡는 별도 DB 세션 (ANOM-G04 용) */
function holdIncidentRowLock(incidentId: number, seconds: number): { tag: string; acquired: Promise<void>; done: Promise<void> } {
  const tag = `e2e_anomlow_${incidentId}_${Date.now().toString(36)}`;
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

/** tag 세션이 잡은 잠금 때문에 (간접 대기 포함) 기다리고 있는 다른 DB 세션 수 */
function countBlockedBy(tag: string): number {
  return Number(
    psql(`WITH h AS (SELECT pid FROM pg_stat_activity WHERE application_name = ${sqlStr(tag)}),
               d AS (SELECT w.pid FROM pg_stat_activity w WHERE pg_blocking_pids(w.pid) && ARRAY(SELECT pid FROM h))
          SELECT count(DISTINCT w.pid) FROM pg_stat_activity w
          WHERE w.pid IN (SELECT pid FROM d) OR pg_blocking_pids(w.pid) && ARRAY(SELECT pid FROM d);`),
  );
}

/** 이상감지 상황 1건을 DB 에 직접 만든다. startedAt/lastDetectedAt 은 지금으로부터 minutesAgo 분 전 */
function insertIncident(wardId: string, sessionId: string, minutesAgo = 0): number {
  return Number(
    psql(`INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status)
          VALUES (${sqlStr(wardId)}, ${sqlStr(sessionId)}, 'FIRE', now() - interval '${minutesAgo} minutes', now() - interval '${minutesAgo} minutes', 1, 0.9, 'PENDING')
          RETURNING id;`)
      .split('\n')[0],
  );
}

/** 서버(DB) 기준 KST 현재 시(hour). 재촉 스케줄러의 야간/요약 시각 판단이 서버 시계를 쓰기 때문 */
function kstHour(): number {
  return Number(psql(`SELECT extract(hour FROM now() AT TIME ZONE 'Asia/Seoul')::int;`));
}

async function sleep(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/** 조건이 참이 될 때까지 intervalMs 마다 확인한다. 시간 안에 안 되면 false */
async function waitUntil(check: () => boolean, timeoutMs: number, intervalMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(intervalMs);
  }
  return check();
}

test.describe('이상감지 - 낮은 심각도', () => {
  test('[ANOM-G04] 같은 보호자의 첫 응답이 동시에 2번 도착해도 둘 다 200 으로 멱등 처리된다', async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const ward = await tempUser('WARD');
    const guardian = await tempUser('GUARDIAN');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const incidentId = insertIncident(ward.id, `e2e_dbl_${Date.now().toString(36)}`);

    // 네트워크 간격이 BE 트랜잭션보다 길어 자연 경합은 거의 없다. 이 테스트가 만든 상황 행 1개에만 잠시 FOR UPDATE 를 잡아
    // "두 요청이 모두 응답 없음으로 보고 insert 하려는 순간" 을 만든다 (조회 후 insert 구조라면 잠금이 풀린 뒤 늦은 쪽 insert 가 unique 위반,
    // 서비스가 상황 행을 먼저 잠그는 구조라면 두 요청이 줄을 서서 둘 다 200)
    const rounds = 3;
    const failed: string[] = [];
    const notes: string[] = [];
    const notConcurrent: string[] = [];
    for (let round = 1; round <= rounds; round++) {
      psql(`DELETE FROM anomaly_incident_feedback WHERE incident_id = ${incidentId};
            UPDATE anomaly_incident SET review_status = 'PENDING' WHERE id = ${incidentId};`);
      const holder = holdIncidentRowLock(incidentId, 8);
      await holder.acquired;
      const responses = Promise.all([
        g.api.raw('POST', `/api/guardian/anomaly/${incidentId}/feedback`, { verdict: 'REAL' }),
        g.api.raw('POST', `/api/guardian/anomaly/${incidentId}/feedback`, { verdict: 'REAL' }),
      ]);
      await sleep(500);
      let blocked = 0;
      await expect
        .poll(() => (blocked = countBlockedBy(holder.tag)), { timeout: 6_000 })
        .toBeGreaterThanOrEqual(2)
        .catch(() => undefined);
      await holder.done;
      const [r1, r2] = await responses;
      const [s1, s2] = [r1.status(), r2.status()];
      const bodies = `${(await r1.text()).slice(0, 120)} / ${(await r2.text()).slice(0, 120)}`;
      const [[rows]] = [psqlRows(`SELECT count(*) FROM anomaly_incident_feedback WHERE incident_id = ${incidentId};`)];
      notes.push(`${round}회차: 대기 ${blocked}건, 상태 ${s1}/${s2}, 저장 ${rows[0]}행, ${bodies}`);
      if (s1 !== 200 || s2 !== 200) failed.push(`${round}회차 ${s1}/${s2}`);
      if (blocked < 2) notConcurrent.push(`${round}회차 대기 ${blocked}건`);
    }
    test.info().annotations.push({ type: '회차', description: notes.join(' | ') });
    console.log(`[ANOM-G04] ${notes.join(' | ')}`);

    // 전제: 매 회차 두 요청이 모두 같은 순간 DB 에서 대기했어야 "동시 도착" 을 실제로 만든 것이다
    expect(notConcurrent, `두 요청이 동시에 대기 상태에 들어가지 않아 경합을 만들지 못했다 [${notes.join(' | ')}]`).toEqual([]);

    expect(
      failed,
      `같은 보호자가 첫 응답을 동시에 2번 보내면 한쪽이 200 이 아니다 (${failed.join(', ')}). 응답 존재 여부를 조회한 뒤 insert 하는 구조라 ` +
        'unique(incident_id, guardian_id) 위반이 전역 핸들러에서 409 "이미 사용 중이거나 중복된 값입니다" 로 변환된다. ' +
        `원자적 upsert 라면 둘 다 200 이어야 한다. [${notes.join(' | ')}]`,
    ).toEqual([]);
  });

  test('[ANOM-G06] 동수(CONFLICTED) 상황에서도 미응답 보호자는 건별 재촉 또는 동수 안내를 받는다', async ({ tempUser, loginAs }) => {
    test.setTimeout(540_000);
    const hour = kstHour();
    test.skip(hour >= 22 || hour < 8, `야간(22~08 KST, 현재 ${hour}시)에는 재촉 스케줄러가 발송을 미루므로 검증할 수 없다`);

    const ward = await tempUser('WARD');
    const [ga, gb, gc] = [await tempUser('GUARDIAN'), await tempUser('GUARDIAN'), await tempUser('GUARDIAN')];
    for (const g of [ga, gb, gc]) connect(g.id, ward.id);
    const [a, b] = [await loginAs(ga), await loginAs(gb)];

    const tag = Date.now().toString(36);
    // 대상: A 는 REAL, B 는 FALSE_ALARM -> 1:1 동수. C 는 미응답. 상황은 2시간 전에 닫혔다(재촉 조건 lastDetectedAt <= now-70분 충족)
    const target = insertIncident(ward.id, `e2e_g06_${tag}`, 120);
    // 대조군: 같은 피보호자의 미응답(PENDING) 상황. 스케줄러가 돌았다면 C 에게 이 상황의 재촉은 반드시 기록된다
    const control = insertIncident(ward.id, `e2e_g06c_${tag}`, 120);
    // 동수 안내 FCM 이 나가지 않도록 응답자 두 명을 이미 처리됨으로 기록
    psql(`INSERT INTO anomaly_review_conflict_log (incident_id, guardian_id, sent, created_at)
          VALUES (${target}, ${sqlStr(ga.id)}, true, now()), (${target}, ${sqlStr(gb.id)}, true, now());`);

    expect((await a.api.raw('POST', `/api/guardian/anomaly/${target}/feedback`, { verdict: 'REAL' })).status()).toBe(200);
    expect((await b.api.raw('POST', `/api/guardian/anomaly/${target}/feedback`, { verdict: 'FALSE_ALARM' })).status()).toBe(200);
    expect(psql(`SELECT review_status FROM anomaly_incident WHERE id = ${target};`), '준비: A/B 응답으로 동수가 되어야 한다').toBe('CONFLICTED');

    const reminded = (incidentId: number) =>
      psql(`SELECT count(*) FROM anomaly_review_reminder_log WHERE incident_id = ${incidentId} AND guardian_id = ${sqlStr(gc.id)};`) === '1';
    const ran = await waitUntil(() => reminded(control), 420_000);
    expect(ran, '스케줄러(5분 주기)가 돌지 않았다 - 대조군 상황의 재촉 기록이 7분 안에 생기지 않음(재촉 기능 꺼짐 또는 서버 시각 문제)').toBe(true);
    await sleep(3_000);

    const gotReminder = reminded(target);
    const gotConflictNotice =
      psql(`SELECT count(*) FROM anomaly_review_conflict_log WHERE incident_id = ${target} AND guardian_id = ${sqlStr(gc.id)};`) === '1';
    test.info().annotations.push({ type: '결과', description: `C 재촉기록(대상 상황)=${gotReminder}, C 동수안내기록=${gotConflictNotice}` });

    expect(
      gotReminder || gotConflictNotice,
      '동수(CONFLICTED)인 상황의 미응답 보호자 C 에게 건별 재촉도, 동수 안내도 기록되지 않았다. ' +
        '같은 시점에 PENDING 인 대조군 상황에는 C 재촉이 기록되어 스케줄러는 돌았다. 재촉 후보 쿼리는 PENDING 만 대상으로 하고 ' +
        '동수 안내는 응답자만 대상이라, 동수를 깰 수 있는 미응답자가 아무 요청도 받지 못한다',
    ).toBe(true);
  });

  test('[ANOM-G08] 사용 중지(isActive=false)한 카메라의 화재 신호는 이력·알림을 만들지 않거나 보호자 목록과 일관되게 처리된다', async () => {
    test.fixme(
      true,
      '화재 신호는 BE 가 클라이언트로 붙은 AI 서버 WS(live_streams / latest_analysis)로만 들어오고, BE 에는 신호 주입용 엔드포인트가 없으며 WS 주소는 서버 설정이라 흉내 낼 수 없다. ' +
        'AI 서버는 다시 살아났지만(2026-09-30 확인: /api/streams/v1/live-streams 200, BE 로그 "AI WS 연결됨"), 재현하려면 공유 AI 서버에 실제 화재 프레임을 보내 탐지를 일으켜야 해서 ' +
        '사용자 승인 없이는 실행하지 않는다 (자동 실행 권한에서도 거부됨). ' +
        '재현 절차: 임시 ward 카메라 등록 -> 송출/구독 -> PATCH /api/ward/camera/{id} {isActive:false} -> ' +
        '화재 프레임 전송(anomaly:notify:{userId}:{sessionId}:FIRE 선점으로 알림 억제) -> anomaly_incident 생성 여부(기대: 생성되지 않음) 확인',
    );
  });

  test('[ANOM-G09] 건별 재촉이 나간 같은 주기에 미응답 요약이 이어서 발송되지 않는다', async ({ tempUser }) => {
    test.setTimeout(540_000);
    const hour = kstHour();
    test.skip(hour < 20 || hour >= 22, `요약 시각(20:00)~야간 시작(22:00 KST) 사이에만 재현된다 (현재 ${hour}시)`);

    const ward = await tempUser('WARD');
    const guardian = await tempUser('GUARDIAN');
    connect(guardian.id, ward.id);
    // 상황이 75분 전에 닫혔다 -> 이번 주기에 건별 재촉 대상이 된다
    const incidentId = insertIncident(ward.id, `e2e_g09_${Date.now().toString(36)}`, 75);

    const reminderRow = () =>
      psqlRows(`SELECT to_char(sent_at, 'HH24:MI:SS') FROM anomaly_review_reminder_log WHERE incident_id = ${incidentId} AND guardian_id = ${sqlStr(guardian.id)};`);
    const summaryRows = () =>
      psqlRows(`SELECT to_char(sent_at, 'HH24:MI:SS'), pending_count FROM anomaly_review_summary_log WHERE guardian_id = ${sqlStr(guardian.id)};`);

    const remindedOk = await waitUntil(() => reminderRow().length === 1, 420_000);
    expect(remindedOk, '스케줄러(5분 주기)가 건별 재촉을 기록하지 않았다 (재촉 기능 꺼짐 또는 서버 시각 문제)').toBe(true);
    // 같은 주기의 요약 단계까지 끝나도록 잠시 기다린다 (재촉 -> 동수 안내 -> 요약 순으로 연달아 실행)
    await sleep(15_000);

    const reminder = reminderRow()[0]?.[0];
    const summaries = summaryRows();
    test.info().annotations.push({ type: '결과', description: `재촉 ${reminder}, 요약 ${JSON.stringify(summaries)}` });

    expect(
      summaries,
      `건별 재촉(${reminder})이 나간 바로 그 주기에 같은 상황으로 미응답 요약도 발송 기록이 생겼다 (${JSON.stringify(summaries)}). ` +
        '요약이 방금 커밋된 재촉 로그를 그대로 세기 때문에 수 초 간격으로 푸시가 2건 도착한다 (알림 피로). ' +
        '요약은 재촉 후 최소 간격이 지난 상황만 담아야 한다',
    ).toEqual([]);
  });

  test('[ANOM-G14] 이력 저장이 실패(롤백)하면 쿨다운 키도 남기지 않아 이후 화재 신호가 1분간 버려지지 않는다', async () => {
    test.fixme(
      true,
      'AnomalyDetectionService.handle 의 유일한 진입점은 백엔드가 AI 서버에 거는 WS(AiLiveStreamSubscriber, latest_analysis)라서 ' +
        'HTTP·DB·Redis 로 신호를 주입할 방법이 없고, AI 서버가 내려가 있다(AI-6). 저장 실패(롤백) 경로는 DB 장애 유발이 필요해 공유 dev 서버에서 금지. ' +
        '재현 절차(AI 복구 후/전용 환경): (a) 저장 단계 예외 강제 또는 (b) 화재 영상 스트리밍 중 카메라 삭제로 소유자 매핑 실패 -> ' +
        'anomaly:cooldown:{sessionId}:FIRE 키가 남지 않아야 하고 바로 다음 화재 신호가 이력으로 적재되어야 한다 (현재는 키가 남아 1분간 스킵)',
    );
  });

  test('[ANOM-G17] Swagger 문서가 실제 카메라 IDOR(403)·판정 응답 에러 코드와 일치한다', async ({ tempUser, loginAs }) => {
    const wardA = await tempUser('WARD');
    const wardB = await tempUser('WARD');
    const guardian = await tempUser('GUARDIAN');
    const [a, b] = [await loginAs(wardA), await loginAs(wardB)];
    void guardian;

    const camera = await a.api.post<{ id: number }>('/api/ward/camera', { label: '거실' });

    // 실제 동작: 타인 카메라 수정·삭제는 403
    const patchRes = await b.api.raw('PATCH', `/api/ward/camera/${camera.id}`, { label: '침입' });
    const deleteRes = await b.api.raw('DELETE', `/api/ward/camera/${camera.id}`);
    const actual = `PATCH ${patchRes.status()}, DELETE ${deleteRes.status()}`;
    expect([patchRes.status(), deleteRes.status()], `타인 카메라 수정·삭제 실제 응답: ${actual}`).toEqual([403, 403]);
    expect(await a.api.get<{ id: number; label: string }[]>('/api/ward/camera').then(list => list.find(c => c.id === camera.id)?.label)).toBe('거실');

    // 문서: /v3/api-docs 가 같은 내용을 말한다
    const ctx = await request.newContext({ baseURL: env.apiUrl });
    try {
      const res = await ctx.get('/v3/api-docs');
      expect(res.ok(), 'OpenAPI 문서(/v3/api-docs)를 읽지 못했다').toBe(true);
      type Op = { description?: string; responses?: Record<string, { description?: string }> };
      const doc = (await res.json()) as { paths: Record<string, Record<string, Op>> };
      const cameraPath = doc.paths['/api/ward/camera/{id}'];
      const feedbackPost = doc.paths['/api/guardian/anomaly/{incidentId}/feedback']?.post;

      for (const method of ['patch', 'delete'] as const) {
        const op = cameraPath?.[method];
        expect(op, `문서에 ${method.toUpperCase()} /api/ward/camera/{id} 가 없다`).toBeTruthy();
        expect(op?.description ?? '', `${method.toUpperCase()} 설명이 타인 카메라를 404 로 응답한다고 적고 있다 (실제 403)`).not.toMatch(/타인[^.]*404/);
        expect(op?.responses?.['404']?.description ?? '', `${method.toUpperCase()} 404 응답 설명이 "본인 카메라가 아님" 을 포함한다 (실제 403)`).not.toMatch(/본인 카메라가 아님/);
        expect(op?.responses?.['403'], `${method.toUpperCase()} 의 403 응답 설명이 없다`).toBeTruthy();
      }
      expect(feedbackPost, '문서에 판정 응답 API 가 없다').toBeTruthy();
      expect(Object.keys(feedbackPost?.responses ?? {}), '판정 응답 문서에 이미 폐지된 409(관리자 확정) 응답이 남아 있다').not.toContain('409');
    } finally {
      await ctx.dispose();
    }
  });
});
