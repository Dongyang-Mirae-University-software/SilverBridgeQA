/**
 * 최종 QA - 카메라·이상감지(CAM) P1a - 보호자 판정(오탐 응답)
 *
 * 이상감지 상황은 임시 피보호자 자신의 행으로 DB 에 시드한다(판정 API 만 보는 케이스라 실제 화재 신호는 쓰지 않는다).
 * 시드한 행은 임시 사용자를 지울 때 외래키로 함께 지워진다. CAM-N38 만 동수 안내(5분 주기 스케줄러)를 보려고
 * 카메라 1대를 등록한다(안내는 등록된 카메라의 상황에만 간다). 끝나면 바로 지운다.
 * 동시 응답(N39)은 실제 상황이 필요해 cam-p1a-clip.spec.ts 의 실제 화재 묶음에서 확인한다.
 */
import { request } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psqlRows, sqlStr } from '../../../src/remote';
import {
  cleanupAll,
  connect,
  errOf,
  feedback,
  incidentRow,
  kstHour,
  loginUser,
  mkUser,
  registerCamera,
  seedIncident,
  sleep,
  TAGS,
  waitForCameraSlots,
  trackCameraP1a,
} from './_helpers-cam-p1a';

test.afterEach(async () => {
  await cleanupAll();
});

const fakeSession = () => `e2e-p1a-${Math.random().toString(36).slice(2, 10)}`;

function feedbackRows(incidentId: number) {
  return psqlRows(`SELECT guardian_id, verdict FROM anomaly_incident_feedback WHERE incident_id = ${incidentId} ORDER BY guardian_id;`);
}

