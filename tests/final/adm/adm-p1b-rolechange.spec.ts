/**
 * 최종 QA - 관리자(ADM) P1b: 역할 변경 정리와 정지 해제 후 알림 복구 (ADM-N36, N37, X02)
 *
 * 안전:
 *  - 임시 사용자(Owned)만 쓴다. 임시 사용자는 전화번호가 없어 문자가 나가지 않는다.
 *  - FCM 토큰은 X02 에서만 가짜 토큰 1개를 등록한다(실제 기기가 아니라 푸시 서버가 거절한다). 푸시는 그 한 건뿐이다.
 *  - 카메라 행은 CAM_SIGNAL_ALLOWED=1 일 때만 만든다(N37 의 카메라 단계).
 *  - 실시간 연결 주소에 토큰이 들어가므로 trace 를 끄고, 알림 본문이 담길 수 있는 영상·사진도 끈다.
 */
import { psql, redis, sqlStr } from '../../../src/remote';
import { bodyOf,  psqlOne, Safety, settle } from './_helpers-adm';
import {
  auditRows, notifRows, CAM_SIGNAL_ALLOWED, closeStompCapture, connectionStatus, doseTimeAfter, expect, insertConnection, openStompCapture, readStompCapture,
  TAGS, test, uniq,
} from './_helpers-adm-p1b';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

// 역할 변경은 관리자 조치(disconnectedBy=ADMIN) - 2026-11-16(CONN-N06)부터 피보호자 문구에 관리자 표시
const WARD_DISCONNECTED_BODY = '관리자가 가족 연결을 해제했어요.';
const GUARDIAN_ADMIN_DISCONNECTED_BODY = '관리자가 연결을 해제했습니다.';

