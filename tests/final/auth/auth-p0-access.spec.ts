/**
 * 최종 QA - 인증(AUTH) P0 - 권한·IDOR·저장소(Redis) 장애 (A45 A47 A48 A49)
 *
 * 임시 사용자만 쓴다. Redis 서버 자체는 멈추지 않는다(금지). 대신 "그 임시 사용자 한 명의 키"를 문자열이 아닌 해시 타입으로 만들어
 * 저장소 조회가 오류(WRONGTYPE)를 내게 하는 방식으로 장애 경로를 재현한다 (기존 tests/variables/auth-medium.spec.ts AUTH-G21 과 같은 방식).
 * 이 방식은 키가 그 사용자 것인 경로(무효화·로그인 실패 횟수·인증코드 시도·발송 상한)만 재현한다.
 */
import { expect, test } from '../../../src/fixtures';
import { countBackendLog, redis, redisDelPattern } from '../../../src/remote';
import { connect, loginViaForm, suppressSosNotify } from '../../../src/variables';
import {
  callBe,
  expectFail,
  openMenuNav,
  pollUntil,
  relaxAuthRates,
  signinRaw,
  tokensOf,
  wsHandshakeStatus,
  TAGS,
} from './_helpers-auth';

test.beforeEach(() => relaxAuthRates());

test('AUTH-A45 로그인 없음 401, 역할 다름 403', TAGS, async ({ tempUser, loginAs, openAs }) => {
  test.setTimeout(240_000);
  const guardian = await tempUser('GUARDIAN');
  const ward = await tempUser('WARD');
  const admin = await tempUser('ADMIN');
  const g = await loginAs(guardian);
  const w = await loginAs(ward);

  await test.step('API: 토큰 없음/위조 401, 역할이 다르면 403', async () => {
    const none = await callBe('GET', '/api/user/me');
    expectFail(none, 401, 'LOGIN_REQUIRED', '토큰 없음');
    const forged = await callBe('GET', '/api/user/me', { token: 'forged.token.value' });
    expect(forged.status, `위조 토큰 ${forged.status} ${forged.code}`).toBe(401);

    const guardianToWard = await g.api.raw('GET', '/api/ward/medication/today');
    expect(guardianToWard.status(), 'GUARDIAN -> /api/ward/**').toBe(403);
    const wardToGuardian = await w.api.raw('GET', '/api/guardian/medication');
    expect(wardToGuardian.status(), 'WARD -> /api/guardian/**').toBe(403);
    for (const [label, who] of [['GUARDIAN', g], ['WARD', w]] as const) {
      const res = await who.api.raw('GET', '/api/admin/user');
      expect(res.status(), `${label} -> /api/admin/**`).toBe(403);
      expect(((await res.json()) as { message?: string }).message, `${label} 거부 문구`).toBe('접근 권한이 없습니다.');
    }
  });

  await test.step('화면: 로그인 안 하면 로그인 화면으로, 다른 역할 화면 주소는 내 홈으로', async () => {
    for (const path of ['/guardian', '/ward', '/admin']) {
      const anon = await openAs('anonymous', path);
      await expect(anon, `비로그인 ${path}`).toHaveURL(/\/login$/);
    }

    await relaxAuthRates();
    const gp = await openAs('anonymous', '/login');
    await loginViaForm(gp, guardian.email, guardian.password);
    await expect(gp).toHaveURL(/\/guardian$/);
    await gp.goto('/ward');
    await expect(gp, '보호자가 피보호자 화면 주소로 들어가면 보호자 홈').toHaveURL(/\/guardian$/);
    await gp.goto('/admin');
    await expect(gp, '보호자가 관리자 화면 주소로 들어가면 보호자 홈').toHaveURL(/\/guardian$/);

    await relaxAuthRates();
    const wp = await openAs('anonymous', '/login');
    await loginViaForm(wp, ward.email, ward.password);
    await expect(wp).toHaveURL(/\/ward$/);
    await wp.goto('/guardian');
    await expect(wp, '피보호자가 보호자 화면 주소로 들어가면 피보호자 홈').toHaveURL(/\/ward$/);
    await wp.goto('/admin');
    await expect(wp, '피보호자가 관리자 화면 주소로 들어가면 피보호자 홈').toHaveURL(/\/ward$/);
  });

  await test.step('관리자 로그인: 빈 화면이 아니라 관리자 화면이 보인다', async () => {
    await relaxAuthRates();
    const ap = await openAs('anonymous', '/login');
    await loginViaForm(ap, admin.email, admin.password);
    await expect(ap).toHaveURL(/\/admin/);
    await expect(ap.getByRole('main').first(), '관리자 화면 본문이 그려진다 (빈 화면 아님)').toBeVisible();
    await openMenuNav(ap, '관리자');
  });
});

