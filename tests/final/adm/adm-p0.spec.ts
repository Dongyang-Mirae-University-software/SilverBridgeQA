/**
 * 최종 QA - 관리자(ADM) P0 (15건)
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다(끝나면 자동 삭제). 고정 계정·setup 은 쓰지 않는다.
 *  - 알림을 받는 임시 보호자는 전화번호 없음(phone: null)이라 문자가 나갈 수 없고, FCM 토큰도 없어 푸시도 나가지 않는다.
 *  - 카메라 등록·화재 신호는 CAM 영역만 실제로 일으킨다. 이 영역의 ADM-A23 은 SOS·웹소켓 차단 부분만 돌리고 카메라·화재 단계는 넣지 않았다.
 *  - Redis 는 건드리지 않는다(속도 제한 카운터를 지우지 않고, 429 가 나오면 기다렸다 다시 시도한다).
 *  - DB 는 읽기 위주이고, 쓰는 것은 이 테스트가 만든 임시 사용자의 행뿐이다.
 *  - 관리자 조치가 남긴 감사 로그는 지우지 않는다(삭제 헬퍼가 없다 - 보존 스케줄러가 회수).
 *  - 실시간 연결 주소에 토큰이 들어가므로 trace 를 끄고, 다른 회원 정보가 담길 수 있는 화면 영상·사진도 끈다.
 */
import { request } from '@playwright/test';

import { Api } from '../../../src/api';
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { countBackendLog, psql, remoteBash, sqlStr } from '../../../src/remote';
import { connect, fcmTokenCount, sosEventCount } from '../../../src/variables';
import {
  allKeys, allStrings, auditCount, bodyOf, closeRawStomp, forbiddenInResponse, isForbiddenKey, notificationRows, openRawStomp, psqlOne,
  readRawStomp, redact, Safety, settle, signinWaiting, sleep, TAGS, userExists, userStatusRow,
} from './_helpers-adm';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const suffix = () => Date.now().toString(36).slice(-4);

