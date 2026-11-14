/**
 * 최종 QA - 관리자(ADM) P1b: 회원 관리 (ADM-A18, A21, A24, N30, N31, N32, N35)
 *
 * 안전:
 *  - 임시 사용자(Owned)만 만들고 고친다. 고정 계정은 쓰지 않는다. 전화번호는 임시 대역이거나 없음(문자 발송 없음).
 *  - 회원 목록·탭 건수는 이 테스트 전용 꼬리표(이름)로 좁혀서 읽는다. 서비스 전체 숫자는 "내 사용자를 만들기 전후의 차이"로만 본다.
 *  - 관리자 조치가 남긴 감사 로그·알림 이력은 임시 사용자 id 로 걸러 정리 단계에서 지운다.
 *  - 회원 화면은 다른 회원 정보가 보일 수 있어 trace·영상·스크린샷을 끈다.
 */
import { Api } from '../../../src/api';
import { psql, sqlStr } from '../../../src/remote';
import { bodyOf, closeRawStomp,  openRawStomp, psqlOne, readRawStomp, settle, userExists, userStatusRow } from './_helpers-adm';
import {
  auditRows, notifRows, CAM_SIGNAL_ALLOWED, connectionStatus, expect, insertConnection, q, setUserFields, signin, TAGS, test, uniq,
} from './_helpers-adm-p1b';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

interface UserListRow {
  userId: string;
  name: string;
  role: string;
  status: string;
  statusReason: string | null;
  connectionState: string | null;
  connectionCount: number;
  firstConnection: { counterpartName: string; relation: string | null; status: string } | null;
  createdAt: string;
}
interface UserPage {
  content: UserListRow[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
}

const listUsers = async (api: Api, query: string): Promise<UserPage> => {
  const res = await bodyOf(await api.raw('GET', `/api/admin/user?${query}`));
  expect(res.status, `회원 목록 응답 상태 ${res.status}`).toBe(200);
  return res.json.data as UserPage;
};

test('ADM-A18 이름·정지 사유 입력 검증', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const target = owned.user('GUARDIAN', { phone: null, name: `QA18${tag}` });

  // 이름 오류: 빈 값, 공백만, 보이지 않는 글자만(제로폭·NBSP), NUL, 20자 초과 -> 모두 400 (500 아님)
  const badNames: [string, string][] = [
    ['빈 값', ''],
    ['공백만', '   '],
    ['제로폭 글자만', '​​​'],
    ['NBSP 만', '  '],
    ['NUL 이 섞임', 'a\u0000b'],
    ['NUL 만', '\u0000'],
    ['21자', '가'.repeat(21)],
  ];
  for (const [label, name] of badNames) {
    const res = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { name }));
    expect.soft(res.status, `이름 ${label}: 400 이어야 하는데 ${res.status}`).toBe(400);
  }
  expect.soft(userStatusRow(target.id).name, '이름 오류 요청은 저장되지 않는다(NUL 이 섞인 이름이 NUL 만 빼고 저장되면 안 된다)').toBe(target.name);

  // 정지 사유 201자는 400 이고 저장 안 됨 (상태도 그대로)
  const over = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: '가'.repeat(201) }));
  expect(over.status, `정지 사유 201자: 400 이어야 하는데 ${over.status}`).toBe(400);
  let row = userStatusRow(target.id);
  expect(row.status, '사유 201자 요청은 정지도 되지 않는다').toBe('ACTIVE');
  expect(row.reason, '사유 201자 요청은 사유도 저장되지 않는다').toBe('');

  // 200자는 성공
  const ok = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: '가'.repeat(200) }));
  expect(ok.status, `정지 사유 200자: 200 이어야 하는데 ${ok.status}`).toBe(200);
  row = userStatusRow(target.id);
  expect(row.status).toBe('RESTRICTED');
  expect([...row.reason].length, '저장된 사유는 200자').toBe(200);

  // 정지 상태에서 사유 201자로 다시 보내도 400 이고 기존 사유가 그대로
  const again = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { statusReason: 'b'.repeat(201) }));
  expect(again.status, `사유 201자(상태 안 바꿈): 400 이어야 하는데 ${again.status}`).toBe(400);
  expect([...userStatusRow(target.id).reason].length, '기존 사유가 그대로').toBe(200);
});

