/**
 * 최종 QA - 인증(AUTH) P1b - 속도 제한·재발급 실패 (A09 A24)
 *
 * 임시 사용자만 쓴다. 속도 제한은 이 PC IP 키(rate:이름:내IP)만 건드린다 - 한도를 채운 뒤 반드시 그 키만 지운다.
 * 문자는 보내지 않는다(이미 가입된 임시 사용자 번호로 보내 409 로 끝낸다).
 */
import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { expect, test } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import {
  armOnce401,
  callBe,
  cookieNames,
  delLoginKeys,
  expectFail,
  isClearing,
  openMenuNav,
  Raw,
  refreshByCookie,
  refreshRows,
  rtCookie,
  signinRaw,
  tokensOf,
} from './_helpers-auth';
import { loginViaFormSafe, myIpSuffixP1b, relaxP1bRates, TAGS_P1, uniqueTag } from './_helpers-auth-p1b';

test.beforeEach(() => relaxP1bRates());

interface Endpoint {
  /** rate:{name}:{IP} 의 name */
  name: string;
  label: string;
  /** 한도 안에서 이 호출이 돌려주는 정상 응답 (한도와 무관한 결과) */
  ok: { status: number; code?: string };
  call: (i: number) => Promise<Raw>;
}

test('AUTH-A09 IP 기준 1분 10회 초과 429 (signin, email-check, find-email, signup-sms, refresh, kakao-login, reset)', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(420_000);
  const owner = await tempUser('GUARDIAN');
  const tag = uniqueTag();
  const ghosts: string[] = [];
  const suffix = await myIpSuffixP1b();

  const endpoints: Endpoint[] = [
    {
      name: 'signin',
      label: 'signin',
      ok: { status: 401, code: 'INVALID_CREDENTIALS' },
      // 호출마다 다른 미가입 이메일을 쓴다 (같은 이메일이면 6번째부터 로그인 잠금 429 가 먼저 나와 섞인다)
      call: i => {
        const email = `e2e.rl.${tag}.${i}@silverbridge.test`;
        ghosts.push(email);
        return signinRaw(email, 'Wrong1!pass');
      },
    },
    {
      name: 'email-check',
      label: 'signup/email/check',
      ok: { status: 200 },
      call: i => callBe('POST', '/api/auth/signup/email/check', { data: { email: `e2e.rl.${tag}.${i}@silverbridge.test` } }),
    },
    {
      name: 'find-email',
      label: 'find-email',
      ok: { status: 404, code: 'USER_NOT_FOUND' },
      call: () => callBe('POST', '/api/auth/find-email', { data: { name: 'E2E없는사람', phone: '01000009998' } }),
    },
    {
      name: 'signup-sms',
      label: 'signup/sms/send (이미 가입된 번호라 문자는 나가지 않는다)',
      ok: { status: 409, code: 'PHONE_ALREADY_EXISTS' },
      call: () => callBe('POST', '/api/auth/signup/sms/send', { data: { phone: owner.phone } }),
    },
    {
      name: 'token-refresh',
      label: 'refresh',
      ok: { status: 400, code: 'INVALID_INPUT' },
      call: () => callBe('POST', '/api/auth/refresh'),
    },
    {
      name: 'kakao-login',
      label: 'signin/kakao (가짜 인가 코드)',
      ok: { status: 401, code: 'KAKAO_INVALID_CODE' },
      call: () => callBe('POST', '/api/auth/signin/kakao', { data: { code: `e2e-fake-${tag}` } }),
    },
    {
      name: 'pw-reset-confirm',
      label: 'password/reset',
      ok: { status: 400, code: 'EXPIRED_SMS_CODE' },
      call: i =>
        callBe('POST', '/api/auth/password/reset', {
          data: { email: `e2e.rl.${tag}.${i}@silverbridge.test`, code: '000000', newPassword: 'Valid1!pass9' },
        }),
    },
  ];

  try {
    for (const ep of endpoints) {
      await test.step(ep.label, async () => {
        const key = `rate:${ep.name}:${suffix}`;
        let results: Raw[] = [];
        // 같은 PC 에서 다른 영역이 같은 한도를 동시에 쓰면 10번 안에 429 가 나거나, 반대로 중간에 키가 지워져 11번째가 429 가
        // 아닐 수 있다 - 내 IP 키를 비우고 다시 센다 (최대 4판). 실제 카카오 서버를 부르는 kakao-login 은 최대 2판만 센다
        const maxRounds = ep.name === 'kakao-login' ? 2 : 4;
        let roundsUsed = 0;
        for (let round = 1; round <= maxRounds; round++) {
          roundsUsed = round;
          await relaxP1bRates();
          results = [];
          for (let i = 1; i <= 11; i++) results.push(await ep.call(i));
          if (results.slice(0, 10).every(r => r.status !== 429) && results[10].status === 429) break;
        }
        if (roundsUsed > 1) {
          // 다시 센 것은 공용 IP 간섭 때문일 수도, 10번 안에 429 가 나는 진짜 문제일 수도 있어 숨기지 않고 남긴다
          test.info().annotations.push({
            type: '경고: 한도 판을 다시 셌다',
            description: `${ep.label}: ${roundsUsed}판째에 결과를 받았다 (앞 판들은 처음 10번 정상 + 11번째 429 모양이 아니었다)`,
          });
        }

        expect.soft(
          results.slice(0, 10).map(r => r.status),
          `${ep.label}: 처음 10번은 한도에 걸리지 않고 정상 응답(${ep.ok.status})`,
        ).toEqual(Array(10).fill(ep.ok.status));
        if (ep.ok.code) {
          expect.soft(results.slice(0, 10).map(r => r.code), `${ep.label}: 처음 10번의 에러 코드`).toEqual(Array(10).fill(ep.ok.code));
        }
        expectFail(results[10], 429, 'TOO_MANY_REQUESTS', `${ep.label} 11번째`);

        const ttl = Number(redis('TTL', key));
        expect.soft(ttl, `${ep.label}: 한도 키 TTL ${ttl}초는 1분(60초) 이내`).toBeGreaterThan(0);
        expect.soft(ttl).toBeLessThanOrEqual(60);

        // 1분이 지난 것과 같은 상태: 이 PC IP 의 이 한도 키만 1초 뒤 만료되게 한다
        redis('EXPIRE', key, '1');
        await expect
          .poll(async () => (await ep.call(12)).status, {
            message: `${ep.label}: 1분 뒤에는 다시 허용(${ep.ok.status})`,
            timeout: 20_000,
            intervals: [1_500],
          })
          .toBe(ep.ok.status);
      });
    }
  } finally {
    await relaxP1bRates();
    delLoginKeys({ emails: ghosts });
  }
});

