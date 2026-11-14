/**
 * 최종 QA - 인증(AUTH) P1a - 화면: 비밀번호 찾기·내 정보·서버 기동 (A35 N19 N20 N22 A30 A15)
 *
 * 임시 사용자만 쓴다. 이메일·문자는 N19·N20 에서 각 1건만 실제로 나가고(임시 주소·임시 번호),
 * A35 는 발송을 가짜로 받고 BE 의 인증코드만 Redis 로 넣는다. 인증코드는 받은 뒤 알려진 값으로 바꿔 입력한다.
 */
import { expect, test } from '../../../src/fixtures';
import { env } from '../../../src/env';
import { psql, redis, sqlStr } from '../../../src/remote';
import { userRowCount, signinRaw, callBe, tokensOf } from './_helpers-auth';
import { ADDRESS } from '../../../src/accounts';
import {
  accessOfPage,
  dashed,
  delMyRateDual,
  EXPIRED_BODY,
  failFirst,
  openPlain,
  openProfileDialog,
  relaxMine,
  TAGS_P1,
  uiLogin,
} from './_helpers-auth-p1a';

test.beforeEach(() => relaxMine());

const NEW_PASSWORD = 'NewPass1!x';
const alertText = (page: import('@playwright/test').Page) => page.getByRole('alert').filter({ hasText: /\S/ });

/** 비밀번호 찾기 3~4단계 공용: 인증번호 입력 후 확인, 새 비밀번호 입력 */
async function typeCodeAndConfirm(page: import('@playwright/test').Page, code: string) {
  await page.getByLabel('인증번호', { exact: true }).fill(code);
  await page.getByRole('button', { name: '확인', exact: true }).click();
}
async function typeNewPassword(page: import('@playwright/test').Page, password: string) {
  await page.getByLabel('새 비밀번호', { exact: true }).fill(password);
  await page.getByLabel('비밀번호 확인', { exact: true }).fill(password);
}

// ---------------------------------------------------------------------------------------------
// 비밀번호 재설정
// ---------------------------------------------------------------------------------------------

test('AUTH-A35 새 비밀번호 단계에서 인증이 만료되면 다시 받기', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const verifyKey = `password:email:verify:${user.email}`;
  const attemptKey = `password:email:attempt:${user.email}`;
  const { page, close } = await openPlain(browser, '/find-password');
  try {
    // 메일은 보내지 않는다: 발송 응답만 가짜로 받고, BE 의 인증코드는 Redis 에 직접 넣는다
    await page.route('**/api/auth/find-password/email/send', route =>
      route.fulfill({ status: 200, json: { success: true, code: 200, message: 'OK', data: { expiresInSeconds: 300, codeLength: 6 } } }),
    );
    redis('SET', verifyKey, '123456', 'EX', '300');
    redis('DEL', attemptKey);

    await page.getByRole('button', { name: /이메일 인증/ }).click();
    await page.getByLabel('이메일').fill(user.email);
    await page.getByRole('button', { name: '인증코드 받기' }).click();
    await typeCodeAndConfirm(page, '123456');
    await expect(page.getByRole('heading', { name: '새 비밀번호' }), '코드 확인을 지나 새 비밀번호 단계').toBeVisible();

    // 코드 확인 뒤 5분이 지난 것과 같은 상태: 이 임시 사용자의 인증코드 키만 지운다
    redis('DEL', verifyKey, attemptKey);
    await typeNewPassword(page, NEW_PASSWORD);
    await page.getByRole('button', { name: '비밀번호 변경' }).click();

    await expect(alertText(page), '만료 오류 안내').toContainText('만료');
    const again = page.getByRole('button', { name: '인증 다시 받기' });
    await expect(again, "'인증 다시 받기' 버튼으로 처음부터 재요청할 수 있어야 한다").toBeVisible();
    await again.click();
    await expect(page.getByRole('button', { name: /이메일 인증/ }), '처음 단계(인증 방법 선택)로 돌아간다').toBeVisible();
  } finally {
    redis('DEL', verifyKey, attemptKey);
    await delMyRateDual('pw-reset-email', 'pw-reset-email-verify');
    await relaxMine(['rate:pw-reset-confirm:*']);
    await close();
  }
});

