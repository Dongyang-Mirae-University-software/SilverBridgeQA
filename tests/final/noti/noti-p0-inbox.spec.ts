/**
 * 최종 QA - 알림(NOTI) P0 - 받은 알림 기록(종 아이콘)과 관리자 알림 이력
 *
 * 알림 이력 행은 전화번호·푸시 토큰이 없는 보호자에게 SOS 를 보내 만든다(전달 수단이 없어 FAILED 로 남고 외부 발송은 없다).
 * 받은 알림 API: /api/user/me/notifications (목록·unread-count·{id}/read·read-all), 코드 NOTIFICATION_NOT_OWNED 403.
 */
import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { connect, logoutViaProfile } from '../../../src/variables';
import { bellButton, bodyOf, fakeToken, fillLoginForm, menuButton, NOTI_TAGS, openMenu, sendSos, waitForLog } from './_helpers-noti';

const INBOX = '/api/user/me/notifications';

interface InboxItem { id: number; read: boolean; wardName: string | null }
interface Page { content: InboxItem[] }

function readAtOf(id: number) {
  return psql(`SELECT coalesce(read_at::text, '') FROM notification_log WHERE id = ${id};`);
}

test.describe('받은 알림 기록', () => {
  test('NOTI-A46 남의 알림을 읽음 처리·조회 시도(IDOR)', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    const a = await tempUser('GUARDIAN', { phone: null });
    const b = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(b.id, ward.id);
    const [ga, gb, w] = [await loginAs(a), await loginAs(b), await loginAs(ward)];

    await sendSos(w.api);
    const [row] = await waitForLog(b.id, 'WARD_SOS');
    const id = row.id;
    expect(readAtOf(id), '준비: B 의 알림은 아직 안 읽음').toBe('');
    expect((await gb.api.get<Page>(`${INBOX}?size=50`)).content.map(i => i.id), '준비: B 목록에 보인다').toContain(id);

    await test.step('A 가 B 의 알림 ID 로 읽음 처리 -> 403 NOTIFICATION_NOT_OWNED', async () => {
      const res = await ga.api.raw('POST', `${INBOX}/${id}/read`);
      const body = await bodyOf(res);
      expect(res.status(), JSON.stringify(body).slice(0, 150)).toBe(403);
      expect(body.code).toBe('NOTIFICATION_NOT_OWNED');
      expect(readAtOf(id), 'B 의 read_at 변화 없음').toBe('');
    });

    await test.step('A 의 목록·안 읽은 수에 B 의 알림이 섞이지 않고, 모두 읽음도 B 에게 영향 없음', async () => {
      const list = await ga.api.get<Page>(`${INBOX}?size=50`);
      expect(list.content.map(i => i.id)).not.toContain(id);
      const all = await ga.api.raw('POST', `${INBOX}/read-all`);
      expect(all.status()).toBe(200);
      expect(((await bodyOf(all)).data as { updated: number }).updated, 'A 는 받은 알림이 없어 0건').toBe(0);
      expect(readAtOf(id), 'read-all 뒤에도 B 의 알림은 그대로').toBe('');
      expect((await gb.api.get<{ count: number }>(`${INBOX}/unread-count`)).count, 'B 의 안 읽은 수 그대로').toBe(1);
    });

    await test.step('대조: B 본인은 읽음 처리할 수 있다', async () => {
      const own = await gb.api.raw('POST', `${INBOX}/${id}/read`);
      expect(own.status()).toBe(200);
      expect(readAtOf(id)).not.toBe('');
    });
  });

  test('NOTI-A51 로그아웃·계정 전환 뒤 이전 사용자의 알림 목록·팝업이 안 남음', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const first = await tempUser('GUARDIAN', { phone: null });
    const second = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(first.id, ward.id);
    const [f, w] = [await loginAs(first), await loginAs(ward)];
    await sendSos(w.api);
    await waitForLog(first.id, 'WARD_SOS');

    const page = await openAs(f.who, '/guardian');
    const bell = bellButton(page);
    const toasts = page.locator('[aria-live="polite"]').filter({ hasText: ward.name });

    await test.step('첫 사용자: 종 아이콘에 안 읽은 알림, 알림 목록에 피보호자 알림, 팝업(토스트)', async () => {
      await expect(menuButton(page)).toBeVisible();
      await expect(bell).toHaveAttribute('aria-label', /안 읽은 알림 1개/);
      await bell.click();
      await expect(page.locator('#notification-inbox')).toContainText(ward.name);
      await page.getByRole('button', { name: '알림 닫기' }).click();
      await page.evaluate(name => {
        window.dispatchEvent(new CustomEvent('careai:push', {
          detail: {
            data: { type: 'WARD_SOS', wardId: 'e2e000', wardName: name, sosEventId: `e2e-local-${Date.now()}` },
            notification: { title: '긴급 SOS', body: `${name}님이 긴급 도움을 요청했습니다.` },
          },
        }));
      }, ward.name);
      await expect(toasts.first()).toBeVisible();
    });

    await test.step('로그아웃하면 팝업이 사라진다', async () => {
      await openMenu(page);
      await logoutViaProfile(page, first.name);
      await expect.soft(toasts, '로그인 화면에 이전 사용자의 팝업이 남아 있다').toHaveCount(0);
    });

    await test.step('같은 브라우저로 다른 보호자가 로그인: 알림·팝업·안 읽은 수가 없다', async () => {
      // 공용 loginViaForm 은 모든 IP 의 속도 제한 키를 지우므로 쓰지 않고 폼을 직접 채운다
      await fillLoginForm(page, second.email, second.password);
      await expect(page).toHaveURL(/\/guardian$/);
      await expect(menuButton(page)).toBeVisible();
      await expect.soft(toasts, '다음 사용자 화면에 이전 사용자의 팝업이 보인다').toHaveCount(0);
      await expect.soft(bell, '다음 사용자에게 이전 사용자의 안 읽은 수가 보인다').toHaveAttribute('aria-label', '알림');
      await bell.click();
      const inbox = page.locator('#notification-inbox');
      await expect(inbox).toBeVisible();
      await expect(inbox.getByRole('status'), '불러오는 중 표시가 끝날 때까지').toHaveCount(0);
      await expect.soft(inbox, '다음 사용자 알림 목록에 이전 사용자의 알림이 보인다').not.toContainText(ward.name);
    });
  });
});

