/**
 * 최종 QA - 인증(AUTH) P2 - 가입 (N03 N04 N05 N09 A05 A12 A57)
 *
 * 임시 사용자와 이 묶음이 만든 가입 계정(e2e.p1b.p2* / e2e.kakaop2.* 이메일)만 쓴다. 정리는 정확한 이메일·번호 키로만 한다.
 * 실제 문자는 N03 에서만 2건(임시 번호 대역 010-0000-9xxx). 나머지는 문자 발송·확인을 대체하고 인증 표식을 Redis 에 직접 넣는다.
 */
import { randomUUID } from 'node:crypto';

import { expect, modal, test } from '../../../src/fixtures';
import { redis } from '../../../src/remote';
import { uniqueTestPhone } from '../../../src/seed';
import {
  armSmsNonce,
  callBe,
  cleanupUserByEmail,
  expectFail,
  kakaoSignupBody,
  setKakaoPending,
  signupBody,
  uniqueSuffix,
} from './_helpers-auth';
import { userCountByEmail } from './_helpers-auth-p1b';
import {
  birthYearsAgo,
  columnByEmail,
  fillSignupAddress,
  fillSignupProfileWithBirth,
  goToSignupProfileStep,
  kstDayOffset,
  kstToday,
  maskEmailLikeBe,
  p2Email,
  relaxP2,
  stubSignupSms,
  TAGS_P2,
} from './_helpers-auth-p2';
import { fillSignupAccount } from './_helpers-auth-p1b';

test.beforeEach(() => relaxP2());

const phoneKeys = (phone: string) => [
  `sms:verify:${phone}`,
  `sms:verified:${phone}`,
  `sms:attempt:${phone}`,
  `sms:sendcount:${phone}`, // 발송할 때마다 BE 가 올리는 번호별 발송 횟수(임시 번호 자신의 키)
];

test('AUTH-N03 SMS 재발송은 쿨다운 없이 즉시 가능', TAGS_P2, async () => {
  test.setTimeout(120_000);
  const phone = uniqueTestPhone();
  try {
    const first = await callBe('POST', '/api/auth/signup/sms/send', { data: { phone } });
    expect(first.status, `발송 ${first.status} ${first.code}`).toBe(200);
    const code1 = redis('GET', `sms:verify:${phone}`);
    expect(code1, '첫 코드는 6자리 숫자').toMatch(/^\d{6}$/);

    // 바로(쿨다운 없이) 재발송
    const second = await callBe('POST', '/api/auth/signup/sms/resend', { data: { phone } });
    expect(second.status, `재발송 ${second.status} ${second.code}`).toBe(200);
    expect(second.json?.data?.expiresInSeconds, '재발송 응답의 유효 시간(초)').toBe(300);
    expect(second.json?.data?.codeLength, '재발송 응답의 코드 길이').toBe(6);

    const code2 = redis('GET', `sms:verify:${phone}`);
    expect(code2, '새 코드는 6자리 숫자').toMatch(/^\d{6}$/);
    expect(code2, '기존 코드는 폐기되고 새 코드로 바뀐다').not.toBe(code1);
    const ttl = Number(redis('TTL', `sms:verify:${phone}`));
    expect(ttl, `새 코드 유효 시간(초) ${ttl}`).toBeGreaterThan(240);
    expect(ttl).toBeLessThanOrEqual(300);

    // 옛 코드는 더 이상 맞지 않고, 새 코드는 통과해 인증 표식(nonce)을 받는다
    const old = await callBe('POST', '/api/auth/signup/sms/verify', { data: { phone, code: code1 } });
    expectFail(old, 400, 'INVALID_SMS_CODE', '옛 코드');
    const ok = await callBe('POST', '/api/auth/signup/sms/verify', { data: { phone, code: code2 } });
    expect(ok.status, `새 코드 확인 ${ok.status} ${ok.code}`).toBe(200);
    expect(ok.json?.data?.verificationNonce, '인증 표식(nonce)이 발급된다').toMatch(/^[0-9a-f-]{36}$/);
  } finally {
    redis('DEL', ...phoneKeys(phone));
  }
});

