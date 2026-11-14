/**
 * 최종 QA 알림(NOTI) 영역 전용 도우미.
 * 임시 사용자만 쓴다. DB·Redis 는 src/remote.ts 의 기존 함수(조회 위주)만 거친다.
 */
import { APIRequestContext, APIResponse, Page, request } from '@playwright/test';

import { Api } from '../../../src/api';
import { env } from '../../../src/env';
import { expect } from '../../../src/fixtures';
import { psqlRows, sqlStr } from '../../../src/remote';

export const NOTI_TAGS = { tag: ['@P0', '@NOTI'] };
/** 30분 넘게 기다리는 느린 테스트(NOTI_RUN_SLOW=1 일 때만 돈다) */
export const NOTI_SLOW_TAGS = { tag: ['@P0', '@NOTI', '@slow'] };

/**
 * 로그인 폼만 채워 누른다. src/variables.ts 의 loginViaForm 은 relaxRateLimits() 로 모든 IP 의
 * 속도 제한 Redis 키를 지우기 때문에(다른 영역 테스트를 깨뜨릴 수 있음) 이 영역에서는 쓰지 않는다.
 */
export async function fillLoginForm(page: Page, email: string, password: string) {
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

/** JWT 의 exp(만료 시각, 초). 서명은 검사하지 않고 payload 만 읽는다 */
export function jwtExp(jwt: string): number {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).exp as number;
}

/** 실제 푸시가 나가지 않는 가짜 FCM 토큰 (길이 500 이하) */
export function fakeToken(userId: string, tag = '') {
  return `e2e-fake-fcm-${userId}-${tag}${Date.now().toString(36)}`;
}

// ───────────── 화면 도우미 (v13 보호자 화면: 사이드바는 닫힌 서랍, 위쪽 바에 종 아이콘·메뉴 버튼) ─────────────

/** 보호자 화면이 열렸는지(위쪽 바의 "메뉴 열기" 버튼) */
export function menuButton(page: Page) {
  return page.getByRole('button', { name: '메뉴 열기' });
}

/** 닫힌 사이드바 서랍을 연다 (내 프로필·로그아웃·메뉴 링크는 서랍 안에 있다) */
export async function openMenu(page: Page) {
  await menuButton(page).click();
  await expect(page.getByRole('complementary', { name: /메뉴$/ })).toBeVisible();
}

/** 종 아이콘(받은 알림 버튼) */
export function bellButton(page: Page) {
  return page.locator('[aria-controls="notification-inbox"]');
}

// ───────────── 토큰·응답 도우미 ─────────────

