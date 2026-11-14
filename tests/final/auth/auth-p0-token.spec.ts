/**
 * 최종 QA - 인증(AUTH) P0 - 토큰·쿠키 (N10 N12 N16 A20 A21 A22 A23)
 *
 * 임시 사용자만 쓴다. refresh 는 쿠키(careai_rt)로 보내는 방식으로 통일한다(본문 방식과 같은 규칙).
 */
import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { expect, test } from '../../../src/fixtures';
import { redis } from '../../../src/remote';
import { loginViaForm } from '../../../src/variables';
import { env } from '../../../src/env';
import {
  accessLogCount,
  armOnce401,
  callBe,
  cookieNames,
  expectFail,
  isClearing,
  jwtPayload,
  openMenuNav,
  parseCookie,
  pollUntil,
  refreshByCookie,
  refreshRows,
  relaxAuthRates,
  rtCookie,
  setTempUserStatus,
  sha256Hex,
  signinRaw,
  sleep,
  tokensOf,
  TAGS,
} from './_helpers-auth';

test.beforeEach(() => relaxAuthRates());

test('AUTH-N10 로그인 성공과 refresh 쿠키 속성', TAGS, async ({ tempUser, openAs }) => {
  const user = await tempUser('GUARDIAN');

  await test.step('signin 응답: access 30분, careai_rt 쿠키 속성', async () => {
    const res = await signinRaw(user.email, user.password);
    expect(res.status, `로그인 ${res.status} ${res.message}`).toBe(200);
    const { access } = tokensOf(res);
    const payload = jwtPayload(access);
    expect(payload.exp - payload.iat, 'accessToken 수명은 30분(1800초)').toBe(1800);

    const cookies = res.setCookies.map(parseCookie);
    expect(cookies.map(cookie => cookie.name), 'Set-Cookie 는 refresh 쿠키 하나뿐이다 (accessToken 을 쿠키로 주지 않는다)').toEqual(['careai_rt']);
    const cookie = cookies[0];
    expect(cookie.value.length, '쿠키 값이 비어 있지 않다').toBeGreaterThan(20);
    expect(cookie.attrs.httponly, 'HttpOnly').toBe(true);
    expect(cookie.attrs.secure, 'Secure').toBe(true);
    expect(String(cookie.attrs.samesite).toLowerCase(), 'SameSite=Lax').toBe('lax');
    expect(cookie.attrs.path, 'Path=/api/auth').toBe('/api/auth');
    expect(cookie.attrs['max-age'], '수명 7일(604800초)').toBe('604800');
    expect(cookie.attrs.domain, 'Domain 속성 없음').toBeUndefined();
  });

  await test.step('화면 로그인 뒤: 스크립트(document.cookie)로는 읽히지 않고, 브라우저에는 HttpOnly 로 저장된다', async () => {
    await relaxAuthRates();
    const page = await openAs('anonymous', '/login');
    await loginViaForm(page, user.email, user.password);
    await expect(page).toHaveURL(/\/guardian$/);
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();

    const visible = await page.evaluate(() => document.cookie);
    expect(visible, 'document.cookie 에 careai_rt 가 보이면 안 된다').not.toContain('careai_rt');
    const stored = (await page.context().cookies()).find(cookie => cookie.name === 'careai_rt');
    expect(stored, '브라우저에 careai_rt 쿠키가 저장돼야 한다 (FE 중계가 BE 의 Set-Cookie 를 전달)').toBeTruthy();
    expect(stored!.httpOnly, '저장된 쿠키는 HttpOnly').toBe(true);
    expect(stored!.secure, '저장된 쿠키는 Secure').toBe(true);
    expect(stored!.path, '저장된 쿠키 Path').toBe('/api/auth');
  });
});

