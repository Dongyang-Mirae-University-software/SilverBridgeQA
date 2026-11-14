/**
 * 최종 QA - 카메라·이상감지(CAM) 영역 전용 도우미.
 *
 * - AI 서버 송출은 화면(FE)과 같은 경로인 FE 프록시(/api/streams, 피보호자 로그인 쿠키 필요)로 한다. AI 서버 주소·키는 쓰지 않는다.
 * - 화재 신호 1회(`getFireRun`)를 여러 케이스가 나눠 쓴다. 서비스 전체 카메라 상한이 3대라서 한 번에 1대만 쓰고, 끝나면 바로 지운다.
 * - 임시 사용자만 쓰고 끝나면 지운다(disposeFireRun). 토큰·비밀번호·전화번호는 로그에 찍지 않는다.
 * - 서비스 전체 카메라 상한(3대)은 공용 값이다. 카메라를 만드는 CAM 테스트는 시작할 때 남은 자리를 확인하고
 *   모자라면 이유를 남기고 건너뛴다(skipUnlessCameraSlot). 다른 영역 테스트와 동시에 돌리지 않는다.
 */
import { APIRequestContext, chromium, Page, request } from '@playwright/test';

import { Api, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { fireImage, suppressAnomalySmsFallback } from '../../../src/fire';
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { countBackendLog, psqlRows, redisDelPattern, sqlStr } from '../../../src/remote';
import { createTempUser, deleteTempUser, TempUser } from '../../../src/seed';
import { connect } from '../../../src/variables';

export interface Camera {
  id: number;
  sessionId: string;
  deviceId: string;
  label: string;
  isActive?: boolean;
}

export interface Incident {
  incidentId: number;
  wardId: string;
  wardName?: string;
  cameraLabel: string | null;
  detectedType: string;
  detectedTypeLabel: string;
  eventCount: number;
  maxConfidence: number;
  reviewStatus: string;
  myVerdict: string | null;
  clip?: { clipId: number } | null;
  clipCount?: number;
}

export interface ErrBody {
  status: number;
  code?: string;
  message?: string;
  raw: string;
}

/** API 응답을 상태코드·에러코드(code)·메시지로 풀어 준다 */
export async function errOf(res: { status(): number; text(): Promise<string> }): Promise<ErrBody> {
  const raw = await res.text();
  let json: { code?: string; message?: string } = {};
  try {
    json = JSON.parse(raw);
  } catch {
    /* JSON 이 아닌 응답 */
  }
  return { status: res.status(), code: json.code, message: json.message, raw: raw.slice(0, 300) };
}

export function expectErr(err: ErrBody, status: number, code?: string, label = '') {
  const shown = `${label} 실제 ${err.status} ${err.code ?? ''} ${err.message ?? err.raw.slice(0, 80)}`;
  expect(err.status, shown).toBe(status);
  if (code) expect(err.code, shown).toBe(code);
}

export const FE_COOKIE = 'careai_access_token';

/** FE 프록시(/api/streams)를 피보호자 로그인 쿠키로 부르는 클라이언트. 쿠키 값은 어디에도 찍지 않는다 */
export async function wardProxy(login: LoginResult): Promise<APIRequestContext> {
  return request.newContext({ baseURL: env.baseUrl, extraHTTPHeaders: { Cookie: `${FE_COOKIE}=${login.accessToken}` } });
}

export async function createAiSession(proxy: APIRequestContext, sessionId: string, deviceId: string) {
  const res = await proxy.post('/api/streams/v1/stream-sessions', { data: { sessionId, cameraIdentifier: deviceId, deviceType: 'ipad' } });
  return res;
}

export async function postFrame(proxy: APIRequestContext, sessionId: string, jpeg: Buffer) {
  return proxy.post(`/api/streams/v1/stream-sessions/${sessionId}/frame`, {
    multipart: { frame: { name: 'frame.jpg', mimeType: 'image/jpeg', buffer: jpeg } },
  });
}

export async function stopAiSession(proxy: APIRequestContext, sessionId: string) {
  return proxy.post(`/api/streams/v1/stream-sessions/${sessionId}/stop`).catch(() => undefined);
}

import { readFileSync } from 'node:fs';

export function fireJpeg(): Buffer {
  return readFileSync(fireImage());
}

let plainRef: Buffer | undefined;
/** 화재·흉기가 없는 평범한 사진(회색 그라데이션). 영상 유지용 전송에 써서 재감지 알림을 막는다 */
export async function plainJpeg(): Promise<Buffer> {
  if (plainRef) return plainRef;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
    await page.setContent('<body style="margin:0;height:480px;background:linear-gradient(#cfd8dc,#78909c)"></body>');
    plainRef = await page.screenshot({ type: 'jpeg', quality: 80 });
  } finally {
    await browser.close();
  }
  return plainRef;
}

