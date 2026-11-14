/**
 * 최종 QA - 알림(NOTI) P1a - 관리자 알림 이력 (GET /api/admin/notification, /summary)
 *
 * 관리자 이력은 서비스 전체를 보여 주므로, 이 파일의 모든 조회는 임시 사용자 이름에 넣은 고유 조각(keyword)으로 좁히고
 * 결과를 임시 사용자 id 로 다시 확인한다(남의 행을 훑지 않는다).
 * 집계·필터 조건은 임시 사용자 자신의 알림 이력 행을 직접 넣어(insertLogRow) 정확히 만든다(발송 없음).
 * N50 만 실제 발송을 일으킨다(전화번호·푸시 토큰이 없는 임시 사용자라 외부 발송은 없다).
 */
import { Api } from '../../../src/api';
import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { TempUser, TempUserOptions } from '../../../src/seed';
import { connect } from '../../../src/variables';
import { anonymous, bodyOf, logRows, sendSos, waitForLog } from './_helpers-noti';
import { insertLogRow, P1A_TAGS, uniqueNameTag } from './_helpers-noti-p1a';

const LIST = '/api/admin/notification';
const SUMMARY = '/api/admin/notification/summary';

interface Item {
  id: number;
  sentAt: string;
  type: string;
  typeLabel: string;
  category: string;
  wardId: string | null;
  wardName: string | null;
  title: string;
  body: string;
  recipientId: string;
  recipientName: string;
  recipientRole: string;
  recipientIsWard: boolean;
  relation: string | null;
  deliveredChannels: string[];
  result: string;
  notSentReason: string | null;
  notSentReasonLabel: string | null;
  channelResults: { channel: string; status: string; reason: string | null; reasonLabel: string | null }[];
}
interface PageBody {
  content: Item[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
}

async function get(api: Api, path: string) {
  const res = await api.raw('GET', path);
  return { status: res.status(), body: await bodyOf(res) };
}

async function listOf(api: Api, query: string): Promise<PageBody> {
  const r = await get(api, `${LIST}?${query}`);
  expect(r.status, `GET ${LIST}?${query.replace(/keyword=[^&]*/, 'keyword=<조각>')} -> 200`).toBe(200);
  return r.body.data as PageBody;
}

const ids = (items: { id: number }[]) => items.map(i => i.id).sort((a, b) => a - b);

/** 임시 보호자·피보호자 한 쌍(이름에 고유 조각). 보호자 이름 = <조각>g, 피보호자 이름 = <조각>w */
async function pair(tempUser: (role: TempUser['role'], options?: TempUserOptions) => Promise<TempUser>, tag: string) {
  const guardian = await tempUser('GUARDIAN', { name: `${tag}g`, phone: null });
  const ward = await tempUser('WARD', { name: `${tag}w`, phone: null });
  connect(guardian.id, ward.id);
  return { guardian, ward };
}

test.describe('관리자 알림 이력 조회', () => {
  test('NOTI-N47 관리자 알림 이력 목록 조회(기본 7일·20건)', P1A_TAGS, async ({ tempUser, loginAs }) => {
    const tag = uniqueNameTag();
    const admin = await tempUser('ADMIN');
    const { guardian, ward } = await pair(tempUser, tag);
    const [ad, gu] = [await loginAs(admin), await loginAs(guardian)];

    // 최근 25건(1분 간격) + 10일 전 1건. 기본 기간(7일)에는 25건만 보여야 한다
    const rowIds: number[] = [];
    for (let k = 1; k <= 25; k++) {
      rowIds.push(
        insertLogRow({
          recipientId: guardian.id,
          wardId: ward.id,
          type: 'WARD_SOS',
          result: k === 1 ? 'DELIVERED' : 'FAILED',
          channels: k === 1
            ? [{ channel: 'FCM', status: 'DELIVERED', reason: null }, { channel: 'SMS', status: 'FAILED', reason: 'NO_PHONE' }]
            : [{ channel: 'FCM', status: 'FAILED', reason: 'NO_DEVICE' }],
          title: `QA-${String(k).padStart(2, '0')}`,
          body: `본문 ${k}`,
          createdAtSql: `now() - interval '${k} minutes'`,
        }),
      );
    }
    const oldId = insertLogRow({ recipientId: guardian.id, wardId: ward.id, type: 'WARD_SOS', result: 'FAILED', title: 'QA-OLD', createdAtSql: `now() - interval '10 days'` });

    const first = await listOf(ad.api, `keyword=${tag}`);
    expect(first.size, '기본 20건').toBe(20);
    expect(first.page).toBe(0);
    expect(first.content, '첫 쪽 20건').toHaveLength(20);
    expect(first.totalElements, '기본 기간(7일)에는 25건(10일 전 행 제외)').toBe(25);
    expect(first.totalPages).toBe(2);
    expect(first.last).toBe(false);
    expect(ids(first.content), '내 행만 들어 있다').toEqual(ids(rowIds.slice(0, 20).map(id => ({ id }))));
    expect(first.content.map(i => i.title), '최신순').toEqual(Array.from({ length: 20 }, (_, i) => `QA-${String(i + 1).padStart(2, '0')}`));
    const times = first.content.map(i => Date.parse(i.sentAt));
    expect(times.every((t, i) => i === 0 || times[i - 1] > t), '발송 시각이 내림차순').toBe(true);

    const line = first.content[0];
    expect(Object.keys(line).sort(), '한 줄에 들어 있는 칸').toEqual(
      ['id', 'sentAt', 'type', 'typeLabel', 'category', 'wardId', 'wardName', 'title', 'body', 'recipientId', 'recipientName', 'recipientRole', 'recipientIsWard', 'relation',
        'deliveredChannels', 'result', 'notSentReason', 'notSentReasonLabel', 'channelResults'].sort(),
    );
    expect(line).toMatchObject({
      id: rowIds[0], type: 'WARD_SOS', typeLabel: 'SOS', category: 'SOS', wardId: ward.id, wardName: ward.name, title: 'QA-01', body: '본문 1',
      recipientId: guardian.id, recipientName: guardian.name, recipientRole: 'GUARDIAN', recipientIsWard: false, relation: '기타',
      deliveredChannels: ['FCM'], result: 'DELIVERED', notSentReason: null, notSentReasonLabel: null,
    });
    expect(line.channelResults, '채널별 결과와 사유 문구').toEqual([
      { channel: 'FCM', status: 'DELIVERED', reason: null, reasonLabel: null },
      { channel: 'SMS', status: 'FAILED', reason: 'NO_PHONE', reasonLabel: '등록된 전화번호 없음' },
    ]);

    const second = await listOf(ad.api, `keyword=${tag}&page=1`);
    expect(second.page).toBe(1);
    expect(second.content.map(i => i.title), '둘째 쪽 나머지 5건').toEqual(['QA-21', 'QA-22', 'QA-23', 'QA-24', 'QA-25']);
    expect(second.last).toBe(true);

    const month = await listOf(ad.api, `keyword=${tag}&period=LAST_30_DAYS&size=50`);
    expect(ids(month.content), '30일 기간에는 10일 전 행도 포함').toEqual(ids([...rowIds, oldId].map(id => ({ id }))));

    await test.step('권한: 보호자 403, 로그인 없음 401', async () => {
      const asGuardian = await get(gu.api, `${LIST}?keyword=${tag}`);
      expect(asGuardian.status, '보호자는 403').toBe(403);
      const none = await anonymous();
      try {
        expect((await none.get(`${LIST}?keyword=${tag}`)).status(), '로그인 없이는 401').toBe(401);
      } finally {
        await none.dispose();
      }
    });
  });

  test('NOTI-N48 summary 카드 숫자', P1A_TAGS, async ({ tempUser, loginAs }) => {
    const tag = uniqueNameTag();
    const admin = await tempUser('ADMIN');
    const { guardian, ward } = await pair(tempUser, tag);
    const ad = await loginAs(admin);
    const add = (type: string, result: 'DELIVERED' | 'SMS_FALLBACK' | 'FAILED' | 'NOT_SENT', n: number, createdAtSql?: string, reason?: 'RESTRICTED_ACCOUNT' | 'NO_ENABLED_CHANNEL') => {
      for (let i = 0; i < n; i++) insertLogRow({ recipientId: guardian.id, wardId: ward.id, type, result, reason, createdAtSql });
    };
    add('WARD_SOS', 'DELIVERED', 3);
    add('WARD_SOS', 'SMS_FALLBACK', 2);
    add('ANOMALY_DETECTED', 'FAILED', 2);
    add('MEDICATION_REMINDER', 'FAILED', 2);
    add('MEDICATION_MISSED', 'NOT_SENT', 2, undefined, 'RESTRICTED_ACCOUNT');
    add('CONNECTION_REQUEST', 'NOT_SENT', 3, undefined, 'NO_ENABLED_CHANNEL');
    add('CONNECTION_ACCEPTED', 'DELIVERED', 1);
    add('WARD_SOS', 'FAILED', 1, `now() - interval '40 days'`); // 어느 기간에도 안 든다

    interface Summary { period: string; total: number; delivered: number; smsFallback: number; failed: number; notSent: number }
    const summary = async (query = '') => {
      const r = await get(ad.api, `${SUMMARY}?keyword=${tag}${query}`);
      expect(r.status, `summary ${query} -> 200`).toBe(200);
      return r.body.data as Summary;
    };

    const all = await summary();
    expect(all, '기본(7일): 전송 완료 6(문자 대체 2 포함) · 실패 4 · 보내지 않음 5').toEqual({ period: 'LAST_7_DAYS', total: 15, delivered: 6, smsFallback: 2, failed: 4, notSent: 5 });
    expect(all.total, 'total = delivered + failed + notSent').toBe(all.delivered + all.failed + all.notSent);
    expect(all.failed, '보내지 않음(NOT_SENT)은 실패에 섞이지 않는다').toBe(4);

    expect(await summary('&category=SOS'), 'SOS 탭').toEqual({ period: 'LAST_7_DAYS', total: 5, delivered: 5, smsFallback: 2, failed: 0, notSent: 0 });
    expect(await summary('&category=ANOMALY'), '이상감지 탭').toEqual({ period: 'LAST_7_DAYS', total: 2, delivered: 0, smsFallback: 0, failed: 2, notSent: 0 });
    expect(await summary('&category=MEDICATION'), '복약 탭').toEqual({ period: 'LAST_7_DAYS', total: 4, delivered: 0, smsFallback: 0, failed: 2, notSent: 2 });
    expect(await summary('&category=OTHER'), '기타 탭').toEqual({ period: 'LAST_7_DAYS', total: 4, delivered: 1, smsFallback: 0, failed: 0, notSent: 3 });
    expect(await summary('&period=TODAY'), '오늘').toEqual({ period: 'TODAY', total: 15, delivered: 6, smsFallback: 2, failed: 4, notSent: 5 });
    expect((await summary('&period=LAST_30_DAYS')).total, '30일에도 40일 전 행은 빠진다').toBe(15);
    const none = await get(ad.api, `${SUMMARY}?keyword=zz${uniqueNameTag()}`);
    expect(none.status).toBe(200);
    expect(none.body.data, '이름이 안 맞으면 모두 0').toEqual({ period: 'LAST_7_DAYS', total: 0, delivered: 0, smsFallback: 0, failed: 0, notSent: 0 });
  });

  test('NOTI-N49 category·result·period·keyword 필터', P1A_TAGS, async ({ tempUser, loginAs }) => {
    const tagA = uniqueNameTag();
    const tagB = uniqueNameTag();
    const admin = await tempUser('ADMIN');
    const { guardian: gA, ward: wA } = await pair(tempUser, tagA);
    // B: 받는 사람 이름에만 조각이 있고 피보호자 이름에는 없다(받는 사람 이름으로도 찾아지는지)
    const gB = await tempUser('GUARDIAN', { name: `${tagB}g`, phone: null });
    const wB = await tempUser('WARD', { phone: null });
    connect(gB.id, wB.id);
    const ad = await loginAs(admin);
    const row = (recipientId: string, wardId: string, type: string, result: 'DELIVERED' | 'SMS_FALLBACK' | 'FAILED' | 'NOT_SENT', when: string) =>
      insertLogRow({ recipientId, wardId, type, result, createdAtSql: when });

    const r1 = row(gA.id, wA.id, 'WARD_SOS', 'DELIVERED', 'now()');
    const r2 = row(gA.id, wA.id, 'ANOMALY_DETECTED', 'FAILED', 'now()');
    const r3 = row(gA.id, wA.id, 'MEDICATION_MISSED', 'NOT_SENT', 'now()');
    const r4 = row(gA.id, wA.id, 'CONNECTION_REQUEST', 'SMS_FALLBACK', `now() - interval '2 days'`);
    const r5 = row(gA.id, wA.id, 'INQUIRY_ANSWERED', 'DELIVERED', `now() - interval '10 days'`);
    const r6 = row(gA.id, wA.id, 'WARD_SOS', 'FAILED', `now() - interval '40 days'`);
    const b1 = row(gB.id, wB.id, 'WARD_SOS', 'DELIVERED', 'now()');
    const b2 = row(wB.id, wB.id, 'CONNECTION_REQUEST', 'DELIVERED', 'now()'); // 받는 사람·피보호자 모두 조각 없음
    expect(b2).toBeGreaterThan(0);

    const q = async (query: string) => ids((await listOf(ad.api, `${query}&size=50`)).content);
    const month = 'period=LAST_30_DAYS';
    const A = `keyword=${tagA}`;

    await test.step('category', async () => {
      expect(await q(`${A}&${month}&category=SOS`), 'SOS').toEqual(ids([{ id: r1 }]));
      expect(await q(`${A}&${month}&category=ANOMALY`), 'ANOMALY').toEqual(ids([{ id: r2 }]));
      expect(await q(`${A}&${month}&category=MEDICATION`), 'MEDICATION').toEqual(ids([{ id: r3 }]));
      expect(await q(`${A}&${month}&category=OTHER`), 'OTHER(연결·문의 등)').toEqual(ids([{ id: r4 }, { id: r5 }]));
    });
    await test.step('result', async () => {
      expect(await q(`${A}&${month}&result=DELIVERED`), 'DELIVERED').toEqual(ids([{ id: r1 }, { id: r5 }]));
      expect(await q(`${A}&${month}&result=SMS_FALLBACK`), 'SMS_FALLBACK').toEqual(ids([{ id: r4 }]));
      expect(await q(`${A}&${month}&result=FAILED`), 'FAILED(전송 실패 탭)').toEqual(ids([{ id: r2 }]));
      expect(await q(`${A}&${month}&result=NOT_SENT`), 'NOT_SENT').toEqual(ids([{ id: r3 }]));
    });
    await test.step('period', async () => {
      expect(await q(`${A}&period=TODAY`), 'TODAY').toEqual(ids([{ id: r1 }, { id: r2 }, { id: r3 }]));
      expect(await q(`${A}&period=LAST_7_DAYS`), 'LAST_7_DAYS').toEqual(ids([{ id: r1 }, { id: r2 }, { id: r3 }, { id: r4 }]));
      expect(await q(`${A}&period=LAST_30_DAYS`), 'LAST_30_DAYS').toEqual(ids([{ id: r1 }, { id: r2 }, { id: r3 }, { id: r4 }, { id: r5 }]));
      expect(await q(A), '생략하면 LAST_7_DAYS').toEqual(ids([{ id: r1 }, { id: r2 }, { id: r3 }, { id: r4 }]));
      expect(await q(`${A}&${month}&category=SOS&result=FAILED`), '두 조건을 함께 걸면 겹치는 것만(40일 전 행은 기간 밖)').toEqual([]);
    });
    await test.step('keyword', async () => {
      expect(await q(`keyword=${tagA.slice(0, 10)}&${month}`), '이름 일부로 조회').toEqual(ids([{ id: r1 }, { id: r2 }, { id: r3 }, { id: r4 }, { id: r5 }]));
      expect(await q(`keyword=${tagA.toUpperCase()}&${month}`), '대소문자 무시').toEqual(ids([{ id: r1 }, { id: r2 }, { id: r3 }, { id: r4 }, { id: r5 }]));
      expect(await q(`keyword=${tagA}w&${month}`), '피보호자 이름으로도 찾아진다').toEqual(ids([{ id: r1 }, { id: r2 }, { id: r3 }, { id: r4 }, { id: r5 }]));
      expect(await q(`keyword=${tagB}&${month}`), '받는 사람 이름으로 찾으면 그 사람이 받은 행만').toEqual(ids([{ id: b1 }]));
      expect(await q(`keyword=${tagB}`), '다른 조각의 행은 섞이지 않는다').not.toContain(r1);
    });
    expect(r6, '40일 전 행은 어느 기간에도 안 든다(위 단언의 전제)').toBeGreaterThan(0);
  });

  test('NOTI-A64 size 상한 50 초과·0·음수, page 음수, 잘못된 period/category/result', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.info().annotations.push({
      type: '문서와 코드',
      description: '케이스 기대는 "보정(최대 50) 또는 400". 코드(AdminPaging, 컨트롤러 enum 파라미터)로 한 값씩 고정: size>50 은 50, size<=0 은 20(기본), page<0 은 0 으로 보정하고, 잘못된 category·result·period 와 숫자 아닌 page·size 는 400 INVALID_INPUT',
    });
    const tag = uniqueNameTag();
    const admin = await tempUser('ADMIN');
    const { guardian, ward } = await pair(tempUser, tag);
    const ad = await loginAs(admin);
    for (let k = 1; k <= 3; k++) insertLogRow({ recipientId: guardian.id, wardId: ward.id, type: 'WARD_SOS', result: 'FAILED', createdAtSql: `now() - interval '${k} minutes'` });
    const K = `keyword=${tag}`;

    await test.step('보정: 크기·쪽 번호', async () => {
      expect((await listOf(ad.api, `${K}&size=51`)).size, 'size=51 -> 50').toBe(50);
      expect((await listOf(ad.api, `${K}&size=1000`)).size, 'size=1000 -> 50').toBe(50);
      expect((await listOf(ad.api, `${K}&size=50`)).size, 'size=50 은 그대로').toBe(50);
      expect((await listOf(ad.api, `${K}&size=0`)).size, 'size=0 -> 20(기본)').toBe(20);
      expect((await listOf(ad.api, `${K}&size=-5`)).size, 'size=-5 -> 20(기본)').toBe(20);
      expect((await listOf(ad.api, `${K}&page=-1`)).page, 'page=-1 -> 0').toBe(0);
      const huge = await get(ad.api, `${LIST}?${K}&page=2147483647&size=50`);
      expect(huge.status, '아주 큰 page 도 500 이 아니라 200(마지막 가능 쪽으로 보정)').toBe(200);
      expect((huge.body.data as PageBody).content, '그 쪽에는 내 행이 없다').toEqual([]);
    });

    await test.step('400: 잘못된 값', async () => {
      const bad: Record<string, string> = {
        'period=ALL': `${LIST}?${K}&period=ALL`,
        'period=YESTERDAY': `${LIST}?${K}&period=YESTERDAY`,
        'category=ETC': `${LIST}?${K}&category=ETC`,
        'result=WRONG': `${LIST}?${K}&result=WRONG`,
        'size=abc': `${LIST}?${K}&size=abc`,
        'page=abc': `${LIST}?${K}&page=abc`,
        'summary period=ALL': `${SUMMARY}?${K}&period=ALL`,
        'summary category=ETC': `${SUMMARY}?${K}&category=ETC`,
      };
      for (const [label, path] of Object.entries(bad)) {
        const r = await get(ad.api, path);
        expect.soft(r.status, `${label}: 400(500 이 아니다)`).toBe(400);
        expect.soft(r.body.code, `${label}: 오류 코드`).toBe('INVALID_INPUT');
      }
    });
  });
});

