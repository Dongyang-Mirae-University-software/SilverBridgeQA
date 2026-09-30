/**
 * 환경설정 - 알림 채널, 비밀번호 변경, 회원 탈퇴
 *
 * 비밀번호 변경은 그 계정의 토큰을 전부 무효화하고, 탈퇴는 계정을 영구 삭제하므로
 * 각각 전용 계정(guardian3, ward4)을 쓴다. 다음 실행 때 global.setup 이 계정을 다시 만든다.
 */
import { ACCOUNTS } from '../../src/accounts';
import { Api, ApiError } from '../../src/api';
import { env } from '../../src/env';
import { expect, expectPageTitle, test } from '../../src/fixtures';
import { relaxRateLimits } from '../../src/seed';
import { markStale } from '../../src/session';

test.describe('알림 채널 설정', () => {
  test('채널을 켜고 끈 상태가 저장된다', async ({ openAs }) => {
    const page = await openAs('guardian2', '/guardian/settings');
    await expectPageTitle(page, '환경설정');
    await page.getByRole('tab', { name: '알림정보' }).click();

    const push = page.getByRole('checkbox', { name: '앱 푸시 알림 설정' });
    const email = page.getByRole('checkbox', { name: '이메일 설정' });
    // 기본값: 앱 푸시만 켜짐
    await expect(push).toBeChecked();
    await expect(email).not.toBeChecked();

    // 실제 발송 채널(SMS·알림톡)은 건드리지 않고 이메일로 저장 동작을 확인한다
    await page.getByLabel('이메일 설정').click();
    await expect(email).toBeChecked();
    await page.reload();
    await page.getByRole('tab', { name: '알림정보' }).click();
    await expect(page.getByRole('checkbox', { name: '이메일 설정' })).toBeChecked();

    await page.getByLabel('이메일 설정').click();
    await expect(page.getByRole('checkbox', { name: '이메일 설정' })).not.toBeChecked();
    await page.reload();
    await page.getByRole('tab', { name: '알림정보' }).click();
    await expect(page.getByRole('checkbox', { name: '이메일 설정' })).not.toBeChecked();
  });
});

test.describe('비밀번호 변경', () => {
  const G3 = ACCOUNTS.guardian3;
  const newPassword = `${env.password}X`;

  test.afterAll(async () => {
    // 같은 실행의 다른 테스트가 guardian3 을 쓸 수 있으므로 원래 비밀번호로 되돌린다
    relaxRateLimits();
    const api = await Api.as(G3, newPassword).catch(() => null);
    if (api) {
      await api.call('PUT', '/api/user/me/password', { currentPassword: newPassword, newPassword: env.password });
      await api.dispose();
    }
    markStale('guardian3');
  });

  test('현재 비밀번호가 틀리거나 새 비밀번호 확인이 다르면 변경되지 않는다', async ({ openAs }) => {
    const page = await openAs('guardian3', '/guardian/settings');
    await page.getByRole('tab', { name: '보안' }).click();
    await page.getByRole('button', { name: '변경하기' }).click();
    const dialog = page.getByRole('dialog', { name: '비밀번호 변경' });

    await dialog.getByLabel('현재 비밀번호').fill(env.password);
    await dialog.getByLabel('새 비밀번호', { exact: true }).fill(newPassword);
    await dialog.getByLabel('새 비밀번호 확인').fill(`${newPassword}-다름`);
    await dialog.getByRole('button', { name: '변경', exact: true }).click();
    await expect(dialog.getByText('새 비밀번호 확인이 일치하지 않습니다.')).toBeVisible();

    await dialog.getByLabel('현재 비밀번호').fill('Wrong-current-1!');
    await dialog.getByLabel('새 비밀번호 확인').fill(newPassword);
    await dialog.getByRole('button', { name: '변경', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: '비밀번호 변경 실패' })).toBeVisible();
  });

  test('비밀번호를 바꾸면 다시 로그인해야 하고, 새 비밀번호로만 로그인된다', async ({ openAs }) => {
    const page = await openAs('guardian3', '/guardian/settings');
    const oldToken = decodeURIComponent(
      (await page.context().cookies()).find(c => c.name === 'careai_access_token')!.value,
    );
    await page.getByRole('tab', { name: '보안' }).click();
    await page.getByRole('button', { name: '변경하기' }).click();
    const dialog = page.getByRole('dialog', { name: '비밀번호 변경' });
    await dialog.getByLabel('현재 비밀번호').fill(env.password);
    await dialog.getByLabel('새 비밀번호', { exact: true }).fill(newPassword);
    await dialog.getByLabel('새 비밀번호 확인').fill(newPassword);
    await dialog.getByRole('button', { name: '변경', exact: true }).click();

    const done = page.getByRole('alertdialog', { name: '비밀번호 변경 완료' });
    await expect(done).toContainText('새 비밀번호로 다시 로그인해주세요.');
    await done.getByRole('button', { name: '확인' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // 변경 전에 발급된 토큰은 무효
    const stale = await Api.fromLogin({ accessToken: oldToken, refreshToken: '', userId: '', role: '' });
    const err = await stale.get('/api/user/me').catch(e => e as ApiError);
    expect((err as ApiError).status).toBe(401);
    await stale.dispose();

    relaxRateLimits();
    const oldLogin = await Api.signin(G3.email, env.password).catch(e => e as ApiError);
    expect((oldLogin as ApiError).status).toBe(401);

    await page.locator('input[name="email"]').fill(G3.email);
    await page.locator('input[name="password"]').fill(newPassword);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page).toHaveURL(/\/guardian$/);
  });
});