test.describe('카메라·이상감지 P1a - 보호자 판정', () => {
  test('CAM-A31 판정 입력 검증: 잘못된 verdict·빈 본문·로그인 없음', TAGS, async () => {
    const ward = mkUser('WARD');
    const g = mkUser('GUARDIAN');
    const stranger = mkUser('GUARDIAN', 'E2E판정남남');
    connect(g.id, ward.id);
    const incidentId = seedIncident({ wardId: ward.id, sessionId: fakeSession() });
    const gl = await loginUser(g);
    const sl = await loginUser(stranger);
    const wl = await loginUser(ward);
    const url = `/api/guardian/anomaly/${incidentId}/feedback`;

    // 잘못된 값 3가지: 400, 상황의 판정은 그대로 PENDING
    for (const [label, body] of [['MAYBE', { verdict: 'MAYBE' }], ['소문자 real', { verdict: 'real' }], ['verdict 없는 빈 객체', {}], ['null', { verdict: null }]] as const) {
      const err = await errOf(await gl.api.raw('POST', url, body));
      expect(err.status, `${label} -> 실제 ${err.status} ${err.code ?? ''}`).toBe(400);
    }
    // 본문 자체가 없는 요청
    const noBody = await errOf(await gl.api.raw('POST', url));
    expect(noBody.status, `본문 없음 -> 실제 ${noBody.status} ${noBody.code ?? ''}`).toBe(400);
    expect(feedbackRows(incidentId), '거절된 요청은 응답으로 저장되면 안 된다').toEqual([]);
    expect(incidentRow(incidentId)?.review, '거절된 요청 뒤에도 판정은 PENDING').toBe('PENDING');

    // 로그인 없음 401
    const anon = await request.newContext({ baseURL: env.apiUrl });
    try {
      const res = await anon.post(url, { data: { verdict: 'REAL' } });
      expect(res.status(), '토큰 없이 판정').toBe(401);
    } finally {
      await anon.dispose();
    }

    // 연결 안 된 보호자 403 ANOMALY_NOT_AUTHORIZED
    const notLinked = await errOf(await sl.api.raw('POST', url, { verdict: 'REAL' }));
    expect(notLinked.status, '연결 안 된 보호자 판정').toBe(403);
    expect(notLinked.code).toBe('ANOMALY_NOT_AUTHORIZED');
    // 피보호자(역할 다름) 403
    expect((await errOf(await wl.api.raw('POST', url, { verdict: 'REAL' }))).status, '피보호자 계정으로 보호자 판정').toBe(403);
    // 없는 상황 404
    const missing = await errOf(await gl.api.raw('POST', '/api/guardian/anomaly/999999999/feedback', { verdict: 'REAL' }));
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('ANOMALY_INCIDENT_NOT_FOUND');
    expect(feedbackRows(incidentId), '거절된 요청들 뒤에도 응답 저장 없음').toEqual([]);

    // reminder-setting 에 문자열 값 -> 400, 설정은 그대로(기본 true)
    const badSetting = await errOf(await gl.api.raw('PUT', '/api/guardian/anomaly/reminder-setting', { reviewReminderEnabled: 'maybe' }));
    expect(badSetting.status, `재촉 설정에 문자열 -> 실제 ${badSetting.status} ${badSetting.code ?? ''}`).toBe(400);
    const setting = await gl.api.get<{ reviewReminderEnabled: boolean }>('/api/guardian/anomaly/reminder-setting');
    expect(setting.reviewReminderEnabled, '잘못된 값 뒤에도 재촉 설정은 기본 true').toBe(true);
    // 토큰 없는 재촉 설정 변경도 401
    const anon2 = await request.newContext({ baseURL: env.apiUrl });
    try {
      expect((await anon2.put('/api/guardian/anomaly/reminder-setting', { data: { reviewReminderEnabled: false } })).status(), '토큰 없이 재촉 설정').toBe(401);
    } finally {
      await anon2.dispose();
    }
    // 올바른 값 REAL 은 정상 통과(검증이 정상 입력까지 막지 않는지)
    const ok = await feedback(gl.api, incidentId, 'REAL');
    expect(ok.status).toBe(200);
  });

  test('CAM-N36 보호자 응답 REAL·FALSE_ALARM과 답 바꾸기', TAGS, async () => {
    const ward = mkUser('WARD');
    const g = mkUser('GUARDIAN');
    connect(g.id, ward.id);
    const incidentId = seedIncident({ wardId: ward.id, sessionId: fakeSession() });
    // 이력 응답에 나오는 incidentId 와 감지 기록(anomaly_event) 번호는 다르다 - 판정 번호는 incidentId
    const eventId = Number(
      psqlRows(`INSERT INTO anomaly_event (ward_id, session_id, detected_type, confidence, danger, detected_at, created_at, incident_id)
                VALUES (${sqlStr(ward.id)}, ${sqlStr('e2e-p1a-event')}, 'FIRE', 0.9, true, now(), now(), ${incidentId}) RETURNING id;`)[0][0],
    );
    const gl = await loginUser(g);

    const history = await gl.api.get<{ content: { incidentId: number; reviewStatus: string; myVerdict: string | null }[] }>(`/api/guardian/anomaly/history?wardId=${ward.id}`);
    expect(history.content.map(i => i.incidentId), '이력 항목의 번호가 시드한 상황 번호').toEqual([incidentId]);
    expect(history.content[0].myVerdict, '응답 전 myVerdict').toBeNull();

    const real = await feedback(gl.api, incidentId, 'REAL');
    expect(real.status).toBe(200);
    expect(real.json.data).toMatchObject({ incidentId, reviewStatus: 'REAL', myVerdict: 'REAL' });
    expect(feedbackRows(incidentId)).toEqual([[g.id, 'REAL']]);

    const flip = await feedback(gl.api, incidentId, 'FALSE_ALARM');
    expect(flip.status).toBe(200);
    expect(flip.json.data).toMatchObject({ incidentId, reviewStatus: 'FALSE_ALARM', myVerdict: 'FALSE_ALARM' });
    expect(feedbackRows(incidentId), '번복해도 한 사람당 한 줄').toEqual([[g.id, 'FALSE_ALARM']]);
    expect(incidentRow(incidentId)?.review).toBe('FALSE_ALARM');

    const after = await gl.api.get<{ content: { reviewStatus: string; myVerdict: string }[] }>(`/api/guardian/anomaly/history?wardId=${ward.id}`);
    expect(after.content[0]).toMatchObject({ reviewStatus: 'FALSE_ALARM', myVerdict: 'FALSE_ALARM' });

    // 감지 기록 번호(anomalyEventId)로는 판정할 수 없다(다른 상황 번호와 겹치지 않을 때만 확인한다)
    const collides = Number(psqlRows(`SELECT count(*) FROM anomaly_incident WHERE id = ${eventId};`)[0][0]);
    if (collides === 0) {
      const wrong = await errOf(await gl.api.raw('POST', `/api/guardian/anomaly/${eventId}/feedback`, { verdict: 'REAL' }));
      expect(wrong.status, `anomalyEventId 로 판정 시도 -> 실제 ${wrong.status} ${wrong.code ?? ''}`).toBe(404);
      expect(wrong.code).toBe('ANOMALY_INCIDENT_NOT_FOUND');
    } else {
      test.info().annotations.push({ type: '확인 생략', description: 'anomalyEventId 가 다른 상황 번호와 겹쳐 "event 번호로는 판정 불가" 확인은 건너뜀' });
    }
    // 같은 답을 다시 보내도 성공(멱등)
    const again = await feedback(gl.api, incidentId, 'FALSE_ALARM');
    expect(again.status).toBe(200);
    expect(feedbackRows(incidentId).length).toBe(1);
  });

  test('CAM-N37 다수결: 2:1이면 많은 쪽', TAGS, async () => {
    const ward = mkUser('WARD');
    const gs = [mkUser('GUARDIAN', 'E2E다수결1'), mkUser('GUARDIAN', 'E2E다수결2'), mkUser('GUARDIAN', 'E2E다수결3'), mkUser('GUARDIAN', 'E2E다수결미응답')];
    for (const g of gs) connect(g.id, ward.id);
    const incidentId = seedIncident({ wardId: ward.id, sessionId: fakeSession() });
    const a = await loginUser(gs[0]);
    const b = await loginUser(gs[1]);
    const c = await loginUser(gs[2]);
    const silent = await loginUser(gs[3]);

    // 미응답(silent)은 세지 않는다: 1명만 답했으면 그 쪽이 이긴다
    expect((await feedback(a.api, incidentId, 'REAL')).json.data?.reviewStatus, '1:0').toBe('REAL');
    expect((await feedback(c.api, incidentId, 'FALSE_ALARM')).json.data?.reviewStatus, '1:1 동수').toBe('CONFLICTED');
    const third = await feedback(b.api, incidentId, 'REAL');
    expect(third.status).toBe(200);
    expect(third.json.data?.reviewStatus, '2:1 많은 쪽').toBe('REAL');
    expect(incidentRow(incidentId)?.review).toBe('REAL');

    // 소수 의견(FALSE_ALARM)은 상태에는 안 남고 응답 내역에는 남는다
    const rows = feedbackRows(incidentId);
    expect(rows.length, '응답 내역 3줄(미응답은 없음)').toBe(3);
    expect(rows.find(r => r[0] === c.user.id)?.[1], '소수 의견이 응답 내역에 남아 있다').toBe('FALSE_ALARM');
    expect(rows.find(r => r[0] === silent.user.id), '미응답 보호자는 응답 내역에 없다').toBeUndefined();
    const mine = await c.api.get<{ content: { reviewStatus: string; myVerdict: string }[] }>(`/api/guardian/anomaly/history?wardId=${ward.id}`);
    expect(mine.content[0], '소수 의견 보호자 화면: 상태는 REAL, 내 응답은 FALSE_ALARM').toMatchObject({ reviewStatus: 'REAL', myVerdict: 'FALSE_ALARM' });
    const none = await silent.api.get<{ content: { reviewStatus: string; myVerdict: string | null }[] }>(`/api/guardian/anomaly/history?wardId=${ward.id}`);
    expect(none.content[0], '미응답 보호자 화면').toMatchObject({ reviewStatus: 'REAL', myVerdict: null });
  });

  test('CAM-N38 동수면 엇갈림 + 다시 확인 푸시 1번', TAGS, async () => {
    // 카메라 자리를 기다리는 시간(최대 10분) + 안내 대기(최대 8분) + 1회 확인(5.5분)
    test.setTimeout(1_500_000);
    const ward = mkUser('WARD', 'E2E동수본인');
    const first = mkUser('GUARDIAN', 'E2E동수먼저');
    const second = mkUser('GUARDIAN', 'E2E동수나중');
    const silent = mkUser('GUARDIAN', 'E2E동수미응답');
    for (const g of [first, second, silent]) connect(g.id, ward.id);
    const wl = await loginUser(ward);
    // 동수 안내는 "지금 등록된 카메라"의 상황에만 간다 - 카메라 1대를 잠깐 등록한다(끝나면 지움)
    expect(await waitForCameraSlots(1), '카메라 상한(서비스 전체 3대)에 10분 안에 자리가 나지 않았다').toBe(true);
    const camera = await registerCamera(wl.api);
    trackCameraP1a(wl.api, camera.id, camera.sessionId);
    const incidentId = seedIncident({ wardId: ward.id, sessionId: camera.sessionId });
    const f = await loginUser(first);
    const s = await loginUser(second);

    const t0 = new Date().toISOString();
    expect((await feedback(f.api, incidentId, 'REAL')).json.data?.reviewStatus).toBe('REAL');
    const tie = await feedback(s.api, incidentId, 'FALSE_ALARM');
    expect(tie.status).toBe(200);
    expect(tie.json.data, '1:1 은 CONFLICTED 로 돌아오고 내 응답은 저장된다').toMatchObject({ reviewStatus: 'CONFLICTED', myVerdict: 'FALSE_ALARM' });
    expect(incidentRow(incidentId)?.review).toBe('CONFLICTED');
    // 방금 답한 본인은 "보내지 않음(sent=false)"으로 먼저 기록된다
    expect(psqlRows(`SELECT guardian_id, sent FROM anomaly_review_conflict_log WHERE incident_id = ${incidentId} ORDER BY guardian_id;`), '응답 직후 안내 기록: 나중에 답한 사람은 sent=f').toEqual([[second.id, 'f']]);

    const notices = () =>
      psqlRows(`SELECT recipient_id, title, replace(body, E'\\n', ' ') FROM notification_log
                WHERE ward_id = ${sqlStr(ward.id)} AND type = 'ANOMALY_REVIEW_CONFLICTED' AND created_at >= ${sqlStr(t0)}::timestamptz ORDER BY id;`);
    const night = kstHour() >= 22 || kstHour() < 8;
    if (night) {
      // 밤(22~08시 KST)에는 아침으로 미룬다 - 스케줄러가 두 번 돌 시간(6분) 동안 안내가 없어야 한다
      await sleep(6 * 60_000);
      expect(notices(), '밤에는 동수 안내를 미룬다').toEqual([]);
      expect(psqlRows(`SELECT count(*) FROM anomaly_review_conflict_log WHERE incident_id = ${incidentId} AND sent;`)[0][0], '밤에는 안내 선점도 없다').toBe('0');
      test.info().annotations.push({ type: '부분 확인', description: '지금이 22~08시(KST)라 "아침으로 미룸"만 확인했다. 핵심(먼저 답한 보호자에게 안내 1회)은 확인하지 못했다 - 낮(08~22시 KST)에 다시 돌려야 한다. 이 결과를 통과로 보고하지 않는다' });
      return;
    }
    // 낮: 스케줄러(5분 주기)가 먼저 답한 보호자에게 1회 보낸다
    await expect
      .poll(() => notices().length, { timeout: 8 * 60_000, intervals: [10_000], message: '8분 안에 동수 재확인 안내가 기록되지 않았다' })
      .toBeGreaterThan(0);
    const rows = notices();
    expect(rows.map(r => r[0]), '먼저 답한 보호자에게만 1회').toEqual([first.id]);
    expect(rows[0][2], '문구').toContain('다른 보호자와 판정이 다릅니다');
    expect(rows[0][2], '문구').toContain('다시 확인해 주세요');
    for (const secret of [second.name, '오탐', '실제 위험', 'REAL', 'FALSE_ALARM']) {
      expect(`${rows[0][1]} ${rows[0][2]}`, `문구에 누가 뭐라 했는지 드러나면 안 된다(${secret})`).not.toContain(secret);
    }
    expect(rows.filter(r => r[0] === second.id || r[0] === silent.id), '방금 답한 본인·미응답 보호자는 안내를 받지 않는다').toEqual([]);
    expect(psqlRows(`SELECT guardian_id, sent FROM anomaly_review_conflict_log WHERE incident_id = ${incidentId} ORDER BY guardian_id;`).sort()).toEqual([[first.id, 't'], [second.id, 'f']].sort());
    // 다음 스케줄러 주기가 지나도 더 보내지 않는다(상황당 보호자당 1회)
    await sleep(5.5 * 60_000);
    expect(notices().length, '안내는 1번뿐').toBe(1);
  });
});
