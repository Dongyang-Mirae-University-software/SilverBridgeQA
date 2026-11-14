/**
 * 최종 QA - 인증(AUTH) P1a - 화면: 로그인 안내·세션 유지·로그아웃 (A18 A28 A29 N14 N15 A26)
 *
 * 임시 사용자만 쓴다. 화면에서 일부러 만드는 오류(429·403·500·네트워크 실패)는 page.route 로 가짜 응답을 준다(서버에 닿지 않는다).
 * 로그인은 화면 로그인 폼으로 하고, 내 IP 의 로그인 한도만 비운다.
 */
import { expect, test } from '../../../src/fixtures';
import { feHost } from '../../../src/env';
import { presetFcmRegistered } from '../../../src/variables';
import { openMenuNav, sleep, uniqueSuffix } from './_helpers-auth';
import { EXPIRED_BODY, expireAccessCookie, openPlain, relaxMine, TAGS_P1, uiLogin } from './_helpers-auth-p1a';

test.beforeEach(() => relaxMine());

const alertText = (page: import('@playwright/test').Page) => page.getByRole('alert').filter({ hasText: /\S/ });

test('AUTH-A18 잠금 시 화면이 요청 제한(429)과 계정 잠금·이용 제한(403)을 구분 안내', TAGS_P1, async ({ browser }) => {
  const { page, close } = await openPlain(browser, '/login');
  try {
    const ipLimit = { code: 'TOO_MANY_REQUESTS', message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' };
    const locked = { code: 'LOGIN_LOCKED', message: '비밀번호를 5회 이상 틀렸습니다. 10분 후 다시 시도해주세요.' };
    const restricted = { code: 'INACTIVE_USER', message: '사용이 제한된 계정입니다. 고객센터에 문의해주세요.' };
    const replies = [
      { status: 429, headers: { 'Retry-After': '42' }, json: { success: false, ...ipLimit, data: { retryAfterSeconds: 42 } } },
      { status: 429, headers: { 'Retry-After': '600' }, json: { success: false, ...locked, data: { retryAfterSeconds: 600 } } },
      { status: 403, json: { success: false, ...restricted } },
    ];
    let sent = 0;
    await page.route('**/api/auth/signin', route => route.fulfill(replies[Math.min(sent++, replies.length - 1)]));

    await page.locator('input[name="email"]').fill('e2e.p1a.screen@silverbridge.test');
    await page.locator('input[name="password"]').fill('Abcdef1!x');
    const submit = page.getByRole('button', { name: '로그인', exact: true });

    const shown: string[] = [];
    for (const [label, expected] of [
      ['IP 요청 제한 429', ipLimit.message],
      ['계정 잠금 429(LOGIN_LOCKED)', locked.message],
    ] as const) {
      await submit.click();
      await expect(alertText(page), `${label}: 서버 문구로 안내`).toHaveText(expected);
      shown.push(expected);
    }

    await submit.click();
    await expect(alertText(page), '이용 제한 403 안내').toHaveText('비활성화된 계정입니다. 관리자에게 문의해주세요.');
    shown.push((await alertText(page).innerText()).trim());
    expect(new Set(shown).size, `세 가지 안내가 서로 다르다 (${shown.length}종 중 서로 다른 문구 ${new Set(shown).size}종)`).toBe(3);
    expect(sent, '로그인 요청은 세 번 나갔다').toBe(3);
    test.info().annotations.push({
      type: '문서와 다른 점',
      description:
        '문서는 서버 message/code 로 안내한다고 적었다. 배포 FE(a8666240)는 429 만 서버 message 를 쓰고, 403 은 서버 문구(사용이 제한된 계정입니다...) 대신 고정 문구(비활성화된 계정입니다...)를 보여 준다. 세 상황의 안내는 서로 다르다',
    });
  } finally {
    await close();
  }
});

test('AUTH-A28 내 정보 조회가 잠깐 실패해도 로그아웃되지 않음', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(180_000);
  const guardian = await tempUser('GUARDIAN');
  const { page, context, close } = await openPlain(browser, '/login');
  try {
    await uiLogin(page, guardian.email, guardian.password);
    await expect(page).toHaveURL(/\/guardian$/);
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();

    const calls = { me: 0, failed: 0 };
    await page.route('**/api/user/me', async route => {
      if (route.request().method() === 'GET') {
        calls.me += 1;
        if (calls.failed === 0) {
          calls.failed += 1;
          await route.fulfill({ status: 500, json: { success: false, code: 'INTERNAL_SERVER_ERROR', message: 'E2E 가짜 서버 오류' } });
          return;
        }
      }
      await route.fallback();
    });
    const visited: string[] = [];
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
    });
    await page.reload();

    await expect.poll(() => calls.failed, { message: '가짜 500 이 한 번 나갔다', timeout: 20_000 }).toBe(1);
    // 일시 오류로는 로그인 화면으로 가지 않고, 로그인 세션 표시(쿠키)도 지우지 않는다
    await expect
      .poll(async () => (await context.cookies()).find(c => c.name === 'careai_session')?.value, { message: '세션 표시 쿠키 유지', timeout: 10_000 })
      .toBe('1');
    expect(visited.includes('/login'), `로그인 화면으로 이동하면 안 된다 (이동한 경로 ${visited.join(' > ')})`).toBe(false);
    expect(page.url(), '보호자 화면에 그대로 있다').toMatch(/\/guardian/);
    // 배포 FE(a8666240) RoleRouteGuard 의 SessionRetryNotice: 안내 문구와 '다시 시도' 버튼
    const notice = page.getByRole('alert').filter({ hasText: '로그인 상태를 확인하지 못했어요' });
    await expect(notice, '로그인 상태 확인 실패 안내가 보인다').toBeVisible({ timeout: 20_000 });
    await expect(notice, '안내에 다시 시도 문구가 있다').toContainText('잠시 후 다시 시도해 주세요.');

    // 안내의 '다시 시도' 버튼만 눌러 다시 조회하면 정상으로 돌아온다(새로고침으로 대신하지 않는다)
    const callsBefore = calls.me;
    await notice.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect.poll(() => calls.me, { message: '다시 시도 버튼으로 내 정보를 다시 조회한다', timeout: 20_000 }).toBeGreaterThan(callsBefore);
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();
  } finally {
    await close();
  }
});