function b64url(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** 서명이 틀리고 exp 가 지난 access JWT 흉내. secondsAgo 만큼 전에 만료됐다 */
export function expiredJwt(sub: string, role: string, secondsAgo = 3600) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role, typ: 'access', iat: now - secondsAgo - 3600, exp: now - secondsAgo })}.${'x'.repeat(43)}`;
}

/** 진짜 JWT 의 서명 한가운데 글자 하나를 바꿔 위조 서명으로 만든다 */
export function tamperSignature(jwt: string) {
  const [header, payload, signature] = jwt.split('.');
  const i = 10;
  const flipped = signature.slice(0, i) + (signature[i] === 'A' ? 'B' : 'A') + signature.slice(i + 1);
  return `${header}.${payload}.${flipped}`;
}

export async function bodyOf(res: APIResponse): Promise<Record<string, any>> {
  const text = await res.text();
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/** 로그인하지 않은 클라이언트 (Authorization 헤더 없음) */
export function anonymous(): Promise<APIRequestContext> {
  return request.newContext({ baseURL: env.apiUrl });
}

/** Authorization 헤더를 임의의 값으로 넣은 클라이언트 */
export function withBearer(token: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
}

/**
 * POST /api/notifications/fcm-token/release (인증 헤더 없음, IP 기준 1분 10회 공용 제한이라 다른 영역과 겹치면 429).
 * 429 면 응답의 Retry-After(초)를 보고 그만큼(최대 65초) 기다렸다 다시 한다. 헤더가 없으면 20초.
 * 같은 IP 제한을 쓰는 A07·A08 은 한 파일 안에서 직렬로 돌리고, 다른 영역(USER 등)과 동시에 돌리지 않는다.
 */
export async function releaseToken(accessToken: string, token: string) {
  const ctx = await anonymous();
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await ctx.post('/api/notifications/fcm-token/release', { data: { accessToken, token } });
      if (res.status() !== 429 || attempt >= 3) return { status: res.status(), body: await bodyOf(res) };
      const retryAfter = Number(res.headers()['retry-after']);
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 65) * 1000 : 20_000;
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  } finally {
    await ctx.dispose();
  }
}

export function fcmTokenOwner(token: string) {
  return psqlRows(`SELECT user_id FROM fcm_token WHERE token = ${sqlStr(token)};`).map(r => r[0]);
}

// ───────────── 알림 이력(notification_log) ─────────────

export interface LogRow {
  id: number;
  type: string;
  result: string;
  reason: string;
  channels: string;
  readAt: string;
}

/** 수신자의 알림 이력을 읽는다 (조회만) */
export function logRows(recipientId: string, type?: string): LogRow[] {
  return psqlRows(
    `SELECT id, type, result, coalesce(not_sent_reason, ''), channel_results::text, coalesce(read_at::text, '')
       FROM notification_log
      WHERE recipient_id = ${sqlStr(recipientId)} ${type ? `AND type = ${sqlStr(type)}` : ''}
      ORDER BY id;`,
  ).map(([id, t, result, reason, channels, readAt]) => ({ id: Number(id), type: t, result, reason, channels, readAt }));
}

/** 알림 이력 행이 나타날 때까지 기다린다 (발송은 비동기) */
export async function waitForLog(recipientId: string, type: string, count = 1, timeout = 30_000) {
  await expect
    .poll(() => logRows(recipientId, type).length, { timeout, intervals: [1_000, 2_000], message: `${recipientId} 의 ${type} 알림 이력(notification_log)이 생겨야 한다` })
    .toBeGreaterThanOrEqual(count);
  return logRows(recipientId, type);
}

/** 피보호자 API 로 SOS 를 보낸다 (쿨다운 키는 건드리지 않는다. 받는 보호자에게 전화번호·푸시 토큰이 없으면 외부 발송은 없다) */
export async function sendSos(ward: Api) {
  await ward.post('/api/ward/sos', {});
}

/** 보호자의 채널 수신 설정 전체를 한꺼번에 바꾼다 */
export async function setChannels(api: Api, enabled: boolean) {
  await api.raw('PUT', '/api/user/me/notification-settings', {
    settings: ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled })),
  });
}

// ───────────── STOMP(WebSocket) 직접 연결 ─────────────

export function wsUrl(token: string | null) {
  const base = `${env.apiUrl.replace(/^http/, 'ws')}/ws`;
  return token === null ? base : `${base}?token=${token}`;
}

export interface ProbeState {
  opened: boolean;
  connected: boolean;
  close: { code: number; reason: string } | null;
  /** 받은 STOMP 프레임의 명령(첫 줄)만. 본문은 담지 않는다 */
  commands: string[];
  /** MESSAGE 프레임 개수 */
  messages: number;
  receipts: string[];
}

type ProbeWindow = {
  __notiProbe?: Record<
    string,
    { ws: WebSocket; opened: boolean; connected: boolean; close: { code: number; reason: string } | null; commands: string[]; messages: number; receipts: string[] }
  >;
};

/**
 * FE 오리진 페이지 안에서 STOMP 연결을 직접 연다(앱 화면을 열면 401 등으로 앱이 스스로 연결을 닫아 검증이 흐려진다).
 * CONNECTED 를 받거나 닫히거나 15초가 지나면 돌려준다.
 */
export async function probeOpen(page: Page, name: string, url: string): Promise<ProbeState> {
  return page.evaluate(
    ({ name, url }) =>
      new Promise<ProbeState>(resolve => {
        const w = window as unknown as ProbeWindow;
        w.__notiProbe ??= {};
        const ws = new WebSocket(url);
        const st = { ws, opened: false, connected: false, close: null as { code: number; reason: string } | null, commands: [] as string[], messages: 0, receipts: [] as string[] };
        w.__notiProbe[name] = st;
        const snapshot = () => ({ opened: st.opened, connected: st.connected, close: st.close, commands: [...st.commands], messages: st.messages, receipts: [...st.receipts] });
        const timer = setTimeout(() => resolve(snapshot()), 15_000);
        const done = () => {
          clearTimeout(timer);
          resolve(snapshot());
        };
        ws.onopen = () => {
          st.opened = true;
          ws.send('CONNECT\naccept-version:1.2\nheart-beat:0,0\n\n\0');
        };
        ws.onmessage = event => {
          const text = String(event.data);
          const command = text.split('\n')[0];
          if (command === 'MESSAGE') st.messages += 1;
          else if (command.trim()) st.commands.push(command.trim());
          const receipt = /receipt-id:([^\n]+)/.exec(text);
          if (receipt) st.receipts.push(receipt[1]);
          if (command === 'CONNECTED') {
            st.connected = true;
            done();
          }
        };
        ws.onclose = event => {
          st.close = { code: event.code, reason: event.reason };
          done();
        };
        ws.onerror = () => undefined;
      }),
    { name, url },
  );
}

export async function probeSubscribe(page: Page, name: string, destination: string, receipt: string) {
  await page.evaluate(
    ({ name, destination, receipt }) => {
      const st = (window as unknown as ProbeWindow).__notiProbe![name];
      st.ws.send(`SUBSCRIBE\nid:sub-${receipt}\ndestination:${destination}\nreceipt:${receipt}\n\n\0`);
    },
    { name, destination, receipt },
  );
}

export async function probeSend(page: Page, name: string, destination: string, body: string) {
  await page.evaluate(
    ({ name, destination, body }) => {
      const st = (window as unknown as ProbeWindow).__notiProbe![name];
      st.ws.send(`SEND\ndestination:${destination}\ncontent-type:application/json\n\n${body}\0`);
    },
    { name, destination, body },
  );
}

export async function probeState(page: Page, name: string): Promise<ProbeState & { readyState: number }> {
  return page.evaluate(name => {
    const st = (window as unknown as ProbeWindow).__notiProbe![name];
    return {
      opened: st.opened,
      connected: st.connected,
      close: st.close,
      commands: [...st.commands],
      messages: st.messages,
      receipts: [...st.receipts],
      readyState: st.ws.readyState,
    };
  }, name);
}

/**
 * SUBSCRIBE 직후 서버가 구독을 반영할 짧은 시간을 준 뒤, ERROR 프레임이 없고 연결이 열려 있는지 본다.
 * (이 서버는 receipt 헤더를 줘도 RECEIPT 프레임을 보내지 않는다 - 확인해 봄. 그래서 구독 성립의 진짜 증거는
 *  실제 이벤트가 MESSAGE 로 오는 것이다. 여기서는 최소 조건만 본다.)
 */
export async function settleSubscription(page: Page, name: string) {
  await page.waitForTimeout(1_000);
  const state = await probeState(page, name);
  expect(state.commands, `${name}: 구독 거부(ERROR) 프레임이 없다`).not.toContain('ERROR');
  expect(state.close, `${name}: 연결이 닫히지 않았다`).toBeNull();
  expect(state.readyState, `${name}: 연결이 열려 있다`).toBe(1);
}

export async function probeClose(page: Page, name: string) {
  await page
    .evaluate(name => (window as unknown as ProbeWindow).__notiProbe?.[name]?.ws.close(), name)
    .catch(() => undefined);
}

/** 실제 HTTP 핸드셰이크 응답 코드를 본다(101 이면 연결 성립). 토큰 값은 기록하지 않는다 */
export async function handshakeStatus(token: string | null): Promise<number> {
  const ctx = await anonymous();
  try {
    const res = await ctx.fetch(token === null ? '/ws' : `/ws?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('e2e-noti-ws-key!').toString('base64'),
        Origin: env.baseUrl,
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    return res.status();
  } catch {
    return 0;
  } finally {
    await ctx.dispose();
  }
}
