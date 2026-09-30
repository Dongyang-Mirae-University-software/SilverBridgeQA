/**
 * 변수 QA - FE UX 결함 (medium, feux-a)
 *
 * FEUX-G01 무효 쿠키 승격 / G02 다중 탭 refresh / G03 프로필 조회 실패 로그아웃 / G06 localStorage 손상
 * G08 가입 더블클릭 / G09 비밀번호 규칙 불일치 / G12 이메일 규칙 / G13 비밀번호 확인 재검증 / G15 프로필 모달 스냅샷
 *
 * 올바른 동작을 단언하므로 결함이 있는 동안에는 실패한다.
 * 안전: 임시 사용자와 우리가 만든 가입 계정만 쓰고, SMS/메일 발송 API 는 부르지 않는다
 * (가입·전화 인증은 응답을 가짜로 주고 Redis 인증 표식을 직접 넣는다).
 */
import { randomUUID } from 'node:crypto';

import { Page, request } from '@playwright/test';

import { ADDRESS, signupEmail } from '../../src/accounts';
import { Api, ApiError } from '../../src/api';
import { env, feHost } from '../../src/env';
import { expect, nav, test } from '../../src/fixtures';
import { psql, psqlRows, redis, redisDelPattern, sqlStr } from '../../src/remote';
import { deleteTempUser, relaxRateLimits, tempPhone, uniqueTestPhone } from '../../src/seed';
import { loginViaForm } from '../../src/variables';

const EMAIL_CHECK = '/api/auth/signup/email/check';
const VALID_PASSWORD = 'Abcdef1!';

function uniqueTag() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 가입 1단계를 채운다. 비밀번호는 마지막에 채워 버튼 상태가 바로 그 값을 반영하게 한다 */
async function fillSignupStepOne(page: Page, input: { email: string; password: string; passwordCheck: string }) {
  await page.locator('label[for="GUARDIAN"]').click();
  await page.getByPlaceholder('홍길동').fill('E2E가입검증');
  await page.getByPlaceholder('example@email.com').fill(input.email);
  const checked = page.waitForResponse(r => r.url().endsWith(EMAIL_CHECK), { timeout: 20_000 }).catch(() => null);
  await page.getByPlaceholder('example@email.com').blur();
  await checked;
  await page.getByLabel('성별').selectOption('FEMALE');
  const birth = page.locator('label', { hasText: '생년월일' }).locator('select');
  await birth.nth(0).selectOption('1985');
  await birth.nth(1).selectOption('04');
  await birth.nth(2).selectOption('15');
  await page.getByRole('button', { name: '주소 검색' }).click();
  await expect(page.getByPlaceholder('주소 검색으로 입력하세요')).toHaveValue(ADDRESS.address);
  await page.getByPlaceholder('상세주소를 입력하세요').fill('E2E 가입동 202호');
  await page.getByPlaceholder('8자 이상').fill(input.password);
  await page.getByPlaceholder('비밀번호 다시 입력').fill(input.passwordCheck);
}

/** 문자 인증만 대체한다 (auth/signup.spec.ts 와 같은 방식). 실제 문자는 나가지 않는다 */
async function mockSmsVerification(page: Page, phone: string) {
  const nonce = randomUUID();
  redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');
  await page.route('**/api/auth/signup/sms/send', route =>
    route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300 } } }),
  );
  await page.route('**/api/auth/signup/sms/verify', route =>
    route.fulfill({ json: { success: true, data: { verificationNonce: nonce } } }),
  );
}

test.beforeEach(() => {
  relaxRateLimits();
  redisDelPattern('rate:email-check:*');
});

