/**
 * 최종 QA - 카메라·이상감지(CAM) P0 - 꺼 둔 카메라의 감지(N19)와 클립 열람 권한(A36)
 *
 * 임시 피보호자 1명 + 보호자 1명으로 화재 신호를 한 번 만들어 두 케이스가 나눠 쓴다(카메라 1대, 끝나면 지움).
 * 임시 보호자에게는 FCM 토큰이 없어 문자 대체 발송을 상한 키로 막아 둔다(src/fire.ts suppressAnomalySmsFallback).
 */
import { request } from '@playwright/test';

import { Api } from '../../../src/api';
import { env } from '../../../src/env';
import { suppressAnomalySmsFallback } from '../../../src/fire';
import { expect, test } from '../../../src/fixtures';
import { countBackendLog, psqlRows, sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import {
  Camera,
  disposeFireRun,
  errOf,
  expectErr,
  fireJpeg,
  freeRoom,
  Incident,
  loginApi,
  newTempUser,
  releaseFireCamera,
  setupSubscribedCamera,
  streamFireUntilIncident,
  wardProxy,
} from './_helpers-cam';

const TAGS = { tag: ['@P0', '@CAM'] };
// 카메라 상한(서비스 전체 3대)은 공용 값이다. 시작할 때 자리를 확인하고(setupSubscribedCamera) 없으면 건너뛴다. 다른 영역과 동시에 돌리지 않는다.
test.describe.configure({ mode: 'serial' });

interface Inactive {
  wardId: string;
  wardApi: Api;
  guardianId: string;
  guardianApi: Api;
  camera: Camera;
  incident: Incident;
  startedAt: string;
  statusAfter: { status: number; code?: string };
  listed: number;
  liveListed: number;
}
let state: Promise<Inactive> | undefined;

async function build(): Promise<Inactive> {
  const ward = newTempUser('WARD', { name: 'E2E꺼진카메라' });
  const guardian = newTempUser('GUARDIAN', { name: 'E2E꺼진카메라보호자' });
  connect(guardian.id, ward.id);
  suppressAnomalySmsFallback(ward.id);
  const w = await loginApi(ward);
  const g = await loginApi(guardian);
  const proxy = await wardProxy(w.login);
  const label = await freeRoom(w.api);
  const startedAt = new Date().toISOString();
  const { camera } = await setupSubscribedCamera(w.api, proxy, label);
  // 감시가 붙은 뒤에 카메라를 끈다(보호자 화면에서만 숨겨질 뿐 감지·알림은 계속되어야 한다)
  expect((await w.api.raw('PATCH', `/api/ward/camera/${camera.id}`, { isActive: false })).status(), '준비: 카메라 끄기').toBe(200);
  const incident = await streamFireUntilIncident(proxy, camera.sessionId, g.api, ward.id, label, 'FIRE', 90_000);
  if (!incident) throw new Error('꺼 둔 카메라의 화재 신호가 90초 안에 이상감지 상황이 되지 않았다');
  await new Promise(r => setTimeout(r, 4_000));
  const status = await errOf(await g.api.raw('GET', `/api/guardian/camera/${camera.sessionId}/status`));
  const listed = (await g.api.get<unknown[]>('/api/guardian/camera')).length;
  const liveListed = (await g.api.get<unknown[]>('/api/guardian/camera/live')).length;
  await releaseFireCamera().catch(() => undefined);
  await proxy.dispose();
  return {
    wardId: ward.id, wardApi: w.api, guardianId: guardian.id, guardianApi: g.api,
    camera, incident, startedAt, statusAfter: { status: status.status, code: status.code }, listed, liveListed,
  };
}

test.afterAll(async () => {
  await disposeFireRun();
});

test.describe('카메라·이상감지 P0 - 꺼 둔 카메라와 클립 권한', () => {
  test('CAM-N19 꺼 둔(is_active=false) 카메라도 감지·알림은 계속', TAGS, async () => {
    test.setTimeout(480_000);
    state ??= build();
    const s = await state;
    expect(s.incident.detectedType, '꺼 둔 카메라의 화재 신호도 이력이 생긴다').toBe('FIRE');
    expect(s.incident.reviewStatus).toBe('PENDING');
    expect(Number(psqlRows(`SELECT count(*) FROM anomaly_event WHERE ward_id = ${sqlStr(s.wardId)} AND detected_type = 'FIRE';`)[0][0])).toBeGreaterThanOrEqual(1);
    // 알림 기록: 보호자 + 본인
    const rows = psqlRows(`SELECT recipient_id, type FROM notification_log WHERE ward_id = ${sqlStr(s.wardId)} AND type LIKE 'ANOMALY_DETECTED%'
                           AND created_at >= ${sqlStr(s.startedAt)}::timestamptz;`).map(r => `${r[0]}:${r[1]}`);
    // (전달되지 않은 수신자는 쿨다운이 풀려 재감지 때 줄이 더 생길 수 있어 수신자·종류의 조합으로 본다)
    expect([...new Set(rows)].sort()).toEqual([`${s.guardianId}:ANOMALY_DETECTED`, `${s.wardId}:ANOMALY_DETECTED_SELF`].sort());
    // 실시간 보기 대상은 아니다
    expect(s.statusAfter.status, `꺼진 카메라 상태 조회 ${s.statusAfter.code ?? ''}`).toBe(404);
    expect(s.statusAfter.code).toBe('CAMERA_NOT_FOUND');
    expect(s.listed, '보호자 카메라 목록에서 빠진다').toBe(0);
    expect(s.liveListed, '보호자 live 목록에서 빠진다').toBe(0);
  });

  test('CAM-A36 클립 열람 권한: 비연결 보호자·남의 클립·보호자 0명', TAGS, async () => {
    test.setTimeout(480_000);
    state ??= build();
    const s = await state;
    const incidentId = s.incident.incidentId;

    // 클립 id 가 있으면 그 파일 경로를 본다(클립 생성은 AI 서버 사정에 따라 없을 수 있다).
    // 없으면 "파일 권한 미확인"을 남기고, 없는 clipId 로 권한 검사가 상태 코드상 먼저 나오는지라도 확인한다.
    const clips = await s.guardianApi.get<{ clipId: number }[]>(`/api/guardian/anomaly/${incidentId}/clips`);
    const realClipId = clips[0]?.clipId;
    const clipId = realClipId ?? 999_999_999;
    // 실제 클립이면 권한 오류(403)여야 한다. 없는 번호면 BE 가 존재 확인(404 ANOMALY_CLIP_NOT_FOUND)을 권한 확인보다 먼저 하므로 그 응답을 기대한다
    const expectFile = (err: Awaited<ReturnType<typeof errOf>>, code403: string, label: string) =>
      realClipId ? expectErr(err, 403, code403, label) : expectErr(err, 404, 'ANOMALY_CLIP_NOT_FOUND', label);
    test.info().annotations.push({
      type: realClipId ? '클립' : '파일 권한 미확인',
      description: realClipId ? `있음(${clips.length}건)` : '클립이 생기지 않아 실제 클립 파일의 권한은 확인하지 못했다 - 없는 clipId(999999999)로 권한 응답만 확인',
    });

    // 1) 비연결 보호자: 403 ANOMALY_NOT_AUTHORIZED + [IDOR-ATTEMPT]
    const strangerUser = newTempUser('GUARDIAN');
    const stranger = await loginApi(strangerUser);
    expectErr(await errOf(await stranger.api.raw('GET', `/api/guardian/anomaly/${incidentId}/clips`)), 403, 'ANOMALY_NOT_AUTHORIZED', '비연결 보호자 클립 목록');
    expectFile(await errOf(await stranger.api.raw('GET', `/api/guardian/anomaly/clips/${clipId}/file`)), 'ANOMALY_NOT_AUTHORIZED', `비연결 보호자 클립 파일(${realClipId ? '실제' : '없는 번호'})`);
    await expect.poll(() => countBackendLog(`연결되지 않은 피보호자 이상감지 영상 접근 시도: guardianId=${strangerUser.id}`), { timeout: 20_000 }).toBeGreaterThan(0);

    // 2) 남의 클립: 다른 피보호자가 이 집의 클립을 요청 -> 403 ANOMALY_CLIP_NOT_OWNED + [IDOR-ATTEMPT]
    const otherWardUser = newTempUser('WARD');
    const otherWard = await loginApi(otherWardUser);
    expectErr(await errOf(await otherWard.api.raw('GET', `/api/ward/anomaly/${incidentId}/clips`)), 403, 'ANOMALY_CLIP_NOT_OWNED', '남의 클립 목록');
    expectFile(await errOf(await otherWard.api.raw('GET', `/api/ward/anomaly/clips/${clipId}/file`)), 'ANOMALY_CLIP_NOT_OWNED', `남의 클립 파일(${realClipId ? '실제' : '없는 번호'})`);
    await expect.poll(() => countBackendLog(`다른 피보호자 이상감지 영상 접근 시도: wardId=${otherWardUser.id}`), { timeout: 20_000 }).toBeGreaterThan(0);

    // 3) 로그인 없이는 401
    const anon = await request.newContext({ baseURL: env.apiUrl });
    try {
      expect((await anon.get(`/api/guardian/anomaly/${incidentId}/clips`)).status()).toBe(401);
      expect((await anon.get(`/api/ward/anomaly/${incidentId}/clips`)).status()).toBe(401);
    } finally {
      await anon.dispose();
    }

    // 4) 보호자 0명인 피보호자가 본인 클립 요청 -> 404 (연결된 동안은 200)
    expect((await s.wardApi.raw('GET', `/api/ward/anomaly/${incidentId}/clips`)).status(), '보호자가 있을 때 본인 클립 목록').toBe(200);
    const connId = psqlRows(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(s.guardianId)} AND ward_id = ${sqlStr(s.wardId)} AND status = 'ACTIVE';`)[0][0];
    expect((await s.wardApi.raw('DELETE', `/api/ward/connection/disconnection/${connId}`)).status(), '준비: 보호자 연결 해제').toBe(200);
    const none = await errOf(await s.wardApi.raw('GET', `/api/ward/anomaly/${incidentId}/clips`));
    expect(none.status, `보호자 0명 본인 클립 목록 ${none.code ?? ''}`).toBe(404);
    expect((await errOf(await s.wardApi.raw('GET', `/api/ward/anomaly/clips/${clipId}/file`))).status, `보호자 0명 본인 클립 파일(${realClipId ? '실제' : '없는 번호'})`).toBe(404);
    void fireJpeg;
  });
});
