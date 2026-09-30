/**
 * 피보호자 기본 설정 (글자 크기, 고대비, SOS 동작) - 어르신 사용성·접근성
 */
import { expect, expectPageTitle, test } from '../../src/fixtures';

test.describe('피보호자 화면 설정', () => {
  test('글자 크기를 키우면 화면 전체 글자가 커지고, 다시 들어와도 유지된다', async ({ openAs }) => {
    const page = await openAs('ward2', '/ward/settings');
    await expectPageTitle(page, '환경설정');
    const rootFontSize = () => page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    const before = await rootFontSize();

    const slider = page.getByRole('slider', { name: '화면 글자 크기' });
    await slider.fill('24');
    await expect(page.getByText('24px', { exact: true })).toBeVisible();
    await expect.poll(rootFontSize).toBe('24px');
    expect(before).not.toBe('24px');

    await page.goto('/ward/medication');
    await expectPageTitle(page, '복약 알림');
    await expect.poll(rootFontSize).toBe('24px');

    await page.goto('/ward/settings');
    await page.getByRole('slider', { name: '화면 글자 크기' }).fill('17');
  });

  test('고대비 모드를 켜고 끌 수 있다', async ({ openAs }) => {
    const page = await openAs('ward2', '/ward/settings');
    const toggle = page.getByRole('checkbox', { name: '고대비 모드' });
    await expect(toggle).not.toBeChecked();
    await page.getByLabel('고대비 모드').click();
    await expect(toggle).toBeChecked();
    await expect(page.getByText('고대비 모드가 켜져 있습니다.')).toBeVisible();
    await page.getByLabel('고대비 모드').click();
    await expect(page.getByText('일반 모드입니다.', { exact: false })).toBeVisible();
  });

  test('SOS 동작 설정은 키보드·스크린리더로도 선택할 수 있다 (라디오 버튼 접근성)', async ({ openAs }) => {
    test.info().annotations.push({
      type: 'issue',
      description: '.sosCard input { display: none } 때문에 라디오가 접근성 트리·탭 순서에서 빠짐 (WardBasicSettingsSection.module.css:243)',
    });
    const page = await openAs('ward2', '/ward/settings');
    const group = page.getByRole('radiogroup', { name: 'SOS 동작 설정' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio')).toHaveCount(3, { timeout: 3_000 });
  });
});
