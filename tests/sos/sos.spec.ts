/**
 * 긴급 SOS: 피보호자가 SOS 를 누르면 보호자에게 실시간 알림 + 이력 + 알림 발송 기록.
 *
 * 실제 발송 주의: WARD_SOS 는 FCM 강제 + 미전달 시 SMS 폴백이다. E2E 보호자 전화번호는
 * 010-0000-9xxx(미배정 국번)라 SMS 폴백이 실행돼도 실제로 받는 사람이 없다.
 *
 * 사용 계정: ward1 → guardian1 (기본 연결), ward3 (보호자 없음)
 */
import { Page } from '@playwright/test';

import { ACCOUNTS } from '../../src/accounts';
import { env } from '../../src/env';
import { expect, expectPageTitle, modal, test, waitForRealtime } from '../../src/fixtures';
import { psqlRows, redisDelPattern, sqlStr } from '../../src/remote';
import { suppressSosNotify } from '../../src/variables';

const G1 = ACCOUNTS.guardian1;
const W1 = ACCOUNTS.ward1;

type SosAction = '119에 바로 연결' | '119 연결 + 보호자 알림' | '보호자에게 먼저 알림';

const SOS_ACTION_VALUE: Record<SosAction, string> = {
  '119에 바로 연결': 'call119',
  '119 연결 + 보호자 알림': 'call119AndNotify',
  '보호자에게 먼저 알림': 'notifyGuardianFirst',
};

async function chooseSosAction(ward: Page, action: SosAction) {
  await ward.goto('/ward/settings');
  await expectPageTitle(ward, '환경설정');
  // 라디오 input 이 display:none 이라 역할(radio)로는 못 찾는다 → 라벨을 누른다 (접근성 이슈는 settings 테스트에서 따로 검증)
  await ward.getByRole('radiogroup', { name: 'SOS 동작 설정' }).getByText(action, { exact: true }).click();
  await expect
    .poll(() => ward.evaluate(() => JSON.parse(localStorage.getItem('silverbridge_ward_settings') ?? '{}').sosAction))
    .toBe(SOS_ACTION_VALUE[action]);
  await ward.goto('/ward/sos');
  await expect(ward.getByRole('button', { name: /긴급 SOS/ })).toBeVisible();
}

function sosRequests(page: Page) {
  const bodies: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/ward/sos')) bodies.push(request.postData() ?? '');
  });
  return bodies;
}

/** 알림 쿨다운(BE 기본 10초) 해제 (쿨다운 안이면 이력만 남고 알림은 생략되는 게 정상 동작이라) */
function clearSosCooldown() {
  redisDelPattern(`sos:notify:cooldown:${W1.id}`);
}

