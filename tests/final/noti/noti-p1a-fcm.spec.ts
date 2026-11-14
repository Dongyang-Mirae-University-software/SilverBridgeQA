/**
 * 최종 QA - 알림(NOTI) P1a - FCM 토큰 등록·삭제·해제·정리
 *
 * 임시 사용자만 쓴다. 푸시 확인은 가짜 토큰으로 한다.
 * - 짧은 가짜 토큰(fakeToken)은 FCM 이 "형식 오류(INVALID_ARGUMENT)"로 돌려준다.
 * - 실제 웹 토큰 모양의 가짜 토큰(longFakeToken)은 FCM 이 "등록 안 됨(UNREGISTERED, 만료와 같은 취급)"으로 돌려준다(2026-11-13 dev 에서 확인).
 * 서버가 실제로 푸시를 시도했는지는 이 반응에 따른 토큰 삭제·이력 사유로 본다. 실제 기기로 푸시가 가지는 않는다.
 * release 는 IP 기준 공용 제한(1분 10회)이라 이 파일에서는 직렬로 돌리고, 시작 전에 내 IP 의 fcm-release 카운터만 지운다.
 */
import { feHost } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psqlRows, sqlStr } from '../../../src/remote';
import { connect, fcmTokenCount, presetFcmRegistered } from '../../../src/variables';
import { relaxAuthRates } from '../auth/_helpers-auth';
import {
  anonymous,
  bodyOf,
  expiredJwt,
  fakeToken,
  fcmTokenOwner,
  logRows,
  menuButton,
  releaseToken,
  sendSos,
  waitForLog,
} from './_helpers-noti';
import { longFakeToken, P1A_TAGS, relaxFcmReleaseRate } from './_helpers-noti-p1a';

const FCM_TOKEN_API = '/api/notifications/fcm-token';
const RELEASE_API = '/api/notifications/fcm-token/release';

function tokensOf(userId: string): string[] {
  return psqlRows(`SELECT token FROM fcm_token WHERE user_id = ${sqlStr(userId)} ORDER BY token;`).map(r => r[0]);
}

function channelsOf(row: { channels: string }) {
  return JSON.parse(row.channels) as { channel: string; status: string; reason: string | null }[];
}

