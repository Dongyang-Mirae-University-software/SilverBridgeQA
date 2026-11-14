/**
 * 최종 QA - 관리자(ADM) P2: 회원 관리 · 강제 연결
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 임시 사용자는 전화번호가 없어 문자가 나가지 않고, FCM 토큰도 없어 푸시도 나가지 않는다.
 *  - 연결·알림 이력은 임시 사용자 id 로 거른 행만 만들고 지운다. 감사 로그도 이 임시 관리자 id 것만 지운다.
 *  - 실패 메시지에는 상태 코드·개수만 넣는다.
 */
import {
  auditRows, bodyOf, connectionIdOf, connectionStatus, deleteAuditOf, deleteLinksOf, expect, expectCode, getBody, insertConnection,
  notifRows, psqlOne, settle, TAGS, test, uniq, userExists, userStatusRow,
} from './_helpers-adm-p2';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const absentUserId = () => {
  for (let i = 0; i < 10; i++) {
    const id = `qa${Math.random().toString(36).slice(2, 6).padEnd(4, 'x')}`;
    if (psqlOne(`SELECT count(*) FROM users WHERE id = '${id}';`) === '0') return id;
  }
  throw new Error('비어 있는 회원 id 를 찾지 못했습니다.');
};

test('ADM-A19 이미 정지된 계정에 사유만 다시 보냄', TAGS, async ({ tempUser, signIn, later }) => {
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  const first = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { status: 'RESTRICTED', statusReason: `첫사유${tag}` }));
  expect(first.status, `준비: 첫 정지 응답 상태 ${first.status}`).toBe(200);
  expect(userStatusRow(guardian.id).status, '준비: 정지 상태').toBe('RESTRICTED');
  expect(userStatusRow(guardian.id).reason, '준비: 첫 사유').toBe(`첫사유${tag}`);

  // 같은 상태(정지) + 새 사유
  const again = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { status: 'RESTRICTED', statusReason: `새사유${tag}` }));
  const reasonAfter = userStatusRow(guardian.id).reason;
  test.info().annotations.push({
    type: '문서와 코드 차이',
    description: `문서는 '사유가 갱신되거나 거부'(둘 중 하나)로 적었지만 기대값은 '갱신'으로 고정한다. 실측: 응답 상태 ${again.status}, 저장된 사유가 새 사유인지 ${reasonAfter === `새사유${tag}`}. 고칠 곳 추정: AdminUserService.applyStatus 의 '상태가 같으면 바로 return' 부분.`,
  });
  expect(again.status, `정지 상태에 사유만 다시 보낸 응답 상태 ${again.status}`).toBe(200);
  expect(reasonAfter, '성공(200)을 돌려줬으면 정지 사유가 새 사유로 바뀌어야 한다(성공 응답인데 값이 안 바뀌면 결함)').toBe(`새사유${tag}`);
  expect(userStatusRow(guardian.id).status, '정지 상태는 그대로').toBe('RESTRICTED');
});