/** 지금부터 offsetMs 뒤의 KST 복용 시각 (HH:MM:00, 분 단위 올림 없이 내림) */
function doseTimeAfter(offsetMs: number) {
  const t = new Date(Date.now() + offsetMs + 9 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 안전 대시보드
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-N13 보호자 없음·연락 가능한 보호자 없음 사각지대 집계', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const a = await loginAs(admin);
  // 공용 대시보드 전체 숫자라 다른 영역이 동시에 회원을 만들면 흔들린다.
  // 그래서 두 상태를 바로 이어서 재서 "차이"만 비교하고, 어긋나면 처음부터 다시 잰다(3번까지).
  const readSafety = async () => {
    const res = await bodyOf(await a.api.raw('GET', '/api/admin/dashboard/safety'));
    expect(res.status, `안전 현황 응답 상태 ${res.status}`).toBe(200);
    return res;
  };

  const tag = suffix();
  const wardA = await tempUser('WARD', { name: `QA사각A${tag}` }); // 연결을 만들었다 지우며 비교
  const guardianA = await tempUser('GUARDIAN', { phone: null });
  const wardB = await tempUser('WARD', { name: `QA사각B${tag}` }); // 보호자를 정지·해제하며 비교
  const guardianB = await tempUser('GUARDIAN', { phone: null });
  connect(guardianA.id, wardA.id);
  connect(guardianB.id, wardB.id);

  let last = '';
  let passed = false;
  for (let attempt = 1; attempt <= 3 && !passed; attempt++) {
    // (가) 보호자 B 정지 전후: 연결은 남아 있으므로 reachable 만 +1
    const bActive = await readSafety();
    const restrict = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardianB.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] N13' }));
    expect(restrict.status, `준비: 보호자 정지 응답 ${restrict.status}`).toBe(200);
    const bRestricted = await readSafety();
    const release = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardianB.id}`, { status: 'ACTIVE' }));
    expect(release.status, `준비: 보호자 정지 해제 응답 ${release.status}`).toBe(200);

    // (나) 피보호자 A 연결 있음 -> 연결 지움: 두 값이 모두 +1
    const aLinked = await readSafety();
    psql(`DELETE FROM connection WHERE guardian_id = ${sqlStr(guardianA.id)} AND ward_id = ${sqlStr(wardA.id)};`);
    const aUnlinked = await readSafety();
    connect(guardianA.id, wardA.id); // 다음 시도를 위해 되돌림

    // 개수만 내리고 누구인지·정지 사유는 응답에 없다
    for (const res of [bRestricted, aUnlinked]) {
      for (const id of [wardA.id, wardB.id, guardianA.id, guardianB.id]) {
        expect(res.text, '응답에 회원 ID 가 섞여 있다').not.toContain(id);
      }
      expect(allKeys(res.json.data), '응답에 정지 사유·회원 목록 칸이 있다').not.toContain('statusReason');
      for (const [key, value] of Object.entries((res.json.data as Safety).safetyEvents)) {
        expect(['number', 'object'], `safetyEvents.${key} 는 개수(또는 null)여야 한다`).toContain(typeof value);
      }
    }

    const ev = (res: { json: { data?: unknown } }) => (res.json.data as Safety).safetyEvents;
    const bReachable = ev(bRestricted).wardsWithoutReachableGuardian - ev(bActive).wardsWithoutReachableGuardian;
    const bGuardian = ev(bRestricted).wardsWithoutGuardian - ev(bActive).wardsWithoutGuardian;
    const aGuardian = ev(aUnlinked).wardsWithoutGuardian - ev(aLinked).wardsWithoutGuardian;
    const aReachable = ev(aUnlinked).wardsWithoutReachableGuardian - ev(aLinked).wardsWithoutReachableGuardian;
    last = `시도 ${attempt}: 정지 시 reachable +${bReachable}(기대 +1)·guardian +${bGuardian}(기대 +0), 연결 지움 시 guardian +${aGuardian}(기대 +1)·reachable +${aReachable}(기대 +1)`;
    passed = bReachable === 1 && bGuardian === 0 && aGuardian === 1 && aReachable === 1;
  }
  test.info().annotations.push({ type: '실측', description: last });
  expect(passed, `사각지대 집계가 기대와 다르다 - 보호자 없음(A)은 두 값에, 보호자 전원 정지(B)는 reachable 에만 세야 한다. ${last}`).toBe(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// 이상감지 로그·디바이스: 영상·클립 주소 없음
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-N28 관리자 응답에 영상·클립 주소가 없음', TAGS, async ({ tempUser, loginAs }) => {
  const admin = await tempUser('ADMIN');
  const a = await loginAs(admin);

  const paths = [
    '/api/admin/anomaly',
    '/api/admin/anomaly?size=50',
    '/api/admin/anomaly/summary',
    '/api/admin/anomaly/summary?period=ALL',
    '/api/admin/camera',
    '/api/admin/camera?size=50',
    '/api/admin/camera/summary',
  ];
  const seen: string[] = [];
  let incidentId = 1;
  for (const path of paths) {
    const res = await bodyOf(await a.api.raw('GET', path));
    seen.push(`${path} -> ${res.status}`);
    // 실패 메시지에는 상태 코드만 넣는다 (카메라 응답에는 다른 회원의 이름·주소가 있다)
    expect.soft(res.status, `${path} 응답 상태 ${res.status}`).toBe(200);
    expect.soft(forbiddenInResponse(res.json.data), `${path}: 영상·정지 화면·클립 주소나 클립 ID 가 응답에 있다`).toEqual([]);
    const first = res.json.data?.content?.[0];
    if (path === '/api/admin/anomaly' && first?.incidentId) incidentId = first.incidentId;
  }
  test.info().annotations.push({ type: '실측', description: seen.join(' | ') });

  // 관리자 계정으로 클립 목록·재생 API 를 불러도 보호자(또는 피보호자) 전용이라 거부
  for (const path of [
    `/api/guardian/anomaly/${incidentId}/clips`,
    '/api/guardian/anomaly/clips/1/file',
    `/api/ward/anomaly/${incidentId}/clips`,
    '/api/ward/anomaly/clips/1/file',
  ]) {
    const res = await bodyOf(await a.api.raw('GET', path));
    expect.soft(res.status, `관리자가 ${path} 를 불러도 거부(403)되어야 하는데 ${res.status}`).toBe(403);
  }

  // 응답 모양(OpenAPI 문서)에도 그런 칸이 없다
  const ctx = await request.newContext({ baseURL: env.apiUrl });
  try {
    const docsRes = await ctx.get('/v3/api-docs');
    // 문서가 꺼져 있거나(404) 막혀 있으면(401/403) 모양 검사는 할 수 없다. 그 밖의 실패(서버 오류 등)는 실패로 본다.
    if (docsRes.status() === 401 || docsRes.status() === 403 || docsRes.status() === 404) {
      test.info().annotations.push({ type: 'OpenAPI', description: `문서 응답 ${docsRes.status()} - 문서가 열려 있지 않아 모양 검사는 하지 않음` });
    } else {
      expect(docsRes.status(), 'OpenAPI 문서 응답이 정상(200)이어야 한다').toBe(200);
      const schemas = ((await docsRes.json()) as { components?: { schemas?: Record<string, { properties?: Record<string, unknown> }> } }).components?.schemas ?? {};
      const names = Object.keys(schemas).filter(name => /^Admin(Anomaly|Camera)/.test(name));
      expect(names.length, '준비: 문서에 관리자 이상감지·카메라 응답 모양이 있어야 한다').toBeGreaterThan(0);
      for (const name of names) {
        const bad = Object.keys(schemas[name].properties ?? {}).filter(isForbiddenKey);
        expect.soft(bad, `${name} 응답 모양에 영상·클립 관련 칸이 있다`).toEqual([]);
      }
    }
  } finally {
    await ctx.dispose();
  }
});

test('ADM-N45 디바이스 응답에 영상·deviceId·상세 주소가 없음', TAGS, async ({ tempUser, loginAs, openAs }) => {
  const admin = await tempUser('ADMIN');
  const { api, who } = await loginAs(admin);

  // API: 필드 전체 검사
  for (const path of ['/api/admin/camera', '/api/admin/camera?size=50', '/api/admin/camera/summary']) {
    const res = await bodyOf(await api.raw('GET', path));
    // 실패 메시지에는 상태 코드만 넣는다 (다른 회원의 이름·주소가 보고서에 남지 않게)
    expect.soft(res.status, `${path}: 응답 상태 ${res.status}`).toBe(200);
    expect.soft(forbiddenInResponse(res.json.data), `${path}: 영상·deviceId·상세 주소가 응답에 있다`).toEqual([]);
    expect.soft([...allKeys(res.json.data)], `${path}: deviceId 칸이 있다`).not.toContain('deviceId');
  }

  // 화면: 보기 전용 (삭제·점검 요청 버튼 없음)
  const page = await openAs(who, null);
  const listResponse = page.waitForResponse(r => /\/api\/admin\/camera(\?|$)/.test(r.url()), { timeout: 60_000 }).catch(() => null);
  await page.goto('/admin/devices');
  await expect(page.getByRole('heading', { level: 1, name: '디바이스 관리', exact: true })).toBeVisible();
  const response = await listResponse;
  if (response) {
    const body = (await response.json().catch(() => ({}))) as { data?: unknown };
    expect.soft(forbiddenInResponse(body.data), '화면이 받은 목록 응답에 금지 칸이 있다').toEqual([]);
  }
  await expect(page.locator('table thead th')).toHaveText(['어르신', '방', '주소', '등록일', '사용 여부', '상태']);
  await expect(page.locator('tbody tr').first()).toBeVisible();

  const buttonNames = (await page.getByRole('button').allInnerTexts()).map(text => text.trim());
  test.info().annotations.push({ type: '화면 버튼', description: buttonNames.join(' | ') });
  expect(buttonNames.filter(name => /삭제|점검|제거|재시작|재등록/.test(name)), '카메라 삭제·[점검 요청] 같은 조작 버튼이 있다 (보기 전용이어야 한다)').toEqual([]);
  await expect(page.getByRole('button', { name: /삭제|점검/ })).toHaveCount(0);
  // 표 안에는 조작 버튼이 없다 (행 단위 button/a 없음)
  await expect.soft(page.locator('tbody button, tbody a'), '표의 행에 조작 버튼·링크가 있다').toHaveCount(0);
  // 화면 어디에도 영상·이미지가 없다
  await expect.soft(page.locator('video, img[src*="clip"], img[src*="snapshot"]'), '화면에 영상·정지 화면이 있다').toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 회원 관리: 이용 제한(정지)
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-N33 보호자 이용 제한(정지): 로그인·세션·실시간 연결 차단', TAGS, async ({ tempUser, loginAs, openAs }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const target = await tempUser('GUARDIAN', { phone: null });
  const a = await loginAs(admin);
  // 로그인 응답의 refresh 토큰(본문 또는 Set-Cookie)을 나중에 쓰려고, 이 로그인은 직접 부른다
  const first = await signinWaiting(target.email, target.password);
  expect(first.login, `준비: 보호자 로그인 (상태 ${first.status})`).not.toBeNull();
  const t = { api: await Api.fromLogin({ ...first.login!, refreshToken: first.login!.refreshToken ?? '' }), login: first.login! };

  // 앱 화면 대신 FE 오리진 페이지에서 STOMP 연결만 직접 연다 (앱이 401 에 스스로 연결을 닫아 검증이 흐려지지 않게)
  const page = await openAs('anonymous', '/login');
  const connected = await openRawStomp(page, 'target', t.login.accessToken, [`/topic/${target.id}/sos-triggered`]);
  expect(connected, '준비: 로그인 중인 보호자의 WebSocket(STOMP) 연결이 성립해야 한다').toBe(true);
  const meBefore = await t.api.raw('GET', '/api/user/me');
  expect(meBefore.status(), '준비: 정지 전에는 내 정보 조회가 된다').toBe(200);

  const reason = `[QA-ADMIN] N33 정지 사유 ${suffix()}`;
  const patch = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: reason }));
  expect(patch.status, `정지 응답: ${patch.text}`).toBe(200);

  await test.step('열린 웹소켓이 1008 AUTH_INVALIDATED 로 닫힌다', async () => {
    const state = await settle(() => readRawStomp(page, 'target'), s => s.closed, 15_000);
    test.info().annotations.push({ type: '웹소켓 닫힘', description: `closed=${state.closed}, code=${state.code}, reason=${state.reason}` });
    expect.soft(state.closed, '정지했는데 열려 있던 웹소켓이 15초 안에 닫히지 않았다').toBe(true);
    expect.soft(state.code, '닫기 코드는 1008(POLICY_VIOLATION)').toBe(1008);
    expect.soft(state.reason, '닫기 사유는 AUTH_INVALIDATED').toBe('AUTH_INVALIDATED');
  });

  await test.step('기존 토큰은 즉시 무효 (닫힌 시점에 이미 401 - 토큰 무효화 후 닫기 순서)', async () => {
    const me = await t.api.raw('GET', '/api/user/me');
    expect(me.status(), '정지 뒤 옛 access 토큰이 아직 통한다').toBe(401);
  });

  await test.step('로그인 거부 (403, 고객센터 안내)', async () => {
    const res = await signinWaiting(target.email, target.password);
    expect(res.status, `정지 계정 로그인 응답 상태 ${res.status}`).toBe(403);
    expect(res.json.message ?? '', '정지 안내 문구').toContain('제한된 계정');
  });

  await test.step('refresh 로 되살아나지 않는다', async () => {
    // 본문에 refresh 토큰이 없으면(쿠키 전용) 로그인 때 받은 refresh 쿠키를 Cookie 헤더로, FE 오리진을 Origin 으로 보낸다
    const bodyToken = first.login!.refreshToken;
    const cookie = first.refreshCookie;
    expect(bodyToken || cookie, '준비: 로그인 때 refresh 토큰을 본문이나 쿠키로 받아야 한다').toBeTruthy();
    let res = { status: 0, code: '' };
    for (let i = 1; i <= 12; i++) {
      const ctx = await request.newContext({
        baseURL: env.apiUrl,
        extraHTTPHeaders: { Origin: new URL(env.baseUrl).origin, ...(cookie ? { Cookie: cookie } : {}) },
      });
      try {
        const r = await bodyOf(await ctx.post('/api/auth/refresh', { data: bodyToken ? { refreshToken: bodyToken } : {} }));
        res = { status: r.status, code: r.json.code ?? '' };
      } finally {
        await ctx.dispose();
      }
      if (res.status !== 429) break; // 속도 제한이면 Redis 를 건드리지 않고 기다렸다 다시
      await sleep(6_000);
    }
    test.info().annotations.push({ type: 'refresh', description: `${bodyToken ? '본문' : '쿠키'} 방식, 응답 ${res.status} ${res.code}` });
    expect(res.status, `정지된 계정이 refresh 로 새 토큰을 받았거나 다른 오류가 났다 (상태 ${res.status}, code ${res.code})`).toBe(401);
    expect(res.code, '에러 code 가 있어야 한다').not.toBe('');
  });

  await test.step('사유가 회원 정보에 저장된다', async () => {
    const row = userStatusRow(target.id);
    expect(row.status).toBe('RESTRICTED');
    expect(row.reason, 'DB 정지 사유').toBe(reason);
    const detail = await a.api.get<{ status: string; statusReason: string }>(`/api/admin/user/${target.id}`);
    expect(detail.status).toBe('RESTRICTED');
    expect(detail.statusReason, '관리자 상세의 정지 사유').toBe(reason);
  });

  await test.step('ADMIN-G03 흡수: 역할을 바꾼 직후 다시 로그인해도 새 토큰이 바로 통한다', async () => {
    const other = await tempUser('WARD', { phone: null });
    const change = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${other.id}`, { role: 'GUARDIAN' }));
    expect(change.status, `역할 변경 응답: ${change.text}`).toBe(200);
    const relogin = await signinWaiting(other.email, other.password);
    expect(relogin.login, `역할 변경 직후 재로그인 상태 ${relogin.status}`).not.toBeNull();
    const api = await Api.fromLogin({ ...relogin.login!, refreshToken: relogin.login!.refreshToken ?? '' });
    try {
      const me = await api.raw('GET', '/api/user/me');
      expect(me.status(), '역할 변경 직후 재로그인한 새 토큰이 401 이다 (iat 와 무효화 시각 정밀도)').toBe(200);
    } finally {
      await api.dispose();
    }
  });

  await closeRawStomp(page, 'target');
  await t.api.dispose();
});