/** 서비스 전체 카메라 상한(3대)에 한 자리도 없으면 이유를 남기고 이 테스트를 건너뛴다 */
export function skipUnlessCameraSlot() {
  const total = totalCameras();
  test.skip(total >= 3, `카메라 상한 여유 없음(서비스 전체 ${total}대 / 상한 3대) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다`);
}

export async function freeRoom(api: Api): Promise<string> {
  const rooms = await api.get<{ label: string; registered: boolean }[]>('/api/ward/camera/rooms');
  const free = rooms.find(r => !r.registered);
  if (!free) throw new Error('모든 방에 카메라가 있다');
  return free.label;
}

/** 서비스 전체 등록 카메라 수 (SELECT 만) */
export function totalCameras(): number {
  return Number(psqlRows('SELECT count(*) FROM camera;')[0][0]);
}

/** 영상 주소를 열어 첫 조각만 읽고 끊는다. 에러 응답(JSON)이면 본문 전체를 읽는다. */
export async function openStreamOnce(url: string, timeoutMs = 15_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const contentType = res.headers.get('content-type') ?? '';
    if (res.status !== 200) {
      const raw = await res.text();
      let json: { code?: string; message?: string } = {};
      try {
        json = JSON.parse(raw);
      } catch {
        /* 비 JSON */
      }
      return { status: res.status, contentType, code: json.code, message: json.message, firstBytes: 0 };
    }
    const reader = res.body!.getReader();
    const first = await reader.read();
    await reader.cancel().catch(() => undefined);
    return { status: res.status, contentType, code: undefined, message: undefined, firstBytes: first.value?.length ?? 0 };
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

export function mjpegUrl(sessionId: string, ticket?: string, extra = '') {
  const q = [ticket !== undefined ? `ticket=${encodeURIComponent(ticket)}` : '', extra].filter(Boolean).join('&');
  return `${env.apiUrl}/api/camera/stream/${encodeURIComponent(sessionId)}/mjpeg${q ? `?${q}` : ''}`;
}

export async function sleep(ms: number) {
  await new Promise(r => setTimeout(r, ms));
}

/** 알림 설정 변경(채널 하나) */
export async function setChannel(api: Api, channel: 'FCM' | 'SMS' | 'KAKAO_ALIMTALK' | 'EMAIL', enabled: boolean) {
  const res = await api.raw('PUT', '/api/user/me/notification-settings', { settings: [{ channelType: channel, enabled }] });
  return res.status();
}

// ------------------------------------------------------------------------------------------------
// 화재 신호 1회 (여러 케이스가 나눠 쓴다)
// ------------------------------------------------------------------------------------------------

export interface FireRun {
  ward: TempUser;
  ga: TempUser; // 문자·알림톡 켬
  gb: TempUser; // 기본 설정(앱 푸시만)
  admin: TempUser;
  wardApi: Api;
  gaApi: Api;
  gbApi: Api;
  adminApi: Api;
  gaLogin: LoginResult;
  wardLogin: LoginResult;
  camera: Camera;
  proxy: APIRequestContext;
  startedAt: string;
  /** 재등록 전에 이미 찍힌 '세션 구독' 로그 수(AI 가 세션 생성 때 목록을 broadcast 해서 BE 가 먼저 구독한 경우 1 이상) */
  subscribedLogsBeforeReregister: number;
  /** 같은 deviceId 로 다시 등록한 뒤 BE 가 'AI 세션 목록 재요청' 로그를 새로 남기기까지(ms). 안 보이면 null */
  requeryAfterReregisterMs: number | null;
  incident: Incident;
  events: { ga: Record<string, string>[]; gb: Record<string, string>[]; ward: Record<string, string>[] };
  gaToast: { text: string; stillVisibleAfter7s: boolean } | null;
  setupNotes: string[];
}

const created: TempUser[] = [];
const apis: Api[] = [];
let proxyRef: APIRequestContext | null = null;
let cameraRef: { api: Api; id: number; sessionId: string } | null = null;
let runPromise: Promise<FireRun> | undefined;

type OpenAs = (who: { label: string; login: LoginResult }, path?: string | null) => Promise<Page>;

async function collectEvents(page: Page, userId: string) {
  await page.evaluate(id => {
    const w = window as unknown as {
      __connectionStompClient: { subscribe: (d: string, cb: (m: { body: string }) => void) => void };
      __camEvents: unknown[];
    };
    w.__camEvents = [];
    w.__connectionStompClient.subscribe(`/topic/${id}/anomaly-detected`, m => w.__camEvents.push(JSON.parse(m.body)));
  }, userId);
  return () => page.evaluate(() => (window as unknown as { __camEvents: Record<string, string>[] }).__camEvents ?? []);
}

export async function pollIncident(api: Api, wardId: string, label: string, type: string, timeoutMs: number, before = new Set<number>()) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const page = await api.get<{ content: Incident[] }>(`/api/guardian/anomaly/history?wardId=${wardId}&page=0&size=20`);
    const found = page.content.find(i => i.cameraLabel === label && i.detectedType === type && !before.has(i.incidentId));
    if (found) return found;
    await sleep(2_000);
  }
  return undefined;
}

