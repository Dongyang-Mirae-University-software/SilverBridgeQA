/**
 * 최종 QA - 카메라·이상감지(CAM) P1a 묶음 전용 도우미.
 *
 * - 임시 사용자만 쓴다(mkUser). 끝나면 cleanupAll() 이 카메라·AI 세션·임시 사용자를 지운다.
 *   사용자를 지우면 이상감지 상황·판정·클립 행·카메라 행·알림 기록은 DB 외래키(ON DELETE CASCADE)로 함께 사라진다.
 * - DB 직접 접근은 임시 사용자 자신의 행·키만 다룬다(시드 INSERT 도 임시 피보호자 id 로만).
 * - 로그인 속도 제한은 relaxAuthRates(이 PC IP 키만 지움)로 푼다. 전체 키를 패턴으로 지우지 않는다.
 * - 카메라 상한(서비스 전체 3대)은 공용 값이다. 카메라가 필요한 테스트는 남은 자리가 생길 때까지 기다린다(waitForCameraSlots).
 * - 비밀번호·토큰·전화번호는 메시지·annotation 에 찍지 않는다.
 */
import { APIRequestContext, request } from '@playwright/test';

import { Api, ApiError, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { suppressAnomalySmsFallback as rawSuppressSms } from '../../../src/fire';
import { expect } from '../../../src/fixtures';
import { countBackendLog, psqlRows, redis, remoteBash, sqlStr } from '../../../src/remote';
import { createTempUser, deleteTempUser, TempUser } from '../../../src/seed';
import { connect as rawConnect } from '../../../src/variables';
import { relaxAuthRates } from '../auth/_helpers-auth';
import {
  Camera,
  createAiSession,
  errOf,
  fireJpeg,
  freeRoom,
  Incident,
  plainJpeg,
  pollIncident,
  postFrame,
  sleep,
  stopAiSession,
  totalCameras,
  wardProxy,
} from './_helpers-cam';

export { errOf, fireJpeg, plainJpeg, postFrame, sleep, stopAiSession, wardProxy, createAiSession };

/**
 * 이상감지 문자 대체 발송을 막는 상한 키를 만든다(임시 피보호자와 그 연결 보호자 것만).
 * 만든 키 이름(ANOMALY_DETECTED·ANOMALY_DETECTED_SELF x 수신자 id)을 정확히 정리 목록에 올린다.
 */
export function suppressAnomalySmsFallback(wardId: string, seconds = 3600): string[] {
  const recipients = rawSuppressSms(wardId, seconds);
  for (const id of recipients) {
    for (const type of ['ANOMALY_DETECTED', 'ANOMALY_DETECTED_SELF']) trackOwnRedisKey(`notify:sms-fallback:${type}:${id}`);
  }
  return recipients;
}
export type { Camera, Incident };

/**
 * 보호자-피보호자 ACTIVE 연결을 만든다. 연결 시각을 3일 앞으로 당겨, 시드한 상황이 "연결 이전 상황"(이력·판정·클립에서
 * 숨겨지는 상황)으로 취급되지 않게 한다. 연결 행은 이 임시 사용자들의 것이다.
 */
export function connect(guardianId: string, wardId: string) {
  rawConnect(guardianId, wardId);
  psqlRows(`UPDATE connection SET connected_at = now() - interval '3 days' WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} RETURNING id;`);
}

export const TAGS = { tag: ['@P1', '@CAM'] };

// ------------------------------------------------------------------------------------------------
// 임시 사용자·로그인·정리
// ------------------------------------------------------------------------------------------------

const users: TempUser[] = [];
const apis: Api[] = [];
const proxies: APIRequestContext[] = [];
const cameras: { api: Api; id: number; sessionId: string; proxy?: APIRequestContext }[] = [];
const ownRedisKeys: string[] = [];
const pumps: (() => Promise<void>)[] = [];

export function mkUser(role: TempUser['role'], name?: string): TempUser {
  const user = createTempUser(role, name ? { name } : undefined);
  users.push(user);
  return user;
}

export interface Logged {
  user: TempUser;
  api: Api;
  login: LoginResult;
}

/** 로그인(IP 속도 제한 429 는 이 PC 키만 지우고 다시 시도) */
export async function loginUser(user: TempUser): Promise<Logged> {
  let last: unknown;
  for (let i = 1; i <= 14; i++) {
    try {
      const login = await Api.signin(user.email, user.password);
      const api = await Api.fromLogin(login);
      apis.push(api);
      return { user, api, login };
    } catch (error) {
      last = error;
      if (!(error instanceof ApiError) || error.status !== 429) break;
      // 이 PC 의 IP 키만 지운다. 다른 에이전트가 동시에 로그인해 키가 하나로 안 좁혀지면 지우지 못하고 기다렸다 다시 한다(분당 10회 창)
      await relaxAuthRates().catch(() => undefined);
      await sleep(Math.min(5_000 * i, 20_000));
    }
  }
  throw new Error(`임시 사용자 로그인 실패: ${last instanceof ApiError ? `상태 ${last.status}` : String(last).slice(0, 80)}`);
}

export async function proxyFor(login: LoginResult): Promise<APIRequestContext> {
  const proxy = await wardProxy(login);
  proxies.push(proxy);
  return proxy;
}

/** 내 임시 사용자 자신의 Redis 키를 정리 목록에 올린다(정확한 키 이름만, 패턴 금지) */
export function trackOwnRedisKey(key: string) {
  ownRedisKeys.push(key);
}

export function trackCameraP1a(api: Api, id: number, sessionId: string, proxy?: APIRequestContext) {
  cameras.push({ api, id, sessionId, proxy });
}

export function trackPump(stop: () => Promise<void>) {
  pumps.push(stop);
}

/** 이 묶음이 만든 모든 것을 지운다(여러 번 불러도 안전) */
export async function cleanupAll() {
  for (const stop of pumps.splice(0)) await stop().catch(() => undefined);
  for (const cam of cameras.splice(0)) {
    if (cam.proxy) await stopAiSession(cam.proxy, cam.sessionId);
    await cam.api.raw('DELETE', `/api/ward/camera/${cam.id}`).catch(() => undefined);
  }
  for (const proxy of proxies.splice(0)) await proxy.dispose().catch(() => undefined);
  for (const api of apis.splice(0)) await api.dispose().catch(() => undefined);
  const keys = ownRedisKeys.splice(0);
  for (const user of users.splice(0).reverse()) {
    try {
      deleteTempUser(user.id);
    } catch (error) {
      console.warn(`임시 사용자 ${user.id} 정리 실패(다음 전체 실행 때 정리됨):`, String(error).slice(0, 100));
    }
  }
  for (const key of keys) {
    try {
      redis('DEL', key);
    } catch (error) {
      console.warn('내 Redis 키 정리 실패(만료로 사라짐):', String(error).slice(0, 100));
    }
  }
}

// ------------------------------------------------------------------------------------------------
// 카메라 자리
// ------------------------------------------------------------------------------------------------

/** 서비스 전체 카메라 상한(3대)에 need 자리가 생길 때까지 기다린다. 끝내 모자라면 false */
export async function waitForCameraSlots(need: number, timeoutMs = 600_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (totalCameras() + need <= 3) return true;
    if (Date.now() > deadline) return false;
    await sleep(15_000);
  }
}

