/**
 * 최종 QA - 관리자(ADM) P1a: 강제 연결·해제
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 전화번호는 모두 없음(phone: null)이고 FCM 토큰도 없어 문자·푸시가 나갈 수 없다.
 *  - 관리자 조치가 남긴 감사 로그는 이 임시 관리자 id 로 골라 지운다(finally 성격의 later 정리).
 *  - DB 는 읽기 위주이고 쓰는 것은 임시 사용자 자신의 연결 행뿐이다. Redis 는 만지지 않는다.
 *  - 실패 메시지에는 상태 코드·개수만 넣는다.
 */
import { Api } from '../../../src/api';
import { waitForRealtime } from '../../../src/fixtures';
import { sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import {
  auditCountOf, bodyOf, connectionRows, deleteAuditOf, expect, expectError, notificationRows, pendingConnection, psqlOne,
  settle, sleep, TAGS, test, uniq,
} from './_helpers-adm-p1a';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const forceConnect = async (api: Api, guardianId: string, wardId: string) => bodyOf(await api.raw('POST', '/api/admin/connection', { guardianId, wardId }));

// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A27 연결할 수 없는 경우 거부', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const g1 = await tempUser('GUARDIAN', { phone: null });
  const g2 = await tempUser('GUARDIAN', { phone: null });
  const w1 = await tempUser('WARD', { phone: null });
  const w2 = await tempUser('WARD', { phone: null });
  const restricted = await tempUser('GUARDIAN', { phone: null, status: 'RESTRICTED' });
  const leaving = await tempUser('WARD', { phone: null, status: 'INACTIVE' });
  connect(g1.id, w2.id); // 이미 연결된 쌍
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  const attempts: Array<{ label: string; guardianId: string; wardId: string; status: number; code: string }> = [
    { label: '보호자-보호자', guardianId: g1.id, wardId: g2.id, status: 400, code: 'INVALID_CONNECTION_ROLE' },
    { label: '피보호자-피보호자', guardianId: w1.id, wardId: w2.id, status: 400, code: 'INVALID_CONNECTION_ROLE' },
    { label: '이용 제한 계정', guardianId: restricted.id, wardId: w1.id, status: 400, code: 'CONNECTION_TARGET_NOT_ACTIVE' },
    { label: '탈퇴 중 계정', guardianId: g1.id, wardId: leaving.id, status: 400, code: 'CONNECTION_TARGET_NOT_ACTIVE' },
    { label: '이미 연결된 쌍', guardianId: g1.id, wardId: w2.id, status: 409, code: 'CONNECTION_ALREADY_EXISTS' },
    { label: '관리자 id 를 보호자로', guardianId: admin.id, wardId: w1.id, status: 400, code: 'INVALID_CONNECTION_ROLE' },
    { label: '관리자 id 를 피보호자로', guardianId: g1.id, wardId: admin.id, status: 400, code: 'INVALID_CONNECTION_ROLE' },
  ];
  const shapes = new Set<string>();
  for (const attempt of attempts) {
    const res = await forceConnect(a.api, attempt.guardianId, attempt.wardId);
    expectError(res, attempt.status, attempt.code, attempt.label);
    expect(res.json.success, `${attempt.label}: success=false`).toBe(false);
    expect(typeof res.json.message === 'string' && res.json.message.length > 0, `${attempt.label}: 안내 문구가 비어 있다`).toBe(true);
    shapes.add(Object.keys(res.json).sort().join(','));
  }
  expect([...shapes], '오류 응답의 칸 구성이 거부 사유마다 같아야 한다(일관된 형식)').toHaveLength(1);

  // 대조: 정상 쌍(g2-w1)은 연결되고 양쪽에 알림 이력이 남는다 - 알림이 비동기라 이 두 줄이 보인 뒤에야 "다른 쪽엔 없음"을 믿을 수 있다
  const control = await forceConnect(a.api, g2.id, w1.id);
  expect(control.status, `대조 연결 응답 상태 ${control.status}`).toBe(200);
  await expect.poll(() => notificationRows(g2.id, 'CONNECTION_FORCED').length, { timeout: 30_000, message: '대조 보호자의 강제 연결 알림' }).toBe(1);
  await expect.poll(() => notificationRows(w1.id, 'CONNECTION_FORCED').length, { timeout: 30_000, message: '대조 피보호자의 강제 연결 알림' }).toBe(1);

  // 거부된 시도에는 연결·알림·감사 기록이 없다
  expect(connectionRows(g1.id, g2.id), '보호자-보호자 연결 행').toHaveLength(0);
  expect(connectionRows(w1.id, w2.id), '피보호자-피보호자 연결 행').toHaveLength(0);
  expect(connectionRows(restricted.id, w1.id), '이용 제한 계정 연결 행').toHaveLength(0);
  expect(connectionRows(g1.id, leaving.id), '탈퇴 중 계정 연결 행').toHaveLength(0);
  expect(connectionRows(admin.id, w1.id), '관리자-피보호자 연결 행').toHaveLength(0);
  expect(connectionRows(g1.id, admin.id), '보호자-관리자 연결 행').toHaveLength(0);
  expect(connectionRows(g1.id, w2.id), '이미 연결된 쌍은 1건 그대로').toHaveLength(1);
  for (const [name, id] of [['g1', g1.id], ['w2', w2.id], ['restricted', restricted.id], ['leaving', leaving.id], ['admin', admin.id]]) {
    expect(notificationRows(id, 'CONNECTION_FORCED'), `${name} 앞으로 강제 연결 알림이 생겼다`).toHaveLength(0);
  }
  expect(auditCountOf(admin.id, 'FORCE_CONNECT'), '감사 로그는 대조 연결 1건뿐').toBe(1);
});

