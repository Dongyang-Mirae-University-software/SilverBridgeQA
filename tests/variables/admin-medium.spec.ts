/**
 * 변수 QA - 관리자 영역 (medium 8건)
 *
 * 부작용 차단: 임시 사용자(tempUser)와 [QA-ADMIN] 접두어 공지/문의만 쓰고, 끝나면 모두 지운다.
 * 임시 사용자는 FCM 토큰이 없고 알림 채널이 기본값(FCM)이라 외부 발송이 나가지 않는다.
 */
import { APIResponse } from '@playwright/test';

import { Api } from '../../src/api';
import { expect, test } from '../../src/fixtures';
import { psql, redis, redisDelPattern, sqlStr } from '../../src/remote';
import { connect } from '../../src/variables';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function bodyOf(res: APIResponse) {
  const text = await res.text();
  try {
    return { status: res.status(), text, json: JSON.parse(text) as { success?: boolean; message?: string; data?: any } };
  } catch {
    return { status: res.status(), text, json: {} as { success?: boolean; message?: string; data?: any } };
  }
}

/** 관리자 조치가 남긴 감사 로그 정리 (삭제 API 가 없어 DB 로 지운다) */
function cleanAuditLog(adminId: string, targetIds: string[]) {
  const targets = targetIds.map(sqlStr).join(', ');
  psql(`DELETE FROM admin_audit_log WHERE admin_id = ${sqlStr(adminId)}${targets ? ` OR target_id IN (${targets})` : ''};`);
}

test.describe('관리자 API 권한 응답', () => {
  test('[ADMIN-G01] 보호자/피보호자가 관리자 API 를 호출하면 401 이 아니라 403 "접근 권한이 없습니다." 를 받는다', async ({ tempUser, loginAs }) => {
    const guardian = await loginAs(await tempUser('GUARDIAN'));
    const ward = await loginAs(await tempUser('WARD'));

    const calls: { method: 'GET' | 'POST'; path: string; data?: unknown }[] = [
      { method: 'GET', path: '/api/admin/user' },
      { method: 'GET', path: '/api/admin/inquiry' },
      // 권한 거부 경로라 본문이 비어 있어도 상태가 바뀌지 않는다
      { method: 'POST', path: '/api/admin/connection', data: {} },
    ];

    const seen: string[] = [];
    for (const [label, who] of [['보호자', guardian], ['피보호자', ward]] as const) {
      for (const call of calls) {
        const r = await bodyOf(await who.api.raw(call.method, call.path, call.data));
        seen.push(`${label} ${call.method} ${call.path} -> ${r.status} ${r.json.message ?? r.text.slice(0, 60)}`);
        expect.soft(r.status, `${label} ${call.method} ${call.path}: 권한 부족인데 ${r.status} (${r.json.message ?? r.text.slice(0, 80)}) - URL 규칙 거부가 /error 재디스패치로 401 이 됨`).toBe(403);
        expect.soft(r.json.message, `${label} ${call.method} ${call.path}: 메시지가 "접근 권한이 없습니다." 여야 한다`).toBe('접근 권한이 없습니다.');
      }
    }
    test.info().annotations.push({ type: '실측', description: seen.join(' | ') });

    // 대조군: 클래스 @PreAuthorize 만 게이트인 경로는 JSON 403
    const control = await bodyOf(await ward.api.raw('POST', '/api/guardian/inquiry', {}));
    test.info().annotations.push({ type: '대조군 POST /api/guardian/inquiry(피보호자)', description: `${control.status} ${control.json.message}` });
  });
});