/** 카메라 등록. 409(상한)면 잠시 기다렸다 다시 한다 */
export async function registerCamera(wardApi: Api, label?: string): Promise<Camera> {
  for (let attempt = 1; ; attempt++) {
    const room = label ?? (await freeRoom(wardApi));
    const res = await wardApi.raw('POST', '/api/ward/camera', { label: room });
    const text = await res.text();
    if (res.status() === 409 && attempt < 12) {
      await sleep(15_000);
      continue;
    }
    expect(res.status(), '카메라 등록 상태').toBe(200);
    return { ...(JSON.parse(text) as { data: Camera }).data, label: room };
  }
}

// ------------------------------------------------------------------------------------------------
// 영상 전송
// ------------------------------------------------------------------------------------------------

/** 같은 사진을 이어서 보낸다. 멈추는 함수를 돌려준다(cleanupAll 이 빠뜨린 펌프도 멈춘다) */
export function startPump(proxy: APIRequestContext, sessionId: string, jpeg: Buffer, intervalMs = 300) {
  let stop = false;
  let failures = 0;
  const task = (async () => {
    while (!stop) {
      const res = await postFrame(proxy, sessionId, jpeg).catch(() => undefined);
      if (!res || res.status() !== 200) failures++;
      await sleep(intervalMs);
    }
  })();
  const stopFn = async () => {
    stop = true;
    await task;
  };
  trackPump(stopFn);
  return { stop: stopFn, failures: () => failures };
}

