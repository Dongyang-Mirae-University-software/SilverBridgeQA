/**
 * 최종 QA - 인증(AUTH) P2 - 아이디 찾기·프로필 사진·비밀번호 찾기 대기·로그인 화면 접근성 (N18 N25 A36 A43 A56)
 *
 * 임시 사용자만 쓴다. 파일 서버에는 아주 작은 사진만 올리고, 끝나면 그 사용자가 자기 사진을 지워 정리한다.
 * 메일은 보내지 않는다(A36 은 발송 요청을 대체).
 */
import { expect, test } from '../../../src/fixtures';
import { redis } from '../../../src/remote';
import { uniqueTestPhone } from '../../../src/seed';
import { callBe, signinRaw, tokensOf } from './_helpers-auth';
import { openPlain, relaxMine, retryAfterOf, uiLogin, openProfileDialog } from './_helpers-auth-p1a';
import { httpStatusOf, patchImage, TINY_PNG } from './_helpers-auth-p1b';
import {
  delProfileImageRate,
  maskEmailLikeBe,
  relaxP2,
  TAGS_P2,
  TINY_GIF,
  TINY_JPEG,
  TINY_WEBP,
  userColumn,
} from './_helpers-auth-p2';

test.beforeEach(() => relaxP2());

test('AUTH-N18 이름+전화번호로 마스킹 이메일과 가입일 확인', TAGS_P2, async ({ tempUser, openAs }) => {
  const user = await tempUser('GUARDIAN', { name: 'E2E아이디찾기' });
  const page = await openAs('anonymous', '/find-email');
  await page.getByLabel('이름').fill(user.name);
  await page.getByLabel('전화번호').fill(user.phone as string);
  const found = page.waitForResponse(r => r.url().endsWith('/api/auth/find-email') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: '아이디 찾기' }).click();
  const res = await found;
  expect(res.status(), `아이디 찾기 ${res.status()}`).toBe(200);
  const data = (await res.json()).data as { maskedEmail: string; joinedAt: string; hasKakaoAccount: boolean };

  const masked = maskEmailLikeBe(user.email);
  expect(data.maskedEmail, 'BE 가 돌려준 마스킹 이메일').toBe(masked);
  expect(data.joinedAt, 'BE 가 돌려준 가입일(yyyy-MM-dd)').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(data.hasKakaoAccount, '카카오 계정 없음').toBe(false);
  test.info().annotations.push({
    type: '문서와 다른 점',
    description:
      '케이스 예시는 "us**@example.com" 이지만 배포 BE(MaskingUtil.maskEmail)는 앞부분이 5자 이상이면 "앞 2자 + *** + 뒤 2자 + 도메인" 이다. 코드 값으로 고정했다',
  });

  await expect(page.getByText('회원님의 아이디')).toBeVisible();
  await expect(page.getByText(masked, { exact: true }), '화면에 마스킹 이메일').toBeVisible();
  await expect(page.getByText(`가입일 ${data.joinedAt}`), '화면에 가입일(joinedAt)').toBeVisible({ timeout: 3_000 });
});