test.describe('탈퇴 시 연결 정리', () => {
  test('[ADMIN-G02] 관리자가 연결된 회원을 강제 탈퇴시키면 연결 상대에게 해제 알림(WS connection-cancelled)과 CONNECTION_DISCONNECTED 이력이 남는다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const admin = await tempUser('ADMIN');
    const a = await loginAs(admin);

    /** 상대 화면의 연결 소켓에 관찰용 구독을 걸고 강제 탈퇴 후 WS 수신과 알림 이력을 본다 */
    async function run(label: string, withdrawn: { id: string }, peer: Awaited<ReturnType<typeof tempUser>>, path: string) {
      const p = await loginAs(peer);
      const connId = psql(`SELECT id FROM connection WHERE status = 'ACTIVE' AND (guardian_id = ${sqlStr(withdrawn.id)} OR ward_id = ${sqlStr(withdrawn.id)});`);
      expect(connId, `${label}: 사전 조건 - ACTIVE 연결이 있어야 한다`).not.toBe('');

      const page = await openAs(p.who, path);
      await page.waitForFunction(
        () => (window as unknown as { __connectionStompClient?: { connected: boolean } }).__connectionStompClient?.connected === true,
        null, { timeout: 30_000 },
      );
      // 앱이 이미 구독한 토픽에 관찰용 구독을 하나 더 건다
      await page.evaluate(destination => {
        const w = window as unknown as {
          __qaCancelled: string[];
          __connectionStompClient: { subscribe: (d: string, cb: (m: { body: string }) => void) => void };
        };
        w.__qaCancelled = [];
        w.__connectionStompClient.subscribe(destination, m => w.__qaCancelled.push(m.body));
      }, `/topic/${peer.id}/connection-cancelled`);
      await sleep(500);

      const res = await bodyOf(await a.api.raw('DELETE', `/api/admin/user/${withdrawn.id}`));
      expect(res.status, `${label}: 강제 탈퇴 응답 ${res.text}`).toBe(200);

      // 비동기 리스너가 끝날 때까지 WS 와 이력을 함께 폴링한다
      let wsBodies: string[] = [];
      let logs = '';
      for (let i = 0; i < 12; i++) {
        wsBodies = await page.evaluate(() => (window as unknown as { __qaCancelled?: string[] }).__qaCancelled ?? []);
        logs = psql(`SELECT body || '/' || result FROM notification_log WHERE type = 'CONNECTION_DISCONNECTED' AND recipient_id = ${sqlStr(peer.id)};`);
        if (wsBodies.length > 0 && logs !== '') break;
        await sleep(1_000);
      }
      const logRows = logs === '' ? [] : logs.split('\n');
      test.info().annotations.push({ type: `실측 ${label}`, description: `연결 ${connId}, WS ${wsBodies.length}건 ${wsBodies.join(' ')}, 이력 ${logRows.length}건 ${logRows.join(' | ')}` });
      await page.close();
      return { connId, wsBodies, logRows };
    }

    const cleanup: string[] = [];
    try {
      // 1) 피보호자 강제 탈퇴 -> 보호자가 알림을 받는다. 이력의 ward_id 가 탈퇴자라 purge CASCADE 로 지워질 수 있어 WS 만 단언한다
      const g1 = await tempUser('GUARDIAN');
      const w1 = await tempUser('WARD');
      cleanup.push(g1.id, w1.id);
      connect(g1.id, w1.id);
      const r1 = await run('피보호자 탈퇴', w1, g1, '/guardian/wards');
      expect.soft(r1.wsBodies.length, '피보호자 탈퇴: 보호자에게 WS connection-cancelled 가 와야 한다 (AFTER_COMMIT 리스너의 REQUIRED 합류로 이벤트 유실)').toBe(1);
      expect.soft(r1.wsBodies.join(''), '피보호자 탈퇴: WS 본문에 해제된 연결 id 가 있어야 한다').toContain(r1.connId);

      // 2) 보호자 강제 탈퇴 -> 피보호자가 알림을 받는다. recipient/ward 모두 살아 있어 이력 1건이 남아야 한다
      const g2 = await tempUser('GUARDIAN');
      const w2 = await tempUser('WARD');
      cleanup.push(g2.id, w2.id);
      connect(g2.id, w2.id);
      const r2 = await run('보호자 탈퇴', g2, w2, '/ward');
      expect.soft(r2.wsBodies.length, '보호자 탈퇴: 피보호자에게 WS connection-cancelled 가 와야 한다').toBe(1);
      expect.soft(r2.logRows.length, '보호자 탈퇴: 피보호자 앞 CONNECTION_DISCONNECTED 알림 이력이 정확히 1건 남아야 한다 (유실 시 0건)').toBe(1);
      // 문구는 dev 배포본에서 바뀔 수 있어(실측 "보호자가 탈퇴해 연결이 종료되었습니다.") 주체만 확인한다
      expect.soft(r2.logRows.join(''), '보호자 탈퇴: 이력 본문이 보호자 쪽 해제임을 알려야 한다').toContain('보호자');
    } finally {
      cleanAuditLog(admin.id, cleanup);
    }
  });
});

