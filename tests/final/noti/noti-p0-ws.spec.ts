/**
 * 최종 QA - 알림(NOTI) P0 - 실시간(WebSocket/STOMP) 인증·권한
 *
 * 서버 발송 없이 STOMP 프레임만 직접 주고받는다(FE 오리진 페이지에서 연결). 임시 사용자만 쓴다.
 * 핸드셰이크 거부는 HTTP 코드가 현재 실제 값 200(업그레이드 없음)인지로 고정해 확인한다(0 은 서버에 못 닿은 것이라 실패).
 * 배포 코드 JwtHandshakeInterceptor 는 토큰 오류 때 상태 코드를 지정하지 않고 `return false` 만 해서
 * 케이스 문구의 "(401)" 이 아니라 200 이 나온다. 이 차이는 결과에 남기고, BE 에는
 * "토큰 없음·잘못된 토큰이면 response.setStatusCode(HttpStatus.UNAUTHORIZED) 후 false" 를 제안한다(별도 항목).
 * 나중에 BE 가 401 로 바꾸면 이 테스트가 실패해 알아챌 수 있다.
 */
import { randomInt, randomUUID } from 'node:crypto';

import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { redis } from '../../../src/remote';
import { connect } from '../../../src/variables';
import {
  anonymous,
  bodyOf,
  expiredJwt,
  handshakeStatus,
  NOTI_TAGS,
  probeClose,
  probeOpen,
  probeSend,
  probeState,
  probeSubscribe,
  sendSos,
  settleSubscription,
  tamperSignature,
  wsUrl,
} from './_helpers-noti';

/** 지금 배포 코드가 거부할 때 돌려주는 실제 HTTP 코드 (케이스 문구는 401) */
const REJECTED_HANDSHAKE_STATUS = 200;
const HANDSHAKE_NOTE = {
  type: '케이스 문구와 다름',
  description: '케이스는 핸드셰이크 거부(401)인데 실제 응답은 200(업그레이드 없음). BE JwtHandshakeInterceptor 가 상태 코드 없이 return false 하기 때문. BE 에 401 설정 제안 항목으로 올림',
};

