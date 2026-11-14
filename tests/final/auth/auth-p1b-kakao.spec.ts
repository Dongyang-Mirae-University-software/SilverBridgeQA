/**
 * 최종 QA - 인증(AUTH) P1b - 카카오 가입·로그인·탈퇴 (N06 N07 N28)
 *
 * 카카오 서버는 부르지 않는다(실제 카카오 계정 로그인은 자동화할 수 없다). 카카오 가입 대기 세션은
 * 임시 키(kakao:pending:e2e...)를 Redis 에 직접 넣어 만든다. 만든 계정은 모두 임시 사용자라 끝나면 지운다.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type { Page } from '@playwright/test';

import { expect, test } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import { uniqueTestPhone } from '../../../src/seed';
import {
  armSmsNonce,
  callBe,
  cleanupUserByEmail,
  createKakaoUserViaSignup,
  expectFail,
  jwtPayload,
  kakaoSignupBody,
  parseCookie,
  rtCookie,
  setKakaoPending,
  signinRaw,
  tokensOf,
  uniqueSuffix,
} from './_helpers-auth';
import { fillSignupProfile, relaxP1bRates, TAGS_P1, userCountByEmail } from './_helpers-auth-p1b';

test.beforeEach(() => relaxP1bRates());

/** 카카오 콜백 화면을 연다: 이 브라우저가 시작한 로그인으로 보이게 state 쿠키(난수)를 심고 콜백 주소로 간다 (page 는 FE 주소에 있어야 한다) */
async function openKakaoCallback(page: Page, code: string) {
  const nonce = randomBytes(16).toString('hex');
  await page.evaluate(value => {
    document.cookie = `careai_oauth_state=${value}; path=/; SameSite=Lax`;
  }, nonce);
  await page.goto(`/auth/kakao/callback?code=${code}&state=${nonce}`);
}

test('AUTH-N06 카카오 기존 회원 로그인 (화면 절반: 콜백 화면이 로그인 처리)', TAGS_P1, async ({ tempUser, openAs }) => {
  test.setTimeout(120_000);
  const user = await tempUser('GUARDIAN');
  await relaxP1bRates();
  const s = await signinRaw(user.email, user.password);
  expect(s.status, `준비 로그인 ${s.status} ${s.code}`).toBe(200);
  const access = tokensOf(s).access;

  const page = await openAs('anonymous', '/login');
  let sentCode: unknown;
  // 카카오 서버가 필요한 응답만 대체한다: 기존 회원(isNewUser=false)은 accessToken 과 role 을 돌려받는다
  await page.route('**/api/auth/signin/kakao', route => {
    sentCode = (route.request().postDataJSON() as { code?: unknown } | null)?.code;
    return route.fulfill({ json: { success: true, data: { isNewUser: false, accessToken: access, role: 'GUARDIAN' } } });
  });

  await openKakaoCallback(page, 'e2e-fake-code');
  await expect(page, '기존 회원이면 가입 화면이 아니라 역할 홈(보호자 대시보드)으로 간다').toHaveURL(/\/guardian$/, { timeout: 20_000 });
  await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();
  expect(sentCode, '콜백 화면이 인가 코드를 로그인 요청에 실어 보낸다').toBe('e2e-fake-code');
  test.info().annotations.push({
    type: '자동화 못 한 부분',
    description: '서버 응답 쪽(진짜 카카오 인가 코드로 isNewUser=false, accessToken 반환, careai_rt 쿠키 HttpOnly·Path=/api/auth)은 카카오 동의 화면에서 사람이 로그인해야 나오는 코드가 필요해 수동 확인으로 남긴다. 가짜 코드 거절과 속도 제한은 AUTH-A09, P0 AUTH-N08 이 본다',
  });
});

