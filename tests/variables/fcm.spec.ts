/**
 * 변수 QA - 이 기기의 푸시(FCM) 토큰 수명
 *
 * 헤드리스 브라우저는 실제 FCM 토큰을 받을 수 없으므로, FE 가 "이 기기 토큰은 등록됨"으로 기억하는
 * sessionStorage 값을 가짜 토큰으로 심어 재현한다. 가짜 토큰으로는 실제 푸시가 나가지 않는다.
 */
import { expect, test } from '../../src/fixtures';
import { fcmTokenCount, presetFcmRegistered } from '../../src/variables';

const FCM_TOKEN_API = '**/api/notifications/fcm-token';

function fakeToken(userId: string) {
  return `e2e-fake-fcm-${userId}-${Date.now().toString(36)}`;
}

test.describe('FCM 토큰 등록', () => {
  test('[USER-G01] 서버에서 이 기기 토큰이 정리돼도 다시 접속하면 등록을 다시 보낸다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const token = fakeToken(guardian.id);
    // 60일 미사용 정리·무효 토큰 정리로 서버에는 이 기기 토큰이 없는 상태
    expect(fcmTokenCount({ userId: guardian.id })).toBe(0);

    const page = await openAs(who, null);
    await presetFcmRegistered(page, token, guardian.id);
    const registrations: string[] = [];
    // 가짜 토큰이 DB 에 쌓이지 않게 등록 요청은 브라우저에서 가로채 성공으로 돌려준다
    await page.route(FCM_TOKEN_API, route =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":null}' })
        : route.continue(),
    );
    page.on('request', r => {
      if (r.method() === 'POST' && r.url().endsWith('/api/notifications/fcm-token')) registrations.push(r.postData() ?? '');
    });

    await page.goto('/guardian');
    await expect(page.getByRole('complementary', { name: /메뉴$/ })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('complementary', { name: /메뉴$/ })).toBeVisible();

    await expect
      .poll(() => registrations.length, {
        message: 'sessionStorage 에 "등록됨" 기록만 있으면 서버 등록(touch)을 건너뛰어, 지워진 토큰이 영영 복구되지 않는다',
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
  });

  test('[XAREA-G01] 세션 만료로 자동 로그아웃돼도 이 기기의 FCM 토큰이 정리된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api, who } = await loginAs(guardian);
    const token = fakeToken(guardian.id);
    await api.post('/api/notifications/fcm-token', { token, platform: 'WEB' });
    expect(fcmTokenCount({ token })).toBe(1);

    const page = await openAs(who, null);
    await presetFcmRegistered(page, token, guardian.id);
    await page.goto('/guardian');
    await expect(page.getByRole('complementary', { name: /메뉴$/ })).toBeVisible();

    await test.step('다른 곳에서 세션이 끝난 뒤 화면을 다시 불러오면 자동으로 로그인 화면으로 간다', async () => {
      // access 블랙리스트 + refresh 폐기 → 이 브라우저의 재발급 실패 → clearSession
      await api.post('/api/auth/logout');
      await page.reload();
      await expect(page).toHaveURL(/\/login$/, { timeout: 15_000 });
    });

    await expect
      .poll(() => fcmTokenCount({ token }), {
        message: '자동 로그아웃 뒤에도 서버에 이 기기 토큰이 남아, 로그인 화면 상태의 브라우저가 이전 사용자의 SOS·화재 푸시를 받는다',
        timeout: 5_000,
      })
      .toBe(0);
  });
});
