/**
 * 최종 QA - SOS(CONN) P2: A14 N23 A24 A25.
 *
 * 임시 사용자만 쓴다. 보호자가 없는 피보호자(A14)나 전화번호·푸시 토큰이 없는 보호자(N23)만 쓰므로 실제 문자·푸시는 나가지 않는다.
 * SOS 이력 조회 케이스(A24·A25)는 알림이 나가지 않게 이력 행을 임시 피보호자 id 로 직접 만든다.
 */
import { expect, test } from '../../../src/fixtures';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { clearCooldown, cooldownExists, sosEvents, sosNotificationCount } from './_helpers-conn';
import { connectDaysAgo, insertSosEvents } from './_helpers-conn-p1a';
import { call, expectRes, notiRows, Res } from './_helpers-conn-p1b';
import { savedLocation, TAGS } from './_helpers-conn-p2';

const HISTORY = '/api/guardian/sos/history';
const NO_GROUP_KEYS = ['pressCount', 'firstTriggeredAt', 'lastTriggeredAt'];

interface HistItem {
  sosEventId: number;
  triggerType: string;
  pressCount?: number;
  firstTriggeredAt?: string;
  lastTriggeredAt?: string;
}
interface HistPage {
  content: HistItem[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
  counts: { all: number; sosButton: number; guardianCall: number };
}

function pageOf(res: Res): HistPage {
  return res.data as HistPage;
}

test.describe('CONN SOS P2', () => {
  test('CONN-A14 위치 100자 경계와 공백', TAGS, async ({ tempUser, loginAs }) => {
    await relaxAuthRates();
    // 보호자가 없는 피보호자: SOS 이력만 남고 알림은 나가지 않는다
    const ward = await tempUser('WARD', { phone: null });
    const w = await loginAs(ward);
    const send = (location: string | undefined) => call(w.api, 'POST', '/api/ward/sos', location === undefined ? {} : { location });

    try {
      await test.step('정확히 100자는 그대로 저장된다', async () => {
        const text = '가'.repeat(100);
        const res = await send(text);
        expectRes(res, 201, undefined, '100자');
        const saved = savedLocation(((res.data as { sosEventId: number }).sosEventId));
        expect(saved.length, '저장된 글자 수').toBe(100);
        expect(saved.location === text, '저장된 값이 보낸 글자 그대로').toBe(true);
      });

      await test.step('101자는 400 INVALID_INPUT 이고 이력이 남지 않는다', async () => {
        const before = sosEvents(ward.id);
        const res = await send('나'.repeat(101));
        expectRes(res, 400, 'INVALID_INPUT', '101자');
        expect(res.message, '안내 문구').toBe('위치는 100자를 초과할 수 없습니다.');
        expect(sosEvents(ward.id), '거절된 요청은 이력을 만들지 않는다').toBe(before);
      });

      await test.step('공백만 보내면 위치 모름(null)으로 저장된다', async () => {
        const res = await send('      ');
        expectRes(res, 201, undefined, '공백만');
        expect(savedLocation((res.data as { sosEventId: number }).sosEventId).location).toBe('<null>');
      });

      await test.step('앞뒤 공백을 합쳐 100자를 넘어도 공백을 뺀 길이가 100자면 통과하고 공백은 저장되지 않는다', async () => {
        const text = '다'.repeat(100);
        const res = await send(`   ${text}   `);
        expectRes(res, 201, undefined, '앞뒤 공백 + 100자');
        const saved = savedLocation((res.data as { sosEventId: number }).sosEventId);
        expect(saved.length, '저장된 글자 수').toBe(100);
        expect(saved.location === text, '앞뒤 공백이 없는 글자').toBe(true);
      });

      await test.step('중간의 연속 공백 처리를 실측해 기록한다(문서는 "추측·변환 없음")', async () => {
        const res = await send('가  나');
        expectRes(res, 201, undefined, '중간 공백 2칸');
        const saved = savedLocation((res.data as { sosEventId: number }).sosEventId).location;
        test.info().annotations.push({
          type: saved === '가  나' ? '실측: 중간 공백 그대로' : '문서-구현 차이',
          description: saved === '가  나'
            ? "중간의 연속 공백 2칸이 그대로 저장된다(문서의 '변환 없음'과 같음)"
            : `서버가 중간의 연속 공백을 줄여 저장한다(TextSanitizer). 보낸 '가  나'(공백 2칸) -> 저장 '${saved}'. 문서는 '추측·변환 없음'이라 적혀 있어 차이로 기록한다`,
        });
        expect(saved, 'TextSanitizer 가 중간의 연속 공백을 하나로 줄여 저장한다(구현 기준)').toBe('가 나');
      });

      await test.step('공백을 뺀 길이가 101자면 앞뒤 공백이 있어도 400', async () => {
        const before = sosEvents(ward.id);
        expectRes(await send(` ${'라'.repeat(101)} `), 400, 'INVALID_INPUT', '앞뒤 공백 + 101자');
        expect(sosEvents(ward.id)).toBe(before);
      });

      await test.step('위치를 보내지 않으면 위치 모름(null)으로 저장된다', async () => {
        const res = await send(undefined);
        expectRes(res, 201, undefined, '위치 없음');
        expect(savedLocation((res.data as { sosEventId: number }).sosEventId).location).toBe('<null>');
      });
    } finally {
      clearCooldown(ward.id);
    }
  });

  test('CONN-N23 group 없을 때 예전 응답과 같음, 푸시·쉬기와 별개', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connectDaysAgo(guardian.id, ward.id, 3);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);

    try {
      const ids: number[] = [];
      await test.step('피보호자가 SOS 를 연달아 3번 누른다', async () => {
        for (let i = 0; i < 3; i++) {
          const res = await call(w.api, 'POST', '/api/ward/sos', {});
          expectRes(res, 201, undefined, `SOS ${i + 1}`);
          ids.push((res.data as { sosEventId: number }).sosEventId);
        }
        expect(sosEvents(ward.id)).toBe(3);
        await expect.poll(() => sosNotificationCount(ward.id, guardian.id), { message: '보호자 알림 발송 기록이 생긴다', timeout: 30_000 }).toBeGreaterThan(0);
      });
      const newest = Math.max(...ids);
      // 알림 기록이 더 늘지 않을 때까지 기다린 뒤 값을 잡는다 (조회가 알림을 만들지 않는지 보려고)
      let notifications = -1;
      await expect
        .poll(
          () => {
            const now = sosNotificationCount(ward.id, guardian.id);
            const stable = now === notifications;
            notifications = now;
            return stable;
          },
          { message: '알림 기록 수가 더 늘지 않는다', timeout: 40_000, intervals: [3000] },
        )
        .toBe(true);
      clearCooldown(ward.id);
      const bodiesBefore = notiRows(guardian.id, 'WARD_SOS').map(r => r.body);

      await test.step('group 생략과 group=false 는 예전 응답 모양(세 칸 없음)이고 누른 횟수만큼 줄이 있다', async () => {
        for (const query of ['', '?group=false']) {
          const res = await call(g.api, 'GET', `${HISTORY}${query}`);
          expectRes(res, 200, undefined, `조회 ${query || '(group 생략)'}`);
          const data = pageOf(res);
          expect(data.content.map(item => item.sosEventId).sort((a, b) => a - b), `${query || '(group 생략)'}: 이력 3건`).toEqual([...ids].sort((a, b) => a - b));
          expect(data.totalElements, '누름 수').toBe(3);
          expect(data.counts.all, '전체 건수').toBe(3);
          for (const key of NO_GROUP_KEYS) {
            expect(res.text.includes(`"${key}"`), `${query || '(group 생략)'}: 응답 글자에 ${key} 칸이 없다`).toBe(false);
          }
        }
      });

      await test.step('group=true 는 한 줄로 묶고 세 칸이 생기며, 묶음 수가 건수가 된다', async () => {
        const res = await call(g.api, 'GET', `${HISTORY}?group=true`);
        expectRes(res, 200, undefined, 'group=true');
        const data = pageOf(res);
        expect(data.content, '한 줄').toHaveLength(1);
        expect(data.content[0].pressCount, '누른 횟수').toBe(3);
        expect(data.content[0].sosEventId, '묶음의 최신 건').toBe(newest);
        expect(typeof data.content[0].firstTriggeredAt, '첫 누름 시각').toBe('string');
        expect(typeof data.content[0].lastTriggeredAt, '마지막 누름 시각').toBe('string');
        expect(data.totalElements, '묶음 수').toBe(1);
        expect(data.counts.all, '묶음 수').toBe(1);
      });

      await test.step('보호자 대시보드의 latest 는 묶음 칸 없이 그대로다', async () => {
        const res = await call(g.api, 'GET', '/api/guardian/dashboard');
        expectRes(res, 200, undefined, '대시보드');
        const sos = (res.data as { sos: { count: number; latest: Record<string, unknown> } }).sos;
        expect(sos.latest.sosEventId, '가장 최근 SOS').toBe(newest);
        for (const key of NO_GROUP_KEYS) expect(key in sos.latest, `latest 에 ${key} 없음`).toBe(false);
      });

      await test.step('조회는 알림을 보내지도, 알림 쉬기(10초)를 걸지도 않는다', async () => {
        expect(sosNotificationCount(ward.id, guardian.id), '조회 뒤에도 알림 기록 수가 그대로').toBe(notifications);
        expect(cooldownExists(ward.id), '조회가 알림 쉬기 키를 만들지 않는다').toBe(false);
      });

      await test.step("묶음 조회는 보호자 알림 문구의 'N번째' 표기와 횟수 세기를 바꾸지 않는다", async () => {
        expect(notiRows(guardian.id, 'WARD_SOS').map(r => r.body), '조회 전후 보호자 알림 문구가 같다').toEqual(bodiesBefore);
        const res = await call(w.api, 'POST', '/api/ward/sos', {});
        expectRes(res, 201, undefined, '조회 뒤 4번째 SOS');
        await expect
          .poll(() => sosNotificationCount(ward.id, guardian.id), { message: '4번째 SOS 알림 기록이 생긴다', timeout: 30_000 })
          .toBe(notifications + 1);
        const newest = notiRows(guardian.id, 'WARD_SOS').at(-1)!;
        expect(newest.body, "묶음 조회와 무관하게 새 SOS 가 '4번째'로 세어진다").toContain('최근 10분 내 4번째');
      });
    } finally {
      clearCooldown(ward.id);
    }
  });

