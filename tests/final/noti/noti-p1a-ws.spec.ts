/**
 * 최종 QA - 알림(NOTI) P1a - 실시간(WebSocket) 토픽과 연결 요청 저장 순서
 *
 * 서버 알림은 임시 사용자끼리의 연결 흐름으로 일으킨다(전화번호가 없어 문자·알림톡은 나가지 않고, 푸시 토큰도 없다).
 * STOMP 는 FE 오리진 페이지에서 직접 연다(앱 화면의 자동 연결·종료가 검증을 흐리지 않게).
 * 구독 성립 신호(RECEIPT)를 서버가 주지 않아, 구독 확인은 실제 이벤트가 MESSAGE 로 오는 것으로 한다.
 */
import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { bodyOf, logRows, waitForLog, wsUrl } from './_helpers-noti';
import {
  logCountOf,
  p1aBodies,
  p1aClose,
  p1aOpen,
  p1aSettle,
  p1aState,
  p1aSubscribe,
  p1aWaitFor,
  P1A_TAGS,
  pendingConnectionId,
} from './_helpers-noti-p1a';

const REQUEST = '/api/guardian/connection/request';

test.describe('연결 흐름 실시간 토픽', () => {
  test('NOTI-N39 연결 요청·수락·거절·해제·요청 취소 토픽 수신', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];
    const page = await openAs('anonymous', '/login');

    expect((await p1aOpen(page, 'ward', wsUrl(w.login.accessToken))).connected, '준비: 피보호자 연결').toBe(true);
    expect((await p1aOpen(page, 'guardian', wsUrl(g.login.accessToken))).connected, '준비: 보호자 연결').toBe(true);
    const wardTopics = ['connection-request', 'connection-request-cancelled', 'connection-cancelled'];
    const guardianTopics = ['connection-accepted', 'connection-refused', 'connection-cancelled'];
    for (const t of wardTopics) await p1aSubscribe(page, 'ward', `/topic/${ward.id}/${t}`, `w-${t}`);
    for (const t of guardianTopics) await p1aSubscribe(page, 'guardian', `/topic/${guardian.id}/${t}`, `g-${t}`);
    await p1aSettle(page, 'ward');
    await p1aSettle(page, 'guardian');

    async function request() {
      const res = await g.api.raw('POST', REQUEST, { targetId: ward.id, relation: '딸' });
      expect(res.status(), '연결 요청 200').toBe(200);
      return pendingConnectionId(guardian.id, ward.id);
    }

    await test.step('연결 요청 -> 피보호자 connection-request {connectionId, from}', async () => {
      const id = await request();
      const [msg] = await p1aWaitFor(page, 'ward', `/topic/${ward.id}/connection-request`, '피보호자가 connection-request 를 받아야 한다');
      expect(msg.connectionId, 'connectionId').toBe(id);
      expect(msg.from, '보낸 보호자 id').toBe(guardian.id);

      await test.step('요청 취소 -> 피보호자 connection-request-cancelled, payload = connectionId 뿐, 알림 이력 추가 없음', async () => {
        await waitForLog(ward.id, 'CONNECTION_REQUEST'); // 요청 알림 기록이 끝난 뒤의 개수를 기준으로 삼는다
        const wardLogsBefore = logCountOf(ward.id);
        const guardianLogsBefore = logCountOf(guardian.id);
        const cancel = await g.api.raw('DELETE', `/api/guardian/connection/cancel/${id}`);
        expect(cancel.status(), '요청 취소 200').toBe(200);
        const [cancelled] = await p1aWaitFor(page, 'ward', `/topic/${ward.id}/connection-request-cancelled`, '피보호자가 요청 취소 신호를 받아야 한다');
        expect(cancelled, 'payload 는 connectionId 만').toEqual({ connectionId: id });
        // 없음을 보는 단계라 짧게 기다린다: 취소는 디스패처를 거치지 않으므로 푸시·문자·이력이 생기지 않아야 한다
        await page.waitForTimeout(2_000);
        expect(logCountOf(ward.id), '취소로 피보호자 알림 이력이 늘지 않는다(푸시·문자 없음)').toBe(wardLogsBefore);
        expect(logCountOf(guardian.id), '취소로 보호자 알림 이력도 늘지 않는다').toBe(guardianLogsBefore);
      });
    });

    await test.step('연결 수락 -> 보호자 connection-accepted {connectionId}', async () => {
      await request();
      const id = pendingConnectionId(guardian.id, ward.id);
      const accept = await w.api.raw('POST', `/api/ward/connection/${id}/accept`);
      expect(accept.status(), '수락 200').toBe(200);
      const [msg] = await p1aWaitFor(page, 'guardian', `/topic/${guardian.id}/connection-accepted`, '보호자가 connection-accepted 를 받아야 한다');
      expect(msg, 'payload').toEqual({ connectionId: id });

      await test.step('연결 해제 -> 상대(피보호자) connection-cancelled {connectionId, type, disconnectedBy, title, body}', async () => {
        const off = await g.api.raw('DELETE', `/api/guardian/connection/disconnection/${id}`);
        expect(off.status(), '해제 200').toBe(200);
        const [cancelled] = await p1aWaitFor(page, 'ward', `/topic/${ward.id}/connection-cancelled`, '피보호자가 connection-cancelled 를 받아야 한다');
        expect(cancelled).toMatchObject({ connectionId: id, type: 'CONNECTION_CANCELLED', disconnectedBy: 'GUARDIAN' });
      });
    });

    await test.step('연결 거절 -> 보호자 connection-refused {connectionId}', async () => {
      await request();
      const id = pendingConnectionId(guardian.id, ward.id);
      const refuse = await w.api.raw('DELETE', `/api/ward/connection/request/${id}/refusal`);
      expect(refuse.status(), '거절 200').toBe(200);
      const [msg] = await p1aWaitFor(page, 'guardian', `/topic/${guardian.id}/connection-refused`, '보호자가 connection-refused 를 받아야 한다');
      expect(msg, 'payload').toEqual({ connectionId: id });
    });

    expect((await p1aState(page, 'ward')).close, '피보호자 연결은 끝까지 열려 있었다').toBeNull();
    expect((await p1aState(page, 'guardian')).close, '보호자 연결은 끝까지 열려 있었다').toBeNull();
    await p1aClose(page, 'ward');
    await p1aClose(page, 'guardian');
  });

  test('NOTI-N46 웹소켓 알림은 알림 설정과 무관하게 항상 옴', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];
    const off = await w.api.raw('PUT', '/api/user/me/notification-settings', {
      settings: ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: false })),
    });
    expect(off.status(), '준비: 피보호자가 모든 채널을 끈다').toBe(200);

    const page = await openAs('anonymous', '/login');
    expect((await p1aOpen(page, 'ward', wsUrl(w.login.accessToken))).connected, '준비: 피보호자 연결').toBe(true);
    await p1aSubscribe(page, 'ward', `/topic/${ward.id}/connection-request`, 'w-req');
    await p1aSettle(page, 'ward');

    const res = await g.api.raw('POST', REQUEST, { targetId: ward.id, relation: '딸' });
    expect(res.status(), '연결 요청 200').toBe(200);
    const id = pendingConnectionId(guardian.id, ward.id);
    const [msg] = await p1aWaitFor(page, 'ward', `/topic/${ward.id}/connection-request`, '모든 채널을 꺼도 화면 실시간 갱신(connection-request)은 도착해야 한다');
    expect(msg.connectionId).toBe(id);

    // 푸시·문자는 없다: 이력에 "채널을 꺼 둬서 보내지 않음"만 남고 시도한 채널이 없다
    const [row] = await waitForLog(ward.id, 'CONNECTION_REQUEST');
    expect(row.result, '채널이 모두 꺼져 보내지 않음').toBe('NOT_SENT');
    expect(row.reason).toBe('NO_ENABLED_CHANNEL');
    expect(row.channels, '시도한 채널 없음(푸시·문자·알림톡 모두 안 감)').toBe('[]');
    const unread = await w.api.get<{ count: number }>('/api/user/me/notifications/unread-count');
    expect(unread.count, '보내지 않은 알림은 받은 알림 기록에 보이지 않는다').toBe(0);
    await p1aClose(page, 'ward');
  });
});

