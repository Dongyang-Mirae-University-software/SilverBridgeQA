/**
 * 변수 QA - 인증 (medium 등급)
 *
 * AUTH-G01, G03, G04, G09, G12, G14, G16, G17, G21, G31.
 * 모든 테스트는 "올바른 동작"을 단언하므로 결함이 있는 동안에는 실패한다.
 *
 * 부작용 원칙:
 * - 임시 사용자(tempUser)와 이 파일이 만든 행만 다룬다.
 * - SMS·메일은 보내지 않는다: 인증코드·nonce 는 Redis 에 직접 넣고, 인증번호 발송/확인 화면 API 는 page.route 로 대체한다.
 * - 비밀번호 찾기 발송 API(find-password/*\/send)와 가입 SMS 발송 API 는 호출하지 않는다.
 */
import { randomUUID } from 'node:crypto';

import { Page, request } from '@playwright/test';

import { ADDRESS, signupEmail } from '../../src/accounts';
import { contextDefaults, installPageStubs, pageStubArg } from '../../src/browser';
import { env } from '../../src/env';
import { expect, nav, test } from '../../src/fixtures';
import { psql, redis, redisDelPattern, sqlStr } from '../../src/remote';
import { relaxRateLimits, uniqueTestPhone } from '../../src/seed';
import { tokenCookies } from '../../src/session';
import { loginViaForm } from '../../src/variables';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Raw {
  status: number;
  body: string;
}

/** BE 를 직접 호출한다 (FE 프록시·쿠키 없이) */
async function post(path: string, data: unknown): Promise<Raw> {
  const ctx = await request.newContext({ baseURL: env.apiUrl });
  try {
    const res = await ctx.post(path, { data });
    return { status: res.status(), body: await res.text() };
  } finally {
    await ctx.dispose();
  }
}

function signinRaw(email: string, password: string) {
  return post('/api/auth/signin', { email, password });
}

function refreshRaw(refreshToken: string) {
  return post('/api/auth/refresh', { refreshToken });
}

function tokensOf(raw: Raw) {
  const data = (JSON.parse(raw.body) as { data: { accessToken: string; refreshToken: string } }).data;
  return { access: data.accessToken, refresh: data.refreshToken };
}

function messageOf(raw: Raw) {
  try {
    return (JSON.parse(raw.body) as { message?: string }).message ?? raw.body.slice(0, 200);
  } catch {
    return raw.body.slice(0, 200);
  }
}

/** 다음에 나가는 보호 API(auth 제외) 요청 하나를 401 로 바꿔, FE 의 재발급 경로를 태운다 */
function armOnce401(page: Page) {
  const state = { armed: false, fired: 0 };
  void page.route('**/api/**', async route => {
    if (state.armed && !route.request().url().includes('/api/auth/')) {
      state.armed = false;
      state.fired += 1;
      await route.fulfill({
        status: 401,
        json: { success: false, message: '로그인 세션이 만료되었습니다. 다시 로그인해주세요.' },
      });
      return;
    }
    // 다른 라우트(예: 재발급 mock)가 이어서 처리하도록 넘긴다
    await route.fallback();
  });
  return state;
}

async function refreshCookie(page: Page) {
  return (await page.context().cookies()).find(cookie => cookie.name === 'careai_refresh_token')?.value;
}

test.beforeEach(() => relaxRateLimits());