test('AUTH-A47 없는 자원 404, 남의 챗 기록 404, 대기 중 요청은 연결이 아님', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(180_000);
  const guardian = await tempUser('GUARDIAN');
  const ward = await tempUser('WARD');
  const g = await loginAs(guardian);
  const MISSING = 999999999;

  await test.step('없는 id 는 *_NOT_FOUND 404', async () => {
    const cases: [string, string, string, string][] = [
      ['공지 상세', 'GET', `/api/commonness/announcement/select/detail/${MISSING}`, 'ANNOUNCEMENT_NOT_FOUND'],
      ['문의 상세', 'GET', `/api/guardian/inquiry/${MISSING}`, 'INQUIRY_NOT_FOUND'],
      ['약 삭제', 'DELETE', `/api/guardian/medication/${MISSING}`, 'MEDICATION_NOT_FOUND'],
    ];
    for (const [label, method, path, code] of cases) {
      const res = await g.api.raw(method as 'GET' | 'DELETE', path);
      const json = (await res.json().catch(() => ({}))) as { code?: string };
      expect(res.status(), `${label} ${json.code}`).toBe(404);
      expect(json.code, label).toBe(code);
    }
  });

  await test.step('남의(없는) 챗 기록 상세는 CHAT_LOG_NOT_FOUND 404 - 없는 기록과 구분하지 않는다', async () => {
    const res = await g.api.raw('GET', `/api/guardian/chat/logs/${MISSING}`);
    const json = (await res.json().catch(() => ({}))) as { code?: string };
    expect(res.status(), `보호자 챗 기록 ${json.code}`).toBe(404);
    expect(json.code).toBe('CHAT_LOG_NOT_FOUND');
  });

  await test.step('수락 대기 중인 요청은 연결이 아니다: 피보호자 정보 조회 403', async () => {
    const request = await g.api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation: '딸' });
    expect(request.status(), `준비: 연결 요청 ${await request.text()}`).toBe(200);
    const res = await g.api.raw('GET', `/api/guardian/ward/${ward.id}/medication-alert-setting`);
    const json = (await res.json().catch(() => ({}))) as { code?: string };
    expect(res.status(), `대기 중 요청 상태에서 조회 ${json.code}`).toBe(403);
    expect(json.code).toBe('MEDICATION_NOT_AUTHORIZED');
  });

  await test.step('형식이 틀린 wardId(영숫자 1~6자 아님): 403 이고 로그에는 원문 대신 길이만 남는다', async () => {
    const raw = `ZQXWV${Date.now().toString(36).toUpperCase()}`.replace(/[^A-Z0-9]/g, '').slice(0, 12).padEnd(10, 'Q');
    expect(raw.length, '준비: 7자 이상').toBeGreaterThan(6);
    const res = await g.api.raw('GET', `/api/guardian/ward/${raw}/medication-alert-setting`);
    expect(res.status(), '형식 오류 wardId').toBe(403);
    const needle = `형식이 맞지 않는 피보호자 ID로 복약 설정 접근 시도: guardianId=${guardian.id}`;
    const lines = await pollUntil(() => countBackendLog(needle, 120), n => n >= 1, 15_000, 1500);
    expect(lines, '형식 오류 시도가 [IDOR-ATTEMPT] 로그로 남는다').toBeGreaterThanOrEqual(1);
    // 형식 오류 시도 로그([IDOR-ATTEMPT])는 wardId 원문이 아니라 길이(wardIdLength)만 남긴다. 요청 경로 전체를 찍는 일반 API 로그(ApiLoggingAspect)는 이 검사 대상이 아니다
    expect(countBackendLog(`wardIdLength=${raw.length}`, 120), '로그에 길이(wardIdLength)가 남는다').toBeGreaterThanOrEqual(1);
    expect(countBackendLog(`wardId=${raw}`, 120), 'IDOR 로그에 wardId 원문이 나오면 안 된다 (길이만)').toBe(0);
    test.info().annotations.push({ type: '참고', description: '일반 API 로그(ApiLoggingAspect)에는 요청 경로(잘못된 wardId 원문 포함)가 그대로 찍힌다' });
  });
});

