/**
 * 최종 QA - 카메라·이상감지(CAM) P1b 묶음 전용 도우미.
 *
 * - 임시 사용자만 쓴다(mkUser). 끝나면 cleanupAll() 이 카메라·AI 세션·임시 사용자·내 서버 파일을 지운다.
 *   사용자를 지우면 이상감지 상황·판정·클립 행·카메라 행·알림 기록은 DB 외래키(ON DELETE CASCADE)로 함께 사라진다.
 * - DB 직접 접근은 임시 사용자 자신의 행·키만 다룬다(시드 INSERT 도 임시 피보호자 id 로만). 서비스 전체 목록은 훑지 않는다.
 * - 로그인 속도 제한은 relaxAuthRates(이 PC IP 키만 지움)로 푼다. 전체 키를 패턴으로 지우지 않는다.
 * - 카메라 상한(서비스 전체 3대)은 공용 값이다. 카메라가 필요한 테스트는 남은 자리가 생길 때까지 기다린다(waitForCameraSlots).
 * - 비밀번호·토큰·전화번호는 메시지·annotation 에 찍지 않는다.
 */
import { APIRequestContext, request } from '@playwright/test';

import { Api, ApiError, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { suppressAnomalySmsFallback } from '../../../src/fire';
import { expect } from '../../../src/fixtures';
import { countBackendLog, psqlRows, redis, sqlStr } from '../../../src/remote';
import { createTempUser, deleteTempUser, TempUser } from '../../../src/seed';
import { relaxAuthRates } from '../auth/_helpers-auth';
import {
  Camera,
  createAiSession,
  errOf,
  fireJpeg,
  Incident,
  plainJpeg,
  postFrame,
  sleep,
  stopAiSession,
  totalCameras,
  wardProxy,
} from './_helpers-cam';

export { errOf, fireJpeg, plainJpeg, postFrame, sleep, stopAiSession, wardProxy, createAiSession, suppressAnomalySmsFallback, totalCameras };
export type { Camera, Incident };

export const TAGS = { tag: ['@P1', '@CAM'] };

/** 이 묶음이 만든 가짜 세션 이름(카메라가 없는 세션 = 삭제된 카메라의 상황과 같게 취급된다) */
export const fakeSession = () => `e2e-p1b-${Math.random().toString(36).slice(2, 10)}`;

// ------------------------------------------------------------------------------------------------
// 임시 사용자·로그인·정리
// ------------------------------------------------------------------------------------------------

const users: TempUser[] = [];
const apis: Api[] = [];
const ctxs: APIRequestContext[] = [];
const cameras: { api: Api; id: number; sessionId: string; proxy?: APIRequestContext }[] = [];
const ownRedisKeys: string[] = [];
const pumps: (() => Promise<void>)[] = [];

export function mkUser(role: TempUser['role'], name?: string): TempUser {
  // 서버가 바쁠 때(ssh 시간 초과) 임시 사용자 만들기를 몇 번 더 시도한다. 반쯤 만들어진 사용자는 이름 형식이 같아 다음 정리에 지워진다
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const user = createTempUser(role, name ? { name } : undefined);
      users.push(user);
      return user;
    } catch (error) {
      last = error;
    }
  }
  throw last;
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
      await relaxAuthRates().catch(() => undefined);
      await sleep(Math.min(5_000 * i, 20_000));
    }
  }
  throw new Error(`임시 사용자 로그인 실패: ${last instanceof ApiError ? `상태 ${last.status}` : String(last).slice(0, 80)}`);
}

export async function proxyFor(login: LoginResult): Promise<APIRequestContext> {
  const proxy = await wardProxy(login);
  ctxs.push(proxy);
  return proxy;
}

