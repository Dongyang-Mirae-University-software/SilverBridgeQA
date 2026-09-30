/**
 * 변수 QA - 인증 (low 등급, 2번째 묶음)
 *
 * AUTH-G20, G22, G23, G24, G25, G26, G27, G29, G30.
 * 모든 테스트는 "올바른 동작"을 단언하므로 결함이 있는 동안에는 실패한다.
 *
 * 부작용 원칙:
 * - 임시 사용자(tempUser)와 이 파일이 만든 행만 다룬다.
 * - SMS·메일은 보내지 않는다: 인증 nonce 는 Redis 에 직접 넣는다.
 * - 서버 설정은 읽기만 한다 (Redis CONFIG GET / INFO).
 */
import { randomUUID } from 'node:crypto';

import { Page, request } from '@playwright/test';

import { ADDRESS, signupEmail } from '../../src/accounts';
import { env } from '../../src/env';
import { expect, nav, test } from '../../src/fixtures';
import { psql, redis, redisDelPattern, sqlStr } from '../../src/remote';
import { relaxRateLimits, uniqueTestPhone } from '../../src/seed';
import { loginViaForm } from '../../src/variables';

interface Raw {
  status: number;
  body: string;
}

/** BE 를 직접 호출한다 (FE 프록시·쿠키 없이). userAgent 를 주면 그 값으로 보낸다 */
async function post(path: string, data: unknown, opts: { userAgent?: string; token?: string } = {}): Promise<Raw> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    userAgent: opts.userAgent,
    extraHTTPHeaders: opts.token ? { Authorization: `Bearer ${opts.token}` } : undefined,
  });
  try {
    const res = await ctx.post(path, { data });
    return { status: res.status(), body: await res.text() };
  } finally {
    await ctx.dispose();
  }
}

function messageOf(raw: Raw) {
  try {
    return (JSON.parse(raw.body) as { message?: string }).message ?? raw.body.slice(0, 200);
  } catch {
    return raw.body.slice(0, 200);
  }
}

function tokensOf(raw: Raw) {
  const data = (JSON.parse(raw.body) as { data: { accessToken: string; refreshToken: string } }).data;
  return { access: data.accessToken, refresh: data.refreshToken };
}

function jwtPayload(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string; exp: number; iat: number };
}

test.beforeEach(() => relaxRateLimits());

test.describe('로그아웃 실패 처리', () => {
  test('[AUTH-G20] 로그아웃 API 가 실패해도 화면은 로그인 상태로 남지 않거나 실패를 안내한다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    const page = await openAs(who, null);

    // 로그아웃 요청만 네트워크 오류로 실패시킨다 (서버에는 도달하지 않음)
    let logoutCalls = 0;
    await page.route('**/api/auth/logout', route => {
      logoutCalls += 1;
      return route.abort('failed');
    });
    await page.goto('/guardian');
    await expect(nav(page, 'GUARDIAN')).toBeVisible();

    const authCookie = async () =>
      (await page.context().cookies()).find(cookie => cookie.name === 'careai_access_token')?.value;
    expect(await authCookie(), '준비: 로그인 쿠키가 있어야 한다').toBeTruthy();

    // 사이드바 내 이름 -> 프로필 -> 로그아웃 -> 확인
    await page.getByRole('complementary', { name: /메뉴$/ }).getByRole('button', { name: new RegExp(user.name) }).click();
    await page.getByRole('dialog').getByRole('button', { name: '로그아웃' }).click();
    await page.getByRole('alertdialog', { name: '로그아웃 확인' }).getByRole('button', { name: '로그아웃', exact: true }).click();

    await expect.poll(() => logoutCalls, { message: '로그아웃 요청이 나가야 한다' }).toBeGreaterThan(0);
    // 실패 처리(onError)가 있다면 반영될 시간을 준다
    const wentToLogin = await page.waitForURL(/\/login/, { timeout: 6000 }).then(
      () => true,
      () => false,
    );
    const cookieAfter = await authCookie();
    const feedback = page.locator('[aria-live="polite"], [role="alert"]').filter({ hasText: /\S/ });
    const feedbackText = (await feedback.allTextContents()).join(' / ');
    test.info().annotations.push({
      type: '로그아웃 실패 후 상태',
      description: `경로 ${new URL(page.url()).pathname}, 쿠키 ${cookieAfter ? '남음' : '삭제'}, 안내 "${feedbackText || '(없음)'}"`,
    });

    const localCleared = wentToLogin && !cookieAfter;
    const notified = feedbackText.length > 0;
    expect(
      localCleared || notified,
      `로그아웃 API 가 실패했는데 로컬 세션(쿠키 ${cookieAfter ? '남음' : '삭제됨'}, 경로 ${new URL(page.url()).pathname})도 그대로고 실패 안내도 없다. 실패해도 토큰을 지우고 /login 으로 보내거나 최소한 오류를 알려야 한다`,
    ).toBe(true);
  });
});