test.describe('WebSocket 연결과 구독', () => {
  test('NOTI-N38 유효한 token으로 /ws 연결 후 본인 토픽 구독 (연결 요청 알림이 실제로 옴)', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD', { phone: null }); // 연결 요청을 받는 쪽, 외부 발송 없음
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];
    const page = await openAs('anonymous', '/login');

    const open = await probeOpen(page, 'me', wsUrl(w.login.accessToken));
    expect(open.opened, '핸드셰이크 성공').toBe(true);
    expect(open.connected, 'STOMP CONNECTED').toBe(true);

    await probeSubscribe(page, 'me', `/topic/${ward.id}/connection-request`, 'r-own');
    await settleSubscription(page, 'me');
    expect((await probeState(page, 'me')).messages, '요청 전에는 메시지가 없다').toBe(0);

    // 다른 임시 보호자가 연결 요청을 보내면 본인 토픽으로 MESSAGE 가 1개 와야 한다(구독이 실제로 성립했다는 증거)
    const res = await g.api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation: '딸' });
    expect(res.status(), `준비: 연결 요청 (${JSON.stringify(await bodyOf(res)).slice(0, 120)})`).toBe(200);
    await expect
      .poll(async () => (await probeState(page, 'me')).messages, { timeout: 15_000, intervals: [500, 1_000], message: '본인 토픽(connection-request)으로 알림 메시지가 와야 한다' })
      .toBe(1);

    const state = await probeState(page, 'me');
    test.info().annotations.push({ type: '구독 결과', description: `프레임 ${JSON.stringify(state.commands)}, 영수증 ${JSON.stringify(state.receipts)}, MESSAGE ${state.messages}, readyState ${state.readyState}` });
    expect(state.close, '연결이 닫히지 않는다').toBeNull();
    expect(state.readyState).toBe(1);
    await probeClose(page, 'me');
  });

  test('NOTI-A53 토큰 없이 /ws 연결', NOTI_TAGS, async ({ openAs }) => {
    const page = await openAs('anonymous', '/login');

    const status = await handshakeStatus(null);
    test.info().annotations.push({ type: '토큰 없는 핸드셰이크 HTTP 응답', description: String(status) }, HANDSHAKE_NOTE);
    expect(status, '0 이면 서버에 닿지 못한 것(실패). 업그레이드(101)도 안 된다').toBeGreaterThanOrEqual(200);
    expect(status, `거부는 현재 실제 값 ${REJECTED_HANDSHAKE_STATUS}(업그레이드 없음)로 고정 - 케이스 문구는 401`).toBe(REJECTED_HANDSHAKE_STATUS);

    const open = await probeOpen(page, 'noToken', wsUrl(null));
    expect(open.opened, '브라우저 연결이 열리면 안 된다').toBe(false);
    expect(open.connected).toBe(false);
  });

  test('NOTI-A54 위조·만료·다른 타입(refresh) 토큰으로 /ws 연결', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    // 만료된 진짜 토큰은 서명키 없이 만들 수 없어 "서명이 틀린 만료 토큰"으로 대신한다(만료 자체는 못 봄)
    test.info().annotations.push(HANDSHAKE_NOTE, { type: '대체 확인', description: '"만료 토큰"은 서명 틀린 가짜 토큰으로 대신 확인함' });
    const user = await tempUser('GUARDIAN');
    const { login } = await loginAs(user);
    const page = await openAs('anonymous', '/login');
    const bad: Record<string, string> = {
      '위조 서명': tamperSignature(login.accessToken),
      'refresh 타입 토큰': login.refreshToken,
      '만료 토큰(서명 틀림)': expiredJwt(user.id, 'GUARDIAN', 3600),
      '엉터리 문자열': 'garbage.token.value',
    };
    let i = 0;
    for (const [label, token] of Object.entries(bad)) {
      const status = await handshakeStatus(token);
      expect.soft(status, `${label}: 0 이면 서버에 닿지 못한 것(실패)`).toBeGreaterThanOrEqual(200);
      expect.soft(status, `${label}: 거부는 현재 실제 값 ${REJECTED_HANDSHAKE_STATUS}(업그레이드 없음) - 케이스 문구는 401`).toBe(REJECTED_HANDSHAKE_STATUS);
      const open = await probeOpen(page, `bad${i++}`, wsUrl(token));
      expect.soft(open.opened, `${label}: 연결이 열리면 안 된다`).toBe(false);
      expect.soft(open.connected, `${label}: STOMP CONNECTED 면 안 된다`).toBe(false);
    }
    // 대조: 진짜 access token 은 연결된다
    const good = await probeOpen(page, 'good', wsUrl(login.accessToken));
    expect(good.connected, '대조: 유효한 토큰은 연결된다').toBe(true);
    await probeClose(page, 'good');
  });

  test('NOTI-A55 남의 userId 토픽 구독 거부', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    const a = await tempUser('GUARDIAN');
    const b = await tempUser('GUARDIAN');
    const [ga, gb] = [await loginAs(a), await loginAs(b)];
    const page = await openAs('anonymous', '/login');

    expect((await probeOpen(page, 'a', wsUrl(ga.login.accessToken))).connected, '준비: A 연결').toBe(true);
    expect((await probeOpen(page, 'b', wsUrl(gb.login.accessToken))).connected, '준비: B 연결').toBe(true);
    await probeSubscribe(page, 'b', `/topic/${b.id}/sos-triggered`, 'r-b');
    await settleSubscription(page, 'b'); // 대조: B 가 자기 토픽을 구독해도 ERROR 없이 열려 있다

    await probeSubscribe(page, 'a', `/topic/${b.id}/sos-triggered`, 'r-a');
    // 거부(ERROR 프레임 또는 연결 종료)가 올 때까지 기다린다
    await expect
      .poll(async () => {
        const s = await probeState(page, 'a');
        return s.commands.includes('ERROR') || s.close !== null;
      }, { timeout: 10_000, intervals: [250, 500], message: '구독 거부(ERROR 프레임 또는 연결 종료)가 와야 한다' })
      .toBe(true);
    const sa = await probeState(page, 'a');
    test.info().annotations.push({ type: 'A 의 남의 토픽 구독 결과', description: `프레임 ${JSON.stringify(sa.commands)}, 닫힘 ${JSON.stringify(sa.close)}, 영수증 ${JSON.stringify(sa.receipts)}` });

    // B 쪽은 아무도 B 에게 보내지 않았으므로 메시지 수는 보지 않고, 영향이 없는지(연결 유지·구독 영수증 유지)만 본다
    const sb = await probeState(page, 'b');
    expect(sb.close, 'B 의 연결은 영향 없음').toBeNull();
    expect(sb.readyState, 'B 의 연결은 열려 있다').toBe(1);
  });

  test('NOTI-A56 /app/ 외 주소로 SEND하면 가짜 SOS·화재 불가', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    const attacker = await tempUser('GUARDIAN', { phone: null });
    const victim = await tempUser('GUARDIAN', { phone: null }); // 번호·토큰 없음: 외부 발송 없음
    const ward = await tempUser('WARD', { phone: null });
    connect(victim.id, ward.id);
    const [ga, gv, w] = [await loginAs(attacker), await loginAs(victim), await loginAs(ward)];
    const page = await openAs('anonymous', '/login');

    expect((await probeOpen(page, 'attacker', wsUrl(ga.login.accessToken))).connected).toBe(true);
    expect((await probeOpen(page, 'victim', wsUrl(gv.login.accessToken))).connected).toBe(true);
    await probeSubscribe(page, 'victim', `/topic/${victim.id}/sos-triggered`, 'r-v');
    await probeSubscribe(page, 'victim', `/topic/${victim.id}/anomaly-detected`, 'r-v2');
    await settleSubscription(page, 'victim');

    // 대조: 진짜 SOS 를 한 번 보내면 피해자 연결에 MESSAGE 1개가 온다(구독이 실제로 성립했다는 증거). 보낸 뒤부터 가짜를 센다
    await sendSos(w.api);
    await expect
      .poll(async () => (await probeState(page, 'victim')).messages, { timeout: 20_000, intervals: [500, 1_000], message: '대조: 진짜 SOS 는 피해자 연결에 도착해야 한다' })
      .toBe(1);

    const forged = JSON.stringify({ type: 'SOS_TRIGGERED', wardName: 'E2E위조', sosEventId: `e2e-forged-${Date.now()}`, title: '긴급 SOS', body: '가짜 SOS' });
    await probeSend(page, 'attacker', `/topic/${victim.id}/sos-triggered`, forged);
    await probeSend(page, 'attacker', `/topic/${victim.id}/anomaly-detected`, forged);
    await expect
      .poll(async () => {
        const s = await probeState(page, 'attacker');
        return s.commands.includes('ERROR') || s.close !== null;
      }, { timeout: 10_000, intervals: [250, 500], message: '/app/ 이 아닌 주소 SEND 는 거부(ERROR 프레임 또는 연결 종료)돼야 한다' })
      .toBe(true);
    await page.waitForTimeout(3_000); // 가짜 알림이 뒤늦게 도착하는지 잠깐 더 본다(없음을 보는 단계라 짧은 대기가 필요)

    const sa = await probeState(page, 'attacker');
    test.info().annotations.push({ type: '가짜 SEND 결과', description: `프레임 ${JSON.stringify(sa.commands)}, 닫힘 ${JSON.stringify(sa.close)}` });
    const sv = await probeState(page, 'victim');
    expect(sv.messages, '상대 화면(연결)에는 진짜 SOS 1개뿐, 가짜 알림은 오지 않는다').toBe(1);
  });
});

