/**
 * 변수 QA - 횡단(인증 세션·토큰·이메일) 중간 심각도 항목
 *
 * 부작용 차단: 임시 사용자만 쓴다. SMS·메일이 나가는 API 는 부르지 않고, 이메일 중복 확인처럼
 * 발송이 없는 공개 API 만 호출한다. 서버 장애는 브라우저 page.route 로 흉내 내거나(서버 무영향),
 * 임시 사용자 한 명의 Redis 키만 일시적으로 망가뜨렸다가 바로 지운다.
 */
import { request } from '@playwright/test';

import { Api, ApiError } from '../../src/api';
import { env, feHost } from '../../src/env';
import { AdHocUser, expect, nav, test } from '../../src/fixtures';
import { psql, redis, redisDelPattern, remoteBash, sqlStr } from '../../src/remote';
import { relaxRateLimits } from '../../src/seed';
import { presetFcmRegistered, fcmTokenCount } from '../../src/variables';

const EMAIL_CHECK = '/api/auth/signup/email/check';
const ACCESS_COOKIE = 'careai_access_token';
const REFRESH_COOKIE = 'careai_refresh_token';
/** dev FE(next dev) 컨테이너. XCUT-G18 에서 읽기 전용으로만 쓴다 */
const FE_CONTAINER = 'silver-bridge-fe-dev-web';

function unusedEmail() {
  return `e2e.nobody.${Date.now().toString(36)}@silverbridge.test`;
}

