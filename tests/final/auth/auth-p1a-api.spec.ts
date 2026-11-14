/**
 * 최종 QA - 인증(AUTH) P1a - API 케이스 (A07 A08 A50 A51 A41 N23 A25 A31 A33 A34)
 *
 * 임시 사용자와 임시 번호(010-0000-93xx 대역)만 쓴다. 인증코드는 필요한 곳에서만 Redis 에 직접 넣고,
 * 실제 문자는 A07·A08·N23 에서 각 1건만 나간다(E2E_SKIP_SMS=1 이면 나가지 않고 Redis 값으로 대신한다).
 * 속도 제한 카운터는 이 PC 의 IP 키만 비우거나 채우고, 끝나면 지운다.
 */
import { randomUUID } from 'node:crypto';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import { uniqueTestPhone } from '../../../src/seed';
import { suppressSosNotify } from '../../../src/variables';
import { ADDRESS } from '../../../src/accounts';
import { armSmsNonce, callBe, expectFail, relaxAuthRates, signinRaw, tokensOf, uniqueSuffix } from './_helpers-auth';
import {
  callBeAny,
  delMyRate,
  delMyRateDual,
  hammer,
  relaxMine,
  retryAfterOf,
  setMyHourCount,
  signinTokens,
  TAGS_P1,
} from './_helpers-auth-p1a';

test.beforeEach(() => relaxMine());

const exists = (key: string) => redis('EXISTS', key);

// ---------------------------------------------------------------------------------------------
// SMS 인증
// ---------------------------------------------------------------------------------------------