test('AUTH-N25 사진 교체(5MB 이하 JPG/PNG/WebP/GIF)와 삭제 멱등', TAGS_P2, async ({ tempUser, loginAs }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const { login } = await loginAs(user);
  const token = login.accessToken;
  try {
    const files = [
      { name: 'a.png', mimeType: 'image/png', buffer: TINY_PNG },
      { name: 'a.jpg', mimeType: 'image/jpeg', buffer: TINY_JPEG },
      { name: 'a.webp', mimeType: 'image/webp', buffer: TINY_WEBP },
      { name: 'a.gif', mimeType: 'image/gif', buffer: TINY_GIF },
    ];
    let previous = '';
    for (const file of files) {
      await test.step(`${file.mimeType} 업로드는 200 이고 기존 파일은 지워진다`, async () => {
        const res = await patchImage(token, file);
        expect(res.status, `${file.mimeType} 업로드 ${res.status} ${res.code}`).toBe(200);
        const url = userColumn(user.id, 'profile_image');
        expect(url, '새 이미지 주소가 저장된다').toMatch(/^https?:\/\//);
        expect(url, '이전과 다른 주소').not.toBe(previous);
        expect(await httpStatusOf(url), '새 파일은 열린다').toBe(200);
        if (previous) {
          await expect.poll(() => httpStatusOf(previous), { message: '교체 시 기존 파일이 삭제된다', timeout: 20_000 }).toBe(404);
        }
        previous = url;
      });
    }

    await test.step('5MB 경계: 5MB 를 넘는 파일은 거절되고 사진은 바뀌지 않는다', async () => {
      const before = userColumn(user.id, 'profile_image');
      // 시그니처만 맞춘 PNG 에 0 을 채워 5MB + 1바이트로 만든다(거절 경로만 쓰므로 파일 서버에 남지 않는다)
      const big = Buffer.concat([TINY_PNG, Buffer.alloc(5 * 1024 * 1024 + 1 - TINY_PNG.length)]);
      const res = await patchImage(token, { name: 'big.png', mimeType: 'image/png', buffer: big });
      expect(res.status, `5MB 초과 업로드 ${res.status} ${res.code}`).toBe(400);
      expect(res.code, '실패 code 가 있다').toBeTruthy();
      expect(userColumn(user.id, 'profile_image'), '거절 뒤 사진 주소는 그대로').toBe(before);
    });

    await test.step('삭제는 두 번 연속 모두 200, 메시지만 다르다', async () => {
      const first = await callBe('DELETE', '/api/user/me/image', { token });
      expect(first.status, `첫 삭제 ${first.status} ${first.code}`).toBe(200);
      expect(first.message).toBe('프로필 이미지가 삭제되었습니다.');
      expect(userColumn(user.id, 'profile_image'), '삭제 뒤 이미지 없음').toBe('');
      await expect.poll(() => httpStatusOf(previous), { message: '삭제한 파일은 파일 서버에서도 사라진다', timeout: 20_000 }).toBe(404);

      const second = await callBe('DELETE', '/api/user/me/image', { token });
      expect(second.status, `둘째 삭제 ${second.status} ${second.code}`).toBe(200);
      expect(second.message).toBe('설정된 프로필 이미지가 없어 기본 이미지를 사용 중입니다.');
    });
  } finally {
    // 단언이 중간에 실패해도 올려 둔 사진은 사용자가 자기 사진을 지워 정리한다
    await callBe('DELETE', '/api/user/me/image', { token });
    delProfileImageRate(user.id);
  }
});

test('AUTH-A43 사진 속도 제한 1분 5회/1시간 30회, 업로드가 10초 넘어도 성공 표시', TAGS_P2, async ({ tempUser, loginAs, browser }) => {
  test.setTimeout(240_000);
  const apiUser = await tempUser('GUARDIAN');
  const uiUser = await tempUser('GUARDIAN');
  const { login } = await loginAs(apiUser);
  const token = login.accessToken;
  const png = { name: 'rate.png', mimeType: 'image/png', buffer: TINY_PNG };
  const { page, close } = await openPlain(browser, '/login');
  try {
    await test.step('1분 5회: 6번째 PATCH 는 429 TOO_MANY_REQUESTS 와 Retry-After', async () => {
      delProfileImageRate(apiUser.id);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await patchImage(token, png)).status);
      expect(statuses, '앞 5번은 모두 200').toEqual([200, 200, 200, 200, 200]);
      const sixth = await patchImage(token, png);
      expect(sixth.status, `6번째 ${sixth.status} ${sixth.code}`).toBe(429);
      expect(sixth.code).toBe('TOO_MANY_REQUESTS');
      expect(retryAfterOf(sixth), 'Retry-After(초)가 1~60').toBeGreaterThanOrEqual(1);
      expect(retryAfterOf(sixth)).toBeLessThanOrEqual(60);
    });

    await test.step('1시간 30회: 시간 창 카운터가 30 이면 다음 PATCH 는 429, Retry-After 는 1분보다 길다', async () => {
      delProfileImageRate(apiUser.id);
      redis('SET', `rate:profile-image:1h:${apiUser.id}`, '30', 'EX', '3600');
      const res = await patchImage(token, png);
      expect(res.status, `31번째 ${res.status} ${res.code}`).toBe(429);
      expect(res.code).toBe('TOO_MANY_REQUESTS');
      expect(retryAfterOf(res), '시간 창 한도라 Retry-After 가 60초보다 길다').toBeGreaterThan(60);
    });

    await test.step('화면: 업로드 응답이 10초 넘게 걸려도 끝나면 새 사진이 보이고 실패 안내는 남지 않는다', async () => {
      await uiLogin(page, uiUser.email, uiUser.password);
      await expect(page).toHaveURL(/\/guardian$/);
      const dialog = await openProfileDialog(page, '보호자', new RegExp(uiUser.name));
      // 서버는 정상 처리하고, 응답만 12초 늦게 돌려준다(화면의 기본 대기 10초를 넘긴다)
      await page.route('**/api/user/me/image', async route => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        const response = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 12_000));
        await route.fulfill({ response });
      });
      await dialog.locator('input[type="file"]').first().setInputFiles(png);
      await expect(dialog.getByText('사진을 올리는 중이에요')).toBeVisible();
      await expect.poll(() => userColumn(uiUser.id, 'profile_image'), { message: '서버에는 사진이 저장된다', timeout: 30_000 }).toMatch(/^https?:\/\//);
      const saved = userColumn(uiUser.id, 'profile_image');
      const fileName = saved.split('/').pop() as string;
      await expect(dialog.getByText('사진을 올리는 중이에요'), '올리는 중 표시가 끝난다').toBeHidden({ timeout: 30_000 });
      await expect
        .poll(() => dialog.locator('img').evaluateAll((imgs, name) => imgs.some(img => decodeURIComponent((img as HTMLImageElement).src).includes(name)), fileName), {
          message: '서버에 저장된 새 사진이 프로필 칸에 보인다',
          timeout: 30_000,
        })
        .toBe(true);
      await expect(dialog.getByText('알 수 없는 오류'), '실패 안내는 남지 않는다').toHaveCount(0);
    });
  } finally {
    await close();
    await callBe('DELETE', '/api/user/me/image', { token });
    delProfileImageRate(apiUser.id);
    // 화면 사용자의 사진은 서버에 남아 있을 수 있으므로 그 사용자 토큰으로 지운다
    await relaxMine();
    const ui = await signinRaw(uiUser.email, uiUser.password);
    if (ui.status === 200) await callBe('DELETE', '/api/user/me/image', { token: tokensOf(ui).access });
    delProfileImageRate(uiUser.id);
  }
});