/** 이 임시 사용자 토큰으로 BE 를 직접 부르는 클라이언트(헤더를 직접 다룰 때) */
export async function authedCtx(login: LoginResult): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${login.accessToken}` } });
  ctxs.push(ctx);
  return ctx;
}

/** 내 임시 사용자 자신의 Redis 키(정확한 이름만, 패턴 금지) */
export function trackOwnRedisKey(key: string) {
  ownRedisKeys.push(key);
}

export function trackCamera(api: Api, id: number, sessionId: string, proxy?: APIRequestContext) {
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
  for (const ctx of ctxs.splice(0)) await ctx.dispose().catch(() => undefined);
  for (const api of apis.splice(0)) await api.dispose().catch(() => undefined);
  const keys = ownRedisKeys.splice(0);
  for (const user of users.splice(0).reverse()) {
    try {
      // 내 임시 사용자 id 가 들어간 정확한 키 두 개만 지운다(패턴 삭제 안 씀)
      redis('DEL', `notify:sms-fallback:ANOMALY_DETECTED:${user.id}`);
      redis('DEL', `notify:sms-fallback:ANOMALY_DETECTED_SELF:${user.id}`);
    } catch (error) {
      console.warn(`임시 사용자 ${user.id} 의 Redis 키 정리 실패(만료로 사라짐):`, String(error).slice(0, 100));
    }
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

/**
 * 보호자-피보호자 ACTIVE 연결을 만든다. 연결 시각을 10일 앞으로 당겨, 시드한 상황(최대 4일 전)이
 * "연결 이전 상황"(이력·판정·재촉에서 숨겨지는 상황)으로 취급되지 않게 한다. 연결 행은 이 임시 사용자들의 것이다.
 */
export function connect(guardianId: string, wardId: string) {
  psqlRows(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
            VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'ACTIVE', ${sqlStr(guardianId)}, now() - interval '10 days', '기타') RETURNING id;`);
}

// ------------------------------------------------------------------------------------------------
// 카메라
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

export interface RegisterResult {
  status: number;
  code?: string;
  camera?: Camera & { recommendedFps?: number; createdAt?: string };
}

/** 카메라 등록 요청 1번(재시도 없음). 상태·에러 코드·성공 시 카메라를 돌려준다 */
export async function tryRegister(api: Api, body: { label: string; deviceId?: string }): Promise<RegisterResult> {
  const res = await api.raw('POST', '/api/ward/camera', body);
  const text = await res.text();
  let json: { code?: string; data?: Camera } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* JSON 아님 */
  }
  return { status: res.status(), code: json.code, camera: res.status() === 200 ? (json.data as RegisterResult['camera']) : undefined };
}

/** 등록하되 서비스 전체 상한(CAMERA_LIMIT_REACHED)이면 잠시 기다렸다 다시 한다. 그 밖의 실패는 그대로 돌려준다 */
export async function registerCameraRetry(api: Api, body: { label: string; deviceId?: string }, maxWaitMs = 600_000, proxy?: APIRequestContext): Promise<RegisterResult> {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const r = await tryRegister(api, body);
    if (r.status === 409 && r.code === 'CAMERA_LIMIT_REACHED' && Date.now() < deadline) {
      await sleep(15_000);
      continue;
    }
    if (r.camera) trackCamera(api, r.camera.id, r.camera.sessionId, proxy);
    return r;
  }
}

/** 등록 성공을 단언하고 카메라를 돌려준다(정리 목록에 올림) */
export async function registerOk(api: Api, label: string, deviceId?: string, proxy?: APIRequestContext): Promise<Camera & { recommendedFps?: number }> {
  const r = await registerCameraRetry(api, { label, deviceId }, 600_000, proxy);
  expect(r.status, `카메라 등록(${label}) 실제 ${r.status} ${r.code ?? ''}`).toBe(200);
  return r.camera!;
}