test.describe('FCM 토큰 등록 검증·재등록·갱신', () => {
  test('NOTI-A02 토큰 값이 빈 값·누락·공백', P1A_TAGS, async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const bodies: Record<string, unknown> = {
      '빈 문자열': { token: '', platform: 'WEB' },
      '생략': { platform: 'WEB' },
      '공백 3칸': { token: '   ', platform: 'WEB' },
      '탭·줄바꿈만': { token: '\t\n', platform: 'WEB' },
      'null': { token: null, platform: 'WEB' },
    };
    for (const [label, data] of Object.entries(bodies)) {
      const res = await api.raw('POST', FCM_TOKEN_API, data);
      const body = await bodyOf(res);
      expect.soft(res.status(), `${label}: 400(검증 오류)`).toBe(400);
      expect.soft(body.success, `${label}: 실패 응답`).toBe(false);
      expect.soft(body.code, `${label}: 오류 코드`).toBe('INVALID_INPUT');
    }
    expect(fcmTokenCount({ userId: user.id }), '검증에 걸린 요청은 아무것도 저장하지 않는다').toBe(0);

    // 대조: 같은 사용자가 올바른 토큰은 등록할 수 있다
    const ok = await api.raw('POST', FCM_TOKEN_API, { token: fakeToken(user.id, 'a02'), platform: 'WEB' });
    expect(ok.status(), '대조: 올바른 토큰은 200').toBe(200);
    expect(fcmTokenCount({ userId: user.id })).toBe(1);
  });

  test('NOTI-N02 같은 토큰 다시 등록하면 중복 저장 없이 200', P1A_TAGS, async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const token = fakeToken(user.id, 'n02');

    const first = await api.raw('POST', FCM_TOKEN_API, { token, platform: 'WEB' });
    expect(first.status()).toBe(200);
    const [[before]] = psqlRows(`SELECT extract(epoch FROM updated_at)::text FROM fcm_token WHERE token = ${sqlStr(token)};`);
    await new Promise(resolve => setTimeout(resolve, 1_500)); // 시각 차이가 확실히 나도록
    const second = await api.raw('POST', FCM_TOKEN_API, { token, platform: 'WEB' });
    expect(second.status(), '두 번째도 200').toBe(200);
    expect((await bodyOf(second)).message).toBe('FCM 토큰이 등록되었습니다.');

    expect(fcmTokenCount({ token }), 'DB 행은 1건 그대로').toBe(1);
    expect(fcmTokenCount({ userId: user.id }), '이 사용자의 토큰도 1건').toBe(1);
    expect(fcmTokenOwner(token), '주인 그대로').toEqual([user.id]);
    // 코드(FcmService.registerToken)는 같은 사용자의 재등록에서 사용 시각만 갱신한다(유휴 정리 기준)
    const [[after]] = psqlRows(`SELECT extract(epoch FROM updated_at)::text FROM fcm_token WHERE token = ${sqlStr(token)};`);
    expect(Number(after) > Number(before), `재등록하면 사용 시각이 앞으로 간다(갱신): ${before} -> ${after}`).toBe(true);
  });

  test('NOTI-N04 토큰 갱신(onTokenRefresh) 시 새 토큰 추가 등록', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(120_000);
    test.info().annotations.push({
      type: '대체 확인',
      description: '실제 기기가 없어 "새 토큰으로 푸시 수신" 대신, 서버가 새 토큰으로 푸시를 시도했는지를 본다. 실제 웹 토큰 모양의 가짜 토큰은 FCM 이 등록 안 됨으로 돌려주고 서버가 그 토큰을 지우므로, 새 토큰이 지워졌다면 푸시가 그 토큰으로 갔다는 뜻이다',
    });
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, ward.id);
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];
    const tokenA = longFakeToken();
    const tokenB = longFakeToken();

    const a = await g.api.raw('POST', FCM_TOKEN_API, { token: tokenA, platform: 'WEB' });
    expect(a.status(), '토큰 A 등록').toBe(200);
    const b = await g.api.raw('POST', FCM_TOKEN_API, { token: tokenB, platform: 'WEB' });
    expect(b.status(), '새 토큰 B 등록').toBe(200);
    expect(tokensOf(guardian.id).sort(), 'A 를 지우지 않고 B 를 추가로 등록한다').toEqual([tokenA, tokenB].sort());

    await sendSos(w.api);
    const [row] = await waitForLog(guardian.id, 'WARD_SOS');
    expect(channelsOf(row).find(c => c.channel === 'FCM'), '두 토큰 모두 푸시 시도 후 만료로 처리됨').toMatchObject({ status: 'FAILED', reason: 'ALL_TOKENS_EXPIRED' });
    expect(tokensOf(guardian.id), '새 토큰 B 도 푸시 시도 대상이었다(등록 안 됨 응답을 받아 서버가 지움)').toEqual([]);
  });
});