test.describe('로그인 잠금·비밀번호 재설정', () => {
  test('[AUTH-G01] 비밀번호 재설정에 성공하면 로그인 잠금이 풀려 새 비밀번호로 바로 로그인할 수 있다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const newPassword = 'NewPass1!x';

    try {
      await test.step('준비: 오답 5회로 계정 잠금 (5번째까지 401, 이후 429)', async () => {
        for (let i = 1; i <= 5; i++) {
          const res = await signinRaw(user.email, 'Wrong1!pass');
          expect(res.status, `오답 ${i}회째는 401 이어야 한다: ${res.body}`).toBe(401);
        }
        const locked = await signinRaw(user.email, user.password);
        expect(locked.status, `6번째 시도는 잠금(429)이어야 한다: ${locked.body}`).toBe(429);
      });

      await test.step('비밀번호 재설정 성공 (메일 발송 없이 인증코드를 Redis 에 직접 주입)', async () => {
        redis('SET', `password:email:verify:${user.email}`, '123456', 'EX', '300');
        const reset = await post('/api/auth/password/reset', { email: user.email, code: '123456', newPassword });
        expect(reset.status, `재설정이 성공해야 한다: ${reset.body}`).toBe(200);
      });

      await test.step('새 비밀번호로 로그인', async () => {
        // 재설정 직후 같은 초에 받은 토큰은 무효화 기준과 겹칠 수 있어(AUTH-G06) 1초 이상 띄운다
        await sleep(1300);
        relaxRateLimits();
        const after = await signinRaw(user.email, newPassword);
        const ttl = redis('TTL', `login:lock:${user.id}`);
        test.info().annotations.push({ type: 'login:lock TTL(초)', description: ttl });
        expect(
          after.status,
          `본인 확인(인증코드)으로 비밀번호를 재설정했는데도 로그인 잠금이 남아 있다: ${after.status} ${messageOf(after)} (login:lock TTL ${ttl}초)`,
        ).toBe(200);
      });
    } finally {
      redisDelPattern(`login:*:${user.id}`);
    }
  });
});

test.describe('refresh 토큰', () => {
  test('[AUTH-G03] 다른 기기 로그인으로 밀려난 기기의 갱신 시도가 새 기기의 세션까지 끊지 않는다 (다중 기기·다중 탭)', async ({
    tempUser,
    loginAs,
    openAs,
  }) => {
    await test.step('(a) 기기 A 로그인 후 기기 B 로그인 - A 가 갱신을 시도해도 B 의 refresh 는 유효해야 한다', async () => {
      const user = await tempUser('GUARDIAN');
      const a = tokensOf(await signinRaw(user.email, user.password));
      await sleep(1300); // 같은 초에 발급되면 JWT 가 같아진다(AUTH-G04)
      const b = tokensOf(await signinRaw(user.email, user.password));

      const staleRefresh = await refreshRaw(a.refresh);
      expect(staleRefresh.status, `단일 기기 정책으로 밀려난 A 의 갱신은 거절된다: ${staleRefresh.body}`).toBe(401);

      const bRefresh = await refreshRaw(b.refresh);
      expect
        .soft(
          bRefresh.status,
          `밀려난 A 의 옛 토큰이 '재사용'으로 판정돼 사용자의 모든 refresh 가 폐기됐다. 정상인 B 의 갱신이 ${bRefresh.status}: ${messageOf(bRefresh)}`,
        )
        .toBe(200);
    });

    await test.step('(b) 같은 브라우저 두 탭 - 한 탭이 재발급한 뒤 다른 탭이 갱신해도 로그아웃되지 않는다', async () => {
      const user = await tempUser('GUARDIAN');
      const { who } = await loginAs(user);
      const pageA = await openAs(who, '/guardian');
      await expect(nav(pageA, 'GUARDIAN')).toBeVisible();
      const pageB = await pageA.context().newPage();
      await pageB.goto('/guardian');
      await expect(nav(pageB, 'GUARDIAN')).toBeVisible();
      const stateA = armOnce401(pageA);
      const stateB = armOnce401(pageB);
      const before = await refreshCookie(pageA);

      // 탭 A: 보호 API 가 401 이 되어 실제 /api/auth/refresh 로 재발급 (쿠키의 refresh 가 회전된다)
      stateA.armed = true;
      await nav(pageA, 'GUARDIAN').getByRole('link', { name: '공지사항', exact: true }).click();
      await expect.poll(() => stateA.fired, { message: '탭 A 의 401 유도가 실행돼야 한다' }).toBe(1);
      await expect.poll(() => refreshCookie(pageA), { timeout: 20_000, message: '탭 A 가 재발급되어 쿠키의 refresh 가 바뀐다' }).not.toBe(before);

      // 탭 B: 모듈 변수에 캐시한 옛 refresh 로 재발급을 시도한다
      stateB.armed = true;
      await nav(pageB, 'GUARDIAN').getByRole('link', { name: '공지사항', exact: true }).click();
      await expect.poll(() => stateB.fired, { message: '탭 B 의 401 유도가 실행돼야 한다' }).toBe(1);
      const leftToLogin = await pageB.waitForURL(/\/login/, { timeout: 10_000 }).then(
        () => true,
        () => false,
      );
      expect
        .soft(leftToLogin, '탭 B 가 옛 refresh 로 갱신하다 재사용 판정을 받아 세션이 전부 폐기되고 /login 으로 쫓겨났다 (쿠키의 최신 토큰을 다시 읽어야 한다)')
        .toBe(false);
    });
  });

  test('[AUTH-G04] 같은 초에 refresh 를 만들어도 UNIQUE 충돌(409) 없이 정상 발급된다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const results: string[] = [];
    const failures: string[] = [];
    const note = (label: string, raw: Raw) => {
      results.push(`${label}:${raw.status}`);
      if (raw.status !== 200) failures.push(`${label} -> ${raw.status} ${messageOf(raw)}`);
    };

    // 로그인 직후 곧바로 재발급, 로그인 직후 곧바로 재로그인 - 지연 없이 연속 호출해 같은 초에 겹치게 한다
    for (let round = 1; round <= 4; round++) {
      relaxRateLimits();
      const s1 = await signinRaw(user.email, user.password);
      note(`R${round} 로그인`, s1);
      if (s1.status !== 200) continue;
      note(`R${round} 즉시 재발급`, await refreshRaw(tokensOf(s1).refresh));
      note(`R${round} 즉시 재로그인`, await signinRaw(user.email, user.password));
      note(`R${round} 즉시 재로그인2`, await signinRaw(user.email, user.password));
    }

    test.info().annotations.push({ type: '호출 결과', description: results.join(', ') });
    expect(failures, `같은 초에 발급된 refresh JWT 가 동일 문자열이라 UNIQUE 충돌로 실패한다:\n${failures.join('\n')}`).toEqual([]);
  });
});

