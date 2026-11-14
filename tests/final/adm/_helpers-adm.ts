/**
 * 최종 QA - 관리자(ADM) 영역 전용 도우미.
 * 공용 src/ 파일은 고치지 않고, 이 영역에서만 쓰는 작은 함수를 모은다.
 *
 * 안전: 읽기(SELECT)와 기존 헬퍼(connect 등)만 쓴다. 토큰·비밀번호·전화번호는 어디에도 찍지 않는다.
 */
import { APIResponse, Page, request } from '@playwright/test';

import { env } from '../../../src/env';
import { psql, sqlStr } from '../../../src/remote';

export const TAGS = { tag: ['@P0', '@ADM'] };

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface Body {
  status: number;
  text: string;
  json: { success?: boolean; message?: string; code?: string; data?: any };
}

export async function bodyOf(res: APIResponse): Promise<Body> {
  const text = await res.text();
  try {
    return { status: res.status(), text, json: JSON.parse(text) };
  } catch {
    return { status: res.status(), text, json: {} };
  }
}

export interface SigninResult extends Body {
  /** 로그인 성공 시 응답 본문의 data (토큰 포함 - 어디에도 찍지 말 것) */
  login: { accessToken: string; refreshToken: string | null; userId: string; role: string } | null;
  /** Set-Cookie 로 내려온 refresh 쿠키의 "이름=값" (없으면 null) */
  refreshCookie: string | null;
}

/**
 * 로그인을 직접 부른다. 속도 제한(429)이 걸리면 Redis 를 건드리지 않고 기다렸다 다시 시도한다.
 * 실패 응답(403 등)도 그대로 돌려준다.
 */
export async function signinWaiting(email: string, password: string, attempts = 12): Promise<SigninResult> {
  for (let i = 1; ; i++) {
    const ctx = await request.newContext({ baseURL: env.apiUrl });
    try {
      const res = await ctx.post('/api/auth/signin', { data: { email, password } });
      const body = await bodyOf(res);
      if (body.status === 429 && i < attempts) {
        await sleep(6_000);
        continue;
      }
      const cookie = res
        .headersArray()
        .filter(h => h.name.toLowerCase() === 'set-cookie')
        .map(h => h.value)
        .find(value => /refresh/i.test(value.split('=')[0]));
      return { ...body, login: body.status === 200 ? (body.json.data ?? null) : null, refreshCookie: cookie ? cookie.split(';')[0] : null };
    } finally {
      await ctx.dispose();
    }
  }
}

/** 조건이 참이 될 때까지 기다린다 (끝까지 거짓이면 마지막 값을 돌려준다) */
export async function settle<T>(read: () => Promise<T> | T, done: (v: T) => boolean, timeoutMs: number, stepMs = 500): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await sleep(stepMs);
    value = await read();
  }
  return value;
}

/** 응답 트리의 모든 키 이름 (배열 안 객체 포함) */
export function allKeys(node: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    node.forEach(item => allKeys(item, into));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      into.add(key);
      allKeys(value, into);
    }
  }
  return into;
}

/** 응답 트리의 모든 문자열 값 */
export function allStrings(node: unknown, into: string[] = []): string[] {
  if (typeof node === 'string') {
    into.push(node);
  } else if (Array.isArray(node)) {
    node.forEach(item => allStrings(item, into));
  } else if (node && typeof node === 'object') {
    Object.values(node as Record<string, unknown>).forEach(value => allStrings(value, into));
  }
  return into;
}

/**
 * 관리자 화면 응답에 있으면 안 되는 칸 이름: 영상·정지 화면·클립 주소, 기기 토큰(deviceId), 상세 주소.
 * 낙타 표기(fileUrl, playbackUri, s3Key)와 밑줄 표기(file_url)를 낱말로 쪼개서 본다.
 */
const FORBIDDEN_WORDS = new Set(['url', 'uri', 'href', 'link', 'path', 'clip', 'clips', 'video', 'still', 'snapshot', 'thumb', 'thumbnail', 'image']);
const FORBIDDEN_JOINED = /deviceid|addressdetail|detailaddress|s3key|objectkey|filekey|storagekey/;

export function isForbiddenKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_\-\s]+/);
  if (words.some(word => FORBIDDEN_WORDS.has(word))) return true;
  return FORBIDDEN_JOINED.test(words.join(''));
}
/** 응답 값에 있으면 안 되는 모양: 영상·이미지 파일 주소, 클립 경로 */
export const FORBIDDEN_VALUE = /https?:\/\/|\.(mp4|webm|m3u8|jpg|jpeg|png)(\?|$)|\/clips?\//i;

export function forbiddenInResponse(json: unknown): string[] {
  const problems: string[] = [];
  for (const key of allKeys(json)) {
    if (isForbiddenKey(key)) problems.push(`키 ${key}`);
  }
  for (const value of allStrings(json)) {
    if (FORBIDDEN_VALUE.test(value)) problems.push(`값 ${value.slice(0, 40)}`);
  }
  return problems;
}