test.describe('관리자 조치와 로그인의 동시성', () => {
  test('[ADMIN-G04] 로그인이 진행 중일 때 관리자가 계정을 정지해도 정지가 로그인 커밋에 덮여 ACTIVE 로 되돌아가지 않는다', async ({ tempUser, loginAs }) => {
    test.setTimeout(420_000);
    const admin = await tempUser('ADMIN');
    const target = await tempUser('GUARDIAN');
    const a = await loginAs(admin);

    const lost: string[] = [];
    let tries = 0;
    try {
      // 로그인 요청과 정지 요청의 간격을 바꿔 가며 겹치는 순간을 찾는다
      outer: for (let round = 0; round < 2; round++) {
        for (let delay = 0; delay <= 240; delay += 10) {
          tries++;
          redisDelPattern('rate:signin:*');
          redisDelPattern(`password:invalidate:${target.id}`);
          psql(`UPDATE users SET status = 'ACTIVE', status_reason = NULL WHERE id = ${sqlStr(target.id)};`);

          const login = Api.signin(target.email, target.password).then(() => 'ok', () => 'fail');
          await sleep(delay);
          const patch = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { status: 'RESTRICTED', statusReason: 'qa' }));
          await login;

          const status = psql(`SELECT status FROM users WHERE id = ${sqlStr(target.id)};`);
          if (patch.status === 200 && status !== 'RESTRICTED') {
            lost.push(`지연 ${delay}ms: 정지 응답 200 이었으나 DB status=${status}`);
            break outer;
          }
        }
      }
      test.info().annotations.push({ type: '실측', description: `${tries}회 시도, 덮어쓰기 ${lost.length}건 ${lost.join(' / ')}` });
      expect(lost, '관리자가 정지(200)한 계정이 로그인 트랜잭션의 전체 컬럼 UPDATE 로 ACTIVE 로 되돌아갔다 (lost update)').toEqual([]);
    } finally {
      redisDelPattern(`password:invalidate:${target.id}`);
      cleanAuditLog(admin.id, [target.id]);
    }
  });
});

test.describe('공지 조회', () => {
  test('[ADMIN-G05] 공지를 수정하지 않고 상세만 조회해도 수정 일시(updatedAt)는 바뀌지 않는다', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const guardian = await tempUser('GUARDIAN');
    const [a, g] = [await loginAs(admin), await loginAs(guardian)];

    let id: number | undefined;
    try {
      const created = await a.api.post<{ id: number; updatedAt: string }>('/api/admin/announcement/create', {
        title: `[QA-ADMIN] G05 ${Date.now().toString(36)}`, content: '수정 일시 오염 확인용 (곧 삭제됨)',
      });
      id = created.id;
      const before = (await a.api.get<{ updatedAt: string }>(`/api/admin/announcement/select/detail/${id}`)).updatedAt;

      await sleep(3_000);
      await g.api.get(`/api/commonness/announcement/select/detail/${id}`);

      const after = (await a.api.get<{ updatedAt: string }>(`/api/admin/announcement/select/detail/${id}`)).updatedAt;
      test.info().annotations.push({ type: '실측', description: `조회 전 ${before} / 조회 후 ${after}` });
      expect(after, `단순 조회로 updatedAt 이 ${before} -> ${after} 로 바뀌었다 (조회수 증가가 @LastModifiedDate 와 DB 트리거를 탄다)`).toBe(before);
    } finally {
      if (id !== undefined) await a.api.call('DELETE', `/api/admin/announcement/delete/${id}`).catch(() => undefined);
      cleanAuditLog(admin.id, id !== undefined ? [String(id)] : []);
    }
  });
});

