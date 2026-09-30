/**
 * 복약: 보호자가 약을 등록·수정·삭제하고, 피보호자가 복용 체크하면 보호자 화면에 실시간 반영.
 * 사용 계정: guardian1 ↔ ward1 (global.setup 의 기본 연결)
 */
import { Page } from '@playwright/test';

import { ACCOUNTS } from '../../src/accounts';
import { acceptNextConfirm, expect, expectPageTitle, test, waitForRealtime } from '../../src/fixtures';

const W1 = ACCOUNTS.ward1;

function stamp() {
  return Date.now().toString(36).slice(-5);
}

/** 보호자 복약 화면에서 피보호자 카드 (카드 li 안에 약 li 가 또 있어서 회원 ID 로 고른다) */
function wardCard(page: Page) {
  return page.locator('li').filter({ has: page.getByText(W1.id, { exact: true }) }).first();
}

/** 보호자 화면의 약 한 줄 */
function guardianItem(page: Page, name: string) {
  return page.locator('li').filter({ has: page.getByRole('button', { name: `${name} 삭제` }) }).last();
}

/** 피보호자 화면의 약 카드 */
function wardItem(page: Page, name: string) {
  return page.locator('li').filter({ hasText: name }).last();
}

async function addMedication(guardian: Page, name: string) {
  await wardCard(guardian).getByRole('button', { name: '+ 약 추가' }).click();
  const dialog = guardian.getByRole('dialog', { name: '약 추가' });
  await dialog.getByRole('textbox', { name: '약 이름' }).fill(name);
  await dialog.getByRole('combobox', { name: '시간대' }).selectOption('DINNER');
  await dialog.getByRole('textbox', { name: /^복용 시각/ }).fill('19:30');
  await dialog.getByRole('spinbutton', { name: '용량(정)' }).fill('2');
  await dialog.getByRole('textbox', { name: '메모' }).fill('식후 30분');
  await dialog.getByRole('button', { name: '추가', exact: true }).click();
  await expect(dialog).toBeHidden();
}

