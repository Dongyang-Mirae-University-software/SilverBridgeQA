/**
 * 최종 QA - 인증(AUTH) 영역 공용 도우미 (이 영역 전용).
 *
 * 원칙: 임시 사용자(tempUser)와 이 도우미가 만든 행만 다룬다. DB·Redis 는 src/remote.ts 의 기존 함수로만 쓴다.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

import { expect, Page, request } from '@playwright/test';

import { ADDRESS } from '../../../src/accounts';
import { env } from '../../../src/env';
import { psql, redis, redisDelPattern, remoteBash, sqlStr } from '../../../src/remote';
import { deleteTempUser, uniqueTestPhone } from '../../../src/seed';

export const TAGS = { tag: ['@P0', '@AUTH'] };

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// 속도 제한: 이 실행 PC 의 IP 키만 다룬다 (다른 IP·다른 영역의 카운터는 건드리지 않는다)
// ---------------------------------------------------------------------------------------------

/**
 * rate:signin:* 키와 횟수를 읽는다 (읽기 전용, 고정 패턴).
 * 남은 시간(TTL)은 읽지 않는다: TTL 은 매초 줄어 상관없는 키도 "바뀐 키"로 보이게 해 후보가 여러 개로 남았다(CONN-A38·A44 1차 실패).
 */
function scanSigninCounters(): Map<string, string> {
  const out = remoteBash(
    [
      `docker exec -i ${env.redisContainer} sh -s <<'__E2E_SCAN__'`,
      `redis-cli --scan --pattern 'rate:signin:*' | while read k; do echo "$k $(redis-cli GET "$k")"; done`,
      '__E2E_SCAN__',
      '',
    ].join('\n'),
  );
  const map = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const i = line.indexOf(' ');
    map.set(line.slice(0, i), line.slice(i + 1));
  }
  return map;
}

let myIpSuffix: string | undefined;

/**
 * 이 PC 가 BE 에서 보이는 IP 키 끝부분. 미가입 임시 이메일로 로그인을 불러 보고, 그 사이 새로 생겼거나 값이 바뀐
 * rate:signin:* 키를 찾는다. 후보가 하나로 좁혀질 때까지 최대 8번 확인한다. 한 번 알아내면 이 프로세스 안에서 재사용한다.
 * 다른 IP(다른 세션·실사용자)가 같은 순간 로그인하면 그 키도 바뀌므로 판마다 교집합을 남긴다. 다른 영역이 내 키를 지워
 * 바뀐 키가 없거나 교집합이 비면 그 판은 버리고 다시 센다.
 */
export async function myRateSuffix(): Promise<string> {
  if (myIpSuffix) return myIpSuffix;
  let candidates: Set<string> | undefined;
  for (let round = 0; round < 8; round++) {
    const ghost = `e2e.ipprobe.${uniqueSuffix()}@silverbridge.test`;
    const before = scanSigninCounters();
    await signinRaw(ghost, 'Wrong1!pass');
    const after = scanSigninCounters();
    redisDelPattern(`login:*:${sha256Hex(ghost)}`);
    const changed = [...after.keys()].filter(key => before.get(key) !== after.get(key));
    if (!changed.length) continue;
    const next = candidates ? new Set(changed.filter(key => candidates!.has(key))) : new Set(changed);
    candidates = next.size ? next : new Set(changed);
    if (candidates.size === 1) break;
  }
  if (!candidates || candidates.size !== 1) {
    throw new Error(`내 IP 의 속도 제한 키를 하나로 찾지 못했다 (후보 ${candidates?.size ?? 0}개)`);
  }
  const key = [...candidates][0];
  myIpSuffix = key.slice('rate:signin:'.length);
  return myIpSuffix;
}

/**
 * 이 PC 의 로그인·재발급·이메일 찾기 한도와, 넘겨 준 "rate:이름:*" 한도 중 "내 IP 키" 만 지운다.
 * (제한이 풀리는 방향이라 해가 없고, 다른 IP·다른 영역이 만든 카운터는 지우지 않는다)
 */
export async function relaxAuthRates(extraPatterns: string[] = []) {
  const suffix = await myRateSuffix();
  const names = ['signin', 'token-refresh', 'find-email'];
  for (const pattern of extraPatterns) {
    const m = /^rate:([a-z-]+):\*$/.exec(pattern);
    if (!m) throw new Error(`허용되지 않는 속도 제한 패턴: ${pattern}`);
    names.push(m[1]);
  }
  redis('DEL', ...names.map(name => `rate:${name}:${suffix}`));
}

/**
 * 틀린 비밀번호로 5번 실패시켜 계정 잠금을 만든다. 같은 PC 에서 다른 영역이 동시에 로그인해 IP 한도(분당 10)에 걸리면
 * 그 시도는 실패로 세어지지 않으므로, 429 TOO_MANY_REQUESTS 가 오면 내 IP 키를 비우고 같은 시도를 다시 한다.
 */
