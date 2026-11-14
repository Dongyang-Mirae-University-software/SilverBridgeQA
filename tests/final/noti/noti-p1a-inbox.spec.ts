/**
 * 최종 QA - 알림(NOTI) P1a - 받은 알림 기록(종 아이콘)·읽음 처리·탈퇴 정리·푸시 클릭 경로
 *
 * 받은 알림 API 는 11/13판 설명서에는 없고 배포 코드(UserNotificationController)에 있다:
 *   GET /api/user/me/notifications · /unread-count, POST /{id}/read · /read-all  (남의 알림 403 NOTIFICATION_NOT_OWNED, 없는 알림 404)
 * 기대값은 이 코드로 정했다(설명서 확정 전 - 케이스 N34 의 보류 사유).
 * 알림 이력 행은 전화번호·푸시 토큰이 없는 보호자에게 SOS 를 보내 만든다(전달 수단이 없어 FAILED 로 남고 외부 발송은 없다).
 */
import vm from 'node:vm';

import { request } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { TempUser, TempUserOptions } from '../../../src/seed';
import { connect } from '../../../src/variables';
import { bellButton, bodyOf, logRows, menuButton, sendSos, waitForLog } from './_helpers-noti';
import { logCountOf, P1A_TAGS, readAtOf, uniqueNameTag } from './_helpers-noti-p1a';

const INBOX = '/api/user/me/notifications';
const REQUEST = '/api/guardian/connection/request';

interface InboxItem { id: number; type: string; category: string; read: boolean; wardId: string | null; wardName: string | null }
interface InboxPage { content: InboxItem[]; totalElements: number }

