/**
 * 최종 QA - 인증(AUTH) P1b - 일반 회원가입 (A01 A03 A04 A10 N01 N02)
 *
 * 임시 사용자와 이 묶음이 만든 가입 계정(e2e.p1b.* 이메일)만 쓴다. 정리는 정확한 이메일로만 지운다.
 * 문자는 N01 에서만 실제로 1건 보낸다(임시 번호 대역 010-0000-9xxx). 나머지는 인증 표식을 Redis 에 직접 넣는다.
 */
import { randomUUID } from 'node:crypto';

import { env } from '../../../src/env';
import { expect, modal, test } from '../../../src/fixtures';
import { redis } from '../../../src/remote';
import { uniqueTestPhone } from '../../../src/seed';
import {
  armSmsNonce,
  callBe,
  cleanupUserByEmail,
  expectFail,
  signinRaw,
  signupBody,
} from './_helpers-auth';
import {
  fillSignupAccount,
  fillSignupProfile,
  p1bEmail,
  relaxP1bRates,
  TAGS_P1,
  userCountByEmail,
} from './_helpers-auth-p1b';
import { psql, sqlStr } from '../../../src/remote';

test.beforeEach(() => relaxP1bRates());

const CHECK = '/api/auth/signup/email/check';

test('AUTH-A01 이미 가입된 이메일 확인', TAGS_P1, async ({ tempUser, openAs }) => {
  const user = await tempUser('GUARDIAN');
  const [local, domain] = user.email.split('@');
  const variants = {
    원래: user.email,
    '전부 대문자': user.email.toUpperCase(),
    '섞인 대소문자': `${local[0].toUpperCase()}${local.slice(1)}@${domain.toUpperCase()}`,
  };

  await test.step('API: 대소문자가 달라도 409 EMAIL_ALREADY_EXISTS', async () => {
    for (const [label, email] of Object.entries(variants)) {
      expectFail(await callBe('POST', CHECK, { data: { email } }), 409, 'EMAIL_ALREADY_EXISTS', `이메일 확인(${label})`);
    }
    const free = await callBe('POST', CHECK, { data: { email: p1bEmail('free') } });
    expect(free.status, `대조군: 가입 안 된 이메일 ${free.status} ${free.code}`).toBe(200);
  });

  await test.step('화면: 가입 1단계(계정)에서 중복 오류가 보이고 다음으로 못 간다', async () => {
    const page = await openAs('anonymous', '/signup');
    const res = await fillSignupAccount(page, { email: variants['전부 대문자'] });
    expect(res.status(), '화면이 보낸 중복 확인 요청 상태').toBe(409);
    await expect(page.getByText('이미 사용 중인 이메일입니다.'), '중복 오류 문구').toBeVisible();
    await expect(page.getByRole('button', { name: '다음' }), '1단계에서 막힌다').toBeDisabled();
  });
});