test('AUTH-A48 Redis 장애 시 일반 API 503, SOS 만 통과', TAGS, async ({ tempUser, loginAs }) => {
  const ward = await tempUser('WARD');
  const guardian = await tempUser('GUARDIAN');
  connect(guardian.id, ward.id);
  const { login } = await loginAs(ward);
  suppressSosNotify(ward.id, 300); // 보호자 알림(푸시·문자)은 나가지 않게 한다
  const key = `password:invalidate:${ward.id}`;

  try {
    expect((await callBe('GET', '/api/user/me', { token: login.accessToken })).status, '준비: 장애 재현 전 정상').toBe(200);

    // 준비: 같은 임시 사용자의 두 번째 세션을 만들어 로그아웃시킨다 (장애 중에 로그아웃된 토큰이 되살아나지 않는지 보려고)
    await relaxAuthRates();
    const second = tokensOf(await signinRaw(ward.email, ward.password));
    expect(second.access, '준비: 두 번째 세션 access').toBeTruthy();
    const out = await callBe('POST', '/api/auth/logout', { token: second.access, headers: { Cookie: `careai_rt=${second.refresh}` } });
    expect(out.status, `준비: 두 번째 세션 로그아웃 ${out.status}`).toBe(200);
    expectFail(await callBe('GET', '/api/user/me', { token: second.access }), 401, 'LOGIN_REQUIRED', '준비: 로그아웃된 토큰');

    // 이 임시 사용자의 무효화 키만 조회 오류가 나게 한다 (Redis 장애 대역)
    redis('DEL', key);
    redis('HSET', key, 'e2e', '1');
    redis('EXPIRE', key, '300');
    expect(redis('TYPE', key), '준비: 해시 타입').toBe('hash');

    const general = await callBe('GET', '/api/user/me', { token: login.accessToken });
    expectFail(general, 503, 'SERVICE_UNAVAILABLE', '일반 API');
    const other = await callBe('GET', '/api/ward/medication/today', { token: login.accessToken });
    expectFail(other, 503, 'SERVICE_UNAVAILABLE', '다른 일반 경로도 통과하지 않는다');

    const sos = await callBe('POST', '/api/ward/sos', { token: login.accessToken, data: {} });
    expect(sos.status, `SOS 는 저장소 장애와 무관하게 통과해야 한다: ${sos.status} ${sos.code}`).toBeLessThan(300);

    const ws = await wsHandshakeStatus(login.accessToken);
    expect(ws, '웹소켓 연결은 503 으로 거부된다 (101 이면 통과해 버린 것)').toBe(503);

    const logged = await pollUntil(() => countBackendLog('AUTH-STORE-UNAVAILABLE', 120), n => n >= 1, 10_000, 1500);
    expect(logged, '서버 로그에 [AUTH-STORE-UNAVAILABLE]').toBeGreaterThanOrEqual(1);

    // 장애 중에도 이미 로그아웃된 토큰은 풀리지 않는다: 일반 API 는 200 이 아니다 (401 또는 503)
    const dead = await callBe('GET', '/api/user/me', { token: second.access });
    expect([401, 503], `장애 중 로그아웃된 토큰으로 일반 API: ${dead.status} ${dead.code}`).toContain(dead.status);
    const deadSos = await callBe('POST', '/api/ward/sos', { token: second.access, data: {} });
    test.info().annotations.push({
      type: '장애 중 로그아웃된 토큰으로 SOS',
      description: `${deadSos.status} ${deadSos.code ?? ''} (SOS 는 저장소 장애 때 통과시키는 경로라, 로그아웃된 토큰이 통과하는지 결과만 기록한다)`,
    });
  } finally {
    redis('DEL', key);
  }
  const recovered = await callBe('GET', '/api/user/me', { token: login.accessToken });
  expect(recovered.status, '키를 정리하면 다시 정상').toBe(200);

  test.info().annotations.push({
    type: '재현 범위',
    description: 'Redis 서버를 멈추지 않고 임시 사용자 1명의 키를 해시 타입으로 바꿔 재현했다. SOS 는 실제로 1건(많으면 2건) 보내 sos_event 가 생기며, 보호자 알림은 쿨다운 키로 막았다',
  });

  await test.step('키 퇴출 정책: noeviction (설정을 읽기만 한다)', async () => {
    const policy = redis('CONFIG', 'GET', 'maxmemory-policy').split('\n').pop()?.trim();
    expect(policy, `maxmemory-policy 가 ${policy}: 메모리가 차면 로그아웃 블랙리스트·잠금 키가 퇴출돼 로그아웃된 토큰이 풀릴 수 있다`).toBe('noeviction');
  });
});