test('ADM-N34 정지 계정에는 SOS·화재 포함 알림이 하나도 안 감 (SOS 단계)', TAGS, async ({ tempUser, loginAs, openAs }) => {
  // 화재 단계는 카메라 신호라 이 영역에서 돌리지 않는다 - ADM-A23 에 같은 검사(정지 보호자 무수신)를 담았다.
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD');
  const restricted = await tempUser('GUARDIAN', { phone: null });
  const normal = await tempUser('GUARDIAN', { phone: null }); // 대조군: 정상 보호자는 알림을 시도받는다
  connect(restricted.id, ward.id);
  connect(normal.id, ward.id);
  const a = await loginAs(admin);
  const w = await loginAs(ward);
  const n = await loginAs(normal);

  // 대조군(정상 보호자)의 실시간 연결을 FE 오리진 페이지에서 직접 연다
  const page = await openAs('anonymous', '/login');
  expect(await openRawStomp(page, 'normal', n.login.accessToken, [`/topic/${normal.id}/sos-triggered`]), '준비: 정상 보호자의 실시간 연결').toBe(true);

  const patch = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${restricted.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] N34' }));
  expect(patch.status, `준비: 보호자 정지 ${patch.text}`).toBe(200);

  const sos = await bodyOf(await w.api.raw('POST', '/api/ward/sos', {}));
  expect(sos.status, `SOS 전송 응답: ${sos.text.slice(0, 120)}`).toBe(201);

  const normalRows = await settle(() => notificationRows(normal.id, 'WARD_SOS'), rows => rows.length >= 1, 30_000);
  expect(normalRows.length, '정상 보호자에게는 SOS 알림 발송 시도(이력)가 남아야 한다').toBe(1);
  expect(normalRows[0].reason, '정상 보호자의 알림이 이용 제한 사유로 막혔다').not.toBe('RESTRICTED_ACCOUNT');
  const normalEvents = await settle(() => readRawStomp(page, 'normal'), s => s.destinations.length >= 1, 15_000);
  expect(normalEvents.destinations, '정상 보호자의 실시간 연결로 sos-triggered 이벤트가 와야 한다').toContain(`/topic/${normal.id}/sos-triggered`);
  await closeRawStomp(page, 'normal');

  const restrictedRows = await settle(() => notificationRows(restricted.id, 'WARD_SOS'), rows => rows.length >= 1, 15_000);
  test.info().annotations.push({ type: '실측', description: `정상 ${normalRows.map(r => r.result).join(',')} / 정지 ${restrictedRows.map(r => `${r.result}:${r.reason}`).join(',')}` });
  expect(restrictedRows.length, '정지 보호자 앞 알림 이력은 "보내지 않음" 1건으로 남아야 한다').toBe(1);
  expect(restrictedRows[0].result, '정지 계정은 실패가 아니라 NOT_SENT 로 남아야 한다').toBe('NOT_SENT');
  expect(restrictedRows[0].reason, '보내지 않은 사유').toBe('RESTRICTED_ACCOUNT');
  // 대시보드 "오늘 실패 알림" 은 공용 숫자라 비교하지 않고, 그 숫자의 원천인 이 보호자 앞 FAILED 이력이 0건인지 본다
  const failedForRestricted = Number(psql(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(restricted.id)} AND result = 'FAILED';`));
  expect(failedForRestricted, '정지 보호자 앞 알림이 "실패"로 세어졌다').toBe(0);

  // 푸시·문자·웹 알림 모두 막혔는지는 서버 로그의 차단 표시로 본다
  const blocked = await settle(
    () => countBackendLog(`[NOTIFY-BLOCKED] 이용 제한 계정이라 발송하지 않음: userId=${restricted.id}`, 300),
    n => n >= 1, 15_000,
  );
  expect.soft(blocked, '정지 보호자에 대한 [NOTIFY-BLOCKED] 로그가 없다 (푸시·문자 차단 표시)').toBeGreaterThanOrEqual(1);
  const wsBlocked = countBackendLog(`[WS-BLOCKED] 이용 중이 아닌 계정 - 실시간 이벤트 미발송: userId=${restricted.id}`, 300);
  expect.soft(wsBlocked, '정지 보호자에 대한 [WS-BLOCKED] 로그가 없다 (웹 알림 차단 표시)').toBeGreaterThanOrEqual(1);
  const normalBlocked = countBackendLog(`[NOTIFY-BLOCKED] 이용 제한 계정이라 발송하지 않음: userId=${normal.id}`, 300);
  expect.soft(normalBlocked, '정상 보호자가 차단 대상으로 잡혔다').toBe(0);
});

test('ADM-N38 강제 탈퇴: 일반 탈퇴와 같은 길, 상대에게 해제 알림', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { name: `QA탈퇴${suffix()}`, phone: null });
  const ward = await tempUser('WARD', { phone: null });
  connect(guardian.id, ward.id);
  const a = await loginAs(admin);
  const g = await loginAs(guardian);

  const fakeToken = `e2e-fake-fcm-${guardian.id}-${Date.now().toString(36)}`;
  await g.api.post('/api/notifications/fcm-token', { token: fakeToken, platform: 'WEB' });
  expect(fcmTokenCount({ userId: guardian.id }), '준비: 푸시 주소가 등록돼야 한다').toBe(1);
  const refreshBefore = Number(psql(`SELECT count(*) FROM refresh_token WHERE user_id = ${sqlStr(guardian.id)};`));
  expect(refreshBefore, '준비: 로그인으로 refresh 토큰 행이 있어야 한다').toBeGreaterThan(0);

  const res = await bodyOf(await a.api.raw('DELETE', `/api/admin/user/${guardian.id}`));
  expect(res.status, `강제 탈퇴 응답: ${res.text}`).toBe(200);

  await test.step('계정 삭제, 로그인 정보·푸시 주소·접속 기록 정리', async () => {
    const gone = await settle(() => !userExists(guardian.id), v => v, 20_000);
    expect(gone, '강제 탈퇴 뒤에도 회원 행이 남아 있다').toBe(true);
    expect(fcmTokenCount({ userId: guardian.id }), '푸시 주소가 남아 있다').toBe(0);
    expect(Number(psql(`SELECT count(*) FROM refresh_token WHERE user_id = ${sqlStr(guardian.id)};`)), 'refresh 토큰이 남아 있다').toBe(0);
    expect(Number(psql(`SELECT count(*) FROM access_log WHERE user_id = ${sqlStr(guardian.id)};`)), '접속 기록이 탈퇴자 ID 에 그대로 남아 있다(익명화되어야 함)').toBe(0);
    expect(Number(psql(`SELECT count(*) FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} OR ward_id = ${sqlStr(guardian.id)};`)), '연결이 남아 있다').toBe(0);
  });

  await test.step('연결 상대에게 해제 알림', async () => {
    const rows = await settle(() => notificationRows(ward.id, 'CONNECTION_DISCONNECTED'), r => r.length >= 1, 20_000);
    test.info().annotations.push({ type: '실측', description: `상대(피보호자) 해제 알림 이력 ${rows.length}건 ${rows.map(r => r.body).join(' / ')}` });
    expect(rows.length, '연결 상대(피보호자)에게 해제 알림 이력이 정확히 1건 있어야 한다').toBe(1);
    // 피보호자 문구는 단문이고 2026-11-16(CONN-N06)부터 해제한 쪽이 붙는다("관리자가 가족 연결을 해제했어요." 등) - 해제 안내인지만 본다
    expect(rows[0].body, '연결 해제를 알리는 문구').toMatch(/연결(이|을) 해제/);
  });

  await test.step('누가 지웠는지 감사 기록이 남음', async () => {
    expect(auditCount({ adminId: admin.id, targetId: guardian.id, action: 'USER_FORCE_DELETE' }), '강제 탈퇴 감사 로그 1건').toBe(1);
    const detail = psqlOne(`SELECT detail FROM admin_audit_log WHERE action = 'USER_FORCE_DELETE' AND target_id = ${sqlStr(guardian.id)};`);
    expect(detail, '감사 로그에 탈퇴 대상(이름)이 있어야 한다').toContain(guardian.name);
    // 기록이 삭제보다 먼저 남는지(ADMIN-G18)는 삭제 시각을 알 수 없어 확인하지 않는다 - 보류
    test.info().annotations.push({ type: '확인 안 함', description: '감사 기록이 삭제보다 먼저 남는 순서(ADMIN-G18)는 보류. 기록 존재와 내용만 확인' });
  });

  await test.step('삭제 후 같은 토큰 사용 불가', async () => {
    const me = await bodyOf(await g.api.raw('GET', '/api/user/me'));
    test.info().annotations.push({ type: '옛 토큰', description: `상태 ${me.status}, code ${me.json.code ?? ''}` });
    expect(me.status, `삭제된 계정의 옛 토큰이 ${me.status} 를 받았다 (배포본은 무효화된 토큰을 401 로 막는다)`).toBe(401);
    expect(me.json.code ?? '', '에러 code 가 있어야 한다').not.toBe('');
    const again = await bodyOf(await a.api.raw('DELETE', `/api/admin/user/${guardian.id}`));
    expect(again.status, '이미 지운 회원을 다시 지우면 404').toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 강제 연결
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-N39 관리자가 보호자-피보호자 강제 연결', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(180_000);
  const tag = suffix();
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { name: `QA보호자${tag}`, phone: null });
  const ward = await tempUser('WARD', { name: `QA피보호자${tag}`, phone: null });
  const a = await loginAs(admin);

  const res = await bodyOf(await a.api.raw('POST', '/api/admin/connection', { guardianId: guardian.id, wardId: ward.id }));
  expect(res.status, `강제 연결 응답: ${res.text}`).toBe(200);

  await test.step('연결 성립, 관계 값은 비어 있음', async () => {
    const [status, relation, initiatedBy] = psql(
      `SELECT status, coalesce(relation, '<NULL>'), initiated_by FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`,
    ).split('|');
    expect(status, '연결 상태').toBe('ACTIVE');
    expect(relation, '관계(relation)는 비어 있어야 한다').toBe('<NULL>');
    expect(initiatedBy, '누가 연결했는지(관리자)').toBe(admin.id);
  });

  await test.step('보호자·피보호자 알림 문구(수락 문구 아님)', async () => {
    const guardianRows = await settle(() => notificationRows(guardian.id, 'CONNECTION_FORCED'), r => r.length >= 1, 20_000);
    const wardRows = await settle(() => notificationRows(ward.id, 'CONNECTION_FORCED'), r => r.length >= 1, 20_000);
    test.info().annotations.push({ type: '실측 문구', description: `보호자: ${guardianRows.map(r => r.body).join(' / ')} | 피보호자: ${wardRows.map(r => r.body).join(' / ')}` });
    expect(guardianRows.length, '보호자 알림 이력 1건').toBe(1);
    expect(guardianRows[0].body, '보호자 문구').toBe(`관리자가 ${ward.name}님과의 연결을 완료했습니다.`);
    expect(wardRows.length, '피보호자 알림 이력 1건').toBe(1);
    // 배포본(2026-10-27 단문 정책) 문구. 문서의 옛 문구("관리자가 OOO님을 보호자로 연결했습니다")와 다르다 - 수락 문구가 아니면 된다
    expect(wardRows[0].body, '피보호자 문구는 "수락" 문구가 아니어야 한다').not.toContain('수락');
    expect(wardRows[0].body, '피보호자 문구(배포본)').toBe('가족과 연결됐어요. 앱에서 확인해 주세요.');
    expect(notificationRows(guardian.id, 'CONNECTION_ACCEPTED').length, '보호자에게 일반 수락 알림이 섞여 나갔다').toBe(0);
  });

  await test.step('누가·언제·누구를 연결했는지 기록', async () => {
    const connectionId = psqlOne(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`);
    expect(auditCount({ adminId: admin.id, targetId: connectionId, action: 'FORCE_CONNECT' }), '강제 연결 감사 로그 1건').toBe(1);
    const row = psql(`SELECT detail, created_at IS NOT NULL FROM admin_audit_log WHERE action = 'FORCE_CONNECT' AND target_id = ${sqlStr(connectionId)};`).split('|');
    expect(row[0], '감사 로그에 보호자 ID').toContain(guardian.id);
    expect(row[0], '감사 로그에 피보호자 ID').toContain(ward.id);
    expect(row[1], '감사 로그에 시각').toBe('t');
  });

  await test.step('같은 쌍을 다시 연결하면 409', async () => {
    const again = await bodyOf(await a.api.raw('POST', '/api/admin/connection', { guardianId: guardian.id, wardId: ward.id }));
    expect(again.status, `중복 강제 연결 응답: ${again.text.slice(0, 120)}`).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 공통 권한
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A02 일반 회원(WARD/GUARDIAN)이 관리자 API 호출', TAGS, async ({ tempUser, loginAs, openAs }) => {
  test.setTimeout(240_000);
  const guardian = await loginAs(await tempUser('GUARDIAN', { phone: null }));
  const ward = await loginAs(await tempUser('WARD', { phone: null }));

  // 없는 ID 로 부른다 - 권한 거부가 먼저라 상태가 바뀌지 않고, 뚫려도 404/400 이라 알 수 있다
  const none = '999999999';
  const calls: { method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string; data?: unknown }[] = [
    { method: 'GET', path: '/api/admin/user' },
    { method: 'GET', path: '/api/admin/user/counts' },
    { method: 'GET', path: '/api/admin/user/ZZZZZZ' },
    { method: 'PATCH', path: '/api/admin/user/ZZZZZZ', data: { name: 'x' } },
    { method: 'DELETE', path: '/api/admin/user/ZZZZZZ' },
    { method: 'POST', path: '/api/admin/connection', data: {} },
    { method: 'DELETE', path: `/api/admin/connection/${none}` },
    { method: 'GET', path: '/api/admin/dashboard/safety' },
    { method: 'GET', path: '/api/admin/dashboard/operation' },
    { method: 'GET', path: '/api/admin/dashboard/ai-status' },
    { method: 'GET', path: '/api/admin/camera' },
    { method: 'GET', path: '/api/admin/camera/summary' },
    { method: 'GET', path: '/api/admin/anomaly' },
    { method: 'GET', path: '/api/admin/anomaly/summary' },
    { method: 'GET', path: '/api/admin/notification' },
    { method: 'GET', path: '/api/admin/notification/summary' },
    { method: 'GET', path: '/api/admin/inquiry' },
    { method: 'GET', path: `/api/admin/inquiry/${none}` },
    { method: 'POST', path: `/api/admin/inquiry/${none}/answer`, data: { answer: 'x' } },
    { method: 'GET', path: '/api/admin/announcement/select' },
    { method: 'GET', path: '/api/admin/announcement/summary' },
    { method: 'GET', path: `/api/admin/announcement/select/detail/${none}` },
    { method: 'POST', path: '/api/admin/announcement/create', data: {} },
    { method: 'PUT', path: `/api/admin/announcement/update/${none}`, data: {} },
    { method: 'DELETE', path: `/api/admin/announcement/delete/${none}` },
    { method: 'GET', path: '/api/admin/announcement/draft/select' },
    { method: 'GET', path: `/api/admin/announcement/draft/select/detail/${none}` },
    { method: 'POST', path: '/api/admin/announcement/draft/create', data: {} },
    { method: 'PUT', path: `/api/admin/announcement/draft/update/${none}`, data: {} },
    { method: 'DELETE', path: `/api/admin/announcement/draft/delete/${none}` },
    { method: 'POST', path: `/api/admin/announcement/draft/publish/${none}` },
    { method: 'GET', path: '/api/admin/hospital' },
    { method: 'GET', path: '/api/admin/hospital/summary' },
    { method: 'POST', path: '/api/admin/hospital', data: {} },
    { method: 'PUT', path: `/api/admin/hospital/${none}`, data: {} },
    { method: 'DELETE', path: `/api/admin/hospital/${none}` },
    { method: 'PUT', path: `/api/admin/hospital/${none}/status`, data: {} },
    { method: 'POST', path: `/api/admin/hospital/${none}/department`, data: {} },
    { method: 'PUT', path: `/api/admin/hospital/${none}/department/1`, data: {} },
    { method: 'DELETE', path: `/api/admin/hospital/${none}/department/1` },
    { method: 'GET', path: '/api/admin/ai-stats/chat?from=2026-11-01&to=2026-11-02' },
    { method: 'GET', path: '/api/admin/ai-stats/companion' },
  ];

  const wrong: string[] = [];
  for (const [label, who] of [['보호자', guardian], ['피보호자', ward]] as const) {
    for (const call of calls) {
      const r = await bodyOf(await who.api.raw(call.method, call.path, call.data));
      if (r.status !== 403) wrong.push(`${label} ${call.method} ${call.path} -> ${r.status}`);
      else if (r.json.data !== undefined && r.json.data !== null) wrong.push(`${label} ${call.method} ${call.path} -> 403 이지만 data 노출`);
    }
  }
  test.info().annotations.push({ type: '실측', description: `${calls.length * 2}회 호출, 403 아님/노출 ${wrong.length}건 ${wrong.slice(0, 5).join(' | ')}` });
  expect(wrong, '관리자 API 를 일반 회원이 불렀는데 403 이 아니거나 데이터가 보인다').toEqual([]);

  // 화면 주소로 직접 들어가도 자기 홈으로 돌려보낸다 (관리자 화면은 보이지 않는다)
  const guardianPage = await openAs(guardian.who, '/admin');
  await expect(guardianPage, '보호자가 /admin 에 들어가면 보호자 홈으로 가야 한다').toHaveURL(/\/guardian$/);
  await expect(guardianPage.getByRole('heading', { name: /운영 현황|안전 현황/ })).toHaveCount(0);
  const wardPage = await openAs(ward.who, '/admin/members');
  await expect(wardPage, '피보호자가 /admin/members 에 들어가면 피보호자 홈으로 가야 한다').toHaveURL(/\/ward$/);
  await expect(wardPage.getByRole('heading', { level: 1, name: '회원 관리' })).toHaveCount(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 회원 관리: 거부되어야 하는 변경
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A14 피보호자는 이용 제한할 수 없음', TAGS, async ({ tempUser, loginAs }) => {
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const a = await loginAs(admin);
  const w = await loginAs(ward);

  const res = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${ward.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] A14' }));
  test.info().annotations.push({ type: '실측', description: `피보호자 정지 -> ${res.status} ${res.json.message ?? ''}` });
  expect(res.status, `피보호자 정지는 400 이어야 한다: ${res.text.slice(0, 160)}`).toBe(400);
  expect(res.json.message ?? '', '안내 문구').toContain('피보호자 계정은 이용 제한할 수 없습니다');

  const row = userStatusRow(ward.id);
  expect(row.status, '피보호자 상태가 바뀌었다').toBe('ACTIVE');
  expect(row.reason, '정지 사유가 저장됐다').toBe('');

  // 피보호자는 계속 로그인·SOS 가 된다
  const me = await w.api.raw('GET', '/api/user/me');
  expect(me.status(), '피보호자 토큰이 끊겼다').toBe(200);
  const login = await signinWaiting(ward.email, ward.password);
  expect(login.status, `피보호자 로그인 상태 ${login.status}`).toBe(200);
  const sos = await bodyOf(await w.api.raw('POST', '/api/ward/sos', {}));
  expect(sos.status, `피보호자 SOS 응답: ${sos.text.slice(0, 120)}`).toBe(201);
  expect(sosEventCount(ward.id), 'SOS 이력').toBe(1);
});

test('ADM-A15 정지된 보호자를 피보호자로 바꾸기, 관리자 역할로 바꾸기', TAGS, async ({ tempUser, loginAs }) => {
  const admin = await tempUser('ADMIN');
  const restricted = await tempUser('GUARDIAN', { status: 'RESTRICTED', phone: null });
  const anyone = await tempUser('GUARDIAN', { phone: null });
  const a = await loginAs(admin);

  const toWard = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${restricted.id}`, { role: 'WARD' }));
  test.info().annotations.push({ type: '실측', description: `정지 보호자 -> WARD: ${toWard.status} ${toWard.json.message ?? ''}` });
  expect.soft(toWard.status, `정지 보호자를 피보호자로 바꾸면 400 이어야 한다: ${toWard.text.slice(0, 160)}`).toBe(400);
  expect.soft(toWard.json.message ?? '', '안내 문구').toContain('피보호자 계정은 이용 제한할 수 없습니다');

  const toAdmin = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${anyone.id}`, { role: 'ADMIN' }));
  test.info().annotations.push({ type: '실측', description: `보호자 -> ADMIN: ${toAdmin.status} ${toAdmin.json.message ?? ''}` });
  expect.soft(toAdmin.status, `관리자 역할로 바꾸면 400 이어야 한다: ${toAdmin.text.slice(0, 160)}`).toBe(400);
  expect.soft(toAdmin.json.message ?? '', '안내 문구').toContain('피보호자 또는 보호자만');

  const r1 = userStatusRow(restricted.id);
  expect(r1.role, '정지 보호자의 역할이 바뀌었다').toBe('GUARDIAN');
  expect(r1.status, '정지 보호자의 상태가 바뀌었다').toBe('RESTRICTED');
  const r2 = userStatusRow(anyone.id);
  expect(r2.role, '일반 보호자가 관리자가 됐다').toBe('GUARDIAN');
  expect(r2.status).toBe('ACTIVE');
});

