/**
 * 최종 QA - 인증(AUTH) P1b - 실시간 연결(FE) 재연결과 토큰 (A54)
 *
 * 임시 보호자만 쓴다. 로그인은 화면으로 해서 브라우저가 refresh 쿠키(careai_rt)를 갖는다.
 * 일반 끊김의 "토큰이 거부되는 상황"은 page.routeWebSocket 으로 핸드셰이크를 닫아 흉내 내고(BE 에 거부 기록을 쌓지 않는다),
 * 1008 AUTH_INVALIDATED 는 서버가 실제로 닫게 한다(임시 사용자가 자기 비밀번호를 바꿔 모든 세션을 끊는다).
 */
import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { env } from '../../../src/env';
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { callBe, cookieNames } from './_helpers-auth';
import { loginViaFormSafe, relaxP1bRates, TAGS_P1 } from './_helpers-auth-p1b';

test.beforeEach(() => relaxP1bRates());

test('AUTH-A54 실시간 연결 끊김 뒤 재연결 전 토큰 갱신, 1008 AUTH_INVALIDATED 는 재시도 안 함', TAGS_P1, async ({ browser, tempUser }) => {
  test.setTimeout(240_000);
  const user = await tempUser('GUARDIAN');
  // 5xx 자동 감시(openAs)에 걸리지 않게 직접 컨텍스트를 연다 (이 케이스는 일부러 연결을 거부·종료한다)
  const context = await browser.newContext({ ...contextDefaults });
  try {
    await context.addInitScript(installPageStubs(), pageStubArg);
    const page = await context.newPage();

    const attempts: { token: string; at: number; rejected: boolean }[] = [];
    const serverCloses: { code: number; reason: string; at: number }[] = [];
    const refreshCalls: { at: number; status: number }[] = [];
    let rejecting = false;
    let firstToken = '';
    let urlHadToken = false;

    await page.routeWebSocket(/\/ws\?token=/, ws => {
      const token = new URL(ws.url()).searchParams.get('token') ?? '';
      if (!firstToken) firstToken = token;
      if (token) urlHadToken = true;
      const rejected = rejecting && token === firstToken;
      attempts.push({ token, at: Date.now(), rejected });
      if (rejected) {
        void ws.close();
        return;
      }
      const server = ws.connectToServer();
      // 서버가 닫은 코드·사유를 기록하고, 같은 코드·사유로 화면 쪽 연결도 닫아 준다
      // (onClose 를 달면 한쪽이 닫혀도 반대쪽을 자동으로 닫지 않는다)
      server.onClose((code, reason) => {
        serverCloses.push({ code: code ?? 0, reason: reason ?? '', at: Date.now() });
        void ws.close(code && code >= 1000 && code !== 1005 ? { code, reason } : undefined);
      });
    });
    page.on('response', res => {
      if (res.url().includes('/api/auth/refresh') && res.request().method() === 'POST') {
        refreshCalls.push({ at: Date.now(), status: res.status() });
      }
    });

    await page.goto('/login');
    await loginViaFormSafe(page, user.email, user.password);
    await expect(page).toHaveURL(/\/guardian$/);
    await waitForRealtime(page);
    expect(firstToken, '준비: 처음 연결에 쓴 토큰').not.toBe('');

    await test.step('일반 끊김: 같은 토큰으로 계속 두드리지 않고, 갱신한 새 토큰으로 다시 붙는다', async () => {
      const refreshBefore = refreshCalls.length;
      const attemptsBefore = attempts.length;
      // 서버가 만료 토큰을 거부하는 상황: 처음 토큰으로 오는 핸드셰이크는 닫는다. 그리고 연결을 끊는다
      // 끊김 표시는 안내 띠(role=status)로 좁힌다 - 대시보드에 원래 있는 '재연결' 같은 글자에 걸리지 않게, 끊기 전에는 0개인지 먼저 본다
      const dropNotice = page.getByRole('status').filter({ hasText: /실시간.{0,12}끊|연결이 끊/ });
      await expect(dropNotice, '기준선: 끊기 전에는 끊김 표시가 없다').toHaveCount(0);
      rejecting = true;
      const droppedAt = Date.now();
      await page.evaluate(() => {
        const client = (window as unknown as { __connectionStompClient: { webSocket?: WebSocket } }).__connectionStompClient;
        client.webSocket?.close();
      });

      // 끊김 표시: 문구는 문서에 없어 기획 확인이 필요하다. 안내 띠(role=status)에 '실시간 ... 끊' 또는 '연결이 끊' 이 있어야 한다 (FE 코드는 콘솔 경고만 남긴다)
      test.info().annotations.push({ type: '기획 확인 필요', description: '끊김 표시 문구가 문서에 없다. role=status 안내 띠의 문구는 기획과 정한 뒤 이 정규식을 그 문구로 고정한다' });
      await expect
        .soft(dropNotice.first(), '실시간 연결이 끊겼을 때 화면에 끊김 표시가 보이지 않는다')
        .toBeVisible({ timeout: 4_000 });

      // 끊긴 직후에는 연결 상태가 잠깐 남아 있을 수 있으니, 먼저 재연결 시도(거부됨)가 나올 때까지 기다린다
      await expect
        .poll(() => attempts.slice(attemptsBefore).filter(a => a.rejected).length, {
          message: '끊긴 뒤 재연결 시도가 시작됨',
          timeout: 30_000,
          intervals: [500],
        })
        .toBeGreaterThanOrEqual(1);

      await expect
        .poll(
          () => page.evaluate(() => (window as unknown as { __connectionStompClient?: { connected: boolean } }).__connectionStompClient?.connected === true),
          { message: '갱신된 토큰으로 다시 연결됨', timeout: 90_000, intervals: [1_000] },
        )
        .toBe(true);

      const rejectedAttempts = attempts.slice(attemptsBefore).filter(a => a.rejected).length;
      const refreshAfter = refreshCalls.slice(refreshBefore);
      const success = attempts.slice(attemptsBefore).find(a => !a.rejected);
      expect(refreshAfter.length, '재연결 전에 토큰 갱신(/api/auth/refresh)이 있었다').toBeGreaterThanOrEqual(1);
      expect(refreshAfter[0].status, '토큰 갱신 응답').toBe(200);
      expect(success, '거부되지 않은 새 연결 시도').toBeTruthy();
      expect(success!.token, '새 연결은 처음 토큰이 아니라 갱신된 토큰').not.toBe(firstToken);
      expect(success!.at, '갱신이 새 연결보다 먼저').toBeGreaterThan(refreshAfter[0].at - 1);
      expect(rejectedAttempts, `같은 토큰으로 거부된 재시도는 2번 이하 (실제 ${rejectedAttempts}번, ${Math.round((Date.now() - droppedAt) / 1000)}초 동안)`).toBeLessThanOrEqual(2);
      rejecting = false;
    });

    await test.step('1008 AUTH_INVALIDATED: 재시도 없이 로그인 화면으로 간다', async () => {
      const cookies = await context.cookies();
      const access = decodeURIComponent(cookies.find(c => c.name === 'careai_access_token')?.value ?? '');
      expect(access, '준비: 현재 접근 토큰 쿠키').not.toBe('');
      const closesBefore = serverCloses.length;
      const attemptsBefore = attempts.length;

      // 임시 사용자가 자기 비밀번호를 바꾸면 서버가 모든 세션과 실시간 연결을 닫는다(1008 AUTH_INVALIDATED)
      const change = await callBe('PUT', '/api/user/me/password', {
        token: access,
        data: { currentPassword: env.password, newPassword: 'ChangedP1b!9' },
      });
      expect(change.status, `비밀번호 변경 ${change.status} ${change.code}`).toBe(200);

      await expect
        .poll(() => serverCloses.slice(closesBefore).find(c => c.code === 1008), { message: '서버가 1008 로 닫음', timeout: 20_000 })
        .toBeTruthy();
      const closed = serverCloses.slice(closesBefore).find(c => c.code === 1008)!;
      expect(closed.reason, '닫힘 사유').toBe('AUTH_INVALIDATED');

      await expect(page, '재연결 대신 로그인 화면').toHaveURL(/\/login/, { timeout: 30_000 });
      expect(await cookieNames(page), '로그인 세션 표시가 지워진다').not.toContain('careai_session');
      // 로그인 화면으로 간 뒤 한 번의 재연결 주기(5초)보다 길게 두어도 새 연결 시도가 없어야 한다
      // "일이 일어나지 않음" 을 보는 것이라 정해진 시간(재연결 주기 5초보다 긴 7초) 동안 기다린 뒤 센다
      await page.waitForTimeout(7_000);
      expect(attempts.length - attemptsBefore, '1008 이후 새 실시간 연결 시도가 없다').toBe(0);
    });

    test.info().annotations.push({
      type: '보류 항목 XCUT-G25 (결과만 기록)',
      description: `실시간 연결 주소의 쿼리에 로그인 토큰이 ${urlHadToken ? '들어 있다(서버·프록시 로그에 남을 수 있다)' : '없다'}`,
    });
  } finally {
    await context.close();
  }
});
