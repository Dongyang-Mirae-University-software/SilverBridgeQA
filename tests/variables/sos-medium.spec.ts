/**
 * 변수 QA - 긴급 SOS (medium 등급)
 *
 * 각 테스트는 "올바른 동작"을 단언하므로 버그가 살아 있는 동안에는 실패한다.
 *
 * 부작용 차단: 모든 SOS 는 임시 피보호자로만 보낸다. 화면 SOS 는 보내기 전에 알림 쿨다운 키를 넣어 두고,
 * 서버 알림 경로를 직접 확인하는 테스트(G09·G11)는 전화번호·FCM 토큰이 없는 임시 보호자만 연결해
 * 실제 SMS/푸시가 나갈 수 없게 한다.
 */
import { expect, test } from '../../src/fixtures';
import { psql, redis, sqlStr } from '../../src/remote';
import { collectSosPosts, connect, presetSosAction, sosEventCount, suppressSosNotify } from '../../src/variables';

const ACTIVE_GUARDIANS = '**/api/ward/connection/active';

const cooldownKey = (wardId: string) => `sos:notify:cooldown:${wardId}`;

function notificationLogCount(guardianId: string, wardId: string) {
  return Number(psql(`SELECT count(*) FROM notification_log
                      WHERE recipient_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} AND type = 'WARD_SOS';`));
}