test('AUTH-A29 만료·옛 토큰이 남아 있어도 가입·계정 찾기가 된다', TAGS_P1, async ({ browser }) => {
  test.setTimeout(180_000);
  const { page, context, close } = await openPlain(browser, null);
  try {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const stale = `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'e2eold', role: 'GUARDIAN', exp, iat: exp - 1800 })}.e2eexpired`;
    const base = { domain: feHost, path: '/', expires: Math.floor(Date.now() / 1000) + 86_400, httpOnly: false, secure: false, sameSite: 'Lax' as const };
    await context.addCookies([
      { ...base, name: 'careai_access_token', value: encodeURIComponent(stale) },
      { ...base, name: 'careai_session', value: '1' },
      { ...base, name: 'careai_role', value: 'GUARDIAN' },
      { ...base, name: 'careai_refresh_token', value: 'e2e-stale-legacy-refresh' },
    ]);

    const answered = (suffix: string) =>
      page.waitForResponse(res => res.request().method() === 'POST' && new URL(res.url()).pathname.endsWith(suffix), { timeout: 30_000 });

    // 세 흐름을 모두 끝까지 본 뒤 결과를 한꺼번에 단언한다(앞 흐름이 막혀도 나머지 결과가 남도록 soft)
    const results: Record<string, { status: number; code?: string }> = {};
    const record = async (name: string, res: Awaited<ReturnType<typeof answered>>) => {
      const body = (await res.json().catch(() => null)) as { code?: string } | null;
      results[name] = { status: res.status(), code: body?.code };
    };

    await test.step('가입: 이메일 중복 확인', async () => {
      await page.goto('/signup');
      const reply = answered('/signup/email/check');
      await page.getByLabel('이메일').fill(`e2e.p1a.${uniqueSuffix()}@silverbridge.test`);
      await page.getByLabel('이메일').press('Tab');
      await record('가입 이메일 확인', await reply);
    });

    await test.step('비밀번호 찾기: 이메일 인증코드 요청(미가입 이메일이라 메일은 안 나간다)', async () => {
      await relaxMine();
      await page.goto('/find-password');
      await page.getByRole('button', { name: /이메일 인증/ }).click();
      await page.getByLabel('이메일').fill(`e2e.ghost.${uniqueSuffix()}@silverbridge.test`);
      const reply = answered('/find-password/email/send');
      await page.getByRole('button', { name: '인증코드 받기' }).click();
      await record('비밀번호 찾기 발송', await reply);
    });

    await test.step('아이디 찾기', async () => {
      await relaxMine();
      await page.goto('/find-email');
      await page.waitForLoadState('networkidle'); // 화면이 준비되기 전에 입력하면 입력값이 상태에 반영되지 않는다
      await page.locator('input[name="name"]').fill('E2E없는사람');
      await page.locator('input[name="phone"]').fill('01000009997');
      const reply = answered('/find-email');
      await page.getByRole('button', { name: '아이디 찾기' }).click();
      await record('아이디 찾기', await reply);
    });

    const summary = Object.entries(results).map(([name, r]) => `${name}=${r.status} ${r.code ?? ''}`).join(' | ');
    expect.soft(results['가입 이메일 확인']?.status, `가입 이메일 확인은 200 (${summary})`).toBe(200);
    expect.soft(results['비밀번호 찾기 발송'], `비밀번호 찾기 발송: 미가입이면 404 (${summary})`).toEqual({ status: 404, code: 'EMAIL_ACCOUNT_NOT_FOUND' });
    expect.soft(results['아이디 찾기'], `아이디 찾기: 미가입 이름·번호는 404 USER_NOT_FOUND (${summary})`).toEqual({ status: 404, code: 'USER_NOT_FOUND' });
    test.info().annotations.push({
      type: '원인 추정',
      description:
        '배포 FE 의 프록시(src/app/api/[...path]/route.ts)는 /auth/signin·/auth/signin/kakao·/auth/refresh 를 뺀 모든 요청에 careai_access_token 쿠키를 Bearer 로 붙인다. 브라우저의 axios 는 공개 인증 요청에 토큰을 붙이지 않지만, 프록시가 다시 붙여 만료 토큰이 BE 까지 간다',
    });
  } finally {
    await close();
  }
});