test('AUTH-A07 코드 5회 오류 시 초기화, 동시 요청으로도 5회 초과 불가, 5분 만료', TAGS_P1, async () => {
  test.setTimeout(240_000);
  const phone = uniqueTestPhone();
  const key = {
    verify: `sms:verify:${phone}`,
    attempt: `sms:attempt:${phone}`,
    verified: `sms:verified:${phone}`,
    count: `sms:sendcount:${phone}`,
  };
  const verify = (code: string) => callBe('POST', '/api/auth/signup/sms/verify', { data: { phone, code } });
  const seed = (ttl = 300) => {
    redis('SET', key.verify, '424242', 'EX', String(ttl));
    redis('DEL', key.attempt);
  };

  try {
    await test.step('발송 직후 코드 유효 시간은 5분 (실제 문자 1건)', async () => {
      if (env.skipSms) {
        test.info().annotations.push({ type: '건너뜀', description: 'E2E_SKIP_SMS=1 이라 실제 발송 단계는 하지 않았다' });
        return;
      }
      await delMyRate('signup-sms');
      const sent = await callBe('POST', '/api/auth/signup/sms/send', { data: { phone } });
      expect(sent.status, `발송 ${sent.status} ${sent.code}`).toBe(200);
      expect(sent.json?.data?.expiresInSeconds, '응답의 만료 초').toBe(300);
      const ttl = Number(redis('TTL', key.verify));
      expect(ttl, `코드 TTL ${ttl}초는 5분(300초) 안쪽`).toBeGreaterThan(270);
      expect(ttl).toBeLessThanOrEqual(300);
      expect(exists(key.attempt), '발송 직후 오류 횟수는 0').toBe('0');
    });

    await test.step('틀린 코드 5회 뒤에는 맞는 코드도 거절된다', async () => {
      await delMyRateDual('signup-sms-verify');
      seed();
      for (let i = 1; i <= 4; i++) {
        expectFail(await verify('000001'), 400, 'INVALID_SMS_CODE', `오답 ${i}회`);
      }
      expectFail(await verify('000001'), 400, 'SMS_TOO_MANY_ATTEMPTS', '오답 5회째');
      expect(exists(key.verify), '5회째에 코드가 무효화(삭제)된다').toBe('0');
      expectFail(await verify('424242'), 400, 'EXPIRED_SMS_CODE', '맞는 코드도 거절(재발송 필요)');
      expect(exists(key.verified), '인증 완료 표식(nonce)은 만들어지지 않는다').toBe('0');
    });

    await test.step('병렬 10건을 보내도 비교는 5회까지, 그 뒤 맞는 코드도 거절', async () => {
      await delMyRateDual('signup-sms-verify');
      seed();
      const results = await Promise.all(Array.from({ length: 10 }, () => verify('000001')));
      const codes = results.map(r => `${r.status} ${r.code}`);
      expect(results.every(r => r.status === 400), `병렬 응답이 모두 400 (${codes.join(', ')})`).toBe(true);
      const invalid = results.filter(r => r.code === 'INVALID_SMS_CODE').length;
      const tooMany = results.filter(r => r.code === 'SMS_TOO_MANY_ATTEMPTS').length;
      expect(invalid, `오답으로 비교된 요청은 4건 이하 (실제 ${invalid}건)`).toBeLessThanOrEqual(4);
      expect(tooMany, '시도 초과 응답이 1건 이상').toBeGreaterThanOrEqual(1);
      expect(exists(key.verify), '병렬 뒤 코드는 무효화돼 있다').toBe('0');
      await delMyRateDual('signup-sms-verify');
      expectFail(await verify('424242'), 400, 'EXPIRED_SMS_CODE', '병렬 뒤 맞는 코드도 거절');
      expect(exists(key.verified), '인증 완료 표식이 없다').toBe('0');
    });

    await test.step('5분이 지난 코드(만료)는 EXPIRED_SMS_CODE', async () => {
      await delMyRateDual('signup-sms-verify');
      seed(2);
      await expect.poll(() => exists(key.verify), { message: '코드가 만료돼 사라진다', timeout: 10_000 }).toBe('0');
      expectFail(await verify('424242'), 400, 'EXPIRED_SMS_CODE', '만료된 코드');
    });

    await test.step('확인 API 에도 IP 제한(분당 10회): 11번째는 429 + Retry-After', async () => {
      await delMyRateDual('signup-sms-verify');
      for (let i = 1; i <= 10; i++) {
        const res = await verify('000001');
        expectFail(res, 400, 'EXPIRED_SMS_CODE', `확인 ${i}번째(코드 없음)`);
      }
      const limited = await verify('000001');
      expectFail(limited, 429, 'TOO_MANY_REQUESTS', '확인 11번째');
      const wait = retryAfterOf(limited);
      expect(wait, `Retry-After ${wait}초는 1~60`).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
    });
  } finally {
    redis('DEL', key.verify, key.attempt, key.verified, key.count);
    await delMyRateDual('signup-sms-verify');
    await delMyRate('signup-sms');
  }
});

