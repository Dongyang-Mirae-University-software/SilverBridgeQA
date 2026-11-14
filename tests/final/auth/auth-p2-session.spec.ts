/**
 * 최종 QA - 인증(AUTH) P2 - 로그인 유지·토큰 전달·긴 User-Agent (N11 N13 A27, 수동확인 A14 A53)
 *
 * 임시 사용자만 쓴다. 서버 설정(환경변수)과 컨테이너는 바꾸지 않는다.
 */
import { expect, test } from '../../../src/fixtures';
import { contextDefaults } from '../../../src/browser';
import { callBe, expectFail, isClearing, rtCookie, signinRaw, tokensOf } from './_helpers-auth';
import { relaxMine, uiLogin } from './_helpers-auth-p1a';
import { relaxP2, TAGS_P2 } from './_helpers-auth-p2';

test.beforeEach(() => relaxP2());

const DAY = 24 * 3600;

test('AUTH-N11 "로그인 유지" 끄면 세션 쿠키로 저장', TAGS_P2, async ({ tempUser, openAs, browser }) => {
  test.setTimeout(150_000);
  const user = await tempUser('GUARDIAN');
  const keep = await tempUser('GUARDIAN');
  const nowSec = () => Date.now() / 1000;
  let restarted: import('@playwright/test').BrowserContext | undefined;
  try {
    // 기준선: 로그인 유지를 켜 두면(기본) 화면 쪽 쿠키가 7일짜리로 남는다
    await test.step('기준선: 로그인 유지 켬 -> 세션 표시 쿠키는 유효기간이 있다', async () => {
      const page = await openAs('anonymous', '/login');
      await expect(page.getByLabel('로그인 유지')).toBeChecked();
      await uiLogin(page, keep.email, keep.password);
      await page.waitForURL(url => !url.pathname.startsWith('/login'));
      await expect.poll(async () => (await page.context().cookies()).some(c => c.name === 'careai_session')).toBe(true);
      const cookies = await page.context().cookies();
      const session = cookies.find(c => c.name === 'careai_session')!;
      expect(session.expires, '켬: careai_session 은 7일 가까운 유효기간').toBeGreaterThan(nowSec() + 6 * DAY);
      expect(cookies.some(c => c.name === 'careai_session_only'), '켬: 세션 전용 표시가 없다').toBe(false);
    });

    const page = await openAs('anonymous', '/login');
    await page.getByLabel('로그인 유지').uncheck();
    await uiLogin(page, user.email, user.password);
    await page.waitForURL(url => !url.pathname.startsWith('/login'));
    await expect.poll(async () => (await page.context().cookies()).some(c => c.name === 'careai_session_only')).toBe(true);
    const cookies = await page.context().cookies();
    const byName = (name: string) => cookies.find(c => c.name === name);

    await test.step('끔: 토큰·세션 표시 쿠키는 세션 쿠키(유효기간 없음)', async () => {
      for (const name of ['careai_access_token', 'careai_session', 'careai_session_only', 'careai_role']) {
        expect(byName(name), `${name} 쿠키가 있다`).toBeTruthy();
        expect(byName(name)!.expires, `${name} 은 세션 쿠키(expires=-1)`).toBe(-1);
      }
    });

    await test.step('끔: 서버가 내린 refresh 쿠키(HttpOnly)와 흔적 쿠키는 7일 남는다', async () => {
      const rt = byName('careai_rt');
      expect(rt, 'refresh 쿠키가 있다').toBeTruthy();
      expect(rt!.httpOnly, 'refresh 쿠키는 HttpOnly').toBe(true);
      expect(rt!.expires, 'refresh 쿠키는 브라우저를 닫아도 남는 유효기간').toBeGreaterThan(nowSec() + 6 * DAY);
      expect(byName('careai_session_trace')?.expires ?? 0, '흔적 쿠키(남은 세션을 끝내기 위한 표시)는 7일').toBeGreaterThan(nowSec() + 6 * DAY);
    });

    await test.step('브라우저를 닫았다 열면(유효기간 있는 쿠키만 남김) 로그인 화면이 보이고 남은 세션이 정리된다', async () => {
      const persistent = cookies.filter(c => c.expires !== -1);
      restarted = await browser.newContext({ ...contextDefaults, storageState: { cookies: persistent, origins: [] } });
      const again = await restarted.newPage();
      await again.goto('/login');
      await expect(again.locator('input[name="email"]'), '대시보드로 넘어가지 않고 로그인 폼이 보인다').toBeVisible();
      await expect(again).toHaveURL(/\/login/);
      await expect
        .poll(async () => (await restarted!.cookies()).some(c => c.name === 'careai_rt'), { message: '남아 있던 refresh 쿠키가 지워진다' })
        .toBe(false);
    });
  } finally {
    await restarted?.close();
  }
});

