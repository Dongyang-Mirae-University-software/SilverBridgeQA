/**
 * 변수 QA - FE UX (medium, b)
 *
 * 부작용 차단
 * - 모든 사용자는 임시 사용자이고, SOS 를 보내는 테스트는 보내기 전에 알림 쿨다운 키를 넣어 FCM·SMS 가 나가지 않게 한다.
 * - 화면 송출(G36)은 AI 서버 API 를 전부 page.route 로 가로채 실제 세션을 만들지 않는다.
 * - 공지(G24)는 만들고 바로 지운다.
 */
import { Page } from '@playwright/test';

import { expect, modal, nav, test, waitForRealtime } from '../../src/fixtures';
import { psql, sqlStr } from '../../src/remote';
import { collectSosPosts, connect, presetSosAction, sosEventCount, suppressSosNotify } from '../../src/variables';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 화면 우측 사이드바 (역할 가드를 통과해 레이아웃이 그려졌다는 표시) */
function sidebar(page: Page) {
  return page.getByRole('complementary', { name: /메뉴$/ });
}

// ---------------------------------------------------------------------------------------------
// G17 - 루트('/') 접근
// ---------------------------------------------------------------------------------------------

function b64url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** exp 가 과거인 access JWT (서명은 무효). '/' 서버 컴포넌트는 서명을 검증하지 않고 exp·role 만 읽는다 */
function expiredAccessToken(userId: string, role: string) {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: userId, role, exp: 1 })}.expired-signature`;
}

test.describe('루트 접근', () => {
  test('[FEUX-G17] access 만료 뒤에도 유효한 refresh 쿠키가 있으면 "/" 로 들어와도 로그인 화면이 아니라 역할 홈으로 간다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { login } = await loginAs(guardian);
    const expiredCookies = { ...login, accessToken: expiredAccessToken(guardian.id, 'GUARDIAN') };

    const page = await openAs({ label: '루트진입', login: expiredCookies }, '/');
    test.info().annotations.push({ type: '실측', description: `'/' 진입 후 최종 경로 ${new URL(page.url()).pathname}` });
    await expect
      .soft(page, '유효한 refresh 쿠키가 있는데도 access exp 만 보고 /login 으로 보낸다 (refresh 미사용)')
      .not.toHaveURL(/\/login/, { timeout: 5_000 });
    await expect.soft(sidebar(page), '역할 홈(보호자 레이아웃)이 열려야 한다').toBeVisible({ timeout: 20_000 });

    // 대조군: 같은 쿠키로 보호 경로에 직접 들어가면 클라이언트 인터셉터가 refresh 로 복구한다 (참고 기록)
    const control = await openAs({ label: '대조군', login: expiredCookies }, '/guardian');
    const recovered = await sidebar(control).waitFor({ timeout: 20_000 }).then(() => true, () => false);
    test.info().annotations.push({ type: '대조군', description: `/guardian 직접 진입 복구: ${recovered}, 최종 경로 ${new URL(control.url()).pathname}` });
  });
});
// ---------------------------------------------------------------------------------------------
// G19 - 오프라인 SOS
// ---------------------------------------------------------------------------------------------

test.describe('오프라인 SOS', () => {
  test('[FEUX-G19] 오프라인에서 SOS "보내기"를 누르면 "전송 중..." 에 갇히지 않고 곧바로 실패·오프라인 안내가 나온다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await presetSosAction(page, 'notifyGuardianFirst');
    const posts = collectSosPosts(page);
    await page.goto('/ward/sos');
    await expect(page.getByRole('link', { name: `${guardian.name}에게 전화하기` })).toBeVisible();

    await page.getByRole('button', { name: /긴급 SOS/ }).click();
    const confirm = modal(page, '긴급 SOS 전송');
    await expect(confirm).toBeVisible();

    await page.context().setOffline(true);
    await confirm.getByRole('button', { name: '보내기' }).click();

    try {
      await expect(
        confirm.getByText('보호자에게 SOS를 전송하고 있습니다.'),
        '오프라인인데 mutation 이 paused 로 대기해 모달이 "전송 중..." 으로 고착된다 (취소·닫기도 비활성). 즉시 실패 안내나 전화 걸기가 나와야 한다',
      ).toBeHidden({ timeout: 8_000 });
    } finally {
      const stuckCancelDisabled = await confirm.getByRole('button', { name: '취소' }).isDisabled().catch(() => null);
      const postsWhileOffline = posts.length;
      await page.context().setOffline(false);
      // 복귀 뒤 뒤늦게 나가는 SOS 가 서버에 닿는지 관찰하고, 임시 사용자 삭제 전에 처리가 끝나게 기다린다
      await sleep(6_000);
      test.info().annotations.push({
        type: '실측',
        description: `오프라인 중 SOS 요청 ${postsWhileOffline}건, 복귀 후 누적 ${posts.length}건, 서버 이력 ${sosEventCount(ward.id)}건, 취소 버튼 비활성: ${stuckCancelDisabled}`,
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// G21 - 보호자 복약 화면 오류 표시
// ---------------------------------------------------------------------------------------------

function farDoseTime() {
  return psql(`SELECT to_char((now() AT TIME ZONE 'Asia/Seoul') + interval '6 hours', 'HH24:MI:00');`);
}

function insertMedication(wardId: string, createdBy: string, name: string): number {
  return Number(
    psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time, dose_amount)
          VALUES (${sqlStr(wardId)}, ${sqlStr(createdBy)}, ${sqlStr(name)}, 'MORNING', ${sqlStr(farDoseTime())}, 1) RETURNING id;`),
  );
}