test('ADM-A21 동시 요청: 정지·역할 변경·강제 탈퇴 겹침', TAGS, async ({ owned }) => {
  test.setTimeout(420_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const seen: string[] = [];

  // (1) 같은 보호자에 정지와 역할 변경(피보호자로)을 동시에: 한쪽만 성공하고 다른 쪽은 400(피보호자는 정지 불가 조합)
  for (let round = 1; round <= 3; round++) {
    const guardian = owned.user('GUARDIAN', { phone: null });
    const ward = owned.user('WARD', { phone: null });
    insertConnection(guardian.id, ward.id, 'ACTIVE', '아들');
    const [restrict, roleChange] = await Promise.all([
      bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] A21' })),
      bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardian.id}`, { role: 'WARD' })),
    ]);
    const statuses = [restrict.status, roleChange.status].sort();
    const row = userStatusRow(guardian.id);
    const statusAudit = auditRows(guardian.id, 'USER_STATUS_CHANGE').length;
    const roleAudit = auditRows(guardian.id, 'USER_ROLE_CHANGE').length;
    seen.push(`정지+역할 ${round}회차: 정지 ${restrict.status}, 역할 ${roleChange.status}, 결과 ${row.role}/${row.status}`);
    expect(statuses, `${round}회차: 한쪽만 성공(200)하고 다른 쪽은 400 이어야 한다(500 금지) - 정지 ${restrict.status}, 역할 ${roleChange.status}`).toEqual([200, 400]);
    expect(`${row.role}/${row.status}`, `${round}회차: 피보호자인데 이용 제한인 조합은 만들어지면 안 된다`).not.toBe('WARD/RESTRICTED');
    if (restrict.status === 200) {
      expect(`${row.role}/${row.status}`, `${round}회차: 정지가 이겼다면 보호자·이용 제한`).toBe('GUARDIAN/RESTRICTED');
      expect({ statusAudit, roleAudit }, `${round}회차: 감사 로그는 정지 1건뿐`).toEqual({ statusAudit: 1, roleAudit: 0 });
      expect(connectionStatus(guardian.id, ward.id), `${round}회차: 역할이 안 바뀌었으니 연결은 그대로`).toBe('ACTIVE');
      expect(notifRows(ward.id, 'CONNECTION_DISCONNECTED'), `${round}회차: 연결이 그대로라 해제 알림은 없다`).toEqual([]);
    } else {
      expect(`${row.role}/${row.status}`, `${round}회차: 역할 변경이 이겼다면 피보호자·이용 중`).toBe('WARD/ACTIVE');
      expect({ statusAudit, roleAudit }, `${round}회차: 감사 로그는 역할 변경 1건뿐`).toEqual({ statusAudit: 0, roleAudit: 1 });
      expect(connectionStatus(guardian.id, ward.id), `${round}회차: 연결은 해제 상태`).toBe('DISCONNECTED');
      const rows = await settle(() => notifRows(ward.id, 'CONNECTION_DISCONNECTED'), r => r.length >= 1, 20_000);
      expect(rows.length, `${round}회차: 연결 상대에게 해제 알림이 1건`).toBe(1);
      const extra = await settle(() => notifRows(ward.id, 'CONNECTION_DISCONNECTED'), r => r.length > 1, 3_000);
      expect(extra.length, `${round}회차: 해제 알림이 중복되지 않는다`).toBe(1);
    }
  }

  // (2) 같은 보호자를 강제 탈퇴 2번을 동시에: 한 번만 성공(200)하고 나머지는 404, 감사 로그 1건, 연결 상대 알림 1건
  for (let round = 1; round <= 3; round++) {
    const guardian = owned.user('GUARDIAN', { phone: null });
    const ward = owned.user('WARD', { phone: null });
    const requested = owned.user('WARD', { phone: null });
    insertConnection(guardian.id, ward.id, 'ACTIVE', '아들');
    insertConnection(guardian.id, requested.id, 'PENDING', '딸');
    const results = await Promise.all([
      bodyOf(await a.api.raw('DELETE', `/api/admin/user/${guardian.id}`)),
      bodyOf(await a.api.raw('DELETE', `/api/admin/user/${guardian.id}`)),
    ]);
    const statuses = results.map(r => r.status).sort();
    seen.push(`강제 탈퇴 ${round}회차: ${statuses.join('/')}`);
    expect(statuses, `${round}회차: 한 번만 성공(200)하고 나머지는 404 이어야 한다(500 금지) - 실제 ${statuses.join('/')}`).toEqual([200, 404]);
    expect(userExists(guardian.id), `${round}회차: 탈퇴한 회원 행이 남지 않는다`).toBe(false);
    expect(auditRows(guardian.id, 'USER_FORCE_DELETE').length, `${round}회차: 강제 탈퇴 감사 로그는 성공한 한 건과 일치`).toBe(1);
    const rows = await settle(() => notifRows(ward.id, 'CONNECTION_DISCONNECTED'), r => r.length >= 1, 20_000);
    expect(rows.length, `${round}회차: 연결됐던 상대에게 해제 알림 1건`).toBe(1);
    const extra = await settle(() => notifRows(ward.id, 'CONNECTION_DISCONNECTED'), r => r.length > 1, 3_000);
    expect(extra.length, `${round}회차: 해제 알림이 중복되지 않는다`).toBe(1);
    expect(
      Number(psql(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(requested.id)};`)),
      `${round}회차: 수락 대기 요청의 상대에게는 알림 없이 취소`,
    ).toBe(0);
    expect(
      Number(psql(`SELECT count(*) FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} OR ward_id = ${sqlStr(guardian.id)};`)),
      `${round}회차: 탈퇴한 회원의 연결 행이 남지 않는다`,
    ).toBe(0);
  }
  // (3) 카메라 정리: 피보호자 쪽 카메라 행이 있을 때 동시 요청 뒤에도 카메라가 남지 않고 감사 로그의 '카메라 삭제'가 한 번뿐
  //     카메라 등록은 CAM_SIGNAL_ALLOWED=1 일 때만 한다(다른 영역은 게이트 필요).
  if (CAM_SIGNAL_ALLOWED) {
    const cameraCount = (id: string) => Number(psql(`SELECT count(*) FROM camera WHERE ward_id = ${sqlStr(id)};`));
    const addCamera = (id: string, label: string) =>
      psql(
        `INSERT INTO camera (ward_id, session_id, device_id, label, registered_by, is_active)
         VALUES (${sqlStr(id)}, ${sqlStr(`qa_a21_${label}_${uniq()}`)}, ${sqlStr(`qa-a21-dev-${label}-${uniq()}`)}, '거실', ${sqlStr(id)}, true);`,
      );
    // 역할 변경(피보호자 -> 보호자) 두 번을 동시에
    const w1 = owned.user('WARD', { phone: null });
    addCamera(w1.id, 'role');
    expect(cameraCount(w1.id), '준비: 카메라 1대').toBe(1);
    const roles = await Promise.all([
      bodyOf(await a.api.raw('PATCH', `/api/admin/user/${w1.id}`, { role: 'GUARDIAN' })),
      bodyOf(await a.api.raw('PATCH', `/api/admin/user/${w1.id}`, { role: 'GUARDIAN' })),
    ]);
    seen.push(`카메라+역할변경 동시: ${roles.map(r => r.status).sort().join('/')}`);
    expect(roles.some(r => r.status >= 500), `역할 변경 동시 요청에 500 이 없다 - ${roles.map(r => r.status).join('/')}`).toBe(false);
    expect(roles.filter(r => r.status === 200).length, '역할 변경이 한 번은 성공').toBeGreaterThanOrEqual(1);
    expect(cameraCount(w1.id), '역할 변경 뒤 카메라가 남지 않는다').toBe(0);
    const cameraAudits = auditRows(w1.id, 'USER_ROLE_CHANGE').filter(r => r.detail.includes('카메라 1대 삭제')).length;
    expect(cameraAudits, "감사 로그의 '카메라 1대 삭제'는 한 번뿐(중복·누락 없음)").toBe(1);
    // 강제 탈퇴 두 번을 동시에
    const w2 = owned.user('WARD', { phone: null });
    addCamera(w2.id, 'del');
    const dels = await Promise.all([
      bodyOf(await a.api.raw('DELETE', `/api/admin/user/${w2.id}`)),
      bodyOf(await a.api.raw('DELETE', `/api/admin/user/${w2.id}`)),
    ]);
    seen.push(`카메라+강제탈퇴 동시: ${dels.map(r => r.status).sort().join('/')}`);
    expect(dels.map(r => r.status).sort(), '카메라가 있어도 한 번만 성공(200), 나머지 404').toEqual([200, 404]);
    expect(cameraCount(w2.id), '강제 탈퇴 뒤 카메라 행이 남지 않는다').toBe(0);
  } else {
    test.info().annotations.push({ type: '확인 안 함', description: '카메라 정리(역할 변경·강제 탈퇴 동시 요청 뒤 카메라 행과 감사 로그 중복)는 카메라 등록이 필요해 CAM_SIGNAL_ALLOWED=1 일 때만 확인한다(이번 실행은 건너뜀)' });
  }
  test.info().annotations.push({ type: '실측', description: seen.join(' | ') });
});