/** 화재 사진을 이어서 보내(유지 조건 때문에 연속 관찰이 필요하다) 이상감지 상황이 생기면 멈춘다 */
export async function streamFireUntilIncident(
  proxy: APIRequestContext,
  sessionId: string,
  guardianApi: Api,
  wardId: string,
  label: string,
  type = 'FIRE',
  timeoutMs = 75_000,
  jpeg: Buffer = fireJpeg(),
  before = new Set<number>(),
): Promise<Incident | undefined> {
  const deadline = Date.now() + timeoutMs;
  let sent = 0;
  while (Date.now() < deadline) {
    const res = await postFrame(proxy, sessionId, jpeg);
    expect(res.status(), `프레임 ${sent + 1} 업로드`).toBe(200);
    sent++;
    if (sent % 12 === 0) {
      const found = await pollIncident(guardianApi, wardId, label, type, 0, before).catch(() => undefined);
      if (found) return found;
    }
    await sleep(250);
  }
  return pollIncident(guardianApi, wardId, label, type, 10_000, before);
}

/**
 * 화재 신호 1회를 만든다(처음 부른 테스트에서만 돈다. 나머지는 같은 결과를 받는다).
 * 순서: 카메라 등록 -> AI 세션 생성·프레임 -> 같은 기기로 재등록(BE 가 'AI 세션 목록 재요청' 로그를 새로 남기는지 확인) -> 화재 프레임
 * 한계: 진짜 '스트리밍 먼저, 등록 나중'은 만들 수 없다(sessionId 를 BE 가 등록 때 만든다). 그래서 AI 가 세션 생성 때 보낸 목록으로
 * BE 가 이미 구독했을 수 있고, 재등록이 만드는 '등록 이벤트 처리(onCameraRegistered)'만 로그로 확인한다.
 */
export function getFireRun(openAs: OpenAs): Promise<FireRun> {
  if (!runPromise) skipUnlessCameraSlot();
  runPromise ??= startFireRun(openAs);
  return runPromise;
}