const MED_FEEDBACK = /찾을 수 없|실패|오류|삭제된|삭제되었|연결이 해제|연결되지|다시 시도|불러오지|복약 정보만|올바른 시각/;

test.describe('보호자 복약 화면 오류 표시', () => {
  test('[FEUX-G21] 복약 화면은 삭제·시각 변경·저장 실패의 원인을 표시하고, 빈 시각은 보내지 않으며, 수정 화면에 등록용 힌트를 띄우지 않는다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(150_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const medName = 'E2E점검약';
    insertMedication(ward.id, guardian.id, medName);
    // 오늘 미복약 요약이 이미 나간 것으로 기록해, 발송 시각과 겹쳐도 요약이 나가지 않게 한다
    psql(`INSERT INTO medication_missed_alert_log (guardian_id, ward_id, dose_date, missed_count, total_count, sent_at)
          VALUES (${sqlStr(guardian.id)}, ${sqlStr(ward.id)}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, 1, now());`);
    const { who } = await loginAs(guardian);

    const page = await openAs(who, '/guardian/medication');
    const puts: string[] = [];
    const alertStatuses: number[] = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && request.url().includes('/medication-alert-setting')) puts.push(request.postData() ?? '');
    });
    page.on('response', response => {
      if (response.request().method() === 'PUT' && response.url().includes('/medication-alert-setting')) alertStatuses.push(response.status());
    });

    const card = page.getByRole('listitem').filter({ has: page.getByText(ward.name) }).first();
    await expect(card.getByRole('button', { name: new RegExp(`${medName} 아침`) })).toBeVisible();

    await test.step('(b) 미복약 알림 발송 시각 칸을 비워도 ":00" 이 서버로 나가지 않고, 나가서 실패하면 안내가 뜬다', async () => {
      const time = card.locator('input[type="time"]');
      await expect(time).toBeVisible();
      await time.fill('');
      await sleep(2_000);
      test.info().annotations.push({ type: '실측', description: `빈 시각 입력 뒤 PUT 본문 [${puts.join(' ')}] 응답 [${alertStatuses.join(',')}]` });
      expect.soft(puts.filter(body => body.includes('":00"')), '빈 값이 ":00" 으로 만들어져 PUT 으로 나간다 (빈 값 검사 없음)').toEqual([]);
      if (alertStatuses.some(status => status >= 400)) {
        expect.soft(await card.innerText(), `저장 요청이 ${alertStatuses.join(',')} 로 실패했는데 화면에 아무 안내도 없다`).toMatch(MED_FEEDBACK);
      }
    });

    await test.step('(d) 수정 화면에는 "비워두면 시간대 기본 시각" 힌트가 없다', async () => {
      await card.getByRole('button', { name: new RegExp(`${medName} 아침`) }).click();
      const dialog = page.getByRole('dialog', { name: '약 수정' });
      await expect(dialog).toBeVisible();
      await expect
        .soft(dialog.getByText('비워두면 시간대 기본 시각으로 설정됩니다.'), '수정에서 시각을 비우면 서버는 기존 시각을 유지하는데 힌트는 기본 시각으로 바뀐다고 안내한다 (등록 화면 전용이어야 함)')
        .toHaveCount(0);

      await test.step('(c) 저장이 서버에서 거절되면 서버 메시지가 그대로 보인다 (연결 해제된 피보호자)', async () => {
        psql(`UPDATE connection SET status = 'DISCONNECTED', updated_at = now() WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`);
        const saveResponse = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().includes('/api/guardian/medication/'));
        await dialog.getByRole('button', { name: '수정', exact: true }).click();
        const res = await saveResponse;
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        const serverMessage = body?.message ?? '';
        test.info().annotations.push({ type: '실측', description: `연결 해제 뒤 약 수정 -> ${res.status()} "${serverMessage}"` });
        expect(res.status(), '연결이 끊긴 피보호자의 약 수정은 서버가 거절해야 한다').toBeGreaterThanOrEqual(400);
        if (serverMessage) {
          await expect
            .soft(dialog, '서버가 준 거절 사유 대신 항상 고정 문구 "저장에 실패했습니다. 다시 시도해 주세요." 만 표시된다')
            .toContainText(serverMessage);
        }
        if (await dialog.isVisible()) await dialog.getByRole('button', { name: '닫기' }).click();
      });
    });

    await test.step('(a) 삭제가 서버에서 거절되면 원인이 표시되거나 목록이 갱신된다', async () => {
      page.once('dialog', dialog => void dialog.accept());
      const deleteResponse = page.waitForResponse(r => r.request().method() === 'DELETE' && r.url().includes('/api/guardian/medication/'));
      await card.getByRole('button', { name: `${medName} 삭제` }).click();
      const res = await deleteResponse;
      test.info().annotations.push({ type: '실측', description: `연결 해제 뒤 약 삭제 -> ${res.status()}` });
      expect(res.status(), '연결이 끊긴 피보호자의 약 삭제는 서버가 거절해야 한다').toBeGreaterThanOrEqual(400);
      await expect
        .poll(
          async () => (await card.count()) === 0 || (await card.getByText(medName).count()) === 0 || MED_FEEDBACK.test(await page.locator('body').innerText()),
          { message: '삭제가 거절됐는데 안내도 없고 목록도 그대로다 (삭제 mutation 에 onError·재조회 없음)', timeout: 4_000 },
        )
        .toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// G23 - 실시간 채널 재연결
// ---------------------------------------------------------------------------------------------

test.describe('실시간 채널', () => {
  test('[FEUX-G23] 실시간 연결이 끊겨 재연결이 계속 실패하면 토큰 갱신을 먼저 하거나 끊김 표시를 보여 준다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    // AI 라이브 WS(liveStreamSocket)는 dev 의 AI 서버가 내려가 있고 재연결 코드 자체가 없어 여기서는 STOMP 만 본다
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);

    const page = await openAs(who, null);
    const attempts: { token: string | null; at: number }[] = [];
    let firstConnection: { close: (options?: { code?: number; reason?: string }) => void } | null = null;
    // 첫 연결만 통과시키고, 이후 연결은 만료 토큰으로 핸드셰이크가 거절되는 상황처럼 즉시 닫는다
    await page.routeWebSocket(/\/ws(\?|$)/, ws => {
      attempts.push({ token: new URL(ws.url()).searchParams.get('token'), at: Date.now() });
      if (attempts.length === 1) {
        ws.connectToServer();
        firstConnection = ws;
      } else {
        ws.close({ code: 4401, reason: 'expired token' });
      }
    });
    const refreshCalls: string[] = [];
    page.on('request', request => {
      if (request.url().includes('/auth/refresh')) refreshCalls.push(request.url());
    });

    await page.goto('/guardian');
    await expect(sidebar(page)).toBeVisible();
    await waitForRealtime(page);
    const beforeDrop = refreshCalls.length;

    // 네트워크가 한 번 끊김 (다른 HTTP 호출은 없음)
    firstConnection!.close({ code: 4000, reason: 'network drop' });
    await sleep(14_000);

    const tokens = new Set(attempts.map(a => a.token));
    test.info().annotations.push({
      type: '실측',
      description: `끊김 뒤 재연결 시도 ${attempts.length - 1}회, 사용한 토큰 ${tokens.size}종, refresh 호출 ${refreshCalls.length - beforeDrop}회`,
    });
    expect(attempts.length, '끊긴 뒤 자동 재연결 시도가 있어야 실험이 성립한다').toBeGreaterThan(2);

    const refreshed = refreshCalls.length > beforeDrop;
    const indicator = await page.getByText(/연결 끊김|연결이 끊|실시간.{0,8}(끊|연결 안|오프라인)|재연결/).first().isVisible().catch(() => false);
    expect(
      refreshed || indicator,
      '재연결이 계속 실패하는데 토큰 갱신(refresh)도 하지 않고 끊김 표시도 없다 (같은 토큰으로 5초마다 재시도, 콘솔 경고만)',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// G24 - 공지사항
// ---------------------------------------------------------------------------------------------

test.describe('공지사항 화면', () => {
  test('[FEUX-G24] 공지가 2건 이상이면 보호자·피보호자 공지 화면에서 이전 공지도 볼 수 있다', async ({ tempUser, loginAs, openAs }) => {
    const admin = await tempUser('ADMIN');
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const [a, g, w] = [await loginAs(admin), await loginAs(guardian), await loginAs(ward)];

    const suffix = Date.now().toString(36);
    const older = `[QA-FEUX] G24 이전공지 ${suffix}`;
    const newer = `[QA-FEUX] G24 최신공지 ${suffix}`;
    const ids: number[] = [];
    try {
      ids.push((await a.api.post<{ id: number }>('/api/admin/announcement/create', { title: older, content: '이전 공지 본문' })).id);
      await sleep(1_500);
      ids.push((await a.api.post<{ id: number }>('/api/admin/announcement/create', { title: newer, content: '최신 공지 본문' })).id);

      for (const [label, who, path] of [['보호자', g.who, '/guardian/notices'], ['피보호자', w.who, '/ward/notices']] as const) {
        const page = await openAs(who, path);
        await expect(page.getByText(newer), `${label}: 최신 공지는 보여야 한다`).toBeVisible();
        const visibleArticles = await page.locator('article').count();
        test.info().annotations.push({ type: '실측', description: `${label} 화면 공지 카드 ${visibleArticles}개` });
        await expect
          .soft(page.getByText(older), `${label}: 이전 공지가 화면 어디에도 없다 (최신 1건만 렌더, 목록·상세 진입 없음)`)
          .toBeVisible({ timeout: 3_000 });
      }
    } finally {
      for (const id of ids) await a.api.call('DELETE', `/api/admin/announcement/delete/${id}`).catch(() => undefined);
      psql(`DELETE FROM admin_audit_log WHERE admin_id = ${sqlStr(admin.id)}${ids.length ? ` OR target_id IN (${ids.map(id => sqlStr(String(id))).join(', ')})` : ''};`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// G25 - 보호자 대시보드
// ---------------------------------------------------------------------------------------------

test.describe('보호자 대시보드', () => {
  test('[FEUX-G25] 스트림 조회가 실패하고 예약·이상감지 데이터가 없으면 "안정"·"이상 없음"·"2건" 같은 확정 값을 보여 주지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const { who } = await loginAs(guardian);

    const page = await openAs(who, null);
    // 5xx 대신 abort 를 써서 PageWatcher 의 5xx 검사와 섞이지 않게 한다
    await page.route('**/api/streams/v1/live-streams', route => route.abort('failed'));
    await page.goto('/guardian');
    await expect(page.getByText(`${ward.name} 님 오늘 상태`)).toBeVisible();
    await sleep(1_500);

    const hero = await page.locator('section', { hasText: '마지막 업데이트' }).first().innerText();
    const detection = await page.locator('a[href="/guardian/detection"]').last().innerText();
    const emotion = await page.locator('a[href="/guardian/emotion"]').last().innerText();
    const hospital = await page.locator('a[href="/guardian/hospital"]').last().innerText();
    test.info().annotations.push({
      type: '실측',
      description: `히어로 "${hero.replace(/\s+/g, ' ')}" / 이상감지 "${detection.replace(/\s+/g, ' ')}" / 정서 "${emotion.replace(/\s+/g, ' ')}" / 병원 "${hospital.replace(/\s+/g, ' ')}"`,
    });

    expect.soft(hero, '스트림 조회가 실패했는데 히어로가 "안정 · 모니터링 중" 이라고 안심시킨다 (조회 실패도 안정으로 폴백)').not.toContain('안정 · 모니터링 중');
    expect.soft(detection, '이상감지 이력·스트림 상태와 무관하게 항상 "이상 없음" 상수를 표시한다').not.toContain('이상 없음');
    expect.soft(emotion, '정서 분석 데이터가 없는데 항상 "기쁨" 상수를 표시한다').not.toContain('기쁨');
    expect.soft(hospital, '병원 예약이 0건인 임시 보호자에게 항상 "2건" 상수를 표시한다').not.toContain('2건');
  });
});

// ---------------------------------------------------------------------------------------------
// G30 - 알림 권한 요청
// ---------------------------------------------------------------------------------------------

test.describe('알림 권한', () => {
  test('[FEUX-G30] 알림 권한은 사용자 클릭 없이 자동으로 요청하지 않고, 설정 화면에 브라우저 권한 상태를 알려 준다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);

    const page = await openAs(who, null);
    // 제스처를 요구하는 브라우저(Safari/Firefox)처럼 자동 호출은 실패하고, 호출 횟수를 센다
    await page.addInitScript(() => {
      const w = window as unknown as { __permissionCalls: number };
      w.__permissionCalls = 0;
      class FakeNotification {
        static permission = 'default';
        static requestPermission() {
          w.__permissionCalls += 1;
          return Promise.reject(new DOMException('사용자 제스처가 필요합니다.', 'NotAllowedError'));
        }
      }
      Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    });
    const registrations: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/notifications/fcm-token')) registrations.push(request.postData() ?? '');
    });

    await page.goto('/guardian');
    await expect(sidebar(page)).toBeVisible();
    await sleep(2_000);

    const calls = await page.evaluate(() => (window as unknown as { __permissionCalls: number }).__permissionCalls);
    test.info().annotations.push({ type: '실측', description: `클릭 없이 Notification.requestPermission 호출 ${calls}회, FCM 토큰 등록 요청 ${registrations.length}건` });
    expect.soft(calls, '사용자 클릭 없이 로그인/새로고침 직후 RoleRouteGuard effect 가 requestPermission 을 자동 호출한다 (제스처를 요구하는 브라우저에서는 프롬프트가 안 뜸)').toBe(0);

    await nav(page, 'GUARDIAN').getByRole('link', { name: '환경설정' }).click();
    await expect(page.getByText('알림 채널 설정')).toBeVisible();
    await expect
      .soft(
        page.getByText(/브라우저.{0,12}(알림|권한)|알림 권한|권한.{0,8}(필요|거부|차단|허용|요청)/).first(),
        '권한이 default/denied 라 푸시가 등록되지 않았는데 설정 화면에는 브라우저 권한 상태·안내가 없고 앱 푸시가 켜진 것처럼만 보인다',
      )
      .toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------------------------
// G36 - 화면 송출
// ---------------------------------------------------------------------------------------------

test.describe('화면 송출', () => {
  test('[FEUX-G36] 화면 송출은 업로드 실패를 LIVE 로 숨기지 않고, 더블클릭에도 세션을 한 번만 만들며, 화면을 떠나면 세션을 종료한다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(150_000);
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);

    const page = await openAs(who, null);
    const sessionId = `e2e-feux-${Date.now().toString(36)}`;
    let createCalls = 0;
    let createDelayMs = 0;
    let stopCalls = 0;
    let frameCalls = 0;
    let failFrames = false;
    // AI 서버에는 아무것도 보내지 않는다: 세션 생성·프레임·종료를 모두 브라우저에서 가로챈다
    await page.route('**/api/streams/v1/stream-sessions', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      createCalls += 1;
      if (createDelayMs) await sleep(createDelayMs);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session_id: sessionId }) });
    });
    await page.route('**/api/streams/v1/stream-sessions/*/frame', route => {
      frameCalls += 1;
      return failFrames ? route.abort('failed') : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/streams/v1/stream-sessions/*/stop', route => {
      stopCalls += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    const startPreview = async () => {
      await page.getByRole('button', { name: '카메라 미리보기 켜기' }).click();
      await expect(page.getByRole('button', { name: '송출 시작' })).toBeEnabled();
    };
    const stopAll = async () => {
      const stopButton = page.getByRole('button', { name: '송출 종료' });
      if (await stopButton.isVisible()) await stopButton.click();
      const previewOff = page.getByRole('button', { name: '미리보기 끄기' });
      if (await previewOff.isVisible()) await previewOff.click();
    };

    await page.goto('/guardian/stream');
    await expect(page.getByRole('button', { name: '카메라 미리보기 켜기' })).toBeVisible();

    await test.step('업로드가 계속 실패하면 LIVE 표시를 유지하지 않는다', async () => {
      failFrames = true;
      await startPreview();
      await page.getByRole('button', { name: '송출 시작' }).click();
      await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
      await expect
        .soft(page.getByText('LIVE', { exact: true }), '프레임 업로드가 전부 실패하는데 LIVE 배지와 "현재 화면이 보호자에게 전송되고 있습니다." 가 그대로다 (uploadFrame catch 가 비어 있음)')
        .toBeHidden({ timeout: 8_000 });
      test.info().annotations.push({ type: '실측', description: `업로드 실패 구간에서 프레임 요청 ${frameCalls}회 시도` });
      failFrames = false;
      await stopAll();
    });

    await test.step('송출 시작을 더블클릭해도 세션 생성은 한 번이다', async () => {
      await page.reload();
      createCalls = 0;
      createDelayMs = 1_200;
      await startPreview();
      await page.getByRole('button', { name: '송출 시작' }).dblclick();
      await sleep(3_000);
      test.info().annotations.push({ type: '실측', description: `더블클릭 뒤 세션 생성 요청 ${createCalls}회` });
      expect.soft(createCalls, '세션 생성 중에는 시작 버튼이 비활성이 아니라 두 번째 클릭이 세션 생성과 캡처 타이머를 한 번 더 만든다').toBe(1);
      createDelayMs = 0;
      await stopAll();
    });

    await test.step('송출 중 다른 메뉴로 이동하면 서버 세션을 종료한다', async () => {
      await page.reload();
      stopCalls = 0;
      await startPreview();
      await page.getByRole('button', { name: '송출 시작' }).click();
      await expect(page.getByText('LIVE', { exact: true })).toBeVisible();
      await nav(page, 'GUARDIAN').getByRole('link', { name: '공지사항' }).click();
      await expect(page).toHaveURL(/\/guardian\/notices/);
      await sleep(1_500);
      test.info().annotations.push({ type: '실측', description: `메뉴 이동 뒤 세션 종료(stop) 요청 ${stopCalls}회` });
      expect.soft(stopCalls, '송출 중 화면을 떠났는데 stop 호출이 없어 AI 서버에 세션이 남는다 (언마운트 cleanup 이 stopStreamSession 을 호출하지 않음)').toBeGreaterThanOrEqual(1);
    });
  });
});
