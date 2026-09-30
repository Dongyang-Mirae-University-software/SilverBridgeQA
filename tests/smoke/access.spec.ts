/**
 * 스모크: 로그인 여부·역할에 따른 접근 제어.
 */
import { expect, test } from '../../src/fixtures';

test.describe('접근 제어 @smoke', () => {
  test('로그인하지 않으면 / 에서 로그인 화면으로 간다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: '로그인' })).toBeVisible();
  });

  test('로그인하지 않고 보호자 화면에 들어가면 로그인 화면으로 간다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/guardian/medication');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('로그인하지 않고 피보호자 화면에 들어가면 로그인 화면으로 간다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/ward/sos');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('보호자로 로그인하면 / 에서 보호자 홈으로 간다', async ({ openAs }) => {
    const page = await openAs('guardian1', '/');
    await expect(page).toHaveURL(/\/guardian$/);
  });

  test('피보호자로 로그인하면 / 에서 피보호자 홈으로 간다', async ({ openAs }) => {
    const page = await openAs('ward1', '/');
    await expect(page).toHaveURL(/\/ward$/);
  });

  test('피보호자가 보호자 화면 주소로 들어가면 피보호자 홈으로 돌려보낸다', async ({ openAs }) => {
    const page = await openAs('ward1', '/guardian/medication');
    await expect(page).toHaveURL(/\/ward$/);
    await expect(page.getByRole('heading', { name: '복약 관리' })).toHaveCount(0);
  });

  test('보호자가 피보호자 화면 주소로 들어가면 보호자 홈으로 돌려보낸다', async ({ openAs }) => {
    const page = await openAs('guardian1', '/ward/sos');
    await expect(page).toHaveURL(/\/guardian$/);
  });

  test('토큰이 위조되면 로그인 화면으로 보낸다', async ({ openAs }) => {
    const page = await openAs('guardian1', '/login');
    await page.context().addCookies([
      { name: 'careai_access_token', value: 'forged.token.value', url: page.url() },
      { name: 'careai_refresh_token', value: 'forged', url: page.url() },
    ]);
    await page.goto('/guardian/medication');
    await expect(page).toHaveURL(/\/login$/);
  });
});
