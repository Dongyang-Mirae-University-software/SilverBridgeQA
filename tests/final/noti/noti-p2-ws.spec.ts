/**
 * 최종 QA - 알림(NOTI) P2 - 실시간(WebSocket) 복약 토픽
 *
 * 임시 사용자만 쓴다(전화번호·푸시 토큰 없음). STOMP 는 FE 오리진 페이지에서 직접 연다(P1a 도우미).
 * 구독 성립 신호(RECEIPT)가 없어 구독 확인은 실제 이벤트가 MESSAGE 로 오는 것으로 한다.
 */
import { psqlRows, sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import {
  addMedication,
  bodyOf,
  expect,
  logCountOf,
  logTypesOf,
  P2_TAGS,
  p1aBodies,
  p1aClose,
  p1aOpen,
  p1aSettle,
  p1aSubscribe,
  p1aWaitFor,
  requestConnection,
  test,
  waitForLog,
  wsUrl,
} from './_helpers-noti-p2';

test.describe('복약 실시간 토픽', () => {
  test('NOTI-N43 복약 체크·해제 실시간 반영, 묶음 체크도 약마다 1건', P2_TAGS, async ({ tempUser, login, openAs }) => {
    test.setTimeout(180_000);
    const ward = await tempUser('WARD', { phone: null });
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const [w, a, b] = [await login(ward), await login(g1), await login(g2)];
    // 복용 시각을 하루 끝 쪽으로 잡아 복약 시각 알림(스케줄러)이 이 확인에 섞이지 않게 한다
    const med1 = await addMedication(a.api, ward.id, '23:50:00', 'QA약A');
    const med2 = await addMedication(a.api, ward.id, '23:55:00', 'QA약B');

    const page = await openAs('anonymous', '/login');
    const parties = [
      { name: 'ward', id: ward.id, token: w.login.accessToken },
      { name: 'g1', id: g1.id, token: a.login.accessToken },
      { name: 'g2', id: g2.id, token: b.login.accessToken },
    ];
    try {
      for (const p of parties) {
        expect((await p1aOpen(page, p.name, wsUrl(p.token))).connected, `준비: ${p.name} 연결`).toBe(true);
        await p1aSubscribe(page, p.name, `/topic/${p.id}/medication-taken`, `m-${p.name}`);
      }
      for (const p of parties) await p1aSettle(page, p.name);

      const topic = (id: string) => `/topic/${id}/medication-taken`;
      const waitAll = (count: number, why: string) => Promise.all(parties.map(p => p1aWaitFor(page, p.name, topic(p.id), `${p.name}: ${why}`, count)));

      await test.step('약 1개 체크 -> 보호자 전원과 본인에게 1건씩(taken=true, takenAt 있음)', async () => {
        expect((await w.api.raw('POST', `/api/ward/medication/${med1}/intake`)).status(), '체크 200').toBe(200);
        const all = await waitAll(1, '체크 알림');
        for (const [i, msgs] of all.entries()) {
          expect(msgs[0], `${parties[i].name}: 체크 payload`).toMatchObject({ medicationId: String(med1), wardId: ward.id, taken: 'true' });
          expect(msgs[0].takenAt, `${parties[i].name}: 체크하면 takenAt 이 있다`).toEqual(expect.any(String));
        }
      });

      await test.step('체크 해제 -> 같은 수신자에게 taken=false, takenAt=null', async () => {
        expect((await w.api.raw('DELETE', `/api/ward/medication/${med1}/intake`)).status(), '해제 200').toBe(200);
        const all = await waitAll(2, '해제 알림');
        for (const [i, msgs] of all.entries()) {
          expect(msgs[1], `${parties[i].name}: 해제 payload`).toMatchObject({ medicationId: String(med1), wardId: ward.id, taken: 'false', takenAt: null });
        }
      });

      await test.step('묶음 체크(약 2개) -> 약마다 1건씩, 수신자마다 2건 추가', async () => {
        const batch = await w.api.raw('POST', '/api/ward/medication/intake/batch', { medicationIds: [med1, med2], taken: true });
        expect(batch.status(), `묶음 체크 200 (${JSON.stringify((await bodyOf(batch)).message)})`).toBe(200);
        const all = await waitAll(4, '묶음 체크 알림');
        for (const [i, msgs] of all.entries()) {
          expect(msgs, `${parties[i].name}: 지금까지 정확히 4건(체크, 해제, 묶음 2건)`).toHaveLength(4);
          const batchMsgs = msgs.slice(2);
          expect(batchMsgs.map(m => m.medicationId).sort(), `${parties[i].name}: 묶음 알림은 약마다 1건`).toEqual([String(med1), String(med2)].sort());
          for (const m of batchMsgs) expect(m, `${parties[i].name}: 묶음 알림 taken`).toMatchObject({ taken: 'true', wardId: ward.id });
        }
      });

      await test.step('푸시·문자 없음: 알림 이력(notification_log)이 생기지 않는다', async () => {
        // 시각에 따라 도는 스케줄러 알림(복약 시각, 저녁 미복용 요약)은 체크와 별개라 뺀다
        const scheduled = ['MEDICATION_REMINDER', 'MEDICATION_MISSED'];
        expect(logTypesOf(g1.id).filter(t => !scheduled.includes(t)), '보호자 1 에게 복약 체크로 생긴 알림 이력 없음').toEqual([]);
        expect(logTypesOf(g2.id).filter(t => !scheduled.includes(t)), '보호자 2 에게 복약 체크로 생긴 알림 이력 없음').toEqual([]);
        expect(logTypesOf(ward.id).filter(t => !scheduled.includes(t)), '본인에게도 복약 체크로 생긴 이력 없음(스케줄러 알림은 별개)').toEqual([]);
      });
    } finally {
      for (const p of parties) await p1aClose(page, p.name);
    }
  });

  test('NOTI-N44 medication-stopped 토픽 수신(남은 ACTIVE 보호자만)', P2_TAGS, async ({ tempUser, login, openAs }) => {
    test.setTimeout(180_000);
    const ward = await tempUser('WARD', { phone: null });
    const leaving = await tempUser('GUARDIAN', { phone: null });
    const staying = await tempUser('GUARDIAN', { phone: null });
    const pending = await tempUser('GUARDIAN', { phone: null });
    connect(leaving.id, ward.id);
    connect(staying.id, ward.id);
    const [l, s, p, w] = [await login(leaving), await login(staying), await login(pending), await login(ward)];
    // 아직 수락 전(PENDING)인 보호자: ACTIVE 가 아니므로 받으면 안 된다
    expect(await requestConnection(p.api, ward.id), '준비: 대기 중인 보호자의 연결 요청').toBe(200);
    expect(
      psqlRows(`SELECT status FROM connection WHERE guardian_id = ${sqlStr(pending.id)} AND ward_id = ${sqlStr(ward.id)};`).map(r => r[0]),
      '준비: 이 보호자의 연결은 아직 ACTIVE 가 아니다',
    ).toEqual(['PENDING']);
    await addMedication(l.api, ward.id, '23:50:00', 'QA약C');
    await addMedication(l.api, ward.id, '23:55:00', 'QA약D');

    const page = await openAs('anonymous', '/login');
    const parties = [
      { name: 'staying', id: s.user.id, token: s.login.accessToken },
      { name: 'pending', id: p.user.id, token: p.login.accessToken },
      { name: 'ward', id: w.user.id, token: w.login.accessToken },
    ];
    try {
      for (const q of parties) {
        expect((await p1aOpen(page, q.name, wsUrl(q.token))).connected, `준비: ${q.name} 연결`).toBe(true);
        await p1aSubscribe(page, q.name, `/topic/${q.id}/medication-stopped`, `s-${q.name}`);
      }
      for (const q of parties) await p1aSettle(page, q.name);

      const withdraw = await l.api.raw('DELETE', '/api/user/me', { password: leaving.password });
      expect(withdraw.status(), '준비: 약을 등록한 보호자 탈퇴').toBe(200);

      const [msg] = await p1aWaitFor(page, 'staying', `/topic/${staying.id}/medication-stopped`, '남은 보호자가 medication-stopped 를 받아야 한다');
      expect(msg, 'payload 는 wardId 와 stoppedCount 만(문자열 값)').toEqual({ wardId: ward.id, stoppedCount: '2' });
      await waitForLog(staying.id, 'MEDICATION_STOPPED'); // 같은 반복문에서 푸시 알림 기록까지 끝난 뒤의 상태로 본다

      expect(await p1aBodies(page, 'pending', `/topic/${pending.id}/medication-stopped`), 'ACTIVE 가 아닌 보호자는 받지 않는다').toEqual([]);
      expect(await p1aBodies(page, 'ward', `/topic/${ward.id}/medication-stopped`), '피보호자 본인에게는 보내지 않는다').toEqual([]);
      expect(logCountOf(pending.id), 'ACTIVE 가 아닌 보호자에게는 알림 이력도 없다').toBe(0);
    } finally {
      for (const q of parties) await p1aClose(page, q.name);
    }
  });

  test('NOTI-N44b camera-analysis 토픽은 보호자만, 상태가 변할 때만 2초 간격', P2_TAGS, async () => {
    test.fixme(
      true,
      '실행하지 않음(CAM 영역 소관): camera-analysis 는 카메라 등록과 AI 분석 신호(공유 AI 서버에 사진)가 있어야 생긴다. 이 작업의 규칙상 송출 화면 도우미(src/fire.ts)도 쓰지 않는다. 코드 근거: LiveAnalysisBroadcaster(MIN_INTERVAL_MILLIS=2000, 보호자 토픽 /topic/{guardianId}/camera-analysis). CAM 영역 테스트(CAM_SIGNAL_ALLOWED=1)에서 확인',
    );
  });
});