test.describe('이메일 대소문자', () => {
  test('[AUTH-G09] 이메일은 대소문자를 구분하지 않아 중복 확인·로그인·가입이 같은 계정으로 취급된다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const upper = user.email.toUpperCase();
    expect(upper).not.toBe(user.email);
    expect(upper.startsWith('E2E.TEMP.'), '정리 안전장치: 이 테스트가 만든 임시 이메일만 다룬다').toBe(true);

    await test.step('(a) 이메일 중복 확인: 대문자로 써도 이미 사용 중(409)', async () => {
      const res = await post('/api/auth/signup/email/check', { email: upper });
      expect.soft(res.status, `대문자로 바꾼 기존 이메일이 사용 가능(${res.status})으로 나온다: ${messageOf(res)}`).toBe(409);
    });

    await test.step('(b) 로그인: 가입 때와 대소문자가 달라도 올바른 비밀번호면 로그인된다', async () => {
      const res = await signinRaw(upper, user.password);
      expect.soft(res.status, `대문자 이메일 + 정답 비밀번호가 ${res.status}: ${messageOf(res)}`).toBe(200);
    });

    await test.step('(c) 가입: 대소문자만 다른 이메일로 두 번째 계정을 만들 수 없다 (SMS 인증은 Redis 로 대체)', async () => {
      const phone = uniqueTestPhone();
      const nonce = randomUUID();
      redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');
      try {
        const res = await post('/api/auth/signup', {
          name: 'E2E대소문자',
          email: upper,
          password: env.password,
          phone,
          verificationNonce: nonce,
          role: 'GUARDIAN',
          address: ADDRESS.address,
          addressDetail: ADDRESS.addressDetail,
          gender: 'MALE',
          birthDate: '1985-04-15',
          postcode: ADDRESS.postcode,
        });
        expect.soft(res.status, `대소문자만 다른 이메일로 별개 계정이 가입됐다: ${res.status} ${messageOf(res)}`).toBe(409);
      } finally {
        // 가입이 통과했다면 만든 행을 정확히 지운다 (이 테스트가 만든 대문자 이메일만)
        psql(`DELETE FROM users WHERE email = ${sqlStr(upper)};`);
        redis('DEL', `sms:verified:${phone}`);
      }
    });
  });
});

