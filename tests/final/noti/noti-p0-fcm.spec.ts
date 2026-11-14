/**
 * 최종 QA - 알림(NOTI) P0 - FCM 토큰 등록·삭제·해제
 *
 * 임시 사용자만 쓴다. 가짜 토큰이라 실제 푸시는 나가지 않는다.
 * 서명이 맞는 진짜 만료 access token 은 서명키 없이는 만들 수 없다. 대신 임시 사용자로 로그인해 받은 토큰이
 * 만료될 때까지(수명 30분) 기다리는 느린 테스트(@slow, NOTI_RUN_SLOW=1 일 때만)로 A07·A10 의 핵심을 확인한다.
 * 빠른 테스트(A07·A08·A10)의 "만료 토큰"은 서명이 틀린 가짜 토큰이라 서명 검사에서 먼저 막힌다는 뜻이며,
 * 만료 자체를 본 것이 아니다(결과 주석에 남긴다). refresh 수명(일 단위) 초과 진짜 토큰은 확인하지 못한다.
 * release 는 IP 공용 제한(1분 10회)을 쓰므로 A07·A08 과 느린 테스트는 직렬로 돌리고 다른 영역과 동시에 돌리지 않는다.
 */
import { expect, nav, test } from '../../../src/fixtures';
import { fcmTokenCount, logoutViaProfile, presetFcmRegistered } from '../../../src/variables';
import {
  anonymous,
  bodyOf,
  expiredJwt,
  fakeToken,
  fcmTokenOwner,
  jwtExp,
  menuButton,
  NOTI_SLOW_TAGS,
  NOTI_TAGS,
  openMenu,
  releaseToken,
  tamperSignature,
  withBearer,
} from './_helpers-noti';

const FCM_TOKEN_API = '/api/notifications/fcm-token';

