/**
 * 최종 QA - 인증(AUTH) P0 - 비밀번호 재설정·변경·탈퇴 (N21 N24 N27 A32 A37 A38 A39 A40)
 *
 * 임시 사용자만 쓴다. 메일·문자는 보내지 않는다(인증코드는 Redis 에 직접 넣는다).
 * 탈퇴 케이스는 임시 사용자가 스스로 탈퇴한다(영구 삭제). 푸시는 임시 사용자에게 FCM 토큰이 없어 실제로 나가지 않는다.
 */
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { psql, redis, redisDelPattern, sqlStr } from '../../../src/remote';
import { deleteTempUser, uniqueTestPhone } from '../../../src/seed';
import { connect, fcmTokenCount, loginViaForm } from '../../../src/variables';
import {
  accessLogCount,
  armSmsNonce,
  callBe,
  cleanupUserByEmail,
  createKakaoUserViaSignup,
  expectFail,
  failLoginFiveTimes,
  isClearing,
  openStompWs,
  pollUntil,
  refreshByCookie,
  refreshRows,
  relaxAuthRates,
  rtCookie,
  signinRaw,
  signupBody,
  sleep,
  tokensOf,
  userRowCount,
  userStatus,
  wsState,
  TAGS,
} from './_helpers-auth';

const RESET = ['rate:pw-reset-confirm:*'];
const NEW_PASSWORD = 'NewPass1!x';

test.beforeEach(() => relaxAuthRates(RESET));

/** 메일 없이 비밀번호 재설정 (인증코드를 Redis 에 직접 넣는다) */
async function resetPassword(email: string, newPassword = NEW_PASSWORD, headers: Record<string, string> = {}) {
  redis('SET', `password:email:verify:${email}`, '123456', 'EX', '300');
  redis('DEL', `password:email:attempt:${email}`);
  return callBe('POST', '/api/auth/password/reset', { data: { email, code: '123456', newPassword }, headers });
}

test('AUTH-N21 재설정 성공 시 모든 기기 로그아웃', TAGS, async ({ tempUser, openAs }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  try {
    // 기기 2대 로그인 (단일 기기 정책: 뒤에 로그인한 B 만 유효)
    const a = tokensOf(await signinRaw(user.email, user.password));
    await sleep(1300);
    const b = tokensOf(await signinRaw(user.email, user.password));
    expect(a.access && b.access).toBeTruthy();

    const page = await openAs('anonymous', '/login');
    expect(await openStompWs(page, b.access), '준비: 기기 B 의 웹소켓(STOMP) 연결').toBe(true);

    // 로그인 5회 실패로 잠금 (재설정이 잠금도 풀어야 한다)
    await failLoginFiveTimes(user.email);
    expect(redis('EXISTS', `login:lock:${user.id}`), '준비: 로그인 잠금').toBe('1');

    const res = await resetPassword(user.email, NEW_PASSWORD, { 'User-Agent': 'E2E-AUTH-P0/1.0' });
    expect(res.status, `재설정 ${res.status} ${res.code} ${res.message}`).toBe(200);

    expect(await pollUntil(() => refreshRows(user.id), n => n === 0, 10_000), 'refresh 전부 삭제').toBe(0);
    for (const [label, token] of [['기기 A', a.access], ['기기 B', b.access]] as const) {
      const me = await pollUntil(() => callBe('GET', '/api/user/me', { token }), r => r.status === 401, 10_000);
      expect(me.status, `${label} 옛 access`).toBe(401);
    }
    expect((await refreshByCookie(b.refresh)).status, '옛 refresh 로 재발급 불가').toBe(401);

    const closed = await pollUntil(() => wsState(page), s => s.readyState === 3, 12_000);
    expect(closed.readyState, `열린 웹소켓이 닫혀야 한다 (readyState ${closed.readyState})`).toBe(3);
    expect(closed.close?.code, '닫힘 코드 1008').toBe(1008);
    expect(closed.close?.reason, '닫힘 사유').toBe('AUTH_INVALIDATED');

    const log = await pollUntil(
      () => psql(`SELECT coalesce(ip_address,'') || '|' || coalesce(user_agent,'') FROM access_log WHERE user_id = ${sqlStr(user.id)} AND action = 'PASSWORD_RESET';`),
      v => v !== '',
      10_000,
    );
    const [ip, ua] = log.split('|');
    expect(ip, 'access_log 에 IP 기록').not.toBe('');
    expect(ua, 'access_log 에 User-Agent 기록').toContain('E2E-AUTH-P0');

    expect(redis('EXISTS', `login:lock:${user.id}`), '로그인 잠금 해제').toBe('0');
    await sleep(1300);
    await relaxAuthRates();
    const again = await signinRaw(user.email, NEW_PASSWORD);
    expect(again.status, `새 비밀번호로 로그인 ${again.status} ${again.code}`).toBe(200);
  } finally {
    redisDelPattern(`login:*:${user.id}`);
  }
});