test('AUTH-N12 쿠키만으로 재발급, 회전 후 옛 토큰 무효', TAGS, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');

  const first = await signinRaw(user.email, user.password);
  expect(first.status).toBe(200);
  const old = tokensOf(first).refresh;
  expect(old, '로그인 응답에 refresh 쿠키가 있어야 한다').toBeTruthy();

  const rotated = await refreshByCookie(old);
  expect(rotated.status, `쿠키만으로 재발급 ${rotated.status} ${rotated.message}`).toBe(200);
  expect(String(rotated.json.data.accessToken).split('.'), '새 access 는 JWT').toHaveLength(3);
  const fresh = rtCookie(rotated);
  expect(fresh?.value, '새 refresh 쿠키가 내려온다').toBeTruthy();
  expect(fresh!.value, '새 쿠키 값은 옛 값과 다르다 (회전)').not.toBe(old);
  expect(fresh!.attrs.path).toBe('/api/auth');

  const reused = await refreshByCookie(old);
  expectFail(reused, 401, 'INVALID_TOKEN', '회전된 옛 토큰');

  await test.step('같은 초 연속 로그인·재발급·재로그인도 오류 없음', async () => {
    const failures: string[] = [];
    for (let round = 1; round <= 3; round++) {
      await relaxAuthRates();
      const s1 = await signinRaw(user.email, user.password);
      if (s1.status !== 200) failures.push(`R${round} 로그인 ${s1.status} ${s1.code}`);
      else {
        const r = await refreshByCookie(tokensOf(s1).refresh);
        if (r.status !== 200) failures.push(`R${round} 즉시 재발급 ${r.status} ${r.code}`);
      }
      const s2 = await signinRaw(user.email, user.password);
      if (s2.status !== 200) failures.push(`R${round} 즉시 재로그인 ${s2.status} ${s2.code}`);
    }
    expect(failures, failures.join(' / ')).toEqual([]);
  });
});

test('AUTH-N16 로그아웃하면 토큰 블랙리스트와 쿠키 삭제', TAGS, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');
  const login = await signinRaw(user.email, user.password);
  expect(login.status).toBe(200);
  const { access, refresh } = tokensOf(login);

  const out = await callBe('POST', '/api/auth/logout', { token: access, headers: { Cookie: `careai_rt=${refresh}` } });
  expect(out.status, `로그아웃 ${out.status} ${out.message}`).toBe(200);
  const cleared = rtCookie(out);
  expect(isClearing(cleared), `로그아웃 응답이 careai_rt 를 만료시켜야 한다: ${out.setCookies.join(' | ').replace(/careai_rt=[^;]*/, 'careai_rt=***')}`).toBe(true);
  expect(cleared!.attrs.path, '삭제 쿠키도 같은 Path').toBe('/api/auth');

  const me = await callBe('GET', '/api/user/me', { token: access });
  expectFail(me, 401, 'LOGIN_REQUIRED', '로그아웃된 access');

  const again = await refreshByCookie(refresh);
  expect(again.status, '로그아웃 뒤 refresh 시도').toBe(401);
  expect(refreshRows(user.id), 'refresh 행이 모두 지워진다').toBe(0);

  await test.step('Redis 블랙리스트 키는 토큰 원문이 아니라 SHA-256 해시', async () => {
    const hashKey = `logout:${sha256Hex(access)}`;
    expect(redis('EXISTS', hashKey), '해시 키가 있다').toBe('1');
    const ttl = Number(redis('TTL', hashKey));
    expect(ttl, `블랙리스트 TTL(${ttl}초)은 access 남은 수명(<=1800초) 이내`).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(1800);
    expect(redis('EXISTS', `logout:${access}`), '토큰 원문을 키로 쓰지 않는다').toBe('0');
  });
});

test('AUTH-A20 폐기된 refresh 재사용: 도난 신호 vs 밀려난 토큰', TAGS, async ({ tempUser }) => {
  await test.step('(가) 회전 후 옛 refresh 재사용 + 다른 refresh 존재: 모두 폐기, TOKEN_REUSE_DETECTED 기록', async () => {
    const user = await tempUser('GUARDIAN');
    const s = await signinRaw(user.email, user.password);
    expect(s.status).toBe(200);
    const r1 = tokensOf(s).refresh;
    const rotated = await refreshByCookie(r1);
    expect(rotated.status, '첫 회전은 성공').toBe(200);
    const r2 = tokensOf(rotated).refresh;
    expect(refreshRows(user.id), '회전 뒤 행 1개').toBe(1);

    const reuse = await refreshByCookie(r1);
    expectFail(reuse, 401, 'INVALID_TOKEN', '옛 토큰 재사용');
    expect(refreshRows(user.id), '도난 신호: 사용자의 모든 refresh 폐기').toBe(0);
    const afterTheft = await refreshByCookie(r2);
    expect(afterTheft.status, '새 토큰도 함께 폐기돼 재발급 불가').toBe(401);
    const logs = await pollUntil(() => accessLogCount(user.id, 'TOKEN_REUSE_DETECTED'), n => n >= 1, 10_000);
    expect(logs, 'access_log 에 TOKEN_REUSE_DETECTED 1건').toBe(1);
  });

  await test.step('(나) 다른 기기 로그인으로 밀려난 refresh: 401 만, 새 기기 세션은 유지, 도난 기록 없음', async () => {
    await relaxAuthRates();
    const user = await tempUser('GUARDIAN');
    const a = tokensOf(await signinRaw(user.email, user.password));
    await sleep(1300); // 같은 초에 발급되면 토큰이 같아진다
    const b = tokensOf(await signinRaw(user.email, user.password));

    const stale = await refreshByCookie(a.refresh);
    expectFail(stale, 401, 'INVALID_TOKEN', '밀려난 A');
    const live = await refreshByCookie(b.refresh);
    expect(live.status, `정상 기기 B 의 갱신이 유지돼야 한다: ${live.status} ${live.code}`).toBe(200);
    expect(refreshRows(user.id), 'B 의 새 refresh 1개가 남는다').toBe(1);
    await sleep(3000); // 접속 기록은 비동기로 남는다
    expect(accessLogCount(user.id, 'TOKEN_REUSE_DETECTED'), '밀려난 토큰 사용은 도난으로 기록하지 않는다').toBe(0);
  });
});