test('ADM-A24 정지 후 상태 저장이 500으로 실패하지 않음', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const target = owned.user('GUARDIAN', { phone: null });

  // 마이그레이션이 끝난 상태: 상태 검사 규칙(users.status)이 "이용 제한(RESTRICTED)"을 허용 목록에 담고 있다
  const constraint = psqlOne(`SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'users'::regclass AND conname = 'chk_users_status';`);
  expect(constraint, '상태 검사 규칙의 허용 목록에 RESTRICTED 가 있다').toContain('RESTRICTED');
  const hasHistory = psqlOne(`SELECT to_regclass('public.flyway_schema_history') IS NOT NULL;`) === 't';
  if (hasHistory) {
    expect(Number(psqlOne(`SELECT count(*) FROM flyway_schema_history WHERE success = false;`)), '실패한 마이그레이션이 없다').toBe(0);
  } else {
    test.info().annotations.push({ type: '확인 범위', description: '마이그레이션 이력 표(flyway_schema_history)가 없어 실패 이력은 보지 않고 상태 검사 규칙만 확인했다' });
  }

  const patch = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] A24' }));
  expect(patch.status, `정지 저장 응답 ${patch.status} (200 이어야 하고 500 이면 안 된다)`).toBe(200);
  const row = userStatusRow(target.id);
  expect(row.status, '저장된 상태').toBe('RESTRICTED');
  expect(row.reason).toBe('[QA-ADMIN] A24');

  const login = await signin(target.email, target.password);
  expect(login.status, `정지 계정 로그인 응답 ${login.status} (거부 403)`).toBe(403);
  expect(login.json.message ?? '', '로그인 거부 때 이용 제한 안내').toContain('제한된 계정');
  expect(login.login, '정지 계정은 토큰을 받지 못한다').toBeNull();
});