test('AUTH-A03 입력 검증: 빈 값, 비밀번호 7자/65자, 이메일 형식, 우편번호 5자리 아님', TAGS_P1, async ({ openAs }) => {
  const phone = uniqueTestPhone();
  const base = () => signupBody({ email: p1bEmail('val'), name: 'E2E검증', phone, nonce: randomUUID() });
  const longPw = `Aa1!${'x'.repeat(61)}`; // 65자
  const cases: { label: string; patch: Record<string, unknown> }[] = [
    { label: '이름 빈 값', patch: { name: '' } },
    { label: '이메일 빈 값', patch: { email: '' } },
    { label: '비밀번호 빈 값', patch: { password: '' } },
    { label: '전화번호 빈 값', patch: { phone: '' } },
    { label: '비밀번호 7자', patch: { password: 'Ab1!xyz' } },
    { label: '비밀번호 65자', patch: { password: longPw } },
    { label: '비밀번호에 영문 없음', patch: { password: '12345678!' } },
    { label: '비밀번호에 숫자 없음', patch: { password: 'Abcdefg!' } },
    { label: '비밀번호에 특수문자 없음', patch: { password: 'Abcdefg1' } },
    { label: '이메일 형식 아님', patch: { email: 'not-an-email' } },
    { label: '우편번호 4자리', patch: { postcode: '1234' } },
    { label: '우편번호 6자리', patch: { postcode: '123456' } },
    { label: '우편번호 숫자 아님', patch: { postcode: 'abcde' } },
  ];

  const created: string[] = [];
  try {
    await test.step('서버: 필드별로 깨뜨리면 400 INVALID_INPUT', async () => {
      for (const c of cases) {
        const body = { ...base(), ...c.patch };
        created.push(String(body.email));
        const res = await callBe('POST', '/api/auth/signup', { data: body });
        expect.soft(res.status, `${c.label}: 상태 ${res.status} (${res.code})`).toBe(400);
        expect.soft(res.code, `${c.label}: 에러 코드`).toBe('INVALID_INPUT');
      }
    });
  } finally {
    for (const email of created) if (/^e2e\./i.test(email) && /@silverbridge\.test$/i.test(email)) cleanupUserByEmail(email);
  }

  await test.step('화면: 가입 화면 검사 규칙이 서버와 같다 (비번 8~64자 영문+숫자+특수)', async () => {
    const page = await openAs('anonymous', '/signup');
    const email = p1bEmail('scr');
    const checked = await fillSignupAccount(page, { email, password: 'Abcdef1!' });
    expect(checked.status(), '준비: 이메일 중복 확인 통과').toBe(200);
    const next = page.getByRole('button', { name: '다음' });
    await expect(next, '기준선: 올바른 비밀번호면 다음이 열린다').toBeEnabled();

    const screenCases = [
      { pw: 'Ab1!xyz', why: '7자' },
      { pw: longPw, why: '65자' },
      { pw: '12345678!', why: '영문 없음(숫자+특수문자 8자)' },
      { pw: 'Abcdefg1', why: '특수문자 없음' },
    ];
    for (const c of screenCases) {
      await page.getByPlaceholder('8자 이상').fill(c.pw);
      await page.getByPlaceholder('비밀번호 다시 입력').fill(c.pw);
      await expect
        .soft(next, `비밀번호 ${c.why}: 서버는 400 으로 거부하는데 화면은 다음 버튼을 열어 준다`)
        .toBeDisabled({ timeout: 3_000 });
    }

    await page.getByPlaceholder('8자 이상').fill('Abcdef1!');
    await page.getByPlaceholder('비밀번호 다시 입력').fill('Abcdef1!');
    await expect(next, '같은 비밀번호로 되돌리면 다음이 열린다').toBeEnabled();
    // 비밀번호만 고치면 확인란도 다시 검사되어 "일치하지 않습니다" 가 보여야 한다
    await page.getByPlaceholder('8자 이상').fill('Zyxwvu9@');
    await expect
      .soft(page.getByText('비밀번호가 일치하지 않습니다'), '비밀번호를 고친 뒤 확인란이 다시 검사되지 않는다')
      .toBeVisible({ timeout: 3_000 });
    await expect.soft(next, '확인란과 달라졌는데 다음이 열려 있다').toBeDisabled({ timeout: 3_000 });
  });
});