test('ADM-A29 같은 쌍을 동시에 강제 연결', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  const [first, second] = await Promise.all([forceConnect(a.api, guardian.id, ward.id), forceConnect(a.api, guardian.id, ward.id)]);
  const statuses = [first.status, second.status].sort();
  expect(statuses, '동시 두 요청의 응답 상태(하나는 200, 하나는 이미 연결됨 409)').toEqual([200, 409]);
  const loser = first.status === 409 ? first : second;
  expect(loser.json.code, '진 쪽의 에러 code').toBe('CONNECTION_ALREADY_EXISTS');

  const rows = connectionRows(guardian.id, ward.id);
  expect(rows, '같은 쌍의 연결 행').toHaveLength(1);
  expect(rows[0].status).toBe('ACTIVE');

  // 알림 중복 없음: 한 건이 도착한 뒤, 더 쌓이지 않는지 잠깐 더 본다(없음을 확인하려면 기다릴 수밖에 없다)
  await expect.poll(() => notificationRows(guardian.id, 'CONNECTION_FORCED').length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => notificationRows(ward.id, 'CONNECTION_FORCED').length, { timeout: 30_000 }).toBe(1);
  // 비동기 알림 실행기가 두 번째 알림을 늦게 만들더라도 잡도록 0.5초 간격으로 8번(약 4초) 확인한다. 한 번이라도 2건이 되면 바로 실패한다.
  for (let i = 0; i < 8; i++) {
    await sleep(500);
    expect(notificationRows(guardian.id, 'CONNECTION_FORCED'), `보호자 알림 중복(${i + 1}번째 확인)`).toHaveLength(1);
    expect(notificationRows(ward.id, 'CONNECTION_FORCED'), `피보호자 알림 중복(${i + 1}번째 확인)`).toHaveLength(1);
  }
  expect(auditCountOf(admin.id, 'FORCE_CONNECT'), '감사 로그').toBe(1);
});

test('ADM-N40 수락 대기 요청이 있으면 그 요청을 연결 상태로 바꿈', TAGS, async ({ tempUser, signIn, later }) => {
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  const pendingId = pendingConnection(guardian.id, ward.id);
  expect(connectionRows(guardian.id, ward.id), '준비: 수락 대기 1건').toEqual([{ id: pendingId, status: 'PENDING', connected: false }]);

  const res = await forceConnect(a.api, guardian.id, ward.id);
  expect(res.status, `강제 연결 응답 상태 ${res.status}`).toBe(200);
  expect(res.json.data?.connectionId, '응답의 연결 id 는 기존 요청 id').toBe(pendingId);
  expect(res.json.data?.status).toBe('ACTIVE');

  const rows = connectionRows(guardian.id, ward.id);
  expect(rows, '새 행을 만들지 않고 기존 요청이 연결됨으로 바뀐다(쌍당 1건)').toEqual([{ id: pendingId, status: 'ACTIVE', connected: true }]);
  await expect.poll(() => notificationRows(guardian.id, 'CONNECTION_FORCED').length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => notificationRows(ward.id, 'CONNECTION_FORCED').length, { timeout: 30_000 }).toBe(1);
});

