/**
 * 변수 QA - 인증 경계
 *
 * 부작용 없음: 이메일 중복 확인(없는 e2e 이메일)만 호출한다. 메일·SMS 발송 API 는 부르지 않는다.
 */
import { request } from '@playwright/test';

import { env } from '../../src/env';
import { expect, test } from '../../src/fixtures';
import { redis, redisDelPattern } from '../../src/remote';

const EMAIL_CHECK = '/api/auth/signup/email/check';

function unusedEmail() {
  return `e2e.nobody.${Date.now().toString(36)}@silverbridge.test`;
}

test.describe('공개 인증 API', () => {
  test('[AUTH-G02] 이전 로그인의 무효 토큰 쿠키가 남아 있어도 가입·계정 찾기 API 는 막히지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api, who } = await loginAs(user);
    // 다른 기기에서 로그아웃(또는 비밀번호 변경·만료)되어 이 브라우저의 쿠키 토큰이 무효가 된 상태
    await api.post('/api/auth/logout');

    const page = await openAs(who, '/signup');

    await test.step('브라우저 경로(FE 프록시): 가입 화면의 이메일 중복 확인', async () => {
      const res = await page.request.post(EMAIL_CHECK, { data: { email: unusedEmail() } });
      expect(res.status(), `FE 프록시가 무효 쿠키 토큰을 붙여 401 이 된다: ${await res.text()}`).toBe(200);
    });

    await test.step('BE 직접: 무효 Bearer 토큰이 붙은 공개 API', async () => {
      const ctx = await request.newContext({
        baseURL: env.apiUrl,
        extraHTTPHeaders: { Authorization: `Bearer ${who.login.accessToken}` },
      });
      const res = await ctx.post(EMAIL_CHECK, { data: { email: unusedEmail() } });
      expect.soft(res.status(), `permitAll 경로에서도 필터가 무효 토큰을 401 로 끝낸다: ${await res.text()}`).toBe(200);
      await ctx.dispose();
    });
  });
});

test.describe('IP 레이트리밋', () => {
  test('[AUTH-G28/XCUT-G02] FE 를 거친 요청도 사용자 IP 기준으로 세어야 한다 (FE 서버 IP 로 합쳐지지 않는다)', async ({ openAs }) => {
    // 카운터를 비우는 쪽이라 다른 사용자에게 해가 없다
    redisDelPattern('rate:email-check:*');

    const direct = await request.newContext({ baseURL: env.apiUrl });
    expect((await direct.post(EMAIL_CHECK, { data: { email: unusedEmail() } })).status()).toBe(200);
    await direct.dispose();

    const page = await openAs('anonymous', '/signup');
    expect((await page.request.post(EMAIL_CHECK, { data: { email: unusedEmail() } })).status()).toBe(200);

    const keys = redis('--scan', '--pattern', 'rate:email-check:*').split('\n').filter(Boolean);
    const ips = keys.map(key => key.replace('rate:email-check:', ''));
    test.info().annotations.push({ type: 'rate:email-check 키', description: ips.join(', ') });
    // 같은 실행 PC 에서 보낸 두 요청이므로 키가 하나여야 한다. 둘이면 FE 경유 요청은 FE 서버 IP 로 세고 있는 것
    expect(ips, 'FE 경유 요청의 IP 가 BE 직접 호출과 달라 모든 사용자가 한 버킷을 공유하게 된다').toHaveLength(1);
  });
});