test.describe('SOS 화면 - 보호자 목록 로딩과 전송 실패', () => {
  test('[SOS-G03] 보호자 목록 로딩 중에 연 확인창도 조회가 끝난 뒤 보내기를 누르면 SOS 가 서버로 전송된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await presetSosAction(page, 'call119AndNotify');
    // 느린 네트워크: 보호자 목록 응답을 5초 늦춘다
    await page.route(ACTIVE_GUARDIANS, async route => {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      await route.continue();
    });
    const posts = collectSosPosts(page);
    await page.goto('/ward/sos');

    // 목록 로딩 중에 바로 긴급 SOS 를 눌러 확인창을 연다
    await page.getByRole('button', { name: /긴급 SOS/ }).click();
    const confirm = page.getByRole('alertdialog', { name: '긴급 SOS 전송' });
    await expect(confirm).toBeVisible();
    await test.step('로딩이 끝날 때까지 기다린 뒤(보호자 카드가 보임) 보내기', async () => {
      await expect(page.getByRole('link', { name: `${guardian.name}에게 전화하기` })).toBeVisible({ timeout: 15_000 });
      await confirm.getByRole('button', { name: '보내기' }).click();
    });

    await expect
      .poll(() => posts.length, {
        message: '확인창이 "보호자 없음"(로딩 중 값)으로 고정되어 보내기를 눌러도 POST /api/ward/sos 없이 119 키패드만 열렸다',
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
  });

  test('[SOS-G04] 보호자가 없는 피보호자가 SOS 를 눌러도 서버에 이력이 남는다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await presetSosAction(page, 'call119AndNotify');
    const posts = collectSosPosts(page);
    await page.goto('/ward/sos');
    // 보호자 목록 조회가 끝나 "보호자 없음"이 확정된 뒤에 누른다
    await expect(page.getByText('현재 연결된 보호자가 없습니다.')).toBeVisible();

    await page.getByRole('button', { name: /긴급 SOS/ }).click();
    await expect(page.getByRole('dialog', { name: '119 신고 키패드' })).toBeVisible();

    await expect
      .poll(() => posts.length, {
        message: '보호자가 0명이면 FE 가 API 를 생략해 POST /api/ward/sos 가 나가지 않는다 (BE 는 이력만 저장하도록 설계됨)',
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
    expect(Number(psql(`SELECT count(*) FROM sos_event WHERE ward_id = ${sqlStr(ward.id)};`)), 'SOS 이력이 남아야 한다').toBe(1);
  });

  test('[SOS-G06] 119 와 함께 보내기 설정에서 SOS 전송이 실패해도 119 화면으로 갈 수 있다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await presetSosAction(page, 'call119AndNotify');
    // 서버 오류/타임아웃 상황: 요청 자체를 실패시킨다 (실제 서버 호출 없음)
    await page.route('**/api/ward/sos', route => route.abort('failed'));
    await page.goto('/ward/sos');
    await expect(page.getByRole('link', { name: `${guardian.name}에게 전화하기` })).toBeVisible();

    await page.getByRole('button', { name: /긴급 SOS/ }).click();
    const confirm = page.getByRole('alertdialog', { name: '긴급 SOS 전송' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: '보내기' }).click();

    const errorModal = page.getByRole('alertdialog', { name: 'SOS 전송 실패' });
    const dial = page.getByRole('dialog', { name: '119 신고 키패드' });
    await expect(errorModal.or(dial).first()).toBeVisible();

    // 올바른 동작: 실패 후에도 119 키패드가 자동으로 뜨거나, 오류 모달에서 119 화면을 열 수 있다
    const dialOpened = await dial.isVisible();
    const canOpenDial = await errorModal.getByRole('button', { name: /119/ }).count();
    expect(
      dialOpened || canOpenDial > 0,
      '전송 실패 시 "확인" 버튼뿐인 오류 모달만 떠서 119 화면으로 갈 방법이 없다 (재시도해도 같은 실패를 반복)',
    ).toBe(true);
  });
});

test.describe('SOS 알림 서버 경로', () => {
  test('[SOS-G09] 아무에게도 전달되지 않은 SOS 는 쿨다운을 남기지 않아 재요청 시 다시 발송을 시도한다', async ({ tempUser, loginAs }) => {
    // 전화번호도 FCM 토큰도 없는 보호자: 푸시·SMS 모두 실패 (실제 발송 없음)
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const { api } = await loginAs(ward);

    await api.post('/api/ward/sos', {});
    await expect
      .poll(() => notificationLogCount(guardian.id, ward.id), { message: '첫 SOS 의 알림 이력(notification_log)이 생겨야 한다', timeout: 20_000 })
      .toBe(1);
    const results = psql(`SELECT result FROM notification_log WHERE recipient_id = ${sqlStr(guardian.id)};`);
    expect(results, '전화번호·토큰이 없으니 전달 실패로 기록되어야 한다').not.toMatch(/DELIVERED|SMS_FALLBACK/);

    expect
      .soft(redis('EXISTS', cooldownKey(ward.id)), '아무에게도 전달되지 않았는데 30초 쿨다운 키가 남아 있다')
      .toBe('0');

    // 10초 뒤 다시 SOS: 미전달이었으니 다시 발송을 시도해야 한다
    await new Promise(resolve => setTimeout(resolve, 10_000));
    await api.post('/api/ward/sos', {});
    await expect
      .poll(() => notificationLogCount(guardian.id, ward.id), {
        message: '쿨다운 때문에 재요청 SOS 의 알림 발송 시도(notification_log)가 생략되었다',
        timeout: 15_000,
      })
      .toBe(2);
  });

  test('[SOS-G10] 인증 필터의 Redis 조회가 실패해도 SOS 요청이 거부되지 않고 이력이 저장된다', async ({ tempUser, loginAs }) => {
    // 공유 dev 의 Redis 를 내릴 수는 없으므로, 임시 피보호자 한 명의 비밀번호 변경 무효화 키
    // (password:invalidate:{userId}) 를 문자열이 아닌 리스트 타입으로 넣어 둔다.
    // 그러면 JwtAuthenticationFilter.isInvalidatedByPasswordChange 의 GET 이 WRONGTYPE 으로 실패해
    // Redis 장애와 같은 DataAccessException 이 이 사용자 요청에서만 난다 (다른 사용자에게는 영향 없음).
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { api } = await loginAs(ward);

    // 대조: 키를 넣기 전에는 같은 토큰으로 인증이 정상 통과한다
    const before = await api.raw('GET', '/api/ward/connection/active');
    expect(before.status(), '사전 조건: Redis 이상이 없을 때 이 토큰은 인증을 통과해야 한다').toBe(200);

    const invalidateKey = `password:invalidate:${ward.id}`;
    redis('DEL', invalidateKey);
    redis('RPUSH', invalidateKey, 'qa-redis-failure');
    redis('EXPIRE', invalidateKey, '300');
    try {
      const res = await api.raw('POST', '/api/ward/sos', {});
      const body = await res.text();
      expect(
        res.status(),
        // 필터 밖으로 나간 예외는 /error 재디스패치에서 익명 요청으로 다시 막혀 500 대신 401 로 보일 수 있다
        `인증 필터의 Redis 조회 실패(WRONGTYPE)가 잡히지 않아 SOS 요청이 컨트롤러에 닿기 전에 ${res.status()} 로 끝난다 (응답: ${body.slice(0, 200)})`,
      ).toBeLessThan(300);
      expect(sosEventCount(ward.id), 'Redis 조회 실패 중 보낸 SOS 가 이력(sos_event)에 남지 않았다').toBe(1);
    } finally {
      redis('DEL', invalidateKey);
    }
  });
});

test.describe('웹 보호자 SOS 토스트', () => {
  test('[SOS-G11] 반복 SOS 의 웹 토스트에는 반복 횟수("N번째") 문구가 표시된다', async ({ tempUser, loginAs, openAs }) => {
    // 전화번호·FCM 토큰이 없는 보호자라 푸시·SMS 는 나가지 않고, 웹 소켓 토스트만 확인한다
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const [g, w] = [await loginAs(guardian), await loginAs(ward)];

    const page = await openAs(g.who, '/guardian/sos');
    await page.waitForFunction(
      () => (window as unknown as { __connectionStompClient?: { connected: boolean } }).__connectionStompClient?.connected === true,
      null,
      { timeout: 30_000 },
    );
    const toasts = page.locator('[aria-live="polite"]');

    await test.step('첫 번째 SOS: 기본 문구 토스트', async () => {
      await w.api.post('/api/ward/sos', {});
      await expect(toasts.filter({ hasText: '긴급 도움을 요청했습니다' })).toBeVisible({ timeout: 20_000 });
    });

    await test.step('쿨다운 키를 지우고(30초 대기 대신) 두 번째 SOS', async () => {
      await expect.poll(() => redis('EXISTS', cooldownKey(ward.id))).toBe('1');
      redis('DEL', cooldownKey(ward.id));
      await w.api.post('/api/ward/sos', {});
    });

    await expect(
      toasts.filter({ hasText: /번째/ }),
      '두 번째 SOS(10분 내 2번째)인데 웹 토스트에 반복 횟수 문구가 없고 첫 번째와 같은 고정 문구만 나온다',
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('보호자 SOS 이력 화면', () => {
  test('[SOS-G12] 이력이 50건을 넘어도 "보호자에게 연락" 탭이 전체 기준으로 건수와 목록을 보여준다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);

    // 최신 55건은 SOS_BUTTON, 가장 오래된 5건만 GUARDIAN_CALL (두 번째 페이지에만 존재)
    psql(`INSERT INTO sos_event (ward_id, trigger_type, created_at)
          SELECT ${sqlStr(ward.id)}, 'SOS_BUTTON', now() - (g * interval '1 minute') FROM generate_series(1, 55) g;
          INSERT INTO sos_event (ward_id, trigger_type, created_at)
          SELECT ${sqlStr(ward.id)}, 'GUARDIAN_CALL', now() - interval '2 days' - (g * interval '1 minute') FROM generate_series(1, 5) g;`);

    const { who } = await loginAs(guardian);
    const page = await openAs(who, '/guardian/sos');
    await expect(page.getByText('전체 호출', { exact: true })).toBeVisible();
    await expect(page.getByText('60 건')).toBeVisible();

    const tab = page.getByRole('tab', { name: /^보호자에게 연락/ });
    await expect(tab, '전체 60건 중 보호자에게 연락 5건이 있는데 현재 페이지 기준이라 0 으로 표시된다').toHaveText(/보호자에게 연락 5$/);
    await tab.click();
    await expect(
      page.getByText('표시할 SOS 이력이 없습니다.'),
      '다른 페이지에 있는 "보호자에게 연락" 이력이 필터 결과에서 빠져 빈 목록 문구가 나온다',
    ).toBeHidden();
  });
});
