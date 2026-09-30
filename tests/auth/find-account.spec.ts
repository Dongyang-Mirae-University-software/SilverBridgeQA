/**
 * 아이디 찾기 / 비밀번호 찾기
 * 비밀번호 찾기는 실제 인증번호 발송(메일/문자)이 끼므로, 발송 직전까지의 화면 흐름과 입력 검증만 본다.
 */
import { ACCOUNTS } from '../../src/accounts';
import { expect, test } from '../../src/fixtures';
import { relaxRateLimits } from '../../src/seed';

test.beforeEach(() => relaxRateLimits());

test.describe('아이디 찾기', () => {
  test('이름과 전화번호로 마스킹된 이메일과 가입일을 보여준다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/find-email');
    await expect(page.getByRole('button', { name: '아이디 찾기' })).toBeDisabled();

    await page.getByLabel('이름').fill(ACCOUNTS.guardian1.name);
    await page.getByLabel('전화번호').fill(ACCOUNTS.guardian1.phone);
    await expect(page.getByLabel('전화번호')).toHaveValue('010-0000-9101');
    await page.getByRole('button', { name: '아이디 찾기' }).click();

    await expect(page.getByText('회원님의 아이디')).toBeVisible();
    const email = page.getByText(/@silverbridge\.test$/);
    await expect(email).toBeVisible();
    await expect(email).not.toHaveText(ACCOUNTS.guardian1.email);

    test.info().annotations.push({
      type: 'issue',
      description: 'BE 는 joinedAt 을 주는데 FE 는 createdAt 을 읽어서 가입일이 안 나옴 (FindEmailResultDisplay.tsx)',
    });
    await expect(page.getByText(/^가입일 /)).toBeVisible({ timeout: 5_000 });
  });

  test('일치하는 회원이 없으면 안내한다', async ({ openAs }) => {
    test.info().annotations.push({
      type: 'issue',
      description: 'requestEmail 이 mutateAsync 를 그대로 반환하고 호출부에서 catch 하지 않아, 실패 시 처리되지 않은 AxiosError 가 발생 (useFindEmailFlow.ts:51)',
    });
    const page = await openAs('anonymous', '/find-email');
    await page.getByLabel('이름').fill('없는사람');
    await page.getByLabel('전화번호').fill('01000009999');
    await page.getByRole('button', { name: '아이디 찾기' }).click();
    await expect(page.getByRole('main').getByText('사용자를 찾을 수 없습니다.')).toBeVisible();
    await expect(page.getByText('회원님의 아이디')).toHaveCount(0);
  });
});

test.describe('비밀번호 찾기', () => {
  test('인증 방식 선택 화면이 뜨고 이메일·SMS 방식을 고를 수 있다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/find-password');
    await expect(page.getByRole('heading', { name: '비밀번호 찾기' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /이메일 인증/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /SMS 인증/ })).toBeVisible();
  });
});
