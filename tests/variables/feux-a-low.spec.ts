/**
 * 변수 QA - FE UX 결함 (low, feux-a)
 *
 * FEUX-G10 생년월일 FE 검증 / G11 이름 정규화 / G14 가입 전화번호 UX / G16 비밀번호 찾기 4단계 만료
 * G18 로그인 오류 문구 / G20 복약 체크 실패 안내 / G22 푸시 토스트 상한 / G26 연결 요청 ID 형식 / G27 409 뒤 목록 갱신
 *
 * 올바른 동작을 단언하므로 결함이 있는 동안에는 실패한다.
 * 안전: 임시 사용자와 우리가 만든 가입 계정만 쓴다. 문자·메일 발송 API 는 부르지 않는다
 * (발송·검증은 route 로 가짜 응답을 주고, 가입에 필요한 인증 표식은 Redis 에 직접 넣는다).
 * 푸시 토스트는 브라우저 안의 CustomEvent 로만 만들어 서버 알림이 나가지 않는다.
 */
import { randomUUID } from 'node:crypto';

import { Page, request } from '@playwright/test';

import { ADDRESS, signupEmail } from '../../src/accounts';
import { env } from '../../src/env';
import { expect, modal, nav, test, toast } from '../../src/fixtures';
import { psql, psqlRows, redis, redisDelPattern, sqlStr } from '../../src/remote';
import { deleteTempUser, relaxRateLimits, uniqueTestPhone } from '../../src/seed';
import { connect, loginViaForm } from '../../src/variables';

const EMAIL_CHECK = '/api/auth/signup/email/check';
const VALID_PASSWORD = 'Abcdef1!';

function uniqueTag() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

interface StepOneInput {
  name?: string;
  email?: string;
  birth?: { year: string; month: string; day: string };
}

/** 가입 1단계를 채운다 (생년월일·이름은 바꿔 가며 검증할 수 있게 인자로 받는다) */
async function fillSignupStepOne(page: Page, input: StepOneInput = {}) {
  const email = input.email ?? `e2e.nobody.${uniqueTag()}@silverbridge.test`;
  await page.locator('label[for="GUARDIAN"]').click();
  await page.getByPlaceholder('홍길동').fill(input.name ?? 'E2E가입검증');
  await page.getByPlaceholder('example@email.com').fill(email);
  const checked = page.waitForResponse(r => r.url().endsWith(EMAIL_CHECK), { timeout: 20_000 }).catch(() => null);
  await page.getByPlaceholder('example@email.com').blur();
  await checked;
  await page.getByLabel('성별').selectOption('FEMALE');
  await selectBirth(page, input.birth ?? { year: '1985', month: '04', day: '15' });
  await page.getByRole('button', { name: '주소 검색' }).click();
  await expect(page.getByPlaceholder('주소 검색으로 입력하세요')).toHaveValue(ADDRESS.address);
  await page.getByPlaceholder('상세주소를 입력하세요').fill('E2E 가입동 202호');
  await page.getByPlaceholder('8자 이상').fill(VALID_PASSWORD);
  await page.getByPlaceholder('비밀번호 다시 입력').fill(VALID_PASSWORD);
  return email;
}

async function selectBirth(page: Page, birth: { year: string; month: string; day: string }) {
  const selects = page.locator('label', { hasText: '생년월일' }).locator('select');
  await selects.nth(0).selectOption(birth.year);
  await selects.nth(1).selectOption(birth.month);
  await selects.nth(2).selectOption(birth.day);
}

/** 문자 인증만 대체한다. 실제 문자는 나가지 않는다 */
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

/** 가입 2단계에서 인증을 마치고 '가입 완료' 를 한 번 누른다 */
async function completeSignup(page: Page, phone: string) {
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByPlaceholder('01012345678').fill(phone);
  await page.getByRole('button', { name: '인증번호 받기' }).click();
  await page.getByPlaceholder('6자리 입력').fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();
  await page.getByRole('button', { name: '가입 완료' }).click();
}