test('AUTH-A04 이름이 보이지 않는 문자·제어문자·NUL만으로 된 경우', TAGS_P1, async () => {
  const names: { label: string; name: string }[] = [
    { label: '제로폭 공백(U+200B)만', name: '\u200b\u200b\u200b' },
    { label: '한글 채움 문자(U+3164)만', name: '\u3164\u3164' },
    { label: 'NUL(U+0000)만', name: '\u0000' },
    { label: '제어문자(U+0007, U+0008)만', name: '\u0007\u0008' },
    { label: '제로폭+채움+NUL 섞음', name: '\u200b\u3164\u0000\u200b' },
  ];
  const emails: string[] = [];
  const phones: string[] = [];
  try {
    for (const c of names) {
      const email = p1bEmail('inv');
      const phone = uniqueTestPhone();
      emails.push(email);
      phones.push(phone);
      const nonce = armSmsNonce(phone);
      const res = await callBe('POST', '/api/auth/signup', { data: signupBody({ email, name: c.name, phone, nonce }) });
      expect.soft(res.status, `${c.label}: 상태 ${res.status} (${res.code}) - 500 이 아니라 400 이어야 한다`).toBe(400);
      expect.soft(res.code, `${c.label}: 에러 코드`).toBe('INVALID_INPUT');
      expect.soft(userCountByEmail(email), `${c.label}: 저장되지 않는다`).toBe(0);
    }
  } finally {
    for (const email of emails) cleanupUserByEmail(email);
    if (phones.length) redis('DEL', ...phones.map(p => `sms:verified:${p}`));
  }
});

test('AUTH-A10 가입 완료 더블클릭·동시 요청', TAGS_P1, async ({ openAs }) => {
  test.setTimeout(180_000);
  const apiEmail = p1bEmail('race');
  const apiPhone = uniqueTestPhone();
  const uiEmail = p1bEmail('dbl');
  const uiPhone = uniqueTestPhone();
  const keys = [`sms:verified:${apiPhone}`, `sms:verified:${uiPhone}`];

  try {
    await test.step('서버: 같은 가입 요청 동시 2건이면 계정은 1개만 생긴다', async () => {
      const nonce = armSmsNonce(apiPhone);
      const body = signupBody({ email: apiEmail, name: 'E2E동시', phone: apiPhone, nonce });
      const [a, b] = await Promise.all([
        callBe('POST', '/api/auth/signup', { data: body }),
        callBe('POST', '/api/auth/signup', { data: body }),
      ]);
      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses.filter(s => s === 201), `성공(201)은 정확히 1건 - 실제 ${statuses.join(',')}`).toHaveLength(1);
      const loser = a.status === 201 ? b : a;
      expect(loser.status, `나머지는 서버 오류(5xx)가 아니라 4xx - 실제 ${loser.status} ${loser.code}`).toBeGreaterThanOrEqual(400);
      expect(loser.status).toBeLessThan(500);
      // 엉뚱한 오류(입력 오류·없음 등)로 끝나지 않고 서버가 정한 거절 코드를 돌려준다
      expect(loser.code, `나머지 응답에 에러 코드가 있다 (${loser.status})`).toBeTruthy();
      expect(['INVALID_INPUT', 'NOT_FOUND', 'INTERNAL_SERVER_ERROR'], `엉뚱한 오류가 아니다 - 실제 ${loser.status} ${loser.code}`).not.toContain(loser.code);
      expect(userCountByEmail(apiEmail), '계정은 1개').toBe(1);
      test.info().annotations.push({
        type: '기획 확인 필요',
        description: `동시 요청 중 진 쪽 응답은 실제 ${loser.status} ${loser.code}. 케이스 기대값은 "중복 오류"인데 배포 BE(AuthService: 이메일 중복 확인 -> SMS 인증 표식 1회 소비 -> 저장)는 먼저 끝난 쪽에 따라 409 EMAIL_ALREADY_EXISTS 또는 400 SMS_NOT_VERIFIED 가 나올 수 있다. 문서가 한 값을 정하면 그 값 하나로 고정한다`,
      });
      // 같은 요청을 한 번 더 순서대로 보내면 항상 중복 오류
      const again = await callBe('POST', '/api/auth/signup', { data: body });
      expectFail(again, 409, 'EMAIL_ALREADY_EXISTS', '순서대로 재요청');
    });

    await test.step('화면: 가입 완료를 두 번 눌러도 요청은 1번, 누른 뒤 버튼은 비활성', async () => {
      const nonce = armSmsNonce(uiPhone);
      const page = await openAs('anonymous', null);
      // 문자 발송·확인만 대체한다 (실제 문자는 나가지 않는다)
      await page.route('**/api/auth/signup/sms/send', route =>
        route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } }),
      );
      await page.route('**/api/auth/signup/sms/verify', route =>
        route.fulfill({ json: { success: true, data: { verificationNonce: nonce } } }),
      );
      let signupCalls = 0;
      let signupDone = 0;
      // 응답을 1.5초 늦춰 "처리 중" 구간을 만든다 (요청 자체는 그대로 서버로 보낸다)
      await page.route('**/api/auth/signup', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        signupCalls += 1;
        await new Promise(resolve => setTimeout(resolve, 1_500));
        await route.continue();
        signupDone += 1;
      });

      await page.goto('/signup');
      const checked = await fillSignupAccount(page, { email: uiEmail });
      expect(checked.status(), '준비: 이메일 중복 확인 통과').toBe(200);
      await page.getByRole('button', { name: '다음' }).click();
      await fillSignupProfile(page, 'E2E더블');
      await page.getByRole('button', { name: '다음' }).click();
      await page.getByPlaceholder('01012345678').fill(uiPhone);
      await page.getByRole('button', { name: '인증번호 받기' }).click();
      await page.getByPlaceholder('6자리 입력').fill('123456');
      await page.getByRole('button', { name: '확인', exact: true }).click();
      await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();

      const submit = page.getByRole('button', { name: '가입 완료' });
      await submit.dblclick();
      await expect.soft(submit, '처리 중에는 가입 완료 버튼이 비활성이어야 한다').toBeDisabled({ timeout: 1_000 });
      await expect(modal(page, '회원가입이 완료되었습니다').or(modal(page, '회원가입 실패'))).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => signupDone, { message: '진행 중인 가입 요청이 모두 끝날 때까지', timeout: 20_000 }).toBe(signupCalls);
      expect(signupCalls, `가입 요청은 1번만 나가야 한다 (실제 ${signupCalls}번)`).toBe(1);
      expect(userCountByEmail(uiEmail), '계정은 1개').toBe(1);
    });
  } finally {
    cleanupUserByEmail(apiEmail);
    cleanupUserByEmail(uiEmail);
    redis('DEL', ...keys);
  }
});