test('AUTH-A36 메일 발송이 느려도(10~12초) 실패로 오해하지 않음', TAGS_P2, async ({ tempUser, openAs }) => {
  test.setTimeout(120_000);
  const user = await tempUser('GUARDIAN');
  const page = await openAs('anonymous', null);
  // 메일은 보내지 않는다: 발송 요청을 가로채 12초 뒤 성공으로 답한다
  await page.route('**/api/auth/find-password/email/send', async route => {
    await new Promise(resolve => setTimeout(resolve, 12_000));
    await route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } });
  });
  await page.goto('/find-password');
  await page.getByRole('button', { name: /이메일 인증/ }).click();
  const email = page.getByPlaceholder('이메일을 입력하세요');
  await email.fill(user.email);
  await page.getByRole('button', { name: '인증코드 받기' }).click();
  const clickedAt = Date.now();

  await expect(page.getByRole('button', { name: '발송 중...' }), '기다리는 동안 대기 안내(발송 중...)가 보인다').toBeDisabled();
  // 10초가 지난 11초 시점에도 대기 안내가 유지돼야 한다(응답은 12초에 온다)
  await page.waitForTimeout(Math.max(0, 11_000 - (Date.now() - clickedAt)));
  await expect.soft(page.getByRole('button', { name: '발송 중...' }), '11초 시점에도 대기 안내(발송 중...)가 유지된다').toBeVisible({ timeout: 500 });
  // 12초 응답이 도착한 뒤에는 실패 안내 없이 인증코드 입력 단계로 넘어간다
  await expect(email, '성공하면 인증코드 입력 단계로 넘어간다(이메일 입력칸이 사라짐)').toBeHidden({ timeout: 30_000 });
  await expect(page.locator('p[role="alert"]'), '실패 안내가 없다').toHaveCount(0);
  test.info().annotations.push({
    type: '확인 범위',
    description:
      '"10초 넘으면 서버가 내는 실패 응답을 구분 안내"는 문서에 상태 코드·code 가 없어 확인하지 않았다. BE 에 문의해 확정한 뒤 별도 단계로 추가한다(기획 확인 필요)',
  });
});

test('AUTH-A56 기본 접근성: 로그인 입력칸 label 연결, 아이디 찾기 실패 시 처리 안 된 오류 없음', TAGS_P2, async ({ openAs }) => {
  const page = await openAs('anonymous', '/login');
  const pageErrors: string[] = [];
  const axiosErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && /AxiosError/.test(msg.text())) axiosErrors.push(msg.text().slice(0, 200));
  });

  await test.step('로그인: label 이 htmlFor/id 로 입력칸과 연결되고 클릭하면 입력칸에 포커스가 간다', async () => {
    for (const [label, selector] of [['이메일', 'input[name="email"]'], ['비밀번호', 'input[name="password"]']] as const) {
      const labelEl = page.locator('label', { hasText: new RegExp(`^${label}$`) });
      const input = page.locator(selector);
      await expect(labelEl).toHaveCount(1);
      const htmlFor = await labelEl.getAttribute('for');
      const inputId = await input.getAttribute('id');
      expect(htmlFor, `${label} label 의 for`).toBeTruthy();
      expect(htmlFor, `${label} label 의 for 가 입력칸 id 와 같다`).toBe(inputId);
      await labelEl.click();
      await expect(input, `${label} label 을 누르면 입력칸에 포커스`).toBeFocused();
      await expect(page.getByLabel(label, { exact: true })).toHaveCount(1);
    }
  });

  await test.step('아이디 찾기 실패(없는 이름·번호, 404): 안내만 나오고 처리 안 된 오류가 없다', async () => {
    await page.goto('/find-email');
    await page.getByLabel('이름').fill('E2E없는사람');
    await page.getByLabel('전화번호').fill(uniqueTestPhone());
    const found = page.waitForResponse(r => r.url().endsWith('/api/auth/find-email') && r.request().method() === 'POST', { timeout: 30_000 });
    await page.getByRole('button', { name: '아이디 찾기' }).click();
    const res = await found;
    expect(res.status(), '없는 계정은 404').toBe(404);
    const message = (await res.json()).message as string;
    await expect(page.locator('p[role="alert"]'), '서버 안내 문구가 그대로 보인다').toHaveText(message);
  });
  expect(pageErrors, '처리 안 된 JS 오류').toEqual([]);
  expect(axiosErrors, '콘솔의 AxiosError').toEqual([]);
});