test('AUTH-N04 가입 나이 경계: 만 14세와 만 120세는 통과', TAGS_P2, async ({ openAs }) => {
  test.setTimeout(240_000);
  const created: { email: string; phone: string }[] = [];
  try {
    for (const [label, years] of [['만14세', 14], ['만120세', 120]] as const) {
      await test.step(`${label}(오늘 기준 정확히 ${years}년 전) 생년월일로 가입 완료`, async () => {
        const email = p2Email(`n04y${years}`);
        const phone = uniqueTestPhone();
        const birth = birthYearsAgo(years);
        created.push({ email, phone });
        const nonce = armSmsNonce(phone);
        const page = await openAs('anonymous', null);
        await stubSignupSms(page, nonce);

        expect(await goToSignupProfileStep(page, email), '준비: 이메일 중복 확인 통과').toBe(200);
        await fillSignupProfileWithBirth(page, 'E2E나이경계', birth);
        await fillSignupAddress(page);
        // 케이스 기대값: 가입 화면에서 나이 규칙(만 14세 이상) 안내가 보인다
        await expect.soft(page.getByText(/만 14세/), '가입 화면에 나이 규칙 안내(만 14세 이상)가 보인다').toBeVisible({ timeout: 3_000 });
        await page.getByRole('button', { name: '다음' }).click();

        await page.getByPlaceholder('01012345678').fill(phone);
        await page.getByRole('button', { name: '인증번호 받기' }).click();
        await page.getByPlaceholder('6자리 입력').fill('123456');
        await page.getByRole('button', { name: '확인', exact: true }).click();
        await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();

        const signed = page.waitForResponse(r => r.url().endsWith('/api/auth/signup') && r.request().method() === 'POST', { timeout: 30_000 });
        await page.getByRole('button', { name: '가입 완료' }).click();
        const res = await signed;
        expect(res.status(), `가입 ${res.status()}`).toBe(201);
        await expect(modal(page, '회원가입이 완료되었습니다')).toBeVisible();
        expect(columnByEmail(email, 'birth_date'), '저장된 생년월일').toBe(`[${birth}]`);
      });
    }
  } finally {
    for (const { email, phone } of created) {
      cleanupUserByEmail(email);
      redis('DEL', ...phoneKeys(phone));
    }
  }
});

test('AUTH-N05 이름 앞뒤 공백은 정리해 저장, 아이디 찾기도 된다', TAGS_P2, async () => {
  const email = p2Email('n05');
  const phone = uniqueTestPhone();
  try {
    const nonce = armSmsNonce(phone);
    const signed = await callBe('POST', '/api/auth/signup', { data: signupBody({ email, name: ' 홍길동 ', phone, nonce }) });
    expect(signed.status, `가입 ${signed.status} ${signed.code}`).toBe(201);
    expect(columnByEmail(email, 'name'), '이름은 앞뒤 공백 없이 저장된다').toBe('[홍길동]');

    // 정리한 이름과, 공백이 붙은 이름 둘 다 같은 계정을 찾는다 (FE 화면 대신 BE 를 직접 호출)
    for (const typed of ['홍길동', ' 홍길동 ']) {
      const found = await callBe('POST', '/api/auth/find-email', { data: { name: typed, phone } });
      expect(found.status, `"${typed}" 아이디 찾기 ${found.status} ${found.code}`).toBe(200);
      expect(found.json?.data?.maskedEmail, `"${typed}" 마스킹 이메일`).toBe(maskEmailLikeBe(email.toLowerCase()));
      expect(found.json?.data?.hasKakaoAccount, '카카오 계정 없음').toBe(false);
    }
  } finally {
    cleanupUserByEmail(email);
    redis('DEL', ...phoneKeys(phone));
  }
});

/** 카카오 가입 한 번분(임시 세션·인증 표식)을 만든다. 정리 함수를 같이 돌려준다 */
function prepareKakaoSignup() {
  const tag = uniqueSuffix();
  const kakaoId = `e2e${tag}`.slice(0, 20);
  const email = `e2e.kakaop2.${tag}@silverbridge.test`;
  const phone = uniqueTestPhone();
  const nonce = armSmsNonce(phone);
  const pendingToken = randomUUID();
  setKakaoPending(kakaoId, pendingToken, email);
  const body = (profileImageUrl: string) => ({ ...kakaoSignupBody({ kakaoId, pendingToken, phone, nonce }), profileImageUrl });
  const cleanup = () => {
    cleanupUserByEmail(email);
    redis('DEL', `kakao:pending:${kakaoId}`, ...phoneKeys(phone));
  };
  return { email, body, cleanup };
}

test('AUTH-N09 카카오 프로필 이미지 kakaocdn 주소 처리', TAGS_P2, async () => {
  const k = prepareKakaoSignup();
  try {
    const http = 'http://k.kakaocdn.net/dn/e2e/profile_p2.jpg';
    const res = await callBe('POST', '/api/auth/signup/kakao', { data: k.body(http) });
    expect(res.status, `카카오 가입 ${res.status} ${res.code}`).toBe(201);
    expect(columnByEmail(k.email, 'profile_image'), 'http 주소는 https 로 바꿔 저장된다').toBe('[https://k.kakaocdn.net/dn/e2e/profile_p2.jpg]');
  } finally {
    k.cleanup();
  }
});