test.describe('문의 답변 동시성', () => {
  test('[ADMIN-G07] 같은 문의에 동시에 답변하면 한 요청만 성공하고 나머지는 409 이다', async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const admin = await tempUser('ADMIN');
    const author = await tempUser('GUARDIAN');
    const a = await loginAs(admin);

    const inquiryIds: string[] = [];
    const findings: string[] = [];
    try {
      for (let round = 1; round <= 15 && findings.length === 0; round++) {
        const id = psql(`INSERT INTO inquiry (user_id, category, title, content, status)
                         VALUES (${sqlStr(author.id)}, 'ETC', ${sqlStr(`[QA-ADMIN] G07 ${round}`)}, '동시 답변 확인용', 'WAITING') RETURNING id;`)
          .split('\n')[0].trim();
        inquiryIds.push(id);

        const results = await Promise.all(
          [1, 2, 3, 4].map(n => a.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: `동시 답변 ${round}-${n}` })),
        );
        const statuses = results.map(r => r.status());
        const audits = Number(psql(`SELECT count(*) FROM admin_audit_log WHERE action = 'INQUIRY_ANSWER' AND target_id = ${sqlStr(id)};`));
        if (statuses.filter(s => s === 200).length > 1 || audits > 1) {
          findings.push(`${round}회차: 응답 ${statuses.join(',')}, 답변 감사 로그 ${audits}행`);
        }
      }
      test.info().annotations.push({ type: '실측', description: findings.length ? findings.join(' / ') : `${inquiryIds.length}회차 모두 정상` });
      expect(findings, '동시 답변이 둘 이상 200 으로 성공했다 (재답변 409 가드가 원자적이지 않음)').toEqual([]);
    } finally {
      cleanAuditLog(admin.id, inquiryIds);
    }
  });
});

test.describe('FE 공지사항 화면', () => {
  test('[ADMIN-G11] 공지가 2건 이상이면 최신 1건뿐 아니라 이전 공지도 화면에서 볼 수 있다', async ({ tempUser, loginAs, openAs }) => {
    const admin = await tempUser('ADMIN');
    const guardian = await tempUser('GUARDIAN');
    const [a, g] = [await loginAs(admin), await loginAs(guardian)];

    const suffix = Date.now().toString(36);
    const older = `[QA-ADMIN] G11 이전공지 ${suffix}`;
    const newer = `[QA-ADMIN] G11 최신공지 ${suffix}`;
    const ids: number[] = [];
    try {
      ids.push((await a.api.post<{ id: number }>('/api/admin/announcement/create', { title: older, content: '이전 공지 본문' })).id);
      await sleep(1_500);
      ids.push((await a.api.post<{ id: number }>('/api/admin/announcement/create', { title: newer, content: '최신 공지 본문' })).id);

      const page = await openAs(g.who, '/guardian/notices');
      await expect(page.getByText(newer), '최신 공지는 보여야 한다').toBeVisible();
      await expect(page.getByText(older), '이전 공지가 화면 어디에도 없다 (최신 1건만 렌더, 목록/상세 진입 없음)').toBeVisible({ timeout: 3_000 });
    } finally {
      for (const id of ids) await a.api.call('DELETE', `/api/admin/announcement/delete/${id}`).catch(() => undefined);
      cleanAuditLog(admin.id, ids.map(String));
    }
  });
});