test('AUTH-N24 비밀번호 변경 성공 후 다른 기기 세션 종료, 새 로그인은 정상', TAGS, async ({ tempUser, loginAs }) => {
  const user = await tempUser('GUARDIAN');
  const { api, login } = await loginAs(user);
  const otherDeviceToken = `e2e-fake-fcm-other-${user.id}-${Date.now().toString(36)}`;
  await api.post('/api/notifications/fcm-token', { token: otherDeviceToken, platform: 'WEB' });
  expect(fcmTokenCount({ token: otherDeviceToken }), '준비: 다른 기기 푸시 주소 등록').toBe(1);

  // 현재 비밀번호를 한 번 틀려 확인 실패 기록(user:pwfail)을 만든다 - 성공하면 지워져야 한다
  const wrong = await api.raw('PUT', '/api/user/me/password', { currentPassword: 'Wrong1!pass', newPassword: 'E2eChanged!2345' });
  expect(wrong.status(), '준비: 틀린 현재 비밀번호는 401').toBe(401);
  expect(redis('EXISTS', `user:pwfail:${user.id}`), '준비: 실패 기록').toBe('1');

  const res = await api.raw('PUT', '/api/user/me/password', { currentPassword: user.password, newPassword: 'E2eChanged!2345' });
  expect(res.status(), `변경 ${await res.text()}`).toBe(200);
  const cookie = res.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value);
  const parsed = cookie.map(line => line.split(';').map(s => s.trim())).find(parts => parts[0].startsWith('careai_rt='));
  expect(parsed, '응답이 refresh 쿠키(careai_rt)를 지우라고 내려야 한다').toBeTruthy();
  expect(parsed!.some(part => part.toLowerCase() === 'max-age=0'), 'Max-Age=0 으로 삭제').toBe(true);

  const oldMe = await pollUntil(() => api.raw('GET', '/api/user/me').then(r => r.status()), s => s === 401, 10_000);
  expect(oldMe, '옛 access 토큰은 401').toBe(401);
  expect(await pollUntil(() => fcmTokenCount({ token: otherDeviceToken }), n => n === 0, 5_000), '다른 기기 푸시 주소 삭제').toBe(0);
  expect(refreshRows(user.id), '기존 refresh 삭제').toBe(0);
  expect(redis('EXISTS', `user:pwfail:${user.id}`), '확인 실패 기록(pwfail) 해제').toBe('0');
  expect(redis('EXISTS', `user:pwlock:${user.id}`), '확인 잠금(pwlock) 해제').toBe('0');

  await relaxAuthRates();
  const fresh = await signinRaw(user.email, 'E2eChanged!2345');
  expect(fresh.status, `새 비밀번호 로그인 ${fresh.status} ${fresh.code}`).toBe(200);
  const old = await signinRaw(user.email, user.password);
  expectFail(old, 401, 'INVALID_CREDENTIALS', '옛 비밀번호');
  expect(login.accessToken).toBeTruthy();
});

