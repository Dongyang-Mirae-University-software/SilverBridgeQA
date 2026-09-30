/**
 * 스모크: 모든 메뉴 화면이 역할별로 열리는지.
 * 사이드바 메뉴를 실제로 눌러 이동하고, 제목이 보이고, JS 예외·API 5xx 가 없는지 본다.
 */
import { expect, expectPageTitle, nav, test } from '../../src/fixtures';

const GUARDIAN_MENUS: [menu: string, path: string, title: string | null][] = [
  ['SOS 이력', '/guardian/sos', 'SOS 이력'],
  ['이상감지', '/guardian/detection', '이상감지'],
  ['정서 상태 체크', '/guardian/emotion', '정서 상태 체크'],
  ['AI 의료 챗봇', '/guardian/chatbot', 'AI 의료 챗봇'],
  ['피보호자 관리', '/guardian/wards', '피보호자 관리'],
  ['복약 관리', '/guardian/medication', '복약 관리'],
  ['병원 예약', '/guardian/hospital', '병원 예약하기'],
  ['화면 송출', '/guardian/stream', '화면 송출'],
  ['공지사항', '/guardian/notices', '공지사항'],
  ['문의하기', '/guardian/inquiries', '문의하기'],
  ['환경설정', '/guardian/settings', '환경설정'],
  ['대시보드', '/guardian', null],
];

const WARD_MENUS: [menu: string, path: string, title: string | null][] = [
  ['긴급 전화', '/ward/sos', null],
  ['복약 알림', '/ward/medication', '복약 알림'],
  ['내 보호자', '/ward/guardians', '내 보호자'],
  ['공지사항', '/ward/notices', '공지사항'],
  ['환경설정', '/ward/settings', '환경설정'],
  ['홈', '/ward', null],
];

test.describe('보호자 메뉴 @smoke', () => {
  test('보호자 로그인 상태로 모든 메뉴가 열린다', async ({ openAs }) => {
    const page = await openAs('guardian1', '/guardian');
    await expect(nav(page, 'GUARDIAN')).toBeVisible();

    for (const [menu, path, title] of GUARDIAN_MENUS) {
      await test.step(menu, async () => {
        await nav(page, 'GUARDIAN').getByRole('link', { name: menu, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        if (title) await expectPageTitle(page, title);
      });
    }
  });

  test('대시보드에 연결된 피보호자가 보인다', async ({ openAs }) => {
    const page = await openAs('guardian1', '/guardian');
    await expect(page.getByRole('region', { name: '피보호자 목록' })).toContainText('E2E피보호자1');
  });
});

test.describe('피보호자 메뉴 @smoke', () => {
  test('피보호자 로그인 상태로 모든 메뉴가 열린다', async ({ openAs }) => {
    const page = await openAs('ward1', '/ward');
    await expect(nav(page, 'WARD')).toBeVisible();

    for (const [menu, path, title] of WARD_MENUS) {
      await test.step(menu, async () => {
        await nav(page, 'WARD').getByRole('link', { name: menu, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`${path}$`));
        if (title) await expectPageTitle(page, title);
      });
    }
  });

  test('홈 카드에서 긴급 전화 화면으로 간다', async ({ openAs }) => {
    const page = await openAs('ward1', '/ward');
    await page.getByRole('main').getByRole('link', { name: /긴급 전화/ }).click();
    await expect(page).toHaveURL(/\/ward\/sos$/);
    await expect(page.getByRole('button', { name: /긴급 SOS/ })).toBeVisible();
  });
});

test.describe('사이드바 사용자 카드 @smoke', () => {
  test('보호자 이름과 회원 ID 가 표시된다', async ({ openAs }) => {
    const page = await openAs('guardian1', '/guardian/notices');
    const card = page.getByRole('complementary', { name: '보호자 메뉴' }).getByRole('button', { name: /E2E보호자1/ });
    await expect(card).toContainText('e2eg01');
  });
});