test('AUTH-A12 카카오 프로필 이미지: 가입 요청의 kakaocdn 이외 주소는 400 으로 거절', TAGS_P2, async () => {
  // 2026-11-16 결정·문서 정정(BE 프로젝트_설명 카카오 가입): 로그인 응답(signin/kakao)은 밖 주소를 비우고,
  // 가입 요청(signup/kakao)에 kakaocdn 밖 주소가 오면 400 INVALID_INPUT. 임의 주소 저장을 막는 의도된 동작이다.
  const urls = ['https://example.com/profile.png', 'https://kakaocdn.net.example.com/p.png', 'https://user@k.kakaocdn.net/p.png'];
  for (const url of urls) {
    const k = prepareKakaoSignup();
    try {
      const label = url.replace(/^https:\/\/(user@)?/, '');
      const res = await callBe('POST', '/api/auth/signup/kakao', { data: k.body(url) });
      expect.soft(res.status, `${label}: 기대값 400. 실제 ${res.status} ${res.code}`).toBe(400);
      expect.soft(res.code, `${label}: INVALID_INPUT`).toBe('INVALID_INPUT');
      expect.soft(columnByEmail(k.email, 'id'), `${label}: 거절된 가입으로 계정이 생기지 않는다`).toBe('');
    } finally {
      k.cleanup();
    }
  }
});

test('AUTH-A05 생년월일 경계: 미래, 만 14세 미만(하루 모자람), 120세 초과, 형식 오류', TAGS_P2, async ({ openAs }) => {
  test.setTimeout(180_000);
  const apiEmail = p2Email('a05api');
  const apiPhone = uniqueTestPhone();
  const uiEmail = p2Email('a05ui');
  try {
    await test.step('가입 요청: 잘못된 생년월일은 모두 400 INVALID_INPUT, 계정은 생기지 않는다', async () => {
      const nonce = armSmsNonce(apiPhone);
      const bad: [string, string][] = [
        ['미래(내일)', kstDayOffset(1)],
        ['만 14세 하루 모자람', birthYearsAgo(14, 1)],
        ['만 121세', birthYearsAgo(121)],
        ['형식 오류(슬래시)', '1990/01/01'],
        ['형식 오류(없는 달·일)', '2000-13-45'],
      ];
      for (const [label, birthDate] of bad) {
        const res = await callBe('POST', '/api/auth/signup', {
          data: { ...signupBody({ email: apiEmail, name: 'E2E생일', phone: apiPhone, nonce }), birthDate },
        });
        expectFail(res, 400, 'INVALID_INPUT', label);
      }
      expect(userCountByEmail(apiEmail), '거절된 요청으로 계정이 생기지 않는다').toBe(0);
    });

    await test.step('가입 화면: 같은 값은 "다음" 단계로 넘어가기 전에 막힌다', async () => {
      const page = await openAs('anonymous', null);
      expect(await goToSignupProfileStep(page, uiEmail), '준비: 이메일 중복 확인 통과').toBe(200);
      const next = page.getByRole('button', { name: '다음' });
      await fillSignupProfileWithBirth(page, 'E2E생일', birthYearsAgo(30));
      await fillSignupAddress(page);
      await expect(next, '기준선: 정상 생년월일이면 다음 버튼이 열린다').toBeEnabled();

      const today = kstToday();
      const cases: [string, string][] = [
        ['만 14세 하루 모자람', birthYearsAgo(14, 1)],
        ['만 121세', birthYearsAgo(121)],
      ];
      if (Number(kstDayOffset(1).slice(0, 4)) === today.y) cases.push(['미래(내일)', kstDayOffset(1)]);
      for (const [label, birth] of cases) {
        const [y, m, d] = birth.split('-');
        const selects = page.getByRole('group', { name: /생년월일/ }).locator('select');
        await selects.nth(0).selectOption(y);
        await selects.nth(1).selectOption(m);
        await selects.nth(2).selectOption(d);
        await expect.soft(next, `${label}(${birth}) 이면 가입 화면에서 먼저 막혀 다음 버튼이 비활성이다`).toBeDisabled({ timeout: 3_000 });
      }
    });
  } finally {
    cleanupUserByEmail(apiEmail);
    cleanupUserByEmail(uiEmail);
    redis('DEL', ...phoneKeys(apiPhone));
  }
});