test('AUTH-N13 body-compat=true 이면 본문 refreshToken도 내려가고 받는다 (본문 우선)', TAGS_P2, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');
  await relaxMine();
  const login = await signinRaw(user.email, user.password);
  expect(login.status, `로그인 ${login.status} ${login.code}`).toBe(200);

  await test.step('로그인 응답: 본문 refreshToken 과 refresh 쿠키가 함께 내려온다 (body-compat=true)', async () => {
    expect(login.json?.data?.refreshToken, '본문 refreshToken').toBeTruthy();
    expect(rtCookie(login)?.value, 'refresh 쿠키').toBeTruthy();
    expect(rtCookie(login)?.value, '본문과 쿠키는 같은 토큰').toBe(login.json.data.refreshToken);
  });

  const first = tokensOf(login).refresh;
  await relaxMine();
  let second = '';
  await test.step('본문 refresh 와 다른(죽은) 쿠키를 함께 보내면 본문 값 기준으로 처리하고 응답 본문에도 refreshToken 이 있다', async () => {
    const res = await callBe('POST', '/api/auth/refresh', {
      data: { refreshToken: first },
      headers: { Cookie: 'careai_rt=not.a.real.token' },
    });
    expect(res.status, `재발급 ${res.status} ${res.code}`).toBe(200);
    expect(res.json?.data?.accessToken, '새 access').toBeTruthy();
    second = res.json?.data?.refreshToken;
    expect(second, '응답 본문에도 새 refreshToken').toBeTruthy();
    expect(rtCookie(res)?.value, '새 refresh 쿠키도 같은 값').toBe(second);
  });

  await test.step('본문이 틀리고 쿠키가 맞으면 본문 기준으로 거절되고, 맞는 쿠키는 지워지지 않는다', async () => {
    await relaxMine();
    const bad = await callBe('POST', '/api/auth/refresh', {
      data: { refreshToken: 'not.a.real.token' },
      headers: { Cookie: `careai_rt=${second}` },
    });
    expectFail(bad, 401, 'INVALID_TOKEN', '틀린 본문');
    expect(isClearing(rtCookie(bad)), '본문이 거절돼도 맞는 쿠키는 지우지 않는다').toBe(false);

    await relaxMine();
    const stillGood = await callBe('POST', '/api/auth/refresh', { headers: { Cookie: `careai_rt=${second}` } });
    expect(stillGood.status, `쿠키만으로 재발급 ${stillGood.status} ${stillGood.code}`).toBe(200);
  });
});

test('AUTH-A27 User-Agent 가 매우 길어도 로그인·로그아웃 정상', TAGS_P2, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');
  for (const length of [600, 2000]) {
    await test.step(`User-Agent ${length}자`, async () => {
      const ua = `E2E-LongUA/${'A'.repeat(length - 11)}`;
      expect(ua).toHaveLength(length);
      await relaxMine();
      const login = await signinRaw(user.email, user.password, { 'User-Agent': ua });
      expect(login.status, `로그인 ${login.status} ${login.code}`).toBe(200);
      expect(login.json?.success, '로그인 성공 표시').toBe(true);
      const out = await callBe('POST', '/api/auth/logout', { token: tokensOf(login).access, headers: { 'User-Agent': ua } });
      expect(out.status, `로그아웃 ${out.status} ${out.code}`).toBe(200);
      expect(out.json?.success, '로그아웃 성공 표시').toBe(true);
    });
  }
});

test.fixme(
  'AUTH-A14 카카오 서버 지연·실패 (연결 3초/응답 5초)',
  {
    tag: ['@P2', '@AUTH'],
    annotation: {
      type: '수동확인 사유',
      description:
        '카카오 토큰 교환을 5초 넘게 지연시키려면 BE 가 부르는 카카오 서버 주소를 가짜 서버로 바꾸거나 컨테이너 설정을 바꿔야 한다. 서버 설정·컨테이너 변경이 금지라 자동화할 수 없다. 실제 카카오로는 지연을 만들 수 없다. BE 단위 테스트(KakaoAuthServiceTest)나 로컬 BE 에 가짜 카카오를 붙인 환경에서 확인한다',
    },
  },
  async () => {},
);

test.fixme(
  'AUTH-A53 AUTH_REFRESH_COOKIE_ENABLED=false 롤백, body-compat=false 전환',
  {
    tag: ['@P2', '@AUTH'],
    annotation: {
      type: '수동확인 사유',
      description:
        '두 스위치는 BE 컨테이너 환경변수라 바꾸려면 컨테이너를 다시 띄워야 한다. 서버 설정·컨테이너 변경 금지 규칙 때문에 자동화할 수 없다. 현재 값(쿠키 켬, body-compat 켬)에서의 동작은 AUTH-N13 이 확인한다. 로컬 BE 에서 환경변수를 바꿔 로그인·refresh 를 확인한다(BE RefreshCookieHttpTest 참고)',
    },
  },
  async () => {},
);