test.describe('카카오 가입 프로필 이미지', () => {
  test('[AUTH-G22] 카카오 가입의 profileImageUrl 이 너무 길거나 허용 도메인이 아니면 400 으로 거절하고 SMS 인증(nonce)을 소진하지 않는다', async ({}) => {
    const kakaoId = `9${Date.now()}`.slice(0, 20);
    const email = `kakao_${kakaoId}@kakao.com`;
    const pendingKey = `kakao:pending:${kakaoId}`;
    const phone = uniqueTestPhone();
    const verifiedKey = `sms:verified:${phone}`;

    const body = (profileImageUrl: string, nonce: string) => ({
      kakaoId,
      name: 'E2E카카오',
      phone,
      verificationNonce: nonce,
      role: 'GUARDIAN',
      profileImageUrl,
      address: ADDRESS.address,
      addressDetail: ADDRESS.addressDetail,
      gender: 'MALE',
      birthDate: '1985-04-15',
      postcode: ADDRESS.postcode,
    });
    const arm = () => {
      const nonce = randomUUID();
      redis('SET', pendingKey, email, 'EX', '600');
      redis('SET', verifiedKey, nonce, 'EX', '600');
      return nonce;
    };

    try {
      await test.step('(a) 501자 이상의 URL: 500 이 아니라 400 이고 nonce 는 그대로 남는다', async () => {
        const nonce = arm();
        const res = await post('/api/auth/signup/kakao', body(`https://k.kakaocdn.net/${'a'.repeat(500)}`, nonce));
        const nonceLeft = redis('EXISTS', verifiedKey);
        test.info().annotations.push({ type: '긴 URL 응답', description: `${res.status} ${messageOf(res)} / nonce 키 존재 ${nonceLeft}` });
        expect.soft(res.status, `521자 URL 로 가입 요청이 ${res.status}: ${messageOf(res)}`).toBe(400);
        expect.soft(nonceLeft, '검증 실패(또는 서버 오류)로 끝났는데 SMS 인증 nonce 가 소진됐다 (사용자는 SMS 재인증을 해야 한다)').toBe('1');
      });

      await test.step('(b) 카카오 CDN 이 아닌 임의 외부 URL 은 프로필 이미지로 저장할 수 없다', async () => {
        const nonce = arm();
        const res = await post('/api/auth/signup/kakao', body('https://tracker.e2e-invalid.example/pixel.png', nonce));
        const stored = psql(`SELECT profile_image FROM users WHERE provider = 'KAKAO' AND provider_id = ${sqlStr(kakaoId)};`);
        test.info().annotations.push({ type: '외부 URL 응답', description: `${res.status} ${messageOf(res)} / 저장값 ${stored || '(없음)'}` });
        expect.soft(res.status, `임의 외부 URL 이 그대로 받아들여졌다: ${res.status}`).toBe(400);
        expect.soft(stored, '임의 외부 URL 이 프로필 이미지로 저장됐다 (다른 사용자 화면에서 로드됨)').toBe('');
      });
    } finally {
      // 이 테스트가 만든 카카오 가입 행만 정리한다
      psql(`DELETE FROM access_log WHERE user_id IN (SELECT id FROM users WHERE provider = 'KAKAO' AND provider_id = ${sqlStr(kakaoId)});
            DELETE FROM users WHERE provider = 'KAKAO' AND provider_id = ${sqlStr(kakaoId)};`);
      redis('DEL', pendingKey);
      redis('DEL', verifiedKey);
    }
  });
});