async function startFireRun(openAs: OpenAs): Promise<FireRun> {
  const notes: string[] = [];
  const tail = Math.random().toString(36).slice(2, 6); // 같은 이름 임시 사용자가 남아 있어도 관리자 요약 검색이 섞이지 않게
  const ward = createTempUser('WARD', { name: `E2E카메라본인${tail}` });
  created.push(ward);
  const ga = createTempUser('GUARDIAN', { name: 'E2E카메라보호자A' });
  created.push(ga);
  const gb = createTempUser('GUARDIAN', { name: 'E2E카메라보호자B' });
  created.push(gb);
  const admin = createTempUser('ADMIN', { name: 'E2E카메라관리자' });
  created.push(admin);
  connect(ga.id, ward.id);
  connect(gb.id, ward.id);
  // FCM 토큰이 없는 임시 계정은 문자 대체 발송 대상이라 막는다(알림 기록·실시간·이력은 그대로)
  suppressAnomalySmsFallback(ward.id);

  const logins = {
    ward: await Api.signinWithRetry(ward.email, ward.password),
    ga: await Api.signinWithRetry(ga.email, ga.password),
    gb: await Api.signinWithRetry(gb.email, gb.password),
    admin: await Api.signinWithRetry(admin.email, admin.password),
  };
  const wardApi = await Api.fromLogin(logins.ward);
  const gaApi = await Api.fromLogin(logins.ga);
  const gbApi = await Api.fromLogin(logins.gb);
  const adminApi = await Api.fromLogin(logins.admin);
  apis.push(wardApi, gaApi, gbApi, adminApi);

  // N27: 보호자 A 는 문자·알림톡 켬, 보호자 B 는 기본(앱 푸시만), 본인은 문자 켬
  notes.push(`A 문자 ${await setChannel(gaApi, 'SMS', true)} / A 알림톡 ${await setChannel(gaApi, 'KAKAO_ALIMTALK', true)} / 본인 문자 ${await setChannel(wardApi, 'SMS', true)}`);

  const label = await freeRoom(wardApi);
  const camera = await wardApi.post<Camera>('/api/ward/camera', { label });
  cameraRef = { api: wardApi, id: camera.id, sessionId: camera.sessionId };

  const proxy = await wardProxy(logins.ward);
  proxyRef = proxy;
  const startedAt = new Date().toISOString();

  // 실시간 이벤트를 받는 화면(보호자 A·B, 본인)
  const gaPage = await openAs({ label: 'ga', login: logins.ga }, '/guardian');
  const gbPage = await openAs({ label: 'gb', login: logins.gb }, '/guardian');
  const wardPage = await openAs({ label: 'ward', login: logins.ward }, '/ward');
  await Promise.all([waitForRealtime(gaPage), waitForRealtime(gbPage), waitForRealtime(wardPage)]);
  const getGa = await collectEvents(gaPage, ga.id);
  const getGb = await collectEvents(gbPage, gb.id);
  const getWard = await collectEvents(wardPage, ward.id);

  // 1) AI 세션 생성 + 프레임 1장. 카메라는 이미 등록돼 있어 AI 가 세션 생성 때 보낸 목록으로 BE 가 이 자리에서 구독할 수 있다
  const created1 = await createAiSession(proxy, camera.sessionId, camera.deviceId);
  expect(created1.status(), 'AI 세션 생성(FE 프록시)').toBe(200);
  const jpeg = fireJpeg();
  expect((await postFrame(proxy, camera.sessionId, jpeg)).status(), '첫 프레임').toBe(200);
  await sleep(3_000);

  // 2) 같은 기기로 재등록(멱등) -> 등록 이벤트(onCameraRegistered)가 'AI 세션 목록 재요청' 로그를 새로 남기는지 센다
  const requeryNeedle = `AI 세션 목록 재요청: sessionId=${camera.sessionId}`;
  const subscribedLogsBeforeReregister = countBackendLog(`세션 구독: sessionId=${camera.sessionId}`, 300);
  const requeryBefore = countBackendLog(requeryNeedle, 300);
  const t0 = Date.now();
  const again = await wardApi.post<Camera>('/api/ward/camera', { label, deviceId: camera.deviceId });
  expect(again.sessionId).toBe(camera.sessionId);
  let requeryAfterReregisterMs: number | null = null;
  while (Date.now() - t0 < 70_000) {
    if (countBackendLog(requeryNeedle, 300) > requeryBefore) {
      requeryAfterReregisterMs = Date.now() - t0;
      break;
    }
    await sleep(2_000);
  }

  // 3) 화재 프레임을 이어서 보낸다
  const before = new Set<number>();
  const incident = await streamFireUntilIncident(proxy, camera.sessionId, gaApi, ward.id, label, 'FIRE', 90_000, jpeg, before);
  if (!incident) throw new Error('화재 프레임을 보냈지만 90초 안에 이상감지 상황이 생기지 않았다');

  // 4) 알림 도착을 잠시 기다린다
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && (await getGa()).length === 0) await sleep(1_000);
  await sleep(2_000);

  // 보호자 A 화면의 안전 알림 팝업(확인 전까지 유지되어야 한다)
  let gaToast: FireRun['gaToast'] = null;
  const alert = gaPage.getByRole('alert').filter({ hasText: /화재/ }).first();
  if (await alert.isVisible().catch(() => false)) {
    const text = ((await alert.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim();
    await gaPage.waitForTimeout(7_000);
    gaToast = { text, stillVisibleAfter7s: await alert.isVisible().catch(() => false) };
  }

  return {
    ward, ga, gb, admin, wardApi, gaApi, gbApi, adminApi,
    gaLogin: logins.ga, wardLogin: logins.ward,
    camera: { ...camera, label }, proxy, startedAt, subscribedLogsBeforeReregister, requeryAfterReregisterMs, incident,
    events: { ga: await getGa(), gb: await getGb(), ward: await getWard() },
    gaToast, setupNotes: notes,
  };
}

/** 공용 화재 신호용 카메라를 지우고 AI 세션을 끝낸다(카메라 상한 3대 때문에 다음 테스트 전에 부른다) */
export async function releaseFireCamera() {
  if (proxyRef && cameraRef) await stopAiSession(proxyRef, cameraRef.sessionId);
  if (cameraRef) await cameraRef.api.raw('DELETE', `/api/ward/camera/${cameraRef.id}`).catch(() => undefined);
  cameraRef = null;
}

/** 파일 끝에서 한 번: 카메라·AI 세션·임시 사용자 정리 */
export async function disposeFireRun() {
  await releaseFireCamera().catch(() => undefined);
  if (proxyRef) await proxyRef.dispose().catch(() => undefined);
  proxyRef = null;
  for (const api of apis.splice(0)) await api.dispose().catch(() => undefined);
  for (const user of created.splice(0).reverse()) {
    try {
      // suppressAnomalySmsFallback 가 만든 이 임시 사용자 자신의 키만 지운다
      redisDelPattern(`notify:sms-fallback:*:${user.id}`);
    } catch (error) {
      console.warn(`임시 사용자 ${user.id} 의 Redis 키 정리 실패 (1시간 뒤 자동 만료):`, error);
    }
    try {
      deleteTempUser(user.id);
    } catch (error) {
      console.warn(`임시 사용자 ${user.id} 정리 실패 (다음 전체 실행 때 정리됨):`, error);
    }
  }
  runPromise = undefined;
}

/** 임시 사용자를 만들고 disposeFireRun 때 지우게 등록한다 */
export function newTempUser(role: TempUser['role'], options?: Parameters<typeof createTempUser>[1]): TempUser {
  const user = createTempUser(role, options);
  created.push(user);
  return user;
}

export async function loginApi(user: TempUser): Promise<{ api: Api; login: LoginResult }> {
  const login = await Api.signinWithRetry(user.email, user.password);
  const api = await Api.fromLogin(login);
  apis.push(api);
  return { api, login };
}

/** 이 파일이 만든 카메라를 정리 목록에 올린다 */
export function trackCamera(api: Api, id: number, sessionId: string, proxy: APIRequestContext) {
  proxyRef = proxy;
  cameraRef = { api, id, sessionId };
}

/**
 * 카메라 등록 -> AI 세션 만들고 프레임 1장 -> 같은 기기 재등록 -> BE 구독 확인까지 한다.
 * 서비스 전체 카메라 상한 때문에 한 번에 1대만 쓴다.
 */
export async function setupSubscribedCamera(wardApi: Api, proxy: APIRequestContext, label: string, jpegOrNull?: Buffer) {
  skipUnlessCameraSlot();
  const jpeg = jpegOrNull ?? (await plainJpeg());
  const camera = await wardApi.post<Camera>('/api/ward/camera', { label });
  trackCamera(wardApi, camera.id, camera.sessionId, proxy);
  expect((await createAiSession(proxy, camera.sessionId, camera.deviceId)).status(), 'AI 세션 생성(FE 프록시)').toBe(200);
  expect((await postFrame(proxy, camera.sessionId, jpeg)).status(), '첫 프레임').toBe(200);
  const t0 = Date.now();
  await wardApi.post<Camera>('/api/ward/camera', { label, deviceId: camera.deviceId });
  let subscribedMs: number | null = null;
  while (Date.now() - t0 < 70_000) {
    if (countBackendLog(`세션 구독: sessionId=${camera.sessionId}`, 120) > 0) {
      subscribedMs = Date.now() - t0;
      break;
    }
    await sleep(2_000);
  }
  expect(subscribedMs, 'BE 가 새 AI 세션을 구독해야 한다').not.toBeNull();
  return { camera: { ...camera, label }, subscribedMs: subscribedMs! };
}

export function cameraRowCount(sessionId: string): number {
  return Number(psqlRows(`SELECT count(*) FROM camera WHERE session_id = ${sqlStr(sessionId)};`)[0][0]);
}