/** 카메라 등록 -> AI 세션 + 프레임 -> BE 가 세션을 구독할 때까지(같은 기기 재등록으로 이벤트를 다시 낸다) */
export async function setupStreamingCamera(wardApi: Api, proxy: APIRequestContext, jpeg: Buffer, label?: string): Promise<Camera> {
  const camera = await registerCamera(wardApi, label);
  trackCameraP1a(wardApi, camera.id, camera.sessionId, proxy);
  expect((await createAiSession(proxy, camera.sessionId, camera.deviceId)).status(), 'AI 세션 생성(FE 프록시)').toBe(200);
  expect((await postFrame(proxy, camera.sessionId, jpeg)).status(), '첫 프레임').toBe(200);
  const t0 = Date.now();
  await wardApi.post<Camera>('/api/ward/camera', { label: camera.label, deviceId: camera.deviceId });
  let subscribed = false;
  while (Date.now() - t0 < 70_000) {
    if (countBackendLog(`세션 구독: sessionId=${camera.sessionId}`, 120) > 0) {
      subscribed = true;
      break;
    }
    await sleep(2_000);
  }
  expect(subscribed, 'BE 가 새 AI 세션을 구독해야 한다').toBe(true);
  return camera;
}

// ------------------------------------------------------------------------------------------------
// DB 시드(임시 피보호자 자신의 행만)
// ------------------------------------------------------------------------------------------------

export interface SeedIncident {
  wardId: string;
  sessionId: string;
  type?: 'FIRE' | 'FALL' | 'WEAPON';
  startedAgoMin?: number;
  lastAgoMin?: number;
  eventCount?: number;
  review?: 'PENDING' | 'REAL' | 'FALSE_ALARM' | 'CONFLICTED';
}

const ago = (min: number) => `now() - interval '${Math.round(min * 60)} seconds'`;

export function seedIncident(o: SeedIncident): number {
  const rows = psqlRows(`INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status, created_at, updated_at)
    VALUES (${sqlStr(o.wardId)}, ${sqlStr(o.sessionId)}, ${sqlStr(o.type ?? 'FIRE')}, ${ago(o.startedAgoMin ?? o.lastAgoMin ?? 0)}, ${ago(o.lastAgoMin ?? 0)}, ${o.eventCount ?? 1}, 0.9, ${sqlStr(o.review ?? 'PENDING')}, now(), now()) RETURNING id;`);
  return Number(rows[0][0]);
}

export interface SeedClip {
  incidentId: number;
  wardId: string;
  sessionId: string;
  status?: 'VISIBLE' | 'HIDDEN';
  createdAgoMin?: number;
  sizeBytes?: number;
}

