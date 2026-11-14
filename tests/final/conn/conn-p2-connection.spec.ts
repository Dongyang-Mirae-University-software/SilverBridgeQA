/**
 * 최종 QA - 연결(CONN) P2: A06 A10 A12.
 *
 * 임시 사용자만 쓴다. 임시 사용자에게는 푸시 토큰·전화번호가 없어 실제 푸시·문자는 나가지 않는다.
 * 화면 글자는 배포 FE(a8666240, v13) 기준이다: 피보호자 "내 가족"(/ward/guardians), 보호자 "연결된 가족"(/guardian/wards), "가족 등록"(/guardian/wards/register).
 * Redis 는 멈출 수 없어(공용 dev), 이 임시 쌍의 키 하나만 "다른 종류"로 바꿔 읽기 오류를 내는 방식으로 장애를 흉내 낸다.
 */
import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { redis, psql, sqlStr } from '../../../src/remote';
import { tokenCookies } from '../../../src/session';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { injectRedisFault, toastArea } from './_helpers-conn';
import { beLogLines } from './_helpers-conn-p1a';
import {
  call, clearConnRateKeys, clearCounter, connRows, connStatus, counterKey, counterValue, expectRes, watchWs,
} from './_helpers-conn-p1b';
import { insertActive, insertPending, pendingSection, poisonKey, REQUEST_API, TAGS } from './_helpers-conn-p2';

const NOT_PENDING_NOTICE = '이미 수락되었거나 거절된 요청이에요.';
const NOT_ACTIVE_NOTICE = '이미 연결이 해제됐어요.';