test('AUTH-A24 refresh 쿠키·토큰이 없거나 만료', TAGS_P1, async ({ tempUser, browser }) => {
  test.setTimeout(240_000);

  await test.step('쿠키도 본문도 없이 refresh', async () => {
    const res = await callBe('POST', '/api/auth/refresh');
    // 2026-11-16 문서 정정(BE 프로젝트_설명 refresh 응답 코드): 토큰이 아예 없으면 400 INVALID_INPUT(요청 형식 오류),
    // 토큰이 있는데 무효·만료면 401. 뒤 단계도 계속 보도록 soft 로 단언한다
    expect.soft(res.status, `쿠키·본문 없는 refresh 상태 ${res.status} (${res.code}) - 기대값 400`).toBe(400);
    expect.soft(res.code, '토큰 없음은 INVALID_INPUT').toBe('INVALID_INPUT');
  });

  await test.step('모르는(없는) refresh 토큰은 401 이고 쿠키를 지운다', async () => {
    const res = await refreshByCookie('e2e.unknown.refresh.token');
    expectFail(res, 401, 'INVALID_TOKEN', '없는 토큰');
    expect(isClearing(rtCookie(res)), '죽은 토큰이면 careai_rt 삭제 Set-Cookie').toBe(true);
  });

  const user = await tempUser('GUARDIAN');
  await test.step('7일이 지난(만료된) refresh 는 401 EXPIRED_TOKEN, 행은 폐기되고 쿠키를 지운다', async () => {
    await relaxP1bRates();
    const s = await signinRaw(user.email, user.password);
    expect(s.status, `준비 로그인 ${s.status} ${s.code}`).toBe(200);
    const { refresh } = tokensOf(s);
    expect(refresh, '준비: refresh 토큰').toBeTruthy();
    expect(refreshRows(user.id), '준비: refresh 행 1개').toBe(1);
    // 이 임시 사용자 자신의 refresh 행만 "7일이 지난 것"으로 만든다
    psql(`UPDATE refresh_token SET expires_at = now() - interval '1 minute' WHERE user_id = ${sqlStr(user.id)};`);
    const res = await refreshByCookie(refresh);
    expectFail(res, 401, 'EXPIRED_TOKEN', '만료된 토큰');
    expect(isClearing(rtCookie(res)), '만료면 careai_rt 삭제 Set-Cookie').toBe(true);
    expect(refreshRows(user.id), '만료 토큰의 행은 폐기된다').toBe(0);
  });

  await test.step('화면: 재발급이 만료로 거절되면 로그인 화면으로 간다', async () => {
    await relaxP1bRates();
    // 401 을 일부러 만드는 케이스라 열린 화면의 자동 감시(openAs)를 쓰지 않고 직접 컨텍스트를 연다
    const context = await browser.newContext({ ...contextDefaults });
    try {
      await context.addInitScript(installPageStubs(), pageStubArg);
      const page = await context.newPage();
      await page.goto('/login');
      await loginViaFormSafe(page, user.email, user.password);
      await expect(page).toHaveURL(/\/guardian$/);
      await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeVisible();
      expect(await cookieNames(page), '준비: 로그인 세션 표시 쿠키').toContain('careai_session');

      psql(`UPDATE refresh_token SET expires_at = now() - interval '1 minute' WHERE user_id = ${sqlStr(user.id)};`);
      const state = armOnce401(page);
      const menu = await openMenuNav(page, '보호자');
      state.armed = true; // 이 순간 나가는 첫 보호 API 가 401 로 바뀌어 FE 의 재발급 경로를 탄다
      await menu.getByRole('link', { name: '공지사항', exact: true }).click({ timeout: 5_000 }).catch(() => undefined);
      await expect.poll(() => state.fired, { message: '보호 API 401 유도가 실행돼야 한다' }).toBeGreaterThanOrEqual(1);
      await expect(page, '재발급이 만료로 거절되면 로그인 화면').toHaveURL(/\/login/, { timeout: 20_000 });
      expect(await cookieNames(page), '로그인 세션 표시가 지워진다').not.toContain('careai_session');
      test.info().annotations.push({
        type: '확인 범위',
        description: '로그인 화면 안내 문구는 문서에 정해진 문구가 없어 화면 이동과 세션 표시 쿠키 삭제만 단언했다',
      });
    } finally {
      await context.close();
    }
  });
});
