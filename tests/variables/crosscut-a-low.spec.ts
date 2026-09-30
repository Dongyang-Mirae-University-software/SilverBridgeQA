/**
 * 변수 QA - 횡단 관심사 (낮은 심각도 묶음 A)
 *
 * 부작용 없음/최소: 실제 SMS·메일·푸시 발송은 하지 않는다.
 * - XCUT-G08: WS 핸드셰이크 거부는 page.routeWebSocket 으로 흉내 낸다 (BE 에 거부 로그를 쌓지 않는다)
 * - XCUT-G09/G10/G20: 임시 사용자 토큰으로 조회·거부 응답만 본다 (G10 은 Redis 무효화 키를 잠깐 넣었다 지운다)
 * - XCUT-G15/G17/G19: 브라우저 안 이벤트·모킹·로컬 서비스워커만 쓴다
 * - XCUT-G11: 공유 서버 부하가 필요해 기록만 한다 (fixme)
 */
import { Page, request } from '@playwright/test';

import { Api } from '../../src/api';
import { contextDefaults } from '../../src/browser';
import { env } from '../../src/env';
import { expect, test, toast, waitForRealtime } from '../../src/fixtures';
import { redis } from '../../src/remote';

/** JWT 의 payload 를 읽는다 (서명 검증 없음, 테스트 계산용) */
function jwtPayload(token: string): { iat: number; exp: number } {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** careai:push 로컬 이벤트로 포그라운드 푸시를 흉내 낸다 (서버 발송 없음) */
async function dispatchPush(page: Page, data: Record<string, string>, notification?: { title: string; body: string }) {
  await page.evaluate(
    detail => window.dispatchEvent(new CustomEvent('careai:push', { detail })),
    { data, notification },
  );
}

test.describe('실시간 연결(WebSocket) 재연결', () => {
  test('[XCUT-G08] 재연결할 때 토큰이 거부되면 갱신하거나 백오프하고, 같은 토큰으로 5초마다 무한 재시도하지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const page = await openAs(who, null);

    // 서버가 만료 토큰을 거부하는 상황을 흉내: 처음 쓴 토큰으로 오는 핸드셰이크는 닫아 버린다
    const attempts: { token: string; rejected: boolean }[] = [];
    let rejecting = false;
    let originalToken = '';
    await page.routeWebSocket(/\/ws\?token=/, ws => {
      const token = new URL(ws.url()).searchParams.get('token') ?? '';
      if (!originalToken) originalToken = token;
      const rejected = rejecting && token === originalToken;
      attempts.push({ token, rejected });
      if (rejected) {
        void ws.close();
        return;
      }
      ws.connectToServer();
    });
    const refreshCalls: string[] = [];
    page.on('request', r => {
      if (r.url().includes('/api/auth/refresh')) refreshCalls.push(r.url());
    });

    await page.goto('/guardian');
    await waitForRealtime(page);

    // 연결이 끊긴 시점에는 토큰이 이미 만료됐다고 보고, 이후 HTTP 호출은 없는 상태로 둔다
    rejecting = true;
    await page.evaluate(() => {
      const client = (window as unknown as { __connectionStompClient: { webSocket?: WebSocket } }).__connectionStompClient;
      client.webSocket?.close();
    });

    await page.waitForTimeout(17_000);

    const rejectedAttempts = attempts.filter(a => a.rejected).length;
    test.info().annotations.push({
      type: '재연결 시도',
      description: `거부된 시도 ${rejectedAttempts}회, 전체 ${attempts.length}회, 토큰 갱신 호출 ${refreshCalls.length}회 (17초)`,
    });
    expect(
      refreshCalls.length > 0 || rejectedAttempts <= 1,
      `재연결이 거부되는데도 토큰 갱신(/api/auth/refresh) 없이 같은 토큰으로 ${rejectedAttempts}회 반복 재시도했다 (5초 간격, 백오프·중단 없음)`,
    ).toBe(true);
  });
});