test('ADM-A20 없는 회원·이미 탈퇴한 회원', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  const probe = async (id: string, label: string) => {
    expectCode(await getBody(a.api, `/api/admin/user/${id}`), 404, 'USER_NOT_FOUND', `${label} 상세`);
    expectCode(await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${id}`, { name: '새이름' })), 404, 'USER_NOT_FOUND', `${label} 수정`);
    expectCode(await bodyOf(await a.api.raw('DELETE', `/api/admin/user/${id}`)), 404, 'USER_NOT_FOUND', `${label} 탈퇴`);
  };

  await probe(absentUserId(), '없는 id');

  // 강제 탈퇴 한 번: 200, 계정은 사라지고 감사 기록은 1건
  const first = await bodyOf(await a.api.raw('DELETE', `/api/admin/user/${ward.id}`));
  expect(first.status, `첫 강제 탈퇴 응답 상태 ${first.status}`).toBe(200);
  await expect.poll(() => userExists(ward.id), { timeout: 30_000, message: '강제 탈퇴한 계정이 지워졌는지' }).toBe(false);

  await probe(ward.id, '이미 탈퇴한 id');
  const forced = () => Number(psqlOne(`SELECT count(*) FROM admin_audit_log WHERE target_id = '${ward.id}' AND action = 'USER_FORCE_DELETE';`));
  const count = await settle(forced, n => n > 1, 3_000);
  expect(count, '재탈퇴를 시도해도 강제 탈퇴 감사 기록은 1건 그대로').toBe(1);
  expect(
    Number(psqlOne(`SELECT count(*) FROM admin_audit_log WHERE admin_id = '${admin.id}' AND target_id = '${ward.id}';`)),
    '이 계정에 대한 이 관리자의 기록은 강제 탈퇴 1건뿐(수정 시도 기록 없음)',
  ).toBe(1);
});

test('ADM-A25 정지 상태 피보호자 데이터는 이름만 고쳐도 400', TAGS, async ({ tempUser, signIn, later }) => {
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  // 옛 데이터 전제: 피보호자는 지금 규칙으로 정지할 수 없지만 DB 에는 정지된 피보호자가 남아 있을 수 있다
  const oldWard = await tempUser('WARD', { phone: null, status: 'RESTRICTED', name: `QA옛피${tag}` });
  const newWard = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));
  test.info().annotations.push({
    type: '보류',
    description: "옛 데이터로만 생기는 상태(피보호자 정지)를 DB 로 만들어 현재 동작만 기록한다. 기대값은 '이름 수정 성공'이 아니라 현재 동작(400 WARD_CANNOT_BE_RESTRICTED)으로 고정한다. 정리 경로는 상태를 ACTIVE 로 되돌리는 요청이다. 문서(BE 2006-2010)는 '피보호자는 정지할 수 없다'.",
  });

  // 0) 지금 규칙: 정상 피보호자는 정지시킬 수 없다(그런 상태가 새로 생기는 경로는 없다)
  expectCode(
    await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${newWard.id}`, { status: 'RESTRICTED', statusReason: '확인' })),
    400, 'WARD_CANNOT_BE_RESTRICTED', '정상 피보호자 정지 시도',
  );
  expect(userStatusRow(newWard.id).status, '정상 피보호자는 그대로 ACTIVE').toBe('ACTIVE');

  // 1) 현재 동작: 정지 상태 피보호자는 이름만 보내도 400 이고 이름은 그대로
  const nameOnly = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${oldWard.id}`, { name: `QA새이름${tag}` }));
  expectCode(nameOnly, 400, 'WARD_CANNOT_BE_RESTRICTED', '정지 피보호자 이름만 수정');
  expect(userStatusRow(oldWard.id).name, '거절됐으므로 이름은 그대로').toBe(`QA옛피${tag}`);
  expect(auditRows(oldWard.id), '거절된 요청은 감사 기록을 남기지 않는다').toEqual([]);

  // 2) 정리 경로: 상태를 ACTIVE 로 되돌리면 통과하고, 그 뒤에는 이름도 수정된다
  const release = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${oldWard.id}`, { status: 'ACTIVE' }));
  expect(release.status, `정지 해제 응답 상태 ${release.status}`).toBe(200);
  expect(userStatusRow(oldWard.id).status, '정지가 풀렸다').toBe('ACTIVE');
  const rename = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${oldWard.id}`, { name: `QA새이름${tag}` }));
  expect(rename.status, `해제 뒤 이름 수정 응답 상태 ${rename.status}`).toBe(200);
  expect(userStatusRow(oldWard.id).name, '이름이 바뀌었다').toBe(`QA새이름${tag}`);
});

test('ADM-A26 강제 탈퇴 기록 순서와 연결 해제 문구', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  later(() => deleteLinksOf([guardian.id, ward.id]));
  later(() => deleteAuditOf([admin.id]));
  test.info().annotations.push({
    type: '수동 확인',
    description: "이 케이스의 앞부분('강제 탈퇴 중 삭제가 실패하면 기록이 실제와 안 맞는 점을 구분 표시')은 삭제를 일부러 실패시킬 수 없어 자동화하지 않는다(서버 설정·DB 구조 변경 금지). 코드상 AdminUserService.forceDelete 는 감사 기록을 삭제보다 먼저 남기고, 삭제 실패 시 구분 표시는 아직 없다(보류). 여기서는 뒷부분(역할 변경으로 끊긴 연결의 알림 문구)만 확인한다.",
  });

  insertConnection(guardian.id, ward.id, 'ACTIVE', '딸');
  // 피보호자를 보호자로 바꾼다 -> 연결이 관리자 조작으로 끊긴다. 남은 쪽(보호자)에게 가는 해제 문구를 본다
  const change = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${ward.id}`, { role: 'GUARDIAN' }));
  expect(change.status, `역할 변경 응답 상태 ${change.status}`).toBe(200);
  expect(connectionStatus(guardian.id, ward.id), '연결은 해제(DISCONNECTED)').toBe('DISCONNECTED');

  const rows = await settle(() => notifRows(guardian.id, 'CONNECTION_DISCONNECTED'), r => r.length >= 1, 30_000);
  expect(rows.length, '남은 쪽에 해제 알림 이력 1건').toBe(1);
  expect(rows[0].body, "역할 변경으로 끊긴 연결의 안내는 '관리자가 해제'로 정확히(보호자가 끊은 것처럼 나가면 안 된다)").toBe('관리자가 연결을 해제했습니다.');
  const audit = auditRows(ward.id, 'USER_ROLE_CHANGE');
  expect(audit.length, '역할 변경 감사 기록 1건').toBe(1);
  expect(audit[0].detail, '감사 기록에 해제된 연결 수').toContain('연결 1건 해제');
});