test('AUTH-A08 번호당 발송 1시간 10회 상한', TAGS_P1, async () => {
  test.setTimeout(120_000);
  const phone = uniqueTestPhone();
  const count = `sms:sendcount:${phone}`;
  const verifyKey = `sms:verify:${phone}`;
  try {
    await delMyRate('signup-sms');
    let before = '';
    if (!env.skipSms) {
      const first = await callBe('POST', '/api/auth/signup/sms/send', { data: { phone } });
      expect(first.status, `1번째 발송 ${first.status} ${first.code}`).toBe(200);
      expect(redis('GET', count), '발송 1건이면 번호당 카운터는 1').toBe('1');
      const ttl = Number(redis('TTL', count));
      expect(ttl, `카운터 창 ${ttl}초는 1시간(3600초) 안쪽`).toBeGreaterThan(3500);
      expect(ttl).toBeLessThanOrEqual(3600);
      before = redis('GET', verifyKey);
      expect(before, '발송된 코드가 저장돼 있다').toMatch(/^\d{6}$/);
    } else {
      test.info().annotations.push({ type: '건너뜀', description: 'E2E_SKIP_SMS=1 이라 실제 발송 1건 확인은 하지 않았다' });
    }

    // 10건 보낸 상태를 번호 카운터로 만든다(실제 문자 10건을 보내지 않는다 - 상한 비교는 BE 가 같은 카운터로 한다)
    redis('SET', count, '10', 'EX', '3600');
    const eleventh = await callBe('POST', '/api/auth/signup/sms/send', { data: { phone } });
    expectFail(eleventh, 429, 'TOO_MANY_REQUESTS', '11번째 발송');
    const wait = retryAfterOf(eleventh);
    expect(wait, `Retry-After ${wait}초는 1~3600`).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(3600);
    expect(eleventh.json?.data?.retryAfterSeconds, '본문의 남은 대기 시간이 헤더와 같다').toBe(wait);
    if (before) expect(redis('GET', verifyKey), '거절된 11번째는 코드를 새로 만들지 않는다(문자 없음)').toBe(before);

    // 재발송 경로도 같은 상한을 쓴다
    const resend = await callBe('POST', '/api/auth/signup/sms/resend', { data: { phone } });
    expectFail(resend, 429, 'TOO_MANY_REQUESTS', '재발송도 같은 상한');
    test.info().annotations.push({
      type: '확인한 점',
      description: '429 의 message 는 일반 문구("요청이 너무 많습니다...")이고 남은 시간은 Retry-After 헤더와 data.retryAfterSeconds 로 내려온다',
    });
  } finally {
    redis('DEL', count, verifyKey, `sms:attempt:${phone}`);
    await delMyRate('signup-sms');
  }
});

// ---------------------------------------------------------------------------------------------
// 공통 보안
// ---------------------------------------------------------------------------------------------

test('AUTH-A50 토큰 무효화 값이 손상(숫자 아님·음수·미래)이면 503, SOS 만 통과', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const ward = await tempUser('WARD');
  const { access } = await signinTokens(ward.email, ward.password);
  const key = `password:invalidate:${ward.id}`;
  const cooldown = `sos:notify:cooldown:${ward.id}`;
  suppressSosNotify(ward.id, 600); // 보호자 알림(푸시·문자)은 나가지 않게 한다

  const corrupt: [string, string][] = [
    ['숫자 아님', 'not-a-number'],
    ['음수', '-5'],
    ['먼 미래', String(Math.floor(Date.now() / 1000) + 86_400)],
  ];
  try {
    expect((await callBe('GET', '/api/user/me', { token: access })).status, '준비: 손상 전에는 정상').toBe(200);
    for (const [label, value] of corrupt) {
      redis('SET', key, value, 'EX', '300');
      expectFail(await callBe('GET', '/api/user/me', { token: access }), 503, 'SERVICE_UNAVAILABLE', `${label}: 일반 API`);
      expectFail(await callBe('GET', '/api/ward/medication/today', { token: access }), 503, 'SERVICE_UNAVAILABLE', `${label}: 다른 일반 API`);
      const sos = await callBe('POST', '/api/ward/sos', { token: access, data: {} });
      expect(sos.status, `${label}: SOS 는 통과해야 한다 (${sos.status} ${sos.code})`).toBeLessThan(300);
    }
    redis('DEL', key);
    expect((await callBe('GET', '/api/user/me', { token: access })).status, '키를 지우면 다시 정상').toBe(200);
  } finally {
    redis('DEL', key, cooldown);
  }
  test.info().annotations.push({
    type: '재현 범위',
    description: '임시 피보호자 1명의 무효화 키 값만 바꿔 재현했다. SOS 는 3건 보내 sos_event 가 생기며 보호자 알림은 쿨다운 키로 막았다',
  });
});