test.describe('인가·인증 응답 코드', () => {
  test('[XCUT-G09] 비ADMIN 이 /api/admin/** 를 호출하면 401 이 아니라 403 (접근 권한 없음) 이다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api } = await loginAs(guardian);

    const results: Record<string, { status: number; body: string }> = {};
    for (const path of ['/api/admin/user', '/api/admin/dashboard/safety', '/api/admin/notification', '/api/ward/medication/today']) {
      const res = await api.raw('GET', path);
      results[path] = { status: res.status(), body: (await res.text()).slice(0, 120) };
    }
    test.info().annotations.push({ type: '응답', description: JSON.stringify(results) });

    // 대조군: 메서드 시큐리티(@PreAuthorize) 경로는 GlobalExceptionHandler 가 403 으로 준다
    expect(results['/api/ward/medication/today'].status, '준비: @PreAuthorize 경로는 403 이어야 한다').toBe(403);

    for (const path of ['/api/admin/user', '/api/admin/dashboard/safety', '/api/admin/notification']) {
      expect.soft(
        results[path].status,
        `${path}: URL 규칙(hasRole ADMIN) 거부가 403 이 아니라 ${results[path].status} "${results[path].body}" 로 응답했다 (AccessDeniedHandler 미설정 + ERROR 디스패치 익명 처리)`,
      ).toBe(403);
    }
  });

  test('[XCUT-G10] 토큰 무효화 직후 같은 초에 새로 로그인해 받은 토큰은 정상적으로 쓸 수 있다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const key = `password:invalidate:${user.id}`;
    let mainStatus = 0;
    let usedIat = 0;
    let usedX = 0;
    const trace: string[] = [];

    try {
      let latency = 1500;
      let offset = 80;
      for (let attempt = 1; attempt <= 8 && !mainStatus; attempt++) {
        // 무효화 시각 = X초 정각(ms). X초 안에(정각 이후) 발급된 토큰은 무효화보다 나중에 만든 새 토큰이다
        const x = Math.floor((Date.now() + latency) / 1000) + 2;
        const t0 = Date.now();
        redis('SET', key, String(x * 1000));
        latency = Math.max(latency, Date.now() - t0) + 500;

        // 이 PC 와 서버의 시계 차이(수백 ms~1초)를 로그인 결과의 iat 로 보정하며 찾아간다
        const wait = x * 1000 + offset - Date.now();
        if (wait < 0) {
          trace.push(`#${attempt} SET 지연 ${latency}ms 로 X초를 놓침`);
          continue; // SSH 가 느려서 X초를 놓침, 다시
        }
        await new Promise(resolve => setTimeout(resolve, wait));

        const startedAt = Date.now();
        const login = await Api.signinWithRetry(user.email, user.password);
        const iat = jwtPayload(login.accessToken).iat;
        trace.push(`#${attempt} X=${x} iat=${iat} 오프셋 ${offset}ms 로그인 ${Date.now() - startedAt}ms`);
        if (iat !== x) {
          offset += iat < x ? 400 : -400;
          continue;
        }

        const api = await Api.fromLogin(login);
        try {
          mainStatus = (await api.raw('GET', '/api/user/me')).status();
          usedIat = iat;
          usedX = x;
        } finally {
          await api.dispose();
        }
      }
      test.info().annotations.push({ type: '시도 기록', description: trace.join(' | ') });
      expect(mainStatus, `준비: 무효화 시각과 같은 초에 발급된 토큰을 얻지 못했다 (${trace.join(' | ')})`).not.toBe(0);

      // 대조: 무효화 다음 초 이후에 발급한 토큰은 통과해야 한다
      // (같은 초에 다시 로그인하면 중복 값 409 가 나므로 서버 시계 기준 다음 초까지 확실히 기다린다)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, (usedX + 2) * 1000 + offset - Date.now())));
      const later = await Api.fromLogin(await Api.signinWithRetry(user.email, user.password));
      const laterStatus = (await later.raw('GET', '/api/user/me')).status();
      await later.dispose();
      expect(laterStatus, '준비: 다음 초에 발급한 토큰은 200 이어야 한다').toBe(200);

      test.info().annotations.push({ type: '같은 초 토큰', description: `iat=${usedIat} 무효화=${usedX * 1000}ms -> ${mainStatus}` });
      expect(
        mainStatus,
        `무효화(${usedX}초 정각) 이후 같은 초에 발급된 새 토큰(iat=${usedIat})이 ${mainStatus} 로 거부됐다 (iat 는 초 절삭, 무효화는 ms, <= 비교)`,
      ).toBe(200);
    } finally {
      redis('DEL', key);
    }
  });
});

test.describe('알림 executor', () => {
  test('[XCUT-G11] SOS·이상감지 알림이 저우선 알림 작업 뒤에서 오래 기다리지 않는다 (전용 executor 또는 채널 타임아웃)', async () => {
    test.fixme(
      true,
      '재현하려면 FCM/Solapi 지연 스텁을 둔 격리 환경에서 알림을 다수 유발해야 한다. 공유 dev 서버에는 부하·지연 주입 금지라 기록만 한다 (AsyncConfig: core 2, max 10, queue 500 -> 큐가 차기 전에는 스레드 2개뿐)',
    );
  });
});