  test('CONN-A24 페이징 경계값과 ack 삭제 확인', TAGS, async ({ tempUser, loginAs }) => {
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connectDaysAgo(guardian.id, ward.id, 3);
    const eventIds = insertSosEvents(ward.id, [{ secondsAgo: 7200 }, { secondsAgo: 100 }, { secondsAgo: 90 }]); // 묶음 모드에서는 뒤의 둘(10초 간격)이 한 줄
    const g = await loginAs(guardian);

    for (const mode of ['', '&group=true']) {
      const label = mode ? '묶음 모드' : '묶음 없는 모드';
      await test.step(`${label}: size 는 1~50 으로 보정된다`, async () => {
        const expectedSize: Record<string, number> = { '0': 1, '-3': 1, '1': 1, '20': 20, '50': 50, '51': 50, '1000000': 50 };
        for (const [size, want] of Object.entries(expectedSize)) {
          const res = await call(g.api, 'GET', `${HISTORY}?size=${size}${mode}`);
          expectRes(res, 200, undefined, `${label} size=${size}`);
          expect(pageOf(res).size, `${label} size=${size} 의 적용 크기`).toBe(want);
          expect(pageOf(res).content.length, `${label} size=${size} 의 줄 수`).toBeLessThanOrEqual(want);
        }
      });

      await test.step(`${label}: 음수 page 는 0번째 페이지로 보정된다`, async () => {
        const res = await call(g.api, 'GET', `${HISTORY}?page=-4&size=2${mode}`);
        expectRes(res, 200, undefined, `${label} page=-4`);
        expect(pageOf(res).page).toBe(0);
        expect(pageOf(res).content.length, '첫 페이지에 줄이 있다').toBeGreaterThan(0);
      });

      await test.step(`${label}: page×size 가 int 범위를 넘어도 500 이 아니라 빈 페이지와 정확한 전체 건수`, async () => {
        for (const [size, lastPage] of [[20, Math.floor(2147483647 / 20)], [50, Math.floor(2147483647 / 50)]] as const) {
          const res = await call(g.api, 'GET', `${HISTORY}?page=2147483647&size=${size}${mode}`);
          expectRes(res, 200, undefined, `${label} page=2147483647 size=${size}`);
          const data = pageOf(res);
          expect(data.page, `${label} size=${size}: 마지막 가능 페이지로 보정`).toBe(lastPage);
          expect(data.content, `${label} size=${size}: 빈 페이지`).toEqual([]);
          expect(data.totalElements, `${label} size=${size}: 전체 건수는 그대로`).toBe(mode ? 2 : 3);
        }
      });

      await test.step(`${label}: int 로 담을 수 없는 page 글자는 400 INVALID_INPUT`, async () => {
        expectRes(await call(g.api, 'GET', `${HISTORY}?page=99999999999${mode}`), 400, 'INVALID_INPUT', `${label} page=99999999999`);
      });
    }

    await test.step('"처리했어요"(ack) API 는 없다: PATCH /api/guardian/sos/{id}/ack 는 404 API_NOT_FOUND', async () => {
      const res = await call(g.api, 'PATCH', `/api/guardian/sos/${eventIds[2]}/ack`);
      expectRes(res, 404, 'API_NOT_FOUND', 'ack');
    });
  });