test('AUTH-N19 이메일 3단계로 재설정 후 새 비밀번호로 바로 로그인', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(240_000);
  const user = await tempUser('GUARDIAN');
  const verifyKey = `password:email:verify:${user.email}`;
  const attemptKey = `password:email:attempt:${user.email}`;
  const countKey = `password:email:sendcount:${user.email}`;
  const { page, close } = await openPlain(browser, '/find-password');
  try {
    await delMyRateDual('pw-reset-email');
    const posts: { path: string; keys: string[] }[] = [];
    page.on('request', req => {
      if (req.method() === 'POST' && /\/api\/auth\/(find-password|password)/.test(req.url())) {
        posts.push({ path: new URL(req.url()).pathname, keys: Object.keys((req.postDataJSON() ?? {}) as object).sort() });
      }
    });

    await page.getByRole('button', { name: /이메일 인증/ }).click();
    await page.getByLabel('이메일').fill(user.email);
    await page.getByRole('button', { name: '인증코드 받기' }).click(); // 실제 메일 1통(.test 주소)
    await expect(page.getByLabel('인증번호', { exact: true }), '2단계: 발송 뒤 코드 입력 화면').toBeVisible({ timeout: 30_000 });
    const ttl = Number(redis('TTL', verifyKey));
    expect(ttl, `발송된 코드가 저장돼 있다(TTL ${ttl}초)`).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    redis('SET', verifyKey, '123456', 'EX', '300'); // 받은 코드를 알려진 값으로 바꾼다(메일을 읽을 수 없으므로)
    redis('DEL', attemptKey);
    await typeCodeAndConfirm(page, '123456');
    await expect(page.getByRole('heading', { name: '새 비밀번호' }), '코드 확인 뒤 새 비밀번호 단계').toBeVisible({ timeout: 20_000 });
    expect(redis('EXISTS', verifyKey), 'verify 는 코드를 소비하지 않는다').toBe('1');

    await typeNewPassword(page, NEW_PASSWORD);
    await page.getByRole('button', { name: '비밀번호 변경' }).click();
    await expect(page.getByText('비밀번호가 변경되었습니다'), '변경 완료 안내').toBeVisible({ timeout: 20_000 });
    expect(redis('EXISTS', verifyKey), 'reset 이 성공하면 코드가 소비된다').toBe('0');

    const reset = posts.find(p => p.path.endsWith('/password/reset'));
    expect(reset?.keys, 'reset 에는 email 만 보낸다(phone 은 보내지 않는다)').toEqual(['code', 'email', 'newPassword']);
    expect(posts.map(p => p.path.replace('/api/auth', '')), '세 단계 요청 순서').toEqual([
      '/find-password/email/send',
      '/find-password/email/verify',
      '/password/reset',
    ]);

    // 변경 직후 바로 로그인: 같은 초에 발급된 토큰도 유효하다
    await relaxMine();
    const direct = await signinRaw(user.email, NEW_PASSWORD);
    expect(direct.status, `새 비밀번호로 바로 로그인 ${direct.status} ${direct.code}`).toBe(200);
    const me = await callBe('GET', '/api/user/me', { token: tokensOf(direct).access });
    expect(me.status, `방금 받은 토큰으로 내 정보 조회 ${me.status} ${me.code}`).toBe(200);

    await page.getByRole('button', { name: '로그인하기' }).click();
    await expect(page).toHaveURL(/\/login/);
    await uiLogin(page, user.email, NEW_PASSWORD);
    await expect(page, '화면 로그인도 된다').toHaveURL(/\/guardian$/, { timeout: 30_000 });
  } finally {
    redis('DEL', verifyKey, attemptKey, countKey);
    await delMyRateDual('pw-reset-email', 'pw-reset-email-verify');
    await relaxMine(['rate:pw-reset-confirm:*']);
    await close();
  }
});