/** 안전 현황(/api/admin/dashboard/safety)에서 이 테스트가 보는 값 */
export interface SafetyEvents {
  disconnectedCameras: number | null;
  wardsWithoutGuardian: number;
  wardsWithoutReachableGuardian: number;
  wardsWithoutCamera: number;
  stalePendingConnections: number;
  todayFailedNotifications: number;
}

export interface Safety {
  aiConnected: boolean;
  safetyEvents: SafetyEvents;
}

/** BE 컨테이너 로그에 없는 칸이 섞여 나갔는지 보는 안전 가드: 문자열이 토큰처럼 보이면 가린다 */
export function redact(text: string): string {
  return text.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '<token>');
}

/** 한 줄 조회 결과(첫 줄) */
export function psqlOne(sql: string): string {
  return psql(sql).split('\n')[0]?.trim() ?? '';
}

export function userStatusRow(userId: string) {
  const [role, status, reason, name, email, phone] = psql(
    `SELECT role, status, coalesce(status_reason, ''), name, email, coalesce(phone, '') FROM users WHERE id = ${sqlStr(userId)};`,
  ).split('|');
  return { role, status, reason, name, email, phone };
}

export function userExists(userId: string): boolean {
  return psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(userId)};`) !== '0';
}

/** 이 관리자·대상에 대한 감사 로그 행 수 (조회만) */
export function auditCount(where: { adminId?: string; targetId?: string; action?: string }): number {
  const conditions = [
    where.adminId ? `admin_id = ${sqlStr(where.adminId)}` : null,
    where.targetId ? `target_id = ${sqlStr(where.targetId)}` : null,
    where.action ? `action = ${sqlStr(where.action)}` : null,
  ].filter(Boolean);
  return Number(psql(`SELECT count(*) FROM admin_audit_log WHERE ${conditions.join(' AND ')};`));
}

/** 알림 이력(notification_log) 행: 받는 사람 + 종류 */
export function notificationRows(recipientId: string, type: string) {
  const out = psql(
    `SELECT result, coalesce(not_sent_reason, ''), body FROM notification_log
     WHERE recipient_id = ${sqlStr(recipientId)} AND type = ${sqlStr(type)} ORDER BY id;`,
  );
  return out
    ? out.split('\n').map(line => {
        const [result, reason, ...body] = line.split('|');
        return { result, reason, body: body.join('|') };
      })
    : [];
}

// ─── 열린 실시간(STOMP) 연결을 직접 열고 닫힘·수신을 본다 ─────────────────────────────

export interface RawStompState {
  connected: boolean;
  closed: boolean;
  code: number;
  reason: string;
  /** 받은 MESSAGE 프레임의 목적지(destination) 목록 */
  destinations: string[];
}

/**
 * FE 오리진 페이지(예: /login)에서 STOMP 연결을 직접 연다. 앱 화면을 열면 401 에 앱이 스스로 연결을 닫아 검증이 흐려진다.
 * topics 는 /topic/... 전체 주소다.
 */
export async function openRawStomp(page: Page, key: string, accessToken: string, topics: string[]): Promise<boolean> {
  const wsUrl = `${env.apiUrl.replace(/^http/, 'ws')}/ws?token=${accessToken}`;
  return page.evaluate(
    ({ url, key, topics }) =>
      new Promise<boolean>(resolve => {
        const w = window as unknown as { __admStomp?: Record<string, { ws: WebSocket; state: RawStompState }> };
        w.__admStomp ??= {};
        const state: RawStompState = { connected: false, closed: false, code: 0, reason: '', destinations: [] };
        const ws = new WebSocket(url);
        w.__admStomp[key] = { ws, state };
        const timer = setTimeout(() => resolve(false), 15_000);
        ws.onopen = () => ws.send('CONNECT\naccept-version:1.2\nheart-beat:0,0\n\n\0');
        ws.onmessage = event => {
          const data = String(event.data);
          if (data.startsWith('CONNECTED')) {
            state.connected = true;
            topics.forEach((topic, i) => ws.send(`SUBSCRIBE\nid:adm-${i}\ndestination:${topic}\n\n\0`));
            clearTimeout(timer);
            resolve(true);
          } else if (data.startsWith('MESSAGE')) {
            const destination = /destination:([^\n]+)/.exec(data)?.[1];
            if (destination) state.destinations.push(destination);
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
        ws.onclose = event => {
          state.closed = true;
          state.code = event.code;
          state.reason = event.reason;
          clearTimeout(timer);
          resolve(false);
        };
      }),
    { url: wsUrl, key, topics },
  );
}

export function readRawStomp(page: Page, key: string): Promise<RawStompState> {
  return page.evaluate(
    k => (window as unknown as { __admStomp: Record<string, { state: RawStompState }> }).__admStomp[k].state,
    key,
  );
}

export function closeRawStomp(page: Page, key: string) {
  return page
    .evaluate(k => (window as unknown as { __admStomp?: Record<string, { ws: WebSocket }> }).__admStomp?.[k]?.ws.close(), key)
    .catch(() => undefined);
}
