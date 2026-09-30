/**
 * 보호자 ↔ 피보호자 연결.
 * 보호자와 피보호자 브라우저를 동시에 띄워서, 한쪽의 행동이 다른 쪽 화면에 실시간으로 반영되는지까지 본다.
 *
 * 사용 계정: guardian2 ↔ ward2(수락·해제), ward3(거절·취소)
 */
import { Page } from '@playwright/test';

import { ACCOUNTS } from '../../src/accounts';
import {
  acceptNextConfirm, expect, expectPageTitle, modal, test, toast, waitForRealtime,
} from '../../src/fixtures';
import { psql, sqlStr } from '../../src/remote';

const G2 = ACCOUNTS.guardian2;
const W2 = ACCOUNTS.ward2;
const W3 = ACCOUNTS.ward3;

/** 연결 카드 (카드 안에도 li 가 있어서 data-role 로 카드만 고른다) */
function card(page: Page, partnerName: string) {
  return page.locator('li[data-role]').filter({ hasText: partnerName });
}

async function requestConnection(guardian: Page, wardId: string, relation: string) {
  await guardian.getByRole('tab', { name: '피보호자 등록' }).click();
  await guardian.getByLabel('회원 ID').fill(wardId);
  await guardian.getByLabel('관계').selectOption(relation);
  await guardian.getByRole('button', { name: '연결 요청', exact: true }).click();
}

/** 앞선 테스트가 남긴 연결을 지워서 테스트끼리 독립적으로 만든다 */
function clearConnections(guardianId: string, wardIds: string[]) {
  psql(`DELETE FROM connection WHERE guardian_id = ${sqlStr(guardianId)}
        AND ward_id IN (${wardIds.map(sqlStr).join(', ')});`);
}

test.describe('연결 요청과 수락', () => {
  test.beforeEach(() => clearConnections(G2.id, [W2.id, W3.id]));

  test('보호자가 요청하면 피보호자에게 실시간 알림이 오고, 수락하면 양쪽에 연결됨으로 보인다', async ({ openAs }) => {
    const ward = await openAs('ward2', '/ward/guardians');
    const guardian = await openAs('guardian2', '/guardian/wards');
    await expectPageTitle(ward, '내 보호자');
    await expectPageTitle(guardian, '피보호자 관리');
    await Promise.all([waitForRealtime(ward), waitForRealtime(guardian)]);

    await test.step('보호자: 회원 ID 로 연결 요청', async () => {
      await requestConnection(guardian, W2.id, '딸');
      await expect(guardian.getByText('피보호자에게 연결 요청을 보냈습니다.')).toBeVisible();
    });

    await test.step('피보호자: 연결 요청 알림이 실시간으로 뜬다', async () => {
      await expect(toast(ward, '연결 요청')).toBeVisible();
    });

    await test.step('피보호자: 요청온 목록에서 수락', async () => {
      await ward.getByRole('tab', { name: '요청온 목록' }).click();
      const request = card(ward, G2.name);
      await expect(request).toContainText('수락 대기');
      await expect(request).toContainText('딸');
      await request.getByRole('button', { name: '수락', exact: true }).click();
      await expect(modal(ward, '요청 수락 완료')).toBeVisible();
      await modal(ward, '요청 수락 완료').getByRole('button', { name: '확인' }).click();
      await expect(ward.getByText('수락 또는 거절하지 않은 연결 요청이 없습니다.')).toBeVisible();
    });

    await test.step('보호자: 수락 알림이 실시간으로 뜨고 목록이 연결됨으로 바뀐다', async () => {
      await expect(toast(guardian, '연결 수락')).toBeVisible();
      await guardian.getByRole('tab', { name: '피보호자 목록' }).click();
      const connected = card(guardian, W2.name);
      await expect(connected).toContainText('연결됨');
      // 연결 후에는 상대 정보가 공개된다
      await expect(connected).not.toContainText('연결 후 공개');
      await expect(connected).toContainText('여성');
      await expect(connected).toContainText(W2.birthDate);
    });

    await test.step('피보호자: 내 보호자 리스트에 보호자가 보인다', async () => {
      await ward.getByRole('tab', { name: '내 보호자 리스트' }).click();
      await expect(card(ward, G2.name)).toContainText('연결됨');
    });
  });

  test('피보호자가 알림 토스트의 거절 버튼으로 거절하면 보호자 종료 이력에 거절됨으로 남는다', async ({ openAs }) => {
    const ward = await openAs('ward3', '/ward');
    const guardian = await openAs('guardian2', '/guardian/wards');
    await Promise.all([waitForRealtime(ward), waitForRealtime(guardian)]);

    await requestConnection(guardian, W3.id, '아들');
    await expect(guardian.getByText('피보호자에게 연결 요청을 보냈습니다.')).toBeVisible();

    const requestToast = ward.locator('[aria-live="polite"]').filter({ hasText: '연결 요청' });
    await requestToast.getByRole('button', { name: '거절', exact: true }).click();
    await expect(requestToast).toHaveCount(0);

    await expect(toast(guardian, '연결 거절')).toBeVisible();
    await guardian.getByRole('tab', { name: '종료 이력' }).click();
    await expect(card(guardian, W3.name).first()).toContainText('거절됨');
  });

  test('보호자가 요청을 취소한 뒤 피보호자가 남아 있던 요청을 수락하면 오류로 안내하고, 새로고침하면 사라진다', async ({ openAs }) => {
    // BE 정책(2026-05-28 feature-connection-refused-notification.md §4): 보호자 요청 취소는 "무알림"이 의도된 설계.
    // 그래서 피보호자 화면에는 취소된 요청이 남아 있을 수 있고, 그걸 눌렀을 때 제대로 안내하는지를 본다.
    const ward = await openAs('ward3', '/ward/guardians');
    const guardian = await openAs('guardian2', '/guardian/wards');
    await Promise.all([waitForRealtime(ward), waitForRealtime(guardian)]);

    await requestConnection(guardian, W3.id, '손자녀');
    await ward.getByRole('tab', { name: '요청온 목록' }).click();
    await expect(card(ward, G2.name)).toBeVisible();

    await guardian.getByRole('tab', { name: '피보호자 목록' }).click();
    const pending = card(guardian, W3.name);
    await expect(pending).toContainText('수락 대기');
    await pending.getByRole('button', { name: '요청 취소' }).click();
    await expect(guardian.getByText('연결 요청을 취소했습니다.')).toBeVisible();
    await expect(card(guardian, W3.name)).toHaveCount(0);

    await card(ward, G2.name).getByRole('button', { name: '수락', exact: true }).click();
    await expect(modal(ward, '요청 수락 실패')).toContainText('수락 대기 중인 연결 관계가 아닙니다.');
    await modal(ward, '요청 수락 실패').getByRole('button', { name: '확인' }).click();

    await ward.reload();
    await ward.getByRole('tab', { name: '요청온 목록' }).click();
    await expect(ward.getByText('수락 또는 거절하지 않은 연결 요청이 없습니다.')).toBeVisible();
  });

  test('없는 회원 ID 나 보호자 ID 로는 요청할 수 없다', async ({ openAs }) => {
    const guardian = await openAs('guardian2', '/guardian/wards?tab=register');

    await requestConnection(guardian, 'zz9999', '딸');
    await expect(guardian.getByText('사용자를 찾을 수 없습니다.')).toBeVisible();

    await requestConnection(guardian, ACCOUNTS.guardian1.id, '딸');
    await expect(guardian.getByText('보호자와 피보호자 역할이 맞지 않습니다.')).toBeVisible();
  });

  test('이미 연결된 피보호자에게 다시 요청하면 거부된다', async ({ openAs }) => {
    // guardian1-ward1 은 global.setup 이 만든 기본 연결
    const guardian = await openAs('guardian1', '/guardian/wards?tab=register');
    await requestConnection(guardian, ACCOUNTS.ward1.id, '아들');
    await expect(guardian.getByText('이미 연결되어 있거나 요청 중인 관계입니다.')).toBeVisible();
  });
});