test('ADM-N30 회원 목록·탭 건수·검색', TAGS, async ({ owned }) => {
  test.setTimeout(300_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();

  // 탭 건수: 내 임시 사용자 한 명의 역할을 DB 에서 바꾸고 바로 다시 읽어 그 차이만 본다 (서비스 전체 숫자라 다른 영역이 동시에 가입하면
  // 어긋나므로, 어긋나면 되돌렸다가 3번까지 다시 잰다). 역할 칸 말고는 아무것도 안 바꾸므로 전체는 그대로여야 한다.
  const counts = async () => {
    const res = await bodyOf(await a.api.raw('GET', '/api/admin/user/counts'));
    expect(res.status, `탭 건수 응답 상태 ${res.status}`).toBe(200);
    const data = res.json.data as { total: number; guardian: number; ward: number; admin: number };
    expect(data.total, '전체 = 보호자 + 피보호자 + 관리자').toBe(data.guardian + data.ward + data.admin);
    return data;
  };
  const guardian = owned.user('GUARDIAN', { phone: null, name: `QA30보호자${tag}` });
  const ward = owned.user('WARD', { phone: null, name: `QA30피보호자${tag}` });
  owned.user('ADMIN', { phone: null, name: `QA30관리자${tag}` });
  const shift = async (from: 'GUARDIAN' | 'WARD' | 'ADMIN', to: 'GUARDIAN' | 'WARD' | 'ADMIN') => {
    const key = (r: string) => r.toLowerCase() as 'guardian' | 'ward' | 'admin';
    let seen = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = await counts();
      setUserFields(guardian.id, `role = ${sqlStr(to)}`);
      const after = await counts();
      const d = { total: after.total - before.total, guardian: after.guardian - before.guardian, ward: after.ward - before.ward, admin: after.admin - before.admin };
      const expected = { total: 0, guardian: 0, ward: 0, admin: 0, [key(from)]: -1, [key(to)]: 1 };
      seen = `${from} -> ${to}: 전체 ${d.total}, 보호자 ${d.guardian}, 피보호자 ${d.ward}, 관리자 ${d.admin}`;
      if (JSON.stringify(d) === JSON.stringify(expected)) return seen;
      setUserFields(guardian.id, `role = ${sqlStr(from)}`);
    }
    return `어긋남 - ${seen}`;
  };
  const shifts = [await shift('GUARDIAN', 'WARD'), await shift('WARD', 'ADMIN'), await shift('ADMIN', 'GUARDIAN')];
  test.info().annotations.push({ type: '실측', description: shifts.join(' | ') });
  expect(shifts.filter(s => s.startsWith('어긋남')), `탭 건수가 역할 한 명의 이동을 그대로 따라가야 한다: ${shifts.join(' | ')}`).toEqual([]);
  // 목록: 관리자도 보이고(연결 상태는 null), 역할 탭·상태 필터·검색·페이지
  const all = await listUsers(a.api, `keyword=${q(tag)}&size=50`);
  const mineRoles = all.content.map(u => u.role).sort();
  expect(mineRoles.filter(r => r === 'ADMIN').length, '목록에 관리자도 보인다').toBeGreaterThanOrEqual(1);
  const adminRow = all.content.find(u => u.role === 'ADMIN')!;
  expect(adminRow.connectionState, '관리자의 연결 상태는 null').toBeNull();
  const times = all.content.map(u => new Date(u.createdAt).getTime());
  expect(times, '목록은 가입 최신순').toEqual([...times].sort((x, y) => y - x));
  const names = all.content.map(u => u.name);
  expect(names.every(n => n.includes(tag)), '검색어에 맞는 회원만').toBe(true);
  expect(all.totalElements, '이 테스트가 만든 회원 3명').toBe(3);
  const firstTag = `QA30보호자${tag}`;
  expect((await listUsers(a.api, `keyword=${q(firstTag)}&role=GUARDIAN`)).totalElements, '역할 탭 보호자').toBe(1);
  expect((await listUsers(a.api, `keyword=${q(firstTag)}&role=WARD`)).totalElements, '이름이 보호자인 회원은 피보호자 탭에 없다').toBe(0);
  expect((await listUsers(a.api, `keyword=${q(`QA30관리자${tag}`)}&role=ADMIN`)).totalElements, '관리자 탭').toBe(1);

  // 상태 필터
  setUserFields(guardian.id, `status = 'RESTRICTED'`);
  const restricted = await listUsers(a.api, `keyword=${q(tag)}&status=RESTRICTED`);
  expect(restricted.content.map(u => u.userId), '이용 제한 필터').toEqual([guardian.id]);
  const active = await listUsers(a.api, `keyword=${q(tag)}&status=ACTIVE&size=50`);
  expect(active.content.map(u => u.userId), '이용 중 필터에는 정지 회원이 없다').not.toContain(guardian.id);

  // 이메일 검색, 페이지 보정
  expect((await listUsers(a.api, `keyword=${q(ward.email)}`)).content.map(u => u.userId), '이메일로 검색').toEqual([ward.id]);
  const paged = await listUsers(a.api, `keyword=${q(tag)}&size=2`);
  expect([paged.page, paged.size, paged.content.length, paged.totalPages], '크기 2: 첫 페이지').toEqual([0, 2, 2, Math.ceil(paged.totalElements / 2)]);
  const lastPage = await listUsers(a.api, `keyword=${q(tag)}&size=2&page=${paged.totalPages - 1}`);
  expect(lastPage.last, '마지막 페이지').toBe(true);
  for (const [query, page, size] of [['size=0', 0, 20], ['size=1000', 0, 50], ['page=-1', 0, 20]] as const) {
    const p = await listUsers(a.api, `keyword=${q(tag)}&${query}`);
    expect(`${query} -> page ${p.page}, size ${p.size}`).toBe(`${query} -> page ${page}, size ${size}`);
  }

  // 흔한 이름·글자로 검색해도 200 이고 빠르다 (일치 회원 수만 기록하고 내용은 남기지 않는다)
  const seen: string[] = [];
  for (const keyword of ['김', 'a', '이']) {
    const started = Date.now();
    const res = await bodyOf(await a.api.raw('GET', `/api/admin/user?keyword=${q(keyword)}&size=1`));
    const ms = Date.now() - started;
    seen.push(`흔한 글자 검색 ${keyword} -> ${res.status} ${ms}ms 일치 ${res.status === 200 ? (res.json.data as UserPage).totalElements : '-'}명`);
    expect.soft(res.status, `흔한 글자 검색 응답 ${res.status}`).toBe(200);
    expect.soft(ms, `흔한 글자 검색이 ${ms}ms 로 느리다(3초 안이어야 한다)`).toBeLessThan(3_000);
  }
  test.info().annotations.push({ type: '검색 속도', description: seen.join(' | ') });
});