test('AUTH-N20 SMS 3단계로 재설정', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(240_000);
  test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 문자가 나가는 케이스라 건너뜀');
  const user = await tempUser('GUARDIAN');
  const phone = user.phone as string;
  const verifyKey = `password:sms:verify:${phone}`;
  const attemptKey = `password:sms:attempt:${phone}`;
  const countKey = `sms:sendcount:${phone}`;
  const { page, close } = await openPlain(browser, '/find-password');
  try {
    await delMyRateDual('pw-reset-sms');
    const posts: { path: string; keys: string[] }[] = [];
    page.on('request', req => {
      if (req.method() === 'POST' && /\/api\/auth\/(find-password|password)/.test(req.url())) {
        posts.push({ path: new URL(req.url()).pathname, keys: Object.keys((req.postDataJSON() ?? {}) as object).sort() });
      }
    });

    await page.getByRole('button', { name: /SMS 인증/ }).click();
    await page.getByLabel('이름', { exact: true }).fill(user.name);
    await page.getByLabel('휴대폰 번호').fill(phone);
    await page.getByRole('button', { name: '인증코드 받기' }).click(); // 실제 문자 1건(임시 번호)
    await expect(page.getByLabel('인증번호', { exact: true }), '2단계: 발송 뒤 코드 입력 화면').toBeVisible({ timeout: 30_000 });
    const ttl = Number(redis('TTL', verifyKey));
    expect(ttl, `발송된 코드가 저장돼 있다(TTL ${ttl}초)`).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(300);

    redis('SET', verifyKey, '123456', 'EX', '300'); // 받은 코드를 알려진 값으로 바꾼다
    redis('DEL', attemptKey);
    await typeCodeAndConfirm(page, '123456');
    await expect(page.getByRole('heading', { name: '새 비밀번호' }), '코드 확인 뒤 새 비밀번호 단계').toBeVisible({ timeout: 20_000 });
    expect(redis('EXISTS', verifyKey), 'verify 는 코드를 소비하지 않는다').toBe('1');

    await typeNewPassword(page, NEW_PASSWORD);
    await page.getByRole('button', { name: '비밀번호 변경' }).click();
    await expect(page.getByText('비밀번호가 변경되었습니다'), '변경 완료 안내').toBeVisible({ timeout: 20_000 });
    expect(redis('EXISTS', verifyKey), 'reset 이 성공하면 코드가 소비된다').toBe('0');

    const reset = posts.find(p => p.path.endsWith('/password/reset'));
    expect(reset?.keys, 'reset 에는 phone 만 보낸다(email 은 보내지 않는다)').toEqual(['code', 'newPassword', 'phone']);
    expect(posts.map(p => p.path.replace('/api/auth', '')), '세 단계 요청 순서').toEqual([
      '/find-password/sms/send',
      '/find-password/sms/verify',
      '/password/reset',
    ]);

    await relaxMine();
    const direct = await signinRaw(user.email, NEW_PASSWORD);
    expect(direct.status, `새 비밀번호로 로그인 ${direct.status} ${direct.code}`).toBe(200);
  } finally {
    redis('DEL', verifyKey, attemptKey, countKey);
    await delMyRateDual('pw-reset-sms', 'pw-reset-sms-verify');
    await relaxMine(['rate:pw-reset-confirm:*']);
    await close();
  }
});

// ---------------------------------------------------------------------------------------------
// 내 정보
// ---------------------------------------------------------------------------------------------

