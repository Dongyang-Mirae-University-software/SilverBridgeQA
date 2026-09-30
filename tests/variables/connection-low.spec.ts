/**
 * 변수 QA - 연결 (low)
 *
 * 부작용:
 *  - 임시 사용자(보호자·피보호자·임시 ADMIN)만 쓴다. 임시 사용자에게는 FCM 토큰이 없어 실제 푸시·SMS 는 나가지 않는다.
 *  - CONN-G10/G12 는 임시 ADMIN 으로 임시 사용자에게만 역할 변경·강제 해제를 호출한다 (감사 로그 행이 남는다).
 *  - CONN-G09 는 임시 보호자를 실제로 탈퇴시킨다 (임시 계정이라 무해). 그 보호자의 이상 알림 설정 행을 만들어 25초간 잠가 purge 를 잠시 늦춘다 (행은 CASCADE 로 함께 지워진다).
 *  - CONN-G11 은 임시 보호자/피보호자 쌍의 PENDING 행을 커밋 전 트랜잭션으로 8초간 붙잡았다가 ROLLBACK 한다 (남는 행 없음).
 *  - CONN-G15 는 DB 트랜잭션을 잠시 붙잡아 경합을 재현한다 (임시 피보호자 행 하나만 건드린다).
 *  - SMS·이메일·알림톡 발송 API 는 부르지 않는다.
 */
import { spawn } from 'node:child_process';

import { Page } from '@playwright/test';

import { Api, LoginResult } from '../../src/api';
import { contextDefaults, installPageStubs, pageStubArg } from '../../src/browser';
import { env } from '../../src/env';
import { expect, test, waitForRealtime } from '../../src/fixtures';
import { psql, sqlStr } from '../../src/remote';
import { deleteTempUser, TempUser } from '../../src/seed';
import { tokenCookies } from '../../src/session';
import { connect } from '../../src/variables';

type TempUserFactory = (role: TempUser['role'], options?: { name?: string }) => Promise<TempUser>;
type LoginFn = (user: TempUser) => Promise<{ api: Api; login: LoginResult }>;

/** 화면의 실시간/푸시 토스트 영역 전체 텍스트 */
async function liveText(page: Page) {
  return (await page.locator('[aria-live="polite"]').allInnerTexts()).join(' | ');
}

/** 관리자 API 클라이언트 (임시 ADMIN 계정) */
async function adminApi(tempUser: TempUserFactory, loginAs: LoginFn) {
  const admin = await tempUser('ADMIN');
  return (await loginAs(admin)).api;
}

/** 조건이 참이 될 때까지 기다린다 (참이 안 되면 마지막 값을 돌려준다) */
async function settle<T>(read: () => Promise<T> | T, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 500));
    value = await read();
  }
  return value;
}