test.describe('User-Agent 길이', () => {
  test('[AUTH-G23] User-Agent 가 500자를 넘어도 로그인·로그아웃이 500 없이 처리된다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const ua = (n: number) => `E2E/${'u'.repeat(n - 4)}`;

    await test.step('(a) UA 501자로 로그인', async () => {
      relaxRateLimits();
      const res = await post('/api/auth/signin', { email: user.email, password: user.password }, { userAgent: ua(501) });
      expect.soft(res.status, `UA 501자 로그인이 ${res.status}: ${messageOf(res)}`).toBe(200);
    });

    await test.step('(b) UA 600자로 로그인', async () => {
      relaxRateLimits();
      const res = await post('/api/auth/signin', { email: user.email, password: user.password }, { userAgent: ua(600) });
      expect.soft(res.status, `UA 600자 로그인이 ${res.status}: ${messageOf(res)}`).toBe(200);
    });

    await test.step('(c) 정상 UA 로 로그인한 뒤 UA 600자로 로그아웃', async () => {
      relaxRateLimits();
      const login = await post('/api/auth/signin', { email: user.email, password: user.password });
      expect(login.status, `준비: 정상 UA 로그인은 200 이어야 한다: ${messageOf(login)}`).toBe(200);
      const res = await post('/api/auth/logout', undefined, { userAgent: ua(600), token: tokensOf(login).access });
      expect.soft(res.status, `UA 600자 로그아웃이 ${res.status}: ${messageOf(res)}`).toBe(200);
    });
  });
});

test.describe('API 문서와 구현', () => {
  test('[AUTH-G24] Swagger 문서의 로그아웃 오류 코드·카카오 pending 유지 시간·로그인 비밀번호 길이가 실제 동작과 같다', async ({}) => {
    const ctx = await request.newContext({ baseURL: env.apiUrl });
    let docs: {
      paths: Record<string, Record<string, { description?: string; responses?: Record<string, { description?: string }> }>>;
      components?: { schemas?: Record<string, { properties?: Record<string, { description?: string; minLength?: number }> }> };
    };
    try {
      const res = await ctx.get('/v3/api-docs');
      expect(res.status(), '준비: /v3/api-docs 를 읽을 수 있어야 한다').toBe(200);
      docs = await res.json();
    } finally {
      await ctx.dispose();
    }

    await test.step('로그아웃: Authorization 헤더가 없을 때 실제 응답과 문서의 오류 코드가 같다', async () => {
      const actual = await post('/api/auth/logout', undefined);
      const responses = docs.paths['/api/auth/logout']?.post?.responses ?? {};
      test.info().annotations.push({ type: '로그아웃(헤더 없음)', description: `실제 ${actual.status}, 문서 ${JSON.stringify(responses)}` });
      const doc400 = responses['400']?.description ?? '';
      expect.soft(
        doc400.includes('헤더 누락') && actual.status !== 400,
        `문서는 "${doc400}" (400) 라고 하지만 실제는 ${actual.status} (${messageOf(actual)})`,
      ).toBe(false);
    });

    await test.step('카카오 가입: 문서가 말하는 pending 유지 시간이 코드 상수(KAKAO_PENDING_TTL=30분)와 같다', async () => {
      const description = docs.paths['/api/auth/signup/kakao']?.post?.description ?? '';
      const minutes = Number(/kakaoId는 서버에서\s*(\d+)\s*분/.exec(description)?.[1]);
      test.info().annotations.push({ type: '문서의 pending 유지 시간(분)', description: String(minutes) });
      expect.soft(minutes, `문서는 ${minutes}분이라 하지만 구현은 30분(KAKAO_PENDING_TTL)이다`).toBe(30);
    });

    await test.step('로그인 비밀번호: 실제로는 짧은 값도 형식 오류가 아닌 401 인데 문서가 8~64자라고 하지 않는다', async () => {
      relaxRateLimits();
      const actual = await post('/api/auth/signin', { email: 'e2e.nobody.g24@silverbridge.test', password: 'ab1' });
      const schema = docs.components?.schemas?.LoginRequest?.properties?.password;
      const claimsMin8 = /8\s*~\s*64/.test(schema?.description ?? '') || (schema?.minLength ?? 0) >= 8;
      test.info().annotations.push({ type: '로그인 비밀번호', description: `3자 -> ${actual.status}, 문서 "${schema?.description}" minLength ${schema?.minLength}` });
      expect.soft(actual.status, '준비: 3자 비밀번호는 형식 오류(400)가 아니라 자격 불일치 401').toBe(401);
      expect.soft(claimsMin8, `문서는 "${schema?.description}" 라고 하지만 3자 비밀번호도 검증을 통과해 ${actual.status} 이 된다`).toBe(false);
    });
  });
});

