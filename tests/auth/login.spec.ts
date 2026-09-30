/**
 * 로그인·로그아웃 (실제 로그인 화면으로)
 */
import { ACCOUNTS } from '../../src/accounts';
import { Api, ApiError } from '../../src/api';
import { env } from '../../src/env';
import { expect, modal, nav, test } from '../../src/fixtures';
import { relaxRateLimits } from '../../src/seed';
import { markStale } from '../../src/session';

test.beforeEach(() => {
  // 로그인 API 는 IP 당 1분 10회 제한
  relaxRateLimits();
});

test.describe('로그인', () => {
  test('보호자는 로그인하면 보호자 대시보드로 간다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/login');
    await page.locator('input[name="email"]').fill(ACCOUNTS.guardian1.email);
    await page.locator('input[name="password"]').fill(env.password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    markStale('guardian1');

    await expect(page).toHaveURL(/\/guardian$/);
    await expect(nav(page, 'GUARDIAN')).toBeVisible();
  });

  test('피보호자는 로그인하면 피보호자 홈으로 간다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/login');
    await page.locator('input[name="email"]').fill(ACCOUNTS.ward1.email);
    await page.locator('input[name="password"]').fill(env.password);
    await page.keyboard.press('Enter');
    markStale('ward1');

    await expect(page).toHaveURL(/\/ward$/);
    await expect(nav(page, 'WARD')).toBeVisible();
  });

  test('비밀번호가 틀리면 안내 문구가 보이고 로그인 화면에 머문다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/login');
    await page.locator('input[name="email"]').fill(ACCOUNTS.guardian1.email);
    await page.locator('input[name="password"]').fill('wrong-password-1!');
    await page.getByRole('button', { name: '로그인', exact: true }).click();

    await expect(page.getByRole('alert').first()).toContainText('이메일 또는 비밀번호가 올바르지 않습니다.');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('없는 이메일이면 같은 안내 문구가 보인다 (가입 여부를 드러내지 않음)', async ({ openAs }) => {
    const page = await openAs('anonymous', '/login');
    await page.locator('input[name="email"]').fill('no-such-user@silverbridge.test');
    await page.locator('input[name="password"]').fill('whatever-1!');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('이메일 또는 비밀번호가 올바르지 않습니다.');
  });

  test('빈 칸으로 로그인하면 입력 안내가 보인다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/login');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('이메일과 비밀번호를 입력해주세요.');
  });

  test('로그인 화면에서 아이디 찾기·비밀번호 찾기·회원가입으로 이동한다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/login');
    await page.getByRole('button', { name: '아이디 찾기' }).click();
    await expect(page.getByRole('heading', { name: '아이디 찾기' })).toBeVisible();
    await page.goto('/login');
    await page.getByRole('button', { name: '비밀번호 찾기' }).click();
    await expect(page.getByRole('heading', { name: '비밀번호 찾기' }).first()).toBeVisible();
    await page.goto('/login');
    await page.getByRole('button', { name: '회원가입' }).click();
    await expect(page.getByRole('heading', { name: '회원가입' })).toBeVisible();
  });

  test('카카오 로그인 버튼은 카카오 인증 페이지로 보낸다', async ({ request }) => {
    const res = await request.get(`${env.baseUrl}/api/oauth/kakao/authorize`, { maxRedirects: 0 });
    expect([302, 307]).toContain(res.status());
    const location = new URL(res.headers().location);
    expect(location.host).toBe('kauth.kakao.com');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('redirect_uri')).toMatch(/\/oauth$/);
    expect(location.searchParams.get('client_id')).toBeTruthy();
  });
});

test.describe('로그인 - 알려진 문제', () => {
  test('입력칸에 라벨이 연결돼 있다 (스크린리더·getByLabel 로 찾을 수 있다)', async ({ openAs }) => {
    test.info().annotations.push({
      type: 'issue',
      description: 'TextInput 의 <label> 에 htmlFor/id 연결이 없음 (src/components/TextInput.tsx)',
    });
    const page = await openAs('anonymous', '/login');
    await expect(page.getByLabel('이메일')).toBeVisible({ timeout: 3_000 });
    await expect(page.getByLabel('비밀번호')).toBeVisible({ timeout: 3_000 });
  });

  test('"로그인 유지"를 끄고 로그인하면 브라우저를 닫을 때 로그인이 풀린다 (세션 쿠키)', async ({ openAs }) => {
    test.info().annotations.push({
      type: 'issue',
      description: 'LoginContent 의 remember 상태가 어디에도 전달되지 않음. 토큰 쿠키는 항상 max-age 7일 (tokenStore.ts)',
    });
    const page = await openAs('anonymous', '/login');
    await page.getByText('로그인 유지').click();
    await page.locator('input[name="email"]').fill(ACCOUNTS.ward3.email);
    await page.locator('input[name="password"]').fill(env.password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    markStale('ward3');
    await expect(page).toHaveURL(/\/ward$/);

    const cookies = await page.context().cookies();
    const access = cookies.find(c => c.name === 'careai_access_token');
    expect(access, '토큰 쿠키').toBeTruthy();
    expect(access!.expires, '로그인 유지를 껐으면 만료일 없는 세션 쿠키여야 한다').toBe(-1);
  });

  test('관리자 계정으로 로그인해도 빈 화면이 되지 않는다', async ({ openAs }) => {
    test.info().annotations.push({
      type: 'issue',
      description: 'getRoleHomePath(ADMIN) → /guardian, RoleRouteGuard(GUARDIAN) 불일치 → 같은 곳으로 replace 반복 → 빈 화면 (src/utils/auth/routes.ts)',
    });
    const page = await openAs('anonymous', '/login');
    await page.locator('input[name="email"]').fill(ACCOUNTS.admin.email);
    await page.locator('input[name="password"]').fill(env.password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    markStale('admin');

    await page.waitForURL(url => !url.pathname.startsWith('/login'));
    // 관리자 화면이 없더라도 최소한 안내(제목/문구)는 보여야 한다
    await expect(page.getByRole('main').or(page.getByRole('heading')).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('로그아웃', () => {
  test('프로필에서 로그아웃하면 로그인 화면으로 가고, 쓰던 토큰은 더 이상 쓸 수 없다', async ({ openAs }) => {
    const page = await openAs('guardian2', '/guardian');
    const token = decodeURIComponent(
      (await page.context().cookies()).find(c => c.name === 'careai_access_token')!.value,
    );

    await page.getByRole('complementary', { name: '보호자 메뉴' }).getByRole('button', { name: /E2E보호자2/ }).click();
    const profile = page.getByRole('dialog');
    await expect(profile).toContainText(ACCOUNTS.guardian2.email);
    await profile.getByRole('button', { name: '로그아웃' }).click();
    await modal(page, '로그아웃 확인').getByRole('button', { name: '로그아웃', exact: true }).click();
    markStale('guardian2');

    await expect(page).toHaveURL(/\/login$/);
    const cookies = await page.context().cookies();
    expect(cookies.find(c => c.name === 'careai_access_token')?.value ?? '').toBe('');

    // 서버도 로그아웃된 토큰을 거부해야 한다 (Redis 블랙리스트)
    const api = await Api.fromLogin({ accessToken: token, refreshToken: '', userId: '', role: '' });
    const err = await api.get('/api/user/me').catch(e => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    await api.dispose();

    // 뒤로 가기로 보호자 화면에 돌아가도 들어갈 수 없다
    await page.goto('/guardian/medication');
    await expect(page).toHaveURL(/\/login$/);
  });
});