test('AUTH-N22 내 프로필 조회와 수정', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(240_000);
  const guardian = await tempUser('GUARDIAN');
  const { page, close } = await openPlain(browser, '/login');
  try {
    await uiLogin(page, guardian.email, guardian.password);
    await expect(page).toHaveURL(/\/guardian$/);
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();

    await test.step('조회: 프로필 모달이 내 정보를 보여 준다', async () => {
      const dialog = await openProfileDialog(page, '보호자', new RegExp(guardian.name));
      await expect(dialog.getByRole('heading', { level: 2, name: guardian.name })).toBeVisible();
      await expect(dialog).toContainText(dashed(guardian.phone as string));
      await expect(dialog).toContainText(guardian.email);
      const me = await callBe('GET', '/api/user/me', { token: await accessOfPage(page) });
      expect(me.status, `GET /api/user/me ${me.status}`).toBe(200);
      expect(me.json?.data?.name, '조회한 이름').toBe(guardian.name);
      await dialog.getByRole('button', { name: '닫기' }).first().click();
    });

    const uiName = 'E2E화면수정';
    await test.step('수정(화면): 이름을 바꾸면 모달에 바로 반영되고 서버에도 저장된다', async () => {
      const dialog = await openProfileDialog(page, '보호자', new RegExp(guardian.name));
      await dialog.getByRole('button', { name: '이름 바꾸기' }).click();
      await dialog.getByRole('textbox', { name: '이름' }).fill(uiName);
      await dialog.getByRole('button', { name: '저장', exact: true }).click();
      await expect(dialog.getByRole('heading', { level: 2, name: uiName }), '모달에 새 이름이 바로 보인다').toBeVisible();
      const me = await callBe('GET', '/api/user/me', { token: await accessOfPage(page) });
      expect(me.json?.data?.name, '서버에 저장된 이름').toBe(uiName);
      await dialog.getByRole('button', { name: '닫기' }).first().click();
    });

    await test.step('수정(PUT 전체 필드): 조회에 반영되고, 다시 연 프로필 모달에도 최신 값이 보인다', async () => {
      const token = await accessOfPage(page);
      const next = {
        name: 'E2E서버수정',
        phone: guardian.phone,
        gender: 'FEMALE',
        birthDate: '1980-02-03',
        postcode: ADDRESS.postcode,
        address: ADDRESS.address,
        addressDetail: 'E2E 변경동 303호',
      };
      const put = await callBe('PUT', '/api/user/me', { token, data: next });
      expect(put.status, `PUT /api/user/me ${put.status} ${put.code}`).toBe(200);
      const me = await callBe('GET', '/api/user/me', { token });
      expect(me.status, `GET /api/user/me ${me.status}`).toBe(200);
      const got = me.json?.data ?? {};
      expect({ name: got.name, gender: got.gender, birthDate: got.birthDate, addressDetail: got.addressDetail, postcode: got.postcode }, '조회 값이 수정 값과 같다').toEqual({
        name: next.name,
        gender: next.gender,
        birthDate: next.birthDate,
        addressDetail: next.addressDetail,
        postcode: next.postcode,
      });

      test.info().annotations.push({
        type: '기획 확인 필요',
        description:
          '이 단계는 브라우저 밖 API 로 고친 값(다른 기기에서 고친 경우와 같다)이 새로고침 없이 연 모달에 보여야 한다고 본다. 배포 FE 는 프로필 조회 캐시(staleTime 5분)를 써서 다시 조회하지 않는다. 같은 화면 안 수정(2단계)은 바로 반영된다. 케이스가 "다른 기기 수정"까지 포함하는지 기획 확인이 필요하다',
      });
      // 새로고침 없이 모달을 다시 열면 최신 프로필이 보여야 한다(FEUX-G15: 항상 최신 프로필 표시)
      const dialog = await openProfileDialog(page, '보호자', new RegExp(`${uiName}|${next.name}`));
      await expect(dialog.getByRole('heading', { level: 2, name: next.name }), '다시 연 모달의 이름이 최신 값').toBeVisible({ timeout: 15_000 });
      await expect(dialog, '다시 연 모달의 상세 주소가 최신 값').toContainText('E2E 변경동 303호');
      await expect(dialog, '다시 연 모달의 성별·생년월일이 최신 값').toContainText('여성 · 1980년 2월 3일');
    });
  } finally {
    await close();
  }
});