test('ADM-N31 회원 상세와 연결 상태 표시', TAGS, async ({ owned, openAs }) => {
  test.setTimeout(240_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const u1 = owned.user('GUARDIAN', { phone: null, name: `QA31갑${tag}` }); // 연결됨 + 수락 대기
  const u2 = owned.user('GUARDIAN', { phone: null, name: `QA31을${tag}` }); // 수락 대기만
  const u3 = owned.user('GUARDIAN', { phone: null, name: `QA31병${tag}` }); // 둘 다 없음
  const m = owned.user('ADMIN', { phone: null, name: `QA31관리자${tag}` });
  const w1 = owned.user('WARD', { phone: null, name: `QA31가${tag}` });
  const w2 = owned.user('WARD', { phone: null, name: `QA31나${tag}` });
  const w3 = owned.user('WARD', { phone: null, name: `QA31다${tag}` });
  insertConnection(u1.id, w1.id, 'ACTIVE', '아들');
  insertConnection(u1.id, w2.id, 'PENDING', '딸');
  insertConnection(u2.id, w3.id, 'PENDING', '딸');

  type Detail = { connectionState: string | null; connections: { connectionId: number; counterpartId: string; counterpartName: string; relation: string | null; status: string }[] };
  const detail = async (id: string) => {
    const res = await bodyOf(await a.api.raw('GET', `/api/admin/user/${id}`));
    expect(res.status, `회원 상세 응답 ${res.status}`).toBe(200);
    return res.json.data as Detail;
  };

  await test.step('상세: 연결됨 > 수락 대기 > 미연결 순으로 하나만, 연결된 사람은 전부', async () => {
    const d1 = await detail(u1.id);
    expect(d1.connectionState, '연결됨과 대기가 둘 다 있으면 연결됨').toBe('CONNECTED');
    expect(d1.connections.map(c => `${c.counterpartId}:${c.status}:${c.relation}`), '연결된 사람 전체(연결됨이 먼저)').toEqual([`${w1.id}:ACTIVE:아들`, `${w2.id}:PENDING:딸`]);
    expect(d1.connections.map(c => c.counterpartName)).toEqual([w1.name, w2.name]);
    const d2 = await detail(u2.id);
    expect(d2.connectionState, '대기만 있으면 수락 대기').toBe('PENDING');
    expect(d2.connections.map(c => c.counterpartId)).toEqual([w3.id]);
    const d3 = await detail(u3.id);
    expect(d3.connectionState, '둘 다 없으면 미연결').toBe('NONE');
    expect(d3.connections).toEqual([]);
    const dm = await detail(m.id);
    expect(dm.connectionState, '관리자는 미연결이 아니라 빈 값(null)').toBeNull();
    expect(dm.connections).toEqual([]);
    const dw1 = await detail(w1.id);
    expect(dw1.connectionState, '피보호자 쪽에서도 같은 연결이 보인다').toBe('CONNECTED');
    expect(dw1.connections.map(c => c.counterpartId)).toEqual([u1.id]);
  });

  await test.step('연결 상태 필터: 관리자는 미연결 필터에서 빠진다', async () => {
    const ids = async (connection: string) => (await listUsers(a.api, `keyword=${q(tag)}&connection=${connection}&size=50`)).content.map(u => u.userId).sort();
    const sorted = (...x: string[]) => [...x].sort();
    expect(await ids('NONE'), '미연결 필터').toEqual(sorted(u3.id));
    expect(await ids('CONNECTED'), '연결됨 필터').toEqual(sorted(u1.id, w1.id));
    expect(await ids('PENDING'), '수락 대기 필터(연결됨이 있는 보호자는 빠진다)').toEqual(sorted(u2.id, w2.id, w3.id));
    const everyone = await listUsers(a.api, `keyword=${q(tag)}&size=50`);
    expect(everyone.content.map(u => u.userId).sort(), '필터 없음: 관리자도 포함').toEqual(sorted(u1.id, u2.id, u3.id, m.id, w1.id, w2.id, w3.id));
    expect(everyone.content.find(u => u.userId === m.id)!.connectionState).toBeNull();
    const u1Row = everyone.content.find(u => u.userId === u1.id)!;
    expect([u1Row.connectionCount, u1Row.firstConnection?.counterpartName], '목록 행은 연결 건수와 대표 1명(연결됨 먼저)').toEqual([2, w1.name]);
  });

  await test.step('화면: 연결 상태 배지·미연결 필터·상세의 관계 표시', async () => {
    const page = await openAs(a.who, null);
    await page.goto('/admin/members');
    await expect(page.getByRole('heading', { level: 1, name: '회원 관리', exact: true })).toBeVisible();
    await page.getByPlaceholder('이름 · 이메일 · 전화번호 · 연결 회원 검색').fill(tag);
    const row = (name: string) => page.locator('tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) });
    await expect(page.locator('tbody tr')).toHaveCount(7);
    const cell = (name: string, index: number) => row(name).first().getByRole('cell').nth(index);
    await expect(cell(u1.name, 6), '연결됨과 대기가 같이 있으면 연결됨 하나').toHaveText('연결됨');
    await expect(cell(u1.name, 5)).toContainText('연결 회원 2명 보기');
    await expect(cell(u2.name, 6)).toHaveText('수락 대기');
    await expect(cell(u2.name, 5), '연결 회원 한 명은 이름과 관계').toContainText(`${w3.name} (딸)`);
    await expect(cell(u3.name, 6)).toHaveText('미연결');
    await expect(cell(m.name, 6), '관리자의 연결 상태는 빈 값').toHaveText('-');
    await expect(row(m.name).getByRole('button', { name: '관리' }), '관리자 행에는 관리 버튼이 없다').toHaveCount(0);

    await page.getByLabel('연결 상태').selectOption('NONE');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await expect(row(u3.name)).toHaveCount(1);
    await expect(row(m.name), '미연결 필터에서 관리자 계정이 빠진다').toHaveCount(0);
    await page.getByLabel('연결 상태').selectOption('ALL');
    await expect(page.locator('tbody tr')).toHaveCount(7);

    await row(u1.name).first().getByRole('button', { name: '관리' }).click();
    const dialog = page.getByRole('dialog', { name: '회원 수정' });
    await expect(dialog).toBeVisible();
    const items = dialog.locator('section:has(h3) li');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText(w1.name);
    await expect(items.nth(0)).toContainText('피보호자의 아들');
    await expect(items.nth(0)).toContainText('연결됨');
    await expect(items.nth(1)).toContainText(w2.name);
    await expect(items.nth(1)).toContainText('피보호자의 딸');
    await expect(items.nth(1)).toContainText('수락 대기');
    await expect(dialog.getByRole('button', { name: '해제', exact: true }), '연결됨 한 건에만 해제 버튼').toHaveCount(1);
  });

  test.info().annotations.push({
    type: 'FE 확인 필요 - 문서와 차이',
    description: 'FE 관계 표시 문구가 문서와 다름(문서와 화면 중 어느 쪽을 고칠지 팀이 정해야 함). 문서는 관계를 "이 회원은 OO님의 아들" 문장으로 보인다고 적었지만 배포 화면은 연결 목록에 상대 이름과 "피보호자의 아들"을 보인다. 화면 값으로 고정했다.',
  });
});

test('ADM-N32 이름 수정과 감사 로그', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const target = owned.user('GUARDIAN', { name: `QA32전${tag}` });
  const before = userStatusRow(target.id);

  const newName = `QA32후${tag}`;
  const res = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { name: `  ${newName}  ` }));
  expect(res.status, `이름 수정 응답 ${res.status}`).toBe(200);
  expect(res.json.success, '성공 표시').toBe(true);
  const after = userStatusRow(target.id);
  expect(after.name, '이름이 바뀌고 앞뒤 공백은 정리해서 저장').toBe(newName);
  expect([after.email, after.phone, after.role, after.status], '이메일·전화번호·역할·상태는 변하지 않는다').toEqual([before.email, before.phone, before.role, before.status]);

  const audits = auditRows(target.id, 'USER_NAME_CHANGE');
  expect(audits.length, '관리자 활동 기록이 한 건 남는다').toBe(1);
  expect(audits[0].detail, '기록에 바뀐 이름(전·후)이 들어 있다').toContain(target.name);
  expect(audits[0].detail).toContain(newName);
  expect(
    Number(psql(`SELECT count(*) FROM admin_audit_log WHERE target_id = ${sqlStr(target.id)} AND admin_id = ${sqlStr(admin.id)} AND action = 'USER_NAME_CHANGE';`)),
    '기록한 사람은 이 관리자',
  ).toBe(1);
  const detail = (await a.api.get<{ name: string; email: string }>(`/api/admin/user/${target.id}`));
  expect([detail.name, detail.email], '상세 조회에도 반영').toEqual([newName, target.email]);

  // 같은 이름을 다시 보내면 바뀐 게 없어 기록이 늘지 않는다
  const same = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { name: newName }));
  expect(same.status).toBe(200);
  expect(auditRows(target.id, 'USER_NAME_CHANGE').length, '같은 이름은 기록하지 않는다').toBe(1);
});