test('AUTH-N01 일반 가입 4단계 끝까지 성공', TAGS_P1, async ({ openAs }) => {
  test.setTimeout(180_000);
  const email = p1bEmail('n01');
  const phone = uniqueTestPhone();
  try {
    const page = await openAs('anonymous', '/signup');

    await test.step('1) 이메일 중복 확인 200', async () => {
      const res = await fillSignupAccount(page, { email });
      expect(res.status(), '이메일 중복 확인').toBe(200);
      await page.getByRole('button', { name: '다음' }).click();
      await fillSignupProfile(page, 'E2E일반가입');
      await page.getByRole('button', { name: '다음' }).click();
    });

    await test.step('2) SMS 발송 200 (실제 문자 1건, 임시 번호 대역)', async () => {
      await page.getByPlaceholder('01012345678').fill(phone);
      const sent = page.waitForResponse(r => r.url().endsWith('/api/auth/signup/sms/send'), { timeout: 30_000 });
      await page.getByRole('button', { name: '인증번호 받기' }).click();
      const res = await sent;
      expect(res.status(), `SMS 발송 ${res.status()}`).toBe(200);
    });

    await test.step('3) SMS 확인 200 (nonce 받기)', async () => {
      // 받은 문자를 볼 수 없으므로 서버가 저장한 이 번호의 인증 코드를 읽어 입력한다 (이 임시 번호의 키만 읽는다)
      const code = redis('GET', `sms:verify:${phone}`);
      expect(code, '서버가 저장한 6자리 코드').toMatch(/^\d{6}$/);
      await page.getByPlaceholder('6자리 입력').fill(code);
      const verified = page.waitForResponse(r => r.url().endsWith('/api/auth/signup/sms/verify'), { timeout: 30_000 });
      await page.getByRole('button', { name: '확인', exact: true }).click();
      const res = await verified;
      expect(res.status(), `SMS 확인 ${res.status()}`).toBe(200);
      await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();
    });

    await test.step('4) 가입 완료 성공, 새 계정으로 로그인할 수 있다', async () => {
      const signed = page.waitForResponse(
        r => r.url().endsWith('/api/auth/signup') && r.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: '가입 완료' }).click();
      const res = await signed;
      expect(res.status(), `가입 ${res.status()}`).toBe(201);
      await expect(modal(page, '회원가입이 완료되었습니다')).toBeVisible();

      const login = await signinRaw(email, env.password);
      expect(login.status, `새 계정 로그인 ${login.status} ${login.code}`).toBe(200);
      expect(login.json?.data?.role, '가입 때 고른 역할').toBe('GUARDIAN');
    });
  } finally {
    cleanupUserByEmail(email);
    redis('DEL', `sms:verify:${phone}`, `sms:verified:${phone}`, `sms:attempt:${phone}`);
  }
});