test('AUTH-A21 토큰 종류 혼용: access 를 refresh 자리에, refresh 를 Bearer 로', TAGS, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');
  const s = await signinRaw(user.email, user.password);
  expect(s.status).toBe(200);
  const { access, refresh } = tokensOf(s);
  expect(refreshRows(user.id), '준비: refresh 행 1개').toBe(1);

  const wrongSlot = await refreshByCookie(access);
  expect(wrongSlot.status, `access 를 refresh 자리에: ${wrongSlot.status} ${wrongSlot.code}`).toBe(401);
  expect(refreshRows(user.id), 'access 를 잘못 보냈다고 세션이 폐기되지 않는다').toBe(1);

  const wrongBearer = await callBe('GET', '/api/user/me', { token: refresh });
  expect(wrongBearer.status, `refresh 를 Bearer 로: ${wrongBearer.status} ${wrongBearer.code}`).toBe(401);
  expect(refreshRows(user.id), 'refresh 를 Bearer 로 보냈다고 세션이 폐기되지 않는다').toBe(1);

  const real = await refreshByCookie(refresh);
  expect(real.status, `정상 refresh 는 여전히 유효: ${real.status} ${real.code}`).toBe(200);
});

test('AUTH-A22 쿠키만 쓸 때 Origin 이 허용 목록 밖이면 403', TAGS, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');
  const s = await signinRaw(user.email, user.password);
  expect(s.status).toBe(200);
  const t0 = tokensOf(s).refresh;

  const evil = await refreshByCookie(t0, { Origin: 'https://evil.example.com' });
  expect(evil.status, `허용 밖 Origin: ${evil.status} ${evil.code ?? evil.body.slice(0, 80)}`).toBe(403);
  expect(rtCookie(evil), '403 일 때 쿠키를 지우라고 하지 않는다 (유효한 세션을 해치지 않음)').toBeUndefined();
  expect(refreshRows(user.id), '거절된 요청이 토큰을 소비하지 않는다').toBe(1);

  const allowedOrigin = new URL(env.baseUrl).origin;
  const allowed = await refreshByCookie(t0, { Origin: allowedOrigin });
  expect(allowed.status, `허용된 Origin(${allowedOrigin}): ${allowed.status} ${allowed.code}`).toBe(200);
  const t1 = tokensOf(allowed).refresh;

  const noOrigin = await refreshByCookie(t1);
  expect(noOrigin.status, `Origin 없음: ${noOrigin.status} ${noOrigin.code}`).toBe(200);
});