test('AUTH-A51 로그인 사용자 전체 요청 1분 600회 제한', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(240_000);
  const user = await tempUser('WARD');
  const other = await tempUser('GUARDIAN');
  const a = await signinTokens(user.email, user.password);
  const b = await signinTokens(other.email, other.password);
  const keyA = `rate:user-api:${user.id}`;
  const keyB = `rate:user-api:${other.id}`;
  try {
    redis('DEL', keyA, keyB);
    const statuses = await hammer('/api/user/me', a.access, 600, 20);
    const ok = statuses.filter(s => s === 200).length;
    expect(ok, `600번째까지는 모두 200 (200 ${ok}건, 그 밖 ${statuses.filter(s => s !== 200).join(',') || '없음'})`).toBe(600);
    const ttl = Number(redis('TTL', keyA));
    expect(ttl, `집계 창이 아직 살아 있어야 한다 (TTL ${ttl}초)`).toBeGreaterThan(0);

    const over = await callBe('GET', '/api/user/me', { token: a.access });
    expectFail(over, 429, 'TOO_MANY_REQUESTS', '601번째');
    const wait = retryAfterOf(over);
    expect(wait, `Retry-After ${wait}초는 1~60`).toBeGreaterThanOrEqual(1);
    expect(wait).toBeLessThanOrEqual(60);

    const counted = redis('GET', keyA);
    const sosSetting = await callBe('GET', '/api/ward/sos-setting', { token: a.access });
    expect(sosSetting.status, `SOS 경로(sos-setting)는 제한과 무관하게 통과 (${sosSetting.status} ${sosSetting.code})`).toBe(200);
    const preflight = await callBeAny('OPTIONS', '/api/user/me', {
      headers: {
        Origin: env.baseUrl,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    expect(preflight.status, `OPTIONS 는 제한 대상이 아니다 (${preflight.status})`).not.toBe(429);
    const authCall = await callBe('POST', '/api/auth/find-email', { token: a.access, data: { name: 'E2E없는사람', phone: '01000009999' } });
    expect(authCall.status, `/api/auth/** 는 사용자 제한 대상이 아니다 (${authCall.status} ${authCall.code})`).not.toBe(429);
    expect(redis('GET', keyA), 'SOS·OPTIONS·auth 호출은 사용자 카운터를 올리지 않는다').toBe(counted);

    const second = await callBe('GET', '/api/user/me', { token: b.access });
    expect(second.status, `다른 사용자 토큰은 따로 집계돼 정상 (${second.status} ${second.code})`).toBe(200);
    expect(redis('GET', keyB), '다른 사용자 카운터는 1').toBe('1');
  } finally {
    redis('DEL', keyA, keyB);
    await delMyRate('find-email');
  }
  test.info().annotations.push({
    type: '확인하지 않은 점',
    description: 'USER_RATE_LIMIT_ENABLED=false 이면 제한이 없다는 부분은 서버 설정을 바꿀 수 없어 확인하지 않았다',
  });
});

// ---------------------------------------------------------------------------------------------
// 내 정보
// ---------------------------------------------------------------------------------------------

function profileBody(over: Record<string, unknown> = {}) {
  return {
    name: 'E2E수정이름',
    phone: '01000000000',
    gender: 'FEMALE',
    birthDate: '1980-02-03',
    postcode: ADDRESS.postcode,
    address: ADDRESS.address,
    addressDetail: 'E2E 수정동 202호',
    ...over,
  };
}

test('AUTH-A41 프로필 수정 검증: 필수 누락, 번호 변경 시 nonce 없음, 이미 쓰는 번호', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const other = await tempUser('GUARDIAN');
  const { access } = await signinTokens(user.email, user.password);
  const put = (data: unknown) => callBe('PUT', '/api/user/me', { token: access, data });
  const newPhone = uniqueTestPhone();
  const keys = [`sms:verified:${newPhone}`, `sms:verified:${other.phone}`];

  try {
    await test.step('필수 누락은 400', async () => {
      const { name: _name, ...noName } = profileBody({ phone: user.phone });
      expectFail(await put(noName), 400, 'INVALID_INPUT', '이름 누락');
      expectFail(await put({ name: 'E2E부분수정' }), 400, 'INVALID_INPUT', '이름만 보냄(부분 수정)');
      expectFail(await put(profileBody({ phone: user.phone, postcode: '' })), 400, 'INVALID_INPUT', '우편번호 비움');
    });

    await test.step('번호를 바꾸는데 nonce 가 없거나 틀리면 SMS_NOT_VERIFIED 400', async () => {
      expectFail(await put(profileBody({ phone: newPhone })), 400, 'SMS_NOT_VERIFIED', 'nonce 없음');
      const real = armSmsNonce(newPhone);
      expectFail(await put(profileBody({ phone: newPhone, verificationNonce: randomUUID() })), 400, 'SMS_NOT_VERIFIED', 'nonce 불일치');
      expect(redis('GET', keys[0]), '틀린 nonce 는 인증 상태를 지우지 않는다').toBe(real);
      expect(psql(`SELECT phone FROM users WHERE id = ${sqlStr(user.id)};`), '번호는 바뀌지 않았다').toBe(user.phone);
    });

    await test.step('이미 쓰는 번호로 바꾸면 막히고, SMS 인증 상태는 남는다', async () => {
      const nonce = armSmsNonce(other.phone as string);
      const res = await put(profileBody({ phone: other.phone, verificationNonce: nonce }));
      expectFail(res, 409, 'PHONE_ALREADY_EXISTS', '다른 회원 번호로 변경');
      expect(redis('GET', keys[1]), '막혀도 인증 완료 표식(nonce)은 남는다').toBe(nonce);
      expect(psql(`SELECT phone FROM users WHERE id = ${sqlStr(user.id)};`), '번호는 바뀌지 않았다').toBe(user.phone);
    });
  } finally {
    redis('DEL', ...keys);
  }
  test.info().annotations.push({
    type: '문서와 다른 점',
    description: '문서는 이미 쓰는 번호의 상태 코드를 적지 않았다. 배포 코드는 409 PHONE_ALREADY_EXISTS (번호 중복 확인이 nonce 소비보다 먼저)',
  });
});

test('AUTH-N23 전화번호 변경은 새 번호 SMS 인증+nonce, 미변경은 nonce 생략', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const { access } = await signinTokens(user.email, user.password);
  const newPhone = uniqueTestPhone();
  const verifiedKey = `sms:verified:${newPhone}`;
  const stored = () => psql(`SELECT phone FROM users WHERE id = ${sqlStr(user.id)};`);
  try {
    await test.step('번호 변경: 새 번호로 인증한 nonce 와 함께 200', async () => {
      let nonce: string;
      if (env.skipSms) {
        nonce = armSmsNonce(newPhone);
        test.info().annotations.push({ type: '건너뜀', description: 'E2E_SKIP_SMS=1 이라 실제 문자 대신 Redis 에 인증 표식을 넣었다' });
      } else {
        await delMyRate('signup-sms');
        await delMyRateDual('signup-sms-verify');
        const sent = await callBe('POST', '/api/auth/signup/sms/send', { data: { phone: newPhone } });
        expect(sent.status, `새 번호로 발송 ${sent.status} ${sent.code}`).toBe(200);
        const code = redis('GET', `sms:verify:${newPhone}`);
        expect(code, '저장된 코드').toMatch(/^\d{6}$/);
        const checked = await callBe('POST', '/api/auth/signup/sms/verify', { data: { phone: newPhone, code } });
        expect(checked.status, `코드 확인 ${checked.status} ${checked.code}`).toBe(200);
        nonce = checked.json?.data?.verificationNonce as string;
        expect(nonce, 'verificationNonce(UUID)').toMatch(/^[0-9a-f-]{36}$/);
      }
      const res = await callBe('PUT', '/api/user/me', { token: access, data: profileBody({ phone: newPhone, verificationNonce: nonce }) });
      expect(res.status, `번호 변경 ${res.status} ${res.code}`).toBe(200);
      expect(stored(), 'DB 의 번호가 새 번호').toBe(newPhone);
      expect(redis('EXISTS', verifiedKey), '쓴 nonce 는 소비된다').toBe('0');
    });

    await test.step('번호 그대로 수정: nonce 없이 200', async () => {
      const res = await callBe('PUT', '/api/user/me', { token: access, data: profileBody({ phone: newPhone, name: 'E2E번호그대로' }) });
      expect(res.status, `번호 미변경 수정 ${res.status} ${res.code}`).toBe(200);
      expect(res.json?.data?.name, '이름은 바뀐다').toBe('E2E번호그대로');
      expect(stored(), '번호는 그대로').toBe(newPhone);
    });
  } finally {
    redis('DEL', verifiedKey, `sms:verify:${newPhone}`, `sms:attempt:${newPhone}`, `sms:sendcount:${newPhone}`);
    await delMyRate('signup-sms');
    await delMyRateDual('signup-sms-verify');
  }
});

