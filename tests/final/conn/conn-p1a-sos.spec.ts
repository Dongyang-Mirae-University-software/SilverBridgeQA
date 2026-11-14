/**
 * 최종 QA - SOS(CONN) P1a: A26 A27 N25 A23 N21 N22 A15 A16 A18 A21 N16.
 *
 * 임시 사용자만 쓴다. 보호자에게 전화번호가 없으면(phone: null) 푸시·문자가 모두 못 가므로 실제 문자는 나가지 않는다.
 * SOS 이력 조회 케이스(N21·N22)는 알림이 나가지 않게 이력 행을 임시 피보호자 id 로 직접 만든다.
 */
import { env } from '../../../src/env';
import { expect, modal, test, waitForRealtime } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import { connect, suppressSosNotify } from '../../../src/variables';
import { relaxAuthRates } from '../auth/_helpers-auth';
import {
  clearCooldown, logLineCount, pressSosV13, read, sosEvents, sosHeroButton, sosNotificationCount, sosNotificationLogs, toastArea,
} from './_helpers-conn';
import {
  beLogLines, captureFrames, connectDaysAgo, insertSosEvent, insertSosEvents, rawCall, TAGS,
} from './_helpers-conn-p1a';

const WARD_SETTINGS_KEY = 'silverbridge_ward_settings';
const SETTING_PATH = '/api/ward/sos-setting';

type Api = { raw: (m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string, d?: unknown) => Promise<import('@playwright/test').APIResponse> };