test('ADM-N35 정지 해제', TAGS, async ({ owned, openAs }) => {
  test.setTimeout(240_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const target = owned.user('GUARDIAN', { phone: null });
  const reason = `[QA-ADMIN] N35 ${tag}`;

  await test.step('정지했다가 푸는 기본 흐름', async () => {
    const restrict = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: reason }));
    expect(restrict.status, `준비: 정지 응답 ${restrict.status}`).toBe(200);
    expect(userStatusRow(target.id).reason, '준비: 사유가 저장됨').toBe(reason);
    const blocked = await signin(target.email, target.password);
    expect(blocked.status, `정지 중 로그인 ${blocked.status}`).toBe(403);

    const release = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'ACTIVE' }));
    expect(release.status, `정지 해제 응답 ${release.status}`).toBe(200);
    const row = userStatusRow(target.id);
    expect(row.status, '해제 뒤 상태').toBe('ACTIVE');
    expect(row.reason, '정지 사유가 지워진다').toBe('');
    const ok = await signin(target.email, target.password);
    expect(ok.status, `해제 뒤 로그인 ${ok.status}`).toBe(200);
    const detail = await a.api.get<{ status: string; statusReason: string | null }>(`/api/admin/user/${target.id}`);
    expect([detail.status, detail.statusReason], '상세에서도 사유가 없다').toEqual(['ACTIVE', null]);

    const audits = auditRows(target.id, 'USER_STATUS_CHANGE');
    expect(audits.length, '정지와 해제 두 건의 감사 로그').toBe(2);
    expect(audits[0].detail, '정지 기록(사유 포함)').toMatch(/이용 중.*이용 제한.*사유.*N35/);
    expect(audits[1].detail, '해제 기록').toMatch(/이용 제한.*이용 중/);
    expect(audits[1].detail, '해제 기록에는 사유가 없다').not.toContain('사유');
  });

  await test.step('해제는 열린 웹소켓과 기존 토큰을 건드리지 않는다', async () => {
    // 로그인한 보호자의 실시간 연결을 연 뒤, 정지 이벤트 없이(DB 로 직접) 정지 상태로 만들고 관리자 API 로 해제한다.
    const t = await owned.login(target);
    const page = await openAs('anonymous', '/login');
    const connected = await openRawStomp(page, 'target', t.login.accessToken, [`/topic/${target.id}/sos-triggered`]);
    expect(connected, '준비: 보호자의 웹소켓 연결').toBe(true);
    setUserFields(target.id, `status = 'RESTRICTED', status_reason = ${sqlStr(reason)}`);
    const release = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'ACTIVE' }));
    expect(release.status, `해제 응답 ${release.status}`).toBe(200);
    // 닫히면 바로 알려 주고, 닫히지 않으면 6초를 채워 본다
    const state = await settle(() => readRawStomp(page, 'target'), s => s.closed, 6_000);
    expect(state.closed, `정지를 풀었는데 열려 있던 웹소켓이 닫혔다 (code ${state.code}, ${state.reason})`).toBe(false);
    const me = await t.api.raw('GET', '/api/user/me');
    expect(me.status(), '해제 뒤에도 기존 토큰이 그대로 통한다').toBe(200);
    expect(userStatusRow(target.id).status).toBe('ACTIVE');
    expect(auditRows(target.id, 'USER_STATUS_CHANGE').length, '해제 감사 로그가 한 건 더 남는다').toBe(3);
    await closeRawStomp(page, 'target');
  });
});