export async function deleteCamera(api: Api, id: number) {
  const res = await api.raw('DELETE', `/api/ward/camera/${id}`);
  return res.status();
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
export async function setupStreamingCamera(wardApi: Api, proxy: APIRequestContext, jpeg: Buffer, label: string): Promise<Camera> {
  const camera = await registerOk(wardApi, label, undefined, proxy);
  expect((await createAiSession(proxy, camera.sessionId, camera.deviceId)).status(), 'AI 세션 생성(FE 프록시)').toBe(200);
  expect((await postFrame(proxy, camera.sessionId, jpeg)).status(), '첫 프레임').toBe(200);
  const t0 = Date.now();
  const again = await tryRegister(wardApi, { label, deviceId: camera.deviceId });
  expect(again.status, '같은 기기 재등록').toBe(200);
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
  /** 상황 시작: 지금으로부터 몇 분 전(기본 lastAgoMin) */
  startedAgoMin?: number;
  /** 마지막 감지: 지금으로부터 몇 분 전(기본 0) */
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

/** 시작 시각을 정확한 시각(ISO)으로 박아 시드한다 - 같은 시작 시각인 상황끼리 id 순서를 볼 때 쓴다 */
export function seedIncidentAt(o: Omit<SeedIncident, 'startedAgoMin' | 'lastAgoMin'> & { startedAtIso: string }): number {
  const rows = psqlRows(`INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status, created_at, updated_at)
    VALUES (${sqlStr(o.wardId)}, ${sqlStr(o.sessionId)}, ${sqlStr(o.type ?? 'FIRE')}, ${sqlStr(o.startedAtIso)}::timestamptz, ${sqlStr(o.startedAtIso)}::timestamptz, ${o.eventCount ?? 1}, 0.9, ${sqlStr(o.review ?? 'PENDING')}, now(), now()) RETURNING id;`);
  return Number(rows[0][0]);
}

export interface SeedClip {
  incidentId: number;
  wardId: string;
  sessionId: string;
  fileName?: string;
  status?: 'VISIBLE' | 'HIDDEN';
  createdAgoMin?: number;
  sizeBytes?: number;
}

let clipSeq = 0;
export function seedClip(o: SeedClip): number {
  clipSeq++;
  const name = o.fileName ?? `e2e-p1b-${Date.now().toString(36)}-${clipSeq}.webm`;
  const created = ago(o.createdAgoMin ?? 1);
  const rows = psqlRows(`INSERT INTO anomaly_clip (incident_id, ward_id, session_id, file_name, size_bytes, duration_ms, frame_count, width, height, clip_started_at, detected_at, status, hidden_at, created_at, updated_at)
    VALUES (${o.incidentId}, ${sqlStr(o.wardId)}, ${sqlStr(o.sessionId)}, ${sqlStr(name)}, ${o.sizeBytes ?? 1_900_000}, 5000, 50, 1280, 720, ${created}, ${created}, ${sqlStr(o.status ?? 'VISIBLE')},
    ${o.status === 'HIDDEN' ? 'now()' : 'NULL'}, ${created}, ${created}) RETURNING id;`);
  return Number(rows[0][0]);
}

export function incidentRow(id: number) {
  const r = psqlRows(`SELECT review_status, event_count FROM anomaly_incident WHERE id = ${id};`)[0];
  return r ? { review: r[0], eventCount: Number(r[1]) } : undefined;
}

/** 지금 KST 시각(시) - 재촉·동수 안내는 밤(22~08시)에는 아침으로 미룬다. 서버 시각이 아니라 이 PC 시각(같은 시간대 기준) */
export function kstHour(): number {
  return Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;
}

export async function feedback(api: Api, incidentId: number, verdict: string) {
  const res = await api.raw('POST', `/api/guardian/anomaly/${incidentId}/feedback`, { verdict });
  return { status: res.status(), json: (await res.json().catch(() => ({}))) as { data?: { reviewStatus?: string; myVerdict?: string; incidentId?: number }; code?: string } };
}

export interface HistoryItem {
  incidentId: number;
  wardId: string;
  cameraLabel: string | null;
  detectedType: string;
  reviewStatus: string;
  myVerdict: string | null;
  eventCount: number;
  clip?: { clipId: number } | null;
  clipCount?: number;
}

export interface HistoryPage {
  content: HistoryItem[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
}

/** 보호자 이력 호출(쿼리는 이름·값 그대로 이어 붙인다). 상태와 본문을 함께 돌려준다 */
export async function history(api: Api, query: string) {
  const res = await api.raw('GET', `/api/guardian/anomaly/history${query ? `?${query}` : ''}`);
  const text = await res.text();
  let json: { data?: HistoryPage; code?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* JSON 아님 */
  }
  return { status: res.status(), page: json.data, code: json.code };
}

export interface HistorySummary {
  total: number;
  pendingCount: number;
  conflictedCount: number;
  needsReviewCount: number;
  byType: { fire: number; fall: number; weapon: number };
  deletedCameraCount: number;
}

export async function summary(api: Api, query = '') {
  const res = await api.raw('GET', `/api/guardian/anomaly/history/summary${query ? `?${query}` : ''}`);
  const json = (await res.json().catch(() => ({}))) as { data?: HistorySummary; code?: string };
  return { status: res.status(), data: json.data, code: json.code };
}

/** 이 임시 피보호자의 상황 id 들 */
export function incidentIdsOfWard(wardId: string): number[] {
  return psqlRows(`SELECT id FROM anomaly_incident WHERE ward_id = ${sqlStr(wardId)} ORDER BY id;`).map(r => Number(r[0]));
}

/** 읽기 전용 조회가 서버 연결 지연(ssh 시간 초과)으로 실패하면 몇 번 더 시도한다 - 오래 도는 케이스가 일시적인 연결 문제로 죽지 않게 */
export function rowsRetry(sql: string, attempts = 3): string[][] {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return psqlRows(sql);
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

/** 조건이 참이 될 때까지 기다린다(고정 sleep 대신). 시간 안에 안 되면 false */
export async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs: number, intervalMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}