test.describe('가입 화면 입력 규칙', () => {
  test('[AUTH-G12] 가입 화면의 비밀번호·이메일 검증이 서버 규칙(영문+숫자+특수문자, 8~64자, + 허용 이메일)과 같다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/signup');
    const password = page.getByPlaceholder('8자 이상');
    const email = page.getByPlaceholder('example@email.com');
    const passwordError = page.getByText('비밀번호 형식이 올바르지 않습니다.');
    const emailError = page.getByText('이메일 형식이 올바르지 않습니다.');
    const settle = () => page.waitForTimeout(1200);

    await test.step("영문이 없는 '12345678!' 는 서버가 거부하므로 화면도 형식 오류를 보여야 한다", async () => {
      await password.fill('12345678!');
      await settle();
      await expect.soft(passwordError, "영문 없는 '12345678!' 를 화면이 통과시킨다 (서버는 영문 필수로 400)").toHaveCount(1, { timeout: 2000 });
    });

    await test.step("한글이 섞인 'Passw0rd!한글' 도 서버 허용 문자가 아니므로 화면이 거부해야 한다", async () => {
      await password.fill('Passw0rd!한글');
      await settle();
      await expect.soft(passwordError, '한글이 든 비밀번호를 화면이 통과시킨다').toHaveCount(1, { timeout: 2000 });
    });

    await test.step('64자를 넘는 비밀번호는 서버가 거부하므로 화면도 거부해야 한다', async () => {
      await password.fill(`Aa1!${'a'.repeat(70)}`);
      await settle();
      await expect.soft(passwordError, '74자 비밀번호를 화면이 통과시킨다 (최대 길이 검사 없음)').toHaveCount(1, { timeout: 2000 });
    });

    await test.step("서버가 허용하는 특수문자 '_' 만 쓴 'Passw0rd_' 는 화면이 막지 않아야 한다", async () => {
      await password.fill('Passw0rd_');
      await settle();
      await expect.soft(passwordError, "서버가 허용하는 'Passw0rd_' 를 화면이 형식 오류로 막는다").toHaveCount(0, { timeout: 2000 });
    });

    await test.step("'+' 가 든 유효한 이메일은 화면이 막지 않아야 한다", async () => {
      await email.fill(`e2e.plus+tag${Date.now().toString(36)}@silverbridge.test`);
      await email.blur();
      await settle();
      await expect.soft(emailError, "서버가 허용하는 '+' 이메일을 화면이 형식 오류로 막는다").toHaveCount(0, { timeout: 2000 });
    });
  });
});