test('ADM-N36 역할 변경 보호자 -> 피보호자: 연결 정리와 알림', TAGS, async ({ owned, openAs }) => {
  test.setTimeout(240_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const guardian = owned.user('GUARDIAN', { phone: null });
  const connected = owned.user('WARD', { phone: null }); // 연결된 피보호자
  const requested = owned.user('WARD', { phone: null }); // 수락 대기 중인 피보호자
  insertConnection(guardian.id, connected.id, 'ACTIVE', '아들');
  insertConnection(guardian.id, requested.id, 'PENDING', '딸');
  const g = await owned.login(guardian);
  const c = await owned.login(connected);
  const r = await owned.login(requested);

  // 실시간 연결(앱 화면 대신 FE 오리진 페이지에서 직접): 보호자 본인, 연결된 상대, 대기 중인 상대
  const page = await openAs('anonymous', '/login');
  expect(await openStompCapture(page, 'guardian', g.login.accessToken, [`/topic/${guardian.id}/sos-triggered`]), '준비: 보호자의 실시간 연결').toBe(true);
  expect(await openStompCapture(page, 'connected', c.login.accessToken, [`/topic/${connected.id}/connection-cancelled`]), '준비: 연결된 상대의 실시간 연결').toBe(true);
  expect(
    await openStompCapture(page, 'requested', r.login.accessToken, [`/topic/${requested.id}/connection-cancelled`, `/topic/${requested.id}/connection-refused`]),
    '준비: 대기 중인 상대의 실시간 연결',
  ).toBe(true);
  expect((await g.api.raw('GET', '/api/user/me')).status(), '준비: 변경 전 보호자 토큰은 유효').toBe(200);

  const change = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { role: 'WARD' }));
  expect(change.status, `역할 변경 응답 ${change.status}`).toBe(200);

  await test.step('연결 정리: 연결됨은 해제, 대기 요청은 취소', async () => {
    expect(psqlOne(`SELECT role FROM users WHERE id = ${sqlStr(guardian.id)};`)).toBe('WARD');
    expect(connectionStatus(guardian.id, connected.id), '연결됐던 쪽은 해제(DISCONNECTED)').toBe('DISCONNECTED');
    expect(connectionStatus(guardian.id, requested.id), '수락 대기 요청은 취소(CANCELLED)').toBe('CANCELLED');
  });

  await test.step('연결됐던 상대에게만 해제 알림이 간다 (보호자 문구가 아님)', async () => {
    const frames = await settle(() => readStompCapture(page, 'connected'), s => s.frames.length >= 1, 20_000);
    expect(frames.frames.length, '연결된 상대에게 실시간 해제 알림 1건').toBe(1);
    expect(frames.frames[0].destination).toBe(`/topic/${connected.id}/connection-cancelled`);
    const payload = JSON.parse(frames.frames[0].body) as { disconnectedBy?: string; body?: string; type?: string };
    expect(payload.disconnectedBy, '해제 주체는 관리자 조치').toBe('ADMIN');
    expect(payload.body, '받는 사람이 피보호자면 관리자 표시가 붙은 한 줄 문구').toBe(WARD_DISCONNECTED_BODY);
    expect(payload.body, '보호자 문구가 아니다').not.toContain('보호자가 연결을 해제');

    const rows = await settle(() => notifRows(connected.id, 'CONNECTION_DISCONNECTED'), x => x.length >= 1, 30_000);
    expect(rows.length, '알림 이력 1건').toBe(1);
    expect(rows[0].body, '알림 이력 문구').toBe(WARD_DISCONNECTED_BODY);
    expect(rows[0].body).not.toContain('보호자가 연결을 해제');
  });

  await test.step('대기 요청의 상대에게는 알림 없이 취소', async () => {
    const state = await readStompCapture(page, 'requested');
    expect(state.frames, '대기 중이던 상대에게 실시간 알림이 가지 않는다').toEqual([]);
    expect(Number(psqlOne(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(requested.id)};`)), '대기 중이던 상대의 알림 이력이 없다').toBe(0);
  });

  await test.step('토큰 무효화와 웹소켓 종료', async () => {
    const state = await settle(() => readStompCapture(page, 'guardian'), s => s.closed, 15_000);
    expect(state.closed, '역할이 바뀐 보호자의 웹소켓이 15초 안에 닫혀야 한다').toBe(true);
    expect([state.code, state.reason], '닫는 코드와 사유').toEqual([1008, 'AUTH_INVALIDATED']);
    expect((await g.api.raw('GET', '/api/user/me')).status(), '옛 역할의 토큰은 401').toBe(401);
  });

  await test.step('감사 로그', async () => {
    const audits = auditRows(guardian.id, 'USER_ROLE_CHANGE');
    expect(audits.length).toBe(1);
    expect(audits[0].detail, '연결 2건(연결됨 1 + 대기 1) 정리').toContain('연결 2건 해제');
  });

  await closeStompCapture(page, 'connected');
  await closeStompCapture(page, 'requested');
  test.info().annotations.push({
    type: '문서와 차이',
    description: `받는 사람이 피보호자이면 어르신용 한 줄 문구("${WARD_DISCONNECTED_BODY}", 2026-11-16 CONN-N06 결정), 보호자이면 "관리자가 연결을 해제했습니다"(ADM-N37 에서 확인). 해제 주체는 실시간 알림의 disconnectedBy=ADMIN 으로도 간다.`,
  });
});

test('ADM-N37 역할 변경 피보호자 -> 보호자: 카메라·클립·약 정리', TAGS, async ({ owned }) => {
  test.setTimeout(480_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const wardB = owned.user('WARD', { phone: null, name: `QA37B${tag}` }); // 보호자로 바꿀 피보호자
  const keeper = owned.user('GUARDIAN', { phone: null }); // B 에 연결된 보호자 (B 의 약을 등록)
  const wardC = owned.user('WARD', { phone: null }); // 대조군: 역할을 바꾸지 않는 피보호자
  const keeperC = owned.user('GUARDIAN', { phone: null });
  const wardD = owned.user('WARD', { phone: null }); // B 가 보호자로서 남에게 등록한 약의 주인
  insertConnection(keeper.id, wardB.id, 'ACTIVE', '아들');
  insertConnection(keeperC.id, wardC.id, 'ACTIVE', '아들');
  const k = await owned.login(keeper);
  const kc = await owned.login(keeperC);

  // 복용 시각을 1~2분 뒤로 잡아 실제 스케줄러가 한 바퀴 도는 걸 본다
  const doseAt = Math.floor((Date.now() + 120_000) / 60_000) * 60_000;
  const doseTime = doseTimeAfter(doseAt - Date.now());
  const register = async (api: typeof k.api, wardId: string, name: string) => {
    const res = await bodyOf(await api.raw('POST', `/api/guardian/ward/${wardId}/medication`, { name, timeSlot: 'MORNING', doseTime }));
    expect(res.status, `준비: 약 등록 상태 ${res.status}`).toBe(200);
  };
  await register(k.api, wardB.id, '[QA-ADMIN] N37 약');
  await register(kc.api, wardC.id, '[QA-ADMIN] N37 대조 약');
  // B 가 (보호자일 때) 남(D)에게 등록한 약: 6시간 뒤 복용이라 알림은 안 나간다. 피보호자 B 앞의 약이 아니므로 그대로 남아야 한다.
  psql(
    `INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time)
     VALUES (${sqlStr(wardD.id)}, ${sqlStr(wardB.id)}, '[QA-ADMIN] N37 남에게 등록한 약', 'MORNING', ${sqlStr(doseTimeAfter(6 * 3600_000))});`,
  );
  const aliveMeds = (wardId: string) => Number(psql(`SELECT count(*) FROM medication WHERE ward_id = ${sqlStr(wardId)} AND deleted_at IS NULL;`));
  expect(aliveMeds(wardB.id), '준비: B 앞의 살아 있는 약 1건').toBe(1);
  expect(aliveMeds(wardD.id), '준비: D 앞의 살아 있는 약 1건(B 가 등록)').toBe(1);

  if (CAM_SIGNAL_ALLOWED) {
    psql(
      `INSERT INTO camera (ward_id, session_id, device_id, label, registered_by, is_active)
       VALUES (${sqlStr(wardB.id)}, ${sqlStr(`qa_p1b_${tag}`)}, ${sqlStr(`qa-p1b-dev-${tag}`)}, '거실', ${sqlStr(wardB.id)}, true);`,
    );
    expect(Number(psql(`SELECT count(*) FROM camera WHERE ward_id = ${sqlStr(wardB.id)};`)), '준비: B 앞 카메라 1대').toBe(1);
  }

  const change = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${wardB.id}`, { role: 'GUARDIAN' }));
  expect(change.status, `역할 변경 응답 ${change.status}`).toBe(200);
  expect(psqlOne(`SELECT role FROM users WHERE id = ${sqlStr(wardB.id)};`)).toBe('GUARDIAN');

  await test.step('정리 결과: 약 중지, 연결 해제, 남에게 등록한 약은 그대로', async () => {
    expect(aliveMeds(wardB.id), 'B 앞의 약이 중지되지 않았다 - 복약 알림 대상으로 남는다').toBe(0);
    expect(aliveMeds(wardD.id), '보호자가 남에게 등록한 약은 그대로').toBe(1);
    expect(connectionStatus(keeper.id, wardB.id), '연결은 해제').toBe('DISCONNECTED');
    const audit = auditRows(wardB.id, 'USER_ROLE_CHANGE');
    expect(audit.length).toBe(1);
    expect(audit[0].detail, '감사 로그에 약 중지가 기록돼야 한다').toContain('복약 1건 중지');
    expect(audit[0].detail, '감사 로그에 연결 정리가 기록돼야 한다').toContain('연결 1건 해제');
    if (CAM_SIGNAL_ALLOWED) {
      expect(Number(psql(`SELECT count(*) FROM camera WHERE ward_id = ${sqlStr(wardB.id)};`)), 'B 앞 카메라가 삭제된다').toBe(0);
      expect(audit[0].detail, '감사 로그에 카메라 삭제가 기록돼야 한다').toContain('카메라 1대 삭제');
    } else {
      test.info().annotations.push({ type: '확인 안 함', description: '카메라·영상 클립 삭제는 카메라 등록이 필요해 CAM_SIGNAL_ALLOWED=1 일 때만 확인한다(이번 실행은 건너뜀)' });
    }
  });

  await test.step('연결됐던 보호자에게는 관리자 문구의 해제 알림이 간다', async () => {
    const rows = await settle(() => notifRows(keeper.id, 'CONNECTION_DISCONNECTED'), x => x.length >= 1, 30_000);
    expect(rows.length).toBe(1);
    expect(rows[0].body, '받는 사람이 보호자이면 관리자 조치 문구').toBe(GUARDIAN_ADMIN_DISCONNECTED_BODY);
  });

  await test.step('복용 시각이 지나도 옛 복약 알림이 오지 않는다 (대조 약에는 알림이 나간다)', async () => {
    const reminderRows = (wardId: string) =>
      Number(psql(`SELECT count(*) FROM medication_reminder_log r JOIN medication m ON m.id = r.medication_id WHERE m.ward_id = ${sqlStr(wardId)};`));
    const wait = Math.max(0, doseAt - Date.now()) + 150_000;
    const control = await settle(() => reminderRows(wardC.id), n => n >= 1, wait, 3_000);
    test.info().annotations.push({ type: '복약 알림', description: `대조 약 알림 기록 ${control}건, 복용 시각 ${doseTime} (한국 시간)` });
    expect(control, '준비: 역할을 바꾸지 않은 대조 약에는 복약 알림 기록이 남아야 한다(스케줄러가 돌았다는 증거)').toBeGreaterThanOrEqual(1);
    const stray = await settle(() => reminderRows(wardB.id), n => n > 0, 10_000, 2_000);
    expect(stray, '보호자로 바뀐 B 의 약에 복약 알림 기록이 생겼다').toBe(0);
    expect(notifRows(wardB.id, 'MEDICATION_REMINDER'), '보호자로 바뀐 B 에게 복약 알림 이력이 생겼다').toEqual([]);
    expect(aliveMeds(wardD.id), '알림 시각이 지난 뒤에도 남에게 등록한 약은 그대로').toBe(1);
  });
});