/** 두 사용자 사이 연결 id (없으면 빈 문자열) */
function connectionId(guardianId: string, wardId: string) {
  return psql(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} ORDER BY id DESC LIMIT 1;`);
}

/** 피보호자가 받은 최근 알림 이력 본문 (수신자 기준) */
function lastNotificationBody(recipientId: string, type: string) {
  return psql(
    `SELECT body FROM notification_log WHERE recipient_id = ${sqlStr(recipientId)} AND type = ${sqlStr(type)} ORDER BY id DESC LIMIT 1;`,
  );
}

/** 보호자가 등록 탭에서 회원 ID 입력칸 */
function idInput(page: Page) {
  return page.getByLabel('회원 ID');
}

test.describe('연결 요청 입력 (보호자)', () => {
  test('[CONN-G05] 회원 ID 입력칸은 실제 ID 형식(영숫자 6자)을 안내하고 6자까지만 받는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const page = await openAs(who, '/guardian/wards?tab=register');

    const input = idInput(page);
    await expect(input).toBeVisible();

    const placeholder = (await input.getAttribute('placeholder')) ?? '';
    const maxLength = await input.getAttribute('maxlength');
    test.info().annotations.push({ type: '입력칸', description: `placeholder="${placeholder}" maxlength=${maxLength}` });

    // 안내 문구가 실제 ID 형식(영숫자 6자)이어야 한다. 예시 부분만 떼어 본다
    const example = placeholder.replace(/^예\)\s*/, '');
    expect.soft(example, `placeholder 예시 "${example}" 는 실제 ID 형식(영숫자 6자)이 아니다. 안내대로 입력하면 항상 400 "사용자 ID는 6자리입니다."`).toMatch(/^[A-Za-z0-9]{6}$/);

    // 안내 문구대로 실제로 타이핑해 본다 (한도가 있으면 6자에서 멈춘다)
    await input.click();
    await input.pressSequentially('WD-2026-0188');
    const typed = await input.inputValue();
    expect.soft(typed.length, `BE 는 정확히 6자만 받는데 입력칸은 "${typed}"(${typed.length}자)까지 허용한다 (maxLength=${maxLength})`).toBeLessThanOrEqual(6);
  });

  test('[CONN-G06] ID 를 대소문자만 틀리게 입력해도 다른 피보호자에게 확인 없이 요청이 나가지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const intended = await tempUser('WARD', { name: 'E2E의도피보호자' });
    const other = await tempUser('WARD', { name: 'E2E엉뚱피보호자' });
    const guardian = await tempUser('GUARDIAN');

    // intended 는 소문자 ID(e2xxxx). 다른 피보호자의 ID 를 그 대문자형(E2XXXX)으로 바꿔, 대소문자만 다른 두 ID 를 만든다
    const upperId = intended.id.toUpperCase();
    expect(upperId, '준비: 대문자형 ID 는 원래 ID 와 달라야 한다').not.toBe(intended.id);
    psql(`UPDATE users SET id = ${sqlStr(upperId)} WHERE id = ${sqlStr(other.id)};`);

    try {
      const { who } = await loginAs(guardian);
      const page = await openAs(who, '/guardian/wards?tab=register');

      // 보호자는 "e2xxxx"(intended)를 구두로 들었지만 대문자로 잘못 입력했다
      await idInput(page).fill(upperId);
      await page.getByLabel('관계').selectOption('딸');
      await page.getByRole('button', { name: '연결 요청', exact: true }).click();

      // 요청이 서버에 도착하고 화면 메시지가 뜰 시간을 준다
      await page.waitForTimeout(4_000);
      const message = await page.locator('form').getByText(/연결 요청|피보호자|찾을 수 없/).last().innerText().catch(() => '');
      const pending = Number(psql(`SELECT count(*) FROM connection WHERE ward_id = ${sqlStr(upperId)} AND guardian_id = ${sqlStr(guardian.id)};`));
      test.info().annotations.push({ type: '화면 메시지', description: message });

      expect(
        pending,
        `대소문자만 다른 ID(${upperId})를 입력하자 대상 확인·정규화 없이 그 ID 의 다른 피보호자(${other.name})에게 곧바로 연결 요청이 생성됐다 (화면: "${message}")`,
      ).toBe(0);
    } finally {
      deleteTempUser(upperId);
    }
  });

  test('[CONN-G14] 눈에 보이지 않는 문자(zero-width, 전각공백)만으로 된 관계는 400 으로 거부된다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api } = await loginAs(guardian);

    const cases: [string, string][] = [
      ['​', 'zero-width space(U+200B)'],
      ['　', '전각공백(U+3000)'],
    ];
    const results: string[] = [];
    for (const [relation, label] of cases) {
      const ward = await tempUser('WARD');
      const res = await api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation });
      const status = res.status();
      results.push(`${label}=${status}`);
      test.info().annotations.push({ type: label, description: `${status} ${(await res.text()).slice(0, 120)}` });
      expect.soft(status, `${label} 만으로 된 관계가 서버 검증을 통과했다 (필수값 정책 우회, 응답 ${status})`).toBe(400);
    }
    test.info().annotations.push({ type: '응답 요약', description: results.join(', ') });
  });

  test('[CONN-G11] 같은 요청을 동시에 여러 번 보내면 중복 응답은 모두 "이미 연결되어 있거나 요청 중인 관계입니다."로 통일된다', async ({
    tempUser, loginAs,
  }) => {
    test.setTimeout(60_000);
    const expected = '이미 연결되어 있거나 요청 중인 관계입니다.';
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const { api } = await loginAs(guardian);

    // 순수 병렬 요청만으로는 exists 검사와 INSERT 사이 창이 너무 좁아 거의 항상 검사 단계(정식 문구)에서 걸린다.
    // 그래서 "먼저 들어온 요청이 INSERT 했지만 아직 커밋 전" 상태를 DB 트랜잭션으로 붙잡아 창을 넓힌다:
    // 커밋되지 않은 PENDING 행은 exists 검사(READ COMMITTED)에는 안 보이고, 뒤따른 요청의 INSERT 는 유니크 인덱스에서 기다린다.
    // 붙잡은 트랜잭션은 ROLLBACK 해서 우리 행은 남기지 않는다 -> 기다리던 요청 중 하나가 200, 나머지는 유니크 위반(23505) 경로로 간다.
    const held = holdTransaction(
      `INSERT INTO connection (guardian_id, ward_id, status, initiated_by, relation)
       VALUES (${sqlStr(guardian.id)}, ${sqlStr(ward.id)}, 'PENDING', ${sqlStr(guardian.id)}, '딸');`,
      8,
      'ROLLBACK',
    );
    held.catch(() => undefined);
    const holding = await settle(
      () => Number(psql(`SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query ILIKE '%pg_sleep%' AND pid IN (
              SELECT pid FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'connection' AND l.granted);`)) > 0,
      v => v,
      10_000,
    );
    expect(holding, '준비: 커밋 전 PENDING 행을 가진 트랜잭션을 잡지 못했다').toBe(true);

    // 이 시점에 같은 요청 3건을 동시에 보낸다 (두 탭·재시도 로직과 같은 상황)
    const responses = await Promise.all(
      Array.from({ length: 3 }, () => api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation: '딸' })),
    );
    await held;
    const rows = await Promise.all(
      responses.map(async res => {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        return `${res.status()} ${body.message ?? ''}`;
      }),
    );
    test.info().annotations.push({ type: '동시 요청 응답', description: rows.join(' / ') });

    const live = Number(
      psql(`SELECT count(*) FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)} AND status IN ('PENDING','ACTIVE');`),
    );
    expect(live, '유니크 인덱스가 지켜서 요청 행은 1건만 있어야 한다').toBe(1);
    expect(rows.filter(row => row.startsWith('200')).length, `동시 요청 중 정확히 1건만 성공해야 한다 (${rows.join(' / ')})`).toBe(1);

    const duplicates = rows.filter(row => row.startsWith('409'));
    expect(duplicates.length, `나머지는 409 여야 한다 (${rows.join(' / ')})`).toBe(rows.length - 1);
    const generic = duplicates.find(row => !row.includes(expected)) ?? '';
    expect(generic, `동시 중복 요청의 두 번째 응답이 범용 문구로 나왔다: "${generic}" (유니크 위반이 CONNECTION_ALREADY_EXISTS 로 변환되지 않음)`).toBe('');
  });
});

test.describe('연결 정리 알림', () => {
  test('[CONN-G09] 보호자가 탈퇴하면 purge 전에도 연결이 DISCONNECTED 로 커밋되고 피보호자에게 해제 알림이 간다', async ({
    tempUser, loginAs, openAs,
  }) => {
    test.setTimeout(120_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const id = connectionId(guardian.id, ward.id);
    expect(id, '준비: 연결 행').not.toBe('');

    const wardPage = await openAs(w.who, '/ward');
    await waitForRealtime(wardPage);

    // purge(사용자 행 DELETE)만 막는다: 보호자에게 딸린 CASCADE 대상 행(이상 알림 설정)을 하나 만들어 잠가 두면
    // purge 의 CASCADE 삭제만 그 잠금에서 기다리고, 탈퇴 UPDATE·연결 정리 UPDATE·접속로그 INSERT 는 영향을 받지 않는다.
    // 그래서 "탈퇴 커밋 후, purge 전" 구간을 붙잡아 두고 연결 상태를 들여다볼 수 있다 (purge 실패 상황과 같은 창)
    const settingId = psql(
      `INSERT INTO guardian_anomaly_setting (guardian_id, review_reminder_enabled) VALUES (${sqlStr(guardian.id)}, false) RETURNING id;`,
    );
    const held = holdTransaction(`SELECT 1 FROM guardian_anomaly_setting WHERE id = ${settingId} FOR UPDATE;`, 25);
    held.catch(() => undefined);
    const locked = await settle(
      () => {
        try {
          psql(`SELECT 1 FROM guardian_anomaly_setting WHERE id = ${settingId} FOR UPDATE NOWAIT;`);
          return false;
        } catch {
          return true;
        }
      },
      v => v,
      10_000,
    );
    expect(locked, '준비: CASCADE 대상 행 잠금을 잡지 못했다').toBe(true);

    // purge 가 잠금에서 기다리는 동안 응답이 늦어 클라이언트 제한 시간(15초)을 넘길 수 있다. 서버 쪽 처리는 계속된다
    const withdraw = g.api
      .raw('DELETE', '/api/user/me', { password: guardian.password })
      .then(r => `${r.status()}`, (e: Error) => `클라이언트 시간 초과 (${e.message.split('\n')[0]})`);

    // 탈퇴 트랜잭션 커밋(INACTIVE) 확인
    const userStatus = await settle(() => psql(`SELECT status FROM users WHERE id = ${sqlStr(guardian.id)};`), s => s === 'INACTIVE', 10_000);
    if (userStatus !== 'INACTIVE') {
      const waiting = psql(`SELECT left(query, 200) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%users%';`);
      test.info().annotations.push({ type: '잠금 대기 쿼리', description: waiting || '(없음)' });
    }
    expect(userStatus, '준비: 탈퇴 트랜잭션이 커밋되지 않았다').toBe('INACTIVE');

    // AFTER_COMMIT 리스너(tearDownConnectionsOnWithdrawal)가 끝날 시간을 준다. purge 는 잠금에 막혀 대기 중
    const connStatus = await settle(() => psql(`SELECT status FROM connection WHERE id = ${id};`), s => s !== 'ACTIVE', 8_000);
    const body = await settle(() => lastNotificationBody(ward.id, 'CONNECTION_DISCONNECTED'), b => b !== '', 5_000);
    const toastText = await liveText(wardPage);
    const stillThere = psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(guardian.id)};`);
    test.info().annotations.push({ type: 'purge 전 연결 상태', description: `connection ${id} status=${connStatus || '(행 없음)'}, users 행 ${stillThere}건` });
    test.info().annotations.push({ type: '알림 이력', description: body || '(없음)' });
    test.info().annotations.push({ type: '피보호자 토스트', description: toastText || '(없음)' });

    // 잠금을 풀고 탈퇴 응답·purge 가 끝나길 기다린다
    await held.catch(() => undefined);
    test.info().annotations.push({ type: '탈퇴 응답', description: await withdraw });
    const purged = await settle(() => psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(guardian.id)};`), c => c === '0', 15_000);
    test.info().annotations.push({ type: '잠금 해제 후 purge', description: purged === '0' ? '사용자 행 삭제됨' : '사용자 행 남음' });
    expect(stillThere, '준비: purge 가 잠금을 무시하고 먼저 끝났다 (관찰 창 확보 실패)').toBe('1');

    expect.soft(
      body,
      `탈퇴 정리 후 상대(피보호자)에게 연결 해제 알림 이력이 남지 않았다 (토스트: "${toastText}")`,
    ).not.toBe('');
    expect(
      connStatus,
      `탈퇴 커밋 뒤 AFTER_COMMIT 리스너가 disconnect() 했는데도 purge 전 연결 상태가 "${connStatus}" 이다. ` +
        'tearDownConnectionsOnWithdrawal 이 REQUIRES_NEW 없이 이미 커밋된 트랜잭션에 합류해 상태 변경이 커밋되지 않는다 ' +
        '(purge 가 실패하면 탈퇴한 보호자와의 연결이 ACTIVE 로 남는다, 정리는 FK CASCADE 에만 의존)',
    ).toBe('DISCONNECTED');
  });

  test('[CONN-G10] 관리자가 역할을 바꿔 연결이 정리되면 상대에게 "보호자가 해제했다"고 잘못 안내하지 않는다', async ({
    tempUser, loginAs,
  }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const id = connectionId(guardian.id, ward.id);
    expect(id, '준비: 연결 행').not.toBe('');
    expect(psql(`SELECT status FROM connection WHERE id = ${id};`), '준비: 연결이 ACTIVE 여야 역할 변경 정리가 알림을 보낸다').toBe('ACTIVE');
    const before = Number(psql(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(ward.id)} AND type = 'CONNECTION_DISCONNECTED';`));
    const admin = await adminApi(tempUser, loginAs);

    // 강제 해제(DELETE /api/admin/connection)가 아니라 역할 변경 경로(tearDownConnectionsOnRoleChange)로만 연결을 끊는다
    await admin.call('PATCH', `/api/admin/user/${guardian.id}`, { role: 'WARD' });

    const role = psql(`SELECT role FROM users WHERE id = ${sqlStr(guardian.id)};`);
    const connStatus = await settle(() => psql(`SELECT status FROM connection WHERE id = ${id};`), s => s === 'DISCONNECTED', 10_000);
    const rows = await settle(
      () => psql(`SELECT body FROM notification_log WHERE recipient_id = ${sqlStr(ward.id)} AND type = 'CONNECTION_DISCONNECTED' ORDER BY id;`),
      r => r !== '',
      15_000,
    );
    const bodies = rows ? rows.split('\n') : [];
    const body = bodies[bodies.length - 1] ?? '';
    test.info().annotations.push({ type: '역할 변경 결과', description: `role=${role}, connection ${id} status=${connStatus}, 변경 전 해제 이력 ${before}건` });
    test.info().annotations.push({ type: '피보호자 알림 본문', description: bodies.join(' / ') || '(없음)' });

    expect(role, '준비: 역할 변경이 반영돼야 한다').toBe('WARD');
    expect(connStatus, '준비: 역할 변경 정리로 연결이 DISCONNECTED 가 돼야 한다').toBe('DISCONNECTED');
    expect(before, '준비: 역할 변경 전에는 해제 이력이 없어야 한다').toBe(0);
    expect(bodies.length, '역할 변경으로 연결이 정리됐는데 상대(피보호자)에게 해제 알림 이력이 1건이 아니다').toBe(1);
    expect(
      body,
      `관리자가 역할을 바꿔 끊었는데 피보호자에게 "${body}" 로 안내한다 (보호자가 스스로 끊은 것처럼 보임)`,
    ).not.toMatch(/(보호자|피보호자)가 연결을 해제했습니다/);
    expect(body, `역할 변경 정리 알림이 관리자 조치임을 알리지 않는다: "${body}"`).toMatch(/관리자/);
  });

  test('[CONN-G12] 관리자가 연결을 강제 해제하면 실시간 토스트에 관리자 해제라는 문구가 표시된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const admin = await adminApi(tempUser, loginAs);
    const [g, w] = [await loginAs(guardian), await loginAs(ward)];

    const guardianPage = await openAs(g.who, '/guardian/wards');
    const wardPage = await openAs(w.who, '/ward');
    await Promise.all([waitForRealtime(guardianPage), waitForRealtime(wardPage)]);

    const id = connectionId(guardian.id, ward.id);
    expect(id, '준비: 연결 행').not.toBe('');
    await admin.call('DELETE', `/api/admin/connection/${id}`);

    const texts = await settle(
      async () => [await liveText(guardianPage), await liveText(wardPage)],
      t => t.some(x => /해제/.test(x)),
      15_000,
    );
    await wardPage.waitForTimeout(1_500);
    const [guardianText, wardText] = [await liveText(guardianPage), await liveText(wardPage)];
    test.info().annotations.push({ type: '보호자 토스트', description: guardianText || texts[0] });
    test.info().annotations.push({ type: '피보호자 토스트', description: wardText || texts[1] });

    const all = `${guardianText} | ${wardText}`;
    expect(all, '해제 실시간 토스트가 어느 화면에도 뜨지 않았다').toMatch(/해제/);
    expect(
      all,
      `WS payload 에 connectionId 만 있어 토스트가 FE 기본 문구로만 뜬다. 관리자가 해제했다는 안내가 없다: ${all}`,
    ).toMatch(/관리자/);
  });
});

test.describe('피보호자 관리 화면 (보호자)', () => {
  test('[CONN-G13] 등록 탭으로 바로 들어가도 툴바에 실제 연결 수가 표시된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const { who } = await loginAs(guardian);

    const page = await openAs(who, '/guardian/wards?tab=register');
    const summary = page.getByText(/연결됨 \d+명 · 대기 \d+건/);
    await expect(summary).toBeVisible();
    // 목록 조회가 끝날 수 있는 시간을 준다
    await page.waitForTimeout(3_000);
    const text = (await summary.innerText()).replace(/\s+/g, ' ');
    test.info().annotations.push({ type: '등록 탭 툴바', description: text });

    expect(text, `ACTIVE 연결이 1명 있는데 등록 탭 직접 진입 시 툴바가 "${text}" 로 표시된다 (목록 쿼리가 list 탭에서만 활성화됨)`).toContain('연결됨 1명');
  });

  test('[CONN-G16] 피보호자에게 연결 요청이 4건 도착하면 모든 요청이 수락/거절할 수 있게 남는다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who } = await loginAs(ward);
    const page = await openAs(who, '/ward');
    await waitForRealtime(page);

    for (let i = 1; i <= 4; i++) {
      const guardian = await tempUser('GUARDIAN', { name: `E2E요청자${i}` });
      const { api } = await loginAs(guardian);
      await api.post('/api/guardian/connection/request', { targetId: ward.id, relation: '딸' });
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(3_000);

    const area = page.locator('[aria-live="polite"]');
    const acceptButtons = await area.getByRole('button', { name: '수락', exact: true }).count();
    const overflowNotice = await area.getByText(/\d+\s*건\s*더|외\s*\d+\s*건|\+\s*\d+/).count();
    const pending = Number(psql(`SELECT count(*) FROM connection WHERE ward_id = ${sqlStr(ward.id)} AND status = 'PENDING';`));
    test.info().annotations.push({ type: '토스트', description: `수락 버튼 ${acceptButtons}개, 더보기 안내 ${overflowNotice}개, DB PENDING ${pending}건` });

    expect(pending, '준비: 요청 4건이 모두 PENDING 이어야 한다').toBe(4);
    expect(
      acceptButtons > 3 || overflowNotice > 0,
      `요청 ${pending}건이 왔는데 수락/거절 토스트는 ${acceptButtons}개만 남고 나머지는 "N건 더 있음" 안내 없이 사라졌다 (slice(0, 3))`,
    ).toBe(true);
  });

  test('[CONN-G17] 요청일은 해외 타임존 브라우저에서도 한국 시간(KST) 날짜로 표시된다', async ({ tempUser, loginAs, browser }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const { login } = await loginAs(guardian);

    // KST 2026-09-30 00:30 에 생긴 수락 대기 요청 (LA 에서는 09-29 저녁)
    psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, relation, created_at)
          VALUES (${sqlStr(guardian.id)}, ${sqlStr(ward.id)}, 'PENDING', ${sqlStr(guardian.id)}, '딸', '2026-09-30 00:30:00+09');`);

    const context = await browser.newContext({
      ...contextDefaults,
      timezoneId: 'America/Los_Angeles',
      storageState: { cookies: tokenCookies(login), origins: [] },
    });
    try {
      await context.addInitScript(installPageStubs(), pageStubArg);
      const page = await context.newPage();
      await page.goto('/guardian/wards?tab=register');

      const row = page.locator('section').filter({ hasText: '요청 내역' }).locator('li').first();
      await expect(row).toBeVisible();
      const text = (await row.innerText()).replace(/\s+/g, ' ');
      test.info().annotations.push({ type: '요청 내역 행', description: text });

      expect(
        text,
        `KST 2026-09-30 00:30 에 보낸 요청이 LA 브라우저에서 하루 전으로 표시된다 (Intl.DateTimeFormat 에 timeZone 미지정): "${text}"`,
      ).toMatch(/2026\.\s*09\.\s*30\./);
    } finally {
      await context.close();
    }
  });
});

