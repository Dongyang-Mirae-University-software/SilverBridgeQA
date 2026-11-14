/**
 * 최종 QA - 인증(AUTH) P0 - 로그인·잠금·가입 입력 (N31 N34 A02 A06 A11 A16 A17 A19)
 *
 * 임시 사용자만 쓴다. 문자·메일은 보내지 않는다(인증 표식은 Redis 에 직접 넣는다).
 */
import { randomUUID } from 'node:crypto';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psql, redis, redisDelPattern, sqlStr } from '../../../src/remote';
import { deleteTempUser, uniqueTestPhone } from '../../../src/seed';
import { loginViaForm } from '../../../src/variables';
import {
  accessLogCount,
  armSmsNonce,
  callBe,
  cleanupUserByEmail,
  createKakaoUserViaSignup,
  delLoginKeys,
  expectFail,
  isClearing,
  myRateSuffix,
  rtCookie,
  setTempUserStatus,
  kakaoSignupBody,
  pollUntil,
  refreshByCookie,
  refreshRows,
  relaxAuthRates,
  setKakaoPending,
  sha256Hex,
  signinRaw,
  signupBody,
  sleep,
  tokensOf,
  uniqueSuffix,
  TAGS,
} from './_helpers-auth';

const SIGNUP_RATES = ['rate:signup:*', 'rate:kakao-signup:*'];

test.beforeEach(() => relaxAuthRates());

test('AUTH-N31 5회 실패 후 10분 잠금, 10분 뒤 해제', TAGS, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');
  const lockKey = `login:lock:${user.id}`;
  const failKey = `login:fail:${user.id}`;
  try {
    for (let i = 1; i <= 5; i++) {
      const res = await signinRaw(user.email, 'Wrong1!pass');
      expectFail(res, 401, 'INVALID_CREDENTIALS', `오답 ${i}회`);
    }
    const locked = await signinRaw(user.email, user.password);
    expectFail(locked, 429, 'LOGIN_LOCKED', '6번째(맞는 비밀번호)');
    expect(locked.message, '안내 문구에 10분').toContain('10분');

    const lockTtl = Number(redis('TTL', lockKey));
    const failTtl = Number(redis('TTL', failKey));
    expect(lockTtl, `잠금 TTL ${lockTtl}초는 10분(600초) 안쪽`).toBeGreaterThan(450);
    expect(lockTtl).toBeLessThanOrEqual(600);
    expect(failTtl, `실패 집계 창 TTL ${failTtl}초도 10분(600초) 안쪽`).toBeGreaterThan(450);
    expect(failTtl).toBeLessThanOrEqual(600);

    // 10분이 지난 것과 같은 상태: 이 임시 사용자의 잠금·집계 키만 1초 뒤 만료되게 한다
    redis('EXPIRE', lockKey, '1');
    redis('EXPIRE', failKey, '1');
    await sleep(2500);
    await relaxAuthRates();
    const after = await signinRaw(user.email, user.password);
    expect(after.status, `잠금이 풀린 뒤 로그인 ${after.status} ${after.code}`).toBe(200);
  } finally {
    redisDelPattern(`login:*:${user.id}`);
  }
});