test.describe('받은 알림 기록 - API', () => {
  test('NOTI-N34 알림 발송 시 받는 사람 1명당 1줄 기록, read_at은 NULL', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.info().annotations.push({ type: '근거', description: '받은 알림 API 가 11/13판 설명서에 없어 배포 코드(UserNotificationController·notification_log V67)로 기대값을 정함' });
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const [w, g] = [await loginAs(ward), await loginAs(guardian)];

    const res = await g.api.raw('POST', REQUEST, { targetId: ward.id, relation: '딸' });
    expect(res.status(), '연결 요청 200').toBe(200);

    const rows = await waitForLog(ward.id, 'CONNECTION_REQUEST');
    expect(rows, '받는 사람(피보호자) 1명당 1줄').toHaveLength(1);
    expect(rows[0].readAt, 'read_at 은 NULL(안 읽음)').toBe('');
    expect(psql(`SELECT read_at IS NULL FROM notification_log WHERE id = ${rows[0].id};`), 'DB 에서도 read_at IS NULL').toBe('t');
    expect(logRows(guardian.id), '요청을 보낸 보호자에게는 줄이 없다').toHaveLength(0);

    // 보낸 알림(전달 수단이 없어 FAILED)은 받은 알림 기록에 안 읽음으로 보인다
    const unread = await w.api.get<{ count: number }>(`${INBOX}/unread-count`);
    expect(unread.count, '안 읽은 수 1').toBe(1);
    const list = await w.api.get<InboxPage>(INBOX);
    expect(list.content.map(i => ({ id: i.id, type: i.type, category: i.category, read: i.read })), '목록에 1건, 안 읽음').toEqual([
      { id: rows[0].id, type: 'CONNECTION_REQUEST', category: 'CONNECTION', read: false },
    ]);
  });

  test('NOTI-A48 이미 읽은 알림을 다시 읽음 처리하면 시각 유지', P1A_TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward1 = await tempUser('WARD', { phone: null });
    const ward2 = await tempUser('WARD', { phone: null });
    connect(guardian.id, ward1.id);
    connect(guardian.id, ward2.id);
    const [g, w1, w2] = [await loginAs(guardian), await loginAs(ward1), await loginAs(ward2)];
    await sendSos(w1.api);
    await sendSos(w2.api);
    const rows = await waitForLog(guardian.id, 'WARD_SOS', 2);
    const [idA, idB] = rows.map(r => r.id);
    const unread = async () => (await g.api.get<{ count: number }>(`${INBOX}/unread-count`)).count;
    const read = (id: number) => g.api.raw('POST', `${INBOX}/${id}/read`);
    expect(await unread(), '준비: 안 읽은 수 2').toBe(2);

    await test.step('같은 알림을 연속으로 두 번 읽음 -> 둘 다 200, 처음 읽은 시각 유지, 안 읽은 수 1', async () => {
      expect((await read(idA)).status(), '첫 읽음 200').toBe(200);
      const firstReadAt = readAtOf(idA);
      expect(firstReadAt, 'read_at 이 채워졌다').not.toBe('');
      expect((await read(idA)).status(), '다시 읽음도 200(멱등)').toBe(200);
      expect(readAtOf(idA), '처음 읽은 시각 그대로').toBe(firstReadAt);
      expect(await unread(), '한 건만 줄어 1').toBe(1);
    });

    await test.step('이미 읽은 알림을 동시에 5번 읽음 -> 모두 200, 시각 그대로, 안 읽은 수 1', async () => {
      const before = readAtOf(idA);
      const results = await Promise.all(Array.from({ length: 5 }, () => read(idA)));
      expect(results.map(r => r.status()), '모두 200').toEqual([200, 200, 200, 200, 200]);
      expect(readAtOf(idA), '시각 그대로').toBe(before);
      expect(await unread(), '안 읽은 수 그대로 1').toBe(1);
    });

    await test.step('안 읽은 알림을 동시에 5번 읽음 -> 모두 200, 한 번만 읽은 것으로, 안 읽은 수 0(음수 아님)', async () => {
      const results = await Promise.all(Array.from({ length: 5 }, () => read(idB)));
      expect(results.map(r => r.status()), '모두 200').toEqual([200, 200, 200, 200, 200]);
      const at = readAtOf(idB);
      expect(at, 'read_at 이 채워졌다').not.toBe('');
      expect(await unread(), '안 읽은 수 0').toBe(0);
      expect(readAtOf(idB), '시각이 더 바뀌지 않는다').toBe(at);
    });

    await test.step('모두 읽음을 다시 눌러도 오류 없이 0건, 안 읽은 수는 0 그대로', async () => {
      const all = await g.api.raw('POST', `${INBOX}/read-all`);
      expect(all.status()).toBe(200);
      expect(((await bodyOf(all)).data as { updated: number }).updated, '바뀐 건수 0').toBe(0);
      expect(await unread(), '음수가 되지 않는다').toBe(0);
    });
  });

  test('NOTI-A50 받는 사람·피보호자가 탈퇴하면 그 사람 이력도 삭제', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const ward = await tempUser('WARD', { phone: null });
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    const requester = await tempUser('GUARDIAN', { phone: null });
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const [w, a, b, rq] = [await loginAs(ward), await loginAs(g1), await loginAs(g2), await loginAs(requester)];
    void b;

    // 준비: 피보호자 SOS(보호자 둘에게 1줄씩, ward_id = 피보호자), 연결 요청(피보호자가 받는 1줄)
    await sendSos(w.api);
    const [sos1] = await waitForLog(g1.id, 'WARD_SOS');
    const [sos2] = await waitForLog(g2.id, 'WARD_SOS');
    expect((await rq.api.raw('POST', REQUEST, { targetId: ward.id, relation: '딸' })).status(), '준비: 연결 요청').toBe(200);
    const [req] = await waitForLog(ward.id, 'CONNECTION_REQUEST');
    const rowExists = (id: number) => Number(psql(`SELECT count(*) FROM notification_log WHERE id = ${id};`)) === 1;
    const userGone = (id: string) => Number(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(id)};`)) === 0;
    expect([sos1.id, sos2.id, req.id].every(rowExists), '준비: 세 줄이 모두 있다').toBe(true);

    await test.step('받는 사람(보호자 g1)이 탈퇴 -> g1 의 줄만 사라진다', async () => {
      const res = await a.api.raw('DELETE', '/api/user/me', { password: g1.password });
      expect(res.status(), '탈퇴 200').toBe(200);
      await expect.poll(() => userGone(g1.id), { timeout: 30_000, intervals: [1_000, 2_000], message: '탈퇴한 사용자 행이 지워져야 한다(hard delete)' }).toBe(true);
      expect(logCountOf(g1.id), 'g1 의 알림 이력이 모두 삭제됨').toBe(0);
      expect(rowExists(sos1.id), 'g1 의 SOS 줄 삭제').toBe(false);
      expect(rowExists(sos2.id), '대조: g2 의 줄은 그대로').toBe(true);
      expect(rowExists(req.id), '대조: 피보호자의 연결 요청 줄도 그대로').toBe(true);
    });

    await test.step('피보호자가 탈퇴 -> 피보호자가 받은 줄과 피보호자에 관한 줄이 모두 사라진다', async () => {
      const res = await w.api.raw('DELETE', '/api/user/me', { password: ward.password });
      expect(res.status(), '탈퇴 200').toBe(200);
      await expect.poll(() => userGone(ward.id), { timeout: 30_000, intervals: [1_000, 2_000], message: '탈퇴한 피보호자 행이 지워져야 한다(hard delete)' }).toBe(true);
      expect(rowExists(req.id), '피보호자가 받은 연결 요청 줄 삭제').toBe(false);
      expect(rowExists(sos2.id), 'g2 가 받은, 그 피보호자에 관한 SOS 줄도 삭제(ward_id CASCADE)').toBe(false);
      expect(Number(psql(`SELECT count(*) FROM notification_log WHERE ward_id = ${sqlStr(ward.id)} OR recipient_id = ${sqlStr(ward.id)};`)), '그 피보호자와 관련된 줄이 남지 않는다').toBe(0);
    });
  });
});

test.describe('받은 알림 기록 - 화면', () => {
  /** 보호자 한 명에게 피보호자 3명의 SOS 알림 3건을 쌓는다 */
  async function threeWards(tempUser: (role: TempUser['role'], options?: TempUserOptions) => Promise<TempUser>) {
    const tag = uniqueNameTag();
    const guardian = await tempUser('GUARDIAN', { name: `${tag}g`, phone: null });
    const wards: TempUser[] = [];
    for (const suffix of ['x', 'y', 'z']) {
      const ward = await tempUser('WARD', { name: `${tag}${suffix}`, phone: null });
      connect(guardian.id, ward.id);
      wards.push(ward);
    }
    return { guardian, wards };
  }

  test('NOTI-N35 받은 알림 목록 조회와 안 읽은 수 표시', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const { guardian, wards } = await threeWards(tempUser);
    const g = await loginAs(guardian);
    for (const ward of wards) await sendSos((await loginAs(ward)).api);
    await waitForLog(guardian.id, 'WARD_SOS', 3);

    const unread = await g.api.get<{ count: number }>(`${INBOX}/unread-count`);
    expect(unread.count, '준비: API 안 읽은 수 3').toBe(3);

    const page = await openAs(g.who, '/guardian');
    await expect(menuButton(page)).toBeVisible();
    await expect(bellButton(page), '종 아이콘 이름에 안 읽은 알림 3개').toHaveAttribute('aria-label', '알림, 안 읽은 알림 3개');
    await bellButton(page).click();
    const panel = page.locator('#notification-inbox');
    await expect(panel).toBeVisible();
    const items = panel.locator('li');
    await expect(items, '목록 3건').toHaveCount(3);
    for (const ward of wards) {
      await expect(items.filter({ hasText: ward.name }), `${ward.name} 의 알림 1건`).toHaveCount(1);
    }
    await expect(items.filter({ hasText: '안 읽음' }), '3건 모두 안 읽음 표시').toHaveCount(3);
    await expect(panel.getByRole('button', { name: '모두 읽음' }), '안 읽은 알림이 있으니 모두 읽음 버튼은 켜져 있다').toBeEnabled();
  });

  test('NOTI-N36 알림을 읽으면 read_at 기록되고 안 읽은 수 감소', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const { guardian, wards } = await threeWards(tempUser);
    const g = await loginAs(guardian);
    for (const ward of wards) await sendSos((await loginAs(ward)).api);
    await waitForLog(guardian.id, 'WARD_SOS', 3);
    const rowOf = (wardId: string) => Number(psql(`SELECT id FROM notification_log WHERE recipient_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(wardId)};`));
    const target = wards[1];
    const targetId = rowOf(target.id);
    expect(readAtOf(targetId), '준비: 아직 안 읽음').toBe('');

    const page = await openAs(g.who, '/guardian');
    await expect(menuButton(page)).toBeVisible();
    await expect(bellButton(page)).toHaveAttribute('aria-label', '알림, 안 읽은 알림 3개');
    await bellButton(page).click();
    await page.locator('#notification-inbox li').filter({ hasText: target.name }).getByRole('button').click();

    await expect.poll(() => readAtOf(targetId), { timeout: 15_000, intervals: [500, 1_000], message: '알림을 열면 그 줄의 read_at 이 채워져야 한다' }).not.toBe('');
    expect(readAtOf(rowOf(wards[0].id)), '다른 알림은 그대로 안 읽음').toBe('');
    expect(readAtOf(rowOf(wards[2].id)), '다른 알림은 그대로 안 읽음').toBe('');
    expect((await g.api.get<{ count: number }>(`${INBOX}/unread-count`)).count, '안 읽은 수 3 -> 2').toBe(2);

    // 화면에서도 줄어든다: 보호자 홈으로 돌아가 종 아이콘 이름을 본다
    await page.goto('/guardian');
    await expect(bellButton(page), '종 아이콘 안 읽은 수 2').toHaveAttribute('aria-label', '알림, 안 읽은 알림 2개');
  });
});

test.describe('푸시 클릭 경로', () => {
  test('NOTI-N37 화재·복약 푸시 클릭 시 해당 화면으로 이동', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.info().annotations.push({
      type: '대체 확인',
      description: '헤드리스 브라우저에서는 알림 팝업을 실제로 누를 수 없다. 배포된 서비스 워커의 클릭 처리 연결(notificationclick -> push.getPath -> navigate/openWindow)과 이동 경로 규칙(/push-sw-logic.js 의 getPath)을 그대로 실행해 경로를 확인하고, 그 경로의 화면이 실제로 열리는지(리다이렉트 없음) 본다',
    });
    const api = await request.newContext({ baseURL: env.baseUrl });
    let logicSource = '';
    let swSource = '';
    try {
      const logic = await api.get('/push-sw-logic.js');
      expect(logic.status(), '/push-sw-logic.js 를 받을 수 있다').toBe(200);
      logicSource = await logic.text();
      const sw = await api.get('/firebase-messaging-sw.js');
      expect(sw.status(), '서비스 워커 파일을 받을 수 있다').toBe(200);
      swSource = await sw.text();
    } finally {
      await api.dispose();
    }

    await test.step('서비스 워커가 클릭을 이동 규칙으로 연결한다', async () => {
      expect(swSource, '규칙 파일을 읽어 온다').toContain("importScripts('/push-sw-logic.js')");
      const click = /addEventListener\('notificationclick'[\s\S]*?\n\}\);/.exec(swSource)?.[0] ?? '';
      expect(click, 'notificationclick 처리가 있다').not.toBe('');
      expect(click, '클릭 데이터로 경로를 구해').toContain('push.getPath(data, role, event.action)');
      expect(click, '열린 탭은 이동, 없으면 새 창').toMatch(/navigate\(targetUrl\)[\s\S]*openWindow\(targetUrl\)/);
    });

    const sandbox: { self: { SilverBridgePush?: { getPath: (data: Record<string, string>, role: string | null, action?: string) => string } } } = { self: {} };
    vm.runInNewContext(logicSource, sandbox);
    const push = sandbox.self.SilverBridgePush;
    expect(push, '이동 규칙 객체(SilverBridgePush)가 만들어진다').toBeTruthy();

    await test.step('경로 규칙: 화재(이상감지)·복약', async () => {
      expect(push!.getPath({ type: 'ANOMALY_DETECTED', detectedType: 'FIRE' }, 'GUARDIAN'), '화재 푸시 -> 이상감지(감지 이력) 화면').toBe('/guardian/detection');
      expect(push!.getPath({ type: 'ANOMALY_DETECTED', detectedType: 'FIRE', sessionId: 's1' }, 'GUARDIAN'), '세션이 있으면 그 세션').toBe('/guardian/detection?session=s1');
      expect(push!.getPath({ type: 'ANOMALY_DETECTED' }, 'WARD'), '피보호자가 받은 화재 푸시는 홈').toBe('/ward');
      expect(push!.getPath({ type: 'MEDICATION_REMINDER' }, 'WARD'), '복약 시각 푸시(피보호자) -> 복약 화면').toBe('/ward/medication');
      expect(push!.getPath({ type: 'MEDICATION_MISSED' }, 'GUARDIAN'), '미복용 요약 푸시(보호자) -> 복약 화면').toBe('/guardian/medication');
    });

    await test.step('그 화면이 실제로 열린다', async () => {
      const guardian = await tempUser('GUARDIAN');
      const ward = await tempUser('WARD');
      const [g, w] = [await loginAs(guardian), await loginAs(ward)];
      const gp = await openAs(g.who, '/guardian/detection');
      await expect(gp, '보호자 이상감지 화면이 열린다(로그인·홈으로 돌려보내지 않음)').toHaveURL(/\/guardian\/detection$/);
      await expect(menuButton(gp)).toBeVisible();
      const wp = await openAs(w.who, '/ward/medication');
      await expect(wp, '피보호자 복약 화면이 열린다').toHaveURL(/\/ward\/medication$/);
    });
  });
});