test.describe('연결 해제', () => {
  test.beforeEach(async ({ apiAs }) => {
    clearConnections(G2.id, [W2.id]);
    const admin = await apiAs('admin');
    await admin.post('/api/admin/connection', { guardianId: G2.id, wardId: W2.id });
  });

  test('보호자가 연결을 해제하면 종료 이력으로 옮겨지고 피보호자 목록에서도 빠진다', async ({ openAs }) => {
    const ward = await openAs('ward2', '/ward/guardians');
    const guardian = await openAs('guardian2', '/guardian/wards');
    await expect(card(ward, G2.name)).toContainText('연결됨');

    acceptNextConfirm(guardian, /연결을 해제할까요/);
    await card(guardian, W2.name).getByRole('button', { name: '연결 해제' }).click();
    await expect(guardian.getByText('연결을 해제했습니다.')).toBeVisible();
    await expect(card(guardian, W2.name)).toHaveCount(0);

    await guardian.getByRole('tab', { name: '종료 이력' }).click();
    await expect(card(guardian, W2.name).first()).toContainText('연결 해제됨');

    await ward.reload();
    await expect(ward.getByText('연결된 보호자가 없습니다.')).toBeVisible();
  });

  test('보호자가 해제 확인창에서 취소하면 연결이 유지된다', async ({ openAs }) => {
    const guardian = await openAs('guardian2', '/guardian/wards');
    guardian.once('dialog', dialog => dialog.dismiss());
    await card(guardian, W2.name).getByRole('button', { name: '연결 해제' }).click();
    await expect(card(guardian, W2.name)).toContainText('연결됨');
  });

  test('피보호자가 확인 모달을 거쳐 연결을 해제한다', async ({ openAs }) => {
    const ward = await openAs('ward2', '/ward/guardians');
    const guardian = await openAs('guardian2', '/guardian/wards');

    await card(ward, G2.name).getByRole('button', { name: '연결 해제' }).click();
    await modal(ward, '보호자 연결 해제').getByRole('button', { name: '해제', exact: true }).click();
    await expect(modal(ward, '연결 해제 완료')).toBeVisible();
    await modal(ward, '연결 해제 완료').getByRole('button', { name: '확인' }).click();
    await expect(ward.getByText('연결된 보호자가 없습니다.')).toBeVisible();

    await guardian.reload();
    await expect(card(guardian, W2.name)).toHaveCount(0);
  });
});