test.describe('인증 세션·쿠키', () => {
  test('[FEUX-G01] 만료·무효 access 쿠키가 남아 있어도 가입 화면의 이메일 중복 확인이 막히지 않는다', async ({ openAs }) => {
    const page = await openAs('anonymous', null);
    // 세션이 만료(30분)됐지만 쿠키(7일)만 남은 상태
    const base = { domain: feHost, path: '/', expires: Math.floor(Date.now() / 1000) + 7 * 24 * 3600 };
    await page.context().addCookies([
      { ...base, name: 'careai_access_token', value: 'aaa.bbb.ccc' },
      { ...base, name: 'careai_refresh_token', value: 'x' },
    ]);
    await page.goto('/signup');

    const checked = page.waitForResponse(r => r.url().endsWith(EMAIL_CHECK));
    await page.getByPlaceholder('example@email.com').fill(`e2e.nobody.${uniqueTag()}@silverbridge.test`);
    await page.getByPlaceholder('example@email.com').blur();
    const res = await checked;
    const body = await res.text();

    expect
      .soft(res.status(), `BFF 가 무효 쿠키를 Bearer 로 승격해 공개 API 가 401 이 된다: ${body.slice(0, 200)}`)
      .toBe(200);
    await expect
      .soft(page.getByText('로그인 세션이 만료되었습니다'), '가입 화면 이메일 아래에 세션 만료 메시지가 뜬다')
      .toHaveCount(0);
    // 참고: 비밀번호 찾기 발송은 실제 메일·문자가 나갈 수 있어 호출하지 않는다 (BFF 승격 경로는 위와 동일)
  });

  test('[FEUX-G02] 한 탭이 토큰을 회전시킨 뒤 다른 탭이 재발급해도 세션이 유지된다', async ({ tempUser, openAs }) => {
    const user = await tempUser('GUARDIAN');
    // 탭 A: 화면에서 로그인해 메모리에 refresh 토큰을 고정한다
    const pageA = await openAs('anonymous', '/login');
    await loginViaForm(pageA, user.email, user.password);
    await expect(pageA).toHaveURL(/\/guardian$/);
    await expect(nav(pageA, 'GUARDIAN')).toBeVisible();

    // 탭 B: 같은 브라우저(쿠키 공유)의 다른 탭
    const pageB = await pageA.context().newPage();
    await pageB.goto('/guardian');
    await expect(nav(pageB, 'GUARDIAN')).toBeVisible();

    /** 다음 조회 API 하나를 401 로 만들어 그 탭이 refresh 하게 한다. refresh 응답 상태를 모은다 */
    const arm401 = async (page: Page) => {
      const state = { fired: false, refreshStatus: null as number | null };
      await page.route('**/api/**', route => {
        const req = route.request();
        const url = req.url();
        if (state.fired || req.method() !== 'GET' || url.includes('/api/auth/') || url.includes('/api/streams/')) {
          return route.continue();
        }
        state.fired = true;
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          json: { success: false, code: 'EXPIRED_TOKEN', message: '[E2E] 토큰 만료' },
        });
      });
      page.on('response', r => {
        if (r.url().endsWith('/api/auth/refresh')) state.refreshStatus = r.status();
      });
      return state;
    };
    const trigger = async (page: Page, state: { refreshStatus: number | null }) => {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      for (let i = 0; i < 20 && state.refreshStatus === null; i++) await page.waitForTimeout(500);
      if (state.refreshStatus === null) {
        await nav(page, 'GUARDIAN').getByRole('link', { name: '피보호자 관리' }).click();
        for (let i = 0; i < 20 && state.refreshStatus === null; i++) await page.waitForTimeout(500);
      }
    };

    // 1) 탭 B 가 먼저 refresh (R1 -> R2 회전, 쿠키도 R2)
    const stateB = await arm401(pageB);
    await trigger(pageB, stateB);
    expect(stateB.refreshStatus, '탭 B 의 정상 refresh 는 성공해야 한다 (테스트 준비 확인)').toBe(200);

    // 2) 탭 A 가 자기 메모리의 옛 R1 로 refresh
    const stateA = await arm401(pageA);
    await trigger(pageA, stateA);
    expect
      .soft(stateA.refreshStatus, '탭 A 가 메모리의 옛 refresh 토큰(R1)을 보내 BE 재사용 탐지가 전 세션을 폐기한다')
      .toBe(200);
    await pageA.waitForTimeout(1500);
    expect.soft(pageA.url(), '탭 A 가 로그인 화면으로 쫓겨난다').not.toMatch(/\/login/);
    const cookies = await pageA.context().cookies();
    expect
      .soft(
        cookies.some(c => c.name === 'careai_refresh_token' && c.value),
        '재사용 탐지 후 FE 가 공유 쿠키까지 지워 다른 탭도 세션을 잃는다',
      )
      .toBe(true);
  });

  test('[FEUX-G03] 프로필 조회가 일시 실패해도 토큰을 지우고 로그아웃하지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who } = await loginAs(ward);

    await test.step('진입 시 프로필 조회 네트워크 실패', async () => {
      const page = await openAs(who, null);
      await page.route('**/api/user/me', route => route.abort('failed'));
      await page.goto('/ward');
      await page.waitForURL(/\/login/, { timeout: 10_000 }).catch(() => undefined);
      expect
        .soft(page.url(), '프로필 조회 1회 실패(retry:false)에 RoleRouteGuard 가 곧바로 /login 으로 보낸다')
        .not.toMatch(/\/login/);
      const cookies = await page.context().cookies();
      expect
        .soft(
          cookies.some(c => c.name === 'careai_access_token' && c.value),
          '일시 오류인데 access 토큰 쿠키가 삭제된다',
        )
        .toBe(true);
    });

    await test.step('5분 뒤 창 복귀 재조회 실패', async () => {
      const page = await openAs(who, null);
      await page.clock.install();
      await page.goto('/ward');
      await expect(nav(page, 'WARD')).toBeVisible();

      await page.route('**/api/user/me', route => route.abort('failed'));
      await page.clock.fastForward('06:00');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForURL(/\/login/, { timeout: 10_000 }).catch(() => undefined);
      expect
        .soft(page.url(), '캐시된 프로필이 있는데도 재조회 1회 실패로 로그아웃된다')
        .not.toMatch(/\/login/);
    });
  });
});