test.describe('FCM 토큰', () => {
  test('NOTI-N01 FCM 토큰 등록', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const token = fakeToken(user.id, 'n01');

    const res = await api.raw('POST', FCM_TOKEN_API, { token, platform: 'WEB' });
    expect(res.status()).toBe(200);
    const body = await bodyOf(res);
    expect(body.success).toBe(true);
    expect(body.message).toBe('FCM 토큰이 등록되었습니다.');
    expect(fcmTokenCount({ userId: user.id, token }), 'DB 에 1건 저장').toBe(1);

    await test.step('같은 토큰을 다시 등록해도 200, 중복 저장 없음', async () => {
      const again = await api.raw('POST', FCM_TOKEN_API, { token, platform: 'WEB' });
      expect(again.status()).toBe(200);
      expect(fcmTokenCount({ token })).toBe(1);
    });

    await test.step('참고: 설명서는 platform 을 소문자(web)로 적었지만 코드는 ANDROID|IOS|WEB 만 받는다', async () => {
      const lower = await api.raw('POST', FCM_TOKEN_API, { token: fakeToken(user.id, 'low'), platform: 'web' });
      test.info().annotations.push({ type: 'platform=web(소문자) 응답', description: String(lower.status()) });
      expect(fcmTokenCount({ userId: user.id }), '소문자는 저장되지 않고 위 1건만 남는다').toBe(1);
    });
  });

  test('NOTI-N05 앱을 계속 켜 둬도 하루 1회 토큰 재등록', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    const token = fakeToken(user.id, 'n05');
    const page = await openAs(who, null);
    await presetFcmRegistered(page, token, user.id);
    const registrations: string[] = [];
    // 가짜 토큰이 DB 에 쌓이지 않게 등록 요청은 브라우저에서 가로채 성공으로 돌려준다
    await page.route(`**${FCM_TOKEN_API}`, route =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true,"data":null}' })
        : route.continue(),
    );
    page.on('request', r => {
      if (r.method() === 'POST' && r.url().endsWith(FCM_TOKEN_API)) registrations.push(r.postData() ?? '');
    });

    await page.goto('/guardian');
    await expect(menuButton(page)).toBeVisible();
    const before = registrations.length;

    await test.step('화면을 켜 둔 채 하루(25시간)가 지난 것처럼 시각을 옮기고, 화면 안에서 이동·포커스', async () => {
      await page.clock.setFixedTime(new Date(Date.now() + 25 * 3600 * 1000));
      await openMenu(page);
      await nav(page, 'GUARDIAN').getByRole('link').nth(1).click();
      await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
      });
    });

    // 고정 대기 대신 최대 10초까지 등록 호출이 늘어나는지 본다
    await expect
      .poll(
        () => registrations.length - before,
        { timeout: 10_000, intervals: [500, 1_000], message: '하루가 지난 뒤에도 등록 API(POST /api/notifications/fcm-token)가 다시 호출되지 않았다 - FE 가 세션 저장값(sessionStorage)만 보고 재등록을 건너뛴다' },
      )
      .toBeGreaterThan(0);
  });

  test('NOTI-N06 로그아웃 시 이 기기 토큰 삭제', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api, who } = await loginAs(user);

    await test.step('API: DELETE ?token=... -> 200, 행 삭제', async () => {
      const token = fakeToken(user.id, 'n06a');
      await api.post(FCM_TOKEN_API, { token, platform: 'WEB' });
      expect(fcmTokenCount({ token })).toBe(1);
      const res = await api.raw('DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(token)}`);
      expect(res.status()).toBe(200);
      const body = await bodyOf(res);
      expect(body.success).toBe(true);
      expect(body.message).toBe('FCM 토큰이 삭제되었습니다.');
      expect(fcmTokenCount({ token }), '이후 이 기기로 푸시가 가지 않는다(행 없음)').toBe(0);
      const again = await api.raw('DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(token)}`);
      expect(again.status(), '없는 토큰도 200(멱등)').toBe(200);
    });

    await test.step('화면: 로그아웃하면 FE 가 이 기기 토큰을 지운다', async () => {
      const token = fakeToken(user.id, 'n06b');
      await api.post(FCM_TOKEN_API, { token, platform: 'WEB' });
      const page = await openAs(who, null);
      await presetFcmRegistered(page, token, user.id);
      await page.goto('/guardian');
      await expect(menuButton(page)).toBeVisible();
      await openMenu(page);
      await logoutViaProfile(page, user.name);
      await expect
        .poll(() => fcmTokenCount({ token }), { timeout: 10_000, message: '로그아웃 뒤에도 서버에 이 기기 토큰이 남아 있다' })
        .toBe(0);
    });
  });

  test('NOTI-A06 남의 토큰 삭제 시도(IDOR)', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    const a = await tempUser('GUARDIAN');
    const b = await tempUser('GUARDIAN');
    const [ga, gb] = [await loginAs(a), await loginAs(b)];
    const tokenB = fakeToken(b.id, 'a06');
    await gb.api.post(FCM_TOKEN_API, { token: tokenB, platform: 'WEB' });
    expect(fcmTokenOwner(tokenB), '준비: B 소유 토큰').toEqual([b.id]);

    const res = await ga.api.raw('DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(tokenB)}`);
    test.info().annotations.push({ type: 'A 가 B 토큰 삭제 응답', description: String(res.status()) });
    // 문서: 없는 토큰과 같게 처리(멱등 200). 403 이 오면 문서와 다르다
    expect(res.status()).toBe(200);
    expect(fcmTokenOwner(tokenB), 'B 의 토큰 행은 그대로(삭제 안 됨, 주인도 그대로)').toEqual([b.id]);
  });

});