test.describe('로그인 화면 오류 문구', () => {
  test('[AUTH-G14] IP 요청 제한(429)과 계정 잠금을 구분해 안내하고, 제한 계정은 서버 사유를 보여준다', async ({ tempUser, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const page = await openAs('anonymous', '/login');
    const errorText = page.locator('[class*="errorMessage"]').first();

    try {
      await test.step('IP 레이트리밋 초과: 비밀번호를 틀리지 않았는데 "5회 틀려 30분 제한" 이라고 안내하면 안 된다', async () => {
        // 화면(FE 프록시)이 BE 에 보이는 IP 의 카운터 키를 만들고, 한도(10회)까지 채워 둔다
        await page.request.post('/api/auth/signin', { data: { email: 'e2e.nobody@silverbridge.test', password: 'Wrong1!pass' } });
        const keys = redis('--scan', '--pattern', 'rate:signin:*').split('\n').filter(Boolean);
        expect(keys.length, 'rate:signin 카운터 키를 찾지 못했다 (환경 확인 필요)').toBeGreaterThan(0);
        for (const key of keys) redis('SET', key, '10', 'EX', '60');

        await page.locator('input[name="email"]').fill(user.email);
        await page.locator('input[name="password"]').fill(user.password);
        await page.getByRole('button', { name: '로그인', exact: true }).click();

        await expect(errorText).toBeVisible();
        const shown = (await errorText.textContent()) ?? '';
        test.info().annotations.push({ type: '429 화면 문구', description: shown });
        expect.soft(shown, `정답 비밀번호인데 IP 요청 제한(TOO_MANY_REQUESTS)이 계정 잠금 문구로 표시된다: "${shown}"`).not.toContain('30분');
        expect.soft(shown, `서버 사유(요청이 너무 많습니다)를 보여줘야 한다: "${shown}"`).toContain('요청이 너무 많습니다');
      });

      await test.step('이용 제한(RESTRICTED) 계정: 서버 문구(고객센터 문의)를 보여준다', async () => {
        relaxRateLimits();
        const restricted = await tempUser('GUARDIAN', { status: 'RESTRICTED' });
        await page.reload();
        await loginViaForm(page, restricted.email, restricted.password);
        await expect(errorText).toBeVisible();
        const shown = (await errorText.textContent()) ?? '';
        test.info().annotations.push({ type: '403 화면 문구', description: shown });
        expect.soft(shown, `서버는 "사용이 제한된 계정입니다. 고객센터에 문의해주세요." 라고 하는데 화면은 "${shown}"`).toContain('사용이 제한된 계정');
      });
    } finally {
      relaxRateLimits();
    }
  });
});

test.describe('가입 완료 버튼', () => {
  test('[AUTH-G16] 가입 완료를 더블클릭해도 요청은 한 번만 나가고 실패 모달이 뜨지 않는다', async ({ openAs }) => {
    const email = signupEmail(`dbl${Date.now().toString(36)}`);
    const phone = uniqueTestPhone();
    const nonce = randomUUID();
    const page = await openAs('anonymous', null);
    const signups: { status?: number }[] = [];
    page.on('request', req => {
      if (req.method() === 'POST' && req.url().endsWith('/api/auth/signup')) signups.push({});
    });
    page.on('response', res => {
      if (res.request().method() === 'POST' && res.url().endsWith('/api/auth/signup')) {
        const item = signups.find(entry => entry.status === undefined);
        if (item) item.status = res.status();
      }
    });

    try {
      // 문자 인증만 대체 (발송/확인 응답을 가짜로 주고 BE 가 확인하는 표식을 Redis 에 넣는다)
      redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');
      await page.route('**/api/auth/signup/sms/send', route =>
        route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300 } } }),
      );
      await page.route('**/api/auth/signup/sms/verify', route =>
        route.fulfill({ json: { success: true, data: { verificationNonce: nonce } } }),
      );
      await page.goto('/signup');

      await page.locator('label[for="GUARDIAN"]').click();
      await page.getByPlaceholder('홍길동').fill('E2E더블클릭');
      await page.getByPlaceholder('example@email.com').fill(email);
      await page.getByPlaceholder('example@email.com').blur();
      await page.getByPlaceholder('8자 이상').fill(env.password);
      await page.getByPlaceholder('비밀번호 다시 입력').fill(env.password);
      await page.getByLabel('성별').selectOption('FEMALE');
      const birth = page.locator('label', { hasText: '생년월일' }).locator('select');
      await birth.nth(0).selectOption('1985');
      await birth.nth(1).selectOption('04');
      await birth.nth(2).selectOption('15');
      await page.getByRole('button', { name: '주소 검색' }).click();
      await expect(page.getByPlaceholder('주소 검색으로 입력하세요')).toHaveValue(ADDRESS.address);
      await page.getByPlaceholder('상세주소를 입력하세요').fill('E2E 가입동 202호');
      await expect(page.getByRole('button', { name: '다음' })).toBeEnabled();
      await page.getByRole('button', { name: '다음' }).click();

      await page.getByPlaceholder('01012345678').fill(phone);
      await page.getByRole('button', { name: '인증번호 받기' }).click();
      await page.getByPlaceholder('6자리 입력').fill('123456');
      await page.getByRole('button', { name: '확인', exact: true }).click();
      await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();

      await page.getByRole('button', { name: '가입 완료' }).dblclick();

      // 가입 요청의 응답이 모두 올 때까지 기다린 뒤, 늦게 도착하는 요청·응답까지 잠시 더 본다
      await expect
        .poll(() => signups.length > 0 && signups.every(item => item.status !== undefined), { timeout: 20_000 })
        .toBe(true);
      await page.waitForTimeout(2500);

      const statuses = signups.map(item => item.status ?? '응답없음').join(', ');
      test.info().annotations.push({ type: '가입 요청', description: `${signups.length}건 (${statuses})` });
      const failureModal = page.getByText('회원가입 실패');
      expect.soft(await failureModal.count(), `성공한 가입 뒤에 '회원가입 실패' 모달이 뜬다 (요청 ${signups.length}건: ${statuses})`).toBe(0);
      expect(signups.length, `더블클릭으로 가입 요청이 ${signups.length}건 나갔다 (${statuses}). 제출 중에는 버튼이 비활성이어야 한다`).toBe(1);
    } finally {
      psql(`DELETE FROM users WHERE email = ${sqlStr(email)};`);
      redis('DEL', `sms:verified:${phone}`);
    }
  });
});