test('AUTH-N34 클라이언트 IP: 믿을 수 있는 프록시의 XFF만 인정', TAGS, async ({ openAs }) => {
  const ghosts: string[] = [];
  const ghostEmail = () => {
    const email = `e2e.ghost.${uniqueSuffix()}@silverbridge.test`;
    ghosts.push(email);
    return email;
  };
  const spoof = (i: number) => `10.${i}.${(i * 7) % 250}.${(i * 13) % 250 + 1}`;

  // 이 시험은 이 PC 의 로그인 IP 한도(분당 10)를 일부러 채운다. 끝나면(실패해도) 내 IP 키만 비우고,
  // 만든 미가입 이메일의 login:* 키도 지운다. 다른 영역과 같은 PC 에서 동시에 돌리면 그쪽이 429 를 받을 수 있어,
  // 영역 단독 실행(--workers=1 로 이 영역만)에서만 돌리는 것을 전제로 한다.
  try {
  await test.step('BE 직접: 요청마다 X-Forwarded-For 를 바꿔도 속도 제한(분당 10회)을 못 피한다', async () => {
    await relaxAuthRates();
    const results: string[] = [];
    let limited = 0;
    for (let i = 1; i <= 14; i++) {
      // 요청마다 새 미가입 이메일: 계정 잠금(LOGIN_LOCKED)이 아니라 IP 한도만 본다
      const res = await signinRaw(ghostEmail(), 'Wrong1!pass', { 'X-Forwarded-For': spoof(i) });
      results.push(`${res.status}${res.code === 'TOO_MANY_REQUESTS' ? 'R' : ''}`);
      if (res.status === 429 && res.code === 'TOO_MANY_REQUESTS') limited++;
    }
    expect(limited, `위조 XFF 로 IP 제한을 우회했다: ${results.join(',')}`).toBeGreaterThan(0);
  });

  const page = await openAs('anonymous', '/login');

  await test.step('FE 경유: 클라이언트가 보낸 X-Forwarded-For 를 바꿔도 제한을 못 피한다', async () => {
    await relaxAuthRates();
    const results: string[] = [];
    let limited = 0;
    for (let i = 1; i <= 14; i++) {
      const res = await page.request.post('/api/auth/signin', {
        data: { email: ghostEmail(), password: 'Wrong1!pass' },
        headers: { 'X-Forwarded-For': spoof(i) },
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string };
      results.push(`${res.status()}${body.code === 'TOO_MANY_REQUESTS' ? 'R' : ''}`);
      if (res.status() === 429 && body.code === 'TOO_MANY_REQUESTS') limited++;
    }
    expect(limited, `FE 경유 위조 XFF 로 IP 제한을 우회했다: ${results.join(',')}`).toBeGreaterThan(0);
  });

  await test.step('FE 경유 요청도 BE 직접 요청과 같은 사용자 IP 로 집계된다 (FE 서버 IP 로 합쳐지지 않는다)', async () => {
    await relaxAuthRates();
    expect((await signinRaw(ghostEmail(), 'Wrong1!pass')).status).toBe(401);
    expect((await page.request.post('/api/auth/signin', { data: { email: ghostEmail(), password: 'Wrong1!pass' } })).status()).toBe(401);
    // 전체 키 개수 대신 "내 IP 키 하나"의 값으로 본다: 직접 호출 1회 + FE 경유 1회 = 같은 키에서 2
    const myKey = `rate:signin:${await myRateSuffix()}`;
    const count = Number(redis('GET', myKey));
    expect(count, `직접 호출과 FE 경유가 같은 내 IP 키(${myKey})에서 세어져 2가 돼야 한다 (실제 ${count})`).toBe(2);
  });
  } finally {
    await relaxAuthRates();
    delLoginKeys({ emails: ghosts });
  }
});

test('AUTH-A02 kakao_숫자@kakao.com 형태 이메일은 일반 가입 거절', TAGS, async () => {
  // 실제 카카오 회원번호와 겹치지 않게 9 로 시작하는 긴 숫자를 쓴다 (형식은 kakao_숫자@kakao.com 그대로)
  const base = `9${Date.now()}`;
  const variants = [`kakao_${base}@kakao.com`, `KAKAO_${base}1@KAKAO.COM`, ` kakao_${base}2@kakao.com `];
  await relaxAuthRates(SIGNUP_RATES);
  const phone = uniqueTestPhone();
  const nonce = armSmsNonce(phone);
  try {
    for (const email of variants) {
      const res = await callBe('POST', '/api/auth/signup', { data: signupBody({ email, name: 'E2E선점', phone, nonce }) });
      expect(res.status, `${email.trim()} -> ${res.status} ${res.code} ${res.message}`).toBe(400);
      const rows = Number(psql(`SELECT count(*) FROM users WHERE lower(email) = lower(${sqlStr(email.trim())});`));
      expect(rows, `${email.trim()} 로 계정이 만들어졌다 (남의 카카오 자리 선점)`).toBe(0);
      expect(redis('EXISTS', `sms:verified:${phone}`), '입력 검증에서 막혔으니 문자 인증(nonce)은 소비되지 않는다').toBe('1');
    }
  } finally {
    redis('DEL', `sms:verified:${phone}`);
    for (const email of variants) cleanupUserByEmail(email);
  }
});

test('AUTH-A06 verificationNonce 누락·불일치·재사용', TAGS, async () => {
  test.setTimeout(180_000);
  await relaxAuthRates(SIGNUP_RATES);
  const tag = uniqueSuffix();
  const email = (n: number) => `e2e.signup.nonce${n}${tag}@silverbridge.test`;
  const phoneA = uniqueTestPhone();
  const phoneB = uniqueTestPhone();
  const created: string[] = [];
  const signup = (n: number, phone: string, nonce?: string) =>
    callBe('POST', '/api/auth/signup', { data: signupBody({ email: email(n), name: 'E2E논스', phone, nonce }) });

  try {
    await test.step('(a) nonce 없이: 400 (가입 안 됨)', async () => {
      redis('SET', `sms:verified:${phoneA}`, randomUUID(), 'EX', '600');
      const res = await signup(1, phoneA, undefined);
      expect(res.status, `${res.status} ${res.code} ${res.message}`).toBe(400);
      // 문서는 SMS_NOT_VERIFIED 라고 적었지만, 배포 BE 는 verificationNonce 에 @NotBlank 를 걸어 입력 검증 단계에서 INVALID_INPUT 400 이다
      expect(res.code, `누락 시 코드 ${res.code}`).toBe('INVALID_INPUT');
      test.info().annotations.push({
        type: '문서와 코드 차이 (A06 a)',
        description: '문서는 nonce 누락을 SMS_NOT_VERIFIED 로 적었지만, 코드는 입력 검증 400 INVALID_INPUT 으로 막는다',
      });
    });

    await test.step('(b) 다른 번호의 nonce: SMS_NOT_VERIFIED 400, 그 번호의 인증은 소비되지 않는다', async () => {
      const nonceB = armSmsNonce(phoneB);
      const res = await signup(2, phoneA, nonceB);
      expectFail(res, 400, 'SMS_NOT_VERIFIED', '다른 번호 nonce');
      expect(redis('EXISTS', `sms:verified:${phoneB}`), '남의 번호 인증 표식은 그대로').toBe('1');
    });

    await test.step('(c) 틀린 nonce: SMS_NOT_VERIFIED 400', async () => {
      armSmsNonce(phoneA);
      const res = await signup(3, phoneA, randomUUID());
      expectFail(res, 400, 'SMS_NOT_VERIFIED', '틀린 nonce');
      expect(redis('EXISTS', `sms:verified:${phoneA}`), '틀린 nonce 는 진짜 인증을 소비하지 않는다').toBe('1');
    });

    await test.step('(d) 인증 표식이 사라진(시간 만료와 같은 상태) 뒤: 같은 오류', async () => {
      const nonce = randomUUID();
      redis('SET', `sms:verified:${phoneA}`, nonce, 'EX', '1');
      await sleep(2500);
      const res = await signup(4, phoneA, nonce);
      expectFail(res, 400, 'SMS_NOT_VERIFIED', '만료된 nonce');
    });

    await test.step('(e) 한 번 쓴 nonce 재사용: 첫 가입은 성공하고 표식이 사라지며, 같은 nonce 로 다시 하면 SMS_NOT_VERIFIED', async () => {
      const nonce = armSmsNonce(phoneA);
      const first = await signup(5, phoneA, nonce);
      expect(first.status, `첫 가입 ${first.status} ${first.code} ${first.message}`).toBe(201);
      created.push(email(5));
      expect(redis('EXISTS', `sms:verified:${phoneA}`), '가입이 nonce 를 소비한다').toBe('0');
      // 같은 번호로 다시 가입할 수 있게 첫 계정을 지운 뒤, 이미 쓴 nonce 로 재시도
      cleanupUserByEmail(email(5));
      created.pop();
      const replay = await signup(6, phoneA, nonce);
      expectFail(replay, 400, 'SMS_NOT_VERIFIED', '이미 쓴 nonce');
    });
  } finally {
    redis('DEL', `sms:verified:${phoneA}`);
    redis('DEL', `sms:verified:${phoneB}`);
    for (let n = 1; n <= 6; n++) cleanupUserByEmail(email(n));
  }
});

test('AUTH-A11 pendingToken 누락·틀림·30분 만료·재로그인 뒤 옛 토큰', TAGS, async () => {
  test.setTimeout(180_000);
  await relaxAuthRates(SIGNUP_RATES);
  const tag = uniqueSuffix();
  const kakaoId = `e2e${tag}`.slice(0, 20);
  const email = `e2e.kakaopend.${tag}@silverbridge.test`;
  const phone = uniqueTestPhone();
  const call = (data: object) => callBe('POST', '/api/auth/signup/kakao', { data });
  const rows = () => Number(psql(`SELECT count(*) FROM users WHERE provider = 'KAKAO' AND provider_id = ${sqlStr(kakaoId)};`));
  let createdUserId = '';

  try {
    const nonce = armSmsNonce(phone);
    const t1 = randomUUID();
    setKakaoPending(kakaoId, t1, email);

    await test.step('토큰 누락: 4xx', async () => {
      const res = await call(kakaoSignupBody({ kakaoId, phone, nonce }));
      expect(res.status, `누락 ${res.status} ${res.code}`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      expect(rows(), '가입되지 않는다').toBe(0);
    });

    await test.step('틀린 토큰(남의 kakaoId 만 아는 공격자): 거절, 인증 nonce 는 소비되지 않는다', async () => {
      const res = await call(kakaoSignupBody({ kakaoId, pendingToken: randomUUID(), phone, nonce }));
      expectFail(res, 400, 'KAKAO_SESSION_EXPIRED', '틀린 토큰');
      expect(rows(), '가입되지 않는다').toBe(0);
      expect(redis('EXISTS', `sms:verified:${phone}`), 'nonce 는 그대로').toBe('1');
    });

    await test.step('세션이 만료(30분 TTL 이 지난 것과 같은 상태): 올바른 토큰이어도 거절', async () => {
      setKakaoPending(kakaoId, t1, email, 1);
      await sleep(2500);
      const res = await call(kakaoSignupBody({ kakaoId, pendingToken: t1, phone, nonce }));
      expectFail(res, 400, 'KAKAO_SESSION_EXPIRED', '만료');
      expect(rows()).toBe(0);
    });

    await test.step('재로그인으로 새 토큰이 발급되면(세션 교체) 옛 토큰은 거절, 새 토큰으로만 완료', async () => {
      setKakaoPending(kakaoId, t1, email);
      const t2 = randomUUID();
      setKakaoPending(kakaoId, t2, email); // 카카오 로그인을 다시 하면 새 토큰으로 교체된다
      const old = await call(kakaoSignupBody({ kakaoId, pendingToken: t1, phone, nonce }));
      expectFail(old, 400, 'KAKAO_SESSION_EXPIRED', '옛 토큰');
      expect(rows()).toBe(0);

      const ok = await call(kakaoSignupBody({ kakaoId, pendingToken: t2, phone, nonce }));
      expect(ok.status, `본인 토큰 ${ok.status} ${ok.code} ${ok.message}`).toBe(201);
      createdUserId = ok.json?.data?.userId ?? '';
      expect(rows(), '새 토큰으로는 가입이 완료된다').toBe(1);
      expect(redis('EXISTS', `kakao:pending:${kakaoId}`), '완료되면 세션 키가 지워진다').toBe('0');
    });
  } finally {
    if (createdUserId) deleteTempUser(createdUserId);
    cleanupUserByEmail(email);
    redis('DEL', `kakao:pending:${kakaoId}`);
    redis('DEL', `sms:verified:${phone}`);
  }
});

test('AUTH-A16 미가입 이메일과 비밀번호 불일치는 같은 응답', TAGS, async ({ tempUser, openAs }) => {
  const user = await tempUser('GUARDIAN');
  const ghost = `e2e.ghost.${uniqueSuffix()}@silverbridge.test`;
  const shape = (res: Awaited<ReturnType<typeof signinRaw>>) => JSON.stringify({ status: res.status, success: res.json?.success, code: res.code, message: res.message, data: res.json?.data ?? null });

  test.setTimeout(180_000);
  try {
  const known: number[] = [];
  const unknown: number[] = [];
  // 첫 1회는 연결 맺기·예열이라 버리고, 이어서 8회를 잰다. 매 회전 전에 내 IP 한도와 로그인 실패 집계(5회 잠금)를 비운다
  const ROUNDS = 9;
  for (let i = 0; i < ROUNDS; i++) {
    await relaxAuthRates();
    delLoginKeys({ userIds: [user.id], emails: [ghost] });
    const t1 = Date.now();
    const a = await signinRaw(user.email, 'Wrong1!pass');
    const d1 = Date.now() - t1;
    const t2 = Date.now();
    const b = await signinRaw(ghost, 'Wrong1!pass');
    const d2 = Date.now() - t2;
    expectFail(a, 401, 'INVALID_CREDENTIALS', '가입 이메일 + 틀린 비밀번호');
    expectFail(b, 401, 'INVALID_CREDENTIALS', '미가입 이메일');
    expect(shape(a), '응답 본문이 같아야 계정 존재 여부를 알 수 없다').toBe(shape(b));
    if (i > 0) {
      known.push(d1);
      unknown.push(d2);
    }
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((x, y) => x - y);
    return (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2;
  };
  const mk = median(known);
  const mu = median(unknown);
  test.info().annotations.push({ type: '응답 시간(ms) 가입/미가입 (첫 1회 제외 8회)', description: `${known.join(',')} / ${unknown.join(',')}` });
  // 네트워크 흔들림에 덜 민감하도록 차이(ms) 대신 비율로 본다: 중앙값이 2배 이상 벌어지면 계정 존재 여부를 추측할 수 있다
  const ratio = Math.max(mk, mu) / Math.max(1, Math.min(mk, mu));
  expect(ratio, `응답 시간 차이가 커서 계정 존재 여부를 추측할 수 있다 (가입 ${mk}ms, 미가입 ${mu}ms, 비율 ${ratio.toFixed(2)})`).toBeLessThan(2);

  await test.step('화면 안내 문구도 같다', async () => {
    await relaxAuthRates();
    delLoginKeys({ userIds: [user.id], emails: [ghost] });
    const page = await openAs('anonymous', '/login');
    await loginViaForm(page, user.email, 'Wrong1!pass');
    const message = page.locator('[class*="errorMessage"]').first();
    await expect(message).toContainText('이메일 또는 비밀번호가 올바르지 않습니다.');
    const textKnown = ((await message.textContent()) ?? '').trim();
    await page.reload();
    await loginViaForm(page, ghost, 'Wrong1!pass');
    await expect(message).toContainText('이메일 또는 비밀번호가 올바르지 않습니다.');
    const textUnknown = ((await message.textContent()) ?? '').trim();
    expect(textUnknown, '미가입 이메일의 안내 문구가 가입 이메일과 같아야 한다').toBe(textKnown);
  });
  } finally {
    delLoginKeys({ userIds: [user.id], emails: [ghost] });
  }
});

test('AUTH-A17 잠금은 user.id 기준, 미가입 이메일도 같은 방식, 동시 요청 5회 초과 불가', TAGS, async ({ tempUser }) => {
  test.setTimeout(240_000);
  const cleanIds: string[] = [];
  const cleanEmails: string[] = [];

  try {
  await test.step('가입 계정: 타인이 5회 실패시키면 본인 로그인도 LOGIN_LOCKED 429 (user.id 기준)', async () => {
    const user = await tempUser('GUARDIAN');
    cleanIds.push(user.id);
    for (let i = 1; i <= 5; i++) {
      const res = await signinRaw(user.email, 'Wrong1!pass');
      expect(res.status, `오답 ${i}회 ${res.status}`).toBe(401);
    }
    const mine = await signinRaw(user.email, user.password);
    expectFail(mine, 429, 'LOGIN_LOCKED', '잠금 뒤 본인 로그인');
    expect(redis('EXISTS', `login:lock:${user.id}`), '잠금 키는 user.id 기준').toBe('1');
  });

  await test.step('미가입 이메일도 같은 시점(6번째)에 같은 429', async () => {
    await relaxAuthRates();
    const ghost = `e2e.ghost.${uniqueSuffix()}@silverbridge.test`;
    cleanEmails.push(ghost);
    const codes: string[] = [];
    for (let i = 1; i <= 6; i++) {
      const res = await signinRaw(ghost, 'Wrong1!pass');
      codes.push(`${res.status}:${res.code}`);
    }
    expect(codes.slice(0, 5), '1~5번째').toEqual(Array(5).fill('401:INVALID_CREDENTIALS'));
    expect(codes[5], '6번째는 가입 계정과 같은 잠금 응답').toBe('429:LOGIN_LOCKED');
  });

  await test.step('병렬 20건: 비밀번호 비교(401)는 5건을 넘지 않는다', async () => {
    await relaxAuthRates();
    const user = await tempUser('GUARDIAN');
    cleanIds.push(user.id);
    // 연결을 미리 열어 도착 시각 차이를 줄인다 (로그인 API 가 아닌 GET)
    await Promise.all(Array.from({ length: 10 }, () => fetch(`${env.apiUrl}/`).then(res => res.text()).catch(() => '')));
    const results = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const res = await fetch(`${env.apiUrl}/api/auth/signin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: user.email, password: 'Wrong1!pass' }),
        });
        const json = (await res.json().catch(() => ({}))) as { code?: string };
        return { status: res.status, code: json.code };
      }),
    );
    const compared = results.filter(r => r.status === 401).length;
    const summary = results.map(r => `${r.status}${r.code ? ':' + r.code : ''}`).join(',');
    test.info().annotations.push({ type: '병렬 20건', description: summary });
    expect(compared, `비밀번호 비교가 ${compared}건 진행됐다 (${summary})`).toBeLessThanOrEqual(5);
    expect(results.some(r => r.status === 200), '오답만 보냈으니 200 이 있으면 안 된다').toBe(false);
    await relaxAuthRates();
    const after = await signinRaw(user.email, user.password);
    expectFail(after, 429, 'LOGIN_LOCKED', '병렬 시도 뒤 맞는 비밀번호');
  });

  } finally {
    delLoginKeys({ userIds: cleanIds, emails: cleanEmails });
    await relaxAuthRates();
  }
});

test('AUTH-A19 이용 제한(정지)·탈퇴 중 계정은 로그인 차단 + refresh 삭제', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(180_000);
  const admin = await tempUser('ADMIN');
  const a = await loginAs(admin);
  const target = await tempUser('GUARDIAN');
  const targetIds = [target.id];

  try {
    await test.step('로그인 중인 계정을 관리자가 정지하면 refresh 가 바로 삭제되고, refresh 도 차단된다', async () => {
      const s = await signinRaw(target.email, target.password);
      expect(s.status).toBe(200);
      const { refresh } = tokensOf(s);
      expect(refreshRows(target.id), '준비: refresh 1개').toBe(1);

      const patch = await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: 'qa-auth-p0' });
      expect(patch.status(), `정지 ${await patch.text()}`).toBe(200);
      const left = await pollUntil(() => refreshRows(target.id), n => n === 0, 10_000);
      expect(left, '정지 즉시 refresh 삭제').toBe(0);

      await relaxAuthRates();
      const viaRefresh = await refreshByCookie(refresh);
      // 정지 리스너가 refresh 행을 먼저 지우므로 배포 코드(AuthService.refresh)에서는 항상 401 INVALID_TOKEN 이다
      // (행이 남은 채 정지된 403 INACTIVE_USER 경로는 아래 별도 단계에서 본다)
      expectFail(viaRefresh, 401, 'INVALID_TOKEN', '정지로 refresh 행이 지워진 계정의 refresh');
      expect(refreshRows(target.id), 'refresh 로 새 토큰이 만들어지지 않는다').toBe(0);
    });

    await test.step('정지 계정 signin: 비번이 맞으면 INACTIVE_USER 403 안내, 틀리면 INVALID_CREDENTIALS 401', async () => {
      await relaxAuthRates();
      const right = await signinRaw(target.email, target.password);
      expectFail(right, 403, 'INACTIVE_USER', '정지 + 맞는 비밀번호');
      expect(right.message, '정지 안내 문구').toContain('사용이 제한된 계정');
      expect(refreshRows(target.id), '정지 계정은 새 refresh 가 생기지 않는다').toBe(0);
      const wrong = await signinRaw(target.email, 'Wrong1!pass');
      expectFail(wrong, 401, 'INVALID_CREDENTIALS', '정지 + 틀린 비밀번호는 정지 사실을 숨긴다');
    });

    await test.step('탈퇴 진행 중(INACTIVE) 계정 signin: 같은 규칙', async () => {
      await relaxAuthRates();
      const inactive = await tempUser('GUARDIAN', { status: 'INACTIVE' });
      const right = await signinRaw(inactive.email, inactive.password);
      expectFail(right, 403, 'INACTIVE_USER', 'INACTIVE + 맞는 비밀번호');
      expect(refreshRows(inactive.id)).toBe(0);
      const wrong = await signinRaw(inactive.email, 'Wrong1!pass');
      expectFail(wrong, 401, 'INVALID_CREDENTIALS', 'INACTIVE + 틀린 비밀번호');
    });

    await test.step('refresh 행이 남은 채 정지된 계정(임시 사용자 자신의 status 만 직접 변경): refresh 403 + 행 삭제 + 쿠키 삭제', async () => {
      await relaxAuthRates();
      const held = await tempUser('GUARDIAN');
      const s = await signinRaw(held.email, held.password);
      expect(s.status).toBe(200);
      const { refresh } = tokensOf(s);
      expect(refreshRows(held.id), '준비: refresh 1개').toBe(1);
      setTempUserStatus(held.id, 'RESTRICTED'); // 정지 리스너를 거치지 않으므로 행이 남는다
      expect(refreshRows(held.id), '행이 남아 있다').toBe(1);
      const viaRefresh = await refreshByCookie(refresh);
      expectFail(viaRefresh, 403, 'INACTIVE_USER', '행이 남은 정지 계정의 refresh');
      expect(isClearing(rtCookie(viaRefresh)), '403 INACTIVE_USER 는 쿠키 삭제').toBe(true);
      expect(refreshRows(held.id), '거절하면서 refresh 행을 지운다(revokeOne)').toBe(0);
    });

    await test.step('refresh 행이 남은 채 정지된 계정: signin 은 403 INACTIVE_USER, 새 refresh 가 생기지 않는다', async () => {
      await relaxAuthRates();
      const held = await tempUser('GUARDIAN');
      expect((await signinRaw(held.email, held.password)).status).toBe(200);
      setTempUserStatus(held.id, 'RESTRICTED');
      const right = await signinRaw(held.email, held.password);
      expectFail(right, 403, 'INACTIVE_USER', '행이 남은 정지 계정 + 맞는 비밀번호');
      expect(rtCookie(right), '로그인 거절 때 새 refresh 쿠키를 주지 않는다').toBeUndefined();
    });

    test.info().annotations.push({
      type: '자동화 못 한 부분',
      description: 'signin/kakao 경로는 실제 카카오 인가 코드가 필요해 호출하지 못했다 (코드상 같은 상태 검사)',
    });
  } finally {
    psql(`DELETE FROM admin_audit_log WHERE admin_id = ${sqlStr(admin.id)} OR target_id IN (${targetIds.map(sqlStr).join(', ')});`);
  }
});
