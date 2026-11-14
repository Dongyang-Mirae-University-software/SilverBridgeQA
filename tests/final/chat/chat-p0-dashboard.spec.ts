/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P0: 보호자 홈 대시보드 (GET /api/guardian/dashboard)
 * 근거: BE 프로젝트_설명.txt 3-15 (2216-2238행), FE 배포본 a8666240 GuardianDashboardContent
 */
import { countBackendLog } from '../../../src/remote';
import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import { call, disconnectAsGuardian, sleep } from './_helpers-chat';

const TAGS = { tag: ['@P0', '@CHAT'] };

async function idorLogged(needle: string) {
  for (let i = 0; i < 4; i++) {
    if (countBackendLog(needle) > 0) return true;
    await sleep(1_500);
  }
  return false;
}

test.describe('CHAT P0 - 보호자 대시보드', () => {
  test.fixme('CHAT-N08 한 칸 조회 실패해도 전체는 200, 그 칸만 null', TAGS, async () => {
    // 이상감지·SOS·복약 조회 하나를 일부러 실패시킬 방법이 화면·API·허용된 DB 헬퍼에 없다(서버 설정·컨테이너·DB 쓰기 금지).
    // 기대값(200, 실패 칸 null, unavailable 에 칸 이름, total null, 500 아님)은 BE 단위 테스트(GuardianDashboardService)에서 확인한다.
    // 화면이 null 칸을 어떻게 그리는지는 CHAT-N09 에서 응답을 바꿔 확인한다.
  });

  test('CHAT-N09 실제 데이터 없으면 "이상 없음" 대신 "확인 불가" 표시', TAGS, async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const { who } = await loginAs(guardian);
    const isDashboard = (r: { url(): string; request(): { method(): string } }) =>
      r.url().includes('/api/guardian/dashboard') && r.request().method() === 'GET';
    const badgeSel = 'span[class*="attentionBadge"]';

    // 0) 대조군: 정상 응답이면 배지가 "지금 확인할 일이 없어요" 로 바뀐다 (아래 단언이 응답 값을 실제로 본다는 증거)
    const control = await openAs(who, null);
    const controlResp = control.waitForResponse(isDashboard);
    await control.goto('/guardian');
    expect((await controlResp).status()).toBe(200);
    await expect(control.locator(badgeSel)).toHaveText(/지금 확인할 일이 없어요/);

    // 1) 서버 응답의 이상감지 칸을 조회 실패(null) 로 바꿔서 연다
    const page = await openAs(who, null);
    await page.route('**/api/guardian/dashboard**', async route => {
      const response = await route.fetch();
      const body = await response.json();
      body.data.pendingActions = { total: null, anomaly: null, medication: body.data.pendingActions?.medication ?? 0 };
      body.data.anomalyDetection = null;
      body.data.wards = (body.data.wards ?? []).map((w: Record<string, unknown>) => ({ ...w, pendingCount: null }));
      body.data.unavailable = ['anomalyDetection'];
      await route.fulfill({ response, json: body });
    });
    const respSeen = page.waitForResponse(isDashboard);
    await page.goto('/guardian');
    await respSeen;
    await expect(page.getByRole('heading', { level: 1, name: '보호자 대시보드' })).toBeAttached();
    const badge = page.locator(badgeSel);
    await expect(badge).toBeVisible();
    // 응답이 화면에 반영될 때까지 기다린다: 정상 응답일 때 쓰는 확정 문구가 아니고, 잠시 지나도 바뀌지 않는다
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await expect(badge).not.toHaveText(/지금 확인할 일이 없어요/);
    // 확정 값이 아니라 "확인 불가" 가 보인다 ("확인 중" 은 불러오는 중 문구라 실패 표시로 인정하지 않는다)
    await expect.soft(badge, '조회 실패 칸은 "확인 불가" 로 그려야 한다 (로딩 문구 "확인 중" 과 구분)').toHaveText(/확인 불가/);
    const text = await page.locator('body').innerText();
    expect(text, '조회 실패 칸을 "이상 없음" 으로 그리면 안 된다').not.toContain('이상 없음');
    expect(text, '조회 실패 칸을 "확인할 일 없음" 으로 그리면 안 된다').not.toContain('지금 확인할 일이 없어요');
    expect(text).not.toMatch(/확인 필요 0건|확인이 필요한 일 0건/);
    await expect(page.getByRole('link', { name: /^AI 이상감지$/ })).toBeVisible();

    // 2) 대시보드 요청 자체가 실패하면 0건·"없음" 으로 그리지 않는다
    const page2 = await openAs(who, null);
    await page2.route('**/api/guardian/dashboard**', route => route.abort('failed'));
    const failedReq = page2.waitForEvent('requestfailed', { predicate: r => r.url().includes('/api/guardian/dashboard'), timeout: 15_000 });
    await page2.goto('/guardian');
    await failedReq;
    await page2.waitForLoadState('networkidle').catch(() => undefined);
    await expect(page2.locator(badgeSel)).toBeVisible();
    await expect.soft(page2.locator(badgeSel), '요청 실패는 "확인 불가"').toHaveText(/확인 불가/);
    expect(await page2.locator('body').innerText()).not.toContain('이상 없음');

    // 3) SOS·복약 칸이 조회 실패(unavailable)여도 0건 으로 그리지 않는다
    for (const field of ['sos', 'medication'] as const) {
      const p = await openAs(who, null);
      await p.route('**/api/guardian/dashboard**', async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.data[field === 'sos' ? 'sos' : 'medication'] = null;
        body.data.pendingActions = { ...(body.data.pendingActions ?? {}), total: null };
        body.data.unavailable = [field];
        await route.fulfill({ response, json: body });
      });
      const seen = p.waitForResponse(isDashboard);
      await p.goto('/guardian');
      await seen;
      await p.waitForLoadState('networkidle').catch(() => undefined);
      await expect(p.locator(badgeSel)).toBeVisible();
      await expect.soft(p.locator(badgeSel), `${field} 칸 조회 실패는 "확인 불가"`).toHaveText(/확인 불가/);
      expect(await p.locator('body').innerText(), `${field} 칸 실패를 확정 문구로 그리면 안 된다`).not.toContain('지금 확인할 일이 없어요');
    }
  });
  test('CHAT-A03 연결 안 된 남의 wardId 로 조회 (IDOR)', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const stranger = await tempUser('WARD'); // 연결 없음
    const { api } = await loginAs(guardian);

    const res = await call(api, 'GET', `/api/guardian/dashboard?wardId=${stranger.id}`);
    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('DASHBOARD_NOT_AUTHORIZED');
    expect(res.json?.data, '데이터가 같이 오면 안 된다').toBeUndefined();
    expect(res.text).not.toContain(stranger.name);
    expect(await idorLogged(`[IDOR-ATTEMPT] 연결되지 않은 피보호자 대시보드 조회 시도: guardianId=${guardian.id}`), '[IDOR-ATTEMPT] 로그').toBe(true);
  });

  test('CHAT-A04 연결 해제 뒤 같은 wardId 로 재조회', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const { api } = await loginAs(guardian);

    const before = await call(api, 'GET', `/api/guardian/dashboard?wardId=${ward.id}`);
    expect(before.status, '연결 중에는 200').toBe(200);
    expect(before.json.data.wards.map((w: { wardId: string }) => w.wardId)).toEqual([ward.id]);

    await disconnectAsGuardian(api, guardian.id, ward.id);

    const after = await call(api, 'GET', `/api/guardian/dashboard?wardId=${ward.id}`);
    expect(after.status).toBe(403);
    expect(after.json?.code).toBe('DASHBOARD_NOT_AUTHORIZED');
    // wardId 없이 불러도 해제된 피보호자는 합산에 없다
    const all = await call(api, 'GET', '/api/guardian/dashboard');
    expect(all.status).toBe(200);
    expect(all.json.data.wards).toEqual([]);
  });

  test('CHAT-A05 guardianId 파라미터를 붙여도 무시', TAGS, async ({ tempUser, loginAs }) => {
    const g1 = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD');
    const g2 = await tempUser('GUARDIAN');
    const w2 = await tempUser('WARD');
    connect(g1.id, w1.id);
    connect(g2.id, w2.id);
    const { api } = await loginAs(g1);

    const res = await call(api, 'GET', `/api/guardian/dashboard?guardianId=${g2.id}`);
    expect(res.status).toBe(200);
    const ids = res.json.data.wards.map((w: { wardId: string }) => w.wardId);
    expect(ids, '토큰 보호자(g1)의 피보호자만').toEqual([w1.id]);
    expect(res.text, '남의 피보호자 정보가 없다').not.toContain(w2.id);

    // guardianId 를 붙여도 남의 피보호자 wardId 는 여전히 막힌다
    const other = await call(api, 'GET', `/api/guardian/dashboard?guardianId=${g2.id}&wardId=${w2.id}`);
    expect(other.status).toBe(403);
    expect(other.json?.code).toBe('DASHBOARD_NOT_AUTHORIZED');
  });
});