test('ADM-X02 정지를 풀면 보호자가 SOS·화재 알림을 다시 받는다', TAGS, async ({ owned, openAs }) => {
  test.setTimeout(300_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const ward = owned.user('WARD', { phone: null });
  const guardian = owned.user('GUARDIAN', { phone: null });
  insertConnection(guardian.id, ward.id, 'ACTIVE', '아들');
  const w = await owned.login(ward);
  const cooldownKey = `sos:notify:cooldown:${ward.id}`;

  const reachable = async () => {
    const res = await bodyOf(await a.api.raw('GET', '/api/admin/dashboard/safety'));
    expect(res.status, `안전 현황 응답 ${res.status}`).toBe(200);
    return (res.json.data as Safety).safetyEvents.wardsWithoutReachableGuardian;
  };
  const patchStatus = async (status: 'ACTIVE' | 'RESTRICTED') => {
    const res = await bodyOf(
      await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, status === 'RESTRICTED' ? { status, statusReason: '[QA-ADMIN] X02' } : { status }),
    );
    expect(res.status, `준비: ${status} 변경 응답 ${res.status}`).toBe(200);
  };
  /** 바꾸기 직전과 직후의 값 차이를 잰다(다른 영역이 동시에 바꾸면 어긋나므로 되돌렸다가 3번까지 다시) */
  const measure = async (from: 'ACTIVE' | 'RESTRICTED', to: 'ACTIVE' | 'RESTRICTED', expected: number) => {
    let diff = NaN;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await reachable();
      await patchStatus(to);
      diff = (await reachable()) - before;
      if (diff === expected) return diff;
      if (attempt < 3) await patchStatus(from);
    }
    return diff;
  };

  // 1) 정지: 대시보드 "연락 가능한 보호자 없음" +1 (연결은 남아 있으므로 보호자 없음 칸은 그대로)
  const onRestrict = await measure('ACTIVE', 'RESTRICTED', 1);
  expect(onRestrict, '유일한 보호자를 정지하면 wardsWithoutReachableGuardian 이 1 늘어야 한다').toBe(1);

  // 2) 정지 중 SOS: 보내지 않음(NOT_SENT) + 이유 RESTRICTED_ACCOUNT
  const sos1 = await bodyOf(await w.api.raw('POST', '/api/ward/sos', {}));
  expect(sos1.status, `SOS 응답 ${sos1.status}`).toBe(201);
  const blocked = await settle(() => notifRows(guardian.id, 'WARD_SOS'), rows => rows.length >= 1, 30_000);
  expect(blocked.length, '정지 중 SOS 알림 이력 1건').toBe(1);
  expect([blocked[0].result, blocked[0].reason], '정지 중에는 NOT_SENT(RESTRICTED_ACCOUNT)').toEqual(['NOT_SENT', 'RESTRICTED_ACCOUNT']);

  // 3) 해제: wardsWithoutReachableGuardian 이 다시 1 줄어 처음으로 돌아온다
  const onRelease = await measure('RESTRICTED', 'ACTIVE', -1);
  expect(onRelease, '정지를 풀면 wardsWithoutReachableGuardian 이 1 줄어 사각지대에서 빠져야 한다').toBe(-1);

  // 4) 다시 로그인하고 FCM 을 재등록한 뒤 SOS: 알림이 정상으로 시도된다
  const g = await owned.login(guardian);
  const page = await openAs('anonymous', '/login');
  expect(await openStompCapture(page, 'guardian', g.login.accessToken, [`/topic/${guardian.id}/sos-triggered`]), '준비: 해제 뒤 보호자의 실시간 연결').toBe(true);
  const fcm = await bodyOf(await g.api.raw('POST', '/api/notifications/fcm-token', { token: `qa-p1b-fake-${uniq()}${uniq()}`, platform: 'WEB' }));
  expect(fcm.status, `FCM 재등록 응답 ${fcm.status}`).toBe(200);
  redis('DEL', cooldownKey); // 이 피보호자의 SOS 알림 쿨다운 키만 지운다(첫 SOS 가 남긴 것)
  try {
  const sos2 = await bodyOf(await w.api.raw('POST', '/api/ward/sos', {}));
  expect(sos2.status, `해제 뒤 SOS 응답 ${sos2.status}`).toBe(201);

  const rows = await settle(() => notifRows(guardian.id, 'WARD_SOS'), x => x.length >= 2, 40_000);
  expect(rows.length, `해제 뒤 SOS 알림 이력이 한 건 더 생겨야 한다 (전체 ${rows.map(r => `${r.result}/${r.reason}`).join(', ')})`).toBe(2);
  const sent = rows[1];
  test.info().annotations.push({ type: '실측', description: `정지 중 ${blocked[0].result}/${blocked[0].reason}, 해제 뒤 ${sent.result}/${sent.reason || '-'}` });
  expect(sent.result, '해제 뒤에는 NOT_SENT 가 아니라 실제 발송을 시도한다').not.toBe('NOT_SENT');
  expect(sent.reason, '해제 뒤에는 보내지 않은 사유가 없다').toBe('');
  const channels = psqlOne(`SELECT channel_results::text FROM notification_log WHERE recipient_id = ${sqlStr(guardian.id)} AND type = 'WARD_SOS' ORDER BY id DESC LIMIT 1;`);
  expect(channels, '해제 뒤 알림에는 푸시(FCM) 시도 기록이 있다').toContain('FCM');

  const web = await settle(() => readStompCapture(page, 'guardian'), s => s.frames.length >= 1, 20_000);
  expect(web.frames.map(f => f.destination), '해제 뒤 웹 실시간 알림(sos-triggered)이 온다').toContain(`/topic/${guardian.id}/sos-triggered`);
  await closeStompCapture(page, 'guardian');

  test.info().annotations.push({
    type: '확인 범위',
    description: '문서는 해제 뒤 결과가 DELIVERED 라고 적었다. 임시 사용자는 실제 기기의 FCM 토큰이 없어 푸시 서버가 가짜 토큰을 거절하므로 DELIVERED 는 확인할 수 없다. 해제 뒤 결과가 NOT_SENT 가 아니고 푸시 시도 기록이 있으며 웹 실시간 알림이 오는 것까지 확인했다. 화재 알림은 카메라 신호가 필요해 돌리지 않았다(SOS 와 같은 알림 발송 경로).',
  });
  } finally {
    // 두 번째 SOS 가 새로 만든 쿨다운 키도 지운다(이 임시 피보호자의 키뿐). 실패해도 다음 정리는 계속된다.
    try { redis('DEL', cooldownKey); } catch { /* TTL 로 사라진다 */ }
  }
});