test.describe('FCM 푸시 결과에 따른 토큰 정리', () => {
  test('NOTI-A12 푸시 형식 오류 한 건이 모든 토큰을 지우지 않음', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(150_000);
    test.info().annotations.push({
      type: '부분 확인',
      description: '정상 토큰이 섞인 경우(성공 토큰이 있을 때만 INVALID_ARGUMENT 삭제하는 anySuccess=true 분기)는 실제로 전달되는 기기 토큰이 없어 자동화할 수 없다. BE 단위 테스트(FcmServiceTest) 몫',
    });
    test.info().annotations.push({
      type: '확인 범위',
      description: '진짜로 전달되는 FCM 토큰을 만들 수 없어 "형식 오류 토큰만 지워지고 정상 토큰은 남는" 혼합 상태는 못 만든다. 대신 형식 오류 2개 + 등록 안 됨(만료) 1개를 함께 보냈을 때 전부 지워지지 않고 만료된 1개만 정리되는지, 형식 오류만 남은 뒤 다음 푸시에도 지워지지 않는지를 본다(FcmService.cleanupInvalidTokens: 전부 실패한 묶음의 INVALID_ARGUMENT 는 보존)',
    });
    const ward1 = await tempUser('WARD', { phone: null });
    const ward2 = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, ward1.id);
    connect(guardian.id, ward2.id);
    const [w1, w2, g] = [await loginAs(ward1), await loginAs(ward2), await loginAs(guardian)];
    const bad1 = fakeToken(guardian.id, 'bad1');
    const bad2 = fakeToken(guardian.id, 'bad2');
    const expired = longFakeToken();
    for (const token of [bad1, bad2, expired]) {
      expect((await g.api.raw('POST', FCM_TOKEN_API, { token, platform: 'WEB' })).status(), '준비: 토큰 등록').toBe(200);
    }

    await test.step('첫 푸시: 만료 토큰만 정리, 형식 오류 토큰은 그대로', async () => {
      await sendSos(w1.api);
      const [row] = await waitForLog(guardian.id, 'WARD_SOS');
      expect(channelsOf(row).find(c => c.channel === 'FCM'), '푸시는 전달되지 않음(서버 오류 사유)').toMatchObject({ status: 'FAILED', reason: 'PUSH_SERVER_ERROR' });
      expect(tokensOf(guardian.id), '모든 토큰이 지워지지 않았고, 만료된 토큰만 정리됐다').toEqual([bad1, bad2].sort());
    });

    await test.step('다음 푸시: 형식 오류만 남아도 전부 지우지 않는다', async () => {
      await sendSos(w2.api);
      await expect.poll(() => logRows(guardian.id, 'WARD_SOS').length, { timeout: 30_000, intervals: [1_000, 2_000] }).toBe(2);
      const second = logRows(guardian.id, 'WARD_SOS')[1];
      expect(channelsOf(second).find(c => c.channel === 'FCM'), '여전히 서버 오류 사유').toMatchObject({ status: 'FAILED', reason: 'PUSH_SERVER_ERROR' });
      expect(tokensOf(guardian.id), '형식 오류 토큰 2개는 그대로').toEqual([bad1, bad2].sort());
    });
  });

  test('NOTI-A13 기기 토큰이 전부 만료이면 ALL_TOKENS_EXPIRED로 기록', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(120_000);
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, ward.id);
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];
    // 실제 웹 토큰 모양이지만 발급된 적 없는 토큰: FCM 이 "등록 안 됨"으로 돌려주는 만료 토큰 대역
    const tokens = [longFakeToken(), longFakeToken()];
    for (const token of tokens) {
      expect((await g.api.raw('POST', FCM_TOKEN_API, { token, platform: 'WEB' })).status(), '준비: 토큰 등록').toBe(200);
    }

    await sendSos(w.api);
    const [row] = await waitForLog(guardian.id, 'WARD_SOS');
    const fcm = channelsOf(row).find(c => c.channel === 'FCM');
    expect(fcm, '이력 FCM 채널 실패 사유 ALL_TOKENS_EXPIRED').toMatchObject({ status: 'FAILED', reason: 'ALL_TOKENS_EXPIRED' });
    expect(row.result, '문자도 번호가 없어 전달 수단이 없으니 FAILED').toBe('FAILED');
    expect(tokensOf(guardian.id), '만료 토큰은 서버가 정리한다').toEqual([]);
  });
});