test.describe('포그라운드 알림 토스트', () => {
  test('[XCUT-G15] 안전 알림(SOS, 화재)은 다른 알림에 밀려나거나 6초 뒤 사라지지 않고 확인 전까지 유지된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);

    await test.step('SOS 토스트 뒤에 다른 알림 3건이 쌓여도 SOS 토스트가 남는다', async () => {
      const page = await openAs(who, '/guardian');
      await expect(page.getByRole('complementary', { name: /메뉴$/ })).toBeVisible();

      await dispatchPush(
        page,
        { type: 'WARD_SOS', wardId: 'e2e000', wardName: 'E2E피보호', sosEventId: `e2e-g15-${Date.now()}` },
        { title: '긴급 SOS', body: 'E2E피보호님이 긴급 도움을 요청했습니다.' },
      );
      await expect(toast(page, '긴급 SOS')).toBeVisible();

      for (const id of ['m1', 'm2', 'm3']) {
        await dispatchPush(page, { type: 'MEDICATION_MISSED', wardId: 'e2e000', medicationId: `e2e-${id}`, attempt: '1' });
      }
      await expect(toast(page, '복약 확인 요청')).toHaveCount(3);
      await expect.soft(
        toast(page, '긴급 SOS'),
        '토스트가 3개를 넘자 가장 오래된 SOS 토스트가 조용히 밀려나 사라졌다 (slice(0, 3), 상시 유지 예외 없음)',
      ).toHaveCount(1);
    });

    await test.step('화재(ANOMALY_DETECTED) 토스트는 6초가 지나도 남는다', async () => {
      const page = await openAs(who, '/guardian');
      await expect(page.getByRole('complementary', { name: /메뉴$/ })).toBeVisible();

      await dispatchPush(
        page,
        { type: 'ANOMALY_DETECTED', wardId: 'e2e000', wardName: 'E2E피보호' },
        { title: '화재 감지', body: 'E2E피보호님 집에서 화재가 감지되었습니다.' },
      );
      await expect(toast(page, '화재 감지')).toBeVisible();

      await page.waitForTimeout(7_000);
      await expect.soft(toast(page, '화재 감지'), '화재 알림 토스트가 6초 뒤 자동으로 사라졌다 (ANOMALY_DETECTED 는 상시 유지 대상이 아님)').toHaveCount(1);
    });
  });
});

test.describe('프록시·타임아웃', () => {
  test('[XCUT-G17] 인증 메일 발송 응답이 10초를 넘겨 늦게 와도 화면이 "알 수 없는 오류"로 끝나지 않는다', async ({ openAs, tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const page = await openAs('anonymous', null);

    // 메일 발송은 가짜: BE 가 SMTP 지연으로 12초 뒤 성공 응답하는 상황을 모킹한다 (실제 발송 없음)
    await page.route('**/api/auth/find-password/email/send', async route => {
      await new Promise(resolve => setTimeout(resolve, 12_000));
      await route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } }).catch(() => {});
    });
    await page.goto('/find-password');
    await page.getByRole('button', { name: /이메일 인증/ }).click();
    await page.locator('input[name="email"]').fill(user.email);
    await page.getByRole('button', { name: '이메일 발송', exact: true }).click();

    const codeInput = page.locator('input[inputmode="numeric"]');
    const errorText = page.locator('[class*="errorMessage"]').first();
    await expect(codeInput.or(errorText).first()).toBeVisible({ timeout: 25_000 });

    const shown = (await errorText.isVisible()) ? ((await errorText.textContent()) ?? '') : '';
    test.info().annotations.push({ type: '12초 지연 후 화면', description: shown || '인증코드 입력 단계' });
    expect(
      await codeInput.isVisible(),
      `서버는 발송을 끝냈는데 FE 10초 타임아웃으로 "${shown}" 가 표시됐다 (사용자가 재시도하면 중복 발송, 시간당 한도 소진)`,
    ).toBe(true);
  });
});