test.describe('관리자 알림 이력 줄 수', () => {
  test('NOTI-N50 연결·SOS 등 발송 1건당 받는 사람별 1줄, 복약은 같은 시각 묶음당 1줄', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(420_000);
    const tag = uniqueNameTag();
    const admin = await tempUser('ADMIN');
    const ward = await tempUser('WARD', { name: `${tag}w`, phone: null });
    const g1 = await tempUser('GUARDIAN', { name: `${tag}a`, phone: null });
    const g2 = await tempUser('GUARDIAN', { name: `${tag}b`, phone: null });
    const requester = await tempUser('GUARDIAN', { name: `${tag}c`, phone: null });
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const [ad, w, rq] = [await loginAs(admin), await loginAs(ward), await loginAs(requester)];

    await test.step('연결 요청 1건 -> 받는 사람(피보호자) 1줄', async () => {
      const res = await rq.api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation: '딸' });
      expect(res.status(), '연결 요청 200').toBe(200);
      await waitForLog(ward.id, 'CONNECTION_REQUEST');
      expect(logRows(ward.id, 'CONNECTION_REQUEST'), '피보호자 1줄').toHaveLength(1);
      expect(logRows(requester.id), '요청한 보호자에게는 알림 이력이 없다').toHaveLength(0);
    });

    await test.step('SOS 1건, 보호자 2명 -> 2줄', async () => {
      await sendSos(w.api);
      await waitForLog(g1.id, 'WARD_SOS');
      await waitForLog(g2.id, 'WARD_SOS');
      expect(logRows(g1.id, 'WARD_SOS'), 'g1 1줄').toHaveLength(1);
      expect(logRows(g2.id, 'WARD_SOS'), 'g2 1줄').toHaveLength(1);
      expect(logRows(ward.id, 'WARD_SOS'), '피보호자 본인에게는 SOS 줄이 없다').toHaveLength(0);
    });

    await test.step('복약: 같은 시각에 약 2개 -> 피보호자에게 묶음 1줄', async () => {
      const minutes = Number(psql(`SELECT (extract(hour from (now() AT TIME ZONE 'Asia/Seoul')) * 60 + extract(minute from (now() AT TIME ZONE 'Asia/Seoul')))::int;`));
      test.skip(minutes < 35, '자정 직후에는 알림 유예 창이 자정에서 잘려 시나리오를 만들 수 없다');
      // 재알림(15분 뒤)은 끈다. 최초 알림만 본다
      psql(`INSERT INTO medication_setting (user_id, alarm_enabled, remind_again_enabled) VALUES (${sqlStr(ward.id)}, true, false)
            ON CONFLICT (user_id) DO UPDATE SET alarm_enabled = true, remind_again_enabled = false;`);
      // 두 약의 복용 시각은 한 문자열로 정해 똑같이 넣는다(문장마다 now() 를 따로 쓰면 소수 초가 달라 다른 시각이 된다)
      const doseTime = psql(`SELECT to_char((now() AT TIME ZONE 'Asia/Seoul') - interval '2 minutes', 'HH24:MI:00');`);
      for (const name of ['QA약A', 'QA약B']) {
        psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time, dose_amount)
              VALUES (${sqlStr(ward.id)}, ${sqlStr(g1.id)}, ${sqlStr(name)}, 'MORNING', ${sqlStr(doseTime)}, 1);`);
      }
      const reminderLogs = () =>
        Number(psql(`SELECT count(*) FROM medication_reminder_log r JOIN medication m ON m.id = r.medication_id WHERE m.ward_id = ${sqlStr(ward.id)} AND r.attempt = 1;`));
      await expect
        .poll(() => logRows(ward.id, 'MEDICATION_REMINDER').length, { timeout: 200_000, intervals: [5_000, 10_000], message: '복약 알림(스케줄러 1분 주기)이 피보호자에게 기록돼야 한다 - 스케줄러가 꺼져 있으면 이 단계는 성립하지 않는다' })
        .toBeGreaterThanOrEqual(1);
      await expect.poll(reminderLogs, { timeout: 60_000, intervals: [2_000, 5_000], message: '두 약 모두 발송 선점 기록이 있어야 한다' }).toBe(2);
      expect(logRows(ward.id, 'MEDICATION_REMINDER'), '약은 2개지만 같은 시각 묶음이라 알림 이력은 1줄').toHaveLength(1);
    });

    await test.step('관리자 목록에서도 같은 줄 수', async () => {
      const mine = async (category: string) => {
        const page = await listOf(ad.api, `keyword=${tag}&period=TODAY&category=${category}&size=50`);
        return page.content.filter(i => i.wardId === ward.id);
      };
      const sos = await mine('SOS');
      expect(sos.map(i => i.recipientId).sort(), 'SOS: 받는 사람 수만큼').toEqual([g1.id, g2.id].sort());
      const other = await mine('OTHER');
      expect(other.filter(i => i.type === 'CONNECTION_REQUEST').map(i => i.recipientId), '연결 요청: 피보호자 1줄').toEqual([ward.id]);
      const med = await mine('MEDICATION');
      expect(med.filter(i => i.type === 'MEDICATION_REMINDER').map(i => i.recipientId), '복약: 묶음 1줄').toEqual([ward.id]);
    });
  });
});
