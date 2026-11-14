/**
 * 최종 QA - 인증(AUTH) P1a 묶음 전용 도우미.
 *
 * 원칙: 임시 사용자와 이 PC 의 IP 키만 다룬다. 공용 키를 패턴으로 지우지 않는다.
 * P0 도우미(_helpers-auth.ts)는 고치지 않고 가져다 쓴다.
 */
import { Browser, expect, Page, request } from '@playwright/test';

import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { env, feHost } from '../../../src/env';
import { redis } from '../../../src/remote';
import { callBe, myRateSuffix, openMenuNav, Raw, relaxAuthRates, signinRaw, sleep, tokensOf } from './_helpers-auth';

export const TAGS_P1 = { tag: ['@P1', '@AUTH'] };

// ---------------------------------------------------------------------------------------------
// 속도 제한: 이 PC 의 IP 키만 지운다 (제한이 풀리는 방향)
// ---------------------------------------------------------------------------------------------

/**
 * relaxAuthRates 와 같다(내 IP 의 로그인·재발급·이메일 찾기 한도만 비운다). 다른 에이전트가 같은 순간 로그인해
 * "내 IP 키를 하나로 못 찾는" 일시 실패가 나면 잠깐 쉬고 다시 찾는다. 3번 모두 실패하면 그 오류를 그대로 던진다.
 */
export async function relaxMine(extraPatterns: string[] = []) {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await relaxAuthRates(extraPatterns);
      return;
    } catch (error) {
      last = error;
      await sleep(1500 * attempt);
    }
  }
  throw last;
}

/** 한 창짜리 한도(rate:이름:IP) 중 내 IP 키만 지운다 */
export async function delMyRate(...names: string[]) {
  const suffix = await myRateSuffix();
  redis('DEL', ...names.map(name => `rate:${name}:${suffix}`));
}

/** 분·시간 두 창짜리 한도(rate:이름:1m:IP, rate:이름:1h:IP) 중 내 IP 키만 지운다 */
export async function delMyRateDual(...names: string[]) {
  const suffix = await myRateSuffix();
  redis('DEL', ...names.flatMap(name => [`rate:${name}:1m:${suffix}`, `rate:${name}:1h:${suffix}`]));
}

/** 내 IP 의 두 창 한도 카운터를 지정한 값으로 둔다(시간 창은 1시간 TTL) */
export async function setMyHourCount(name: string, count: number) {
  const suffix = await myRateSuffix();
  redis('SET', `rate:${name}:1h:${suffix}`, String(count), 'EX', '3600');
}

// ---------------------------------------------------------------------------------------------
// BE 호출
// ---------------------------------------------------------------------------------------------

/** callBe 와 같지만 OPTIONS 등 아무 메서드나 보낼 수 있다 */
export async function callBeAny(
  method: string,
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

/** 임시 사용자로 로그인(내 IP 키만 비우고 호출). 토큰만 돌려준다 */
export async function signinTokens(email: string, password: string) {
  await relaxAuthRates();
  const res = await signinRaw(email, password);
  expect(res.status, `준비: 로그인 ${res.status} ${res.code}`).toBe(200);
  return { ...tokensOf(res), userId: res.json.data.userId as string };
}

/** 한 연결로 GET 을 total 번 보낸다(동시 concurrency). 응답 상태만 모아 돌려준다 */
export async function hammer(path: string, token: string, total: number, concurrency = 20) {
  const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  const statuses: number[] = [];
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (next < total) {
          next += 1;
          const res = await ctx.get(path);
          statuses.push(res.status());
        }
      }),
    );
  } finally {
    await ctx.dispose();
  }
  return statuses;
}

/** Retry-After 헤더(초)를 숫자로. 없거나 숫자가 아니면 NaN */
export function retryAfterOf(raw: Raw) {
  return Number(raw.headers['retry-after']);
}

// ---------------------------------------------------------------------------------------------
// 화면
// ---------------------------------------------------------------------------------------------