// release 는 IP 기준 공용 제한(fcm-release 1분 10회)을 쓴다. 이 묶음 안에서는 직렬로 돌린다
test.describe('FCM 토큰 release (IP 공용 제한 - 직렬)', () => {
  test.describe.configure({ mode: 'serial' });

  test('NOTI-A07 release 로 남의 토큰 삭제 시도', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    // 만료 전 진짜 A 토큰으로 본인 확인 규칙(본인 소유만 삭제)을 확인한다. 진짜 만료 토큰은 아래 @slow 테스트에서 본다
    test.info().annotations.push({ type: '대체 확인', description: '케이스는 만료 토큰이지만 이 테스트는 만료 전 진짜 토큰으로 확인함. 진짜 만료 토큰은 @slow 테스트' });
    const a = await tempUser('GUARDIAN');
    const b = await tempUser('GUARDIAN');
    const [ga, gb] = [await loginAs(a), await loginAs(b)];
    const tokenA = fakeToken(a.id, 'a07a');
    const tokenB = fakeToken(b.id, 'a07b');
    await ga.api.post(FCM_TOKEN_API, { token: tokenA, platform: 'WEB' });
    await gb.api.post(FCM_TOKEN_API, { token: tokenB, platform: 'WEB' });

    const other = await releaseToken(ga.login.accessToken, tokenB);
    expect(other.status, '남의 토큰이어도 조용히 200').toBe(200);
    expect(fcmTokenOwner(tokenB), 'B 토큰은 삭제되지 않음').toEqual([b.id]);

    const own = await releaseToken(ga.login.accessToken, tokenA);
    expect(own.status).toBe(200);
    expect(fcmTokenCount({ token: tokenA }), '대조: 본인 토큰은 지워진다').toBe(0);
  });

  test('NOTI-A08 release 에 서명 틀린·typ 다른·수명 지난 토큰', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    const a = await tempUser('GUARDIAN');
    const { api, login } = await loginAs(a);
    const token = fakeToken(a.id, 'a08');
    await api.post(FCM_TOKEN_API, { token, platform: 'WEB' });

    const attempts: Record<string, string> = {
      '위조 서명': tamperSignature(login.accessToken),
      'refresh 타입 토큰': login.refreshToken,
      '만료 1시간(서명 틀림)': expiredJwt(a.id, 'GUARDIAN', 3600),
    };
    for (const [label, accessToken] of Object.entries(attempts)) {
      const res = await releaseToken(accessToken, token);
      expect.soft(res.status, `${label}: 401 이어야 한다 (${JSON.stringify(res.body).slice(0, 120)})`).toBe(401);
      expect.soft(fcmTokenCount({ token }), `${label}: 삭제되면 안 된다`).toBe(1);
    }
    test.info().annotations.push({
      type: '확인 못 함',
      description: '수명(refresh 기간)이 지난 서명 맞는 진짜 토큰은 확인하지 못함(서명키 없이 만들 수 없고 수일을 기다려야 함). 위 "만료 1시간"은 서명 틀린 토큰이라 서명 검사로 막히는 것만 본 것',
    });
  });
});