test.describe('FE 문의하기 화면', () => {
  test('[ADMIN-G12] 보호자 문의하기 화면에서 문의를 작성하고 내 문의와 답변을 볼 수 있다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);

    const title = `[QA-ADMIN] G12 문의 ${Date.now().toString(36)}`;
    // 알림이 나가지 않도록 API 가 아니라 DB 로 답변 완료 문의를 만든다
    psql(`INSERT INTO inquiry (user_id, category, title, content, status, answer, answered_at)
          VALUES (${sqlStr(guardian.id)}, 'ETC', ${sqlStr(title)}, '문의 본문', 'ANSWERED', 'QA 답변 내용', now());`);

    const page = await openAs(who, '/guardian/inquiries');
    await expect(page.getByRole('heading', { level: 1, name: '문의하기', exact: true })).toBeVisible();

    await expect.soft(page.locator('textarea').first(), '문의 작성 폼(내용 입력)이 없다 - 화면이 제목/설명만 있는 placeholder').toBeVisible({ timeout: 3_000 });
    await expect.soft(page.getByText(title), '내가 남긴 문의가 목록에 보여야 한다').toBeVisible({ timeout: 3_000 });
    await expect.soft(page.getByText('QA 답변 내용'), '관리자 답변을 확인할 수 있어야 한다').toBeVisible({ timeout: 3_000 });
  });
});

test.describe('역할 변경 후 복약 알림', () => {
  test('[ADMIN-G14] 피보호자가 보호자로 바뀌면 옛 복약 일정의 복약 알림은 더 이상 발송되지 않는다', async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const admin = await tempUser('ADMIN');
    const user = await tempUser('WARD');
    const a = await loginAs(admin);

    try {
      // 복용 시각은 KST 기준. 처음엔 창 밖(6시간 뒤)에 두어 역할 변경 전에는 스케줄러가 집지 못하게 한다
      const medId = psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time)
                          VALUES (${sqlStr(user.id)}, ${sqlStr(user.id)}, '[QA-ADMIN] G14 약', 'MORNING',
                                  ((now() AT TIME ZONE 'Asia/Seoul')::time + interval '6 hours')::time) RETURNING id;`)
        .split('\n')[0].trim();

      const res = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${user.id}`, { role: 'GUARDIAN' }));
      expect(res.status, `역할 변경 응답: ${res.text}`).toBe(200);
      expect(psql(`SELECT role FROM users WHERE id = ${sqlStr(user.id)};`), '역할이 GUARDIAN 으로 바뀌어야 한다').toBe('GUARDIAN');

      // 이제 옛 약이 복용 시각이 도래한 상태가 된다 (스케줄러 1분 주기)
      psql(`UPDATE medication SET dose_time = ((now() AT TIME ZONE 'Asia/Seoul')::time - interval '1 minute')::time WHERE id = ${medId};`);

      let sent = 0;
      let notified = 0;
      for (let i = 0; i < 25 && sent === 0; i++) {
        await sleep(6_000);
        sent = Number(psql(`SELECT count(*) FROM medication_reminder_log WHERE medication_id = ${medId};`));
        notified = Number(psql(`SELECT count(*) FROM notification_log WHERE type = 'MEDICATION_REMINDER' AND recipient_id = ${sqlStr(user.id)};`));
        if (notified > 0) break;
      }
      test.info().annotations.push({ type: '실측', description: `발송 기록 ${sent}건, 복약 알림 이력 ${notified}건` });
      expect(
        { sent, notified },
        '보호자로 바뀐 사용자에게 옛 복약 일정의 복약 알림이 발송됐다 (역할 변경 시 medication 정리/발송 대상 role 검사 없음)',
      ).toEqual({ sent: 0, notified: 0 });
    } finally {
      cleanAuditLog(admin.id, [user.id]);
    }
  });
});