test.describe('관리자 알림 이력', () => {
  test('NOTI-A67 실패 사유는 정해진 코드만, 토큰·전화번호 원문 없음', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const admin = await tempUser('ADMIN');
    const ward = await tempUser('WARD');
    const noDevice = await tempUser('GUARDIAN', { phone: null }); // 토큰 없음·번호 없음
    const fakeDevice = await tempUser('GUARDIAN', { phone: null }); // 가짜 토큰만 있음
    connect(noDevice.id, ward.id);
    connect(fakeDevice.id, ward.id);
    const [ad, w, fd] = [await loginAs(admin), await loginAs(ward), await loginAs(fakeDevice)];
    const secretToken = fakeToken(fakeDevice.id, 'a67');
    await fd.api.post('/api/notifications/fcm-token', { token: secretToken, platform: 'WEB' });

    await sendSos(w.api);
    await waitForLog(noDevice.id, 'WARD_SOS');
    await waitForLog(fakeDevice.id, 'WARD_SOS');

    const ALLOWED = new Set([
      'NO_DEVICE', 'ALL_TOKENS_EXPIRED', 'PUSH_SERVER_ERROR', 'NO_PHONE', 'NO_EMAIL',
      'PROVIDER_REJECTED', 'PROVIDER_ERROR', 'RATE_LIMITED', 'UNEXPECTED_ERROR',
    ]);
    const mine = new Set([noDevice.id, fakeDevice.id]);
    const found = new Map<string, Record<string, any>[]>();
    for (const keyword of [noDevice.name, fakeDevice.name]) {
      const res = await ad.api.raw('GET', `/api/admin/notification?keyword=${encodeURIComponent(keyword)}&period=TODAY&size=50`);
      expect(res.status()).toBe(200);
      for (const item of ((await bodyOf(res)).data.content as Record<string, any>[]).filter(i => mine.has(i.recipientId))) {
        found.set(`${item.recipientId}:${item.id}`, [item]);
      }
    }
    const items = [...found.values()].map(v => v[0]);
    expect(items.length, '관리자 이력에서 두 보호자의 SOS 행을 찾아야 한다').toBeGreaterThanOrEqual(2);

    const reasons = new Set<string>();
    for (const item of items) {
      expect(item.result, '시도했지만 전달 수단이 없어 FAILED').toBe('FAILED');
      for (const c of item.channelResults as Record<string, unknown>[]) {
        expect(Object.keys(c).sort(), '채널 결과 칸은 정해진 것만').toEqual(['channel', 'reason', 'reasonLabel', 'status']);
        if (c.reason) {
          reasons.add(String(c.reason));
          expect(ALLOWED.has(String(c.reason)), `정해진 사유 코드가 아니다: ${String(c.reason)}`).toBe(true);
        }
      }
      const text = JSON.stringify(item);
      expect(text, '토큰 원문이 없다').not.toContain(secretToken);
      expect(text, '전화번호 모양(010...)이 없다').not.toMatch(/01[016789]-?\d{3,4}-?\d{4}/);
      expect(text, '예외 원문 표시가 없다').not.toMatch(/exception|stack|firebase|java\./i);
    }
    expect(reasons.has('NO_DEVICE'), '등록된 기기가 없는 보호자는 NO_DEVICE').toBe(true);
    expect(reasons.has('NO_PHONE'), '번호가 없는 보호자는 문자 대체 단계에서 NO_PHONE').toBe(true);
    test.info().annotations.push({ type: '나온 실패 사유', description: [...reasons].sort().join(', ') });
  });
});