test.describe('회원 탈퇴', () => {
  const W4 = ACCOUNTS.ward4;

  test('탈퇴 확인 단계를 거쳐 탈퇴하면 로그아웃되고 다시 로그인할 수 없다', async ({ openAs }) => {
    const page = await openAs('ward4', '/ward/settings');
    await page.getByRole('tab', { name: '보안' }).click();
    await page.getByRole('button', { name: '회원 탈퇴' }).click();

    const confirm = page.getByRole('alertdialog').filter({ hasText: '정말 탈퇴할까요?' });
    await expect(confirm).toContainText('복구할 수 없습니다.');
    await confirm.getByRole('button', { name: '계속하기' }).click();

    const input = page.getByRole('dialog').filter({ hasText: '탈퇴 확인' });
    await input.getByPlaceholder('비밀번호').fill('Wrong-password-1!');
    await input.getByRole('button', { name: '탈퇴하기' }).click();
    await expect(input).toBeVisible();
    await expect(page).toHaveURL(/\/ward\/settings/);

    await input.getByPlaceholder('비밀번호').fill(env.password);
    await input.getByRole('button', { name: '탈퇴하기' }).click();
    markStale('ward4');
    await expect(page).toHaveURL(/\/login$/);

    relaxRateLimits();
    const login = await Api.signin(W4.email, env.password).catch(e => e as ApiError);
    expect(login).toBeInstanceOf(ApiError);
  });

  test('[계약] 카카오 가입자 탈퇴 시 FE 가 BE 가 요구하는 확인 문구를 보낸다', async ({ openAs }) => {
    // 실제 카카오 계정으로는 로그인할 수 없으므로, 내 정보 응답의 provider 만 KAKAO 로 바꿔 화면을 카카오 모드로 만들고
    // 탈퇴 요청은 서버로 보내지 않고 가로채서 본문만 확인한다.
    test.info().annotations.push({
      type: 'issue',
      description: 'FE 는 "회원탈퇴" 입력을 강제하고 그대로 보내지만 BE 는 confirmation="탈퇴" 만 허용 (UserService.KAKAO_WITHDRAW_CONFIRMATION) → 카카오 가입자는 탈퇴 불가',
    });
    const page = await openAs('guardian2', null);
    let deleteBody: Record<string, unknown> | null = null;
    await page.route('**/api/user/me', async route => {
      const request = route.request();
      if (request.method() === 'DELETE') {
        deleteBody = request.postDataJSON();
        await route.fulfill({ status: 400, json: { success: false, message: '[E2E] 요청을 가로챘습니다.' } });
        return;
      }
      const response = await route.fetch();
      const body = await response.json();
      body.data.provider = 'KAKAO';
      await route.fulfill({ response, json: body });
    });

    await page.goto('/guardian/settings');
    await page.getByRole('tab', { name: '보안' }).click();
    await page.getByRole('button', { name: '회원 탈퇴' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: '계속하기' }).click();
    const input = page.getByRole('dialog').filter({ hasText: '탈퇴 확인' });
    await expect(input).toContainText('회원탈퇴를 입력해주세요.');
    await input.getByPlaceholder('회원탈퇴').fill('회원탈퇴');
    await input.getByRole('button', { name: '탈퇴하기' }).click();

    await expect.poll(() => deleteBody).not.toBeNull();
    expect(deleteBody).toEqual({ confirmation: '탈퇴' });
  });
});