test.describe('화면 세션', () => {
  test('[AUTH-G17] 로그인 화면으로 되돌아와 다른 계정으로 로그인하면 이전 계정 캐시 없이 새 계정의 역할 화면으로 간다', async ({
    tempUser,
    openAs,
  }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const page = await openAs('anonymous', '/login');

    await test.step('보호자로 로그인해 보호자 화면(프로필 캐시 형성)을 연다', async () => {
      await loginViaForm(page, guardian.email, guardian.password);
      await expect(page).toHaveURL(/\/guardian$/);
      await expect(nav(page, 'GUARDIAN')).toBeVisible();
    });

    await test.step('로그아웃 없이 뒤로가기로 /login 에 돌아오면 로그인된 사용자는 역할 홈으로 돌려보낸다', async () => {
      await page.goBack();
      const redirected = await page.waitForURL(/\/guardian/, { timeout: 5000 }).then(
        () => true,
        () => false,
      );
      expect.soft(redirected, `로그인된 상태로 /login 에 들어가면 역할 홈으로 우회해야 하는데 ${new URL(page.url()).pathname} 에 머문다`).toBe(true);
    });

    await test.step('같은 화면에서 피보호자 계정으로 로그인하면 피보호자 홈으로 간다 (보호자 프로필 캐시가 남으면 안 된다)', async () => {
      if (!new URL(page.url()).pathname.startsWith('/login')) return; // 위 단계에서 이미 우회됨: 이 시나리오는 성립하지 않는다
      await loginViaForm(page, ward.email, ward.password);
      await expect(page).not.toHaveURL(/\/login/);
      await page.waitForTimeout(3000); // 캐시 기반 역할 가드의 재이동이 끝나기를 기다린다
      const path = new URL(page.url()).pathname;
      test.info().annotations.push({ type: '피보호자 로그인 후 경로', description: path });
      expect(path, `피보호자로 로그인했는데 이전 계정(보호자)의 프로필 캐시로 판정되어 ${path} 로 이동했다`).toMatch(/^\/ward/);
      await expect(nav(page, 'WARD')).toBeVisible();
    });
  });
});

