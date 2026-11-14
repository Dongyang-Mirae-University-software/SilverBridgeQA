/**
 * 최종 QA - 알림(NOTI) P2 - 알림 설정 화면과 보호자 알림 종류 설정
 *
 * 임시 보호자만 쓴다. FE 기준은 a8666240(배포본): NotificationSettingsSection, SettingsLoadError, RoleRouteGuard·lib/fcm.
 * 브라우저 알림 권한은 가짜 Notification 으로 바꿔 호출 횟수를 센다(실제 권한 팝업·푸시 없음).
 */
import { bodyOf, expect, P2_TAGS, test, TYPE_SETTING } from './_helpers-noti-p2';

type TypeSettings = Record<string, { enabled: boolean; required: boolean }>;

const SETTINGS_API = '**/api/user/me/notification-settings';

async function openChannelTab(page: import('@playwright/test').Page) {
  await expect(page.getByRole('heading', { level: 1, name: '환경설정', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '알림 방법' }).click();
}

/** 가짜 Notification 을 심고(실제 권한 팝업 없음) 권한 요청 횟수를 읽는 함수를 돌려준다 */
async function fakeNotification(page: import('@playwright/test').Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __permCalls: number };
    w.__permCalls = 0;
    class FakeNotification {
      static permission = 'default';
      static requestPermission() {
        w.__permCalls += 1;
        return Promise.resolve('default');
      }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
  });
  return () => page.evaluate(() => (window as unknown as { __permCalls: number }).__permCalls);
}

test.describe('알림 방법 화면', () => {
  test('NOTI-N13 설정 화면에 SMS·알림톡 \'미지원\' 표시가 없고 실제 발송 안내', P2_TAGS, async ({ tempUser, login, openAs }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);
    const page = await openAs(u.who, '/guardian/settings');
    await openChannelTab(page);
    await expect(page.getByRole('switch', { name: 'SMS 문자' }), '준비: 알림 방법 목록이 열렸다').toBeVisible();

    await expect(page.getByText('미지원'), '"미지원" 표시가 없다').toHaveCount(0);
    // 문구는 FE a8666240 의 NotificationSettingsSection 안내문 그대로(실제 BE 발송 규칙을 설명한다)
    await expect(page.getByText('켜 두면 알림을 문자로도 받아요. SOS·이상 감지는 푸시가 안 가면 꺼 두어도 문자로 대신 보내요.', { exact: true }), 'SMS 문자 안내').toBeVisible();
    await expect(page.getByText('이상 감지 알림을 카카오톡 메시지로 알려 드려요.', { exact: true }), '알림톡 안내').toBeVisible();
    for (const name of ['SMS 문자', '카카오톡 알림톡']) {
      await expect(page.getByRole('switch', { name }), `${name} 스위치를 켜고 끌 수 있다`).toBeEnabled();
    }
  });

  test('NOTI-N19 알림 설정 조회 실패 시 오류 배너와 재시도, 토글 막기', P2_TAGS, async ({ tempUser, login, openAs }) => {
    test.setTimeout(90_000);
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);
    const page = await openAs(u.who, null);
    let failing = true;
    let failedCalls = 0;
    await page.route(SETTINGS_API, route => {
      if (failing && route.request().method() === 'GET') {
        failedCalls += 1;
        // 서버 5xx 로 흉내 내면 공용 픽스처가 "API 5xx" 버그로 세므로, 연결 끊김으로 실패를 만든다
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto('/guardian/settings');
    await openChannelTab(page);

    const banner = page.getByRole('alert').filter({ hasText: '설정을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.' });
    await expect(banner, '오류 배너(조회를 여러 번 다시 해 본 뒤에 나온다)').toBeVisible({ timeout: 45_000 });
    expect(failedCalls, '조회가 실제로 실패로 막혔다').toBeGreaterThan(0);
    await expect(banner.getByRole('button', { name: '다시 시도', exact: true }), '다시 시도 버튼').toBeEnabled();
    await expect(page.getByRole('switch'), '실패했을 땐 토글을 그리지 않는다(꺼 둔 알림이 켜진 것처럼 보이면 안 된다)').toHaveCount(0);

    failing = false;
    await banner.getByRole('button', { name: '다시 시도', exact: true }).click();
    await expect(page.getByRole('switch', { name: '푸시 알림' }), '다시 시도하면 설정이 보인다').toBeVisible();
    await expect(page.getByRole('switch', { name: '푸시 알림' }), '푸시는 처음 기본값대로 켜짐').toBeChecked();
    await expect(banner, '오류 배너는 사라진다').toHaveCount(0);
    await expect(page.getByRole('switch'), '스위치 4개').toHaveCount(4);
  });

  test('NOTI-N20 알림 권한은 버튼 클릭 때만 요청', P2_TAGS, async ({ tempUser, login, openAs }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);
    const page = await openAs(u.who, null);
    const calls = await fakeNotification(page);

    await page.goto('/guardian/settings');
    await openChannelTab(page);
    await expect(page.getByRole('switch', { name: '푸시 알림' }), '준비: 설정 화면이 다 그려졌다').toBeVisible();

    // 늦게 부르는 경우도 잡도록 진입 뒤 3초 동안 계속 0 인지 본다
    for (let i = 0; i < 6; i++) {
      expect.soft(await calls(), `진입 후 ${(i + 1) * 0.5}초: 권한을 요청하지 않는다(자동 팝업 없음)`).toBe(0);
      await page.waitForTimeout(500);
    }

    const allow = page.getByRole('button', { name: '알림 허용하기', exact: true });
    const hasButton = (await allow.count()) > 0;
    expect.soft(hasButton, '설정 화면에 "알림 허용하기" 버튼이 있다').toBe(true);
    if (hasButton) {
      const before = await calls();
      await allow.click();
      await expect.poll(calls, { message: '버튼을 누르면 그때 권한을 요청한다' }).toBe(before + 1);
    }

    test.info().annotations.push({
      type: '버그 의심 근거',
      description: 'FE a8666240: RoleRouteGuard 의 useEffect 와 completeSigninSession 이 화면 진입·로그인 직후 registerFcmTokenForCurrentDevice 를 부르고, 저장된 토큰이 없으면 그 안에서 Notification.requestPermission 을 바로 부른다. 보호자 설정 화면에는 "알림 허용하기" 버튼 코드가 없다(피보호자 복약 화면 WardPushPermissionNotice 에만 있다). 진짜 버그라 약하게 만들지 않았다',
    });
  });

  test('NOTI-N20b 설정 화면에 현재 알림 권한 상태 칸이 있음', P2_TAGS, async ({ tempUser, login, openAs }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);
    const page = await openAs(u.who, null);
    await fakeNotification(page);

    await page.goto('/guardian/settings');
    await openChannelTab(page);
    await expect(page.getByRole('switch', { name: '푸시 알림' }), '준비: 설정 화면이 다 그려졌다').toBeVisible();
    // 정확한 문구는 케이스 문서에 없어 "권한 상태를 알리는 글이 하나라도 있다"만 최소로 본다
    await expect(page.getByText(/권한|허용됨|차단됨|아직 정하지/).first(), '설정 화면에 현재 알림 권한 상태 칸이 있다').toBeVisible({ timeout: 3_000 });
    test.info().annotations.push({
      type: '버그 의심 근거',
      description: 'NOTI-N20 과 같은 원인: 보호자 설정 화면(NotificationSettingsSection)에 권한 상태 표시 코드가 없다',
    });
  });
});