test('AUTH-A49 Redis 장애: 속도 제한 fail-open, 잠금·인증번호·발송 상한 fail-closed 503', TAGS, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const failKey = `login:fail:${user.id}`;
  const verifyKey = `password:email:verify:${user.email}`;
  const attemptKey = `password:email:attempt:${user.email}`;
  const sendKey = `password:email:sendcount:${user.email}`;
  const breakKey = (key: string) => {
    redis('DEL', key);
    redis('HSET', key, 'e2e', '1');
    redis('EXPIRE', key, '300');
  };

  try {
    await test.step('로그인 잠금 저장소 오류: 풀어 주지 않고 500 이 아니라 503', async () => {
      breakKey(failKey);
      const res = await signinRaw(user.email, user.password);
      expectFail(res, 503, 'SERVICE_UNAVAILABLE', '로그인(잠금 횟수 저장소 오류)');
      redis('DEL', failKey);
      await relaxAuthRates();
      expect((await signinRaw(user.email, user.password)).status, '복구 뒤 정상 로그인').toBe(200);
    });

    await test.step('인증번호 시도 횟수 저장소 오류: 비교를 허용하지 않고 503', async () => {
      await relaxAuthRates(['rate:pw-reset-confirm:*']);
      redis('SET', verifyKey, '123456', 'EX', '300');
      breakKey(attemptKey);
      const res = await callBe('POST', '/api/auth/password/reset', { data: { email: user.email, code: '123456', newPassword: 'NewPass1!x' } });
      expectFail(res, 503, 'SERVICE_UNAVAILABLE', '재설정(시도 횟수 저장소 오류, 맞는 코드여도)');
      redis('DEL', attemptKey);
      await relaxAuthRates();
      expect((await signinRaw(user.email, user.password)).status, '비밀번호는 바뀌지 않았다').toBe(200);
    });

    await test.step('발송 상한 저장소 오류: 발송 전에 막고 503 (상한을 풀어 주지 않는다)', async () => {
      breakKey(sendKey);
      const res = await callBe('POST', '/api/auth/find-password/email/send', { data: { email: user.email } });
      expectFail(res, 503, 'SERVICE_UNAVAILABLE', '이메일 인증번호 발송(상한 저장소 오류)');
    });
  } finally {
    for (const key of [failKey, verifyKey, attemptKey, sendKey]) redis('DEL', key);
    redisDelPattern(`login:*:${user.id}`);
  }

  test.info().annotations.push({
    type: '재현 범위',
    description: '속도 제한 fail-open(IP 키 장애)은 다른 사람과 공유하는 키라 건드리지 않았다. Redis 전체 중단 없이 임시 사용자 키만 해시 타입으로 바꿔 fail-closed 경로 3곳(로그인 횟수·인증번호 시도·발송 상한)을 확인했다',
  });
  void tokensOf;
});