test('ADM-A16 관리자 계정은 수정·정지·삭제 불가', TAGS, async ({ tempUser, loginAs }) => {
  const admin = await tempUser('ADMIN', { name: `QA관리자${suffix()}` });
  const other = await tempUser('ADMIN', { name: `QA관리자B${suffix()}` });
  const a = await loginAs(admin);

  const attempts: { label: string; id: string; method: 'PATCH' | 'DELETE'; data?: unknown }[] = [
    { label: '다른 관리자 이름 수정', id: other.id, method: 'PATCH', data: { name: 'QA변경' } },
    { label: '다른 관리자 정지', id: other.id, method: 'PATCH', data: { status: 'RESTRICTED', statusReason: '[QA-ADMIN] A16' } },
    { label: '다른 관리자 삭제', id: other.id, method: 'DELETE' },
    { label: '자기 자신 이름 수정', id: admin.id, method: 'PATCH', data: { name: 'QA변경' } },
    { label: '자기 자신 정지', id: admin.id, method: 'PATCH', data: { status: 'RESTRICTED' } },
    { label: '자기 자신 삭제', id: admin.id, method: 'DELETE' },
  ];
  const seen: string[] = [];
  for (const attempt of attempts) {
    const res = await bodyOf(await a.api.raw(attempt.method, `/api/admin/user/${attempt.id}`, attempt.data));
    seen.push(`${attempt.label} -> ${res.status}`);
    expect.soft(res.status, `${attempt.label}: 거부(403)되어야 하는데 ${res.status} ${res.text.slice(0, 120)}`).toBe(403);
    expect.soft(res.json.message ?? '', `${attempt.label}: 안내 문구`).toContain('관리자 계정은 변경하거나 삭제할 수 없습니다');
  }
  test.info().annotations.push({ type: '실측', description: seen.join(' | ') });

  for (const [who, id] of [[admin, admin.id], [other, other.id]] as const) {
    const row = userStatusRow(id);
    expect(row.status, `${id}: 상태가 그대로여야 한다`).toBe('ACTIVE');
    expect(row.name, `${id}: 이름이 그대로여야 한다`).toBe(who.name);
    expect(userExists(id), `${id}: 계정이 그대로 있어야 한다`).toBe(true);
  }
  expect(auditCount({ adminId: admin.id }), '거부된 시도에 감사 로그(조치 기록)가 남았다').toBe(0);
  expect(auditCount({ targetId: other.id }) + auditCount({ targetId: admin.id }), '거부된 시도의 대상에 감사 로그가 남았다').toBe(0);

  // 목록에는 보인다
  const list = await a.api.get<{ content: { userId: string }[] }>(`/api/admin/user?role=ADMIN&keyword=${encodeURIComponent(other.email)}`);
  expect(list.content.map(u => u.userId), '관리자 계정이 목록에서 보여야 한다').toContain(other.id);
});