test('AUTH-N27 일반 가입자 탈퇴: 비밀번호 확인, 2걸음 삭제, 연결 상대 알림', TAGS, async ({ tempUser, loginAs, openAs }) => {
  test.setTimeout(240_000);
  const guardian = await tempUser('GUARDIAN');
  const ward = await tempUser('WARD'); // 탈퇴하는 쪽 (LOCAL). 남는 보호자가 알림을 받는다
  connect(guardian.id, ward.id);
  const w = await loginAs(ward);

  const page = await openAs('anonymous', '/login');
  await loginViaForm(page, guardian.email, guardian.password);
  await expect(page).toHaveURL(/\/guardian$/);
  await waitForRealtime(page);
  await page.evaluate(destination => {
    const win = window as unknown as {
      __qaCancelled: string[];
      __connectionStompClient: { subscribe: (d: string, cb: (m: { body: string }) => void) => void };
    };
    win.__qaCancelled = [];
    win.__connectionStompClient.subscribe(destination, m => win.__qaCancelled.push(m.body));
  }, `/topic/${guardian.id}/connection-cancelled`);
  await sleep(500);
  const connId = psql(`SELECT id FROM connection WHERE status = 'ACTIVE' AND ward_id = ${sqlStr(ward.id)};`);
  expect(connId, '준비: ACTIVE 연결').not.toBe('');

  let reSignupId = '';
  try {
    const res = await w.api.raw('DELETE', '/api/user/me', { password: ward.password });
    expect(res.status(), `탈퇴 ${await res.text()}`).toBe(200);

    const bodies = await pollUntil(
      () => page.evaluate(() => (window as unknown as { __qaCancelled?: string[] }).__qaCancelled ?? []),
      list => list.length > 0,
      15_000,
    );
    test.info().annotations.push({ type: '상대에게 온 해제 알림', description: bodies.join(' ').slice(0, 300) });
    expect(bodies.join(' '), '연결 상대에게 탈퇴로 연결이 끝났다는 알림').toContain('탈퇴해 연결이 종료되었습니다');

    expect(userRowCount(ward.id), '2걸음 삭제: 사용자 행이 영구 삭제된다').toBe(0);
    expect(Number(psql(`SELECT count(*) FROM connection WHERE ward_id = ${sqlStr(ward.id)} AND status = 'ACTIVE';`)), '활성 연결이 남지 않는다').toBe(0);

    await relaxAuthRates(RESET);
    const after = await signinRaw(ward.email, ward.password);
    expectFail(after, 401, 'INVALID_CREDENTIALS', '탈퇴 뒤 로그인');

    // 같은 이메일·전화번호로 재가입 가능
    await relaxAuthRates(['rate:signup:*']);
    const nonce = armSmsNonce(ward.phone as string);
    const signup = await callBe('POST', '/api/auth/signup', {
      data: signupBody({ email: ward.email, name: 'E2E재가입', phone: ward.phone as string, nonce, role: 'WARD' }),
    });
    expect(signup.status, `재가입 ${signup.status} ${signup.code} ${signup.message}`).toBe(201);
    reSignupId = psql(`SELECT id FROM users WHERE email = ${sqlStr(ward.email)};`);
    expect(reSignupId, '재가입된 사용자 행').not.toBe('');
  } finally {
    if (reSignupId) deleteTempUser(reSignupId);
    else cleanupUserByEmail(ward.email);
    redis('DEL', `sms:verified:${ward.phone}`);
  }
});