  test('CONN-A25 연결 목록 로딩·실패 때 "피보호자 없음"이 안 보임', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const named = await tempUser('WARD', { name: '이름있는분', phone: null });
    const nameless = await tempUser('WARD', { name: '', phone: null });
    connectDaysAgo(guardian.id, named.id, 3);
    connectDaysAgo(guardian.id, nameless.id, 3);
    const g = await loginAs(guardian);
    const page = await openAs(g.who, null);
    const EMPTY = '연결된 피보호자가 없습니다.';
    const SELECT = '**/api/guardian/connection/select**';

    await test.step('연결 목록이 느리게 오는 동안은 로딩 안내만 보이고 "피보호자 없음"·0건 숫자는 없다', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      await page.route(SELECT, async route => {
        await gate;
        await route.continue();
      });
      await page.goto('/guardian/sos');
      await expect(page.getByText('피보호자 정보를 불러오는 중이에요.')).toBeVisible();
      await expect(page.getByText(EMPTY), '로딩 중에는 "피보호자 없음"이 보이지 않는다').toHaveCount(0);
      await expect(page.getByRole('tablist', { name: '발생 경로 필터' }), '로딩 중에는 0건 숫자 탭이 없다').toHaveCount(0);
      release();
      await expect(page.getByRole('tablist', { name: '발생 경로 필터' }), '목록이 오면 탭이 나온다').toBeVisible();
      await page.unroute(SELECT);
    });