test.describe('로그아웃 뒤 열린 실시간 연결', () => {
  test('NOTI-A60 로그아웃 뒤에도 열린 실시간 연결이 남지 않음', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    test.info().annotations.push({
      type: '문서와 코드',
      description: '문서(BE 2578)와 코드(WebSocketSessionCloser)는 정지·비밀번호 변경·재설정·역할 변경·탈퇴 때만 열린 연결을 닫는다고 한다. 로그아웃은 목록에 없다(AuthService.logout 은 access 블랙리스트와 refresh 폐기만 한다). 케이스 기대(로그아웃 뒤 연결 종료, 알림 도착 안 함)는 보류 항목 XCUT-G07 재확인이다',
    });
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];
    const page = await openAs('anonymous', '/login');
    const topic = `/topic/${ward.id}/connection-request`;

    expect((await p1aOpen(page, 'ward', wsUrl(w.login.accessToken))).connected, '준비: 피보호자 연결').toBe(true);
    await p1aSubscribe(page, 'ward', topic, 'w-req');
    await p1aSettle(page, 'ward');

    // 대조: 로그아웃 전에는 연결 요청 알림이 온다(구독이 실제로 성립했다는 증거)
    expect((await g.api.raw('POST', REQUEST, { targetId: ward.id, relation: '딸' })).status()).toBe(200);
    await p1aWaitFor(page, 'ward', topic, '대조: 로그아웃 전에는 알림이 도착해야 한다');
    const before = (await p1aBodies(page, 'ward', topic)).length;
    const id = pendingConnectionId(guardian.id, ward.id);
    expect((await g.api.raw('DELETE', `/api/guardian/connection/cancel/${id}`)).status(), '준비: 요청 취소').toBe(200);

    const out = await w.api.raw('POST', '/api/auth/logout');
    expect(out.status(), '로그아웃 200').toBe(200);

    // 서버가 연결을 닫는지 최대 15초
    const deadline = Date.now() + 15_000;
    let closed = (await p1aState(page, 'ward')).close;
    while (closed === null && Date.now() < deadline) {
      await page.waitForTimeout(500);
      closed = (await p1aState(page, 'ward')).close;
    }
    expect.soft(closed, '로그아웃 뒤에도 서버가 실시간 연결을 닫지 않았다(close 이벤트 없음)').not.toBeNull();

    // 로그아웃 뒤 새 이벤트: 연결 요청을 다시 보낸다
    expect((await g.api.raw('POST', REQUEST, { targetId: ward.id, relation: '딸' })).status(), '준비: 다시 연결 요청').toBe(200);
    await waitForLog(ward.id, 'CONNECTION_REQUEST', 2); // 서버가 두 번째 요청 알림 처리를 마칠 때까지(WS 는 그 앞에서 보낸다)
    await page.waitForTimeout(2_000); // 도착하지 않음을 보는 단계라 짧게 기다린다
    const after = (await p1aBodies(page, 'ward', topic)).length;
    expect.soft(after, '로그아웃한 사용자의 열린 연결로 새 알림이 도착했다').toBe(before);
    await p1aClose(page, 'ward');
  });
});