test.describe('긴급 SOS', () => {
  test('피보호자가 SOS 를 보내면 보호자에게 실시간 알림이 오고 SOS 이력에 기록된다', async ({ openAs }) => {
    // 알림까지 검증하는 건 이 테스트뿐이다. 나머지는 suppressSosNotify 로 쿨다운 키를 넣어 이력만 남긴다 (SMS 폴백 시도 최소화)
    // 헤드리스 브라우저엔 FCM 토큰이 없어서 이 테스트는 실행마다 Solapi 로 SMS 1건을 실제 발송 요청한다.
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    clearSosCooldown();
    const guardian = await openAs('guardian1', '/guardian/sos');
    const ward = await openAs('ward1', '/ward');
    await expectPageTitle(guardian, 'SOS 이력');
    await Promise.all([waitForRealtime(guardian), waitForRealtime(ward)]);
    const startedAt = new Date().toISOString();

    await chooseSosAction(ward, '보호자에게 먼저 알림');

    await test.step('피보호자: 긴급 SOS → 보내기', async () => {
      await ward.getByRole('button', { name: /긴급 SOS/ }).click();
      const confirm = modal(ward, '긴급 SOS 전송');
      await expect(confirm).toContainText('연결된 보호자에게 알림이 전달됩니다');
      await confirm.getByRole('button', { name: '보내기' }).click();
      const done = modal(ward, 'SOS 전송 완료');
      await expect(done).toContainText('보호자에게 알림을 보냈습니다.');
      await expect(done.getByRole('button', { name: '119 화면 열기' })).toBeVisible();
    });

    await test.step('보호자: 새로고침 없이 긴급 SOS 알림이 뜬다', async () => {
      const sosToast = guardian.locator('[aria-live="polite"]').filter({ hasText: '긴급 SOS' });
      await expect(sosToast).toBeVisible();
      await expect(sosToast).toContainText(W1.name);
      // 긴급 알림은 자동으로 닫히지 않아야 한다
      await guardian.waitForTimeout(7_000);
      await expect(sosToast).toBeVisible();
    });

    await test.step('보호자: 이력 맨 위에 새 SOS 가 있다', async () => {
      const first = guardian.getByRole('list').last().getByRole('listitem').first();
      await expect(first).toContainText(`${W1.name} · 긴급 SOS 버튼`);
    });

    await test.step('서버: 보호자에게 WARD_SOS 알림 발송이 기록됐다', async () => {
      await expect
        .poll(() => psqlRows(`SELECT result, channel_results::text FROM notification_log
                              WHERE recipient_id = ${sqlStr(G1.id)} AND type = 'WARD_SOS'
                                AND created_at >= ${sqlStr(startedAt)}::timestamptz
                              ORDER BY id DESC LIMIT 1;`), { timeout: 20_000 })
        .toHaveLength(1);
      const [[result, channels]] = psqlRows(`SELECT result, channel_results::text FROM notification_log
        WHERE recipient_id = ${sqlStr(G1.id)} AND type = 'WARD_SOS' ORDER BY id DESC LIMIT 1;`);
      test.info().annotations.push({ type: 'WARD_SOS 발송 결과', description: `${result} ${channels}` });
      // 헤드리스 브라우저는 FCM 토큰이 없으므로 FCM 미전달 → SMS 폴백 시도가 정책대로 일어나야 한다
      expect(channels).toContain('"channel": "FCM"');
      expect(channels).toContain('"channel": "SMS"');
    });
  });

  test('119 화면 열기를 누르면 테스트용 119 키패드가 뜨고 실제 발신은 막혀 있다', async ({ openAs }) => {
    suppressSosNotify(W1.id);
    const ward = await openAs('ward1', '/ward');
    await chooseSosAction(ward, '보호자에게 먼저 알림');

    await ward.getByRole('button', { name: /긴급 SOS/ }).click();
    await modal(ward, '긴급 SOS 전송').getByRole('button', { name: '보내기' }).click();
    await modal(ward, 'SOS 전송 완료').getByRole('button', { name: '119 화면 열기' }).click();

    const dial = ward.getByRole('dialog', { name: '119 신고 키패드' });
    await expect(dial).toContainText('119');
    await expect(dial.getByRole('button', { name: '발신 불가(테스트 화면)' })).toBeDisabled();
    await dial.getByRole('button', { name: '닫기' }).click();
    await expect(dial).toBeHidden();
  });

  test('기본 설정(119 연결 + 보호자 알림)에서는 SOS 를 보낸 뒤 바로 119 키패드가 뜬다', async ({ openAs }) => {
    suppressSosNotify(W1.id);
    const ward = await openAs('ward1', '/ward');
    await chooseSosAction(ward, '119 연결 + 보호자 알림');
    const requests = sosRequests(ward);

    await ward.getByRole('button', { name: /긴급 SOS/ }).click();
    await modal(ward, '긴급 SOS 전송').getByRole('button', { name: '보내기' }).click();
    await expect(ward.getByRole('dialog', { name: '119 신고 키패드' })).toBeVisible();
    expect(requests).toHaveLength(1);
  });

  // 정책(.claude/rules/domain-security-policy.md): SOS 동작 설정은 119 화면을 띄우는 시점만 바꾸고,
  // 어떤 설정이든 SOS 는 서버에 기록되고 보호자 알림이 나가야 한다. (변수 QA SOS-G01)
  test('"119에 바로 연결" 설정이어도 키패드와 함께 SOS 가 서버로 간다', async ({ openAs }) => {
    suppressSosNotify(W1.id);
    const ward = await openAs('ward1', '/ward');
    await chooseSosAction(ward, '119에 바로 연결');
    const requests = sosRequests(ward);

    await ward.getByRole('button', { name: /긴급 SOS/ }).click();
    await expect(ward.getByRole('dialog', { name: '119 신고 키패드' })).toBeVisible();
    await expect.poll(() => requests.length, { message: 'POST /api/ward/sos 가 나가야 한다', timeout: 5_000 }).toBe(1);
  });

  test('SOS 확인창에서 취소하면 아무것도 보내지 않는다', async ({ openAs }) => {
    const ward = await openAs('ward1', '/ward');
    await chooseSosAction(ward, '보호자에게 먼저 알림');
    const requests = sosRequests(ward);

    await ward.getByRole('button', { name: /긴급 SOS/ }).click();
    await modal(ward, '긴급 SOS 전송').getByRole('button', { name: '취소' }).click();
    await expect(modal(ward, '긴급 SOS 전송')).toHaveCount(0);
    expect(requests).toHaveLength(0);
  });

  // 보호자가 0명이어도 서버는 이력만 남긴다(알림 대상 없음). 화면이 서버 호출을 건너뛰면 이력이 사라진다. (변수 QA SOS-G04)
  test('연결된 보호자가 없는 피보호자도 SOS 를 누르면 119 키패드와 함께 이력이 남는다', async ({ openAs }) => {
    const ward = await openAs('ward3', '/ward/sos');
    const requests = sosRequests(ward);
    await expect(ward.getByRole('button', { name: /긴급 SOS/ })).toBeVisible();

    await ward.getByRole('button', { name: /긴급 SOS/ }).click();
    await expect(ward.getByRole('dialog', { name: '119 신고 키패드' })).toBeVisible();
    await expect.poll(() => requests.length, { message: 'POST /api/ward/sos 가 나가야 한다', timeout: 5_000 }).toBe(1);
  });

  test('보호자 전화 카드를 누르면 "보호자에게 직접 전화" 이력이 남는다', async ({ openAs }) => {
    suppressSosNotify(W1.id);
    const ward = await openAs('ward1', '/ward/sos');
    const call = ward.getByRole('link', { name: `${G1.name}에게 전화하기` });
    await expect(call).toHaveAttribute('href', `tel:${G1.phone}`);

    const [request] = await Promise.all([
      ward.waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/ward/sos')),
      call.click(),
    ]);
    expect(request.postDataJSON()).toMatchObject({ triggerType: 'GUARDIAN_CALL' });

    const guardian = await openAs('guardian1', '/guardian/sos');
    await guardian.getByRole('tab', { name: /^보호자에게 연락/ }).click();
    await expect(guardian.getByRole('list').last().getByRole('listitem').first())
      .toContainText(`${W1.name} · 보호자에게 직접 전화`);
  });
});

test.describe('SOS 이력 화면', () => {
  test('연결된 피보호자가 없는 보호자는 안내 문구를 본다', async ({ openAs }) => {
    const guardian = await openAs('guardian3', '/guardian/sos');
    await expect(guardian.getByText('연결된 피보호자가 없습니다.')).toBeVisible();
  });
});