test.describe('피보호자 화면 설정 저장소', () => {
  test('[FEUX-G06] localStorage 설정이 손상되거나 접근이 막혀도 피보호자 화면이 정상 표시된다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who } = await loginAs(ward);
    const KEY = 'silverbridge_ward_settings';

    const cases: { name: string; init: (key: string) => void }[] = [
      { name: "손상 JSON '{broken'", init: key => localStorage.setItem(key, '{broken') },
      { name: "'null' 값", init: key => localStorage.setItem(key, 'null') },
      {
        name: 'localStorage 접근 차단(getItem/setItem 예외)',
        init: key => {
          const get = Storage.prototype.getItem;
          const set = Storage.prototype.setItem;
          Storage.prototype.getItem = function (k: string) {
            if (this === window.localStorage && k === key) throw new DOMException('blocked', 'SecurityError');
            return get.call(this, k);
          };
          Storage.prototype.setItem = function (k: string, v: string) {
            if (this === window.localStorage && k === key) throw new DOMException('blocked', 'QuotaExceededError');
            return set.call(this, k, v);
          };
        },
      },
    ];

    for (const c of cases) {
      const page = await openAs(who, null);
      await page.addInitScript(c.init, KEY);
      await page.goto('/ward');
      const visible = await nav(page, 'WARD')
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true, () => false);
      expect.soft(visible, `${c.name}: 예외가 error boundary 없이 전파되어 피보호자 전체 화면이 사라진다`).toBe(true);
    }

    await test.step('타입이 틀린 값은 고대비를 켜지 않는다', async () => {
      const page = await openAs(who, null);
      await page.addInitScript(
        ({ key }) => localStorage.setItem(key, JSON.stringify({ highContrast: 'false', fontSize: 17 })),
        { key: KEY },
      );
      await page.goto('/ward');
      await expect(nav(page, 'WARD')).toBeVisible();
      await expect
        .soft(page.locator('[class*="wardHighContrast"]'), "highContrast:'false'(문자열)가 truthy 로 취급되어 고대비가 켜진다")
        .toHaveCount(0);
    });
  });
});

