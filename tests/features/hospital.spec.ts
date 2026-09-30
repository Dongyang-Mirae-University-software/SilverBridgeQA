/**
 * 병원 예약 (FE BFF → 예약 서비스 reservation.dmu.gosky.kr)
 * 실제로 예약을 만들고 바로 취소한다.
 */
import { ACCOUNTS } from '../../src/accounts';
import { Api } from '../../src/api';
import { env } from '../../src/env';
import { acceptNextConfirm, expect, expectPageTitle, test } from '../../src/fixtures';
import { createTempUser, deleteTempUser } from '../../src/seed';

test.describe('병원 예약', () => {
  test('병원을 골라 내일 예약하고, 예약 내역에서 취소한다', async ({ openAs }) => {
    const symptom = `E2E 테스트 예약 ${Date.now().toString(36)}`;
    const page = await openAs('guardian1', '/guardian/hospital');
    await expectPageTitle(page, '병원 예약하기');
    await expect(page.getByText(`${ACCOUNTS.ward1.name} 님의 예약`)).toBeVisible();

    await test.step('병원 선택', async () => {
      const hospitals = page.locator('ul li button:not([disabled])');
      await expect(hospitals.first()).toBeVisible();
      await hospitals.first().click();
      await expect(page.getByRole('button', { name: `${ACCOUNTS.ward1.name} 님 예약하기` })).toBeVisible();
    });

    await test.step('내일 날짜의 첫 빈 시간 선택', async () => {
      const tomorrow = await page.evaluate(() => {
        const d = new Date(Date.now() + 24 * 3600 * 1000);
        return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
      });
      await page.locator('input[type="date"]').fill(tomorrow);
      const slot = page.getByRole('button', { name: /^\d{2}:\d{2}$/ }).first();
      await expect(slot).toBeVisible();
      await slot.click();
      await expect(page.locator('input[type="tel"]')).toHaveValue(ACCOUNTS.ward1.phone);
      await page.locator('textarea').fill(symptom);
    });

    await test.step('예약하기', async () => {
      await page.getByRole('button', { name: `${ACCOUNTS.ward1.name} 님 예약하기` }).click();
      await expect(page.getByText('예약이 완료되었습니다.')).toBeVisible();
      await expect(page.getByRole('tab', { name: '예약 내역', selected: true })).toBeVisible();
    });

    await test.step('예약 내역에서 취소', async () => {
      const item = page.locator('li').filter({ hasText: symptom });
      await expect(item).toBeVisible();
      acceptNextConfirm(page, /예약을 취소할까요/);
      await item.getByRole('button', { name: '취소' }).click();
      await expect(page.getByText('예약이 취소되었습니다.')).toBeVisible();
      await expect(item.getByRole('button', { name: '취소' })).toHaveCount(0);
    });
  });

  test('연결된 피보호자가 없으면 먼저 연결하라고 안내한다', async ({ openAs }) => {
    const page = await openAs('guardian3', '/guardian/hospital');
    await expect(page.getByText('연결된 피보호자가 없습니다. 먼저 피보호자를 연결해주세요.')).toBeVisible();
  });

  test('처음 쓰는 보호자가 병원 예약 화면을 열어도 오류가 나지 않는다', async ({ openAs, apiAs }) => {
    test.info().annotations.push({
      type: 'issue',
      description:
        'FE BFF(src/app/api/reservation/[...path]/route.ts)가 예약 서비스 계정을 첫 요청 때 만든다. 화면이 /hospitals 와 /reservations/my 를 동시에 부르면 ' +
        '둘 다 가입을 시도하고 한쪽이 이메일 중복(Prisma P2002)으로 실패 → 502. 사용자는 첫 방문 때 예약 내역 오류를 본다.',
    });
    // 예약 서비스에 계정이 없는 "처음 쓰는" 보호자가 필요해서 매번 새 id 로 만든다
    const user = createTempUser('GUARDIAN', 'E2E첫방문보호자');
    try {
      const admin = await apiAs('admin');
      await admin.post('/api/admin/connection', { guardianId: user.id, wardId: ACCOUNTS.ward1.id });
      const login = await Api.signin(user.email, env.password);

      const page = await openAs({ label: 'temp-guardian', login }, '/guardian/hospital');
      await expectPageTitle(page, '병원 예약하기');
      await page.getByRole('tab', { name: '예약 내역' }).click();
      await expect(page.getByText('예약 내역이 없습니다.')).toBeVisible();
      // /api 5xx 는 fixtures 의 PageWatcher 가 잡아서 실패시킨다
    } finally {
      deleteTempUser(user.id);
    }
  });
});