let clipSeq = 0;
export function seedClip(o: SeedClip): number {
  clipSeq++;
  const name = `e2e-p1a-${Date.now().toString(36)}-${clipSeq}.webm`;
  const created = ago(o.createdAgoMin ?? 1);
  const rows = psqlRows(`INSERT INTO anomaly_clip (incident_id, ward_id, session_id, file_name, size_bytes, duration_ms, frame_count, width, height, clip_started_at, detected_at, status, hidden_at, created_at, updated_at)
    VALUES (${o.incidentId}, ${sqlStr(o.wardId)}, ${sqlStr(o.sessionId)}, ${sqlStr(name)}, ${o.sizeBytes ?? 1_900_000}, 5000, 50, 1280, 720, ${created}, ${created}, ${sqlStr(o.status ?? 'VISIBLE')},
    ${o.status === 'HIDDEN' ? 'now()' : 'NULL'}, ${created}, ${created}) RETURNING id;`);
  return Number(rows[0][0]);
}

export function incidentRow(id: number) {
  const r = psqlRows(`SELECT review_status, event_count, to_char(started_at AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI'), extract(epoch from (now() - last_detected_at))::int FROM anomaly_incident WHERE id = ${id};`)[0];
  return r ? { review: r[0], eventCount: Number(r[1]), startedKst: r[2], lastAgoSec: Number(r[3]) } : undefined;
}

export function incidentIdsOfWard(wardId: string, type?: string): number[] {
  return psqlRows(`SELECT id FROM anomaly_incident WHERE ward_id = ${sqlStr(wardId)} ${type ? `AND detected_type = ${sqlStr(type)}` : ''} ORDER BY id;`).map(r => Number(r[0]));
}

export function clipRowsOf(incidentId: number) {
  return psqlRows(`SELECT id, status, size_bytes FROM anomaly_clip WHERE incident_id = ${incidentId} ORDER BY id;`).map(r => ({ id: Number(r[0]), status: r[1], sizeBytes: Number(r[2]) }));
}

/** 이 피보호자의 연결 행(임시 사용자 자신의 것) 상태를 바꾼다. 연결 해제 상황을 만들 때 쓴다 */
export function setConnections(wardId: string, status: 'ACTIVE' | 'DISCONNECTED') {
  psqlRows(`UPDATE connection SET status = ${sqlStr(status)}, updated_at = now() WHERE ward_id = ${sqlStr(wardId)} RETURNING id;`);
}

/** 서버에 저장된 클립 파일 크기(바이트). 없으면 null. 읽기만 한다(stat). 파일 이름은 UUID.webm 형식만 허용 */
export function clipFileSize(fileName: string): number | null {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webm$/.test(fileName)) throw new Error('클립 파일 이름 형식이 UUID.webm 이 아니다');
  const out = remoteBash(`docker exec ${env.apiContainer} sh -c 'stat -c %s /data/clips/${fileName} 2>/dev/null || echo NONE'\n`).trim();
  return out === 'NONE' ? null : Number(out);
}

export function clipFileNameOf(clipId: number): string {
  return psqlRows(`SELECT file_name FROM anomaly_clip WHERE id = ${clipId};`)[0][0];
}

