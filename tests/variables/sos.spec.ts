/**
 * 변수 QA - 긴급 SOS
 *
 * 정책(.claude/rules/domain-security-policy.md): SOS 동작 설정이 어떤 값이든 SOS 를 누르면 서버에 기록되고
 * 보호자에게 알림이 간다. 설정은 119 화면을 띄우는 시점만 바꾼다. 보호자가 0명이어도 서버는 이력만 남긴다.
 *
 * 부작용 차단: 모든 SOS 는 임시 피보호자로만 보내고, 보내기 전에 알림 쿨다운 키를 넣어 FCM·SMS 가 나가지 않게 한다.
 */
import { expect, test } from '../../src/fixtures';
import {
  collectSosPosts, connect, loginViaForm, logoutViaProfile, presetSosAction, pressSos, readSosAction,
  sosEventCount, suppressSosNotify,
} from '../../src/variables';

const ACTIVE_GUARDIANS = '**/api/ward/connection/active';

test.describe('SOS 동작 설정과 관계없이 SOS 는 서버에 도착해야 한다', () => {
  test('[SOS-G01] "119에 바로 연결" 설정이어도 SOS 를 누르면 서버에 기록되고 보호자 알림 대상이 된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await presetSosAction(page, 'call119');
    const posts = collectSosPosts(page);
    await page.goto('/ward/sos');
    await expect(page.getByRole('link', { name: `${guardian.name}에게 전화하기` })).toBeVisible();

    await page.getByRole('button', { name: /긴급 SOS/ }).click();
    await expect(page.getByRole('dialog', { name: '119 신고 키패드' })).toBeVisible();

    await expect
      .poll(() => posts.length, { message: 'POST /api/ward/sos 가 나가야 한다 (지금은 키패드만 열고 서버 호출 없음)', timeout: 5_000 })
      .toBeGreaterThan(0);
    expect(sosEventCount(ward.id), '서버에 SOS 이력이 남아야 한다').toBe(1);
  });

  test('[SOS-G02] 보호자 목록 조회가 실패하면 "보호자 없음"으로 판단해 SOS 를 버리지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await presetSosAction(page, 'notifyGuardianFirst');
    // 일시적인 네트워크 오류 (5xx 대신 abort 를 써서 PageWatcher 의 5xx 검사와 섞이지 않게 한다)
    await page.route(ACTIVE_GUARDIANS, route => route.abort('failed'));
    const posts = collectSosPosts(page);
    await page.goto('/ward/sos');
    await expect(page.getByRole('button', { name: /긴급 SOS/ })).toBeVisible();

    await expect.soft(page.getByText('현재 연결된 보호자가 없습니다.'), '조회 실패를 "보호자 없음"으로 보여 주면 안 된다')
      .toHaveCount(0);

    await pressSos(page);

    // 올바른 동작은 둘 중 하나: SOS 를 서버로 보내거나(보호자 판정은 서버가 함), 오류를 알리고 키패드로 넘기지 않거나
    const sent = await expect
      .poll(() => posts.length, { timeout: 5_000 })
      .toBeGreaterThan(0)
      .then(() => true, () => false);
    if (!sent) {
      await expect(page.getByRole('dialog', { name: '119 신고 키패드' }), 'SOS 를 보내지 않은 채 키패드만 열면 안 된다').toBeHidden();
      await expect(page.getByText('보호자 목록을 불러오지 못했습니다.')).toBeVisible();
    }
  });

  test('[SOS-G02] 보호자 목록을 불러오는 중에 SOS 를 눌러도 SOS 가 서버로 간다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await presetSosAction(page, 'notifyGuardianFirst');
    // 느린 네트워크: 목록 응답이 4초 늦게 온다
    await page.route(ACTIVE_GUARDIANS, async route => {
      await new Promise(resolve => setTimeout(resolve, 4_000));
      await route.continue();
    });
    const posts = collectSosPosts(page);
    await page.goto('/ward/sos');

    await pressSos(page);

    await expect
      .poll(() => posts.length, { message: '로딩 중 스냅샷(보호자 0명) 때문에 "보내기"가 서버 호출 없이 키패드만 열면 안 된다', timeout: 10_000 })
      .toBeGreaterThan(0);
  });
});

test.describe('같은 기기를 여러 피보호자가 쓸 때', () => {
  test('[XAREA-G03] 앞 사람의 "119에 바로 연결" 설정이 다음 피보호자에게 넘어가지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const first = await tempUser('WARD');
    const guardian = await tempUser('GUARDIAN');
    const second = await tempUser('WARD');
    connect(guardian.id, second.id);
    suppressSosNotify(second.id);
    const { who } = await loginAs(first);

    const page = await openAs(who, '/ward/settings');
    await test.step('첫 번째 피보호자: 119에 바로 연결을 고르고 로그아웃', async () => {
      await page.getByRole('radiogroup', { name: 'SOS 동작 설정' }).getByText('119에 바로 연결', { exact: true }).click();
      await expect.poll(() => readSosAction(page)).toBe('call119');
      await logoutViaProfile(page, first.name);
    });

    await test.step('두 번째 피보호자: 같은 브라우저로 로그인', async () => {
      await loginViaForm(page, second.email, second.password);
      await expect(page).toHaveURL(/\/ward$/);
    });

    const posts = collectSosPosts(page);
    await test.step('두 번째 피보호자는 설정을 바꾼 적이 없으니 기본값이어야 한다', async () => {
      expect.soft(await readSosAction(page), '앞 사람의 sosAction 이 남아 있으면 안 된다').not.toBe('call119');
    });

    await test.step('두 번째 피보호자의 SOS 는 보호자에게 간다', async () => {
      await page.goto('/ward/sos');
      await expect(page.getByRole('link', { name: `${guardian.name}에게 전화하기` })).toBeVisible();
      await pressSos(page);
      await expect
        .poll(() => posts.length, { message: 'POST /api/ward/sos 가 나가야 한다', timeout: 5_000 })
        .toBeGreaterThan(0);
    });
  });
});