    await test.step('연결 목록 요청이 실패하면 오류 안내와 [다시 불러오기]가 보이고 "피보호자 없음"은 없다', async () => {
      await page.route(SELECT, route => route.abort('failed'));
      await page.goto('/guardian/sos');
      const alert = page.getByRole('alert').filter({ hasText: '피보호자 정보를 불러오지 못했어요.' });
      await expect(alert).toBeVisible();
      await expect(page.getByText(EMPTY), '실패했을 때 "피보호자 없음"이 보이지 않는다').toHaveCount(0);
      await expect(page.getByRole('tablist', { name: '발생 경로 필터' }), '실패했을 때 0건 숫자 탭이 없다').toHaveCount(0);
      await page.unroute(SELECT);
      await alert.getByRole('button', { name: '다시 불러오기' }).click();
      await expect(page.getByRole('tablist', { name: '발생 경로 필터' }), '다시 불러오면 목록이 나온다').toBeVisible();
      await expect(alert).toHaveCount(0);
    });

    await test.step('이름이 빈 활성 피보호자는 "이름 없음"으로 보인다', async () => {
      const tabs = page.getByRole('tablist', { name: '피보호자 선택' });
      await expect(tabs.getByRole('tab', { name: /이름있는분/ })).toBeVisible();
      await expect(tabs.getByRole('tab'), '활성 피보호자 둘 모두 탭이 있다').toHaveCount(2);
      test.info().annotations.push({ type: '피보호자 탭 이름(실측)', description: (await tabs.getByRole('tab').allInnerTexts()).map(text => text.replace(/\s+/g, ' ').trim() || '(빈 글자)').join(' / ') });
      await expect(tabs.getByRole('tab', { name: /이름 없음/ }), '이름이 빈 피보호자 탭의 이름').toBeVisible({ timeout: 5_000 });
    });
  });
});
