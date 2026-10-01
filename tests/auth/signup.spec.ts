/**
 * 회원가입 전 과정 (화면 입력 → 실제 BE /api/auth/signup → 새 계정으로 로그인)
 *
 * 문자 인증만 대체한다: 인증번호 발송/확인 API 응답을 가짜로 주고, BE 가 가입 때 확인하는
 * Redis 인증 표식(sms:verified:{phone})을 미리 넣어 둔다. 그래서 실제 문자는 나가지 않지만
 * 가입 API 는 실제 서버 검증(이메일·전화 중복, 비밀번호 규칙, 나이 등)을 그대로 통과해야 한다.
 */
import { randomUUID } from 'node:crypto';

import { Page } from '@playwright/test';

import { ACCOUNTS, ADDRESS, signupEmail } from '../../src/accounts';
import { env } from '../../src/env';
import { expect, test } from '../../src/fixtures';
import { psqlRows, redis, sqlStr } from '../../src/remote';
import { relaxRateLimits, uniqueTestPhone } from '../../src/seed';

async function mockSmsVerification(page: Page, phone: string) {
  const nonce = randomUUID();
  redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');
  await page.route('**/api/auth/signup/sms/send', route =>
    route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300 } } }),
  );
  await page.route('**/api/auth/signup/sms/verify', route =>
    route.fulfill({ json: { success: true, data: { verificationNonce: nonce } } }),
  );
}

async function fillBasicInfo(page: Page, input: { role: 'WARD' | 'GUARDIAN'; name: string; email: string }) {
  await page.locator(`label[for="${input.role}"]`).click();
  await page.getByPlaceholder('홍길동').fill(input.name);
  await page.getByPlaceholder('example@email.com').fill(input.email);
  await page.getByPlaceholder('example@email.com').blur(); // 이메일 중복 확인은 blur 때 실행
  await page.getByPlaceholder('8자 이상').fill(env.password);
  await page.getByPlaceholder('비밀번호 다시 입력').fill(env.password);
  await page.getByLabel('성별').selectOption('FEMALE');
  const birth = page.locator('label', { hasText: '생년월일' }).locator('select');
  await birth.nth(0).selectOption('1985');
  await birth.nth(1).selectOption('04');
  // 일(day) 목록은 연·월을 고른 뒤 다시 그려지므로, 옵션이 생길 때까지 기다린다
  await expect(birth.nth(2).locator('option[value="15"]')).toHaveCount(1);
  await birth.nth(2).selectOption('15');
  await page.getByRole('button', { name: '주소 검색' }).click();
  await expect(page.getByPlaceholder('주소 검색으로 입력하세요')).toHaveValue(ADDRESS.address);
  await page.getByPlaceholder('상세주소를 입력하세요').fill('E2E 가입동 202호');
}

test.beforeEach(() => relaxRateLimits());

test.describe('회원가입', () => {
  test('보호자로 가입하고, 새 계정으로 로그인해 보호자 화면을 쓸 수 있다', async ({ openAs, apiAs }) => {
    const email = signupEmail(Date.now().toString(36));
    const phone = uniqueTestPhone();
    const page = await openAs('anonymous', null);
    await mockSmsVerification(page, phone);
    await page.goto('/signup');

    await test.step('1단계: 기본 정보', async () => {
      await expect(page.getByRole('button', { name: '다음' })).toBeDisabled();
      await fillBasicInfo(page, { role: 'GUARDIAN', name: 'E2E가입보호자', email });
      await expect(page.getByRole('button', { name: '다음' })).toBeEnabled();
      await page.getByRole('button', { name: '다음' }).click();
    });

    await test.step('2단계: 전화번호 인증 (문자 발송만 대체)', async () => {
      await page.getByPlaceholder('01012345678').fill(phone);
      await page.getByRole('button', { name: '인증번호 받기' }).click();
      await page.getByPlaceholder('6자리 입력').fill('123456');
      await page.getByRole('button', { name: '확인', exact: true }).click();
      await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();
      await page.getByRole('button', { name: '가입 완료' }).click();
      await expect(page).toHaveURL(/\/login$/);
    });

    const [[userId, role, gender, birthDate, address]] = psqlRows(
      `SELECT id, role, gender, birth_date, address FROM users WHERE email = ${sqlStr(email)};`,
    );
    await test.step('서버: 입력한 정보 그대로 저장됐다', async () => {
      expect({ role, gender, birthDate, address }).toEqual({
        role: 'GUARDIAN', gender: 'FEMALE', birthDate: '1985-04-15', address: ADDRESS.address,
      });
    });

    await test.step('새 계정으로 로그인', async () => {
      await page.locator('input[name="email"]').fill(email);
      await page.locator('input[name="password"]').fill(env.password);
      await page.getByRole('button', { name: '로그인', exact: true }).click();
      await expect(page).toHaveURL(/\/guardian$/);
      await expect(page.getByRole('button', { name: /E2E가입보호자/ })).toContainText(userId);
    });

    // 정리: 다음 실행의 seed 도 지우지만 바로 탈퇴 처리 (관리자 강제 탈퇴 경로도 함께 검증)
    const admin = await apiAs('admin');
    await admin.call('DELETE', `/api/admin/user/${userId}`);
  });

  test('이미 가입된 이메일은 1단계에서 막힌다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/signup');
    await page.getByPlaceholder('example@email.com').fill(ACCOUNTS.guardian1.email);
    await page.getByPlaceholder('example@email.com').blur();
    await expect(page.getByText('이미 사용 중인 이메일입니다.')).toBeVisible();
  });

  test('비밀번호 규칙과 확인 불일치를 안내한다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/signup');
    await page.getByPlaceholder('8자 이상').fill('short');
    await page.getByPlaceholder('비밀번호 다시 입력').fill('different');
    await page.getByPlaceholder('홍길동').click();
    await expect(page.getByRole('alert')).not.toHaveCount(0);
    await expect(page.getByRole('button', { name: '다음' })).toBeDisabled();
  });

  test('이미 가입된 전화번호로는 인증번호를 받을 수 없다 (실제 발송 전 차단)', async ({ openAs }) => {
    const page = await openAs('anonymous', '/signup');
    await fillBasicInfo(page, { role: 'WARD', name: 'E2E중복번호', email: signupEmail(`dup${Date.now().toString(36)}`) });
    await page.getByRole('button', { name: '다음' }).click();
    // 이미 가입된 번호는 BE 가 문자를 보내지 않고 409 를 준다 → 실제 문자 없음
    await page.getByPlaceholder('01012345678').fill(ACCOUNTS.ward1.phone);
    await page.getByRole('button', { name: '인증번호 받기' }).click();
    await expect(page.getByText('이미 사용 중인 전화번호입니다.')).toBeVisible();
    await expect(page.getByPlaceholder('6자리 입력')).toHaveCount(0);
  });
});