test('AUTH-A23 refresh 거절 코드별 쿠키 삭제 규칙과 FE 로그인 유지', TAGS, async ({ tempUser, browser }) => {
  test.setTimeout(360_000);

  await test.step('BE: 죽은 토큰(401)은 쿠키 삭제, 429 는 쿠키를 지우지 않는다', async () => {
    const dead = await refreshByCookie('e2e.dead.token');
    expect(dead.status, `죽은 토큰 ${dead.status} ${dead.code}`).toBe(401);
    const cleared = rtCookie(dead);
    expect(isClearing(cleared), '401 이면 careai_rt 삭제 Set-Cookie').toBe(true);
    expect(cleared!.attrs.path, '삭제 쿠키 Path').toBe('/api/auth');

    // IP 한도(분당 10회)를 채워 429 를 만든다. 11번째가 429. 단언이 실패해도 내 IP 키는 꼭 비운다
    await relaxAuthRates();
    try {
      let last = dead;
      for (let i = 1; i <= 12; i++) {
        last = await refreshByCookie('e2e.dead.token');
        if (last.status === 429) break;
      }
      expectFail(last, 429, 'TOO_MANY_REQUESTS', '재발급 IP 한도');
      expect(rtCookie(last), '429(일시 오류)는 쿠키를 지우지 않는다').toBeUndefined();
    } finally {
      await relaxAuthRates();
    }
  });

  await test.step('BE: 정지된 계정(403 INACTIVE_USER)은 쿠키 삭제', async () => {
    // 임시 사용자 자신의 users.status 만 직접 바꿔(정지 리스너를 거치지 않아) refresh 행이 남은 상태를 만든다
    const user = await tempUser('GUARDIAN');
    const s = await signinRaw(user.email, user.password);
    expect(s.status, `준비 로그인 ${s.status} ${s.code}`).toBe(200);
    setTempUserStatus(user.id, 'INACTIVE');
    const res = await refreshByCookie(tokensOf(s).refresh);
    expectFail(res, 403, 'INACTIVE_USER', '비활성 계정의 refresh');
    const cleared = rtCookie(res);
    expect(isClearing(cleared), '403 INACTIVE_USER 이면 careai_rt 삭제 Set-Cookie (Max-Age=0)').toBe(true);
    expect(cleared!.attrs.path, '삭제 쿠키 Path').toBe('/api/auth');
  });

  test.info().annotations.push({
    type: '자동화 못 한 부분 (A23 BE)',
    description:
      'BE 의 404(없는 사용자)와 5xx 에서의 쿠키 규칙은 정상 계정으로는 만들 수 없다(없는 사용자는 삭제 리스너가 행을 먼저 지워 401 이 되고, 5xx 는 서버를 망가뜨려야 한다). FE 단계는 가짜 응답으로 FE 의 처리만 본다',
  });

  await test.step('FE: 재발급이 401·403·404 면 로그인 정리, 429·503 이면 로그인 유지', async () => {
    const user = await tempUser('GUARDIAN');
    const cases = [
      { status: 401, dead: true },
      { status: 403, dead: true },
      { status: 404, dead: true },
      { status: 429, dead: false },
      { status: 503, dead: false },
    ];
    const failures: string[] = [];
    for (const c of cases) {
      // 5xx 를 일부러 돌려주는 케이스라 5xx 자동 감시(openAs)를 쓰지 않고 직접 컨텍스트를 연다
      const context = await browser.newContext({ ...contextDefaults });
      await context.addInitScript(installPageStubs(), pageStubArg);
      const page = await context.newPage();
      await page.goto('/login');
      await loginViaForm(page, user.email, user.password);
      await expect(page).toHaveURL(/\/guardian$/);
      await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();
      expect(await cookieNames(page), '준비: 로그인 세션 표시 쿠키').toContain('careai_session');

      await page.route('**/api/auth/refresh', route =>
        route.fulfill({ status: c.status, json: { success: false, code: `E2E_${c.status}`, message: `E2E ${c.status}` } }),
      );
      const state = armOnce401(page);
      const menu = await openMenuNav(page, '보호자');
      state.armed = true; // 이 순간 나가는 첫 보호 API 가 401 로 바뀐다 (화면 이동이든 배경 조회든 재발급 경로는 같다)
      await menu.getByRole('link', { name: '공지사항', exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
      await expect.poll(() => state.fired, { message: '보호 API 401 유도가 실행돼야 한다' }).toBeGreaterThanOrEqual(1);

      const wentToLogin = await page.waitForURL(/\/login/, { timeout: c.dead ? 15_000 : 7_000 }).then(
        () => true,
        () => false,
      );
      const sessionKept = (await cookieNames(page)).includes('careai_session');
      if (c.dead && (!wentToLogin || sessionKept)) failures.push(`${c.status}: 로그인 정리가 안 됨 (로그인 화면 ${wentToLogin}, 세션 표시 ${sessionKept})`);
      if (!c.dead && (wentToLogin || !sessionKept)) failures.push(`${c.status}: 일시 오류인데 로그인이 풀림 (로그인 화면 ${wentToLogin}, 세션 표시 ${sessionKept})`);
      await context.close();
    }
    expect(failures, failures.join(' / ')).toEqual([]);
  });
});