test.describe('로그인 계정 열거', () => {
  test('[AUTH-G25] 가입된 이메일과 미가입 이메일의 오답 반복 응답이 같다 (6번째 401 vs 429)', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const ghost = `e2e.nobody.${Date.now().toString(36)}@silverbridge.test`;
    const wrong = 'Wrong1!pass';

    const attempt = async (email: string) => {
      const codes: number[] = [];
      const times: number[] = [];
      for (let i = 0; i < 6; i++) {
        const start = Date.now();
        const res = await post('/api/auth/signin', { email, password: wrong });
        times.push(Date.now() - start);
        codes.push(res.status);
      }
      return { codes, times };
    };

    try {
      const unknown = await attempt(ghost);
      relaxRateLimits();
      const known = await attempt(user.email);
      test.info().annotations.push({
        type: '오답 6회 응답',
        description: `미가입 ${unknown.codes.join(',')} (평균 ${Math.round(unknown.times.reduce((a, b) => a + b, 0) / 6)}ms) / 가입 ${known.codes.join(',')} (평균 ${Math.round(known.times.reduce((a, b) => a + b, 0) / 6)}ms)`,
      });
      expect(
        known.codes[5],
        `가입된 이메일은 6번째에 ${known.codes[5]}, 미가입 이메일은 ${unknown.codes[5]} 이라 응답 코드로 계정 존재 여부가 드러난다`,
      ).toBe(unknown.codes[5]);
    } finally {
      redisDelPattern(`login:*:${user.id}`);
      relaxRateLimits();
    }
  });
});