interface HistItem {
  sosEventId: number;
  wardId: string | null;
  wardName?: string | null;
  triggeredAt: string;
  location?: string | null;
  triggerType: string;
  calledGuardianName?: string;
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

async function history(api: Api, query = ''): Promise<HistPage> {
  const r = await read(await api.raw('GET', `/api/guardian/sos/history${query}`));
  expect(r.status, `SOS 이력 조회 ${query}`).toBe(200);
  return r.body.data as HistPage;
}

async function postSos(api: Api, data: unknown = {}, expected = 201) {
  const r = await read(await api.raw('POST', '/api/ward/sos', data));
  expect(r.status, 'SOS 전송 상태 코드').toBe(expected);
  return r.body.data as { sosEventId: number; triggeredAt: string };
}

test.describe('CONN SOS P1a', () => {
  test('CONN-A26 설정 API 권한·잘못된 값·동시 최초 저장', TAGS, async ({ tempUser, loginAs }) => {
    const ward = await tempUser('WARD');
    const guardian = await tempUser('GUARDIAN');
    const admin = await tempUser('ADMIN');
    const w = await loginAs(ward);
    const g = await loginAs(guardian);
    const a = await loginAs(admin);

    await test.step('무로그인은 401', async () => {
      for (const method of ['GET', 'PUT'] as const) {
        const r = await rawCall(method, SETTING_PATH, method === 'PUT' ? { sosAction: 'CALL_119' } : undefined);
        expect(r.status, `무로그인 ${method}`).toBe(401);
      }
    });

    await test.step('보호자·관리자 토큰은 403 (피보호자 전용)', async () => {
      for (const [label, who] of [['보호자', g], ['관리자', a]] as const) {
        expect((await who.api.raw('GET', SETTING_PATH)).status(), `${label} GET`).toBe(403);
        expect((await who.api.raw('PUT', SETTING_PATH, { sosAction: 'CALL_119' })).status(), `${label} PUT`).toBe(403);
      }
      expect(psql(`SELECT count(*) FROM sos_setting WHERE user_id = ${sqlStr(guardian.id)};`), '보호자 행이 생기면 안 된다').toBe('0');
    });

    await test.step('허용 외 값(빈 값 포함)은 400 이고 행이 생기지 않는다', async () => {
      const bad: unknown[] = ['', ' ', 'CALL_911', 'call_119', 'NOTIFY_GUARDIAN', true, null, ['CALL_119'], {}];
      for (const value of bad) {
        const res = await w.api.raw('PUT', SETTING_PATH, { sosAction: value });
        expect(res.status(), `sosAction=${JSON.stringify(value)}`).toBe(400);
      }
      expect((await w.api.raw('PUT', SETTING_PATH, {})).status(), 'sosAction 필드 없음').toBe(400);
      expect(psql(`SELECT count(*) FROM sos_setting WHERE user_id = ${sqlStr(ward.id)};`), '잘못된 값으로 행이 생기면 안 된다').toBe('0');
      const got = await read(await w.api.raw('GET', SETTING_PATH));
      expect((got.body.data as { sosAction: string }).sosAction, '행이 없으면 기본값').toBe('CALL_119_AND_NOTIFY');
    });

    await test.step('숫자 값(열거형 순서 번호)도 허용 외 값이라 400 이고 행이 생기지 않는다', async () => {
      for (const value of [0, 1, 2]) {
        const res = await w.api.raw('PUT', SETTING_PATH, { sosAction: value });
        expect.soft(res.status(), `sosAction=${value}(숫자)은 허용 외 값이라 400`).toBe(400);
      }
      expect.soft(psql(`SELECT count(*) FROM sos_setting WHERE user_id = ${sqlStr(ward.id)};`), '숫자 값으로 행이 생기면 안 된다').toBe('0');
    });

    await test.step('참고: 값 끝에 공백이 붙은 경우(관찰만, 문서가 정하지 않음 - 기획 확인 필요)', async () => {
      const res = await w.api.raw('PUT', SETTING_PATH, { sosAction: 'CALL_119 ' });
      test.info().annotations.push({
        type: '관찰',
        description: `sosAction="CALL_119 "(끝 공백) -> ${res.status()}. 문서에 없는 입력이라 단언하지 않았다. 기획 확인 필요.`,
      });
    });

    await test.step('행이 없을 때 첫 저장을 동시에 두 번 보내도 둘 다 200, 행은 1개', async () => {
      for (let round = 1; round <= 3; round++) {
        const fresh = await tempUser('WARD');
        const f = await loginAs(fresh);
        const [r1, r2] = await Promise.all([
          f.api.raw('PUT', SETTING_PATH, { sosAction: 'CALL_119' }),
          f.api.raw('PUT', SETTING_PATH, { sosAction: 'CALL_119' }),
        ]);
        expect(r1.status(), `${round}회차 첫 번째 요청`).toBe(200);
        expect(r2.status(), `${round}회차 두 번째 요청`).toBe(200);
        expect(psql(`SELECT count(*) FROM sos_setting WHERE user_id = ${sqlStr(fresh.id)};`), `${round}회차 행 수`).toBe('1');
        const saved = psql(`SELECT sos_action FROM sos_setting WHERE user_id = ${sqlStr(fresh.id)};`);
        expect(saved, `${round}회차 저장된 값은 보낸 값(CALL_119)`).toBe('CALL_119');
      }
    });
  });

  test('CONN-A27 브라우저 저장 설정이 깨져도 화면이 열림', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(150_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const w = await loginAs(ward);
    expect((await w.api.raw('PUT', SETTING_PATH, { sosAction: 'NOTIFY_GUARDIAN_FIRST' })).status()).toBe(200);
    // SOS 가 실제로 나가도 보호자 알림은 억제해 둔다(이력은 남는다)
    suppressSosNotify(ward.id);

    const scenarios: { label: string; init: () => void }[] = [
      {
        label: '저장된 JSON 이 깨짐',
        init: () => window.localStorage.setItem('silverbridge_ward_settings', '{"fontSize":17,"sosAction":'),
      },
      {
        label: '저장소 읽기가 오류를 냄(접근 차단)',
        init: () => {
          Storage.prototype.getItem = () => {
            throw new DOMException('storage blocked', 'SecurityError');
          };
        },
      },
    ];

    try {
      for (const scenario of scenarios) {
        await test.step(scenario.label, async () => {
          const page = await openAs(w.who, null);
          await page.addInitScript(scenario.init);
          const posts: string[] = [];
          page.on('response', r => {
            if (r.request().method() === 'POST' && r.url().endsWith('/api/ward/sos')) posts.push(String(r.status()));
          });
          await page.goto('/ward/sos');
          // 화면이 열려야 한다 (서버 값으로 표시)
          await expect.soft(sosHeroButton(page), `[${scenario.label}] SOS 화면의 버튼이 보여야 한다`).toBeVisible({ timeout: 20_000 });
          if (!(await sosHeroButton(page).isVisible())) return;
          if (scenario.label.startsWith('저장된 JSON')) {
            await expect
              .poll(() => page.evaluate(key => {
                try {
                  return (JSON.parse(window.localStorage.getItem(key) ?? '{}') as { sosAction?: string }).sosAction;
                } catch {
                  return 'parse-error';
                }
              }, WARD_SETTINGS_KEY), { message: '서버 값(NOTIFY_GUARDIAN_FIRST)으로 덮어써진다', timeout: 20_000 })
              .toBe('NOTIFY_GUARDIAN_FIRST');
          }
          const posted = await pressSosV13(page);
          expect.soft(posted, `[${scenario.label}] SOS 요청이 나가야 한다`).not.toBeNull();
          expect.soft(posted?.status(), `[${scenario.label}] SOS 응답`).toBe(201);
        });
      }
    } finally {
      clearCooldown(ward.id);
    }
  });

  test('CONN-N25 SOS 동작 설정 기본값·저장·기기 간 동일', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(150_000);
    const ward = await tempUser('WARD');
    const w = await loginAs(ward);
    const count = () => Number(psql(`SELECT count(*) FROM sos_setting WHERE user_id = ${sqlStr(ward.id)};`));
    const getValue = async (api: Api) => {
      const r = await read(await api.raw('GET', SETTING_PATH));
      expect(r.status).toBe(200);
      return (r.body.data as { sosAction: string }).sosAction;
    };

    await test.step('행이 없으면 기본값 CALL_119_AND_NOTIFY, 조회만으로 행이 생기지 않는다', async () => {
      expect(await getValue(w.api)).toBe('CALL_119_AND_NOTIFY');
      expect(count()).toBe(0);
    });

    await test.step('세 값을 차례로 저장: 응답이 그 값이고 행은 계속 1개(upsert)', async () => {
      for (const value of ['CALL_119', 'NOTIFY_GUARDIAN_FIRST', 'CALL_119_AND_NOTIFY']) {
        const r = await read(await w.api.raw('PUT', SETTING_PATH, { sosAction: value }));
        expect(r.status, `${value} 저장`).toBe(200);
        expect((r.body.data as { sosAction: string }).sosAction, `${value} 응답`).toBe(value);
        expect(count(), `${value} 저장 뒤 행 수`).toBe(1);
        expect(psql(`SELECT sos_action FROM sos_setting WHERE user_id = ${sqlStr(ward.id)};`)).toBe(value);
      }
    });

    await test.step('다른 기기(새 로그인)에서도 같은 값', async () => {
      expect((await w.api.raw('PUT', SETTING_PATH, { sosAction: 'NOTIFY_GUARDIAN_FIRST' })).status()).toBe(200);
      const other = await loginAs(ward);
      expect(await getValue(other.api), '새 로그인에서 조회한 값').toBe('NOTIFY_GUARDIAN_FIRST');

      // 기기 저장소가 비어 있는 새 브라우저에서도 서버 값으로 라디오가 선택돼 있다
      const page = await openAs(other.who, '/ward/settings');
      await page.getByRole('tab', { name: 'SOS 동작' }).click();
      const group = page.getByRole('radiogroup', { name: 'SOS 동작 설정' });
      await expect(group).toBeVisible();
      const first = group.getByRole('radio', { name: /119 화면 바로 열기/ });
      const second = group.getByRole('radio', { name: /보호자 알림 먼저/ });
      await expect(second, '서버 값(보호자 알림 먼저)이 선택돼 있다').toBeChecked({ timeout: 20_000 });
      await expect(first).not.toBeChecked();

      await test.step('키보드·스크린리더로 선택 가능: 라디오가 화면에 보이고 포커스·스페이스로 고를 수 있다', async () => {
        await expect(first, '라디오 입력이 숨겨지지 않아야 한다(display:none 금지)').toBeVisible();
        await first.focus();
        await expect(first).toBeFocused();
        const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(SETTING_PATH));
        await page.keyboard.press('Space');
        expect((await saved).status(), '키보드로 고르면 서버에 저장된다').toBe(200);
        await expect(first).toBeChecked();
        expect(await getValue(w.api), '키보드로 바꾼 값이 서버에 저장됨').toBe('CALL_119_AND_NOTIFY');
      });
    });

    test.info().annotations.push({
      type: '화면 한계',
      description: 'FE a8666240 은 CALL_119 를 고르는 선택지가 없고, 서버 값이 CALL_119 면 기본값(119 화면 바로 열기)으로 표시한다. 서버 값 저장·조회만 CALL_119 로 확인했다.',
    });
  });