// ---------------------------------------------------------------------------------------------
// 로그아웃
// ---------------------------------------------------------------------------------------------

test('AUTH-A25 미인증·블랙리스트 토큰으로 logout 은 401 JSON', TAGS_P1, async ({ tempUser }) => {
  const user = await tempUser('GUARDIAN');
  const expectJson401 = (raw: Awaited<ReturnType<typeof callBe>>, label: string, code = 'LOGIN_REQUIRED') => {
    expect(raw.status, `${label}: 상태 ${raw.status} ${raw.code}`).toBe(401);
    expect(raw.headers.location, `${label}: 리다이렉트가 아니다`).toBeUndefined();
    expect(raw.headers['content-type'] ?? '', `${label}: JSON 응답`).toContain('json');
    expect(raw.json?.success, `${label}: success=false`).toBe(false);
    expect(raw.code, `${label}: 에러 코드`).toBe(code);
  };

  expectJson401(await callBe('POST', '/api/auth/logout'), '토큰 없음');
  expectJson401(await callBe('POST', '/api/auth/logout', { token: 'e2e.not.a.jwt' }), '엉터리 토큰', 'INVALID_TOKEN');

  const { access, refresh } = await signinTokens(user.email, user.password);
  const out = await callBe('POST', '/api/auth/logout', { token: access, headers: { Cookie: `careai_rt=${refresh}` } });
  expect(out.status, `첫 로그아웃 ${out.status} ${out.code}`).toBe(200);
  expectJson401(await callBe('POST', '/api/auth/logout', { token: access }), '이미 로그아웃한 토큰');
});