test('AUTH-A32 코드 오류 5회 무효화, reset 은 코드 선검증', TAGS, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const kakao = await tempUser('GUARDIAN', { provider: 'KAKAO' });
  const ghost = `e2e.ghost.${Date.now().toString(36)}@silverbridge.test`;
  const verifyKey = `password:email:verify:${user.email}`;
  const attempt = (email: string, code: string) =>
    callBe('POST', '/api/auth/password/reset', { data: { email, code, newPassword: NEW_PASSWORD } });

  try {
    await test.step('틀린 코드 5회: 4번은 INVALID_SMS_CODE, 5번째에 SMS_TOO_MANY_ATTEMPTS 로 코드 무효화', async () => {
      redis('SET', verifyKey, '123456', 'EX', '300');
      redis('DEL', `password:email:attempt:${user.email}`);
      const codes: string[] = [];
      for (let i = 1; i <= 5; i++) {
        const res = await attempt(user.email, String(100000 + i));
        expect(res.status, `${i}번째 ${res.status} ${res.code}`).toBe(400);
        codes.push(res.code ?? '');
      }
      expect(codes).toEqual(['INVALID_SMS_CODE', 'INVALID_SMS_CODE', 'INVALID_SMS_CODE', 'INVALID_SMS_CODE', 'SMS_TOO_MANY_ATTEMPTS']);
      expect(redis('EXISTS', verifyKey), '코드가 즉시 무효화된다').toBe('0');
    });

    await test.step('무효화 뒤에는 맞는 코드(123456)도 재발송 전까지 거절 (EXPIRED_SMS_CODE)', async () => {
      const res = await attempt(user.email, '123456');
      expectFail(res, 400, 'EXPIRED_SMS_CODE', '무효화된 코드');
      await relaxAuthRates(RESET);
      const stillOld = await signinRaw(user.email, user.password);
      expect(stillOld.status, '비밀번호는 바뀌지 않았다').toBe(200);
    });

    await test.step('reset 은 코드를 먼저 검증한다: 미가입·카카오·코드 없는 가입자 모두 같은 코드 오류(가입 여부·provider 노출 없음)', async () => {
      await relaxAuthRates(RESET);
      const registeredNoCode = await attempt(user.email, '654321');
      const unregistered = await attempt(ghost, '654321');
      const kakaoAccount = await attempt(kakao.email, '654321');
      for (const [label, res] of [['가입자(코드 없음)', registeredNoCode], ['미가입', unregistered], ['카카오 계정', kakaoAccount]] as const) {
        expectFail(res, 400, 'EXPIRED_SMS_CODE', label);
      }
      expect(unregistered.message, '미가입 응답 문구가 가입자와 같다').toBe(registeredNoCode.message);
      expect(kakaoAccount.message, 'provider 를 알려 주지 않는다').toBe(registeredNoCode.message);
    });

    await test.step('(정책 확인) send 는 미가입이면 404 로 가입 여부를 드러낸다 - 같은 응답 규칙은 reset 단계에만 해당', async () => {
      const send = await callBe('POST', '/api/auth/find-password/email/send', { data: { email: ghost } });
      expectFail(send, 404, 'EMAIL_ACCOUNT_NOT_FOUND', '미가입 이메일 send');
    });
  } finally {
    redis('DEL', verifyKey);
    redis('DEL', `password:email:attempt:${user.email}`);
    redisDelPattern(`login:*:${user.id}`);
  }
});