test('ADM-A28 없는 id·이미 해제된 연결 해제', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  later(() => deleteLinksOf([guardian.id, ward.id]));
  later(() => deleteAuditOf([admin.id]));
  const missing = 2_000_000_000;
  expect(psqlOne(`SELECT count(*) FROM connection WHERE id = ${missing};`), '준비: 없는 연결 id').toBe('0');

  expectCode(await bodyOf(await a.api.raw('DELETE', `/api/admin/connection/${missing}`)), 404, 'CONNECTION_NOT_FOUND', '없는 id 해제');

  insertConnection(guardian.id, ward.id, 'ACTIVE', '아들');
  const id = connectionIdOf(guardian.id, ward.id);
  const first = await bodyOf(await a.api.raw('DELETE', `/api/admin/connection/${id}`));
  expect(first.status, `첫 해제 응답 상태 ${first.status}`).toBe(200);
  expect(connectionStatus(guardian.id, ward.id), '첫 해제 뒤 연결 상태').toBe('DISCONNECTED');
  // 양쪽 모두에게 해제 알림 1건씩
  await expect.poll(() => notifRows(guardian.id, 'CONNECTION_DISCONNECTED').length, { timeout: 30_000, message: '보호자에게 해제 알림' }).toBe(1);
  await expect.poll(() => notifRows(ward.id, 'CONNECTION_DISCONNECTED').length, { timeout: 30_000, message: '피보호자에게 해제 알림' }).toBe(1);

  // 같은 id 를 다시 해제
  test.info().annotations.push({
    type: '문서와 다름(팀 확인 필요)',
    description: '문서는 없는 id·이미 해제된 연결 모두 404 로 적었다. 코드는 없는 id 는 404 CONNECTION_NOT_FOUND, 이미 해제된 연결은 409 CONNECTION_NOT_ACTIVE 다(ConnectionService.forceDisconnect). 코드 값으로 고정한다. 문서와 코드 중 어느 쪽을 맞출지 팀이 정해야 한다(재해제 404 또는 409).',
  });
  for (let i = 1; i <= 2; i++) {
    expectCode(await bodyOf(await a.api.raw('DELETE', `/api/admin/connection/${id}`)), 409, 'CONNECTION_NOT_ACTIVE', `이미 해제된 연결 ${i}번째 재해제`);
  }
  expect(auditRows(String(id), 'FORCE_DISCONNECT').length, '강제 해제 감사 기록은 1건 그대로').toBe(1);
  const extraGuardian = await settle(() => notifRows(guardian.id, 'CONNECTION_DISCONNECTED').length, n => n > 1, 4_000);
  const extraWard = await settle(() => notifRows(ward.id, 'CONNECTION_DISCONNECTED').length, n => n > 1, 1_000);
  expect(extraGuardian, '재해제에도 보호자 알림은 1건 그대로').toBe(1);
  expect(extraWard, '재해제에도 피보호자 알림은 1건 그대로').toBe(1);
});