test('AUTH-N14 첫 화면 접속 때 갱신 가능하면 로그인 유지', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(180_000);
  const guardian = await tempUser('GUARDIAN');
  const { page, context, close } = await openPlain(browser, '/login');
  try {
    await uiLogin(page, guardian.email, guardian.password);
    await expect(page).toHaveURL(/\/guardian$/);
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();

    await expireAccessCookie(page); // access 만료, refresh(HttpOnly 쿠키)는 유효
    const refreshCalls: number[] = [];
    context.on('response', res => {
      if (res.url().includes('/api/auth/refresh') && res.request().method() === 'POST') refreshCalls.push(res.status());
    });
    const visited: string[] = [];
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
    });

    await page.goto('/');
    await expect(page, '갱신 뒤 보호자 홈으로 이어진다').toHaveURL(/\/guardian$/, { timeout: 30_000 });
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();
    expect(visited.includes('/login'), `로그인 화면이 뜨면 안 된다 (경로 ${visited.join(' > ')})`).toBe(false);
    expect(refreshCalls, '갱신(refresh)을 먼저 시도해 성공했다').toEqual([200]);
  } finally {
    await close();
  }
});

test('AUTH-N15 탭 2개를 동시에 써도 로그인이 유지된다', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(420_000);
  const guardian = await tempUser('GUARDIAN');
  const { page: tabA, context, close } = await openPlain(browser, '/login');
  try {
    await uiLogin(tabA, guardian.email, guardian.password);
    await expect(tabA).toHaveURL(/\/guardian$/);
    const tabB = await context.newPage();
    await tabB.goto('/guardian');
    await expect(tabB.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();

    const refreshCalls: number[] = [];
    const timeline: string[] = [];
    const t0 = Date.now();
    const tabName = (req: import('@playwright/test').Request) => (req.frame().page() === tabA ? 'A' : 'B');
    context.on('request', req => {
      if (req.url().includes('/api/auth/refresh') && req.method() === 'POST') timeline.push(`탭${tabName(req)} refresh 시작 +${Date.now() - t0}ms`);
    });
    context.on('response', res => {
      if (res.url().includes('/api/auth/refresh') && res.request().method() === 'POST') {
        refreshCalls.push(res.status());
        timeline.push(`탭${tabName(res.request())} refresh 응답 ${res.status()} +${Date.now() - t0}ms`);
      }
    });

    // 두 탭이 같은 순간 "내 정보" 조회에서 만료(401)를 받게 한다: 두 요청이 모두 도착한 뒤에 같이 401 을 돌려준다
    let armed = false;
    let arrived = 0;
    let open!: () => void;
    let gate = new Promise<void>(resolve => (open = resolve));
    let refreshDelay = 0;
    await context.route('**/api/user/me', async route => {
      if (armed && route.request().method() === 'GET' && arrived < 2) {
        arrived += 1;
        timeline.push(`탭${tabName(route.request())} /me 만료 응답 대기 +${Date.now() - t0}ms`);
        if (arrived === 2) open();
        await gate;
        await route.fulfill({ status: 401, json: EXPIRED_BODY });
        return;
      }
      if (armed && route.request().method() === 'GET') timeline.push(`탭${tabName(route.request())} /me 통과 +${Date.now() - t0}ms`);
      await route.fallback();
    });
    // 지연 단계에서만 갱신 응답을 늦춘다(서버 요청 자체는 그대로). 지연 없는 단계는 실제 속도 그대로 둔다
    await context.route('**/api/auth/refresh', async route => {
      if (refreshDelay > 0) await sleep(refreshDelay);
      await route.fallback();
    });

    const round = async (delay: number) => {
      refreshCalls.length = 0;
      timeline.length = 0;
      arrived = 0;
      gate = new Promise<void>(resolve => (open = resolve));
      refreshDelay = delay;
      armed = true;
      await Promise.all([tabA.reload(), tabB.reload()]);
      await expect.poll(() => arrived, { message: '두 탭이 모두 만료 응답을 받았다', timeout: 30_000 }).toBe(2);
      await expect(tabA.getByRole('heading', { level: 1, name: '보호자 대시보드' }), '탭 A 로그인 유지').toBeVisible({ timeout: 30_000 });
      await expect(tabB.getByRole('heading', { level: 1, name: '보호자 대시보드' }), '탭 B 로그인 유지').toBeVisible({ timeout: 30_000 });
      armed = false;
      return [...refreshCalls];
    };

    // 1단계: 갱신 응답을 1.5초 늦춰 "먼저 시작한 갱신이 끝나기 전에 다른 탭이 갱신하려는 상황"을 만든다
    const delayed = await round(1_500);
    test.info().annotations.push({ type: 'refresh 흐름(지연 1.5초)', description: timeline.join(' / ') });
    expect(delayed, `지연 1.5초: refresh 는 한 번만 돈다(직렬화) - ${timeline.join(' / ')}`).toEqual([200]);
    for (const tab of [tabA, tabB]) expect(new URL(tab.url()).pathname, '로그인 화면으로 밀려나지 않는다').toMatch(/^\/guardian/);
    expect((await context.cookies()).find(c => c.name === 'careai_session')?.value, '세션 표시 쿠키 유지').toBe('1');

    // 2단계: 지연 없는 실제 속도로 10번 반복한다. 한 번이라도 refresh 가 2번 이상 돌면 실패로 남긴다
    const counts: number[] = [];
    const twice: string[] = [];
    for (let i = 1; i <= 10; i++) {
      await relaxMine();
      const got = await round(0);
      counts.push(got.length);
      if (got.length !== 1) twice.push(`${i}회차: ${timeline.join(' / ')}`);
    }
    test.info().annotations.push({ type: 'refresh 횟수(지연 없음 10회)', description: counts.join(',') });
    expect.soft(twice, `지연 없이 10번 중 refresh 가 1번이 아닌 회차 ${twice.length}건(회차별 refresh 횟수 ${counts.join(',')}) - ${twice.join(' || ')}`).toEqual([]);
    if (twice.length > 0) {
      test.info().annotations.push({
        type: '원인 추정',
        description: 'FE apiClient 의 refreshAccessToken 이 락을 얻은 뒤 최신 토큰을 다시 확인하지 않아, 앞 갱신이 끝난 직후 다른 탭이 다시 갱신하는 것으로 보인다(AUTH-G03)',
      });
    }
  } finally {
    await close();
  }
});