test.describe('회원가입 입력 검증', () => {
  test("[FEUX-G08] '가입 완료'를 두 번 눌러도 가입은 한 번만 처리되고 로그인 화면으로 이동한다", async ({ openAs }) => {
    const email = signupEmail(`dbl${uniqueTag()}`);
    const phone = uniqueTestPhone();
    const page = await openAs('anonymous', null);
    await mockSmsVerification(page, phone);
    await page.goto('/signup');

    let posts = 0;
    try {
      await fillSignupStepOne(page, { email, password: VALID_PASSWORD, passwordCheck: VALID_PASSWORD });
      await expect(page.getByRole('button', { name: '다음' })).toBeEnabled();
      await page.getByRole('button', { name: '다음' }).click();

      await page.getByPlaceholder('01012345678').fill(phone);
      await page.getByRole('button', { name: '인증번호 받기' }).click();
      await page.getByPlaceholder('6자리 입력').fill('123456');
      await page.getByRole('button', { name: '확인', exact: true }).click();
      await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();

      // 느린 응답 재현: 두 번째 요청은 첫 번째 가입이 끝난 뒤에 서버에 닿는다
      await page.route('**/api/auth/signup', async route => {
        posts += 1;
        if (posts >= 2) await new Promise(resolve => setTimeout(resolve, 2000));
        await route.continue();
      });
      await page.getByRole('button', { name: '가입 완료' }).dblclick();
      await page.waitForURL(/\/login$/, { timeout: 20_000 }).catch(() => undefined);
      await page.waitForTimeout(500);

      const failModal = page.getByRole('alertdialog', { name: '회원가입 실패' }).or(page.getByText('회원가입 실패'));
      expect
        .soft(page.url(), `가입 요청 ${posts}건 전송. 첫 요청의 성공 콜백이 버려져 화면이 이동하지 않는다`)
        .toMatch(/\/login$/);
      await expect.soft(failModal.first(), '계정은 만들어졌는데 두 번째 요청의 실패 모달이 뜬다').toBeHidden();
      const [[count]] = psqlRows(`SELECT count(*) FROM users WHERE email = ${sqlStr(email)};`);
      expect(count, '계정은 정확히 한 건 생성되어야 한다').toBe('1');
    } finally {
      const rows = psqlRows(`SELECT id FROM users WHERE email = ${sqlStr(email)};`);
      for (const [id] of rows) deleteTempUser(id);
    }
  });

  test('[FEUX-G09] 가입 비밀번호 규칙이 BE(영문·숫자·특수문자, 허용 문자, 8~64자)와 같다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/signup');
    await fillSignupStepOne(page, { email: `e2e.nobody.${uniqueTag()}@silverbridge.test`, password: VALID_PASSWORD, passwordCheck: VALID_PASSWORD });
    const next = page.getByRole('button', { name: '다음' });
    await expect(next, '기준선: BE 도 허용하는 비밀번호는 통과').toBeEnabled();

    const cases: { pw: string; ok: boolean; why: string }[] = [
      { pw: '12345678!', ok: false, why: "영문 없는 '12345678!' 는 BE 가 400 인데 FE 는 통과시킨다" },
      { pw: '가나다라마바사1!', ok: false, why: '한글 포함 비밀번호는 BE 가 400 인데 FE 는 통과시킨다' },
      { pw: `Abcdefg1!${'a'.repeat(56)}`, ok: false, why: '65자 비밀번호는 BE(@Size 8~64)가 400 인데 FE 는 통과시킨다' },
      { pw: 'Abcdefg1_', ok: true, why: "밑줄(_)만 특수문자인 'Abcdefg1_' 는 BE 가 허용하는데 FE 가 거부한다" },
    ];
    for (const c of cases) {
      await page.getByPlaceholder('8자 이상').fill(c.pw);
      await page.getByPlaceholder('비밀번호 다시 입력').fill(c.pw);
      if (c.ok) await expect.soft(next, c.why).toBeEnabled({ timeout: 5_000 });
      else await expect.soft(next, c.why).toBeDisabled({ timeout: 5_000 });
    }
  });

  test("[FEUX-G12] 이메일 '+' 별칭을 허용하고, 대소문자만 다른 이메일은 같은 계정으로 취급한다", async ({ openAs, tempUser }) => {
    await test.step("가입 화면이 'user+alias@' 형식을 형식 오류로 막지 않는다", async () => {
      const page = await openAs('anonymous', '/signup');
      await page.getByPlaceholder('example@email.com').fill(`e2e.plus+${uniqueTag()}@silverbridge.test`);
      await page.getByPlaceholder('example@email.com').blur();
      await page.getByPlaceholder('홍길동').click();
      await expect
        .soft(page.getByText('이메일 형식이 올바르지 않습니다.'), "FE 이메일 정규식에 '+' 가 없어 BE 가 허용하는 주소를 막는다")
        .toHaveCount(0);
    });

    await test.step('대소문자만 다른 이메일은 중복이고 같은 계정으로 로그인된다', async () => {
      const user = await tempUser('GUARDIAN');
      const upper = user.email.toUpperCase();
      expect(upper).not.toBe(user.email);

      redisDelPattern('rate:email-check:*');
      const direct = await request.newContext({ baseURL: env.apiUrl });
      const res = await direct.post(EMAIL_CHECK, { data: { email: upper } });
      const resText = await res.text();
      await direct.dispose();
      expect
        .soft(res.status(), `이미 가입된 이메일의 대문자 변형이 중복으로 잡히지 않는다: ${resText.slice(0, 150)}`)
        .toBe(409);

      relaxRateLimits();
      const login = await Api.signinWithRetry(upper, user.password).then(
        () => null,
        error => error as ApiError,
      );
      expect.soft(login?.message ?? null, '가입 때와 대소문자가 다르면 로그인이 실패한다 (이메일 정규화 없음)').toBeNull();
    });
  });

  test('[FEUX-G13] 가입 비밀번호를 수정하면 비밀번호 확인란도 다시 검증된다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/signup');
    const email = `e2e.nobody.${uniqueTag()}@silverbridge.test`;
    await fillSignupStepOne(page, { email, password: VALID_PASSWORD, passwordCheck: VALID_PASSWORD });
    const next = page.getByRole('button', { name: '다음' });
    await expect(next, '기준선: 일치하는 비밀번호는 통과').toBeEnabled();

    await test.step('일치하던 비밀번호만 바꾸면 불일치가 감지된다', async () => {
      await page.getByPlaceholder('8자 이상').fill('Zzzzzz1!');
      await expect
        .soft(next, '비밀번호만 바꿨는데 확인란이 재검증되지 않아 불일치인 채로 다음 단계로 갈 수 있다')
        .toBeDisabled({ timeout: 5_000 });
    });

    await test.step('확인란 오류 상태에서 비밀번호를 확인란에 맞추면 오류가 풀린다', async () => {
      await page.getByPlaceholder('8자 이상').fill(VALID_PASSWORD);
      await page.getByPlaceholder('비밀번호 다시 입력').fill('Zzzzzz1!');
      await expect(next, '기준선: 불일치면 막힌다').toBeDisabled();
      await expect(page.getByText(/비밀번호가 일치하지 않습니다/)).toBeVisible();

      await page.getByPlaceholder('8자 이상').fill('Zzzzzz1!');
      await expect
        .soft(next, '정상으로 고쳤는데 확인란 오류가 남아 다음 버튼이 계속 비활성이다')
        .toBeEnabled({ timeout: 5_000 });
      await expect.soft(page.getByText(/비밀번호가 일치하지 않습니다/)).toHaveCount(0);
    });
  });
});