test.describe('Redis 장애', () => {
  /**
   * Redis 전체를 멈추는 대신, 이 임시 사용자 한 명의 "password:invalidate:<userId>" 키를 문자열이 아닌
   * 해시 타입으로 만들어 둔다. JwtAuthenticationFilter.isInvalidatedByPasswordChange 의
   * opsForValue().get() 이 WRONGTYPE 오류(RedisSystemException, DataAccessException 계열)를 던지므로
   * Redis 장애와 똑같이 "CustomException 이 아닌 Redis 예외가 필터 밖으로 나가는" 경로를 이 사용자 요청에서만 재현한다.
   * 다른 사용자·다른 키에는 영향이 없고, 테스트가 끝나면 키를 지운다.
   */
  test('[AUTH-G21] 인증 필터에서 Redis 오류가 나면 명시적 5xx(서비스 불가)로 응답하고 FE 는 세션을 지우지 않는다', async ({
    browser,
    tempUser,
    loginAs,
  }) => {
    const user = await tempUser('GUARDIAN');
    const { login } = await loginAs(user);
    const sub = (JSON.parse(Buffer.from(login.accessToken.split('.')[1], 'base64url').toString()) as { sub: string }).sub;
    const key = `password:invalidate:${sub}`;

    const me = async (token: string) => {
      const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
      try {
        const res = await ctx.get('/api/user/me');
        return { status: res.status(), body: await res.text() };
      } finally {
        await ctx.dispose();
      }
    };

    // 브라우저는 openAs 대신 직접 연다: 올바른 동작(5xx)일 때 PageWatcher 의 5xx 단언이 테스트를 실패시키지 않도록
    const context = await browser.newContext({ ...contextDefaults, storageState: { cookies: tokenCookies(login), origins: [] } });
    await context.addInitScript(installPageStubs(), pageStubArg);
    try {
      const before = await me(login.accessToken);
      expect(before.status, `준비: Redis 오류 주입 전 /api/user/me 는 200 이어야 한다 (${messageOf(before)})`).toBe(200);

      const page = await context.newPage();
      await page.goto('/guardian');
      await expect(nav(page, 'GUARDIAN')).toBeVisible();
      expect(await refreshCookie(page), '준비: refresh 쿠키가 있어야 한다').toBeTruthy();

      // 이 사용자 키만 WRONGTYPE 이 나게 만든다 (Redis 장애 대역)
      redis('DEL', key);
      redis('HSET', key, 'e2e', '1');
      redis('EXPIRE', key, '300');
      expect(redis('TYPE', key), '준비: 키가 해시 타입이어야 한다').toBe('hash');

      await test.step('BE: Redis 예외가 필터를 빠져나가도 401(로그인 필요)이 아닌 명시적 5xx 로 응답한다', async () => {
        const res = await me(login.accessToken);
        test.info().annotations.push({ type: 'Redis 오류 시 /api/user/me', description: `${res.status} ${res.body.slice(0, 200)}` });
        expect
          .soft(
            res.status,
            `Redis 오류가 났는데 ${res.status} "${messageOf(res)}" 로 응답했다. 401 이면 FE 는 세션 만료로 보고 로그아웃시킨다`,
          )
          .toBeGreaterThanOrEqual(500);
      });

      await test.step('FE: 인증 API 가 Redis 오류로 실패해도 로그인 화면으로 보내거나 refresh 쿠키를 지우지 않는다', async () => {
        const statuses: string[] = [];
        page.on('response', r => {
          if (r.url().includes('/api/')) statuses.push(`${r.status()} ${new URL(r.url()).pathname}`);
        });
        await nav(page, 'GUARDIAN').getByRole('link', { name: '공지사항', exact: true }).click();
        const wentToLogin = await page.waitForURL(/\/login/, { timeout: 10_000 }).then(
          () => true,
          () => false,
        );
        const cookieAfter = await refreshCookie(page);
        test.info().annotations.push({ type: 'FE API 응답', description: statuses.join(', ') || '(없음)' });
        expect.soft(wentToLogin, `Redis 오류(서버 일시 장애)인데 세션 만료로 처리해 /login 으로 이동했다. 응답: ${statuses.join(', ')}`).toBe(false);
        expect.soft(cookieAfter, 'Redis 오류(서버 일시 장애)인데 유효한 refresh 쿠키를 삭제했다').toBeTruthy();
      });
    } finally {
      redis('DEL', key);
      await context.close();
    }
  });
});

test.describe('재발급 실패 처리', () => {
  test('[AUTH-G31] 재발급 요청이 429(일시 오류)로 실패해도 유효한 토큰을 지우거나 로그인 화면으로 보내지 않는다', async ({
    tempUser,
    loginAs,
    openAs,
  }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    const page = await openAs(who, null);

    // 재발급은 서버가 처리하지 않은 429 로 응답시킨다 (BE 는 호출되지 않아 토큰은 그대로 유효)
    let refreshCalls = 0;
    await page.route('**/api/auth/refresh', route => {
      refreshCalls += 1;
      return route.fulfill({
        status: 429,
        json: { success: false, message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.' },
      });
    });
    const state = armOnce401(page);
    await page.goto('/guardian');
    await expect(nav(page, 'GUARDIAN')).toBeVisible();
    expect(await refreshCookie(page), '준비: refresh 쿠키가 있어야 한다').toBeTruthy();

    // 보호 API 하나가 401 이 되어 FE 가 재발급을 시도하는 상황
    state.armed = true;
    await nav(page, 'GUARDIAN').getByRole('link', { name: '공지사항', exact: true }).click();
    await expect.poll(() => state.fired, { message: '보호 API 401 유도가 실행돼야 한다' }).toBe(1);
    await expect.poll(() => refreshCalls, { message: 'FE 가 재발급을 시도해야 한다' }).toBeGreaterThan(0);

    const wentToLogin = await page.waitForURL(/\/login/, { timeout: 8000 }).then(
      () => true,
      () => false,
    );
    const cookieAfter = await refreshCookie(page);
    expect.soft(wentToLogin, '재발급이 429(일시 오류)였는데 세션 만료로 처리해 /login 으로 이동했다').toBe(false);
    expect.soft(cookieAfter, '재발급이 429(일시 오류)였는데 유효한 refresh 쿠키를 삭제했다').toBeTruthy();
  });
});