function b64url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** 서명이 틀리고 exp 가 지난 JWT (만료·위조 쿠키 토큰 흉내). FE 서버 컴포넌트와 BE 필터 모두 이걸 무효로 본다 */
function expiredJwt(sub: string, role: string) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role, typ: 'access', iat: now - 7200, exp: now - 3600 })}.${'x'.repeat(43)}`;
}

/** 로그인 결과의 access 토큰만 만료 토큰으로 바꾼 브라우저 로그인 정보 (refresh 토큰은 유효) */
function withExpiredAccess(who: AdHocUser, userId: string, role: string): AdHocUser {
  return { label: `${who.label}(access 만료)`, login: { ...who.login, accessToken: expiredJwt(userId, role) } };
}

function fakeToken(userId: string) {
  return `e2e-fake-fcm-${userId}-${Date.now().toString(36)}`;
}

async function cookieNames(page: import('@playwright/test').Page) {
  return (await page.context().cookies()).map(c => c.name);
}

test.describe('횡단 - 세션·토큰', () => {
  test('[XCUT-G01] 만료·위조 토큰 쿠키가 남아 있어도 가입·계정 찾기 같은 공개 API 는 막히지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    redisDelPattern('rate:email-check:*');

    const page = await openAs(who, '/signup');
    // 로그인 후 30분이 지나 access 쿠키가 만료된 상태 (refresh 쿠키는 7일 유효)
    await page.context().addCookies([
      { name: ACCESS_COOKIE, value: encodeURIComponent(expiredJwt(user.id, 'GUARDIAN')), domain: feHost, path: '/' },
    ]);

    await test.step('만료 토큰 쿠키가 있는 채로 이메일 중복 확인', async () => {
      const res = await page.request.post(EMAIL_CHECK, { data: { email: unusedEmail() } });
      expect
        .soft(res.status(), `FE 프록시가 만료 쿠키 토큰을 공개 경로에 붙이고 BE 필터가 401 로 끝낸다: ${await res.text()}`)
        .toBe(200);
    });

    await test.step('대조: 쿠키를 지우면 같은 호출이 성공한다', async () => {
      await page.context().clearCookies();
      const res = await page.request.post(EMAIL_CHECK, { data: { email: unusedEmail() } });
      expect(res.status(), `쿠키 없이도 실패하면 이 테스트의 전제가 틀린 것: ${await res.text()}`).toBe(200);
    });
  });

  test('[XCUT-G03] Redis 조회가 실패해도 인증 API 는 500/401 로 무너지지 않고 세션도 유지된다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api, who } = await loginAs(user);
    // 필터가 GET 으로 읽는 키를 LIST 로 만들어 WRONGTYPE 예외를 낸다 (이 임시 사용자 한 명에게만 영향)
    const key = `password:invalidate:${user.id}`;
    try {
      redis('RPUSH', key, 'corrupt');

      const res = await api.raw('GET', '/api/user/me');
      const body = await res.text();
      test.info().annotations.push({ type: 'Redis 오류 시 /api/user/me', description: `${res.status()} ${body.slice(0, 200)}` });
      expect
        .soft([200, 503], `Redis 오류가 인증 필터 밖으로 새어 요청이 실패한다 (${res.status()}): ${body.slice(0, 200)}`)
        .toContain(res.status());

      const page = await openAs(who, '/guardian');
      await page.waitForTimeout(4_000);
      expect(page.url(), 'Redis 일시 오류에 FE 가 세션을 지우고 로그인 화면으로 보낸다').not.toMatch(/\/login/);
      await expect(nav(page, 'GUARDIAN')).toBeVisible();
    } finally {
      redis('DEL', key);
    }
  });

  test('[XCUT-G05] 토큰 갱신이 429 나 네트워크 오류로 실패해도 세션은 유지된다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);

    await test.step('(a) access 만료 + 갱신 API 가 429(IP 레이트리밋)', async () => {
      const page = await openAs(withExpiredAccess(who, user.id, 'GUARDIAN'), null);
      await page.route('**/api/auth/refresh', route =>
        route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, code: 429, message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' }),
        }),
      );
      const refreshed = page.waitForResponse(res => res.url().includes('/api/auth/refresh'), { timeout: 15_000 }).catch(() => null);
      await page.goto('/guardian');
      await refreshed;
      await page.waitForTimeout(2_500);

      expect.soft(page.url(), '갱신이 429 로 실패했을 뿐인데 로그인 화면으로 보낸다').not.toMatch(/\/login/);
      expect.soft(await cookieNames(page), '갱신 실패(429)에 토큰 쿠키를 지워 강제 로그아웃한다').toContain(REFRESH_COOKIE);
    });

    await test.step('(b) 갱신 API 가 네트워크 오류', async () => {
      const page = await openAs(withExpiredAccess(who, user.id, 'GUARDIAN'), null);
      await page.route('**/api/auth/refresh', route => route.abort('failed'));
      const failed = page.waitForEvent('requestfailed', { predicate: r => r.url().includes('/api/auth/refresh'), timeout: 15_000 }).catch(() => null);
      await page.goto('/guardian');
      await failed;
      await page.waitForTimeout(2_500);

      expect.soft(page.url(), '네트워크 순단에 로그인 화면으로 보낸다').not.toMatch(/\/login/);
      expect.soft(await cookieNames(page), '네트워크 오류에 토큰 쿠키를 지워 강제 로그아웃한다').toContain(REFRESH_COOKIE);
    });

    await test.step('(c) 프로필 조회(/api/user/me)가 네트워크 오류', async () => {
      const page = await openAs(who, null);
      await page.route('**/api/user/me', route => route.abort('failed'));
      const failed = page.waitForEvent('requestfailed', { predicate: r => r.url().includes('/api/user/me'), timeout: 15_000 }).catch(() => null);
      await page.goto('/guardian');
      await failed;
      await page.waitForTimeout(2_500);

      expect.soft(page.url(), '프로필 조회가 일시 실패했을 뿐인데 로그인 화면으로 보낸다').not.toMatch(/\/login/);
      expect.soft(await cookieNames(page), '프로필 조회 실패에 토큰 쿠키를 지워 강제 로그아웃한다').toContain(REFRESH_COOKIE);
    });
  });

  test('[XCUT-G06] 같은 브라우저의 여러 탭이 번갈아 토큰을 갱신해도 전체 세션이 폐기되지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    relaxRateLimits();

    // 탭 A 를 열고, 같은 컨텍스트(쿠키 공유)에서 탭 B 를 연다
    const tabA = await openAs(who, '/guardian');
    await expect(nav(tabA, 'GUARDIAN')).toBeVisible();
    const tabB = await tabA.context().newPage();
    await tabB.goto('/guardian');
    await expect(nav(tabB, 'GUARDIAN')).toBeVisible();

    /** 다음 인증 GET 한 번을 401 로 바꿔, 화면을 새로 고치지 않고도 FE 의 토큰 갱신을 일으킨다 */
    async function makeArmable(page: typeof tabA) {
      let armed = false;
      await page.route(
        url => url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/auth/'),
        route => {
          if (armed && route.request().method() === 'GET') {
            armed = false;
            return route.fulfill({
              status: 401,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, code: 401, message: '로그인이 필요합니다.' }),
            });
          }
          return route.continue();
        },
      );
      return {
        async refreshVia(menu: string) {
          armed = true;
          // 백그라운드 탭은 렌더링이 멈춰 클라이언트 이동이 진행되지 않으므로 앞으로 가져온다
          await page.bringToFront();
          const refreshed = page.waitForResponse(res => res.url().includes('/api/auth/refresh'), { timeout: 15_000 }).catch(() => null);
          await nav(page, 'GUARDIAN').getByRole('link', { name: menu, exact: true }).click();
          const res = await refreshed;
          await page.waitForTimeout(1_500);
          return res?.status() ?? null;
        },
      };
    }
    const a = await makeArmable(tabA);
    const b = await makeArmable(tabB);

    const refreshRows = () => Number(psql(`SELECT count(*) FROM refresh_token WHERE user_id = ${sqlStr(user.id)};`));
    const reuseLogs = () =>
      Number(psql(`SELECT count(*) FROM access_log WHERE user_id = ${sqlStr(user.id)} AND action = 'TOKEN_REUSE_DETECTED';`));

    expect(refreshRows(), '준비: 로그인 직후 refresh 토큰 1개').toBe(1);

    expect(await a.refreshVia('공지사항'), '탭 A 의 첫 갱신은 성공해야 한다').toBe(200);
    expect(await b.refreshVia('피보호자 관리'), '탭 B 의 갱신도 (쿠키의 최신 토큰으로) 성공해야 한다').toBe(200);

    // 탭 A 의 메모리에는 첫 갱신 때 받은 오래된 refresh 토큰이 남아 있다
    const third = await a.refreshVia('복약 관리');
    test.info().annotations.push({ type: '탭 A 세 번째 갱신 상태', description: String(third) });

    expect.soft(reuseLogs(), '탭 간 정상 갱신이 토큰 재사용(도난)으로 오탐되어 TOKEN_REUSE_DETECTED 가 기록된다').toBe(0);
    expect.soft(refreshRows(), '재사용 감지가 이 사용자의 모든 refresh 토큰을 폐기해 두 탭 모두 로그아웃된다').toBeGreaterThan(0);
    expect(tabA.url(), '탭 A 가 로그인 화면으로 쫓겨난다').not.toMatch(/\/login/);
  });

  test('[XCUT-G13] 로그아웃 API 가 실패하면 오류를 알리거나 로컬 세션을 정리하고, 성공하기 전에 푸시 구독부터 지우지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api, who } = await loginAs(guardian);
    const token = fakeToken(guardian.id);
    await api.post('/api/notifications/fcm-token', { token, platform: 'WEB' });
    expect(fcmTokenCount({ token }), '준비: 이 기기 푸시 토큰이 서버에 있다').toBe(1);

    const page = await openAs(who, null);
    await presetFcmRegistered(page, token, guardian.id);
    // 로그아웃만 일시 실패(429)시키고 FCM 토큰 삭제 등 나머지는 그대로 서버로 보낸다
    await page.route('**/api/auth/logout', route =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, code: 429, message: '요청이 너무 많습니다.' }),
      }),
    );
    await page.goto('/guardian');
    await expect(nav(page, 'GUARDIAN')).toBeVisible();

    await page.getByRole('complementary', { name: /메뉴$/ }).getByRole('button', { name: new RegExp(guardian.name) }).click();
    await page.getByRole('dialog').getByRole('button', { name: '로그아웃' }).click();
    const logoutResponse = page.waitForResponse(res => res.url().includes('/api/auth/logout'), { timeout: 15_000 });
    await page.getByRole('alertdialog', { name: '로그아웃 확인' }).getByRole('button', { name: '로그아웃', exact: true }).click();
    await logoutResponse;
    await page.waitForTimeout(2_500);

    const names = await cookieNames(page);
    const sessionKept = !/\/login/.test(page.url()) && names.includes(ACCESS_COOKIE);
    const errorShown = (await page.getByText(/실패|오류|다시 시도|문제가 발생|너무 많/).count()) > 0;
    test.info().annotations.push({ type: '로그아웃 실패 후 상태', description: `url=${page.url()} 세션유지=${sessionKept} 오류표시=${errorShown}` });

    expect.soft(!sessionKept || errorShown, '로그아웃이 실패했는데 아무 안내 없이 로그인 상태가 그대로다').toBe(true);
    if (sessionKept) {
      expect
        .soft(fcmTokenCount({ token }), '로그아웃이 성공하기도 전에 서버의 이 기기 푸시 토큰만 먼저 지워졌다 (세션은 그대로)')
        .toBe(1);
    }
  });

  test('[XCUT-G14] 사이트 루트(/)로 들어와도 access 만료 + refresh 유효면 재로그인 없이 복구된다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    relaxRateLimits();

    // 30분 이상 지나 access 쿠키만 만료된 상태 (refresh 쿠키는 7일 유효)
    const page = await openAs(withExpiredAccess(who, user.id, 'GUARDIAN'), '/');

    await expect(page, '루트가 refresh 쿠키를 보지 않고 곧바로 로그인 화면으로 보낸다').toHaveURL(/\/guardian/, { timeout: 10_000 });
    await expect(nav(page, 'GUARDIAN')).toBeVisible();
  });
});

test.describe('횡단 - 계정·설정', () => {
  test('[XCUT-G16] 이메일은 대소문자를 구분하지 않고 중복 확인·로그인에 쓰인다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    // 가입 때 "E2E.Temp..." 처럼 대문자를 섞어 입력한 계정 (e2e. 접두어는 정리 패턴 때문에 소문자로 둔다)
    const [local, domain] = user.email.split('@');
    const mixed = `e2e.${local.slice('e2e.'.length).toUpperCase()}@${domain}`;
    expect(mixed).not.toBe(user.email);
    psql(`UPDATE users SET email = ${sqlStr(mixed)} WHERE id = ${sqlStr(user.id)};`);

    redisDelPattern('rate:email-check:*');
    relaxRateLimits();

    await test.step('소문자 이메일로 중복 확인 -> 이미 가입된 이메일이어야 한다', async () => {
      const ctx = await request.newContext({ baseURL: env.apiUrl });
      const res = await ctx.post(EMAIL_CHECK, { data: { email: user.email } });
      expect
        .soft(res.status(), `대소문자만 다른 이메일을 사용 가능(200)으로 판정해 중복 계정 가입이 열린다: ${await res.text()}`)
        .not.toBe(200);
      await ctx.dispose();
    });

    await test.step('소문자 이메일로 로그인 -> 같은 계정으로 로그인돼야 한다', async () => {
      const error = await Api.signinWithRetry(user.email, user.password).then(
        () => null,
        (e: unknown) => e,
      );
      const detail = error instanceof ApiError ? `${error.status} ${error.body.slice(0, 150)}` : String(error);
      expect.soft(error, `가입 때와 대소문자가 다르다는 이유로 로그인이 거부된다: ${detail}`).toBeNull();
    });
  });

  test('[XCUT-G18] 예약 BFF 프록시는 소스에 박힌 기본 시크릿으로 계정 비밀번호를 만들지 않는다', async () => {
    // 외부 예약 서비스에 계정을 만들거나 로그인하지 않고, dev FE 컨테이너를 읽기만 해서 판정한다.
    // 시크릿 값은 출력하지도 저장소에 적지도 않고, 설정 여부(UNSET/SET)만 받는다.
    const out = remoteBash(`