test('ADM-N41 강제 연결 해제', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const guardian2 = await tempUser('GUARDIAN', { phone: null });
  const ward2 = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  const g = await signIn(guardian);
  later(() => deleteAuditOf([admin.id]));

  // 1) API 로 해제
  connect(guardian.id, ward.id);
  const connectionId = Number(psqlOne(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`));
  const before = await g.api.raw('GET', `/api/guardian/ward/${ward.id}/medication-alert-setting`);
  expect(before.status(), '준비: 연결 중에는 보호자가 피보호자 설정을 볼 수 있다').toBe(200);

  const del = await bodyOf(await a.api.raw('DELETE', `/api/admin/connection/${connectionId}`));
  expect(del.status, `강제 해제 응답 상태 ${del.status}`).toBe(200);
  expect(connectionRows(guardian.id, ward.id), '해제 뒤 연결 행').toEqual([{ id: connectionId, status: 'DISCONNECTED', connected: true }]);

  // 양쪽 모두에게 해제 알림, 감사 기록
  await expect.poll(() => notificationRows(guardian.id, 'CONNECTION_DISCONNECTED').length, { timeout: 30_000, message: '보호자 해제 알림' }).toBe(1);
  await expect.poll(() => notificationRows(ward.id, 'CONNECTION_DISCONNECTED').length, { timeout: 30_000, message: '피보호자 해제 알림' }).toBe(1);
  expect(notificationRows(guardian.id, 'CONNECTION_DISCONNECTED')[0].body, '보호자 알림 문구').toBe('관리자가 연결을 해제했습니다.');
  const wardBody = notificationRows(ward.id, 'CONNECTION_DISCONNECTED')[0].body;
  // 2026-11-16(CONN-N06): 피보호자 문구는 어르신용 단문에 해제한 쪽(관리자)을 붙인다
  expect(wardBody, '피보호자 알림 문구(어르신용 단문, 관리자 표시)').toBe('관리자가 가족 연결을 해제했어요.');
  expect(auditCountOf(admin.id, 'FORCE_DISCONNECT'), '해제 감사 기록').toBe(1);
  expect(Number(psqlOne(`SELECT count(*) FROM admin_audit_log WHERE admin_id = ${sqlStr(admin.id)} AND action = 'FORCE_DISCONNECT' AND target_id = ${sqlStr(String(connectionId))};`)), '감사 기록의 대상 연결 id').toBe(1);

  // 해제 후 보호자는 피보호자 데이터를 볼 수 없다
  const after = await bodyOf(await g.api.raw('GET', `/api/guardian/ward/${ward.id}/medication-alert-setting`));
  expectError(after, 403, 'MEDICATION_NOT_AUTHORIZED', '해제 뒤 보호자의 피보호자 설정 조회');
  const list = await g.api.raw('GET', '/api/guardian/connection/select');
  expect(await list.text(), '해제 뒤 보호자의 연결 목록에 피보호자가 남아 있다').not.toContain(ward.id);

  // 2) 관리자 회원 상세 화면에서 해제
  connect(guardian2.id, ward2.id);
  const connection2 = Number(psqlOne(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardian2.id)} AND ward_id = ${sqlStr(ward2.id)};`));
  const page = await openAs(a.who, null);
  await page.goto('/admin/members');
  await expect(page.getByRole('heading', { level: 1, name: '회원 관리', exact: true })).toBeVisible();
  await page.getByPlaceholder('이름 · 이메일 · 전화번호 · 연결 회원 검색').fill(guardian2.email);
  const row = page.locator('tbody tr', { hasText: guardian2.email });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: '관리' }).click();
  const dialog = page.getByRole('dialog', { name: '회원 수정' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(ward2.name)).toBeVisible();
  await dialog.getByRole('button', { name: '해제', exact: true }).click();
  await expect(dialog.getByText('연결된 회원이 없습니다.'), '해제 뒤 상세 화면의 연결 목록').toBeVisible();

  expect(connectionRows(guardian2.id, ward2.id), '화면에서 해제한 연결 행').toEqual([{ id: connection2, status: 'DISCONNECTED', connected: true }]);
  await expect.poll(() => notificationRows(guardian2.id, 'CONNECTION_DISCONNECTED').length, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => notificationRows(ward2.id, 'CONNECTION_DISCONNECTED').length, { timeout: 30_000 }).toBe(1);
  expect(auditCountOf(admin.id, 'FORCE_DISCONNECT'), '화면 해제까지 감사 기록 2건').toBe(2);
});

test('ADM-N42 강제 연결 직후 피보호자 화면에 바로 나타남', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { name: `QA강제보호자${tag}`, phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const a = await signIn(admin);
  const w = await signIn(ward);
  later(() => deleteAuditOf([admin.id]));

  const page = await openAs(w.who, '/ward/guardians');
  await waitForRealtime(page);
  await expect(page.getByText('아직 연결된 가족이 없어요')).toBeVisible();

  const res = await forceConnect(a.api, guardian.id, ward.id);
  expect(res.status, `강제 연결 응답 상태 ${res.status}`).toBe(200);

  // 새로고침·포커스 이동 없이 반영을 기다린다
  const card = page.getByRole('list', { name: '연결된 보호자' }).getByRole('listitem').filter({ hasText: guardian.name });
  const shown = await settle(async () => await card.count(), count => count > 0, 20_000);
  const toastText = (await page.locator('[aria-live="polite"]').allInnerTexts()).join(' | ');
  test.info().annotations.push({
    type: '코드 확인',
    description: '피보호자 FE(connectionSocket.ts WARD_CONNECTION_TOPICS)는 connection-accepted 를 구독하지 않는다. 강제 연결 이벤트(connection-accepted)를 받지 못하면 목록이 실시간으로 갱신되지 않는다.',
  });
  expect(shown, '강제 연결된 보호자가 새로고침 없이 피보호자 화면 목록에 나타나야 한다').toBeGreaterThan(0);
  // 강제 연결 이벤트(WS connection-accepted)가 피보호자에게 싣는 문구: BE ConnectionNotificationListener.FORCED_WARD_BODY
  expect.soft(toastText, "피보호자 화면에 강제 연결 안내('가족과 연결됐어요. 앱에서 확인해 주세요.')가 있어야 한다").toContain('가족과 연결됐어요. 앱에서 확인해 주세요.');
  expect.soft(toastText, "수락했다는 거짓 안내가 없어야 한다").not.toMatch(/수락/);
});
