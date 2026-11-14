/**
 * 최종 QA - 인증(AUTH) P0 - 화면 (N08 A13 N17)
 *
 * 카카오 서버는 부르지 않는다: 인가 요청은 리다이렉트 응답만 받고(따라가지 않음), 콜백 화면이 BE 로 보내는 요청은 브라우저에서 가로챈다.
 * 실제 카카오 계정 로그인은 자동화할 수 없다.
 */
import { APIRequestContext, Page } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { connect, loginViaForm } from '../../../src/variables';
import { armOnce401, cookieNames, openMenuNav, pollUntil, relaxAuthRates, TAGS } from './_helpers-auth';

test.beforeEach(() => relaxAuthRates());

const STATE_COOKIE = 'careai_oauth_state';

/** 카카오 인가 요청을 FE 에 보내 (리다이렉트는 따라가지 않는다) state 와 쿠키 난수를 받는다 */
async function startKakao(request: APIRequestContext) {
  const res = await request.get(`${env.baseUrl}/api/oauth/kakao/authorize`, { maxRedirects: 0 });
  expect([302, 307], `인가 요청 응답 ${res.status()}`).toContain(res.status());
  const location = new URL(res.headers().location);
  const state = location.searchParams.get('state') ?? '';
  const raw = res.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value).find(v => v.startsWith(`${STATE_COOKIE}=`));
  const nonce = raw ? decodeURIComponent(raw.split(';')[0].slice(STATE_COOKIE.length + 1)) : '';
  return { state, nonce, rawCookie: raw ?? '', host: location.host };
}

/** 이 페이지가 BE 로 보내는 카카오 로그인 요청을 모으고, 가짜 오류로 끝낸다 (BE·카카오에 도달하지 않는다) */
async function captureKakaoSignin(page: Page) {
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/auth/signin/kakao', async route => {
    posts.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>);
    await route.fulfill({ status: 401, json: { success: false, code: 'KAKAO_INVALID_CODE', message: 'E2E 가짜 응답' } });
  });
  return posts;
}

async function setStateCookie(page: Page, nonce: string) {
  await page.context().addCookies([{ name: STATE_COOKIE, value: nonce, url: env.baseUrl }]);
}

test('AUTH-N08 카카오 인가 요청에 난수 state 생성, 콜백에서 대조 후 code만 백엔드로', TAGS, async ({ openAs, request }) => {
  const first = await startKakao(request);
  expect(first.host, '카카오 인가 주소로 보낸다').toBe('kauth.kakao.com');
  expect(first.state, 'state 는 난수(32자리 16진수)').toMatch(/^[0-9a-f]{32}$/);
  expect(first.nonce, '같은 난수가 이 브라우저(쿠키)에 보관된다').toBe(first.state);
  expect(first.rawCookie.toLowerCase(), 'state 쿠키는 10분(600초) 수명').toContain('max-age=600');
  const second = await startKakao(request);
  expect(second.state, '요청마다 새 난수').not.toBe(first.state);

  const page = await openAs('anonymous', null);
  const posts = await captureKakaoSignin(page);
  await setStateCookie(page, first.nonce);
  await page.goto(`/oauth?code=e2e-fake-code&state=${first.state}`);

  await expect.poll(() => posts.length, { message: 'state 가 일치하면 백엔드 요청이 나간다', timeout: 20_000 }).toBe(1);
  expect(posts[0].code, '요청 본문의 code').toBe('e2e-fake-code');
  expect(Object.keys(posts[0]).sort(), '본문에는 code(와 redirectUri)만 있고 state 는 보내지 않는다').toEqual(['code', 'redirectUri']);
  expect(await cookieNames(page), 'state 는 한 번 쓰면 지운다').not.toContain(STATE_COOKIE);
  test.info().annotations.push({
    type: '문서와 다른 점',
    description: '문서는 state 를 sessionStorage 에 둔다고 적었지만 배포된 FE(a8666240)는 쿠키(careai_oauth_state, 10분)에 둔다',
  });
});