test('AUTH-A26 로그아웃 요청이 실패(네트워크/5xx)해도 화면 처리', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(180_000);
  const guardian = await tempUser('GUARDIAN');
  const fakePushToken = `e2e-fake-fcm-p1a-${guardian.id}-${Date.now().toString(36)}`;
  const { page, close } = await openPlain(browser, null);
  try {
    await presetFcmRegistered(page, fakePushToken, guardian.id);
    await page.goto('/login');
    await uiLogin(page, guardian.email, guardian.password);
    await expect(page).toHaveURL(/\/guardian$/);
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();

    const calls = { logout: 0, pushDelete: 0 };
    await page.route('**/api/auth/logout', async route => {
      calls.logout += 1;
      await route.abort('failed'); // 네트워크 실패
    });
    page.on('request', req => {
      if (req.method() === 'DELETE' && req.url().includes('/notifications/fcm-token')) calls.pushDelete += 1;
    });

    const menu = await openMenuNav(page, '보호자');
    await expect(menu).toBeVisible();
    await page.getByRole('complementary', { name: /메뉴$/ }).getByRole('button', { name: new RegExp(guardian.name) }).click();
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '로그아웃', exact: true }).click();

    test.info().annotations.push({
      type: '기획 확인 필요',
      description:
        '케이스 기대값이 "기기 로그인 정보는 정리 또는 실패 안내"로 둘 중 하나다. 배포 FE(a8666240) mutations.ts 는 누르자마자 세션을 지우고 로그인 화면으로 보내며 서버 정리 실패는 삼킨다(의도된 설계). 이 시험은 "실패 안내 + 푸시 주소는 성공 뒤에만 삭제" 쪽으로 단언한다. 기획이 한쪽으로 확정해야 한다',
    });
    await expect.poll(() => calls.logout, { message: '로그아웃 요청이 나갔다(가짜 실패)', timeout: 20_000 }).toBe(1);
    await expect(page.getByText(/로그아웃.{0,20}(못|실패|오류)/).first(), '로그아웃 실패 안내가 보여야 한다').toBeVisible({ timeout: 10_000 });
    expect.soft(calls.pushDelete, '푸시 주소는 로그아웃이 성공한 뒤에만 지운다 - 실패했으니 삭제 요청이 없어야 한다').toBe(0);
  } finally {
    await close();
  }
});