test('ADM-A17 이메일·전화번호 수정 시도', TAGS, async ({ tempUser, loginAs }) => {
  const admin = await tempUser('ADMIN');
  const target = await tempUser('GUARDIAN', { name: `QA이름${suffix()}` });
  const a = await loginAs(admin);
  const before = userStatusRow(target.id);

  const newName = `QA새이름${suffix()}`;
  // 임시 번호 대역과 겹치지 않게 이 실행에서만 쓰는 번호를 만든다 (실제 번호가 아니다)
  const hijackPhone = `0100009${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
  const res = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, {
    name: newName,
    email: `e2e.hijack.${suffix()}@silverbridge.test`,
    phone: hijackPhone,
  }));
  test.info().annotations.push({ type: '실측', description: `이메일·전화번호를 넣은 PATCH -> ${res.status} ${res.json.message ?? ''}` });
  // 배포 BE 는 요청 모양에 없는 email·phone 칸을 무시하고 이름만 바꾼 뒤 200 을 준다
  expect(res.status, `이메일·전화번호는 무시되고 200 이어야 한다: ${res.status} ${res.text.slice(0, 120)}`).toBe(200);

  const after = userStatusRow(target.id);
  expect(after.email, '이메일이 바뀌었다').toBe(before.email);
  expect(after.phone, '전화번호가 바뀌었다 (인증 없는 번호 변경 경로)').toBe(before.phone);
  expect(after.name, '이름만 바뀌어야 한다').toBe(newName);
  // 이 대상 계정 행에 관리자가 넣은 번호가 들어갔는지만 본다 (다른 임시 사용자와 겹쳐도 거짓 실패가 없게)
  const holder = psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(target.id)} AND phone = ${sqlStr(hijackPhone)};`);
  expect(holder, '관리자가 넣은 번호가 대상 계정에 들어갔다').toBe('0');
});