// ---------------------------------------------------------------------------------------------
// 비밀번호 재설정
// ---------------------------------------------------------------------------------------------

test('AUTH-A31 send 미가입 404, 카카오 가입 계정 400, 발송 전 차단', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const kakao = await tempUser('GUARDIAN', { provider: 'KAKAO' });
  const ghostEmail = `e2e.ghost.${uniqueSuffix()}@silverbridge.test`;
  const ghostPhone = uniqueTestPhone();
  const watch = [
    `password:email:verify:${ghostEmail}`,
    `password:email:sendcount:${ghostEmail}`,
    `password:email:verify:${kakao.email}`,
    `password:email:sendcount:${kakao.email}`,
    `password:sms:verify:${ghostPhone}`,
    `sms:sendcount:${ghostPhone}`,
    `password:sms:verify:${kakao.phone}`,
    `sms:sendcount:${kakao.phone}`,
  ];
  try {
    await delMyRateDual('pw-reset-email', 'pw-reset-sms');
    expectFail(await callBe('POST', '/api/auth/find-password/email/send', { data: { email: ghostEmail } }), 404, 'EMAIL_ACCOUNT_NOT_FOUND', '미가입 이메일 send');
    expectFail(await callBe('POST', '/api/auth/find-password/email/resend', { data: { email: ghostEmail } }), 404, 'EMAIL_ACCOUNT_NOT_FOUND', '미가입 이메일 resend');
    expectFail(await callBe('POST', '/api/auth/find-password/sms/send', { data: { name: 'E2E없는사람', phone: ghostPhone } }), 404, 'USER_NOT_FOUND', '미가입 이름·번호 send');
    expectFail(await callBe('POST', '/api/auth/find-password/email/send', { data: { email: kakao.email } }), 400, 'SOCIAL_USER_NO_PASSWORD', '카카오 계정 이메일 send');
    expectFail(await callBe('POST', '/api/auth/find-password/sms/send', { data: { name: kakao.name, phone: kakao.phone } }), 400, 'SOCIAL_USER_NO_PASSWORD', '카카오 계정 SMS send');

    // 발송 전에 막혔으니 코드도 발송 횟수 카운터도 생기지 않는다(카운터는 메일·문자를 보내기 전에 올리므로, 없다면 보내지 않은 것)
    for (const key of watch) expect(redis('EXISTS', key), `발송 흔적 없음: ${key.replace(/@.*/, '@...')}`).toBe('0');
  } finally {
    redis('DEL', ...watch);
    await delMyRateDual('pw-reset-email', 'pw-reset-sms');
  }
});