export async function failLoginFiveTimes(email: string) {
  let counted = 0;
  for (let tries = 0; counted < 5 && tries < 12; tries++) {
    const res = await signinRaw(email, 'Wrong1!pass');
    if (res.status === 429 && res.code === 'TOO_MANY_REQUESTS') {
      await relaxAuthRates();
      continue;
    }
    counted++;
  }
}

/** 임시 사용자 id 또는 미가입 임시 이메일(sha256 해시)의 로그인 실패·잠금 키만 한 번에 지운다 */
export function delLoginKeys(subjects: { userIds?: string[]; emails?: string[] }) {
  const ids = [...(subjects.userIds ?? []), ...(subjects.emails ?? []).map(sha256Hex)];
  if (!ids.length) return;
  redis('DEL', ...ids.flatMap(id => [`login:fail:${id}`, `login:lock:${id}`]));
}

/** 임시 사용자(이메일 e2e.*@silverbridge.test) 자신의 상태만 바꾼다. 정지 리스너를 거치지 않아 refresh 행이 그대로 남는다 */
export function setTempUserStatus(userId: string, status: 'ACTIVE' | 'RESTRICTED' | 'INACTIVE') {
  psql(`UPDATE users SET status = ${sqlStr(status)} WHERE id = ${sqlStr(userId)} AND email LIKE 'e2e.%@silverbridge.test';`);
}

// ---------------------------------------------------------------------------------------------
// BE 직접 호출
// ---------------------------------------------------------------------------------------------

