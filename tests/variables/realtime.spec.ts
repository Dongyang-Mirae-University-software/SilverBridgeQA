/**
 * 변수 QA - 실시간 알림(WebSocket·푸시 토스트)
 *
 * 부작용 없음: 서버 발송 없이 브라우저 안의 STOMP 프레임·로컬 이벤트만 쓴다.
 */
import { expect, test, toast, waitForRealtime } from '../../src/fixtures';
import { connect, loginViaForm, logoutViaProfile } from '../../src/variables';

const FORGED_NAME = 'E2E위조';

test.describe('STOMP 목적지 권한', () => {
  test('[XCUT-G04] 다른 사용자의 /topic 으로 SEND 해도 그 사용자에게 전달되지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    // 연결 상대는 서로의 userId 를 알 수 있다 (ConnectionResponse.partnerUserId)
    connect(guardian.id, ward.id);
    const [g, w] = [await loginAs(guardian), await loginAs(ward)];

    const victim = await openAs(g.who, '/guardian/sos');
    const attacker = await openAs(w.who, '/ward');
    await Promise.all([waitForRealtime(victim), waitForRealtime(attacker)]);

    await attacker.evaluate(
      ({ destination, name }) => {
        const client = (window as unknown as { __connectionStompClient: { publish: (f: { destination: string; body: string }) => void } })
          .__connectionStompClient;
        client.publish({
          destination,
          body: JSON.stringify({
            type: 'SOS_TRIGGERED', wardName: name, sosEventId: `e2e-forged-${Date.now()}`,
            title: '긴급 SOS', body: `${name}님이 긴급 도움을 요청했습니다.`,
          }),
        });
      },
      { destination: `/topic/${guardian.id}/sos-triggered`, name: FORGED_NAME },
    );

    await victim.waitForTimeout(5_000);
    await expect(
      victim.locator('[aria-live="polite"]').filter({ hasText: FORGED_NAME }),
      '클라이언트가 보낸 위조 SOS 가 보호자 화면에 떴다 (서버가 SUBSCRIBE 만 검사하고 SEND 는 통과시킴)',
    ).toHaveCount(0);
  });
});

test.describe('로그아웃·계정 전환 뒤 화면에 남는 알림', () => {
  test('[XAREA-G02] 로그아웃하면 이전 사용자의 SOS 토스트가 사라지고 다음 사용자에게 보이지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const first = await tempUser('GUARDIAN');
    const second = await tempUser('GUARDIAN');
    const { who } = await loginAs(first);

    const page = await openAs(who, '/guardian');
    await expect(page.getByRole('complementary', { name: /메뉴$/ })).toBeVisible();

    await test.step('첫 번째 보호자: SOS 알림 토스트 (실제 발송 없이 화면 이벤트로 재현)', async () => {
      await page.evaluate(name => {
        window.dispatchEvent(new CustomEvent('careai:push', {
          detail: {
            data: { type: 'WARD_SOS', wardId: 'e2e000', wardName: name, sosEventId: `e2e-local-${Date.now()}` },
            notification: { title: '긴급 SOS', body: `${name}님이 긴급 도움을 요청했습니다.` },
          },
        }));
      }, FORGED_NAME);
      await expect(toast(page, '긴급 SOS')).toBeVisible();
    });

    await test.step('로그아웃하면 토스트가 사라진다', async () => {
      await logoutViaProfile(page, first.name);
      await expect.soft(page.locator('[aria-live="polite"]').filter({ hasText: FORGED_NAME }), '로그인 화면에 이전 사용자의 SOS 가 남아 있다')
        .toHaveCount(0);
    });

    await test.step('같은 브라우저로 다른 보호자가 로그인해도 보이지 않는다', async () => {
      await loginViaForm(page, second.email, second.password);
      await expect(page).toHaveURL(/\/guardian$/);
      await expect(page.locator('[aria-live="polite"]').filter({ hasText: FORGED_NAME }), '다음 사용자 화면에 이전 사용자의 SOS 가 보인다')
        .toHaveCount(0);
    });
  });
});