test.describe('프로필 모달', () => {
  test('[FEUX-G15] 프로필 모달은 저장·이미지 변경 결과를 바로 반영하고, 전화 변경 후에도 다른 항목을 저장할 수 있다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    const page = await openAs(who, null);

    // 프로필 이미지: 서버에는 올리지 않고 응답만 가짜로 준다 (조회 응답에 이미지 주입)
    const tinyPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const imageUrl = `data:image/png;base64,${tinyPng}`;
    const mock = { image: null as string | null, profile: null as Record<string, unknown> | null };
    await page.route('**/api/user/me', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      mock.profile = body.data;
      if (mock.image) body.data.profileImage = mock.image;
      return route.fulfill({ response, json: body });
    });
    await page.route('**/api/user/me/image', route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      mock.image = imageUrl;
      return route.fulfill({ json: { code: 200, success: true, message: 'OK', data: { ...mock.profile, profileImage: imageUrl } } });
    });

    await page.goto('/guardian');
    await expect(nav(page, 'GUARDIAN')).toBeVisible();

    const sidebar = page.getByRole('complementary', { name: /메뉴$/ });
    const dialog = page.getByRole('dialog', { name: user.name });
    const openProfile = async () => {
      await sidebar.getByRole('button', { name: new RegExp(user.name) }).click();
      await expect(dialog).toBeVisible();
    };
    const closeProfile = async () => {
      await page.mouse.click(5, 5); // 오버레이 바깥 클릭
      await expect(dialog).toBeHidden();
    };
    const startEdit = async () => {
      const edit = dialog.getByRole('button', { name: '정보 수정' });
      if (await edit.isVisible()) await edit.click();
    };

    await test.step('상세주소를 저장한 뒤 수정 취소해도 저장한 값이 보인다', async () => {
      await openProfile();
      await startEdit();
      const detail = `E2E수정${uniqueTag()}`;
      await dialog.getByPlaceholder('상세 주소').fill(detail);
      await dialog.getByRole('button', { name: '프로필 저장' }).click();
      await expect(dialog.getByText('프로필 정보를 수정했습니다.')).toBeVisible();
      const cancel = dialog.getByRole('button', { name: '수정 취소' });
      if (await cancel.isVisible()) await cancel.click();
      await expect
        .soft(dialog.getByText(detail), '저장 성공 뒤에도 편집 모드가 남아 있고 수정 취소가 열 때의 옛 프로필 값으로 되돌린다')
        .toBeVisible({ timeout: 5_000 });
      await closeProfile();
    });

    await test.step('전화번호를 바꿔 저장한 뒤 다른 항목을 저장해도 재인증을 요구하지 않는다', async () => {
      const newPhone = tempPhone();
      const nonce = randomUUID();
      redis('SET', `sms:verified:${newPhone}`, nonce, 'EX', '600');
      await page.route('**/api/auth/signup/sms/send', route =>
        route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300 } } }),
      );
      await page.route('**/api/auth/signup/sms/verify', route =>
        route.fulfill({ json: { success: true, data: { verificationNonce: nonce } } }),
      );

      await openProfile();
      await startEdit();
      await dialog.locator('input[inputmode="numeric"]').first().fill(newPhone);
      await dialog.getByRole('button', { name: '인증번호 발송' }).click();
      await dialog.getByPlaceholder('인증번호').fill('123456');
      await dialog.getByRole('button', { name: '인증 확인' }).click();
      await expect(dialog.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();
      await dialog.getByRole('button', { name: '프로필 저장' }).click();
      await expect(dialog.getByText('프로필 정보를 수정했습니다.')).toBeVisible();
      expect(psql(`SELECT phone FROM users WHERE id = ${sqlStr(user.id)};`), '전화번호 변경 저장 확인').toBe(newPhone);

      await startEdit();
      const detail = `E2E재저장${uniqueTag()}`;
      await dialog.getByPlaceholder('상세 주소').fill(detail);
      await dialog.getByRole('button', { name: '프로필 저장' }).click();
      await expect
        .soft(
          dialog.getByText('프로필 정보를 수정했습니다.'),
          '옛 전화번호와 비교해 계속 "번호 변경됨"으로 판단해 다른 항목 저장이 SMS 재인증 요구로 막힌다',
        )
        .toBeVisible({ timeout: 5_000 });
      await expect.soft(dialog.getByText('전화번호를 변경하려면 SMS 인증을 완료하세요.')).toBeHidden();
      await closeProfile();
    });

    await test.step('프로필 이미지를 바꾸면 모달 아바타도 바뀐다', async () => {
      await openProfile();
      await dialog.locator('input[type="file"]').setInputFiles({
        name: 'e2e.png',
        mimeType: 'image/png',
        buffer: Buffer.from(tinyPng, 'base64'),
      });
      await expect(sidebar.locator('img[src^="data:image/png"]'), '사이드바 아바타는 바뀐다 (비교 기준)').toBeVisible();
      await expect
        .soft(dialog.locator('img[src^="data:image/png"]'), '모달 안 아바타는 열 때의 프로필 스냅샷을 그대로 보여 준다')
        .toBeVisible({ timeout: 5_000 });
      await expect.soft(dialog.getByRole('button', { name: '프로필 이미지 삭제' })).toBeVisible({ timeout: 5_000 });
    });
  });
});