test('ADM-A30 보호자가 정지돼도 피보호자 화면은 연결됨으로만 보임', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const guardianName = `QA가족${tag}`;
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { name: guardianName, phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  const w = await signIn(ward);
  later(() => deleteLinksOf([guardian.id, ward.id]));
  later(() => deleteAuditOf([admin.id]));
  test.info().annotations.push({
    type: '보류',
    description: "팀 판단용 기록: 현재 설계는 정지된 보호자를 피보호자 화면에 따로 표시하지 않는다(CONN-G08). 정지는 연결을 정리하지 않으므로 연결은 ACTIVE 로 남고, 유일한 보호자가 정지되면 알림 사각지대로 대시보드에만 잡힌다(ADMIN-G27). 이 시험은 현재 동작을 고정해 기록한다.",
  });
  insertConnection(guardian.id, ward.id, 'ACTIVE', '딸');

  const restrict = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { status: 'RESTRICTED', statusReason: '본인 확인 중' }));
  expect(restrict.status, `보호자 정지 응답 상태 ${restrict.status}`).toBe(200);
  expect(userStatusRow(guardian.id).status, '보호자는 정지 상태').toBe('RESTRICTED');
  expect(connectionStatus(guardian.id, ward.id), '정지는 연결을 정리하지 않는다(ACTIVE 그대로)').toBe('ACTIVE');

  // 대시보드 사각지대: 유일한 보호자가 정지면 wardsWithoutReachableGuardian 이 1 늘고 wardsWithoutGuardian 은 그대로.
  // 공용 숫자라 "정지 상태 vs 정지를 푼 상태"를 이어서 비교하고 어긋나면 3번까지 다시 잰다(끝나면 다시 정지 상태)
  const safetyEvents = async () => {
    const res = await getBody(a.api, '/api/admin/dashboard/safety');
    expect(res.status, `안전 현황 응답 상태 ${res.status}`).toBe(200);
    return res.json.data.safetyEvents as { wardsWithoutReachableGuardian: number; wardsWithoutGuardian: number };
  };
  let blindSpot = '';
  let blindOk = false;
  for (let attempt = 1; attempt <= 3 && !blindOk; attempt++) {
    const restrictedState = await safetyEvents();
    const un = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { status: 'ACTIVE' }));
    expect(un.status, `비교용 정지 해제 응답 상태 ${un.status}`).toBe(200);
    const activeState = await safetyEvents();
    const back = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { status: 'RESTRICTED', statusReason: '본인 확인 중' }));
    expect(back.status, `다시 정지 응답 상태 ${back.status}`).toBe(200);
    const dReach = restrictedState.wardsWithoutReachableGuardian - activeState.wardsWithoutReachableGuardian;
    const dGuard = restrictedState.wardsWithoutGuardian - activeState.wardsWithoutGuardian;
    blindSpot = `시도 ${attempt}: wardsWithoutReachableGuardian +${dReach}(기대 +1), wardsWithoutGuardian +${dGuard}(기대 +0)`;
    blindOk = dReach === 1 && dGuard === 0;
  }
  test.info().annotations.push({ type: '대시보드', description: blindSpot });
  expect(blindOk, `유일한 보호자 정지는 사각지대(wardsWithoutReachableGuardian)로만 잡혀야 한다. ${blindSpot}`).toBe(true);
  expect(userStatusRow(guardian.id).status, '확인 뒤 보호자는 다시 정지 상태').toBe('RESTRICTED');

  const page = await openAs(w.who, '/ward/guardians');
  const list = page.getByRole('list', { name: '연결된 보호자' });
  const item = list.getByRole('listitem').filter({ hasText: guardianName });
  await expect(item, '정지된 보호자도 피보호자의 연결된 보호자 목록에 그대로 보인다').toBeVisible();
  await expect(item.getByRole('button', { name: '연결 끊기' })).toBeVisible();
  // 이름과 전화번호(화면에 보이는 값)는 빼고 남은 글자만 본다. 실패 메시지에 화면 본문을 싣지 않는다
  const rest = ((await item.innerText()) ?? '').replace(guardianName, '').replace(/\d{2,3}-\d{3,4}-\d{4}/g, '').replace(/\s+/g, ' ');
  expect(/정지|제한|이용 중지|사용 불가/.test(rest), '정지·제한을 알리는 표시가 있다(현재 설계는 표시 없음)').toBe(false);
  expect(rest.includes('연결 끊기'), '남은 글자에는 연결 끊기 버튼 문구가 있다').toBe(true);
});