  test('CONN-A23 wardId 형식 오류는 DB 조회 없이 403', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const stranger = await tempUser('WARD');
    const g = await loginAs(guardian);

    const malformed: { label: string; wardId: string; length: number }[] = [
      { label: '7자', wardId: '1234567', length: 7 },
      { label: '특수문자', wardId: 'a!b@c', length: 5 },
      { label: '긴 문자열', wardId: 'x'.repeat(300), length: 300 },
      { label: '줄바꿈이 섞임(로그 위조 시도)', wardId: 'QAFORGEMARK\n[IDOR-ATTEMPT] fake', length: 'QAFORGEMARK\n[IDOR-ATTEMPT] fake'.length },
      { label: '끝에 줄바꿈', wardId: 'abc12\n', length: 6 },
    ];

    await test.step('형식이 틀린 wardId 는 모두 403', async () => {
      for (const m of malformed) {
        const res = await g.api.raw('GET', `/api/guardian/sos/history?wardId=${encodeURIComponent(m.wardId)}`);
        expect(res.status(), `wardId ${m.label}`).toBe(403);
      }
    });

    await test.step('대조: 형식은 맞지만 연결 안 된 6자 ID 도 403', async () => {
      const res = await g.api.raw('GET', `/api/guardian/sos/history?wardId=${stranger.id}`);
      expect(res.status()).toBe(403);
    });

    await test.step('로그에는 원문 대신 길이만 남는다', async () => {
      await expect
        .poll(() => beLogLines(['[IDOR-ATTEMPT]', 'wardIdLength=', `guardianId=${guardian.id},`]).length, {
          message: '형식 오류 시도 로그 줄 수', timeout: 25_000, intervals: [1000, 2000],
        })
        .toBeGreaterThanOrEqual(malformed.length);
      const lines = beLogLines(['[IDOR-ATTEMPT]', 'wardIdLength=', `guardianId=${guardian.id},`]);
      const lengths = lines.map(line => Number(/wardIdLength=(\d+)\s*$/.exec(line)?.[1] ?? NaN)).sort((x, y) => x - y);
      expect(lengths, '줄마다 길이로 끝난다').toEqual(malformed.map(m => m.length).sort((x, y) => x - y));
      expect(logLineCount(env.apiContainer, ['QAFORGEMARK']), '넣은 글자가 로그에 원문으로 남으면 안 된다').toBe(0);
      expect(lines.some(line => line.includes('1234567') || line.includes('a!b@c')), '원문(7자·특수문자)이 로그에 없다').toBe(false);
      // 대조 줄: 형식이 맞는 값은 wardId 원문이 로그에 남는다(길이 줄과 다른 문구)
      await expect
        .poll(() => beLogLines(['[IDOR-ATTEMPT]', `guardianId=${guardian.id},`, `wardId=${stranger.id}`]).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
    });
  });