// release 는 IP 기준 공용 제한(fcm-release 1분 10회)을 쓴다. 이 묶음 안에서는 직렬로 돌린다
test.describe('FCM 토큰 release (IP 공용 제한 - 직렬)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeEach(async () => {
    await relaxFcmReleaseRate(); // 내 IP 의 fcm-release 카운터만 지운다
  });
  test.afterEach(async () => {
    await relaxFcmReleaseRate(); // 이 테스트가 남긴 카운터가 다른 테스트의 release 를 막지 않게 정리
  });

  test('NOTI-A09 release IP 1분 10회 제한', P1A_TAGS, async () => {
    // 인증 헤더 없이 서버가 발급하지 않은 가짜 accessToken 으로 부른다: 한도 안에서는 401, 넘으면 429
    const statuses: number[] = [];
    let retryAfter = '';
    const ctx = await anonymous();
    try {
      for (let i = 0; i < 11; i++) {
        const res = await ctx.post(RELEASE_API, { data: { accessToken: expiredJwt('e2e000', 'GUARDIAN'), token: fakeToken('a09', String(i)) } });
        statuses.push(res.status());
        if (res.status() === 429) {
          retryAfter = res.headers()['retry-after'] ?? '';
          expect((await bodyOf(res)).code, '429 오류 코드').toBe('TOO_MANY_REQUESTS');
        }
      }
    } finally {
      await ctx.dispose();
    }
    test.info().annotations.push({ type: '응답 상태 순서', description: statuses.join(',') });
    if (statuses.slice(0, 10).includes(429)) {
      test.info().annotations.push({ type: '다른 영역과 겹침', description: '같은 PC IP 로 다른 테스트가 release 를 동시에 불러 10번째 안에 429 가 났다(테스트 문제가 아니라 공용 제한). 다시 실행해 확인' });
    }
    expect(statuses.slice(0, 10), '1~10번째는 한도 안이라 만료·위조 토큰 오류(401)').toEqual(Array(10).fill(401));
    expect(statuses[10], '11번째는 429').toBe(429);
    expect(Number(retryAfter), '다시 시도할 때까지 남은 초(Retry-After)는 1~60').toBeGreaterThanOrEqual(1);
    expect(Number(retryAfter)).toBeLessThanOrEqual(60);
  });

  test('NOTI-N07 세션 만료 뒤 release로 본인 토큰 삭제', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.info().annotations.push({
      type: '부분 확인',
      description: '시간으로 만료된 토큰의 "만료 허용 파싱"은 P0 NOTI-A10(@slow)과 합쳐야 완전 확인된다',
    });
    test.info().annotations.push({
      type: '대체 확인',
      description: '서명이 맞는 진짜 "시간 만료" access token 은 30분을 기다려야 한다(P0 의 @slow NOTI-A10 이 확인). 여기서는 세션이 끝난 상태(로그아웃으로 access 블랙리스트·refresh 폐기)의 진짜 access token 으로 확인한다. release 는 블랙리스트를 보지 않는 설계(FcmTokenReleaseService)',
    });
    const a = await tempUser('GUARDIAN');
    const b = await tempUser('GUARDIAN');
    const [ga, gb] = [await loginAs(a), await loginAs(b)];
    const tokenA = fakeToken(a.id, 'n07a');
    const tokenB = fakeToken(b.id, 'n07b');
    await ga.api.post(FCM_TOKEN_API, { token: tokenA, platform: 'WEB' });
    await gb.api.post(FCM_TOKEN_API, { token: tokenB, platform: 'WEB' });
    const accessA = ga.login.accessToken;

    await ga.api.post('/api/auth/logout');
    const dead = await ga.api.raw('GET', '/api/user/me');
    expect(dead.status(), '준비: 끝난 세션의 access token 은 일반 API 에서 401').toBe(401);

    const other = await releaseToken(accessA, tokenB);
    expect(other.status, '남의 토큰이어도 조용히 200').toBe(200);
    expect(fcmTokenOwner(tokenB), 'B 의 토큰은 그대로(주인도 그대로)').toEqual([b.id]);

    const own = await releaseToken(accessA, tokenA);
    expect(own.status, '끝난 세션의 토큰으로도 release 는 200').toBe(200);
    expect(fcmTokenCount({ token: tokenA }), '본인 토큰만 삭제됨').toBe(0);
    expect(fcmTokenCount({ userId: b.id }), 'B 의 토큰은 1건 그대로').toBe(1);
  });

  test('NOTI-N08 자동 로그아웃 때도 release 호출로 푸시 주소 삭제(화면)', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.info().annotations.push({ type: '진짜 버그 판정', description: 'FE(a8666240) clearSession 에 fcm-token/release 호출이 없다' });
    const user = await tempUser('GUARDIAN');
    const { api, who } = await loginAs(user);
    const token = fakeToken(user.id, 'n08');
    await api.post(FCM_TOKEN_API, { token, platform: 'WEB' });
    expect(fcmTokenCount({ token }), '준비: 토큰 등록').toBe(1);

    const page = await openAs(who, null);
    // v13 FE 는 refresh 토큰을 HttpOnly 쿠키(careai_rt, Path=/api/auth)로만 보낸다. 공용 도우미는 옛 쿠키만 넣으므로 직접 더한다
    // (없으면 재발급이 400 으로 끝나 "일시 장애"로 보고 로그아웃하지 않는다)
    await page.context().addCookies([{ name: 'careai_rt', value: who.login.refreshToken, domain: feHost, path: '/api/auth', httpOnly: true, secure: true, sameSite: 'Lax' }]);
    await presetFcmRegistered(page, token, user.id);
    const releaseCalls: number[] = [];
    const refreshStatuses: number[] = [];
    page.on('response', res => {
      if (res.request().method() === 'POST' && res.url().endsWith(RELEASE_API)) releaseCalls.push(res.status());
      if (res.request().method() === 'POST' && res.url().endsWith('/api/auth/refresh')) refreshStatuses.push(res.status());
    });
    await page.goto('/guardian');
    await expect(menuButton(page)).toBeVisible();

    await test.step('다른 곳에서 세션이 끝난 뒤 화면을 다시 불러오면 자동으로 로그인 화면으로 간다', async () => {
      await api.post('/api/auth/logout');
      let loggedOut = false;
      for (let attempt = 0; attempt < 3 && !loggedOut; attempt++) {
        refreshStatuses.length = 0;
        await page.reload();
        loggedOut = await page.waitForURL(/\/login$/, { timeout: 15_000 }).then(() => true, () => false);
        // 같은 PC IP 의 재발급 속도 제한(429)에 걸렸으면 FE 가 일시 장애로 보고 로그아웃하지 않는다 - 내 IP 키만 지우고 다시 한다
        if (!loggedOut && refreshStatuses.includes(429)) await relaxAuthRates();
        else if (!loggedOut) break;
      }
      test.info().annotations.push({ type: '마지막 재발급(/api/auth/refresh) 응답', description: refreshStatuses.join(',') || '(없음)' });
      expect(loggedOut, `세션 끝난 뒤 새로 고침하면 로그인 화면으로 가야 한다(재발급 응답 ${refreshStatuses.join(',') || '없음'})`).toBe(true);
    });

    await expect
      .poll(() => releaseCalls.length, { timeout: 10_000, intervals: [500, 1_000], message: '자동 로그아웃 뒤에 POST /api/notifications/fcm-token/release 호출이 없다 - FE(a8666240)는 자동 로그아웃(clearSession)에서 이 기기 토큰을 해제하는 호출을 하지 않는다' })
      .toBeGreaterThan(0);
    expect(releaseCalls[0], 'release 호출은 200').toBe(200);
    await expect
      .poll(() => fcmTokenCount({ token }), { timeout: 10_000, message: '자동 로그아웃 뒤에도 서버에 이 기기 토큰이 남아 이전 사용자의 푸시를 계속 받는다' })
      .toBe(0);
  });
});