test('AUTH-A30 로그인이 오래된 뒤 사진 삭제·비번 변경·탈퇴는 갱신 후 재시도', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(420_000);
  const changePw = await tempUser('GUARDIAN');
  const leaver = await tempUser('GUARDIAN');
  const admin = await tempUser('ADMIN');
  psql(
    `UPDATE users SET profile_image = ${sqlStr('https://example.invalid/e2e-p1a-photo.png')} WHERE id = ${sqlStr(admin.id)} AND email LIKE 'e2e.%@silverbridge.test';`,
  );

  /** 로그인한 컨텍스트에서 refresh 호출 수를 센다 */
  const countRefresh = (context: import('@playwright/test').BrowserContext) => {
    const calls: number[] = [];
    context.on('response', res => {
      if (res.url().includes('/api/auth/refresh') && res.request().method() === 'POST') calls.push(res.status());
    });
    return calls;
  };

  await test.step('비밀번호 변경: 첫 요청이 만료(401)여도 갱신 후 재시도해 성공', async () => {
    const { page, context, close } = await openPlain(browser, '/login');
    try {
      await uiLogin(page, changePw.email, changePw.password);
      await expect(page).toHaveURL(/\/guardian$/);
      await page.goto('/guardian/settings');
      await page.getByRole('tab', { name: '계정·보안' }).click();
      await page.getByRole('button', { name: '변경', exact: true }).click();
      await page.getByRole('textbox', { name: '현재 비밀번호' }).fill(changePw.password);
      await page.getByRole('textbox', { name: '새 비밀번호 (8자 이상)' }).fill(NEW_PASSWORD);
      await page.getByRole('textbox', { name: '새 비밀번호 확인' }).fill(NEW_PASSWORD);
      const refreshCalls = countRefresh(context);
      const stub = await failFirst(page, { method: 'PUT', pathEnds: '/user/me/password' }, { status: 401, json: EXPIRED_BODY });
      await page.getByRole('button', { name: '변경하기' }).click();
      await expect.poll(() => stub.fired, { message: '만료(401) 응답이 나갔다', timeout: 20_000 }).toBe(1);
      await expect.soft(page.getByText('비밀번호 변경 완료'), '갱신 후 재시도로 성공 안내').toBeVisible({ timeout: 15_000 });
      expect.soft(refreshCalls, '갱신(refresh)을 한 번 시도했다').toEqual([200]);
      await relaxMine();
      const login = await signinRaw(changePw.email, NEW_PASSWORD);
      expect.soft(login.status, `새 비밀번호로 로그인 ${login.status} ${login.code} (재시도되지 않았다면 옛 비밀번호 그대로)`).toBe(200);
    } finally {
      await close();
    }
  });

  await test.step('탈퇴: 첫 요청이 만료(401)여도 갱신 후 재시도해 성공', async () => {
    const { page, context, close } = await openPlain(browser, '/login');
    try {
      await uiLogin(page, leaver.email, leaver.password);
      await expect(page).toHaveURL(/\/guardian$/);
      await page.goto('/guardian/settings');
      await page.getByRole('tab', { name: '계정·보안' }).click();
      const refreshCalls = countRefresh(context);
      const stub = await failFirst(page, { method: 'DELETE', pathEnds: '/user/me' }, { status: 401, json: EXPIRED_BODY });
      await page.getByRole('button', { name: '탈퇴', exact: true }).click();
      await page.getByRole('button', { name: '계속하기' }).click();
      await page.getByRole('textbox', { name: '비밀번호' }).fill(leaver.password);
      await page.getByRole('button', { name: '탈퇴하기' }).click();
      await expect.poll(() => stub.fired, { message: '만료(401) 응답이 나갔다', timeout: 20_000 }).toBe(1);
      await expect.soft(page, '갱신 후 재시도로 탈퇴가 끝나 로그인 화면으로 간다').toHaveURL(/\/login/, { timeout: 15_000 });
      expect.soft(refreshCalls, '갱신(refresh)을 한 번 시도했다').toEqual([200]);
      expect.soft(userRowCount(leaver.id), '탈퇴한 사용자 행이 지워졌다').toBe(0);
    } finally {
      await close();
    }
  });

  await test.step('사진 삭제(관리자 프로필 모달): 첫 요청이 만료(401)여도 갱신 후 재시도해 성공', async () => {
    const { page, context, close } = await openPlain(browser, '/login');
    try {
      await uiLogin(page, admin.email, admin.password);
      await expect(page).toHaveURL(/\/admin/, { timeout: 30_000 });
      const dialog = await openProfileDialog(page, '관리자', new RegExp(admin.name), '운영자 프로필');
      const refreshCalls = countRefresh(context);
      const stub = await failFirst(page, { method: 'DELETE', pathEnds: '/user/me/image' }, { status: 401, json: EXPIRED_BODY });
      await dialog.getByRole('button', { name: '프로필 이미지 삭제' }).click();
      await page.getByRole('button', { name: '삭제', exact: true }).click();
      await expect.poll(() => stub.fired, { message: '만료(401) 응답이 나갔다', timeout: 20_000 }).toBe(1);
      await expect
        .configure({ soft: true })
        .poll(() => psql(`SELECT coalesce(profile_image, '') FROM users WHERE id = ${sqlStr(admin.id)};`), {
          message: '갱신 후 재시도로 사진이 삭제됐다(DB 값이 비었다)',
          timeout: 15_000,
        })
        .toBe('');
      expect.soft(refreshCalls, '갱신(refresh)을 한 번 시도했다').toEqual([200]);
    } finally {
      await close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// 서버 기동
// ---------------------------------------------------------------------------------------------

test.fixme(
  'AUTH-A15 필수 환경변수 누락·약한 JWT_SECRET/KAKAO_CLIENT_SECRET이면 기동 중단',
  TAGS_P1,
  async () => {
    // 이유: 서버를 새로 기동해 봐야 확인되는 케이스다. 서버 설정·컨테이너 변경(docker stop/restart, 환경변수 바꿔 기동)이
    // 금지돼 있고 공용 dev 서버를 멈출 수 없다. 배포 코드(BE 3400-3411 근처의 기동 검사)를 읽는 정적 확인이나
    // 별도 격리 환경(테스트용 컨테이너)에서 수동으로 확인한다.
  },
);