test('AUTH-N02 이메일은 소문자로 저장, 대소문자만 달라도 같은 계정', TAGS_P1, async () => {
  const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const mixed = `E2E.Mixed+Plus.${tag}@Silverbridge.Test`;
  const lower = mixed.toLowerCase();
  const phone1 = uniqueTestPhone();
  const phones = [phone1];
  try {
    await test.step("이메일에 '+' 가 있어도 형식 검사를 통과한다 (문서 확인 필요: 근거 문서 줄이 없어 배포 BE 의 @Email 동작으로 확인)", async () => {
      const res = await callBe('POST', CHECK, { data: { email: mixed } });
      expect(res.status, `'+' 가 든 이메일 확인 ${res.status} ${res.code}`).toBe(200);
      test.info().annotations.push({
        type: '문서 확인 필요',
        description: "'+' 허용은 BE 설명서 532-533행에 직접 근거가 없다. 배포 BE(EmailCheckRequest @Email)가 허용하는 것만 확인했다. FE 가입 화면 정규식(EMAIL_PATTRERN)은 '+' 를 허용하지 않는다(FEUX-G12)",
      });
    });

    await test.step('대소문자 섞인 이메일로 가입하면 소문자로 저장된다', async () => {
      const nonce = armSmsNonce(phone1);
      const res = await callBe('POST', '/api/auth/signup', {
        data: signupBody({ email: mixed, name: 'E2E대소문자', phone: phone1, nonce }),
      });
      expect(res.status, `가입 ${res.status} ${res.code}`).toBe(201);
      const stored = psql(`SELECT email FROM users WHERE lower(email) = ${sqlStr(lower)};`);
      expect(stored, '저장된 이메일은 전부 소문자').toBe(lower);
      expect(userCountByEmail(lower), '계정 1개').toBe(1);
    });

    await test.step('소문자·원래 대소문자 어느 쪽으로 로그인해도 성공', async () => {
      for (const email of [lower, mixed]) {
        const login = await signinRaw(email, env.password);
        expect(login.status, `로그인(${email === lower ? '소문자' : '원래 대소문자'}) ${login.status} ${login.code}`).toBe(200);
      }
    });

    await test.step('같은 이메일(대소문자만 다르게)로 재가입하면 중복 오류 409', async () => {
      for (const email of [lower, mixed]) {
        const phone = uniqueTestPhone();
        phones.push(phone);
        const nonce = armSmsNonce(phone);
        const res = await callBe('POST', '/api/auth/signup', {
          data: signupBody({ email, name: 'E2E재가입', phone, nonce }),
        });
        expectFail(res, 409, 'EMAIL_ALREADY_EXISTS', `재가입(${email === lower ? '소문자' : '원래 대소문자'})`);
      }
      expect(userCountByEmail(lower), '그래도 계정은 1개').toBe(1);
    });
  } finally {
    cleanupUserByEmail(lower);
    redis('DEL', ...phones.map(p => `sms:verified:${p}`));
  }
});