  test('CONN-N21 보호자 SOS 이력 조회와 탭 건수', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const guardian2 = await tempUser('GUARDIAN', { phone: null });
    const w1 = await tempUser('WARD', { name: 'E2E이력가' });
    const w2 = await tempUser('WARD', { name: 'E2E이력나' });
    const w3 = await tempUser('WARD', { name: 'E2E이력다' });
    connectDaysAgo(guardian.id, w1.id);
    connectDaysAgo(guardian2.id, w1.id);
    connectDaysAgo(guardian.id, w2.id);
    // w3 는 연결하지 않는다 - 이력이 섞여 보이면 안 된다
    const g = await loginAs(guardian);

    // w1: 버튼 52건 + 보호자 전화 3건(그중 1건은 guardian2 가 전화받음), w2: 버튼 2건(위치 없는 것 포함) + 전화 1건, w3: 버튼 2건
    psql(`INSERT INTO sos_event (ward_id, trigger_type, location, created_at)
          SELECT ${sqlStr(w1.id)}, 'SOS_BUTTON', '자택 거실', now() - (n * interval '10 minutes') - interval '1 hour' FROM generate_series(1, 52) n;`);
    insertSosEvent(w1.id, { triggerType: 'GUARDIAN_CALL', calledGuardianId: guardian2.id, location: '자택 안방', secondsAgo: 600 });
    insertSosEvent(w1.id, { triggerType: 'GUARDIAN_CALL', secondsAgo: 1200 });
    insertSosEvent(w1.id, { triggerType: 'GUARDIAN_CALL', secondsAgo: 1800 });
    insertSosEvent(w2.id, { secondsAgo: 60, location: '현관' });
    insertSosEvent(w2.id, { secondsAgo: 120 });
    insertSosEvent(w2.id, { triggerType: 'GUARDIAN_CALL', secondsAgo: 180 });
    insertSosEvent(w3.id, { secondsAgo: 30 });
    insertSosEvent(w3.id, { secondsAgo: 90 });

    const TOTAL = 52 + 3 + 3; // w1 55 + w2 3
    const BUTTON = 52 + 2;
    const CALL = 3 + 1;

    await test.step('wardId 를 생략하면 연결된 피보호자 전원을 합쳐 최신순(기본 20건)', async () => {
      const page = await history(g.api);
      expect(page.content).toHaveLength(20);
      expect(page.size).toBe(20);
      expect(page.page).toBe(0);
      expect(page.totalElements).toBe(TOTAL);
      expect(page.totalPages).toBe(Math.ceil(TOTAL / 20));
      expect(page.last).toBe(false);
      expect(page.counts, '탭 건수는 50건을 넘어도 전체 기준').toEqual({ all: TOTAL, sosButton: BUTTON, guardianCall: CALL });
      const ids = new Set(page.content.map(item => item.wardId));
      expect(ids.has(w3.id), '연결 안 된 피보호자 이력이 섞이면 안 된다').toBe(false);
      const times = page.content.map(item => Date.parse(item.triggeredAt));
      expect([...times].sort((x, y) => y - x), '최신순').toEqual(times);
      // 가장 최근 건은 w2 의 60초 전 '현관'
      const [top] = page.content;
      expect(top.wardId).toBe(w2.id);
      expect(top.wardName).toBe(w2.name);
      expect(top.location).toBe('현관');
      expect(top.triggerType).toBe('SOS_BUTTON');
      for (const item of page.content) {
        for (const key of ['sosEventId', 'wardId', 'wardName', 'triggeredAt', 'triggerType']) {
          expect(item, `한 건에 ${key} 가 있다`).toHaveProperty(key);
        }
        expect(Number.isNaN(Date.parse(item.triggeredAt))).toBe(false);
      }
    });

    await test.step('size 상한 50, 마지막 쪽', async () => {
      const big = await history(g.api, '?size=100');
      expect(big.content, 'size 100 은 50 으로 처리').toHaveLength(50);
      expect(big.size).toBe(50);
      const last = await history(g.api, '?page=2&size=20');
      expect(last.content).toHaveLength(TOTAL - 40);
      expect(last.last).toBe(true);
      expect(last.counts.all, '쪽이 달라도 건수는 같다').toBe(TOTAL);
    });

    await test.step('triggerType 필터: 목록은 줄고 탭 건수는 그대로', async () => {
      const calls = await history(g.api, '?triggerType=GUARDIAN_CALL&size=50');
      expect(calls.totalElements).toBe(CALL);
      expect(calls.content.every(item => item.triggerType === 'GUARDIAN_CALL')).toBe(true);
      expect(calls.counts).toEqual({ all: TOTAL, sosButton: BUTTON, guardianCall: CALL });
      const calledItem = calls.content.find(item => item.calledGuardianName);
      expect(calledItem?.calledGuardianName, '전화받은 보호자 이름').toBe(guardian2.name);
      expect((await g.api.raw('GET', '/api/guardian/sos/history?triggerType=BOGUS')).status(), '허용 외 triggerType').toBe(400);
    });

    await test.step('wardId 지정: 그 피보호자만, 연결 안 된 피보호자는 403', async () => {
      const only = await history(g.api, `?wardId=${w2.id}`);
      expect(only.totalElements).toBe(3);
      expect(only.content.every(item => item.wardId === w2.id)).toBe(true);
      expect(only.counts, '조회 범위(그 피보호자) 기준 건수').toEqual({ all: 3, sosButton: 2, guardianCall: 1 });
      expect((await g.api.raw('GET', `/api/guardian/sos/history?wardId=${w3.id}`)).status()).toBe(403);
    });

    await test.step('연결이 없는 보호자는 빈 목록', async () => {
      const lonely = await loginAs(await tempUser('GUARDIAN', { phone: null }));
      const empty = await history(lonely.api);
      expect(empty.content).toHaveLength(0);
      expect(empty.counts).toEqual({ all: 0, sosButton: 0, guardianCall: 0 });
    });

    await test.step('화면: 피보호자별 탭 숫자(전체·SOS 버튼·보호자 연락)가 API counts 와 같다', async () => {
      const page = await openAs(g.who, '/guardian/sos');
      const filters = page.getByRole('tablist', { name: '발생 경로 필터' });
      const shown = async (label: string) => (await filters.getByRole('button', { name: new RegExp(label) }).locator('strong').innerText()).trim();
      for (const [ward, all, button, call] of [[w1, 55, 52, 3], [w2, 3, 2, 1]] as const) {
        // 화면은 연타 묶음 보기(group=true)로 받으므로 묶은 뒤의 건수(묶음 1건으로 셈)와 같아야 한다
        const plain = (await history(g.api, `?wardId=${ward.id}`)).counts;
        expect(plain, `${ward.name} 묶지 않은 건수`).toEqual({ all, sosButton: button, guardianCall: call });
        const api = (await history(g.api, `?wardId=${ward.id}&group=true`)).counts;
        await page.getByRole('tablist', { name: '피보호자 선택' }).getByRole('tab', { name: new RegExp(ward.name) }).click();
        await expect.poll(() => shown('전체'), { message: `${ward.name} 화면 전체 건수`, timeout: 20_000 }).toBe(String(api.all));
        expect(await shown('SOS 버튼'), `${ward.name} 화면 SOS 버튼 건수`).toBe(String(api.sosButton));
        expect(await shown('보호자 연락'), `${ward.name} 화면 보호자 연락 건수`).toBe(String(api.guardianCall));
      }
    });

    test.info().annotations.push({
      type: '범위',
      description: '이름 없는 피보호자 표기(SOS-G14)는 배포 FE(a8666240)에서 "이름 없음" 문구를 찾을 수 없어(탭은 이름이 없으면 "피보호자"로 표시) 확인하지 않았다. 연결 목록 로딩 실패 분리 표시(FEUX-G29)도 확인하지 않았다.',
    });
  });

  test('CONN-N22 연타 묶음 보기 group=true', TAGS, async ({ tempUser, loginAs }) => {
    const g1 = await tempUser('GUARDIAN', { phone: null, name: 'E2E묶음보호자가' });
    const g2 = await tempUser('GUARDIAN', { phone: null, name: 'E2E묶음보호자나' });
    const ward = await tempUser('WARD');
    connectDaysAgo(g1.id, ward.id);
    connectDaysAgo(g2.id, ward.id);
    const v = await loginAs(g1);

    // 버튼: 묶음 A(0·30·60초 간격 = 정확히 60초도 같은 묶음) + 묶음 B(61초 뒤 1건)
    // 한 문장으로 넣어 시각 간격이 정확하다(오래된 것부터 적는다). 보호자 전화: g1 에게 2번(20초 간격), g2 에게 1번(같은 1분 안이라도 다른 줄)
    const [a1, a2, a3, b1, c1, d1, c2] = insertSosEvents(ward.id, [
      { secondsAgo: 3000, location: '거실' },
      { secondsAgo: 2970, location: '안방' },
      { secondsAgo: 2940, location: '부엌' },
      { secondsAgo: 2940 - 61, location: '현관' },
      { triggerType: 'GUARDIAN_CALL', calledGuardianId: g1.id, secondsAgo: 1000 },
      { triggerType: 'GUARDIAN_CALL', calledGuardianId: g2.id, secondsAgo: 990 },
      { triggerType: 'GUARDIAN_CALL', calledGuardianId: g1.id, secondsAgo: 980 },
    ]);

    const byId = (page: HistPage, id: number) => page.content.find(item => item.sosEventId === id);

    await test.step('묶지 않는 보기는 누름마다 한 줄이고 묶음 칸이 없다', async () => {
      const plain = await history(v.api, '?size=50');
      expect(plain.totalElements).toBe(7);
      expect(plain.counts).toEqual({ all: 7, sosButton: 4, guardianCall: 3 });
      expect(plain.content.some(item => 'pressCount' in item || 'firstTriggeredAt' in item || 'lastTriggeredAt' in item)).toBe(false);
    });

    let grouped: HistPage;
    await test.step('묶음 보기: 줄 수·건수는 묶음 수', async () => {
      grouped = await history(v.api, '?group=true&size=50');
      expect(grouped.totalElements, '묶음 수').toBe(4);
      expect(grouped.counts, '건수도 묶음 수').toEqual({ all: 4, sosButton: 2, guardianCall: 2 });
      expect(grouped.content).toHaveLength(4);
    });

    await test.step('한 줄 = 묶음의 최신 값 + pressCount·첫·마지막 시각', async () => {
      const groupA = byId(grouped, a3);
      expect(groupA, '묶음 A 는 최신 건(a3)의 id 로 나온다').toBeTruthy();
      expect(byId(grouped, a1) ?? byId(grouped, a2), '묶음 안의 앞선 건은 따로 나오지 않는다').toBeUndefined();
      expect(groupA!.pressCount, '정확히 60초 간격도 같은 묶음').toBe(3);
      expect(groupA!.location, '위치는 최신 건 값').toBe('부엌');
      expect(Date.parse(groupA!.firstTriggeredAt!)).toBeLessThan(Date.parse(groupA!.lastTriggeredAt!));
      expect(groupA!.lastTriggeredAt).toBe(groupA!.triggeredAt);
      expect(Date.parse(groupA!.lastTriggeredAt!) - Date.parse(groupA!.firstTriggeredAt!), '첫~마지막 간격 60초').toBe(60_000);

      const groupB = byId(grouped, b1);
      expect(groupB, '61초 뒤 1건은 새 묶음').toBeTruthy();
      expect(groupB!.pressCount).toBe(1);
      expect(groupB!.firstTriggeredAt).toBe(groupB!.lastTriggeredAt);
    });

    await test.step('보호자 전화는 전화받은 보호자가 다르면 1분 안이어도 다른 줄', async () => {
      const callsG1 = byId(grouped, c2);
      expect(callsG1?.pressCount, 'g1 에게 건 2번은 한 줄').toBe(2);
      expect(callsG1?.calledGuardianName).toBe(g1.name);
      expect(byId(grouped, c1), '묶음 안의 앞선 건은 따로 나오지 않는다').toBeUndefined();
      const callsG2 = byId(grouped, d1);
      expect(callsG2?.pressCount, 'g2 에게 건 1번은 다른 줄').toBe(1);
      expect(callsG2?.calledGuardianName).toBe(g2.name);
    });

    await test.step('쪽 경계에서 묶음이 잘리지 않는다', async () => {
      const seen = new Map<number, number>();
      for (let p = 0; p < 4; p++) {
        const part = await history(v.api, `?group=true&size=1&page=${p}`);
        expect(part.totalElements).toBe(4);
        expect(part.content).toHaveLength(1);
        seen.set(part.content[0].sosEventId, part.content[0].pressCount!);
      }
      expect(seen.size, '쪽마다 다른 묶음').toBe(4);
      expect(seen.get(a3), '쪽을 나눠도 묶음 A 의 누름 수').toBe(3);
      expect(seen.get(c2)).toBe(2);
    });

    await test.step('triggerType 필터와 같이 쓰면 그 경로의 묶음 수', async () => {
      const calls = await history(v.api, '?group=true&triggerType=GUARDIAN_CALL');
      expect(calls.totalElements).toBe(2);
      expect(calls.counts, '건수는 필터와 무관').toEqual({ all: 4, sosButton: 2, guardianCall: 2 });
    });
  });

  test('CONN-A15 triggerType·calledGuardianId 이상값은 SOS를 막지 않음', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    // 문서에는 "triggerType 이 잘못되면 400 가능(미명시)"이라고만 있다 - 배포 코드는 열거형 변환 실패라 400 이다
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    const outsider = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const w = await loginAs(ward);
    let expectedNotifs = 0;

    const storedCalled = (id: number) => psql(`SELECT coalesce(called_guardian_id, '<null>') FROM sos_event WHERE id = ${id};`);
    const sendAndWait = async (label: string, data: unknown) => {
      clearCooldown(ward.id);
      const res = await postSos(w.api, data);
      expectedNotifs += 2;
      await expect
        .poll(() => sosNotificationCount(ward.id), { message: `${label}: 연결된 보호자 전원(2명)에게 알림 기록`, timeout: 30_000, intervals: [1000, 2000] })
        .toBe(expectedNotifs);
      return res.sosEventId;
    };

    try {
      await test.step('triggerType 이상값은 400 이고 이력이 남지 않는다', async () => {
        const res = await w.api.raw('POST', '/api/ward/sos', { triggerType: 'BOGUS_TYPE' });
        expect(res.status()).toBe(400);
        expect(sosEvents(ward.id)).toBe(0);
        expect(sosNotificationCount(ward.id)).toBe(0);
      });

      let idButton = 0;
      let idShort = 0;
      let idSpecial = 0;
      let idOutsider = 0;
      let idGood = 0;
      await test.step('SOS_BUTTON 에 calledGuardianId: SOS 성공, 값은 저장 안 됨', async () => {
        idButton = await sendAndWait('SOS_BUTTON+id', { triggerType: 'SOS_BUTTON', calledGuardianId: g1.id });
        expect(storedCalled(idButton)).toBe('<null>');
      });
      await test.step('7자 ID', async () => {
        idShort = await sendAndWait('7자', { triggerType: 'GUARDIAN_CALL', calledGuardianId: '1234567' });
        expect(storedCalled(idShort)).toBe('<null>');
      });
      await test.step('특수문자 ID', async () => {
        idSpecial = await sendAndWait('특수문자', { triggerType: 'GUARDIAN_CALL', calledGuardianId: 'a-b!c' });
        expect(storedCalled(idSpecial)).toBe('<null>');
      });
      await test.step('연결 안 된 보호자 ID', async () => {
        idOutsider = await sendAndWait('연결 안 됨', { triggerType: 'GUARDIAN_CALL', calledGuardianId: outsider.id });
        expect(storedCalled(idOutsider)).toBe('<null>');
      });
      await test.step('대조: 연결된 보호자 ID 는 저장된다', async () => {
        idGood = await sendAndWait('정상', { triggerType: 'GUARDIAN_CALL', calledGuardianId: g1.id });
        expect(storedCalled(idGood)).toBe(g1.id);
      });

      await test.step('WARN 로그: 이유와 길이만 남고 원문은 없다', async () => {
        await expect
          .poll(() => beLogLines(['[SOS-CALLED-GUARDIAN-IGNORED]', `wardId=${ward.id},`]).length, { timeout: 25_000, intervals: [1000, 2000] })
          .toBe(4);
        const lines = beLogLines(['[SOS-CALLED-GUARDIAN-IGNORED]', `wardId=${ward.id},`]);
        const reasons = lines.map(line => /reason=(\w+)/.exec(line)?.[1]).sort();
        expect(reasons).toEqual(['FORMAT', 'FORMAT', 'NOT_CONNECTED', 'NOT_GUARDIAN_CALL']);
        const lengths = lines.filter(line => line.includes('reason=FORMAT')).map(line => Number(/length=(\d+)/.exec(line)?.[1])).sort();
        expect(lengths).toEqual([5, 7]);
        const all = lines.join('\n');
        expect(all.includes('1234567') || all.includes('a-b!c') || all.includes(outsider.id), '입력 원문이 로그에 없다').toBe(false);
      });
    } finally {
      clearCooldown(ward.id);
    }

    expect(sosEvents(ward.id), '이력은 5건').toBe(5);
    const logs = sosNotificationLogs(ward.id);
    expect(logs.map(l => l.recipient).sort(), '알림은 매번 두 보호자 모두에게').toEqual(
      [g1.id, g2.id, g1.id, g2.id, g1.id, g2.id, g1.id, g2.id, g1.id, g2.id].sort(),
    );
  });

  test('CONN-A16 문자 대신 보내기 시간당 30건 초과', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    // 31건을 실제로 보내지 않는다 - 이 임시 보호자 한 명의 한도 카운터(Redis)를 30 으로 맞춰 31번째 상황을 만든다.
    // 설정값 0(끔)은 서버 설정이라 바꿀 수 없어 확인하지 않았다.
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const w = await loginAs(ward);
    const g = await loginAs(guardian);
    const key = `notify:sms-fallback:WARD_SOS:${guardian.id}`;

    const page = await openAs(g.who, null);
    const frames = captureFrames(page);
    await page.goto('/guardian');
    await waitForRealtime(page);

    try {
      await test.step('문자가 접수되지 않으면(번호 없음) 센 건수를 되돌린다', async () => {
        redis('SET', key, '5', 'EX', '3600');
        clearCooldown(ward.id);
        await postSos(w.api);
        await expect.poll(() => sosNotificationCount(ward.id, guardian.id), { timeout: 30_000, intervals: [1000, 2000] }).toBe(1);
        expect(redis('GET', key), '문자가 안 나갔으니 센 건수는 미리 넣은 5 그대로(6 으로 남지 않음)').toBe('5');
      });

      await test.step('한도(30건)에 찬 상태의 31번째: 문자만 건너뜀', async () => {
        redis('SET', key, '30', 'EX', '3600');
        clearCooldown(ward.id);
        await postSos(w.api);
        await expect.poll(() => sosNotificationCount(ward.id, guardian.id), { timeout: 30_000, intervals: [1000, 2000] }).toBe(2);
        const [, second] = sosNotificationLogs(ward.id, guardian.id);
        expect(['DELIVERED', 'SMS_FALLBACK'], '전달된 것으로 기록되면 안 된다').not.toContain(second.result);
        expect(second.channels, '문자 단계가 한도 초과(RATE_LIMITED)로 건너뛰어졌다').toContain('RATE_LIMITED');
        expect(second.channels, '푸시(FCM) 시도는 그대로 한다').toContain('FCM');
        await expect
          .poll(() => logLineCount(env.apiContainer, ['[SMS-FALLBACK-CAP]', `userId=${guardian.id},`]), { message: '한도 초과 로그', timeout: 20_000, intervals: [1000, 2000] })
          .toBeGreaterThanOrEqual(1);
        expect(sosEvents(ward.id), '이력은 2건 모두 남는다').toBe(2);
        await expect
          .poll(() => frames.filter(f => f.includes('sos-triggered')).length, { message: '화면 실시간 알림(sos-triggered)도 두 번 모두 온다', timeout: 15_000 })
          .toBeGreaterThanOrEqual(2);
      });
    } finally {
      redis('DEL', key);
      clearCooldown(ward.id);
    }
  });

  test.fixme('CONN-A18 횟수 계산 실패해도 알림은 기본 문구로', TAGS, async () => {
    // 횟수 집계(SosEventRepository.countByWardIdAndCreatedAtGreaterThanEqual) 실패는 DB 장애가 있어야 만들 수 있고,
    // DB·서버를 건드리는 것은 금지라 자동화할 수 없다. 코드(SosNotificationListener.countRecentOccurrences)는 예외를 삼키고
    // 1회로 보아 기본 문구로 보낸다. 정상 경로의 기본 문구는 CONN-N15(P0)가 본다. 수동 확인 필요.
  });

  test('CONN-A21 로그아웃·계정 전환 뒤 이전 사용자 팝업·설정 잔존', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const FORGED = 'E2E이전사용자';
    const wardA = await tempUser('WARD');
    const wardB = await tempUser('WARD');
    const a = await loginAs(wardA);
    await loginAs(wardB);
    expect((await a.api.raw('PUT', SETTING_PATH, { sosAction: 'NOTIFY_GUARDIAN_FIRST' })).status()).toBe(200);

    const page = await openAs(a.who, '/ward/sos');
    await expect(sosHeroButton(page)).toBeVisible({ timeout: 20_000 });
    const readLocal = () => page.evaluate(key => {
      try {
        return (JSON.parse(window.localStorage.getItem(key) ?? '{}') as { sosAction?: string }).sosAction ?? null;
      } catch {
        return 'parse-error';
      }
    }, WARD_SETTINGS_KEY);
    await expect.poll(readLocal, { message: 'A 의 설정이 이 기기에 저장됨', timeout: 20_000 }).toBe('NOTIFY_GUARDIAN_FIRST');

    await test.step('A 가 화면에서 로그아웃', async () => {
      const menu = page.getByRole('navigation', { name: '피보호자 메뉴' });
      if (!(await menu.isVisible())) await page.getByRole('button', { name: /메뉴( 열기)?$/ }).first().click();
      await page.getByRole('button', { name: new RegExp(wardA.name) }).click();
      await page.getByRole('dialog').getByRole('button', { name: '로그아웃' }).click();
      await modal(page, '로그아웃 확인').getByRole('button', { name: '로그아웃', exact: true }).click();
      await expect(page).toHaveURL(/\/login$/);
    });

    await test.step('같은 브라우저에서 B 가 로그인: A 의 119 설정이 넘어오지 않는다', async () => {
      await relaxAuthRates();
      await page.getByLabel('이메일').fill(wardB.email);
      await page.getByLabel('비밀번호').fill(wardB.password);
      await page.getByRole('button', { name: '로그인', exact: true }).click();
      await expect(page).toHaveURL(/\/ward(\/|$)/, { timeout: 30_000 });
      await expect
        .poll(readLocal, { message: 'B 의 서버 값(기본값)으로 바뀌어야 한다. A 의 NOTIFY_GUARDIAN_FIRST 가 남으면 설정이 넘어간 것', timeout: 30_000 })
        .toBe('CALL_119_AND_NOTIFY');
    });

    await test.step('보호자 A 가 받은 SOS 팝업이 로그아웃·보호자 B 로그인 뒤 남지 않는다(실제 팝업을 받는 쪽은 보호자)', async () => {
      const gA = await tempUser('GUARDIAN', { phone: null });
      const gB = await tempUser('GUARDIAN', { phone: null });
      const gAu = await loginAs(gA);
      await loginAs(gB);
      const gPage = await openAs(gAu.who, '/guardian');
      await waitForRealtime(gPage);
      await gPage.evaluate(name => {
        window.dispatchEvent(new CustomEvent('careai:push', {
          detail: {
            data: { type: 'WARD_SOS', wardId: 'e2e000', wardName: name, sosEventId: `e2e-local-${Date.now()}` },
            notification: { title: '긴급 SOS', body: `${name}님이 긴급 도움을 요청했습니다.` },
          },
        }));
      }, FORGED);
      await expect(toastArea(gPage).filter({ hasText: FORGED }), '준비: 보호자 A 화면에 팝업이 떠 있어야 한다').toBeVisible();

      const side = gPage.getByRole('complementary', { name: /메뉴$/ });
      if (!(await side.getByRole('button', { name: new RegExp(gA.name) }).isVisible())) {
        await gPage.getByRole('button', { name: /메뉴( 열기)?$/ }).first().click();
      }
      await side.getByRole('button', { name: new RegExp(gA.name) }).click();
      await gPage.getByRole('dialog').getByRole('button', { name: '로그아웃' }).click();
      await modal(gPage, '로그아웃 확인').getByRole('button', { name: '로그아웃', exact: true }).click();
      await expect(gPage).toHaveURL(/\/login$/);
      await expect.soft(toastArea(gPage).filter({ hasText: FORGED }), '로그아웃 뒤에도 이전 보호자의 SOS 팝업이 남아 있다').toHaveCount(0);

      await relaxAuthRates();
      await gPage.getByLabel('이메일').fill(gB.email);
      await gPage.getByLabel('비밀번호').fill(gB.password);
      await gPage.getByRole('button', { name: '로그인', exact: true }).click();
      await expect(gPage).toHaveURL(/\/guardian(\/|$)/, { timeout: 30_000 });
      await expect.soft(toastArea(gPage).filter({ hasText: FORGED }), '보호자 B 화면에 보호자 A 의 SOS 팝업이 보인다').toHaveCount(0);
    });

    await test.step('남의 실시간 채널로 가짜 알림을 보낼 수 없다', async () => {
      const victimGuardian = await tempUser('GUARDIAN', { phone: null });
      const attackerWard = await tempUser('WARD');
      connect(victimGuardian.id, attackerWard.id);
      const [vg, aw] = [await loginAs(victimGuardian), await loginAs(attackerWard)];
      const victim = await openAs(vg.who, '/guardian');
      const attacker = await openAs(aw.who, null);
      const attackerFrames = captureFrames(attacker);
      await attacker.goto('/ward');
      await Promise.all([waitForRealtime(victim), waitForRealtime(attacker)]);
      await attacker.evaluate(
        ({ destination, name }) => {
          const client = (window as unknown as { __connectionStompClient: { publish: (f: { destination: string; body: string }) => void } })
            .__connectionStompClient;
          client.publish({
            destination,
            body: JSON.stringify({ type: 'SOS_TRIGGERED', wardName: name, sosEventId: `e2e-forged-${Date.now()}`, title: '긴급 SOS', body: `${name}님이 긴급 도움을 요청했습니다.` }),
          });
        },
        { destination: `/topic/${victimGuardian.id}/sos-triggered`, name: 'E2E위조자' },
      );
      // 서버가 클라이언트 SEND 를 거부하면 보낸 쪽에 STOMP ERROR 프레임이 온다. 그것을 기다린 뒤 피해자 화면에 0건인지 본다
      await expect.poll(() => attackerFrames.some(f => f.startsWith('ERROR')), { message: '서버가 위조 발행을 거부했다(ERROR 프레임)', timeout: 15_000 }).toBe(true);
      await expect(toastArea(victim).filter({ hasText: 'E2E위조자' }), '클라이언트가 보낸 위조 SOS 가 보호자 화면에 떴다').toHaveCount(0);
    });
  });

  test('CONN-N16 보호자 전화(GUARDIAN_CALL)와 calledGuardianId 기록', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(150_000);
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const w = await loginAs(ward);
    const v1 = await loginAs(g1);
    const v2 = await loginAs(g2);

    try {
      const res = await postSos(w.api, { triggerType: 'GUARDIAN_CALL', calledGuardianId: g1.id, location: '자택 거실' });
      expect(psql(`SELECT trigger_type || '|' || coalesce(called_guardian_id, '<null>') FROM sos_event WHERE id = ${res.sosEventId};`))
        .toBe(`GUARDIAN_CALL|${g1.id}`);

      await test.step('이력에 전화받은 보호자 이름이 표시된다(전화받은 사람·다른 보호자 모두에게)', async () => {
        for (const [label, viewer] of [['전화받은 보호자', v1], ['다른 보호자', v2]] as const) {
          for (const query of ['', '?group=true']) {
            const res2 = await read(await viewer.api.raw('GET', `/api/guardian/sos/history${query}`));
            expect(res2.status, `${label} ${query}`).toBe(200);
            const page = res2.body.data as HistPage;
            const item = page.content.find(i => i.sosEventId === res.sosEventId);
            expect(item?.triggerType, `${label} ${query} 경로`).toBe('GUARDIAN_CALL');
            expect(item?.calledGuardianName, `${label} ${query} 이름`).toBe(g1.name);
            expect(res2.text.includes(g1.id), `${label} ${query}: 전화받은 보호자 ID 는 응답에 없다`).toBe(false);
          }
        }
      });

      await test.step('알림은 전화받은 사람 포함 전원에게 같은 문구', async () => {
        await expect
          .poll(() => sosNotificationCount(ward.id), { message: '두 보호자 모두에게 알림 기록', timeout: 30_000, intervals: [1000, 2000] })
          .toBe(2);
        const logs = sosNotificationLogs(ward.id);
        expect(logs.map(l => l.recipient).sort()).toEqual([g1.id, g2.id].sort());
        for (const log of logs) {
          expect(log.title).toBe(`[긴급] ${ward.name}님 SOS`);
          expect(log.body).toBe(`${ward.name}님이 긴급 도움을 요청했습니다.`);
        }
      });

      await test.step('전화받은 보호자가 연결을 끊으면 이름 칸이 빠진다', async () => {
        psql(`UPDATE connection SET status = 'DISCONNECTED' WHERE guardian_id = ${sqlStr(g1.id)} AND ward_id = ${sqlStr(ward.id)};`);
        const after = await history(v2.api);
        const item = after.content.find(i => i.sosEventId === res.sosEventId);
        expect(item, '이력은 남는다').toBeTruthy();
        expect(item && 'calledGuardianName' in item, '이름 칸이 없다').toBe(false);
      });
    } finally {
      clearCooldown(ward.id);
    }
  });
});