test.describe('보호자 알림 종류 설정', () => {
  test('NOTI-N29 PUT에서 null·생략은 그대로 유지', P2_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const { api } = await login(user);
    const put = async (data: Record<string, unknown>) => {
      const res = await api.raw('PUT', TYPE_SETTING, data);
      expect(res.status(), `PUT ${JSON.stringify(data)} -> 200`).toBe(200);
      return ((await bodyOf(res)).data as TypeSettings) ?? {};
    };
    const flags = (s: TypeSettings) => ({
      reminder: s.anomalyReviewReminder.enabled,
      medication: s.medication.enabled,
      camera: s.cameraLinkLost.enabled,
      notice: s.companionNotice.enabled,
    });

    // 준비: 선택 항목 4개를 서로 다른 값으로 만든다
    const start = await put({ anomalyReviewReminder: false, medication: true, cameraLinkLost: false, companionNotice: false });
    expect(flags(start), '준비: 시작 값').toEqual({ reminder: false, medication: true, camera: false, notice: false });

    const onlyMedication = await put({ medication: false });
    expect(flags(onlyMedication), 'medication 만 보내면 나머지 3개는 그대로').toEqual({ reminder: false, medication: false, camera: false, notice: false });

    const withNulls = await put({ medication: true, anomalyReviewReminder: null, cameraLinkLost: null, companionNotice: null });
    expect(flags(withNulls), '나머지를 null 로 보내도 그대로').toEqual({ reminder: false, medication: true, camera: false, notice: false });

    const empty = await put({});
    expect(flags(empty), '빈 본문도 아무것도 바꾸지 않는다').toEqual({ reminder: false, medication: true, camera: false, notice: false });

    const reread = (await bodyOf(await api.raw('GET', TYPE_SETTING))).data as TypeSettings;
    expect(flags(reread), '다시 조회해도 같다').toEqual({ reminder: false, medication: true, camera: false, notice: false });
  });

  test('NOTI-N30 anomalyReviewReminder는 reminder-setting과 같은 값', P2_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const { api } = await login(user);
    const reminderApi = '/api/guardian/anomaly/reminder-setting';
    const typeValue = async () => (((await bodyOf(await api.raw('GET', TYPE_SETTING))).data as TypeSettings).anomalyReviewReminder.enabled);
    const reminderValue = async () => {
      const res = await api.raw('GET', reminderApi);
      expect(res.status(), 'reminder-setting 조회 200').toBe(200);
      return ((await bodyOf(res)).data as { reviewReminderEnabled: boolean }).reviewReminderEnabled;
    };

    expect(await typeValue(), '처음에는 켜져 있다').toBe(true);
    expect(await reminderValue(), '처음에는 두 API 가 같다').toBe(true);

    const off = await api.raw('PUT', TYPE_SETTING, { anomalyReviewReminder: false });
    expect(off.status(), 'notification-type-setting 에서 끄기').toBe(200);
    expect(await typeValue(), '종류 설정은 꺼짐').toBe(false);
    expect(await reminderValue(), 'reminder-setting 도 꺼짐').toBe(false);

    const on = await api.raw('PUT', reminderApi, { reviewReminderEnabled: true });
    expect(on.status(), 'reminder-setting 에서 다시 켜기').toBe(200);
    expect(await reminderValue(), 'reminder-setting 켜짐').toBe(true);
    expect(await typeValue(), '반대 방향으로도 종류 설정이 켜짐으로 따라간다').toBe(true);
  });
});