export interface Raw {
  status: number;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  code?: string;
  message?: string;
  headers: Record<string, string>;
  setCookies: string[];
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** FE 프록시·쿠키 없이 BE 를 직접 호출한다 */
export async function callBe(
  method: Method,
  path: string,
  opts: { data?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<Raw> {
  const ctx = await request.newContext({ baseURL: env.apiUrl });
  try {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
    const res = await ctx.fetch(path, { method, data: opts.data, headers });
    const body = await res.text();
    let json: Raw['json'] = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return {
      status: res.status(),
      body,
      json,
      code: json?.code,
      message: json?.message,
      headers: res.headers(),
      setCookies: res.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value),
    };
  } finally {
    await ctx.dispose();
  }
}

export interface ParsedCookie {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
}

export function parseCookie(line: string): ParsedCookie {
  const [pair, ...rest] = line.split(';').map(part => part.trim());
  const eq = pair.indexOf('=');
  const attrs: Record<string, string | true> = {};
  for (const attr of rest) {
    const i = attr.indexOf('=');
    if (i < 0) attrs[attr.toLowerCase()] = true;
    else attrs[attr.slice(0, i).toLowerCase()] = attr.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

/** 응답이 내려 준 refresh 쿠키(careai_rt). 없으면 undefined */
export function rtCookie(raw: Raw): ParsedCookie | undefined {
  return raw.setCookies.map(parseCookie).find(cookie => cookie.name === 'careai_rt');
}

/** 쿠키가 "삭제"(Max-Age=0 이거나 이미 지난 Expires)로 내려왔는가 */
export function isClearing(cookie: ParsedCookie | undefined) {
  if (!cookie) return false;
  if (cookie.attrs['max-age'] === '0') return true;
  const expires = cookie.attrs.expires;
  return typeof expires === 'string' && new Date(expires).getTime() < Date.now();
}

export function signinRaw(email: string, password: string, headers?: Record<string, string>) {
  return callBe('POST', '/api/auth/signin', { data: { email, password }, headers });
}

/** 쿠키만으로 재발급 (본문 없음, Origin 없음). 어떤 전달 방식이든 같은 규칙이라 쿠키 방식을 쓴다 */
export function refreshByCookie(refreshToken: string, extraHeaders: Record<string, string> = {}) {
  return callBe('POST', '/api/auth/refresh', { headers: { Cookie: `careai_rt=${refreshToken}`, ...extraHeaders } });
}

/** 로그인·재발급 응답에서 토큰을 꺼낸다. refresh 는 쿠키(우선) 또는 본문 */
export function tokensOf(raw: Raw): { access: string; refresh: string } {
  const data = raw.json?.data ?? {};
  const refresh = rtCookie(raw)?.value || data.refreshToken || '';
  return { access: data.accessToken as string, refresh };
}

export function jwtPayload(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as {
    sub: string;
    exp: number;
    iat: number;
    typ?: string;
  };
}

export function sha256Hex(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

/** code·상태를 한 번에 단언한다 */
export function expectFail(raw: Raw, status: number, code: string, label = '') {
  expect(raw.status, `${label} 상태 ${raw.status} (${raw.code}) ${raw.message ?? raw.body.slice(0, 120)}`).toBe(status);
  expect(raw.code, `${label} 에러 코드`).toBe(code);
}

export async function pollUntil<T>(
  read: () => T | Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
  stepMs = 500,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await sleep(stepMs);
    value = await read();
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// DB·Redis 조회 (읽기)
// ---------------------------------------------------------------------------------------------

export const refreshRows = (userId: string) =>
  Number(psql(`SELECT count(*) FROM refresh_token WHERE user_id = ${sqlStr(userId)};`));

export const accessLogCount = (userId: string, action: string) =>
  Number(psql(`SELECT count(*) FROM access_log WHERE user_id = ${sqlStr(userId)} AND action = ${sqlStr(action)};`));

export const userRowCount = (userId: string) => Number(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(userId)};`));

export const userStatus = (userId: string) => psql(`SELECT status FROM users WHERE id = ${sqlStr(userId)};`);

// ---------------------------------------------------------------------------------------------
// 가입 도우미
// ---------------------------------------------------------------------------------------------

export function signupBody(over: {
  email: string;
  name: string;
  phone: string;
  nonce?: string;
  role?: 'GUARDIAN' | 'WARD';
}) {
  return {
    name: over.name,
    email: over.email,
    password: env.password,
    phone: over.phone,
    ...(over.nonce === undefined ? {} : { verificationNonce: over.nonce }),
    role: over.role ?? 'GUARDIAN',
    address: ADDRESS.address,
    addressDetail: ADDRESS.addressDetail,
    gender: 'MALE',
    birthDate: '1985-04-15',
    postcode: ADDRESS.postcode,
  };
}

export const uniqueSuffix = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/** 가입 SMS 인증 표식(nonce)을 Redis 에 넣는다 - 문자는 나가지 않는다 */
export function armSmsNonce(phone: string, ttlSeconds = 600) {
  const nonce = randomUUID();
  redis('SET', `sms:verified:${phone}`, nonce, 'EX', String(ttlSeconds));
  return nonce;
}

/** 이 테스트가 만든 사용자(정확한 이메일, 안전한 형식만)를 지운다. 임시 사용자 형식 또는 예약 도메인 선점 시험용 이메일만 허용 */
export function cleanupUserByEmail(email: string) {
  if (!/^(e2e\.[^@']+@silverbridge\.test|kakao_9\d{10,}@kakao\.com)$/i.test(email.trim())) {
    throw new Error(`정리 대상이 안전한 형식이 아닙니다: ${email}`);
  }
  const ids = `(SELECT id FROM users WHERE lower(email) = lower(${sqlStr(email.trim())}))`;
  psql(`DELETE FROM sos_event WHERE ward_id IN ${ids};
        DELETE FROM access_log WHERE user_id IN ${ids};
        DELETE FROM users WHERE lower(email) = lower(${sqlStr(email.trim())});`);
}

/**
 * 카카오 가입 세션(pending)을 Redis 에 넣는다. BE 는 "{pendingToken 의 SHA-256}|{email}" 형식으로 저장한다.
 * src/remote.ts 의 redis() 는 '|' 를 막아서 쓸 수 없으므로 remoteBash 로 같은 키(kakao:pending:{id})에 같은 종류의 값을 넣는다.
 */
export function setKakaoPending(kakaoId: string, pendingToken: string, email: string, ttlSeconds = 1800) {
  const value = `${sha256Hex(pendingToken)}|${email}`;
  if (!/^[A-Za-z0-9_-]{1,20}$/.test(kakaoId) || !/^[A-Za-z0-9:_.@|-]+$/.test(value)) {
    throw new Error('허용되지 않는 카카오 세션 값');
  }
  // 임시 키(kakao:pending:e2e...)만 쓴다. 실제 사용자의 카카오 세션 키는 건드리지 않는다
  if (!kakaoId.startsWith('e2e') || !/^e2e\.[^@']+@silverbridge\.test$/i.test(email)) {
    throw new Error('임시 카카오 세션(e2e 로 시작하는 id, e2e 이메일)만 허용');
  }
  remoteBash(`docker exec ${env.redisContainer} redis-cli SET 'kakao:pending:${kakaoId}' '${value}' EX ${ttlSeconds}\n`);
}

export function kakaoSignupBody(over: { kakaoId: string; pendingToken?: string; phone: string; nonce: string }) {
  return {
    kakaoId: over.kakaoId,
    ...(over.pendingToken === undefined ? {} : { pendingToken: over.pendingToken }),
    name: 'E2E카카오',
    phone: over.phone,
    verificationNonce: over.nonce,
    role: 'GUARDIAN',
    address: ADDRESS.address,
    addressDetail: ADDRESS.addressDetail,
    gender: 'MALE',
    birthDate: '1985-04-15',
    postcode: ADDRESS.postcode,
  };
}

export interface KakaoUser {
  id: string;
  email: string;
  accessToken: string;
  cleanup: () => void;
}

/** 카카오 가입 API 를 실제로 거쳐 KAKAO 사용자 한 명과 토큰을 만든다 (카카오 서버는 부르지 않는다) */
export async function createKakaoUserViaSignup(): Promise<KakaoUser> {
  const tag = uniqueSuffix();
  const kakaoId = `e2e${tag}`.slice(0, 20);
  const email = `e2e.kakaoauth.${tag}@silverbridge.test`;
  const phone = uniqueTestPhone();
  const nonce = armSmsNonce(phone);
  const pendingToken = randomUUID();
  setKakaoPending(kakaoId, pendingToken, email);
  const res = await callBe('POST', '/api/auth/signup/kakao', { data: kakaoSignupBody({ kakaoId, pendingToken, phone, nonce }) });
  if (res.status < 200 || res.status >= 300) {
    redis('DEL', `sms:verified:${phone}`);
    redis('DEL', `kakao:pending:${kakaoId}`);
    cleanupUserByEmail(email);
    throw new Error(`카카오 사용자 준비 실패: ${res.status} ${res.code} ${res.message}`);
  }
  const id = res.json.data.userId as string;
  return {
    id,
    email,
    accessToken: res.json.data.accessToken as string,
    cleanup: () => {
      try {
        deleteTempUser(id);
      } catch (error) {
        console.warn('카카오 임시 사용자 정리 실패', error);
      }
      redis('DEL', `kakao:pending:${kakaoId}`);
      redis('DEL', `sms:verified:${phone}`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 웹소켓
// ---------------------------------------------------------------------------------------------

/** FE 오리진 페이지 안에서 STOMP 연결을 열고 CONNECTED 를 받을 때까지 기다린다. 닫힘 정보(code, reason)를 기록해 둔다 */
export async function openStompWs(page: Page, accessToken: string) {
  const wsUrl = `${env.apiUrl.replace(/^http/, 'ws')}/ws?token=${accessToken}`;
  return page.evaluate(
    url =>
      new Promise<boolean>(resolve => {
        const w = window as unknown as { __e2eWs: WebSocket; __e2eClose?: { code: number; reason: string } };
        const ws = new WebSocket(url);
        w.__e2eWs = ws;
        w.__e2eClose = undefined;
        const timer = setTimeout(() => resolve(false), 15_000);
        ws.onopen = () => ws.send('CONNECT\naccept-version:1.2\nheart-beat:0,0\n\n\0');
        ws.onmessage = event => {
          if (String(event.data).startsWith('CONNECTED')) {
            clearTimeout(timer);
            resolve(true);
          }
        };
        ws.onclose = event => {
          w.__e2eClose = { code: event.code, reason: event.reason };
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
      }),
    wsUrl,
  );
}

export async function wsState(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __e2eWs?: WebSocket; __e2eClose?: { code: number; reason: string } };
    return { readyState: w.__e2eWs?.readyState ?? -1, close: w.__e2eClose };
  });
}

/** 서버 쪽에서 웹소켓 핸드셰이크가 어떤 상태로 끝나는지 (101 = 연결됨, 그 밖에는 거부 상태 코드) */
export function wsHandshakeStatus(accessToken: string): Promise<number> {
  const url = new URL(`${env.apiUrl}/ws`);
  url.searchParams.set('token', accessToken);
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request({
      host: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Origin: env.baseUrl,
      },
      timeout: 15_000,
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('timeout', () => req.destroy(new Error('웹소켓 핸드셰이크 시간 초과')));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------------------------

/** 다음에 나가는 보호 API(auth 제외) 요청 하나를 401 로 바꿔, FE 의 재발급 경로를 태운다 */
export function armOnce401(page: Page) {
  const state = { armed: false, fired: 0 };
  void page.route('**/api/**', async route => {
    if (state.armed && !route.request().url().includes('/api/auth/')) {
      state.armed = false;
      state.fired += 1;
      await route.fulfill({
        status: 401,
        json: { success: false, code: 'EXPIRED_TOKEN', message: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.' },
      });
      return;
    }
    await route.fallback();
  });
  return state;
}

export async function cookieNames(page: Page) {
  return (await page.context().cookies()).map(cookie => cookie.name);
}

/** v13 화면: 사이드바는 서랍식이라 "메뉴" 버튼을 눌러야 보인다. 열고 나서 내비게이션을 돌려준다 */
export async function openMenuNav(page: Page, role: '보호자' | '피보호자' | '관리자') {
  const navigation = page.getByRole('navigation', { name: `${role} 메뉴` });
  if (!(await navigation.isVisible())) {
    await page.getByRole('button', { name: /메뉴( 열기)?$/ }).first().click();
  }
  await expect(navigation).toBeVisible();
  return navigation;
}