test('AUTH-A33 발송·재설정 속도 제한', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(240_000);
  const user = await tempUser('GUARDIAN');
  const ghost = () => `e2e.ghost.${uniqueSuffix()}@silverbridge.test`;
  const sendCount = (email: string) => `password:email:sendcount:${email}`;
  const created: string[] = [sendCount(user.email), `password:email:verify:${user.email}`];
  const sendBody = (email: string) => ({ data: { email } });

  try {
    await test.step('IP 1분 10회: 11번째 send/resend 는 429 (미가입 이메일이라 메일은 안 나간다)', async () => {
      await delMyRateDual('pw-reset-email');
      for (let i = 1; i <= 10; i++) {
        const email = ghost();
        const res = await callBe('POST', i % 2 ? '/api/auth/find-password/email/send' : '/api/auth/find-password/email/resend', sendBody(email));
        expectFail(res, 404, 'EMAIL_ACCOUNT_NOT_FOUND', `${i}번째`);
        created.push(sendCount(email));
      }
      const limited = await callBe('POST', '/api/auth/find-password/email/resend', sendBody(ghost()));
      expectFail(limited, 429, 'TOO_MANY_REQUESTS', '11번째(send 와 resend 가 같은 한도)');
      const wait = retryAfterOf(limited);
      expect(wait, `분 창이라 Retry-After ${wait}초는 1~60`).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
    });

    await test.step('IP 1시간 30회: 31번째는 429, 대기 시간은 시간 창 기준', async () => {
      await delMyRateDual('pw-reset-email');
      await setMyHourCount('pw-reset-email', 29); // 이미 29번 불렀다고 두고 실제로 2번 부른다
      expectFail(await callBe('POST', '/api/auth/find-password/email/send', sendBody(ghost())), 404, 'EMAIL_ACCOUNT_NOT_FOUND', '30번째');
      const limited = await callBe('POST', '/api/auth/find-password/email/send', sendBody(ghost()));
      expectFail(limited, 429, 'TOO_MANY_REQUESTS', '31번째');
      const wait = retryAfterOf(limited);
      expect(wait, `시간 창이라 Retry-After ${wait}초는 60 초과`).toBeGreaterThan(60);
      expect(wait).toBeLessThanOrEqual(3600);
    });

    await test.step('같은 이메일 1시간 10회: 11번째는 429, 미가입 요청은 per-email 카운트에 안 들어간다', async () => {
      await delMyRateDual('pw-reset-email');
      const unknown = ghost();
      created.push(sendCount(unknown));
      expectFail(await callBe('POST', '/api/auth/find-password/email/send', sendBody(unknown)), 404, 'EMAIL_ACCOUNT_NOT_FOUND', '미가입 요청');
      expect(redis('EXISTS', sendCount(unknown)), '미가입 이메일은 per-email 카운터가 생기지 않는다').toBe('0');

      // 가입 이메일로 10번 보낸 상태(실제 메일 10통을 보내지 않는다 - 상한 비교는 BE 가 같은 카운터로 한다)
      redis('SET', sendCount(user.email), '10', 'EX', '3600');
      const limited = await callBe('POST', '/api/auth/find-password/email/send', sendBody(user.email));
      expectFail(limited, 429, 'TOO_MANY_REQUESTS', '같은 이메일 11번째');
      expect(redis('EXISTS', `password:email:verify:${user.email}`), '거절된 요청은 코드를 만들지 않는다(메일 없음)').toBe('0');
      const wait = retryAfterOf(limited);
      expect(wait, `per-email 창 ${wait}초는 1~3600`).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(3600);
    });

    await test.step('SMS 발송도 IP 1분 10회(이름·번호 불일치라 문자는 안 나간다)', async () => {
      await delMyRateDual('pw-reset-sms');
      for (let i = 1; i <= 10; i++) {
        const res = await callBe('POST', '/api/auth/find-password/sms/send', { data: { name: 'E2E없는사람', phone: '01000009998' } });
        expectFail(res, 404, 'USER_NOT_FOUND', `SMS ${i}번째`);
      }
      expectFail(await callBe('POST', '/api/auth/find-password/sms/send', { data: { name: 'E2E없는사람', phone: '01000009998' } }), 429, 'TOO_MANY_REQUESTS', 'SMS 11번째');
    });

    await test.step('reset 1분 10회: 11번째는 429', async () => {
      await relaxAuthRates(['rate:pw-reset-confirm:*']);
      const body = { email: ghost(), code: '000000', newPassword: 'NewPass1!x' };
      for (let i = 1; i <= 10; i++) {
        expectFail(await callBe('POST', '/api/auth/password/reset', { data: body }), 400, 'EXPIRED_SMS_CODE', `reset ${i}번째(코드 없음)`);
      }
      expectFail(await callBe('POST', '/api/auth/password/reset', { data: body }), 429, 'TOO_MANY_REQUESTS', 'reset 11번째');
    });
  } finally {
    redis('DEL', ...created);
    await delMyRateDual('pw-reset-email', 'pw-reset-sms');
    await relaxAuthRates(['rate:pw-reset-confirm:*']);
  }
  test.info().annotations.push({
    type: '문서와 같은 점',
    description: '문서의 "1분 11회째 429"는 코드의 "분당 10회 초과"와 같다. 같은 이메일 상한은 1시간 10회(11번째 429)',
  });
});