// 재설정(pw-reset-confirm)은 IP 기준 공용 제한을 쓰므로 다른 영역과 동시에 돌리지 않는다
test.describe('토큰 무효화 시 열린 연결 종료', () => {
  test.describe.configure({ mode: 'serial' });

  test('NOTI-A58 토큰 무효화 때 열린 연결 close 1008 AUTH_INVALIDATED, 재시도 금지', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(300_000);
    const admin = await loginAs(await tempUser('ADMIN'));
    const page = await openAs('anonymous', '/login');

    async function closedBy(name: string) {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const state = await probeState(page, name);
        if (state.close || Date.now() > deadline) return state.close;
        await page.waitForTimeout(500);
      }
    }
    async function opened(label: string, role: 'GUARDIAN' | 'WARD' = 'GUARDIAN') {
      const user = await tempUser(role);
      const logged = await loginAs(user);
      const state = await probeOpen(page, label, wsUrl(logged.login.accessToken));
      expect(state.connected, `준비(${label}): STOMP 연결`).toBe(true);
      return { user, logged };
    }
    const expected = { code: 1008, reason: 'AUTH_INVALIDATED' };
    // 새 비밀번호·인증코드는 코드에 적지 않고 실행 때마다 임의로 만든다(임시 사용자 전용)
    const randomPassword = () => `E2e!${randomUUID().replace(/-/g, '').slice(0, 12)}a1`;

    await test.step('정지(관리자 이용 제한)', async () => {
      const { user } = await opened('restrict');
      const res = await admin.api.raw('PATCH', `/api/admin/user/${user.id}`, { status: 'RESTRICTED', statusReason: 'qa' });
      expect(res.status(), '준비: 이용 제한').toBe(200);
      expect.soft(await closedBy('restrict'), '정지').toEqual(expected);
    });

    await test.step('비밀번호 변경', async () => {
      const { user, logged } = await opened('pwchange');
      const res = await logged.api.raw('PUT', '/api/user/me/password', { currentPassword: user.password, newPassword: randomPassword() });
      expect(res.status(), '준비: 비밀번호 변경').toBe(200);
      expect.soft(await closedBy('pwchange'), '비밀번호 변경').toEqual(expected);
    });

    await test.step('비밀번호 재설정', async () => {
      const { user } = await opened('pwreset');
      // 인증코드는 Redis 에 직접 넣는다(메일 발송 없음)
      const code = String(randomInt(100_000, 1_000_000));
      redis('SET', `password:email:verify:${user.email}`, code, 'EX', '300');
      const ctx = await anonymous();
      try {
        const res = await ctx.post('/api/auth/password/reset', { data: { email: user.email, code, newPassword: randomPassword() } });
        expect(res.status(), `준비: 재설정 (${JSON.stringify(await bodyOf(res)).slice(0, 100)})`).toBe(200);
      } finally {
        await ctx.dispose();
        redis('DEL', `password:email:verify:${user.email}`); // 재설정이 실패해도 임시 이메일 자기 키만 정리
      }
      expect.soft(await closedBy('pwreset'), '비밀번호 재설정').toEqual(expected);
    });

    await test.step('역할 변경(관리자)', async () => {
      const { user } = await opened('rolechange');
      const res = await admin.api.raw('PATCH', `/api/admin/user/${user.id}`, { role: 'WARD' });
      expect(res.status(), '준비: 역할 변경').toBe(200);
      expect.soft(await closedBy('rolechange'), '역할 변경').toEqual(expected);
    });

    await test.step('탈퇴', async () => {
      const { user, logged } = await opened('withdraw');
      const res = await logged.api.raw('DELETE', '/api/user/me', { password: user.password });
      expect(res.status(), '준비: 탈퇴').toBe(200);
      expect.soft(await closedBy('withdraw'), '탈퇴').toEqual(expected);
    });

    await test.step('FE: 1008 AUTH_INVALIDATED 를 받으면 같은 토큰으로 다시 붙지 않는다', async () => {
      const { user, logged } = await opened('feuser');
      await probeClose(page, 'feuser');
      const app = await openAs(logged.who, null);
      const attempts: string[] = [];
      const closes: string[] = [];
      await app.routeWebSocket(/\/ws\?token=/, ws => {
        attempts.push(new URL(ws.url()).searchParams.get('token') ?? '');
        ws.connectToServer();
      });
      app.on('console', m => {
        if (m.text().includes('연결 종료')) closes.push(m.text());
      });
      await app.goto('/guardian');
      await waitForRealtime(app);
      expect(attempts.length, 'FE 의 첫 실시간 연결(/ws?token=)을 잡았다').toBeGreaterThan(0);
      const usedToken = attempts[0];
      const before = attempts.length;

      const res = await admin.api.raw('PATCH', `/api/admin/user/${user.id}`, { status: 'RESTRICTED', statusReason: 'qa' });
      expect(res.status(), '준비: 이용 제한').toBe(200);
      await app.waitForTimeout(15_000); // FE 재연결 간격 5초의 3배
      const sameTokenRetries = attempts.slice(before).filter(t => t === usedToken).length;
      test.info().annotations.push({ type: 'FE 종료 로그', description: closes.join(' / ').slice(0, 200) || '(없음)' });
      expect(closes.some(c => c.includes('1008') && c.includes('AUTH_INVALIDATED')), 'FE 가 1008/AUTH_INVALIDATED 로 닫힘을 받았다(1008 로그)').toBe(true);
      expect(sameTokenRetries, '무효화된 같은 토큰으로 다시 연결을 시도했다 (핸드셰이크에서 거부될 연결을 계속 두드림)').toBe(0);
    });

    for (const name of ['restrict', 'pwchange', 'pwreset', 'rolechange', 'withdraw']) await probeClose(page, name);
  });
});