/** DB 트랜잭션을 열어 둔 채로 sleep 하다 커밋한다 (경합 재현용, 임시 행만 건드린다) */
function holdTransaction(sql: string, holdSeconds: number, end: 'COMMIT' | 'ROLLBACK' = 'COMMIT') {
  const script = [
    `docker exec -i ${env.dbContainer} sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -q' <<'__E2E_SQL__'`,
    'BEGIN;',
    sql,
    `SELECT pg_sleep(${holdSeconds});`,
    `${end};`,
    '__E2E_SQL__',
    '',
  ].join('\n');
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', env.sshHost, 'bash -s']);
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`트랜잭션 유지 실패 (exit ${code}): ${stderr}`))));
    child.stdin.end(script);
  });
}

test.describe('역할 변경과 연결 요청 경합', () => {
  test('[CONN-G15] 피보호자가 GUARDIAN 으로 바뀌는 중에 들어온 연결 요청은 뒤집힌 방향의 PENDING 으로 남지 않는다', async ({
    tempUser, loginAs,
  }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const { api } = await loginAs(guardian);

    // 관리자의 역할 변경 트랜잭션이 아직 커밋되지 않은 상태를 만든다 (정리 단계는 PENDING 을 못 보고 지나간 뒤)
    const held = holdTransaction(`UPDATE users SET role = 'GUARDIAN' WHERE id = ${sqlStr(ward.id)};`, 5);
    await new Promise(resolve => setTimeout(resolve, 2_500));

    const res = await api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation: '딸' });
    const status = res.status();
    const text = (await res.text()).slice(0, 150);
    await held;

    const role = psql(`SELECT role FROM users WHERE id = ${sqlStr(ward.id)};`);
    const stale = Number(
      psql(`SELECT count(*) FROM connection c JOIN users u ON u.id = c.ward_id
            WHERE c.ward_id = ${sqlStr(ward.id)} AND c.status = 'PENDING' AND u.role <> 'WARD';`),
    );
    test.info().annotations.push({ type: '경합 결과', description: `요청 응답 ${status} ${text}, 피보호자 역할 ${role}, 뒤집힌 PENDING ${stale}건` });

    expect(role, '준비: 역할 변경이 커밋돼야 한다').toBe('GUARDIAN');
    expect(
      stale,
      `역할 변경 커밋 전에 읽은 옛 역할(WARD)로 요청이 통과해, 이제 GUARDIAN 인 사용자가 ward_id 인 PENDING 이 ${stale}건 남았다 (요청 응답 ${status}). 수락 시 역할 재검증·행 잠금이 없다`,
    ).toBe(0);
  });
});