test('AUTH-A13 state 불일치·없음·재사용, 로그인 취소', TAGS, async ({ openAs, request }) => {
  test.setTimeout(180_000);
  const retry = '카카오 로그인을 처음부터 다시 시도해주세요.';

  await test.step('state 가 쿠키 난수와 다르면: 백엔드 호출 없이 거절 안내', async () => {
    const start = await startKakao(request);
    const page = await openAs('anonymous', null);
    const posts = await captureKakaoSignin(page);
    await setStateCookie(page, start.nonce);
    await page.goto(`/oauth?code=e2e-fake-code&state=${'a'.repeat(32)}`);
    await expect(page.getByText(retry), 'state 불일치 안내').toBeVisible({ timeout: 20_000 });
    expect(posts, '백엔드 호출 없음').toHaveLength(0);
  });

  await test.step('state 가 없으면: 백엔드 호출 없이 거절 안내', async () => {
    const start = await startKakao(request);
    const page = await openAs('anonymous', null);
    const posts = await captureKakaoSignin(page);
    await setStateCookie(page, start.nonce);
    await page.goto('/oauth?code=e2e-fake-code');
    await expect(page.getByText(retry), 'state 없음 안내').toBeVisible({ timeout: 20_000 });
    expect(posts, '백엔드 호출 없음').toHaveLength(0);
  });

  await test.step('이 브라우저가 시작하지 않은 로그인(쿠키 없음)이면: 거절', async () => {
    const start = await startKakao(request);
    const page = await openAs('anonymous', null);
    const posts = await captureKakaoSignin(page);
    await page.goto(`/oauth?code=e2e-fake-code&state=${start.state}`);
    await expect(page.getByText(retry), '남의 콜백 주소 거절 안내').toBeVisible({ timeout: 20_000 });
    expect(posts, '백엔드 호출 없음').toHaveLength(0);
  });

  await test.step('한 번 쓴 state 를 다시 쓰면(재사용): 두 번째는 거절', async () => {
    const start = await startKakao(request);
    const page = await openAs('anonymous', null);
    const posts = await captureKakaoSignin(page);
    await setStateCookie(page, start.nonce);
    const url = `/oauth?code=e2e-fake-code&state=${start.state}`;
    await page.goto(url);
    await expect.poll(() => posts.length, { timeout: 20_000 }).toBe(1);
    await page.goto(url);
    await expect(page.getByText(retry), '재사용 거절 안내').toBeVisible({ timeout: 20_000 });
    expect(posts, '재사용은 백엔드로 가지 않는다').toHaveLength(1);
  });

  await test.step('카카오에서 취소(error 파라미터)하고 돌아오면: 로그인 화면 + 취소 안내 문구', async () => {
    const page = await openAs('anonymous', null);
    const posts = await captureKakaoSignin(page);
    await page.goto('/oauth?error=access_denied&error_description=User%20denied%20access');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    // FE 수정 때 정한 정확한 안내 문구. 없으면 FE 버그(error 파라미터를 무시하고 로그인 화면으로만 이동)
    await expect(page.getByText('카카오 로그인을 취소했습니다'), '카카오 동의를 취소하고 돌아왔는데 취소 안내 문구가 없다').toBeVisible({ timeout: 10_000 });
    expect(posts, '백엔드 호출 없음').toHaveLength(0);
  });
});

test('AUTH-N17 계정을 바꿔 로그인하면 이전 계정 정보가 없다', TAGS, async ({ tempUser, openAs }) => {
  test.setTimeout(180_000);
  const guardian = await tempUser('GUARDIAN', { name: 'E2E전환가' });
  const ward = await tempUser('WARD', { name: 'E2E전환나' });
  // 보호자에게 연결된 임시 피보호자: 목록 캐시에 이름이 올라가게 한다
  const linked = await tempUser('WARD', { name: 'E2E전환연결' });
  connect(guardian.id, linked.id);
  const page = await openAs('anonymous', '/login');

  await loginViaForm(page, guardian.email, guardian.password);
  await expect(page).toHaveURL(/\/guardian$/);
  await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();
  await openMenuNav(page, '보호자');
  await expect(page.getByRole('complementary', { name: /메뉴$/ }).getByRole('button', { name: new RegExp(guardian.name) }), '준비: 보호자 이름(프로필 캐시)이 보인다').toBeVisible();
  await page.getByRole('button', { name: '메뉴 닫기' }).first().click();
  await page.goto('/guardian/wards');
  await expect(page.getByText(linked.name).first(), '준비: 피보호자 목록에 연결된 피보호자 이름이 보인다(목록 캐시)').toBeVisible({ timeout: 20_000 });
  await page.goto('/guardian');
  await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();

  await test.step('로그인 상태에서 /login 에 가면 홈으로 이동한다', async () => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/guardian$/, { timeout: 15_000 });
  });

  await test.step('같은 탭에서 세션이 끝나 로그인 화면으로 간 뒤 다른 계정으로 로그인해도 이전 계정 정보가 남지 않는다', async () => {
    // 재발급이 거절되는 상황(세션 끝남)을 만들어 새로고침 없이 로그인 화면으로 보낸다
    await page.route('**/api/auth/refresh', route =>
      route.fulfill({ status: 401, json: { success: false, code: 'INVALID_TOKEN', message: 'E2E 세션 만료' } }),
    );
    const state = armOnce401(page);
    const menu = await openMenuNav(page, '보호자');
    state.armed = true;
    await menu.getByRole('link', { name: '공지사항', exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
    await expect.poll(() => state.fired, { message: '보호 API 401 유도' }).toBeGreaterThanOrEqual(1);
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
    await page.unroute('**/api/auth/refresh');

    await loginViaForm(page, ward.email, ward.password);
    await expect(page).toHaveURL(/\/ward/, { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /메뉴$/ }).first()).toBeVisible();
    // 캐시 기반 역할 가드의 재이동이 있다면 3초 안에 일어난다: 그 사이 /ward 를 벗어나면 바로 알아챈다
    const path = await pollUntil(() => new URL(page.url()).pathname, p => !/^\/ward/.test(p), 3_000, 250);
    expect(path, '이전 계정(보호자) 프로필 캐시로 판정돼 보호자 화면으로 돌아가면 안 된다').toMatch(/^\/ward/);
    const body = await page.locator('body').innerText();
    expect(body, '화면에 이전 계정의 이름이 남아 있다').not.toContain(guardian.name);
    expect(body, '화면에 이전 계정의 피보호자 목록(캐시) 이름이 남아 있다').not.toContain(linked.name);
  });
});