C=${FE_CONTAINER}
R='/app/src/app/api/reservation/[...path]/route.ts'
if docker exec $C grep -qE "RESERVATION_ACCOUNT_SECRET[[:space:]]*(\\?\\?|\\|\\|)[[:space:]]*['\\"]" "$R"; then echo "FALLBACK=yes"; else echo "FALLBACK=no"; fi
docker exec $C sh -c 'if [ -z "\${RESERVATION_ACCOUNT_SECRET+x}" ]; then echo PROC=UNSET; else echo PROC=SET; fi'
# next dev 가 읽는 .env 파일들(.env, .env.local, .env.development, .env.development.local)
docker exec $C sh -c 'cd /app; n=0; for f in .env .env.local .env.development .env.development.local; do [ -f "$f" ] && grep -qE "^[[:space:]]*(export[[:space:]]+)?RESERVATION_ACCOUNT_SECRET=.+" "$f" && n=$((n+1)); done; echo FILES=$n'
`);
    const kv = Object.fromEntries(
      out.trim().split('\n').map(line => line.trim().split('=') as [string, string]),
    );
    expect(kv.FALLBACK, '실행 중인 dev FE 의 route.ts 를 읽지 못함(경로 확인 필요)').toBeDefined();

    // 올바른 동작: 폴백이 없거나(미설정 시 실패), 적어도 dev 서버에 기본값이 아닌 시크릿이 설정돼 있어야 한다
    const secretConfigured = kv.PROC === 'SET' || Number(kv.FILES) > 0;
    expect(
      kv.FALLBACK === 'no' || secretConfigured,
      `dev FE 가 RESERVATION_ACCOUNT_SECRET 없이 소스의 기본값으로 동작함 (route.ts 폴백=${kv.FALLBACK}, 컨테이너 env=${kv.PROC}, .env 파일 설정 수=${kv.FILES}). ` +
        '누구나 HMAC(기본 시크릿, userId) 로 sb-{userId}@silverbridge.local 예약 서비스 계정 비밀번호를 계산할 수 있다',
    ).toBe(true);
  });
});