test.describe('복약 관리', () => {
  test('보호자가 약을 등록하면 피보호자 오늘 일정에 보이고, 복용 체크가 보호자 화면에 실시간 반영된다', async ({ openAs }) => {
    const name = `E2E혈압약-${stamp()}`;
    const guardian = await openAs('guardian1', '/guardian/medication');
    const ward = await openAs('ward1', '/ward/medication');
    await expectPageTitle(guardian, '복약 관리');
    await expectPageTitle(ward, '복약 알림');
    await Promise.all([waitForRealtime(guardian), waitForRealtime(ward)]);

    await test.step('보호자: 약 추가', async () => {
      await addMedication(guardian, name);
      const item = guardianItem(guardian, name);
      await expect(item).toContainText('미복용');
      await expect(item).toContainText('저녁');
    });

    await test.step('피보호자: 새로고침하면 오늘 일정에 보인다', async () => {
      await ward.getByRole('button', { name: '새로고침' }).click();
      const item = wardItem(ward, name);
      await expect(item).toContainText('저녁');
      await expect(item).toContainText('2정 · 식후 30분');
      await expect(item.getByRole('button', { name: '복용 체크' })).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('피보호자: 복용 체크', async () => {
      const before = await ward.getByText(/\d+\/\d+회 완료/).textContent();
      await wardItem(ward, name).getByRole('button', { name: '복용 체크' }).click();
      await expect(wardItem(ward, name).getByRole('button', { name: '체크됨' })).toHaveAttribute('aria-pressed', 'true');
      await expect(wardItem(ward, name)).toContainText('복용 체크');
      await expect(ward.getByText(/\d+\/\d+회 완료/)).not.toHaveText(before ?? '');
    });

    await test.step('보호자: 새로고침 없이 복용함으로 바뀐다 (실시간)', async () => {
      await expect(guardianItem(guardian, name)).toContainText('복용함');
    });

    await test.step('피보호자: 체크 해제하면 보호자 화면도 미복용으로 돌아간다', async () => {
      await wardItem(ward, name).getByRole('button', { name: '체크됨' }).click();
      await expect(wardItem(ward, name).getByRole('button', { name: '복용 체크' })).toHaveAttribute('aria-pressed', 'false');
      await expect(guardianItem(guardian, name)).toContainText('미복용');
    });
  });

  test('보호자가 약 이름을 수정하고 삭제할 수 있다', async ({ openAs }) => {
    const name = `E2E수정전-${stamp()}`;
    const renamed = `E2E수정후-${stamp()}`;
    const guardian = await openAs('guardian1', '/guardian/medication');
    await addMedication(guardian, name);

    await guardian.getByRole('button', { name: new RegExp(`^${name} 저녁`) }).click();
    const dialog = guardian.getByRole('dialog', { name: '약 수정' });
    await expect(dialog.getByRole('textbox', { name: '약 이름' })).toHaveValue(name);
    await expect(dialog.getByRole('textbox', { name: /^복용 시각/ })).toHaveValue('19:30');
    await dialog.getByRole('textbox', { name: '약 이름' }).fill(renamed);
    await dialog.getByRole('button', { name: '수정', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(guardianItem(guardian, renamed)).toBeVisible();
    await expect(guardian.getByRole('button', { name: `${name} 삭제` })).toHaveCount(0);

    await guardian.reload();
    await expect(guardianItem(guardian, renamed)).toBeVisible();

    acceptNextConfirm(guardian, /일정을 삭제할까요/);
    await guardian.getByRole('button', { name: `${renamed} 삭제` }).click();
    await expect(guardian.getByRole('button', { name: `${renamed} 삭제` })).toHaveCount(0);

    const ward = await openAs('ward1', '/ward/medication');
    await expectPageTitle(ward, '복약 알림');
    await expect(ward.getByText(renamed)).toHaveCount(0);
  });

  test('약 삭제 확인창에서 취소하면 그대로 남는다', async ({ openAs }) => {
    const name = `E2E취소-${stamp()}`;
    const guardian = await openAs('guardian1', '/guardian/medication');
    await addMedication(guardian, name);

    guardian.once('dialog', dialog => dialog.dismiss());
    await guardian.getByRole('button', { name: `${name} 삭제` }).click();
    await expect(guardianItem(guardian, name)).toBeVisible();
  });

  test('약 이름을 비우면 추가 버튼이 비활성화된다', async ({ openAs }) => {
    const guardian = await openAs('guardian1', '/guardian/medication');
    await wardCard(guardian).getByRole('button', { name: '+ 약 추가' }).click();
    const dialog = guardian.getByRole('dialog', { name: '약 추가' });
    await expect(dialog.getByRole('button', { name: '추가', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: '약 이름' }).fill('   ');
    await expect(dialog.getByRole('button', { name: '추가', exact: true })).toBeDisabled();
    await dialog.getByRole('button', { name: '취소' }).click();
    await expect(dialog).toBeHidden();
  });

  test('복약 알림 설정(알림 켜기/끄기, 미복약 알림 시각)이 저장된다', async ({ openAs }) => {
    const guardian = await openAs('guardian1', '/guardian/medication');
    await addMedication(guardian, `E2E설정-${stamp()}`);
    const card = wardCard(guardian);

    const alarm = card.getByText(/^알림 (켜짐|꺼짐)$/);
    const initial = await alarm.textContent();
    await alarm.click();
    await expect(alarm).not.toHaveText(initial ?? '');
    await guardian.reload();
    await expect(wardCard(guardian).getByText(/^알림 (켜짐|꺼짐)$/)).not.toHaveText(initial ?? '');

    // 원래대로 (알림이 켜져 있어야 미복약 알림 설정이 보인다)
    if ((await wardCard(guardian).getByText(/^알림 (켜짐|꺼짐)$/).textContent()) === '알림 꺼짐') {
      await wardCard(guardian).getByText('알림 꺼짐').click();
      await expect(wardCard(guardian).getByText('알림 켜짐')).toBeVisible();
    }

    const time = wardCard(guardian).locator('input[type="time"]');
    await time.fill('20:15');
    await expect(wardCard(guardian).getByText('오후 8:15에 발송')).toBeVisible();
    await guardian.reload();
    await expect(wardCard(guardian).locator('input[type="time"]')).toHaveValue('20:15');
  });

  test('피보호자 화면에는 약을 추가·삭제하는 기능이 없다', async ({ openAs }) => {
    const ward = await openAs('ward1', '/ward/medication');
    await expectPageTitle(ward, '복약 알림');
    await expect(ward.getByRole('button', { name: /약 추가/ })).toHaveCount(0);
    await expect(ward.getByRole('button', { name: / 삭제$/ })).toHaveCount(0);
  });
});