/** 이메일로 만든 가입 계정을 지운다 */
function deleteSignedUp(email: string) {
  for (const [id] of psqlRows(`SELECT id FROM users WHERE email = ${sqlStr(email)};`)) deleteTempUser(id);
}

/** 화면 안에서 푸시 알림(FCM 포그라운드 메시지와 같은 경로)을 흉내 낸다. 서버로는 아무것도 나가지 않는다 */
async function localPush(page: Page, data: Record<string, string>, notification: { title: string; body: string }) {
  await page.evaluate(
    detail => window.dispatchEvent(new CustomEvent('careai:push', { detail })),
    { data, notification },
  );
}

/** 임시 보호자-피보호자 사이에 PENDING 연결을 DB 로 바로 만든다 (알림이 나가지 않는다) */
function insertPendingConnection(guardianId: string, wardId: string): number {
  return Number(
    psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, relation)
          VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'PENDING', ${sqlStr(guardianId)}, '아들') RETURNING id;`),
  );
}

test.beforeEach(() => {
  relaxRateLimits();
  redisDelPattern('rate:email-check:*');
});

test.describe('회원가입 입력 검증', () => {
  test('[FEUX-G10] 생년월일이 미래이거나 만 14세 미만·120세 초과이면 가입 1단계에서 바로 막힌다', async ({ openAs }) => {
    const page = await openAs('anonymous', '/signup');
    await fillSignupStepOne(page);
    const next = page.getByRole('button', { name: '다음' });
    await expect(next, '기준선: 정상 생년월일(1985-04-15)은 통과').toBeEnabled();

    const year = new Date().getFullYear();
    const cases = [
      { birth: { year: String(year), month: '12', day: '31' }, why: `올해 아직 오지 않은 날짜(${year}-12-31)` },
      { birth: { year: String(year - 13), month: '12', day: '31' }, why: `만 14세 미만(${year - 13}-12-31)` },
      { birth: { year: '1900', month: '01', day: '01' }, why: '만 120세 초과(1900-01-01)' },
    ];
    for (const c of cases) {
      await selectBirth(page, c.birth);
      await expect
        .soft(next, `${c.why} 인데 FE 가 다음 버튼을 열어 준다 (BE 는 가입 최종 제출에서야 400 으로 거부)`)
        .toBeDisabled({ timeout: 3_000 });
    }
  });

  test('[FEUX-G11] 이름 앞뒤 공백·제로폭 문자는 정리되어 저장되고, 정확한 이름으로 아이디를 찾을 수 있다', async ({ openAs }) => {
    const email = signupEmail(`nm${uniqueTag()}`);
    const phone = uniqueTestPhone();
    const page = await openAs('anonymous', null);
    await mockSmsVerification(page, phone);
    await page.goto('/signup');

    try {
      // 앞뒤 공백 + 제로폭 공백(U+200B)이 붙은 이름
      await fillSignupStepOne(page, { email, name: ' 홍길동​ ' });
      await expect
        .soft(page.getByPlaceholder('홍길동'),
        'FE 이름 입력에 maxLength=20 이 없어 21자 이상은 마지막 단계 모달에서야 거부된다',
      )
        .toHaveAttribute('maxlength', '20');
      await expect(page.getByRole('button', { name: '다음' })).toBeEnabled();
      await completeSignup(page, phone);

      const failModal = page.getByText('회원가입 실패');
      await Promise.race([
        page.waitForURL(/\/login$/, { timeout: 20_000 }),
        failModal.first().waitFor({ timeout: 20_000 }),
      ]).catch(() => undefined);

      const rows = psqlRows(`SELECT '[' || name || ']' FROM users WHERE email = ${sqlStr(email)};`);
      if (rows.length === 0) {
        // BE 가 제로폭 문자를 거부하는 것도 허용되는 처리다 (정규화 또는 거부)
        test.info().annotations.push({ type: '가입 거부', description: '이름 정규화 대신 가입을 거부함' });
        return;
      }
      const stored = rows[0][0];
      expect.soft(
        stored,
        `가입 이름 ' 홍길동<U+200B> ' 가 정리되지 않고 그대로 저장됨: ${JSON.stringify(stored)}`,
      ).toBe('[홍길동]');

      // 공백 없는 정확한 이름으로 아이디 찾기 (조회만 하며 발송 없음)
      relaxRateLimits();
      const direct = await request.newContext({ baseURL: env.apiUrl });
      const res = await direct.post('/api/auth/find-email', { data: { name: '홍길동', phone } });
      const body = await res.text();
      await direct.dispose();
      expect(res.status(), `정확한 이름 '홍길동' 으로 아이디 찾기가 실패한다: ${body.slice(0, 150)}`).toBe(200);
    } finally {
      deleteSignedUp(email);
    }
  });

  test('[FEUX-G14] 가입 전화번호: 하이픈 붙여넣기, 발송 중 입력 잠금, 발송 오류 문구 초기화', async ({ openAs }) => {
    const page = await openAs('anonymous', null);
    let mode: 'slow' | 'error' | 'ok' = 'ok';
    await page.route('**/api/auth/signup/sms/send', async route => {
      if (mode === 'slow') await new Promise(resolve => setTimeout(resolve, 3_000));
      if (mode === 'error') {
        return route.fulfill({ status: 400, json: { success: false, message: '[E2E] 발송 오류 테스트' } });
      }
      return route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300 } } });
    });
    await page.goto('/signup');
    await fillSignupStepOne(page);
    await page.getByRole('button', { name: '다음' }).click();
    const phone = page.getByPlaceholder('01012345678');
    const send = page.getByRole('button', { name: '인증번호 받기' });
    await expect(phone).toBeVisible();

    await test.step('하이픈이 든 번호를 붙여넣어도 숫자만 남아 11자리가 된다', async () => {
      await phone.click();
      await page.keyboard.insertText('010-1234-5678');
      await expect
        .soft(phone, "maxLength=11 이 붙여넣은 '010-1234-5678' 을 '010-1234-56' 으로 먼저 잘라 9자리가 된다")
        .toHaveValue('01012345678');
      await expect.soft(send, '잘린 번호로는 인증번호 받기가 열리지 않는다').toBeEnabled();
    });

    await test.step('인증번호 발송 응답을 기다리는 동안 번호 입력이 잠긴다', async () => {
      await phone.fill('01012345678');
      mode = 'slow';
      await send.click();
      await expect(page.getByRole('button', { name: '발송 중' }), '준비 확인: 발송 요청이 진행 중').toBeVisible();
      await expect
        .soft(phone, '발송 중에도 번호를 고칠 수 있어 문자는 옛 번호로 가고 검증은 새 번호로 호출된다')
        .toBeDisabled({ timeout: 2_000 });
      // 응답이 끝나면 번호 변경으로 되돌린다
      await page.getByRole('button', { name: '번호 변경' }).click({ timeout: 10_000 });
    });

    await test.step('발송 오류 문구는 번호를 고치면 사라진다', async () => {
      mode = 'error';
      await phone.fill('01012345678');
      await send.click();
      const errorText = page.getByText('[E2E] 발송 오류 테스트');
      await expect(errorText, '준비 확인: 발송 오류 문구 표시').toBeVisible();
      await phone.fill('01012345679');
      await expect.soft(errorText, '번호를 고쳤는데 이전 발송 오류 문구가 남아 있다').toBeHidden({ timeout: 3_000 });
    });
  });
});

test.describe('비밀번호 찾기', () => {
  test('[FEUX-G16] 4단계에서 인증번호가 만료되어 실패하면 다시 요청할 수 있는 경로가 나온다', async ({ openAs }) => {
    const page = await openAs('anonymous', null);
    // 발송·검증은 가짜 응답, 재설정은 만료 오류 (BE EXPIRED_SMS_CODE 와 같은 문구)
    const expiredMessage = '인증번호가 만료되었습니다. 인증번호를 다시 요청해주세요.';
    await page.route('**/api/auth/find-password/sms/send', route =>
      route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } }),
    );
    await page.route('**/api/auth/find-password/sms/resend', route =>
      route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } }),
    );
    await page.route('**/api/auth/find-password/sms/verify', route => route.fulfill({ json: { success: true, code: 200 } }));
    await page.route('**/api/auth/password/reset', route =>
      route.fulfill({ status: 400, json: { success: false, code: 'EXPIRED_SMS_CODE', message: expiredMessage } }),
    );
    await page.goto('/find-password');

    await page.getByRole('button', { name: /SMS 인증/ }).click();
    await page.locator('input[name="name"]').fill('E2E찾기');
    await page.locator('input[name="phone"]').fill('01000019999');
    await page.getByRole('button', { name: '인증번호 발송' }).click();
    await page.locator('input[inputmode="numeric"]').fill('123456');
    await page.getByRole('button', { name: '인증 확인' }).click();
    await expect(page.locator('input[name="newPassword"]'), '준비 확인: 4단계 도달').toBeVisible();

    await page.locator('input[name="newPassword"]').fill(VALID_PASSWORD);
    await page.locator('input[name="confirmPassword"]').fill(VALID_PASSWORD);
    await page.getByRole('button', { name: '새 비밀번호 생성' }).click();
    await expect(page.getByText(expiredMessage), '준비 확인: 만료 오류 문구 표시').toBeVisible();

    // 올바른 동작: 2/3단계로 돌아가거나 4단계에 재요청 버튼이 있다 (닫기 ✕ 는 /login 이동이라 복귀 경로가 아니다)
    const recovery = page
      .getByRole('button', { name: /재요청|재발송|재전송|다시 (요청|받기|인증)|이전|처음부터|인증번호 발송|인증 확인/ })
      .first();
    await expect
      .soft(recovery, '만료 오류 문구만 반복되고 인증번호를 다시 요청하는 버튼·복귀 경로가 없다')
      .toBeVisible({ timeout: 3_000 });
  });
});

test.describe('로그인 오류 문구', () => {
  test('[FEUX-G18] IP 요청 제한(429)은 계정 잠금 문구가 아니라 BE 의 실제 사유로 안내된다', async ({ openAs }) => {
    const page = await openAs('anonymous', null);
    let response: { status: number; message: string } = {
      status: 429,
      message: '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    };
    await page.route('**/api/auth/signin', route =>
      route.fulfill({
        status: response.status,
        json: { success: false, code: response.status, message: response.message },
      }),
    );
    await page.goto('/login');
    const errorText = page.locator('p', { hasText: /.+/ }).filter({ hasText: /제한|요청이 너무|문의|입력/ });

    await test.step('429 IP 레이트리밋', async () => {
      await loginViaForm(page, 'e2e.nobody@silverbridge.test');
      await expect(errorText.first(), '준비 확인: 로그인 오류 문구 표시').toBeVisible();
      const text = (await errorText.first().innerText()).trim();
      expect
        .soft(text, `IP 제한(약 1분)인데 '계정 5회 실패 30분 잠금' 문구로 안내된다: ${text}`)
        .toContain('요청이 너무 많습니다');
      expect.soft(text, '계정 잠금(LOGIN_LOCKED)이 아닌데 30분 잠금 문구가 나온다').not.toMatch(/30분/);
    });

    await test.step('403 제한된 계정', async () => {
      response = { status: 403, message: '사용이 제한된 계정입니다. 고객센터에 문의해주세요.' };
      await page.getByRole('button', { name: '로그인', exact: true }).click();
      await expect
        .soft(page.getByText('사용이 제한된 계정입니다. 고객센터에 문의해주세요.').first(), 'BE 가 준 정지 사유 문구가 FE 고정 문구로 바뀐다')
        .toBeVisible({ timeout: 3_000 });
    });
  });
});

test.describe('피보호자 복약 체크', () => {
  test('[FEUX-G20] 복용 체크가 실패하면 카드나 화면에 실패와 재시도 안내가 표시된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    // 복용 시각을 지금과 6시간 떨어뜨려 스케줄러 알림 창에 들지 않게 한다
    const farTime = psql(`SELECT to_char((now() AT TIME ZONE 'Asia/Seoul') + interval '6 hours', 'HH24:MI:00');`);
    const insertMed = (name: string) =>
      Number(
        psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time, dose_amount)
              VALUES (${sqlStr(ward.id)}, ${sqlStr(guardian.id)}, ${sqlStr(name)}, 'MORNING', ${sqlStr(farTime)}, 1) RETURNING id;`),
      );
    const failMed = insertMed('E2E실패약');
    const deletedMed = insertMed('E2E삭제약');
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    await page.route(`**/api/ward/medication/${failMed}/intake`, route =>
      route.fulfill({ status: 403, json: { success: false, message: '본인의 약만 체크할 수 있습니다.' } }),
    );
    await page.goto('/ward/medication');
    const failCard = page.getByRole('listitem').filter({ hasText: 'E2E실패약' });
    const deletedCard = page.getByRole('listitem').filter({ hasText: 'E2E삭제약' });
    await expect(failCard).toBeVisible();
    await expect(deletedCard).toBeVisible();

    const feedback = /(체크|복용).{0,12}(실패|오류)|다시 시도/;
    const baseline = await page.locator('body').innerText();
    expect(baseline, '준비 확인: 클릭 전에는 실패 안내가 없다').not.toMatch(feedback);

    await test.step('다른 사람의 약(403) 이라 체크가 실패한다', async () => {
      const res = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/${failMed}/intake`));
      await failCard.getByRole('button', { name: '복용 체크' }).click();
      expect((await res).status()).toBe(403);
      await expect
        .soft(page.locator('body'), '체크가 실패했는데 어떤 안내도 없이 버튼이 그대로다 (onError 가 API 오류를 삼킴)')
        .toContainText(feedback, { timeout: 4_000 });
    });

    await test.step('보호자가 삭제한 약(404) 을 체크한다', async () => {
      psql(`UPDATE medication SET deleted_at = now() WHERE id = ${deletedMed};`);
      const res = page.waitForResponse(r => r.request().method() === 'POST' && r.url().includes(`/${deletedMed}/intake`));
      await deletedCard.getByRole('button', { name: '복용 체크' }).click();
      expect((await res).status(), 'BE 는 삭제된 약 체크를 404 로 거절한다').toBe(404);
      // 안내가 뜨거나 목록을 다시 불러와 삭제된 카드가 사라진다
      await expect
        .configure({ soft: true })
        .poll(async () => (await deletedCard.count()) === 0 || feedback.test(await deletedCard.innerText().catch(() => '')), {
          message: '404 인데 안내도 없고 삭제된 약 카드가 그대로 남아 반응 없는 버튼이 된다',
          timeout: 4_000,
        })
        .toBe(true);
    });
  });
});

test.describe('푸시 토스트', () => {
  test('[FEUX-G22] 자동으로 닫히지 않는 SOS·연결요청 토스트는 다른 알림 3건에 밀려나거나 취소된 뒤에도 남지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);

    await test.step('보호자: SOS 토스트가 다른 알림 3건에 밀려나지 않는다', async () => {
    const page = await openAs(g.who, '/guardian');
    await expect(nav(page, 'GUARDIAN')).toBeVisible();

    await localPush(
      page,
      { type: 'WARD_SOS', sosEventId: '9001', wardName: 'E2E테스트' },
      { title: '긴급 SOS 토스트', body: 'E2E테스트님이 긴급 도움을 요청했습니다.' },
    );
    await expect(toast(page, '긴급 SOS 토스트'), '준비 확인: SOS 토스트 표시').toBeVisible();

    for (const n of [1, 2, 3]) {
      await localPush(
        page,
        { type: 'MEDICATION_MISSED', medicationId: String(9100 + n), attempt: '1' },
        { title: `복약 확인 요청 ${n}`, body: '체크되지 않은 복약이 있습니다.' },
      );
    }
    await expect(toast(page, '복약 확인 요청 3'), '준비 확인: 마지막 알림 표시').toBeVisible();
    await expect
      .soft(toast(page, '긴급 SOS 토스트'), '토스트 상한(3개)이 가장 오래된 SOS 토스트를 확인 전에 밀어낸다')
      .toBeVisible({ timeout: 2_000 });
    });

    await test.step('피보호자: 취소되거나 이미 처리된 요청의 토스트가 닫힌다', async () => {
    const page = await openAs(w.who, '/ward');
    await expect(nav(page, 'WARD')).toBeVisible();

    // 존재하지 않는 connectionId (수락해도 아무 연결도 생기지 않는다)
    const data = { type: 'CONNECTION_REQUEST', connectionId: '987654321' };
    await localPush(page, data, { title: '연결 요청 토스트', body: '보호자가 연결을 요청했습니다.' });
    const requestToast = toast(page, '연결 요청 토스트');
    await expect(requestToast, '준비 확인: 연결 요청 토스트 표시').toBeVisible();

    await test.step('보호자의 요청 취소(CONNECTION_CANCELLED) 알림을 받는다', async () => {
      await localPush(page, { type: 'CONNECTION_CANCELLED', connectionId: '987654321' }, { title: '연결 해제', body: '연결이 해제되었습니다.' });
      await expect
        .soft(requestToast, '이미 취소된 요청인데 수락/거절 토스트가 자동으로 닫히지 않는다')
        .toBeHidden({ timeout: 3_000 });
    });

    if (await requestToast.isVisible()) {
      // 남아 있는 토스트에서 수락을 누르면 오류 후 토스트가 닫혀야 한다
      const container = page.locator('[aria-live="polite"] > div').filter({ hasText: '연결 요청 토스트' });
      const res = page.waitForResponse(r => r.request().method() === 'POST' && /connection/.test(r.url()) && /accept/.test(r.url()));
      await container.getByRole('button', { name: '수락' }).click();
      const status = (await res).status();
      expect([404, 409], `준비 확인: 존재하지 않는 요청 수락은 거절된다 (${status})`).toContain(status);
      await expect
        .soft(requestToast, `수락이 ${status} 로 실패한 뒤에도 토스트가 남아 같은 오류만 반복한다`)
        .toBeHidden({ timeout: 3_000 });
    }
    });
  });
});

test.describe('보호자 연결 요청 폼', () => {
  test('[FEUX-G26] 회원 ID 입력칸이 6자리 영숫자 형식을 안내하고 잘못된 길이·형식은 제출 전에 막는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const page = await openAs(who, '/guardian/wards?tab=register');
    const form = page.locator('form').filter({ hasText: '새 연결 요청' });
    const idInput = form.getByLabel('회원 ID');
    await expect(idInput).toBeVisible();

    const placeholder = (await idInput.getAttribute('placeholder')) ?? '';
    expect
      .soft(placeholder.trim(), `예시(${placeholder})가 실제 ID 형식(6자 영숫자, 예 aB3xY9)과 다르다`)
      .toMatch(/(^|\s)[A-Za-z0-9]{6}$/);

    await form.getByLabel('관계').selectOption('아들');
    const submit = form.getByRole('button', { name: '연결 요청' });
    // 제출 전에 막히거나, 형식 안내 문구가 보여야 한다. 실제 전송은 하지 않는다 (존재하지 않는 ID 라 알림은 없다)
    const cases = [
      { value: 'WD-2026-0188', why: '예시 형식(하이픈 12자)' },
      { value: 'ab12', why: '5자 미만 ID' },
      { value: 'abcde', why: '5자 ID' },
      { value: 'abcdefg', why: '7자 ID' },
    ];
    for (const c of cases) {
      await idInput.fill(c.value);
      const blocked = await expect(submit).toBeDisabled({ timeout: 1_500 }).then(
        () => true,
        () => false,
      );
      const hinted = (await form.getByText(/6\s*자|6자리/).count()) > 0 && !blocked;
      expect
        .soft(blocked || hinted, `${c.why} '${c.value}' 를 FE 가 막지도 안내하지도 않아 서버 400/404 로만 알게 된다`)
        .toBe(true);
    }
  });
});

test.describe('연결 관리 409 이후 목록', () => {
  test('[FEUX-G27] 이미 취소된 요청을 취소/수락해 409 가 나면 목록을 다시 불러와 오래된 행이 사라진다', async ({ tempUser, loginAs, openAs }) => {
    await test.step('보호자: 이미 취소된 요청의 [요청 취소]', async () => {
      const guardian = await tempUser('GUARDIAN');
      const ward = await tempUser('WARD');
      const connectionId = insertPendingConnection(guardian.id, ward.id);
      const { who } = await loginAs(guardian);
      const page = await openAs(who, '/guardian/wards');
      const cancel = page.getByRole('button', { name: '요청 취소' });
      await expect(cancel, '준비 확인: 수락 대기 행 표시').toBeVisible();

      // 다른 기기에서 이미 취소된 상태
      psql(`UPDATE connection SET status = 'CANCELLED' WHERE id = ${connectionId};`);
      const res = page.waitForResponse(r => r.request().method() !== 'GET' && new RegExp(`/${connectionId}(/|\\?|$)`).test(r.url()));
      await cancel.click();
      const status = (await res).status();
      expect([404, 409], `준비 확인: 이미 취소된 요청 취소는 거절된다 (${status})`).toContain(status);
      await expect
        .soft(cancel, `${status} 오류 뒤에도 목록을 갱신하지 않아 취소된 요청이 그대로 남고 같은 오류가 반복된다`)
        .toBeHidden({ timeout: 5_000 });
    });

    await test.step('피보호자: 이미 취소된 요청의 [수락]', async () => {
      const guardian = await tempUser('GUARDIAN');
      const ward = await tempUser('WARD');
      const connectionId = insertPendingConnection(guardian.id, ward.id);
      const { who } = await loginAs(ward);
      const page = await openAs(who, '/ward/guardians');
      await page.getByRole('tab', { name: '요청온 목록' }).click();
      const accept = page.getByRole('button', { name: '수락', exact: true });
      await expect(accept, '준비 확인: 요청온 목록에 수락 대기 행 표시').toBeVisible();

      psql(`UPDATE connection SET status = 'CANCELLED' WHERE id = ${connectionId};`);
      const res = page.waitForResponse(r => r.request().method() !== 'GET' && new RegExp(`/${connectionId}(/|\\?|$)`).test(r.url()));
      await accept.click();
      const status = (await res).status();
      expect([404, 409], `준비 확인: 이미 취소된 요청 수락은 거절된다 (${status})`).toContain(status);
      await modal(page, '요청 수락 실패').getByRole('button', { name: '확인' }).click();
      await expect
        .soft(accept, `${status} 오류 뒤에도 목록을 갱신하지 않아 취소된 요청의 수락 버튼이 남는다`)
        .toBeHidden({ timeout: 5_000 });
    });
  });
});