test.describe('토큰 쿠키', () => {
  test('[AUTH-G26] 로그인 후 토큰 쿠키는 HttpOnly+Secure 이고 access 쿠키 수명이 토큰 수명과 맞다', async ({ tempUser, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const page = await openAs('anonymous', '/login');
    await loginViaForm(page, user.email, user.password);
    await expect(page).toHaveURL(/\/guardian/);
    await expect(nav(page, 'GUARDIAN')).toBeVisible();

    const cookies = await page.context().cookies();
    const access = cookies.find(cookie => cookie.name === 'careai_access_token');
    const refresh = cookies.find(cookie => cookie.name === 'careai_refresh_token');
    expect(access, '준비: access 쿠키가 있어야 한다').toBeTruthy();
    expect(refresh, '준비: refresh 쿠키가 있어야 한다').toBeTruthy();

    const accessJwt = jwtPayload(decodeURIComponent(access!.value));
    const now = Math.floor(Date.now() / 1000);
    const tokenLifeSec = accessJwt.exp - now;
    const cookieLifeSec = Math.round(access!.expires - now);
    test.info().annotations.push({
      type: '쿠키 속성',
      description: `access httpOnly=${access!.httpOnly} secure=${access!.secure} 수명 ${cookieLifeSec}s (토큰 남은 수명 ${tokenLifeSec}s) / refresh httpOnly=${refresh!.httpOnly} secure=${refresh!.secure}`,
    });

    expect.soft(access!.httpOnly, 'access 쿠키가 HttpOnly 가 아니라 XSS 로 JS 에서 읽힌다').toBe(true);
    expect.soft(refresh!.httpOnly, 'refresh 쿠키가 HttpOnly 가 아니라 XSS 로 JS 에서 읽힌다').toBe(true);
    expect.soft(access!.secure, 'access 쿠키에 Secure 속성이 없다').toBe(true);
    expect.soft(refresh!.secure, 'refresh 쿠키에 Secure 속성이 없다').toBe(true);
    expect.soft(
      cookieLifeSec,
      `access 쿠키 수명이 ${cookieLifeSec}초(약 ${(cookieLifeSec / 86400).toFixed(1)}일)로 토큰 남은 수명 ${tokenLifeSec}초보다 훨씬 길다`,
    ).toBeLessThanOrEqual(tokenLifeSec + 60);
  });
});

test.describe('refresh 토큰 종류', () => {
  test('[AUTH-G27] refresh 자리에 access 토큰을 보내면 401 로만 끝나고 정상 refresh 세션은 폐기되지 않는다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const login = await post('/api/auth/signin', { email: user.email, password: user.password });
    expect(login.status, `준비: 로그인 200: ${messageOf(login)}`).toBe(200);
    const { access, refresh } = tokensOf(login);
    const rows = () => Number(psql(`SELECT count(*) FROM refresh_token WHERE user_id = ${sqlStr(user.id)};`));
    expect(rows(), '준비: refresh_token 행이 1개').toBe(1);

    const wrongKind = await post('/api/auth/refresh', { refreshToken: access });
    expect(wrongKind.status, `access 토큰으로의 refresh 는 401: ${messageOf(wrongKind)}`).toBe(401);

    const left = rows();
    expect.soft(left, `access 토큰을 보냈을 뿐인데 사용자의 refresh_token 행이 ${left}개로 폐기됐다 (재사용 감지 오탐)`).toBe(1);
    const real = await post('/api/auth/refresh', { refreshToken: refresh });
    expect.soft(real.status, `정상 refresh 토큰이 ${real.status}: ${messageOf(real)} (세션이 강제 종료됐다)`).toBe(200);
  });
});