test('AUTH-A37 현재 비밀번호 5회 틀리면 PASSWORD_CHECK_LOCKED 429 (30분, 로그인과 별도)', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(240_000);

  await test.step('비밀번호 변경에서 5회 틀림: 6번째는 맞는 비밀번호여도 429, 탈퇴 확인도 같이 잠김, 로그인은 영향 없음', async () => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await api.raw('PUT', '/api/user/me/password', { currentPassword: `Wrong!Pass${i}xx`, newPassword: 'E2eChanged!2345' });
      statuses.push(res.status());
    }
    expect(statuses, '1~5번째는 401(INVALID_PASSWORD)').toEqual([401, 401, 401, 401, 401]);

    const sixth = await api.raw('PUT', '/api/user/me/password', { currentPassword: user.password, newPassword: 'E2eChanged!2345' });
    const sixthBody = (await sixth.json()) as { code?: string; message?: string };
    expect(sixth.status(), `6번째 ${sixthBody.code}`).toBe(429);
    expect(sixthBody.code).toBe('PASSWORD_CHECK_LOCKED');
    expect(sixthBody.message, '안내는 30분 (로그인 잠금 10분과 다르다)').toContain('30분');
    const ttl = Number(redis('TTL', `user:pwlock:${user.id}`));
    expect(ttl, `잠금 TTL ${ttl}초는 30분(1800초) 안쪽`).toBeGreaterThan(1500);
    expect(ttl).toBeLessThanOrEqual(1800);

    // 탈퇴 확인도 같은 잠금: 틀린 비밀번호로만 시도한다 (성공 호출 없음)
    const withdraw = await api.raw('DELETE', '/api/user/me', { password: 'Wrong!PassZZ' });
    expect(withdraw.status(), '탈퇴 확인도 잠김').toBe(429);
    expect(((await withdraw.json()) as { code?: string }).code).toBe('PASSWORD_CHECK_LOCKED');

    await relaxAuthRates(RESET);
    const loginOk = await signinRaw(user.email, user.password);
    expect(loginOk.status, `본인 로그인은 영향 없음 ${loginOk.status} ${loginOk.code}`).toBe(200);
    expect(redis('EXISTS', `login:lock:${user.id}`), '로그인 잠금 키는 따로다').toBe('0');

    // 재설정 성공 시 잠금 해제
    const reset = await resetPassword(user.email);
    expect(reset.status, `재설정 ${reset.code}`).toBe(200);
    expect(await pollUntil(() => redis('EXISTS', `user:pwlock:${user.id}`), v => v === '0', 8_000), '재설정이 확인 잠금을 푼다').toBe('0');
    expect(redis('EXISTS', `user:pwfail:${user.id}`), '실패 횟수도 지운다').toBe('0');
    await sleep(1300);
    await relaxAuthRates(RESET);
    const again = await loginAs({ ...user, password: NEW_PASSWORD });
    const changed = await again.api.raw('PUT', '/api/user/me/password', { currentPassword: NEW_PASSWORD, newPassword: 'E2eChanged!2345' });
    expect(changed.status(), '잠금이 풀린 뒤 비밀번호 변경 성공').toBe(200);
  });

  await test.step('탈퇴 확인에서 5회 틀림: 6번째 429, 비밀번호 변경도 같이 잠김', async () => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) {
      const res = await api.raw('DELETE', '/api/user/me', { password: `Wrong!Pass${i}xx` });
      statuses.push(res.status());
    }
    expect(statuses, '탈퇴 확인 1~5번째는 401').toEqual([401, 401, 401, 401, 401]);
    const sixth = await api.raw('DELETE', '/api/user/me', { password: 'Wrong!Pass6xx' });
    expect(sixth.status()).toBe(429);
    expect(((await sixth.json()) as { code?: string }).code).toBe('PASSWORD_CHECK_LOCKED');
    const change = await api.raw('PUT', '/api/user/me/password', { currentPassword: user.password, newPassword: 'E2eChanged!2345' });
    expect(change.status(), '비밀번호 변경도 같은 잠금').toBe(429);
    expect(userStatus(user.id), '계정은 그대로 ACTIVE').toBe('ACTIVE');
  });
});