test.describe('CONN 연결 P2', () => {
  test('CONN-A06 Redis 장애 시 연결 요청 제한 없이 통과', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    await relaxAuthRates();
    const control = await tempUser('GUARDIAN', { phone: null });
    const controlWard = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const c = await loginAs(control);
    const g = await loginAs(guardian);
    const cleanups: (() => void)[] = [];

    /** 요청 한 건을 보내고(상태 코드·오류 코드), 만들어졌으면 바로 취소해 같은 쌍이 다시 요청할 수 있게 한다 */
    async function requestAndCancel(api: typeof c.api, guardianId: string, wardId: string) {
      const res = await call(api, 'POST', REQUEST_API, { targetId: wardId, relation: '딸' });
      if (res.status === 200) {
        const row = connRows(guardianId, wardId).at(-1);
        expect(row?.status, '요청이 만들어졌으면 수락 대기').toBe('PENDING');
        expectRes(await call(api, 'DELETE', `/api/guardian/connection/cancel/${row!.id}`), 200, undefined, '요청 취소');
      }
      return { status: res.status, code: res.code };
    }

    try {
      await test.step('대조: 장애가 없으면 같은 쌍의 6번째 요청부터 429 CONNECTION_REQUEST_COOLDOWN', async () => {
        const results = [];
        for (let i = 0; i < 6; i++) results.push(await requestAndCancel(c.api, control.id, controlWard.id));
        expect(results.slice(0, 5).map(r => r.status), '1~5번째 요청').toEqual([200, 200, 200, 200, 200]);
        expect(results[5], '6번째 요청').toEqual({ status: 429, code: 'CONNECTION_REQUEST_COOLDOWN' });
        expect(counterValue(control.id, controlWard.id), '5건이 센 값').toBe('5');
      });

      await test.step('장애 대역: 이 쌍의 횟수 키를 못 읽게 하면 7번 요청해도 모두 통과한다(fail-open)', async () => {
        // 경고 줄에는 사용자 id 가 없어 이 쌍만 걸러낼 수 없다. 그래서 장애를 넣기 직전의 줄 수를 세어 두고 "7건 이상 늘었는지"를 본다
        const warnCount = () => beLogLines(['[CONN-REQUEST-LIMIT-REDIS-DOWN]'], 900, 5000).length;
        const warnBefore = warnCount();
        cleanups.push(poisonKey(counterKey(guardian.id, ward.id)));
        const results = [];
        for (let i = 0; i < 7; i++) results.push(await requestAndCancel(g.api, guardian.id, ward.id));
        expect(results.map(r => r.status), '7번 모두 200').toEqual([200, 200, 200, 200, 200, 200, 200]);
        expect(connRows(guardian.id, ward.id).length, '요청 행이 7건 만들어졌다').toBe(7);
        await expect
          .poll(() => warnCount() - warnBefore, { message: `BE 가 제한 생략(fail-open) 경고를 7번 요청분만큼 새로 남긴다(장애 전 ${warnBefore}줄)`, timeout: 20_000, intervals: [1000, 2000] })
          .toBeGreaterThanOrEqual(7);
      });

      await test.step('같은 장애 상황에서 인증 저장소를 읽는 다른 API 는 503 SERVICE_UNAVAILABLE', async () => {
        expect((await g.api.raw('GET', '/api/guardian/connection/select')).status(), '장애 전에는 정상').toBe(200);
        cleanups.push(injectRedisFault(guardian.id));
        const res = await call(g.api, 'GET', '/api/guardian/connection/select');
        expectRes(res, 503, 'SERVICE_UNAVAILABLE', '연결 목록');
      });
    } finally {
      for (const undo of cleanups.reverse()) undo();
      clearCounter(guardian.id, ward.id);
      clearCounter(control.id, controlWard.id);
      clearConnRateKeys(guardian.id);
      clearConnRateKeys(control.id);
    }
  });

  test('CONN-A10 이미 처리·취소된 요청을 다시 수락·취소', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { name: '이처리', phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    try {
      // 취소·해제 신호는 화면에 전달하지 않는다: 화면이 낡은 목록을 들고 있는 상태에서 오류 뒤 다시 불러오는지 보려는 것이다
      const wardPage = await openAs(w.who, null);
      const wsFrames = await watchWs(wardPage, { drop: /connection-request-cancelled|connection-cancelled/ });
      await wardPage.goto('/ward/guardians');
      await waitForRealtime(wardPage);

      const card = wardPage.getByRole('listitem').filter({ hasText: guardian.name });
      const feedbackClose = wardPage.getByRole('button', { name: '확인', exact: true });

      async function sendRequest(): Promise<number> {
        expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, '요청');
        const row = connRows(guardian.id, ward.id).at(-1)!;
        expect(row.status).toBe('PENDING');
        await expect(card, '피보호자 화면에 요청 카드가 뜬다').toBeVisible();
        return row.id;
      }

      await test.step('취소된 요청을 수락: 409 CONNECTION_NOT_PENDING, 안내 후 요청 카드가 목록에서 빠진다', async () => {
        const id = await sendRequest();
        expectRes(await call(g.api, 'DELETE', `/api/guardian/connection/cancel/${id}`), 200, undefined, '보호자 취소');
        await expect.poll(() => connStatus(id)).toBe('CANCELLED');
        test.info().annotations.push({ type: 'A10 진단(받은 신호 주소)', description: wsFrames.map(f => /^destination:(.*)$/m.exec(f)?.[1]?.trim() ?? f.slice(0, 12)).join(' , ') });
        await expect(card, '준비: 취소 신호를 막았으니 화면에는 아직 남아 있다').toBeVisible();
        // 보호자가 같은 요청을 다시 취소해도 같은 오류
        expectRes(await call(g.api, 'DELETE', `/api/guardian/connection/cancel/${id}`), 409, 'CONNECTION_NOT_PENDING', '취소를 다시 취소');

        const failed = wardPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/api/ward/connection/${id}/accept`));
        await card.getByRole('button', { name: '수락', exact: true }).click();
        const res = await failed;
        expect(res.status(), '취소된 요청 수락').toBe(409);
        expect((await res.json()).code).toBe('CONNECTION_NOT_PENDING');
        await expect(wardPage.getByText('요청 수락 실패')).toBeVisible();
        await expect(wardPage.getByText(NOT_PENDING_NOTICE)).toBeVisible();
        await feedbackClose.click();
        await expect(card, '오류 뒤 목록을 다시 불러와 요청 카드가 사라진다').toHaveCount(0);
        expect(connStatus(id), '취소 상태는 그대로').toBe('CANCELLED');
      });

      await test.step('이미 거절한 요청을 다시 거절: 409 CONNECTION_NOT_PENDING, 안내 후 카드가 빠진다', async () => {
        const id = await sendRequest();
        // 같은 피보호자가 다른 경로(API)로 먼저 거절한다 - 거절 신호는 보호자에게만 가므로 이 화면은 낡은 목록을 들고 있다
        expectRes(await call(w.api, 'DELETE', `/api/ward/connection/request/${id}/refusal`), 200, undefined, '먼저 거절');
        await expect.poll(() => connStatus(id)).toBe('REFUSED');
        await expect(card, '준비: 화면에는 아직 남아 있다').toBeVisible();

        const failed = wardPage.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/api/ward/connection/request/${id}/refusal`));
        await card.getByRole('button', { name: '거절', exact: true }).click();
        const res = await failed;
        expect(res.status(), '거절된 요청 재거절').toBe(409);
        expect((await res.json()).code).toBe('CONNECTION_NOT_PENDING');
        await expect(wardPage.getByText('요청 거절 실패')).toBeVisible();
        await expect(wardPage.getByText(NOT_PENDING_NOTICE)).toBeVisible();
        await feedbackClose.click();
        await expect(card, '오류 뒤 목록을 다시 불러와 요청 카드가 사라진다').toHaveCount(0);
      });

      await test.step('이미 해제된 연결을 다시 해제: 409 CONNECTION_NOT_ACTIVE, 안내 후 연결 줄이 빠진다', async () => {
        const id = await sendRequest();
        await card.getByRole('button', { name: '수락', exact: true }).click();
        await expect(wardPage.getByText('요청 수락 완료')).toBeVisible();
        await feedbackClose.click();
        expect(connStatus(id)).toBe('ACTIVE');
        await expect(card, '연결된 보호자 줄').toBeVisible();

        // 보호자가 먼저 해제한다 - 해제 신호는 막았으니 피보호자 화면에는 아직 남아 있다
        expectRes(await call(g.api, 'DELETE', `/api/guardian/connection/disconnection/${id}`), 200, undefined, '보호자 해제');
        await expect.poll(() => connStatus(id)).toBe('DISCONNECTED');
        await expect(card, '준비: 화면에는 아직 남아 있다').toBeVisible();
        // 보호자가 같은 연결을 다시 해제해도 같은 오류
        expectRes(await call(g.api, 'DELETE', `/api/guardian/connection/disconnection/${id}`), 409, 'CONNECTION_NOT_ACTIVE', '해제를 다시 해제');

        await card.getByRole('button', { name: '연결 끊기' }).click();
        const failed = wardPage.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/api/ward/connection/disconnection/${id}`));
        await wardPage.getByRole('button', { name: '끊기', exact: true }).click();
        const res = await failed;
        expect(res.status(), '해제된 연결 재해제').toBe(409);
        expect((await res.json()).code).toBe('CONNECTION_NOT_ACTIVE');
        await expect(wardPage.getByText('연결 해제 실패')).toBeVisible();
        await expect(wardPage.getByText(NOT_ACTIVE_NOTICE)).toBeVisible();
        await feedbackClose.click();
        await expect(card, '오류 뒤 목록을 다시 불러와 연결 줄이 사라진다').toHaveCount(0);
        await expect(wardPage.getByText('아직 연결된 가족이 없어요')).toBeVisible();
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearConnRateKeys(guardian.id);
    }
  });

  test('CONN-A12 연결 요청 안내 표시 정확성(4건 이상·한국 날짜·탭 직접 진입)', TAGS, async ({ tempUser, loginAs, openAs, browser }) => {
    test.setTimeout(240_000);
    await relaxAuthRates();
    const ward = await tempUser('WARD', { phone: null });
    const senders = [] as Awaited<ReturnType<typeof loginAs>>[];
    for (let i = 1; i <= 4; i++) senders.push(await loginAs(await tempUser('GUARDIAN', { name: `요청자${i}`, phone: null })));
    const w = await loginAs(ward);

    const wardPage = await openAs(w.who, null);
    const area = toastArea(wardPage);
    try {
      await test.step('피보호자에게 요청이 4건 쌓이면 받은 요청 목록에는 4건 모두 수락·거절할 수 있게 남는다', async () => {
        await wardPage.goto('/ward');
        await waitForRealtime(wardPage);
        for (const [i, s] of senders.entries()) {
          expectRes(await call(s.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, `요청 ${i + 1}`);
          await expect(area.getByRole('button', { name: '수락', exact: true }), `요청 ${i + 1}건째 직후 화면 알림의 수락 버튼`).toHaveCount(Math.min(i + 1, 3));
        }
        expect(Number(psql(`SELECT count(*) FROM connection WHERE ward_id = ${sqlStr(ward.id)} AND status = 'PENDING';`)), '준비: 요청 4건이 모두 수락 대기').toBe(4);

        // 받은 요청 목록(다른 화면)에는 4건이 다 있어야 한다
        const listPage = await openAs(w.who, '/ward/guardians');
        const list = listPage.getByRole('list', { name: '받은 연결 요청' });
        await expect(list.getByRole('listitem'), '받은 요청 목록 4건').toHaveCount(4);
        await expect(list.getByRole('button', { name: '수락', exact: true })).toHaveCount(4);
        await expect(list.getByRole('button', { name: '거절', exact: true })).toHaveCount(4);
      });

      await test.step('다른 보호자 화면: 연결된 가족·가족 등록 화면에 바로 들어가도 연결 인원·대기 수가 정확하다', async () => {
        test.info().annotations.push({
          type: '해당 없음(v13)',
          description: "케이스의 '등록·이력 탭 URL 직접 진입'은 v13 FE 에 탭이 없어 해당 없음이다(FE a8666240 에 tab 파라미터 처리 없음). '?tab=register' 는 효과 없는 주소라 목록 화면만 열리고, '이력' 탭 진입은 다루지 않는다",
        });
        const guardian = await tempUser('GUARDIAN', { name: '직접진입', phone: null });
        const wardA = await tempUser('WARD', { phone: null });
        const wardB = await tempUser('WARD', { phone: null });
        const wardC = await tempUser('WARD', { phone: null });
        insertActive(guardian.id, wardA.id);
        insertPending(guardian.id, wardB.id, '아들');
        insertPending(guardian.id, wardC.id, '딸');
        const gl = await loginAs(guardian);

        const listPage = await openAs(gl.who, '/guardian/wards?tab=register');
        await expect(listPage.getByRole('heading', { level: 1, name: '연결된 가족' })).toBeVisible();
        await expect(listPage.getByText('1명', { exact: true }), '연결된 가족 인원 수').toBeVisible();
        await expect(listPage.getByRole('list', { name: '연결된 가족' }).getByText('수락을 기다리는 중'), '대기 카드 2건').toHaveCount(2);

        const registerPage = await openAs(gl.who, '/guardian/wards/register');
        await expect(pendingSection(registerPage).getByRole('listitem'), '가족 등록 화면의 수락 대기 목록').toHaveCount(2);
      });

      await test.step('요청일은 해외 시간대 브라우저에서도 한국 날짜(2026-09-30 00:30 KST -> 9월 30일)로 같게 보인다', async () => {
        const guardian = await tempUser('GUARDIAN', { name: '날짜확인', phone: null });
        const dateWard = await tempUser('WARD', { phone: null });
        insertPending(guardian.id, dateWard.id, '딸', '2026-09-30 00:30:00+09');
        const gl = await loginAs(guardian);
        const dl = await loginAs(dateWard);
        const seen: Record<string, string> = {};
        const rawList = await call(gl.api, 'GET', '/api/guardian/connection/select');
        const rawCreatedAt = String((rawList.data as { createdAt?: string }[] | undefined)?.[0]?.createdAt ?? '(없음)');
        test.info().annotations.push({ type: 'API 요청일 원문 형식', description: `createdAt 의 시각대 표기: ${rawCreatedAt.replace(/^[^T]*T[\d:.]+/, '') || '(시각대 없음)'}` });

        for (const timezoneId of ['Asia/Seoul', 'America/Los_Angeles']) {
          const context = await browser.newContext({
            ...contextDefaults,
            timezoneId,
            storageState: { cookies: tokenCookies(gl.login), origins: [] },
          });
          const wardContext = await browser.newContext({
            ...contextDefaults,
            timezoneId,
            storageState: { cookies: tokenCookies(dl.login), origins: [] },
          });
          try {
            await context.addInitScript(installPageStubs(), pageStubArg);
            await wardContext.addInitScript(installPageStubs(), pageStubArg);
            const guardianPage = await context.newPage();
            await guardianPage.goto('/guardian/wards');
            const pendingCard = guardianPage.getByRole('list', { name: '연결된 가족' }).getByRole('listitem').filter({ hasText: '수락을 기다리는 중' });
            await expect(pendingCard).toBeVisible();
            seen[`보호자 ${timezoneId}`] = (await pendingCard.innerText()).replace(/\s+/g, ' ');
            await expect.soft(pendingCard, `${timezoneId} 보호자 화면의 요청일(KST 9월 30일이어야 한다)`).toContainText('딸로 요청 · 9월 30일', { timeout: 5_000 });

            const wardPage = await wardContext.newPage();
            await wardPage.goto('/ward/guardians');
            const received = wardPage.getByRole('list', { name: '받은 연결 요청' }).getByRole('listitem');
            await expect(received).toBeVisible();
            seen[`피보호자 ${timezoneId}`] = (await received.innerText()).replace(/\s+/g, ' ');
            await expect.soft(received, `${timezoneId} 피보호자 화면의 요청일(KST 9월 30일이어야 한다)`).toContainText('9월 30일에 연결을 요청했어요', { timeout: 5_000 });
          } finally {
            await wardContext.close();
            await context.close();
          }
        }
        test.info().annotations.push({
          type: '요청일 표시(실측)',
          description: Object.entries(seen).map(([where, text]) => `${where}: ${(/\d+월 \d+일/.exec(text) ?? ['날짜 없음'])[0]}`).join(' / '),
        });
      });

      await test.step("화면 알림은 가려진 요청 건수를 'N건 더 있음'으로 알려 준다(4건 중 3개만 남을 때)", async () => {
        // 화면 알림(토스트)은 3개로 줄어도 가려진 건수를 'N건 더 있음'으로 알려야 한다 (4건 중 3개가 남으니 "1건 더")
        test.info().annotations.push({
          type: '문서-화면 차이',
          description: "케이스 기대값은 화면 알림이 가려진 건수를 'N건 더 있음'으로 알려 주는 것이다. 배포 FE 는 알림을 최대 3개로 자르고(PushNotificationListener.tsx addToast slice(0, 3)) 건수 안내 문구가 없다",
        });
        await expect(area.getByRole('button', { name: '수락', exact: true }), '화면 알림에 남은 수락 버튼').toHaveCount(3);
        await expect(area.getByText(/1\s*건\s*더/), "가려진 1건을 알리는 'N건 더 있음' 안내").toBeVisible({ timeout: 5_000 });
      });
    } finally {
      for (const s of senders) {
        clearCounter(s.user.id, ward.id);
        clearConnRateKeys(s.user.id);
      }
    }
  });
});