test.describe('가입 1단계 입력 검증', () => {
  async function fillStepOne(page: Page, email: string, year?: string) {
    await page.locator('label[for="GUARDIAN"]').click();
    await page.getByPlaceholder('홍길동').fill('E2E생년월일');
    await page.getByPlaceholder('example@email.com').fill(email);
    await page.getByPlaceholder('example@email.com').blur();
    await page.getByPlaceholder('8자 이상').fill(env.password);
    await page.getByPlaceholder('비밀번호 다시 입력').fill(env.password);
    await page.getByLabel('성별').selectOption('FEMALE');
    const birth = page.locator('label', { hasText: '생년월일' }).locator('select');
    const thisYear = year ?? (await birth.nth(0).locator('option:not([disabled])').first().getAttribute('value')) ?? '';
    await birth.nth(0).selectOption(thisYear);
    await birth.nth(1).selectOption('01');
    await birth.nth(2).selectOption('01');
    await page.getByRole('button', { name: '주소 검색' }).click();
    await expect(page.getByPlaceholder('주소 검색으로 입력하세요')).toHaveValue(ADDRESS.address);
    await page.getByPlaceholder('상세주소를 입력하세요').fill('E2E 가입동 202호');
    return thisYear;
  }

  test('[AUTH-G29] 가입 1단계에서 만 14세 미만 생년월일을 바로 안내하고, 확인된 이메일은 blur 마다 다시 조회하지 않는다', async ({ openAs }) => {
    redisDelPattern('rate:email-check:*');
    const email = signupEmail(`g29${Date.now().toString(36)}`);
    const page = await openAs('anonymous', null);
    const checks: number[] = [];
    page.on('response', res => {
      if (res.request().method() === 'POST' && res.url().endsWith('/api/auth/signup/email/check')) checks.push(res.status());
    });

    try {
      await page.goto('/signup');

      await test.step('(a) 올해 태어난 것으로 선택하면 1단계에서 막거나 오류를 보여준다 (BE 는 만 14세 이상만 허용)', async () => {
        const year = await fillStepOne(page, email);
        await expect(page.getByPlaceholder('example@email.com')).toHaveValue(email);
        // 이메일 중복 확인이 끝나기를 기다린다
        await expect.poll(() => checks.length, { message: '이메일 확인 요청이 나가야 한다' }).toBeGreaterThan(0);
        await page.waitForTimeout(800);
        const next = page.getByRole('button', { name: '다음' });
        const enabled = await next.isEnabled();
        const birthError = await page.locator('[class*="birthDateError"]').count();
        test.info().annotations.push({ type: '올해 출생 선택', description: `${year}-01-01, 다음 버튼 ${enabled ? '활성' : '비활성'}, 오류 문구 ${birthError}개` });
        expect.soft(
          !enabled || birthError > 0,
          `${year}-01-01 (만 0세) 을 골랐는데 '다음'이 활성이고 오류 안내도 없다. 마지막 제출에서야 BE 400 을 만난다`,
        ).toBe(true);
      });

      await test.step('(b) 이미 확인된 같은 이메일로 blur 를 반복해도 재조회·429 로 확인 상태를 잃지 않는다', async () => {
        const before = checks.length;
        const emailInput = page.getByPlaceholder('example@email.com');
        for (let i = 0; i < 12; i++) {
          await emailInput.focus();
          await emailInput.blur();
        }
        await page.waitForTimeout(1500);
        const extra = checks.length - before;
        const statuses = checks.join(',');
        test.info().annotations.push({ type: '이메일 확인 응답', description: `총 ${checks.length}회 (${statuses}), blur 반복으로 ${extra}회 추가` });
        expect.soft(extra, `변경 없는 같은 이메일인데 blur 12번에 조회 요청이 ${extra}번 더 나갔다 (응답: ${statuses})`).toBe(0);
        expect.soft(checks.includes(429), '이메일 확인이 429 를 받아 이미 확인된 이메일의 확인 상태가 유실될 수 있다').toBe(false);
      });
    } finally {
      redisDelPattern('rate:email-check:*');
    }
  });
});

test.describe('Redis 메모리 정책', () => {
  test('[AUTH-G30] 보안 키(잠금·블랙리스트·인증코드)가 있는 Redis 는 키를 퇴출하지 않는 정책(noeviction)이다', async ({}) => {
    const policy = redis('CONFIG', 'GET', 'maxmemory-policy').split('\n').pop()?.trim();
    const maxmemory = redis('CONFIG', 'GET', 'maxmemory').split('\n').pop()?.trim();
    const info = redis('INFO', 'stats') + '\n' + redis('INFO', 'memory');
    const pick = (name: string) => new RegExp(`^${name}:(.+)$`, 'm').exec(info)?.[1]?.trim();
    test.info().annotations.push({
      type: 'Redis 메모리 설정',
      description: `maxmemory-policy=${policy}, maxmemory=${maxmemory}, used_memory=${pick('used_memory')}, evicted_keys=${pick('evicted_keys')}`,
    });
    expect(
      policy,
      `maxmemory-policy 가 ${policy} (maxmemory ${maxmemory}) 라서 메모리가 차면 login:lock·logout 블랙리스트 같은 보안 키도 rate:* 카운터와 함께 퇴출될 수 있다`,
    ).toBe('noeviction');
  });
});