test.describe('연결 요청 저장 순서', () => {
  test('NOTI-A37 저장이 실패하면 알림도 안 나감', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    test.info().annotations.push({
      type: '부분 확인',
      description: '409 가 사전 검사(existsBy)에서 났는지 저장 실패(DataIntegrityViolation)에서 났는지 구분하지 못해, 저장 실패 경로를 지났는지는 보장하지 못한다. BE 단위 테스트로 넘길 항목',
    });
    test.info().annotations.push({
      type: '대체 확인',
      description: '공용 DB 를 실패시킬 수 없어, 같은 쌍에 동시에 보낸 연결 요청 중 저장이 막힌 것들(409)에서 알림이 늘지 않는지로 확인한다(저장 뒤에만 AFTER_COMMIT 으로 발송). 저장 성공 1건만 알림 1건이어야 한다',
    });
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];
    const page = await openAs('anonymous', '/login');
    const topic = `/topic/${ward.id}/connection-request`;
    expect((await p1aOpen(page, 'ward', wsUrl(w.login.accessToken))).connected, '준비: 피보호자 연결').toBe(true);
    await p1aSubscribe(page, 'ward', topic, 'w-req');
    await p1aSettle(page, 'ward');

    const results = await Promise.all(
      Array.from({ length: 4 }, () => g.api.raw('POST', REQUEST, { targetId: ward.id, relation: '딸' })),
    );
    const statuses = results.map(r => r.status()).sort();
    for (const r of results.filter(x => x.status() === 409)) {
      expect.soft((await bodyOf(r)).code, '저장이 막힌 요청의 오류 코드').toBe('CONNECTION_ALREADY_EXISTS');
    }
    expect(statuses, '동시에 4건: 1건만 저장(200)되고 나머지는 중복 409').toEqual([200, 409, 409, 409]);
    expect(Number(psql(`SELECT count(*) FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`)), '연결 행은 1건').toBe(1);

    await p1aWaitFor(page, 'ward', topic, '저장된 1건의 알림(WS)은 도착해야 한다');
    await waitForLog(ward.id, 'CONNECTION_REQUEST');
    await page.waitForTimeout(3_000); // 저장 실패분의 알림이 뒤늦게 오지 않는지 짧게 더 본다
    expect(logRows(ward.id, 'CONNECTION_REQUEST').length, '알림 이력은 저장 성공 1건뿐').toBe(1);
    expect((await p1aBodies(page, 'ward', topic)).length, '실시간 알림도 1건뿐').toBe(1);
    await p1aClose(page, 'ward');
  });
});