test('AUTH-A57 가입 전화번호 입력 편의와 이메일 확인 제어', TAGS_P2, async ({ openAs }) => {
  test.setTimeout(180_000);
  const email = p2Email('a57');
  const phone = uniqueTestPhone();
  const phoneInput = (page: import('@playwright/test').Page) => page.getByPlaceholder('01012345678');
  const page = await openAs('anonymous', null);
  const sent: string[] = [];
  const checks: string[] = [];
  page.on('request', r => {
    if (r.method() !== 'POST') return;
    if (r.url().endsWith('/api/auth/signup/sms/send')) sent.push(r.url());
    if (r.url().endsWith('/api/auth/signup/email/check')) checks.push(r.url());
  });
  // 문자 발송은 대체한다: mode 로 느린 성공 / 실패 안내를 고른다
  let mode: 'slow' | 'fail' = 'slow';
  await page.route('**/api/auth/signup/sms/send', async route => {
    if (mode === 'fail') {
      return route.fulfill({ status: 400, json: { success: false, code: 'INVALID_INPUT', message: '[E2E] 발송 실패 안내' } });
    }
    await new Promise(resolve => setTimeout(resolve, 1_500));
    return route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } });
  });
  try {
    await page.goto('/signup');
    expect((await fillSignupAccount(page, { email })).status(), '준비: 이메일 중복 확인 통과').toBe(200);
    expect(checks, '이메일 칸을 벗어나면 중복 확인 1번').toHaveLength(1);

    await test.step('이미 확인된 이메일은 다시 조회하지 않는다', async () => {
      const emailInput = page.getByPlaceholder('example@email.com');
      await emailInput.focus();
      await page.getByPlaceholder('8자 이상').focus();
      // 요청이 조금 늦게 나가도 셈이 빠지지 않도록, 포커스를 옮기기 전에 요청 기다림을 걸어 둔다
      const extraCheck = page
        .waitForRequest(r => r.method() === 'POST' && r.url().endsWith('/api/auth/signup/email/check'), { timeout: 2_000 })
        .then(() => true, () => false);
      await emailInput.focus();
      await page.getByPlaceholder('비밀번호 다시 입력').focus();
      expect.soft(await extraCheck, '값이 그대로인 이메일에 다시 포커스를 줬다 뺀 뒤 2초 안에 중복 확인 요청이 또 나가면 안 된다').toBe(false);
      expect.soft(checks, '중복 확인은 1번이어야 한다').toHaveLength(1);
    });

    await page.getByRole('button', { name: '다음' }).click();
    await fillSignupProfileWithBirth(page, 'E2E전화입력', birthYearsAgo(30));
    await fillSignupAddress(page);
    await page.getByRole('button', { name: '다음' }).click();

    await test.step('하이픈 있는 번호를 붙여넣으면 숫자만 정상 처리된다', async () => {
      const dashed = `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
      // 실제 붙여넣기: 클립보드에 값을 넣고 Ctrl+V (paste 이벤트와 maxLength 가 실제처럼 동작한다)
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(text => navigator.clipboard.writeText(text), dashed);
      await phoneInput(page).focus();
      await page.keyboard.press('Control+V');
      await expect.soft(phoneInput(page), `붙여넣은 ${dashed.length}자(하이픈 포함)가 숫자 ${phone.length}자리 번호로 들어가야 한다`).toHaveValue(phone);
      await phoneInput(page).fill(phone);
      await expect(phoneInput(page)).toHaveValue(phone);
    });

    await test.step('발송 중에는 버튼이 잠기고 요청은 1번만 나간다', async () => {
      mode = 'slow';
      const send = page.getByRole('button', { name: '인증번호 받기' });
      await send.dblclick();
      await expect.soft(page.getByRole('button', { name: '발송 중' }), '발송 중에는 버튼이 "발송 중"으로 잠긴다').toBeDisabled({ timeout: 1_000 });
      await expect(page.getByPlaceholder('6자리 입력')).toBeVisible({ timeout: 15_000 });
      expect(sent, '발송 요청은 1번').toHaveLength(1);
      await page.getByRole('button', { name: '번호 변경' }).click();
    });

    await test.step('발송 오류 문구는 입력을 바꾸면 사라진다', async () => {
      mode = 'fail';
      await phoneInput(page).fill(phone);
      await page.getByRole('button', { name: '인증번호 받기' }).click();
      await expect(page.getByText('[E2E] 발송 실패 안내')).toBeVisible();
      await phoneInput(page).fill(phone.slice(0, 10));
      await expect.soft(page.getByText('[E2E] 발송 실패 안내'), '번호를 고치면 이전 오류 문구가 사라져야 한다').toBeHidden({ timeout: 3_000 });
    });
  } finally {
    cleanupUserByEmail(email);
    redis('DEL', ...phoneKeys(phone));
  }
});