test('AUTH-A34 새 비번 규칙 위반, email·phone 둘 다/둘 다 없음은 400', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const verifyKey = `password:email:verify:${user.email}`;
  const attemptKey = `password:email:attempt:${user.email}`;
  const reset = (data: Record<string, unknown>) => callBe('POST', '/api/auth/password/reset', { data });
  try {
    await relaxAuthRates(['rate:pw-reset-confirm:*']);
    redis('SET', verifyKey, '123456', 'EX', '300');

    expectFail(await reset({ email: user.email, code: '123456', newPassword: 'abc' }), 400, 'INVALID_INPUT', '너무 짧은 비밀번호');
    expectFail(await reset({ email: user.email, code: '123456', newPassword: 'Abcdefgh1' }), 400, 'INVALID_INPUT', '특수문자 없는 비밀번호');
    expectFail(await reset({ email: user.email, phone: user.phone, code: '123456', newPassword: 'NewPass1!x' }), 400, 'INVALID_INPUT', 'email 과 phone 을 함께 보냄');
    expectFail(await reset({ code: '123456', newPassword: 'NewPass1!x' }), 400, 'INVALID_INPUT', 'email·phone 둘 다 없음');

    expect(redis('EXISTS', verifyKey), '거절된 요청은 인증코드를 소비하지 않는다').toBe('1');
    await relaxAuthRates();
    const stillOld = await signinRaw(user.email, user.password);
    expect(stillOld.status, `비밀번호는 바뀌지 않았다 (로그인 ${stillOld.status} ${stillOld.code})`).toBe(200);
    expect(tokensOf(stillOld).access).toBeTruthy();
  } finally {
    redis('DEL', verifyKey, attemptKey);
    await relaxAuthRates(['rate:pw-reset-confirm:*']);
  }
});