test('AUTH-A38 탈퇴 확인 실패: 비번 오류, 카카오 확인 문구 불일치', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(180_000);

  await test.step('LOCAL: 틀린 비밀번호·빈 값·비밀번호 없음은 거절되고 계정은 그대로', async () => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const wrong = await api.raw('DELETE', '/api/user/me', { password: 'Wrong1!pass' });
    expect(wrong.status(), '틀린 비밀번호').toBe(401);
    expect(((await wrong.json()) as { code?: string }).code).toBe('INVALID_PASSWORD');
    const blank = await api.raw('DELETE', '/api/user/me', { password: '' });
    expect(blank.status(), '빈 비밀번호는 4xx').toBeGreaterThanOrEqual(400);
    expect(blank.status()).toBeLessThan(500);
    const missing = await api.raw('DELETE', '/api/user/me', {});
    expect(missing.status(), '비밀번호 없음은 4xx').toBeGreaterThanOrEqual(400);
    expect(missing.status()).toBeLessThan(500);
    expect(userStatus(user.id), '계정은 그대로').toBe('ACTIVE');
    await relaxAuthRates(RESET);
    expect((await signinRaw(user.email, user.password)).status, '여전히 로그인된다').toBe(200);
  });

  await test.step("KAKAO: '탈퇴해요'·빈 값·없음은 WITHDRAW_CONFIRMATION_MISMATCH 400, 계정은 그대로", async () => {
    await relaxAuthRates(['rate:kakao-signup:*', 'rate:signup:*']);
    const kakao = await createKakaoUserViaSignup();
    try {
      for (const [label, data] of [
        ["'탈퇴해요'", { confirmation: '탈퇴해요' }],
        ['빈 문자열', { confirmation: '' }],
        ['확인 문구 없음', {}],
      ] as const) {
        const res = await callBe('DELETE', '/api/user/me', { token: kakao.accessToken, data });
        expectFail(res, 400, 'WITHDRAW_CONFIRMATION_MISMATCH', label);
      }
      expect(userStatus(kakao.id), '카카오 계정은 그대로 ACTIVE').toBe('ACTIVE');
    } finally {
      kakao.cleanup();
    }
  });
});

test('AUTH-A39 관리자 계정은 스스로 탈퇴할 수 없음', TAGS, async ({ tempUser, loginAs }) => {
  const admin = await tempUser('ADMIN');
  const { api } = await loginAs(admin);
  for (const [label, body] of [['맞는 비밀번호', { password: admin.password }], ['틀린 비밀번호(확인보다 먼저 막힘)', { password: 'Wrong1!pass' }]] as const) {
    const res = await api.raw('DELETE', '/api/user/me', body);
    const json = (await res.json()) as { code?: string };
    expect(res.status(), `${label} -> ${json.code}`).toBe(403);
    expect(json.code).toBe('ADMIN_CANNOT_WITHDRAW');
  }
  expect(userStatus(admin.id), '관리자 계정은 그대로').toBe('ACTIVE');
});

test('AUTH-A40 탈퇴 직후 옛 토큰·재로그인·열린 웹소켓', TAGS, async ({ tempUser, openAs }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const s = await signinRaw(user.email, user.password);
  expect(s.status).toBe(200);
  const { access, refresh } = tokensOf(s);

  const page = await openAs('anonymous', '/login');
  expect(await openStompWs(page, access), '준비: 웹소켓 연결').toBe(true);

  const del = await callBe('DELETE', '/api/user/me', { token: access, data: { password: user.password } });
  expect(del.status, `탈퇴 ${del.status} ${del.code}`).toBe(200);
  expect(isClearing(rtCookie(del)), '탈퇴 응답이 refresh 쿠키를 지운다').toBe(true);
  expect(userRowCount(user.id), '사용자 행 영구 삭제').toBe(0);

  const me = await callBe('GET', '/api/user/me', { token: access });
  expect(me.status, `옛 access ${me.status} ${me.code}`).toBe(401);
  const refreshed = await refreshByCookie(refresh);
  expect(refreshed.status, `옛 refresh ${refreshed.status} ${refreshed.code}`).toBe(401);
  await relaxAuthRates(RESET);
  const relogin = await signinRaw(user.email, user.password);
  expectFail(relogin, 401, 'INVALID_CREDENTIALS', '탈퇴 뒤 재로그인');

  const closed = await pollUntil(() => wsState(page), st => st.readyState === 3, 12_000);
  test.info().annotations.push({ type: '탈퇴 뒤 열린 웹소켓', description: `readyState ${closed.readyState}, 닫힘 ${JSON.stringify(closed.close ?? null)}` });
  expect(closed.readyState, `탈퇴한 계정의 열린 웹소켓이 닫혀야 한다 (readyState ${closed.readyState}, 1=열림 3=닫힘)`).toBe(3);
  expect(closed.close?.code, '닫힘 코드 1008').toBe(1008);
  expect(closed.close?.reason, '닫힘 사유').toBe('AUTH_INVALIDATED');
  void accessLogCount;
});