/** 이 임시 보호자·피보호자 토큰으로 헤더를 직접 붙여 부르는 클라이언트(Range 같은 요청 헤더가 필요할 때) */
export async function authedCtx(login: LoginResult): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${login.accessToken}` } });
  proxies.push(ctx);
  return ctx;
}

/** 상황의 감지 횟수가 min 이상이 될 때까지 기다린다(감지는 1분 간격) */
export async function waitEventCount(incidentId: number, min: number, timeoutMs = 180_000) {
  await expect
    .poll(() => incidentRow(incidentId)?.eventCount ?? 0, { timeout: timeoutMs, intervals: [5_000], message: `상황 ${incidentId} 의 감지 횟수가 ${min} 이상이 되지 않았다` })
    .toBeGreaterThanOrEqual(min);
}

/** 지금 KST 시각(시) - 재촉·동수 안내는 밤(22~08시)에는 아침으로 미룬다 */
export function kstHour(): number {
  return Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;
}

// ------------------------------------------------------------------------------------------------
// 보호자 이상감지 API 짧은 호출
// ------------------------------------------------------------------------------------------------

export async function feedback(api: Api, incidentId: number, verdict: string) {
  const res = await api.raw('POST', `/api/guardian/anomaly/${incidentId}/feedback`, { verdict });
  return { status: res.status(), json: (await res.json().catch(() => ({}))) as { data?: { reviewStatus?: string; myVerdict?: string; incidentId?: number }; code?: string } };
}

export async function guardianClipList(api: Api, incidentId: number) {
  const res = await api.raw('GET', `/api/guardian/anomaly/${incidentId}/clips`);
  const json = (await res.json().catch(() => ({}))) as { data?: ClipItem[]; code?: string; message?: string };
  return { status: res.status(), items: json.data ?? [], code: json.code, message: json.message };
}

export interface ClipItem {
  clipId: number;
  incidentId: number;
  detectedAt: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  createdAt: string;
}

// ------------------------------------------------------------------------------------------------
// 실제 화재 신호 1회 + 클립(클립·판정·상황 묶기 묶음이 나눠 쓴다)
// ------------------------------------------------------------------------------------------------

export interface ClipRun {
  ward: TempUser;
  ga: TempUser;
  gb: TempUser;
  wardApi: Api;
  gaApi: Api;
  gbApi: Api;
  wardLogin: LoginResult;
  gaLogin: LoginResult;
  gbLogin: LoginResult;
  proxy: APIRequestContext;
  camera: Camera;
  incident: Incident;
  fire: ReturnType<typeof startPump>;
  startedAt: string;
  clipFirstSeenMs: number | null;
  detectionMs: number;
}

let runPromise: Promise<ClipRun> | undefined;

/** 화재 신호를 한 번 만든다(카메라 1대, 보호자 2명). 처음 부른 테스트에서만 돈다 */
export function getClipRun(): Promise<ClipRun> {
  runPromise ??= startClipRun();
  return runPromise;
}

export function resetClipRun() {
  runPromise = undefined;
}

async function startClipRun(): Promise<ClipRun> {
  const ready = await waitForCameraSlots(1);
  if (!ready) throw new Error('카메라 상한(서비스 전체 3대)에 10분 안에 자리가 나지 않았다 - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다');
  const tail = Math.random().toString(36).slice(2, 6);
  const ward = mkUser('WARD', `E2E클립본인${tail}`);
  const ga = mkUser('GUARDIAN', 'E2E클립보호자A');
  const gb = mkUser('GUARDIAN', 'E2E클립보호자B');
  connect(ga.id, ward.id);
  connect(gb.id, ward.id);
  suppressAnomalySmsFallback(ward.id);
  const w = await loginUser(ward);
  const a = await loginUser(ga);
  const b = await loginUser(gb);
  const proxy = await proxyFor(w.login);
  const jpeg = fireJpeg();
  const startedAt = new Date().toISOString();
  const camera = await setupStreamingCamera(w.api, proxy, jpeg);

  const t0 = Date.now();
  const fire = startPump(proxy, camera.sessionId, jpeg, 250);
  const incident = await pollIncident(a.api, ward.id, camera.label, 'FIRE', 120_000);
  if (!incident) throw new Error('화재 프레임을 보냈지만 120초 안에 이상감지 상황이 생기지 않았다');
  const detectionMs = Date.now() - t0;

  // 클립은 이력 적재 뒤 약 3~10초 안에 만들어진다(최대 60초까지 기다린다)
  let clipFirstSeenMs: number | null = null;
  const tClip = Date.now();
  while (Date.now() - tClip < 60_000) {
    const list = await guardianClipList(a.api, incident.incidentId);
    if (list.status === 200 && list.items.length > 0) {
      clipFirstSeenMs = Date.now() - tClip;
      break;
    }
    await sleep(2_000);
  }
  return {
    ward, ga, gb,
    wardApi: w.api, gaApi: a.api, gbApi: b.api,
    wardLogin: w.login, gaLogin: a.login, gbLogin: b.login,
    proxy, camera, incident, fire, startedAt, clipFirstSeenMs, detectionMs,
  };
}

export async function disposeClipRun() {
  await cleanupAll();
  runPromise = undefined;
}