test('AUTH-N07 카카오 신규 가입 4단계 (pendingToken 포함)', TAGS_P1, async ({ openAs }) => {
  test.setTimeout(180_000);
  const tag = uniqueSuffix();
  const kakaoId = `e2e${tag}`.slice(0, 20);
  const email = `e2e.p1b.kakao.${tag}@silverbridge.test`;
  const phone = uniqueTestPhone();
  const pendingToken = randomUUID();
  const phone2 = uniqueTestPhone();
  try {
    await test.step('1) 카카오 로그인 응답(isNewUser=true)이 만드는 가입 대기 세션 - 카카오 서버 없이 같은 형태로 준비', async () => {
      setKakaoPending(kakaoId, pendingToken, email);
      test.info().annotations.push({
        type: '자동화 못 한 부분',
        description: '1번 단계의 진짜 응답(이름 null)은 카카오 서버가 필요해 확인하지 못했다. BE 코드(KakaoAuthService.loginOrPrepareSignup)는 신규 사용자에게 name=null 을 돌려준다. 화면 쪽(이름 칸이 비어 있음)은 아래 화면 단계에서 대체 응답으로 확인한다',
      });
    });

    await test.step('2) SMS 발송 200 (실제 문자 1건, 임시 번호 대역)', async () => {
      const res = await callBe('POST', '/api/auth/signup/sms/send', { data: { phone } });
      expect(res.status, `SMS 발송 ${res.status} ${res.code}`).toBe(200);
    });

    let nonce = '';
    await test.step('3) SMS 확인 200, nonce 받기', async () => {
      const code = redis('GET', `sms:verify:${phone}`); // 이 임시 번호의 키만 읽는다
      expect(code, '서버가 저장한 6자리 코드').toMatch(/^\d{6}$/);
      const res = await callBe('POST', '/api/auth/signup/sms/verify', { data: { phone, code } });
      expect(res.status, `SMS 확인 ${res.status} ${res.code}`).toBe(200);
      nonce = res.json?.data?.verificationNonce;
      expect(nonce, 'verificationNonce 를 받는다').toMatch(/^[0-9a-f-]{36}$/);
    });

    await test.step('4) signup/kakao 에 kakaoId+pendingToken+nonce 전달: 201 Created, 쿠키 발급', async () => {
      const res = await callBe('POST', '/api/auth/signup/kakao', { data: kakaoSignupBody({ kakaoId, pendingToken, phone, nonce }) });
      expect(res.status, `카카오 가입 ${res.status} ${res.code}`).toBe(201);
      expect(res.json?.data?.accessToken, 'accessToken').toBeTruthy();
      const cookie = rtCookie(res);
      expect(cookie?.value, 'careai_rt 쿠키 발급').toBeTruthy();
      const parsed = parseCookie(res.setCookies.find(c => c.startsWith('careai_rt='))!);
      expect(parsed.attrs.httponly, 'HttpOnly').toBe(true);
      expect(jwtPayload(res.json.data.accessToken).sub, '토큰의 사용자').toBe(res.json.data.userId);
      expect(psql(`SELECT provider FROM users WHERE id = ${sqlStr(res.json.data.userId)};`), '카카오 가입 계정').toBe('KAKAO');
    });

    await test.step('같은 pendingToken 으로 다시 가입하면 거절 (세션은 한 번만 쓴다)', async () => {
      // 진짜 인증 표식(nonce)을 보내므로 거절 원인은 pendingToken(이미 쓴 세션) 하나뿐이다
      const nonce2 = armSmsNonce(phone2);
      const again = await callBe('POST', '/api/auth/signup/kakao', {
        data: kakaoSignupBody({ kakaoId, pendingToken, phone: phone2, nonce: nonce2 }),
      });
      expect(again.status, `재사용 ${again.status} ${again.code}`).toBe(400);
      expect(again.code, '재사용 에러 코드').toBe('KAKAO_SESSION_EXPIRED');
    });
  } finally {
    cleanupUserByEmail(email);
    redis('DEL', `kakao:pending:${kakaoId}`, `sms:verify:${phone}`, `sms:verified:${phone}`, `sms:attempt:${phone}`, `sms:verified:${phone2}`);
  }

  await test.step('화면(AUTH-G07): 카카오 콜백 화면이 가입 화면으로 넘기고, 가입 요청에 pendingToken 을 싣는다 (카카오 응답만 대체, 문자는 나가지 않는다)', async () => {
    const uiTag = uniqueSuffix();
    const uiKakaoId = `e2e${uiTag}`.slice(0, 20);
    const uiEmail = `e2e.p1b.kakaoui.${uiTag}@silverbridge.test`;
    const uiPhone = uniqueTestPhone();
    const uiPending = randomUUID();
    try {
      setKakaoPending(uiKakaoId, uiPending, uiEmail);
      const uiNonce = armSmsNonce(uiPhone);
      const page = await openAs('anonymous', '/login');
      // 카카오 서버가 필요한 1번 응답만 같은 형태로 대체한다 (신규 회원: 이름 null)
      await page.route('**/api/auth/signin/kakao', route =>
        route.fulfill({
          json: {
            success: true,
            data: { isNewUser: true, kakaoId: uiKakaoId, email: uiEmail, name: null, profileImageUrl: null, pendingToken: uiPending },
          },
        }),
      );
      await page.route('**/api/auth/signup/sms/send', route =>
        route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } }),
      );
      await page.route('**/api/auth/signup/sms/verify', route =>
        route.fulfill({ json: { success: true, data: { verificationNonce: uiNonce } } }),
      );

      await openKakaoCallback(page, 'e2e-fake-code');
      await expect(page, '신규 회원이면 가입 화면(카카오)으로 간다').toHaveURL(/\/signup\?kakao=1/, { timeout: 20_000 });
      await expect(page.getByPlaceholder('홍길동'), '1번 응답의 이름이 null 이라 이름 칸은 비어 있다').toHaveValue('');

      await page.locator('label[for="GUARDIAN"]').click();
      await fillSignupProfile(page, 'E2E카카오화면');
      await page.getByRole('button', { name: '다음' }).click();
      await page.getByPlaceholder('01012345678').fill(uiPhone);
      await page.getByRole('button', { name: '인증번호 받기' }).click();
      await page.getByPlaceholder('6자리 입력').fill('123456');
      await page.getByRole('button', { name: '확인', exact: true }).click();
      await expect(page.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();

      const signed = page.waitForResponse(
        r => r.url().endsWith('/api/auth/signup/kakao') && r.request().method() === 'POST',
        { timeout: 30_000 },
      );
      await page.getByRole('button', { name: '가입 완료' }).click();
      const res = await signed;
      const sent = res.request().postDataJSON() as Record<string, unknown>;
      expect(sent.pendingToken, '화면이 가입 요청에 카카오 로그인 응답의 pendingToken 을 그대로 싣는다').toBe(uiPending);
      expect(sent.kakaoId, '가입 요청의 kakaoId').toBe(uiKakaoId);
      expect(res.status(), `카카오 가입 ${res.status()}`).toBe(201);
      expect(userCountByEmail(uiEmail), '계정이 1개 만들어진다').toBe(1);
      expect(psql(`SELECT provider FROM users WHERE lower(email) = lower(${sqlStr(uiEmail)});`), '카카오 가입 계정').toBe('KAKAO');
    } finally {
      cleanupUserByEmail(uiEmail);
      redis('DEL', `kakao:pending:${uiKakaoId}`, `sms:verified:${uiPhone}`);
    }
  });
});

test('AUTH-N28 카카오 가입자는 "탈퇴" 또는 "회원탈퇴" 입력으로 탈퇴', TAGS_P1, async () => {
  test.setTimeout(180_000);
  for (const confirmation of ['탈퇴', '회원탈퇴']) {
    await relaxP1bRates();
    const kakao = await createKakaoUserViaSignup();
    try {
      const wrong = await callBe('DELETE', '/api/user/me', { token: kakao.accessToken, data: { confirmation: '탈' } });
      expectFail(wrong, 400, 'WITHDRAW_CONFIRMATION_MISMATCH', '대조군: 다른 문구');
      expect(userCountByEmail(kakao.email), '대조군: 다른 문구로는 탈퇴되지 않는다').toBe(1);

      const res = await callBe('DELETE', '/api/user/me', { token: kakao.accessToken, data: { confirmation } });
      expect(res.status, `"${confirmation}" 로 탈퇴 ${res.status} ${res.code}`).toBe(200);
      expect(userCountByEmail(kakao.email), `"${confirmation}" 탈퇴 뒤 계정이 삭제된다`).toBe(0);
    } finally {
      kakao.cleanup();
    }
  }
});