test.describe('FCM 만료 토큰', () => {
  test('NOTI-A10 만료 토큰 허용이 다른 API로 번지지 않음 (서명 틀린 토큰으로 대신 확인)', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    test.info().annotations.push({
      type: '대체 확인',
      description: '"만료 토큰"을 서명이 틀린 가짜 토큰으로 대신 확인함(서명 검사에서 먼저 401). release 만 만료 토큰을 허용하는 쪽은 @slow 테스트에서 진짜 만료 토큰으로 확인',
    });
    const a = await tempUser('GUARDIAN');
    const { api } = await loginAs(a);
    const token = fakeToken(a.id, 'a10');
    await api.post(FCM_TOKEN_API, { token, platform: 'WEB' });

    const expired = await withBearer(expiredJwt(a.id, 'GUARDIAN', 3600));
    try {
      const calls: Array<[string, string, unknown?]> = [
        ['POST', FCM_TOKEN_API, { token: fakeToken(a.id, 'a10x'), platform: 'WEB' }],
        ['DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(token)}`],
        ['GET', '/api/user/me'],
        ['GET', '/api/user/me/notification-settings'],
        ['GET', '/api/user/me/notifications'],
      ];
      for (const [method, path, data] of calls) {
        const res = await expired.fetch(path, { method, data });
        expect.soft(res.status(), `만료 access token 으로 ${method} ${path.split('?')[0]} 는 401`).toBe(401);
      }
    } finally {
      await expired.dispose();
    }
    expect(fcmTokenCount({ userId: a.id }), '만료 토큰으로 등록·삭제가 먹지 않아 처음 1건 그대로').toBe(1);

    // 대조: 인증 헤더가 아예 없어도 같은 401
    const none = await anonymous();
    try {
      expect((await none.post(FCM_TOKEN_API, { data: { token: fakeToken(a.id, 'none'), platform: 'WEB' } })).status()).toBe(401);
    } finally {
      await none.dispose();
    }
  });

  // 로그인해 받은 진짜 access token 이 만료될 때까지(수명 30분, exp 값을 읽어 기다린다) 기다린다. 서명키는 필요 없다.
  test('NOTI-A10 @slow 진짜 만료 access token: release 만 허용, 다른 API 는 401 (A07 의 만료 토큰 포함)', NOTI_SLOW_TAGS, async ({ tempUser, loginAs }) => {
    test.skip(process.env.NOTI_RUN_SLOW !== '1', '30분 넘게 걸리는 느린 테스트: NOTI_RUN_SLOW=1 일 때만 실행');
    test.setTimeout(35 * 60_000);
    const a = await tempUser('GUARDIAN');
    const b = await tempUser('GUARDIAN');
    const [ga, gb] = [await loginAs(a), await loginAs(b)];
    const tokenA = fakeToken(a.id, 'slowa');
    const tokenB = fakeToken(b.id, 'slowb');
    await ga.api.post(FCM_TOKEN_API, { token: tokenA, platform: 'WEB' });
    await gb.api.post(FCM_TOKEN_API, { token: tokenB, platform: 'WEB' });
    const accessA = ga.login.accessToken;

    const waitMs = Math.max(0, (jwtExp(accessA) + 10) * 1000 - Date.now());
    test.info().annotations.push({ type: '만료까지 기다린 시간(초)', description: String(Math.round(waitMs / 1000)) });
    await new Promise(resolve => setTimeout(resolve, waitMs));

    const expired = await withBearer(accessA);
    try {
      await test.step('만료된 진짜 access token 으로 다른 API 는 401, 등록·삭제도 안 먹는다 (A10)', async () => {
        const calls: Array<[string, string, unknown?]> = [
          ['POST', FCM_TOKEN_API, { token: fakeToken(a.id, 'slowx'), platform: 'WEB' }],
          ['DELETE', `${FCM_TOKEN_API}?token=${encodeURIComponent(tokenA)}`],
          ['GET', '/api/user/me'],
          ['GET', '/api/user/me/notification-settings'],
          ['GET', '/api/user/me/notifications'],
        ];
        for (const [method, path, data] of calls) {
          const res = await expired.fetch(path, { method, data });
          expect.soft(res.status(), `진짜 만료 access token 으로 ${method} ${path.split('?')[0]} 는 401`).toBe(401);
        }
        expect(fcmTokenCount({ userId: a.id }), '만료 토큰으로 등록·삭제가 먹지 않아 처음 1건 그대로').toBe(1);
      });
    } finally {
      await expired.dispose();
    }

    await test.step('release 는 만료 토큰도 허용하되 본인 토큰만 지운다 (A07·A10)', async () => {
      const other = await releaseToken(accessA, tokenB);
      expect(other.status, '남의 토큰이어도 조용히 200').toBe(200);
      expect(fcmTokenOwner(tokenB), 'B 토큰은 삭제되지 않음').toEqual([b.id]);
      const own = await releaseToken(accessA, tokenA);
      expect(own.status, '만료 토큰이어도 release 는 허용(200)').toBe(200);
      expect(fcmTokenCount({ token: tokenA }), '본인 토큰은 지워진다').toBe(0);
    });
  });
});