test.describe('서비스워커 푸시', () => {
  test('[XCUT-G19] 백그라운드 FCM(notification+data) 수신 시 알림이 1개만 뜨고 화재·복약 클릭 경로가 정의돼 있다', async ({ browser }) => {
    const context = await browser.newContext({ ...contextDefaults, serviceWorkers: 'allow', permissions: ['notifications'] });
    try {
      const first = await context.newPage();
      await first.goto('/login');
      const registered = await first
        .evaluate(async () => {
          const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
          await navigator.serviceWorker.ready;
          return registration.scope;
        })
        .catch((error: Error) => `실패: ${error.message}`);
      test.skip(registered.startsWith('실패'), `서비스워커 등록 실패(환경): ${registered}`);

      // 워커가 살아 있을 때 showNotification 호출을 세는 계측을 심는다 (헤드리스에서는 getNotifications 가 비어 있을 수 있다)
      await expect
        .poll(() => context.serviceWorkers().some(w => w.url().includes('firebase-messaging-sw.js')), { timeout: 15_000 })
        .toBe(true);
      const worker = context.serviceWorkers().find(w => w.url().includes('firebase-messaging-sw.js'))!;
      await worker.evaluate(() => {
        const scope = self as unknown as {
          __shown: { title: string; type?: string }[];
          registration: { showNotification: (title: string, options?: { data?: { type?: string } }) => Promise<void> };
        };
        scope.__shown = [];
        const original = scope.registration.showNotification.bind(scope.registration);
        scope.registration.showNotification = (title, options) => {
          scope.__shown.push({ title, type: options?.data?.type });
          return original(title, options);
        };
      });

      // 화면이 보이는 클라이언트가 없어야 SDK 가 백그라운드 경로로 처리한다
      const blank = await context.newPage();
      await first.close();
      await blank.goto('about:blank');

      const cdp = await context.newCDPSession(blank);
      let registrationId = '';
      cdp.on('ServiceWorker.workerRegistrationUpdated', event => {
        const reg = event.registrations.find(r => r.scopeURL.startsWith(env.baseUrl));
        if (reg) registrationId = reg.registrationId;
      });
      await cdp.send('ServiceWorker.enable');
      await expect.poll(() => registrationId, { timeout: 10_000, message: '서비스워커 등록 ID 를 받지 못했다' }).not.toBe('');

      await cdp.send('ServiceWorker.deliverPushMessage', {
        origin: new URL(env.baseUrl).origin,
        registrationId,
        data: JSON.stringify({
          from: 'e2e',
          fcmMessageId: `e2e-${Date.now()}`,
          notification: { title: '긴급 SOS', body: 'E2E피보호님이 긴급 도움을 요청했습니다.' },
          data: { type: 'WARD_SOS', wardId: 'e2e000', wardName: 'E2E피보호', sosEventId: `e2e-g19-${Date.now()}` },
        }),
      });

      // 알림이 표시될 시간을 주고, 마지막에 표시 호출 횟수를 센다
      await blank.waitForTimeout(5_000);
      const liveWorker = context.serviceWorkers().find(w => w.url().includes('firebase-messaging-sw.js'));
      const shown = liveWorker
        ? await liveWorker.evaluate(() => (self as unknown as { __shown?: { title: string; type?: string }[] }).__shown ?? [])
        : [];
      expect(liveWorker, '서비스워커가 종료돼 계측값을 읽지 못했다').toBeTruthy();
      test.info().annotations.push({ type: '표시된 알림', description: JSON.stringify(shown) });
      expect(shown.length, '준비: 푸시가 서비스워커에서 알림 표시까지 처리되지 않았다').toBeGreaterThan(0);
      expect.soft(shown.length, `같은 푸시에 알림 표시가 ${shown.length}번 호출됐다 (SDK 자동 표시 + onBackgroundMessage 의 showNotification 중복)`).toBe(1);

      // 클릭 경로: 이상감지·복약 푸시를 홈('/')이 아닌 전용 화면으로 보내야 한다
      const source = await (await request.newContext()).get(`${env.baseUrl}/firebase-messaging-sw.js`).then(r => r.text());
      for (const type of ['ANOMALY_DETECTED', 'MEDICATION_MISSED']) {
        expect.soft(source.includes(type), `서비스워커 클릭 경로 매핑에 ${type} 가 없어 클릭하면 항상 홈으로 간다`).toBe(true);
      }
    } finally {
      await context.close();
    }
  });
});

test.describe('예외 처리 응답 코드', () => {
  test('[XCUT-G20] 프로필 이미지 API 에 file 파트 없이 multipart 로 보내면 500 이 아니라 400 이다', async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { login } = await loginAs(user);
    const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${login.accessToken}` } });
    try {
      // multipart 이지만 파트 이름이 file 이 아니다 (파일은 저장되지 않는다: 파트 누락으로 컨트롤러 진입 전 예외)
      const res = await ctx.patch('/api/user/me/image', {
        multipart: { image: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('e2e') } },
      });
      const body = (await res.text()).slice(0, 200);
      test.info().annotations.push({ type: '응답', description: `${res.status()} ${body}` });
      expect(res.status(), `file 파트가 없는 요청이 클라이언트 오류(400)가 아니라 ${res.status()} 로 응답했다: ${body}`).toBe(400);

      // 참고: Accept: application/xml 응답(문서화되지 않은 동작)은 기록만 한다
      const xml = await ctx.get('/api/user/me', { headers: { Accept: 'application/xml' } });
      test.info().annotations.push({ type: 'Accept xml', description: `${xml.status()} ${(await xml.text()).slice(0, 80)}` });
    } finally {
      await ctx.dispose();
    }
  });
});