/** 관찰자(PageWatcher) 없이 새 브라우저 컨텍스트와 페이지를 연다. 모의 5xx 를 일부러 쓰는 시험용 */
export async function openPlain(browser: Browser, path: string | null = '/login') {
  const context = await browser.newContext({ ...contextDefaults });
  await context.addInitScript(installPageStubs(), pageStubArg);
  const page = await context.newPage();
  if (path) await page.goto(path);
  return { context, page, close: () => context.close() };
}

/** 로그인 화면으로 로그인한다. 내 IP 의 로그인 한도만 비운다(모든 IP 를 지우는 src/variables.ts 의 loginViaForm 은 쓰지 않는다) */
export async function uiLogin(page: Page, email: string, password: string) {
  await relaxMine();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

/** 서명은 맞지 않지만 FE 가 읽는 값(exp)이 과거인 access 토큰. FE 가 "만료"로 보게 하는 용도(서버로는 보내지 않는다) */
export function expiredLookingAccess(access: string) {
  const [head, body] = access.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>;
  payload.exp = Math.floor(Date.now() / 1000) - 3600;
  payload.iat = Math.floor(Date.now() / 1000) - 3600 - 1800;
  return `${head}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.e2eexpired`;
}

/** 이 컨텍스트의 FE access 쿠키를 만료된 것처럼 보이는 값으로 바꾼다(HttpOnly refresh 쿠키는 그대로) */
export async function expireAccessCookie(page: Page) {
  const cookies = await page.context().cookies();
  const access = cookies.find(c => c.name === 'careai_access_token');
  expect(access, '준비: FE access 쿠키(careai_access_token)').toBeTruthy();
  const fake = expiredLookingAccess(decodeURIComponent(access!.value));
  await page.context().addCookies([
    { name: 'careai_access_token', value: encodeURIComponent(fake), domain: feHost, path: '/', expires: access!.expires, httpOnly: false, secure: access!.secure, sameSite: 'Lax' },
  ]);
}

/** 보호 API 가 아닌 인증 API 를 뺀, 지정한 메서드·경로의 첫 요청만 401(만료) 로 바꾼다. 몇 번 가로챘는지 센다 */
export async function failFirst(
  page: Page,
  match: { method: string; pathEnds: string },
  respond: { status: number; json: unknown },
) {
  const state = { fired: 0, seen: 0 };
  await page.route('**/api/**', async route => {
    const req = route.request();
    if (req.method() === match.method && new URL(req.url()).pathname.endsWith(match.pathEnds)) {
      state.seen += 1;
      if (state.fired === 0) {
        state.fired += 1;
        await route.fulfill({ status: respond.status, json: respond.json });
        return;
      }
    }
    await route.fallback();
  });
  return state;
}

/** 이 페이지가 쓰는 FE access 토큰(쿠키)을 그대로 꺼낸다 - 새로 로그인하면 열린 브라우저의 세션이 끊기므로 API 호출에 이 값을 쓴다 */
export async function accessOfPage(page: Page) {
  const cookie = (await page.context().cookies()).find(c => c.name === 'careai_access_token');
  expect(cookie, '준비: 로그인한 브라우저의 access 쿠키').toBeTruthy();
  return decodeURIComponent(cookie!.value);
}

/** 사이드 메뉴를 열고 사용자 이름 버튼을 눌러 "내 프로필" 대화상자를 연다 */
export async function openProfileDialog(
  page: Page,
  role: '보호자' | '피보호자' | '관리자',
  namePattern: RegExp,
  dialogName = '내 프로필',
) {
  if (role === '관리자') {
    // 관리자 화면은 사이드바가 항상 펼쳐져 있고, 왼쪽 아래 "내 프로필" 카드가 이름 버튼이다
    await page.getByRole('button', { name: namePattern }).filter({ hasText: '내 프로필' }).click();
  } else {
    await openMenuNav(page, role);
    await page.getByRole('complementary', { name: /메뉴$/ }).getByRole('button', { name: namePattern }).click();
  }
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 01012345678 -> 010-1234-5678 */
export const dashed = (phone: string) => `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;

export const EXPIRED_BODY = {
  success: false,
  code: 'EXPIRED_TOKEN',
  message: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.',
};

export { callBe };