// ─────────────────────────────────────────────────────────────────────────────
// 정지와 SOS·실시간
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A22 유일한 보호자를 정지하면 SOS가 아무에게도 안 감', TAGS, async ({ tempUser, loginAs }) => {
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const a = await loginAs(admin);
  const safety = () => a.api.get<Safety>('/api/admin/dashboard/safety');

  const ward = await tempUser('WARD', { name: `QA유일${suffix()}` });
  const only = await tempUser('GUARDIAN', { phone: null });
  connect(only.id, ward.id);
  const patch = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${only.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] A22' }));
  expect(patch.status, `준비: 유일한 보호자 정지 ${patch.text}`).toBe(200);
  const w = await loginAs(ward);

  const sos = await bodyOf(await w.api.raw('POST', '/api/ward/sos', {}));
  expect(sos.status, `SOS 전송 응답: ${sos.text.slice(0, 120)}`).toBe(201);

  // SOS 이력에는 남는다
  expect(sosEventCount(ward.id), 'SOS 이력(sos_event)').toBe(1);

  // 알림은 안 간다: 이력은 "보내지 않음" 으로 남고 차단 로그가 찍힌다
  const rows = await settle(() => notificationRows(only.id, 'WARD_SOS'), r => r.length >= 1, 30_000);
  test.info().annotations.push({ type: '실측', description: `유일한 보호자 앞 알림 이력 ${rows.map(r => `${r.result}:${r.reason}`).join(',')}` });
  expect(rows.length, '정지된 유일한 보호자 앞 알림 이력 1건').toBe(1);
  expect(rows[0].result, '실패가 아니라 NOT_SENT').toBe('NOT_SENT');
  const blocked = await settle(
    () => countBackendLog(`[NOTIFY-BLOCKED] 이용 제한 계정이라 발송하지 않음: userId=${only.id}`, 300),
    n => n >= 1, 15_000,
  );
  expect.soft(blocked, '[NOTIFY-BLOCKED] 로그가 없다').toBeGreaterThanOrEqual(1);

  // 대시보드 사각지대에는 잡혀야 한다 (보호자는 연결돼 있으나 전원 정지).
  // 공유 dev 의 다른 임시 사용자가 전체 숫자를 흔들 수 있어, "정지 상태 vs 정지를 푼 상태"를 바로 이어서 비교하고 어긋나면 다시 잰다.
  let last = '';
  let passed = false;
  for (let attempt = 1; attempt <= 3 && !passed; attempt++) {
    const restrictedState = await safety();
    const unrestrict = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${only.id}`, { status: 'ACTIVE' }));
    expect(unrestrict.status, `비교용 정지 해제 ${unrestrict.text}`).toBe(200);
    const activeState = await safety();
    const back = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${only.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] A22' }));
    expect(back.status, `다시 정지 ${back.text}`).toBe(200);
    const dReachable = restrictedState.safetyEvents.wardsWithoutReachableGuardian - activeState.safetyEvents.wardsWithoutReachableGuardian;
    const dGuardian = restrictedState.safetyEvents.wardsWithoutGuardian - activeState.safetyEvents.wardsWithoutGuardian;
    last = `시도 ${attempt}: 정지 상태가 해제 상태보다 wardsWithoutReachableGuardian +${dReachable}(기대 +1), wardsWithoutGuardian +${dGuardian}(기대 +0)`;
    passed = dReachable === 1 && dGuardian === 0;
  }
  test.info().annotations.push({ type: '대시보드', description: last });
  expect(passed, `연결은 남아 있고 보호자 전원이 정지면 wardsWithoutReachableGuardian 에만 잡혀야 한다. ${last}`).toBe(true);
});

test('ADM-A23 정지 후에도 열린 실시간 연결로 알림이 계속 전달되는지 (SOS 단계)', TAGS, async ({ tempUser, loginAs, openAs }) => {
  // 카메라 등록과 화재 사진 송출(공용 AI 서버)은 CAM 영역 전용이라 이 영역에서는 일으키지 않는다.
  // 화재 이벤트가 정지 보호자의 열린 연결로 새는지는 CAM 영역에서 본다. 여기서는 SOS 이벤트와 웹소켓 닫힘만 본다.
  test.setTimeout(240_000);
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const active = await tempUser('GUARDIAN', { phone: null }); // 대조군
  const target = await tempUser('GUARDIAN', { phone: null }); // 정지할 보호자
  connect(active.id, ward.id);
  connect(target.id, ward.id);
  const a = await loginAs(admin);
  const w = await loginAs(ward);
  const act = await loginAs(active);
  const t = await loginAs(target);

  // 두 보호자 모두 실시간 연결을 직접 붙여 둔다 (FE 오리진 페이지에서)
  const rawPage = await openAs('anonymous', '/login');
  expect(await openRawStomp(rawPage, 'active', act.login.accessToken, [`/topic/${active.id}/sos-triggered`]), '준비: 정상 보호자의 실시간 연결').toBe(true);
  expect(await openRawStomp(rawPage, 'target', t.login.accessToken, [`/topic/${target.id}/sos-triggered`]), '준비: 정지할 보호자의 실시간 연결').toBe(true);

  const patch = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: '[QA-ADMIN] A23' }));
  expect(patch.status, `준비: 정지 ${patch.text}`).toBe(200);

  const closed = await settle(() => readRawStomp(rawPage, 'target'), s => s.closed, 15_000);
  expect.soft(closed.closed, '정지했는데 열려 있던 웹소켓이 닫히지 않았다').toBe(true);
  expect.soft(closed.code, '닫기 코드 1008').toBe(1008);
  expect.soft(closed.reason, '닫기 사유 AUTH_INVALIDATED').toBe('AUTH_INVALIDATED');

  // SOS: 대조군은 받고, 정지된 보호자는 받지 않는다
  const sos = await bodyOf(await w.api.raw('POST', '/api/ward/sos', {}));
  expect(sos.status, `SOS 응답 ${sos.text.slice(0, 120)}`).toBe(201);
  await settle(() => notificationRows(active.id, 'WARD_SOS'), r => r.length >= 1, 30_000);
  const activeState = await settle(() => readRawStomp(rawPage, 'active'), s => s.destinations.length >= 1, 15_000);
  expect(activeState.destinations, '준비: 정상 보호자의 실시간 연결로는 sos-triggered 가 와야 한다').toContain(`/topic/${active.id}/sos-triggered`);
  await sleep(3_000); // 정지 보호자 쪽으로 늦게 새는 이벤트가 없는지 조금 더 본다

  const state = await readRawStomp(rawPage, 'target');
  test.info().annotations.push({ type: '정지된 보호자가 받은 이벤트', description: `${state.destinations.length}건` });
  expect(state.destinations, '정지된 보호자의 열린 실시간 연결로 SOS 이벤트가 새어 나갔다').toEqual([]);
  expect(notificationRows(target.id, 'WARD_SOS').every(r => r.result === 'NOT_SENT'), '정지 보호자 앞 SOS 알림이 발송됐다').toBe(true);
  const wsBlocked = await settle(
    () => countBackendLog(`[WS-BLOCKED] 이용 중이 아닌 계정 - 실시간 이벤트 미발송: userId=${target.id}`, 300),
    n => n >= 1, 10_000,
  );
  expect.soft(wsBlocked, '정지 보호자에 대한 [WS-BLOCKED] 로그가 없다 (웹 알림 차단 표시)').toBeGreaterThanOrEqual(1);
  test.info().annotations.push({ type: '실행 안 함', description: '카메라 등록·화재 신호 단계는 CAM 영역 전용이라 이 테스트에 넣지 않음' });

  await closeRawStomp(rawPage, 'active');
  await closeRawStomp(rawPage, 'target');
});

// ─────────────────────────────────────────────────────────────────────────────
// AI 통계
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A40 통계 응답·로그에 상담 내용·사용자 ID 없음', TAGS, async ({ tempUser, loginAs }) => {
  // 목 AI 서버로 상담 문장·userId 를 섞어 내려보내는 부분은 BE 의 AI 주소를 바꿔야 해서 서버 설정을 건드린다 - 하지 않는다.
  // 대신 배포본이 실제 AI 응답을 "허용 목록" 칸으로만 옮기는지(응답 칸·값 모양)와 [ADMIN-AI-STATS] 로그 칸을 본다.
  const admin = await tempUser('ADMIN');
  const a = await loginAs(admin);
  const range = 'from=2026-11-10&to=2026-11-12';

  const first = await bodyOf(await a.api.raw('GET', `/api/admin/ai-stats/chat?${range}`));
  const second = await bodyOf(await a.api.raw('GET', `/api/admin/ai-stats/chat?${range}`));
  test.info().annotations.push({ type: '실측', description: `1차 ${first.status}, 2차(캐시) ${second.status}` });

  const ALLOWED_KEYS = new Set([
    'from', 'to', 'totalChats', 'users', 'byRole', 'guardian', 'ward', 'unknown', 'byRoute', 'reservation', 'symptom', 'general',
    'emergencyGuidance', 'reservationCompleted', 'fallbackReplies', 'routerFailures', 'routerFailuresByKind', 'credit', 'auth',
    'timeout', 'other', 'routerStatus', 'state', 'recentFailures', 'windowSec', 'daily', 'date', 'generatedAt',
  ]);
  const DATE_OR_TIME = /^\d{4}-\d{2}-\d{2}([T ][\d:.+\-]+)?$/;

  for (const res of [first, second]) {
    if (res.status === 200) {
      const keys = [...allKeys(res.json.data)];
      expect(keys.filter(k => !ALLOWED_KEYS.has(k)), '응답에 허용 목록 밖의 칸이 있다 (상담 내용·사용자 ID 칸 가능성)').toEqual([]);
      expect(keys.filter(k => /user.?id|ward.?id|content|message|question|answer|text/i.test(k)), '응답에 사용자 ID·상담 내용 칸이 있다').toEqual([]);
      const strings = allStrings(res.json.data).filter(s => !DATE_OR_TIME.test(s) && !['ok', 'failing', 'credit_exhausted', 'off'].includes(s));
      expect(strings, '응답에 개수·날짜 말고 문장(상담 내용 후보)이 있다').toEqual([]);
      expect(res.text, '응답에 회원 ID 모양(e2e 임시 ID)이 있다').not.toContain(admin.id);
    } else {
      // AI 가 안 닿는 경우: 개수·날짜만 말하는 고정 오류(503/504) - 본문에 AI 원문이 없어야 한다
      expect([503, 504], `AI 통계가 200 도 503/504 도 아니다: ${res.status} ${res.text.slice(0, 120)}`).toContain(res.status);
      expect(res.text, 'AI 오류 응답에 원문 조각이 있다').not.toMatch(/userId|상담|detail|stack/i);
    }
  }

  // [ADMIN-AI-STATS] 로그: adminId·기간·캐시 여부·소요 ms·실패 코드만
  const raw = remoteBash(
    `docker logs --since 300s ${env.apiContainer} 2>&1 | grep -F '[ADMIN-AI-STATS]' | grep -F 'adminId=${admin.id}' | tail -10\n`,
  );
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.slice(l.indexOf('[ADMIN-AI-STATS]')));
  test.info().annotations.push({ type: '로그 줄 수', description: String(lines.length) });
  expect(lines.length, '이 관리자의 [ADMIN-AI-STATS] 로그가 남아야 한다').toBeGreaterThanOrEqual(2);
  const FORMAT = /^\[ADMIN-AI-STATS\] 챗 집계 (조회|실패): adminId=\w+, from=\d{4}-\d{2}-\d{2}, to=\d{4}-\d{2}-\d{2}, (cached=(true|false)(, elapsedMs=\d+)?|code=[A-Z_]+)$/;
  for (const line of lines) {
    expect.soft(line, `로그 줄이 허용된 칸(adminId·기간·캐시·소요 ms·실패 코드)만 담아야 한다: ${redact(line).slice(0, 160)}`).toMatch(FORMAT);
  }
  if (first.status === 200) {
    expect.soft(lines.some(l => l.includes('cached=true')), '같은 기간 두 번째 조회는 캐시(cached=true)로 기록돼야 한다').toBe(true);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 역할 변경 후 알림
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-X01 역할을 바꾼 뒤 옛 역할의 알림이 더는 오지 않는다', TAGS, async ({ tempUser, loginAs }) => {
  // 화재 단계(카메라 신호)는 CAM 영역 전용이라 돌리지 않는다. 말벗 질문 시각(매일 9·12·15·18·21시 고정)은 기다리지 않고,
  // 역할 변경 뒤 말벗 기록이 정리됐는지를 DB 로 본다. 복약 알림은 복용 시각을 곧(1~2분 뒤)으로 잡아 실제 스케줄러가 한 바퀴 돈 뒤에 확인한다.
  test.setTimeout(480_000);
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const guardianA = await tempUser('GUARDIAN', { phone: null }); // 피보호자로 바꿀 보호자
  const guardianKeep = await tempUser('GUARDIAN', { phone: null }); // 남은 보호자
  connect(guardianA.id, ward.id);
  connect(guardianKeep.id, ward.id);
  const a = await loginAs(admin);
  const w = await loginAs(ward);

  await test.step('(1) 보호자 A를 피보호자로 바꾼 뒤 A에게는 SOS 알림이 안 가고, 남은 보호자에게는 간다', async () => {
    const change = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${guardianA.id}`, { role: 'WARD' }));
    expect(change.status, `역할 변경 응답: ${change.text}`).toBe(200);
    expect(userStatusRow(guardianA.id).role).toBe('WARD');
    expect(
      Number(psql(`SELECT count(*) FROM connection WHERE status = 'ACTIVE' AND (guardian_id = ${sqlStr(guardianA.id)} OR ward_id = ${sqlStr(guardianA.id)});`)),
      '역할이 바뀐 A 의 연결이 정리되어야 한다',
    ).toBe(0);

    const sos = await bodyOf(await w.api.raw('POST', '/api/ward/sos', {}));
    expect(sos.status, `SOS 응답 ${sos.text.slice(0, 120)}`).toBe(201);
    const keepRows = await settle(() => notificationRows(guardianKeep.id, 'WARD_SOS'), r => r.length >= 1, 30_000);
    expect(keepRows.length, '남은 보호자에게는 SOS 알림 시도가 남아야 한다').toBe(1);
    expect(notificationRows(guardianA.id, 'WARD_SOS'), '옛 보호자(A)에게 SOS 알림 이력이 생겼다').toEqual([]);
  });

  await test.step('(2) 피보호자 B를 보호자로 바꾼 뒤 약·연결·말벗 기록이 정리되고 복약 알림이 가지 않는다', async () => {
    const wardB = await tempUser('WARD', { phone: null });
    const keeper = await tempUser('GUARDIAN', { phone: null });
    const wardC = await tempUser('WARD', { phone: null }); // 대조군: 역할을 바꾸지 않는 피보호자
    const keeperC = await tempUser('GUARDIAN', { phone: null });
    connect(keeper.id, wardB.id);
    connect(keeperC.id, wardC.id);
    const k = await loginAs(keeper);
    const kc = await loginAs(keeperC);

    // 복용 시각: 1~2분 뒤(분 단위로 내림한 시각). 스케줄러(1분 주기)가 알림을 낼 만한 시각이다.
    const doseAt = Math.floor((Date.now() + 120_000) / 60_000) * 60_000;
    const doseTime = doseTimeAfter(doseAt - Date.now());
    const register = async (api: typeof k.api, wardId: string, name: string) => {
      const med = await bodyOf(await api.raw('POST', `/api/guardian/ward/${wardId}/medication`, { name, timeSlot: 'MORNING', doseTime }));
      expect(med.status, `준비: 약 등록 상태 ${med.status}`).toBe(200);
    };
    await register(k.api, wardB.id, '[QA-ADMIN] X01 약');
    await register(kc.api, wardC.id, '[QA-ADMIN] X01 대조 약');
    expect(Number(psql(`SELECT count(*) FROM medication WHERE ward_id = ${sqlStr(wardB.id)} AND deleted_at IS NULL;`)), '준비: 살아 있는 약 1건').toBe(1);

    // 말벗 기록: B 앞으로 질문 발송 기록 1건을 임시로 만들어 두고, 역할 변경 뒤 정리되는지 본다 (이 임시 사용자 행만)
    psql(`INSERT INTO companion_prompt_log (ward_id, prompt_date, slot, sent_at) VALUES (${sqlStr(wardB.id)}, current_date, 'QA', now());`);
    expect(Number(psql(`SELECT count(*) FROM companion_prompt_log WHERE ward_id = ${sqlStr(wardB.id)};`)), '준비: 말벗 기록 1건').toBe(1);

    const change = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${wardB.id}`, { role: 'GUARDIAN' }));
    expect(change.status, `역할 변경 응답: ${change.text}`).toBe(200);
    expect(userStatusRow(wardB.id).role).toBe('GUARDIAN');

    expect(Number(psql(`SELECT count(*) FROM medication WHERE ward_id = ${sqlStr(wardB.id)} AND deleted_at IS NULL;`)), 'B 의 약이 중지되지 않았다 - 복약 알림 대상으로 남는다').toBe(0);
    expect(
      Number(psql(`SELECT count(*) FROM connection WHERE status IN ('ACTIVE', 'PENDING') AND (guardian_id = ${sqlStr(wardB.id)} OR ward_id = ${sqlStr(wardB.id)});`)),
      'B 의 옛 연결이 남았다',
    ).toBe(0);
    const audit = psqlOne(`SELECT detail FROM admin_audit_log WHERE action = 'USER_ROLE_CHANGE' AND target_id = ${sqlStr(wardB.id)};`);
    expect(audit, '감사 로그에 약 중지가 기록돼야 한다').toContain('복약 1건 중지');

    // 말벗 기록은 바로 지워졌거나, 지워 달라는 요청(purge)이 남아야 한다
    const companion = await settle(
      () => ({
        prompts: Number(psql(`SELECT count(*) FROM companion_prompt_log WHERE ward_id = ${sqlStr(wardB.id)};`)),
        purge: Number(psql(`SELECT count(*) FROM companion_purge_request WHERE ward_id = ${sqlStr(wardB.id)};`)),
      }),
      c => c.prompts === 0 || c.purge > 0,
      20_000,
    );
    test.info().annotations.push({ type: '말벗 기록', description: `질문 기록 ${companion.prompts}건, 삭제 요청 ${companion.purge}건` });
    expect(companion.prompts === 0 || companion.purge > 0, 'B 의 말벗 기록이 정리되지도, 삭제 요청이 남지도 않았다').toBe(true);

    // 복용 시각이 지나고 스케줄러가 한 바퀴 더 돌 때까지 기다린다. 대조 약에는 알림이 나가야(= 스케줄러가 실제로 돈다), B 에게는 나가면 안 된다.
    const reminderRows = (wardId: string) =>
      Number(psql(`SELECT count(*) FROM medication_reminder_log r JOIN medication m ON m.id = r.medication_id WHERE m.ward_id = ${sqlStr(wardId)};`));
    await sleep(Math.max(0, doseAt - Date.now()));
    const control = await settle(() => reminderRows(wardC.id), n => n >= 1, 100_000, 3_000);
    test.info().annotations.push({ type: '복약 알림', description: `대조 약 알림 기록 ${control}건, 복용 시각 ${doseTime} (KST)` });
    expect(control, '준비: 역할을 바꾸지 않은 대조 약에는 복약 알림 기록이 남아야 한다(스케줄러가 돌았다는 증거)').toBeGreaterThanOrEqual(1);
    await sleep(20_000);
    expect(reminderRows(wardB.id), '보호자로 바뀐 B 의 약에 복약 알림 기록이 생겼다').toBe(0);
    expect(notificationRows(wardB.id, 'MEDICATION_REMINDER'), '보호자로 바뀐 B 에게 복약 알림 이력이 생겼다').toEqual([]);
    test.info().annotations.push({ type: '확인 안 함', description: 'B 의 카메라·클립 정리는 카메라를 만들지 않으므로 확인하지 않음(CAM 영역 소관)' });
  });
});
