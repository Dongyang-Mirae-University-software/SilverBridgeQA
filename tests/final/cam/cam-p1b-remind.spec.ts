/**
 * 최종 QA - 카메라·이상감지(CAM) P1b - 판정 재질문(재촉) 스케줄러
 *
 * 재촉은 BE 가 5분마다 도는 스케줄러(공용)가 보낸다. 그래서 임시 피보호자 자신의 상황을 DB 에 시간만 옮겨 시드하고
 * (1시간 전에 닫힌 상황 등), 스케줄러가 한 바퀴 돌 때까지 기다린 뒤 "발송 선점 기록"(anomaly_review_*_log)과 알림 이력을 본다.
 * 시나리오 하나를 한 번 만들어 N41·N43·N44·N45 가 나눠 본다(스케줄러 한 바퀴 = 최대 약 6분).
 * 등록된 카메라의 상황에만 재촉이 가므로 카메라를 실제로 등록한다(서비스 전체 상한 3대 - 자리가 날 때까지 기다림, 끝나면 바로 지움).
 * 임시 보호자는 푸시 기기가 없어 실제 푸시는 나가지 않고, 재촉 채널은 앱 푸시뿐이라 문자·알림톡도 나가지 않는다.
 * 시각은 바꿀 수 없다: 낮 시간(08~22시 KST)에만 발송 케이스를 볼 수 있고, 밤 시간 케이스(N42)는 밤에만 돈다.
 */
import { Api } from '../../../src/api';
import { expect, test } from '../../../src/fixtures';
import { psqlRows, sqlStr } from '../../../src/remote';
import {
  cleanupAll,
  connect,
  deleteCamera,
  feedback,
  history,
  incidentIdsOfWard,
  kstHour,
  loginUser,
  Logged,
  mkUser,
  registerOk,
  rowsRetry,
  seedIncident,
  sleep,
  summary,
  TAGS,
  totalCameras,
  waitForCameraSlots,
  waitUntil,
} from './_helpers-cam-p1b';

test.afterAll(async () => {
  scenarioPromise = undefined;
  await cleanupAll();
});

const isQuiet = (hour: number) => hour >= 22 || hour < 8;

interface Snapshot {
  hourAtCycle: number;
  reminders: { incidentId: number; guardianId: string }[];
  conflicts: { incidentId: number; guardianId: string; sent: boolean }[];
  summaries: { guardianId: string; pendingCount: number }[];
  notices: { recipientId: string; type: string; title: string; body: string }[];
}

interface Scenario {
  ward: Logged;
  ga: Logged;
  gb: Logged;
  gc: Logged;
  gs: Logged;
  admin: Logged;
  c1: { id: number; sessionId: string };
  ids: { i1: number; i1x: number; i3: number; i5: number; i6: number; i8: number; i9: number; is: number };
  gcSetting: { putStatus: number; putEnabled: boolean | undefined; getEnabled: boolean | undefined };
  gbDefault: boolean | undefined;
  snapshot: Snapshot;
  /** 관리자 집계(이 피보호자 이름으로 좁힘): 시드 전 / 삭제된 카메라 상황 2건 시드 후 / 카메라 삭제 후 */
  adminTotals: { before: number; seeded: number; afterDelete: number; fireAfterDelete: number };
}

let scenarioPromise: Promise<Scenario> | undefined;

function getScenario(): Promise<Scenario> {
  scenarioPromise ??= build().catch(error => {
    scenarioPromise = undefined;
    throw error;
  });
  return scenarioPromise;
}

async function setReminder(api: Api, enabled: boolean) {
  const res = await api.raw('PUT', '/api/guardian/anomaly/reminder-setting', { reviewReminderEnabled: enabled });
  const json = (await res.json().catch(() => ({}))) as { data?: { reviewReminderEnabled?: boolean } };
  return { status: res.status(), enabled: json.data?.reviewReminderEnabled };
}

async function getReminder(api: Api) {
  const res = await api.raw('GET', '/api/guardian/anomaly/reminder-setting');
  const json = (await res.json().catch(() => ({}))) as { data?: { reviewReminderEnabled?: boolean } };
  return json.data?.reviewReminderEnabled;
}

const inList = (ids: number[]) => (ids.length ? ids.join(',') : '0');

const WARD_NAME = 'E2E재촉피보';

/** 관리자 집계(GET /api/admin/anomaly/summary)의 total. 전체 집계라 다른 영역 영향을 피하려고 이 피보호자 이름(keyword)으로 좁힌다 */
async function adminTotal(api: Api, type?: string): Promise<number> {
  const res = await api.raw('GET', `/api/admin/anomaly/summary?keyword=${encodeURIComponent(WARD_NAME)}${type ? `&type=${type}` : ''}`);
  expect(res.status(), '관리자 집계 조회').toBe(200);
  const json = (await res.json()) as { data?: { total?: number } };
  return Number(json.data?.total);
}

/** KST 기준 하루 중 몇 분째인지 */
function kstMinuteOfDay(): number {
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return (h % 24) * 60 + m;
}

/**
 * 피보호자 W 에 카메라 거실(C1, 서비스 전체 상한 때문에 한 대만 쓴다)과 삭제된 카메라(C3, 상황만 남음), 보호자 GA·GB·GC(재촉 끔)·GS(요약용).
 *   i1  C1 확인필요(1시간 15분 전 닫힘)   - 재촉 대상 / i1x C1 3일이 지난 상황 - 재촉 중단 (사용 중지 카메라는 N45 에서 한 바퀴를 더 돈다)
 *   i3  C1 확인필요, GA 가 먼저 응답     - GB 에게 재촉 안 감 / i5 C1 확인필요(GC 가 나중에 답함)
 *   i6  삭제된 카메라 확인필요           - 재촉 안 감 / i8 삭제된 카메라 동수 - 동수 안내 안 감 / i9 C1 동수(대조군) - 동수 안내 감
 *   is  C1 확인필요 + 3시간 전 재촉 기록(GS) - 요약 시각(20:00) 뒤에만 요약
 */
async function build(): Promise<Scenario> {
  const hour = kstHour();
  test.skip(isQuiet(hour), `야간(22~08시 KST, 현재 ${hour}시)에는 재촉 스케줄러가 발송을 미루므로 발송 케이스를 볼 수 없다`);

  // 20:00 요약 단계를 볼 수 있게 20:00~21:40 에 돌리는 것을 권장한다. 21:40 이후에 시작하면 스케줄러 한 바퀴 안에 22시(밤)가 될 수 있어 건너뛴다
  const minute = kstMinuteOfDay();
  test.skip(minute >= 21 * 60 + 40, `밤(22시) 직전(현재 ${hour}시 ${minute % 60}분)에 시작하면 스케줄러 바퀴가 밤에 걸려 결과가 흔들린다`);

  const wardU = mkUser('WARD', WARD_NAME);
  const [gaU, gbU, gcU, gsU] = [mkUser('GUARDIAN', 'E2E재촉A'), mkUser('GUARDIAN', 'E2E재촉B'), mkUser('GUARDIAN', 'E2E재촉C'), mkUser('GUARDIAN', 'E2E재촉S')];
  const adminU = mkUser('ADMIN');
  for (const g of [gaU, gbU, gcU, gsU]) connect(g.id, wardU.id);
  const ward = await loginUser(wardU);
  const [ga, gb, gc, gs] = [await loginUser(gaU), await loginUser(gbU), await loginUser(gcU), await loginUser(gsU)];
  const admin = await loginUser(adminU);

  const ok = await waitForCameraSlots(1, 540_000);
  test.skip(!ok, `카메라 상한 여유 없음(서비스 전체 ${totalCameras()}대 / 상한 3대, 1자리 필요) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다`);

  // 삭제된 카메라(C3): 등록 -> 상황 시드 -> 카메라 삭제. 삭제된 카메라의 세션만 남는다
  const c3 = await registerOk(ward.api, '현관');
  const adminBefore = await adminTotal(admin.api);
  const i6 = seedIncident({ wardId: wardU.id, sessionId: c3.sessionId, startedAgoMin: 80, lastAgoMin: 75 });
  const i8 = seedIncident({ wardId: wardU.id, sessionId: c3.sessionId, startedAgoMin: 80, lastAgoMin: 75 });
  const adminSeeded = await adminTotal(admin.api);
  expect(await deleteCamera(ward.api, c3.id), '준비: 카메라(현관) 삭제').toBe(200);
  const adminAfterDelete = await adminTotal(admin.api);
  const adminFireAfterDelete = await adminTotal(admin.api, 'FIRE');

  const c1 = await registerOk(ward.api, '거실');

  const i1 = seedIncident({ wardId: wardU.id, sessionId: c1.sessionId, startedAgoMin: 80, lastAgoMin: 75 });
  const i1x = seedIncident({ wardId: wardU.id, sessionId: c1.sessionId, startedAgoMin: 4500, lastAgoMin: 4490 });
  const i3 = seedIncident({ wardId: wardU.id, sessionId: c1.sessionId, startedAgoMin: 80, lastAgoMin: 75 });
  const i5 = seedIncident({ wardId: wardU.id, sessionId: c1.sessionId, startedAgoMin: 80, lastAgoMin: 75 });
  const i9 = seedIncident({ wardId: wardU.id, sessionId: c1.sessionId, startedAgoMin: 80, lastAgoMin: 75 });
  const isId = seedIncident({ wardId: wardU.id, sessionId: c1.sessionId, startedAgoMin: 210, lastAgoMin: 200 });
  psqlRows(`INSERT INTO anomaly_review_reminder_log (incident_id, guardian_id, sent_at) VALUES (${isId}, ${sqlStr(gsU.id)}, now() - interval '3 hours') RETURNING id;`);

  // 응답: i3 은 GA 만, i8·i9 는 GA(실제 위험) / GB(오탐) 로 동수
  expect((await feedback(ga.api, i3, 'REAL')).status, '준비: GA 가 i3 에 응답').toBe(200);
  for (const id of [i8, i9]) {
    expect((await feedback(ga.api, id, 'REAL')).status, `준비: GA 응답(${id})`).toBe(200);
    const b = await feedback(gb.api, id, 'FALSE_ALARM');
    expect(b.status, `준비: GB 응답(${id})`).toBe(200);
    expect(b.json.data?.reviewStatus, `준비: ${id} 은 1:1 동수`).toBe('CONFLICTED');
  }
  // GC 는 재질문을 끈다. GB 는 설정을 건드리지 않은 기본값
  const put = await setReminder(gc.api, false);
  const gcSetting = { putStatus: put.status, putEnabled: put.enabled, getEnabled: await getReminder(gc.api) };
  const gbDefault = await getReminder(gb.api);

  // 스케줄러가 한 바퀴 돌 때까지(대조군: GA 의 i1 재촉 기록) 기다린다. 5분마다 도는 공용 스케줄러라 최대 약 6분
  const guardians = [ga, gb, gc, gs].map(g => sqlStr(g.user.id)).join(',');
  const reminded = await waitUntil(
    () => Number(psqlRows(`SELECT count(*) FROM anomaly_review_reminder_log WHERE incident_id = ${i1} AND guardian_id = ${sqlStr(gaU.id)};`)[0][0]) === 1,
    450_000,
    10_000,
  );
  expect(reminded, '스케줄러(5분 주기)가 돌지 않았다 - 대조군 상황 i1 의 재촉 기록이 7분 30초 안에 생기지 않음(재촉 기능 꺼짐 또는 서버 시각 문제)').toBe(true);
  // 같은 바퀴의 동수 안내·요약 단계가 끝나도록 대조군(i9 동수 안내)이 나올 때까지 기다린다
  await waitUntil(
    () => Number(psqlRows(`SELECT count(*) FROM anomaly_review_conflict_log WHERE incident_id = ${i9} AND guardian_id = ${sqlStr(gaU.id)} AND sent = true;`)[0][0]) === 1,
    90_000,
    5_000,
  );
  await sleep(15_000);

  const wardIds = inList(incidentIdsOfWard(wardU.id));
  const snapshot: Snapshot = {
    hourAtCycle: kstHour(),
    reminders: psqlRows(`SELECT incident_id, guardian_id FROM anomaly_review_reminder_log WHERE incident_id IN (${wardIds}) ORDER BY id;`).map(r => ({ incidentId: Number(r[0]), guardianId: r[1] })),
    conflicts: psqlRows(`SELECT incident_id, guardian_id, sent FROM anomaly_review_conflict_log WHERE incident_id IN (${wardIds}) ORDER BY id;`).map(r => ({ incidentId: Number(r[0]), guardianId: r[1], sent: r[2] === 't' })),
    summaries: psqlRows(`SELECT guardian_id, pending_count FROM anomaly_review_summary_log WHERE guardian_id IN (${guardians}) ORDER BY id;`).map(r => ({ guardianId: r[0], pendingCount: Number(r[1]) })),
    notices: psqlRows(`SELECT recipient_id, type, replace(title, E'\\n', ' '), replace(body, E'\\n', ' ') FROM notification_log WHERE recipient_id IN (${guardians}) AND type LIKE 'ANOMALY_REVIEW%' ORDER BY id;`).map(r => ({ recipientId: r[0], type: r[1], title: r[2], body: r[3] })),
  };
  return { ward, ga, gb, gc, gs, admin, c1, ids: { i1, i1x, i3, i5, i6, i8, i9, is: isId }, gcSetting, gbDefault, snapshot, adminTotals: { before: adminBefore, seeded: adminSeeded, afterDelete: adminAfterDelete, fireAfterDelete: adminFireAfterDelete } };
}

const remindedPairs = (s: Scenario, incidentId: number) => s.snapshot.reminders.filter(r => r.incidentId === incidentId).map(r => r.guardianId).sort();

test.describe('카메라·이상감지 P1b - 판정 재질문', () => {
  // 시나리오(카메라·사용자)를 한 번만 만들어 케이스들이 나눠 본다. 병렬이면 워커마다 따로 만들어 카메라·6분 대기가 늘어나므로 순서대로 돌린다
  test.describe.configure({ mode: 'serial' });

  test('CAM-N41 무응답 상황의 1시간 뒤 재질문과 저녁 8시 요약', TAGS, async () => {
    test.setTimeout(1_200_000);
    const s = await getScenario();
    const { i1, i1x, i5, is } = s.ids;
    const [ga, gb] = [s.ga.user.id, s.gb.user.id];

    // 1) 상황이 닫히고(마지막 감지 + 10분) 1시간이 지난 미응답 상황은 보호자마다 한 번 재질문(재촉)이 기록된다
    const gs = s.gs.user.id;
    expect(remindedPairs(s, i1), 'i1 재촉 대상: 연결된 GA·GB·GS 에게 각각 정확히 1번(재촉을 끈 GC 는 빠짐)').toEqual([ga, gb, gs].sort());
    expect(remindedPairs(s, i5), 'i5 재촉').toEqual([ga, gb, gs].sort());
    // 알림 이력: 재촉 문구는 요청이지 통보가 아니다(위험 여부를 단정하지 않음)
    const mine = s.snapshot.notices.filter(n => n.recipientId === ga && n.type === 'ANOMALY_REVIEW_REQUIRED' && /거실/.test(n.body));
    expect(mine.length, 'GA 의 재질문 알림 이력(거실 카메라 상황 i1·i5·is 세 건)').toBe(3);
    for (const n of mine) {
      expect(n.title).toBe('이상감지 확인이 필요해요');
      expect(n.body, '확인을 부탁하는 문구').toContain('실제 상황이었는지 확인해 주세요.');
      expect(n.body, '화재 감지가 있었다는 사실까지만 말한다').toContain('화재 감지가 있었습니다.');
      expect(n.body, '단정하는 말(발생했습니다)을 쓰지 않는다').not.toContain('발생했습니다');
    }
    // 2) 3일이 지난 상황(상황 시작 기준)은 더 묻지 않는다
    expect(remindedPairs(s, i1x), '3일이 지난 상황 i1x 는 재촉 중단').toEqual([]);

    // 3) 하루 1번 요약: 20:00 KST 부터. 이미 건별 재촉을 2시간 안에 받은 보호자(GA)는 요약에서 뺀다(건별 재촉이 3시간 전인 GS 만)
    const hour = s.snapshot.hourAtCycle;
    const gsSummary = s.snapshot.summaries.filter(x => x.guardianId === s.gs.user.id);
    const gaSummary = s.snapshot.summaries.filter(x => x.guardianId === ga);
    expect(gaSummary, '방금 건별 재촉을 받은 GA 에게는 요약을 보내지 않는다(2시간 안)').toEqual([]);
    // is 는 GS 만 3시간 전 재촉 기록을 시드했다. GA·GB 는 이번 바퀴에 처음 재촉을 받고, GS 는 이미 받았으니 다시 받지 않는다(1행 그대로)
    expect(remindedPairs(s, is), 'is 재촉 기록: GA·GB 는 이번에 새로, GS 는 시드한 1행 그대로').toEqual([ga, gb, s.gs.user.id].sort());
    expect(s.snapshot.reminders.filter(r => r.incidentId === is && r.guardianId === s.gs.user.id).length, 'GS 는 같은 상황에 두 번 재촉받지 않는다').toBe(1);
    if (hour >= 20) {
      expect(gsSummary.map(x => x.pendingCount), `요약 시각(20:00) 뒤(${hour}시) GS 에게 하루 1번, 미응답 1건`).toEqual([1]);
      const notice = s.snapshot.notices.find(n => n.recipientId === s.gs.user.id && /건 있습니다/.test(n.body));
      expect(notice?.body, '요약 문구').toContain('확인이 필요한 이상감지가 1건 있습니다.');
    } else {
      expect(gsSummary, `요약 시각(20:00) 전(${hour}시)에는 요약을 보내지 않는다`).toEqual([]);
      test.info().annotations.push({ type: '확인하지 못한 부분', description: `20:00 요약 발송은 요약 시각 뒤에만 볼 수 있다(지금 ${hour}시). 20:00 전에는 요약이 없다는 것까지만 확인. 요약 발송 단계는 20:00~21:40 KST 에 다시 돌려 확인한다(예약 실행)` });
    }
    test.info().annotations.push({
      type: '문서와 차이',
      description: '요약 문구는 코드 기준 "확인이 필요한 이상감지가 N건 있습니다"(문서의 "아직 답 안 하신 게 N건"은 풀어 쓴 표현). 재질문이 한 번만 가는 것은 선점 기록(보호자·상황당 1행)으로 확인 - 두 번째 바퀴는 기다리지 않음',
    });
  });

  test('CAM-N42 밤 22시~8시는 묻지 않고 아침으로 미룸', TAGS, async () => {
    // 두 단계(예약 실행): 22시 이후에 시작해 (1) 밤에는 재촉이 없는 것을 보고 (2) 같은 상황이 08:00 이후 첫 바퀴에서 재촉으로 기록되는 것(대조군)을 본다.
    // 대조군이 있어야 스케줄러가 꺼져 있어서 통과하는 헛통과를 막고 "아침 8시 이후 발송"도 함께 확인된다.
    // 주의: 밤새 카메라 1대 자리를 잡고 있다(서비스 전체 상한 3대). 아침까지 다른 영역의 카메라 등록과 겹치지 않게 예약한다.
    const hour = kstHour();
    test.skip(!isQuiet(hour), `야간(22~08시 KST)에만 시작할 수 있다(현재 ${hour}시). 시각은 바꿀 수 없어 낮에는 건너뛴다(22시 이후 예약 실행)`);
    const minuteNow = kstMinuteOfDay();
    const minutesToMorning = minuteNow >= 22 * 60 ? 24 * 60 - minuteNow + 8 * 60 : 8 * 60 - minuteNow;
    test.setTimeout((minutesToMorning + 25) * 60_000);
    const ward = await loginUser(mkUser('WARD'));
    const g = await loginUser(mkUser('GUARDIAN'));
    connect(g.user.id, ward.user.id);
    const gotSlot = await waitForCameraSlots(1, 540_000);
    test.skip(!gotSlot, `카메라 상한 여유 없음(서비스 전체 ${totalCameras()}대 / 상한 3대) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다`);
    const cam = await registerOk(ward.api, '거실');
    const id = seedIncident({ wardId: ward.user.id, sessionId: cam.sessionId, startedAgoMin: 80, lastAgoMin: 75 });
    const reminderRows = () => Number(rowsRetry(`SELECT count(*) FROM anomaly_review_reminder_log WHERE incident_id = ${id};`)[0][0]);

    // 1단계: 스케줄러가 한 바퀴 이상 돌 시간(5분 + 여유) 동안 재촉 기록이 생기지 않아야 한다(생기면 바로 끝낸다)
    const nightSent = await waitUntil(() => reminderRows() > 0, 6 * 60_000 + 20_000, 20_000);
    expect(nightSent, '밤에는 재촉을 선점하지 않는다(조건은 남아 아침 첫 바퀴에 다시 잡힌다)').toBe(false);
    expect(psqlRows(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(g.user.id)} AND type = 'ANOMALY_REVIEW_REQUIRED';`)[0][0], '밤에는 재질문 알림이 없다').toBe('0');

    // 2단계(대조군): 08:00 이후 첫 바퀴에서 같은 상황의 재촉이 기록된다. 08:00 이전에는 계속 없어야 한다
    const morning = await waitUntil(() => kstHour() >= 8 && kstHour() < 22, (minutesToMorning + 2) * 60_000, 60_000);
    expect(morning, '아침(08:00 KST)이 되어야 한다').toBe(true);
    const sentAfter8 = await waitUntil(() => reminderRows() === 1, 9 * 60_000, 15_000);
    expect(sentAfter8, '08:00 이후 첫 스케줄러 바퀴(최대 약 6분)에 같은 상황의 재촉이 기록돼야 한다(대조군 - 스케줄러가 꺼져 있으면 여기서 실패)').toBe(true);
    const sentHour = Number(rowsRetry(`SELECT extract(hour from sent_at at time zone 'Asia/Seoul')::int FROM anomaly_review_reminder_log WHERE incident_id = ${id};`)[0][0]);
    expect(sentHour, '재촉 기록 시각은 08시 이후(KST)').toBeGreaterThanOrEqual(8);
    expect(sentHour, '재촉 기록 시각은 22시 전(KST)').toBeLessThan(22);
    test.info().annotations.push({ type: '밤 -> 아침', description: `밤 6분 동안 재촉 0건, 아침 ${sentHour}시 첫 바퀴에서 1건` });
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: '"화재 감지 알림 자체는 밤에도 즉시"는 실제 화재 신호가 필요해 이 케이스에서는 확인하지 않았다(P0 CAM-N20 이 즉시 알림을 확인)',
    });
  });

  test('CAM-N43 한 명이 답하면 나머지에게 재촉 중단, 창구는 계속 열림', TAGS, async () => {
    test.setTimeout(1_200_000);
    const s = await getScenario();
    const { i1, i3, i9 } = s.ids;
    const [ga, gb] = [s.ga.user.id, s.gb.user.id];

    // 같은 시각(스케줄러 한 바퀴)에 i1(아무도 답 안 함)은 GA·GB 모두 재촉됐지만, GA 가 먼저 답한 i3 은 아무에게도 재촉이 안 갔다
    expect(remindedPairs(s, i1), '대조군: 아무도 답 안 한 i1 은 연결된 GA·GB·GS 모두 재촉(GC 는 끔)').toEqual([ga, gb, s.gs.user.id].sort());
    expect(remindedPairs(s, i3), 'GA 만 답한 i3 은 GB 에게 재촉이 가지 않는다(GA 에게도 안 감)').toEqual([]);
    expect(psqlRows(`SELECT review_status FROM anomaly_incident WHERE id = ${i3};`)[0][0], 'GA 가 REAL 로 답한 i3 의 판정').toBe('REAL');

    // 창구는 계속 열려 있다: GB 가 반대로 답하면 다수결을 다시 계산한다(1:1 동수)
    const b1 = await feedback(s.gb.api, i3, 'FALSE_ALARM');
    expect(b1.status, 'GB 응답').toBe(200);
    expect(b1.json.data?.reviewStatus, 'GA REAL + GB FALSE_ALARM = 동수').toBe('CONFLICTED');
    expect(b1.json.data?.myVerdict).toBe('FALSE_ALARM');
    expect(psqlRows(`SELECT review_status FROM anomaly_incident WHERE id = ${i3};`)[0][0], '저장된 판정도 동수').toBe('CONFLICTED');
    // 번복: GB 가 REAL 로 바꾸면 2:0 으로 REAL, 다시 오탐으로 바꾸면 동수
    const b2 = await feedback(s.gb.api, i3, 'REAL');
    expect(b2.json.data?.reviewStatus, 'GB 번복(REAL) -> 2:0').toBe('REAL');
    const b3 = await feedback(s.gb.api, i3, 'FALSE_ALARM');
    expect(b3.json.data?.reviewStatus, 'GB 다시 번복 -> 동수').toBe('CONFLICTED');
    expect(Number(psqlRows(`SELECT count(*) FROM anomaly_incident_feedback WHERE incident_id = ${i3};`)[0][0]), '응답은 1인 1표라 쌓이지 않는다').toBe(2);

    // 동수가 된 상황: 먼저 답한 보호자(GA)에게는 스케줄러가 재확인 안내 한 번(대조군 i9), 방금 답해 동수를 만든 GB 는 제외
    const conflict9 = s.snapshot.conflicts.filter(c => c.incidentId === i9);
    expect(conflict9.find(c => c.guardianId === ga)?.sent, 'i9: 먼저 답한 GA 에게 재확인 안내').toBe(true);
    expect(conflict9.find(c => c.guardianId === gb)?.sent, 'i9: 동수를 만든 GB 는 보내지 않음 기록').toBe(false);
    expect(s.snapshot.notices.filter(n => n.recipientId === ga && n.type === 'ANOMALY_REVIEW_CONFLICTED' && /거실/.test(n.body)).length, 'GA 의 동수 안내 알림 이력').toBe(1);
  });

  test("CAM-N44 '확인해 주세요' 알림만 끄기", TAGS, async () => {
    test.setTimeout(1_200_000);
    const s = await getScenario();
    const { i1, i5 } = s.ids;

    // 끄기 200, GET 도 false. 설정을 건드리지 않은 보호자(GB)의 기본값은 받음(true)
    expect(s.gcSetting.putStatus, '재질문 끄기').toBe(200);
    expect(s.gcSetting.putEnabled, 'PUT 응답').toBe(false);
    expect(s.gcSetting.getEnabled, 'GET 도 false').toBe(false);
    expect(s.gbDefault, '설정한 적 없는 보호자의 기본값은 받음').toBe(true);

    // 재질문 시각이 지난 같은 상황들(i1·i5)에서 GA·GB 는 받고 GC 는 안 간다
    for (const id of [i1, i5]) {
      const got = remindedPairs(s, id);
      expect(got, `상황 ${id}: 켜 둔 GA·GB 는 재촉 기록이 있다(대조군)`).toEqual(expect.arrayContaining([s.ga.user.id, s.gb.user.id]));
      expect(got, `상황 ${id}: 끈 GC 에게는 재촉이 가지 않는다`).not.toContain(s.gc.user.id);
    }
    expect(s.snapshot.notices.filter(n => n.recipientId === s.gc.user.id), '끈 GC 의 재질문 알림 이력').toEqual([]);

    // 끄는 것은 재질문만이다: 이력은 그대로 보이고, 판정(답하기)도 그대로 된다
    const all = await history(s.gc.api, `wardId=${s.ward.user.id}&size=50`);
    expect(all.status, '끈 뒤에도 이력 조회').toBe(200);
    expect(all.page?.totalElements, '이력 건수는 그대로(이 피보호자의 상황 전부)').toBe(incidentIdsOfWard(s.ward.user.id).length);
    const answer = await feedback(s.gc.api, i5, 'REAL');
    expect(answer.status, '끈 보호자도 판정은 그대로 한다').toBe(200);
    expect(answer.json.data?.myVerdict).toBe('REAL');
    // 다시 켜면 true
    const on = await setReminder(s.gc.api, true);
    expect(on.status).toBe(200);
    expect(await getReminder(s.gc.api), '다시 켬').toBe(true);
    test.info().annotations.push({ type: '확인하지 못한 부분', description: '"화재 알림 본체는 그대로"는 실제 화재 신호가 필요해 이 케이스에서는 확인하지 않았다(P0 CAM-N20 이 알림을, 이 묶음 CAM-N26 이 반복 알림을 확인)' });
  });

  test('CAM-N45 삭제된 카메라 상황은 재촉·요약·동수 안내에서 제외', TAGS, async () => {
    test.setTimeout(1_200_000);
    const s = await getScenario();
    const { i1, i6, i8, i9 } = s.ids;
    const [ga, gb] = [s.ga.user.id, s.gb.user.id];
    const wardId = s.ward.user.id;

    // 재촉: 삭제된 카메라 상황(i6)은 아무에게도 안 간다(사용 중지 카메라 상황은 아래에서 한 바퀴 더 돌려 본다)
    expect(remindedPairs(s, i1), '대조군: 등록된 카메라 상황은 재촉(GA·GB·GS, 끈 GC 제외)').toEqual([ga, gb, s.gs.user.id].sort());
    expect(remindedPairs(s, i6), '삭제된 카메라 상황 i6 은 재촉하지 않는다').toEqual([]);
    // 동수 안내: 삭제된 카메라(i8)는 안 가고, 같은 조건의 등록된 카메라(i9)는 간다
    expect(s.snapshot.conflicts.filter(c => c.incidentId === i9 && c.guardianId === ga && c.sent).length, '대조군: i9 동수 안내').toBe(1);
    expect(s.snapshot.conflicts.filter(c => c.incidentId === i8 && c.sent), '삭제된 카메라 동수(i8)에는 동수 안내가 가지 않는다').toEqual([]);
    expect(s.snapshot.conflicts.filter(c => c.incidentId === i8 && c.guardianId === ga), 'i8: GA 에게 안내 선점 기록도 없다').toEqual([]);
    // 요약: 삭제된 카메라 상황은 요약에 담지 않는다 - 요약 시각 뒤라면 GS 요약은 등록된 카메라의 1건뿐
    expect(s.snapshot.summaries.filter(x => x.guardianId === ga || x.guardianId === gb), '재촉 직후라 GA·GB 요약 없음').toEqual([]);
    if (s.snapshot.hourAtCycle >= 20) expect(s.snapshot.summaries.find(x => x.guardianId === s.gs.user.id)?.pendingCount, '요약 건수에 삭제된 카메라 상황이 섞이지 않는다').toBe(1);

    // 확인 필요 숫자에서 빠지고 deletedCameraCount 로 집계된다(숫자는 DB 의 이 피보호자 행으로 계산한 값과 같아야 한다)
    const rows = psqlRows(`SELECT i.session_id IN (SELECT session_id FROM camera WHERE ward_id = ${sqlStr(wardId)}), i.review_status, i.detected_type FROM anomaly_incident i WHERE i.ward_id = ${sqlStr(wardId)};`).map(r => ({ live: r[0] === 't', status: r[1], type: r[2] }));
    const liveRows = rows.filter(r => r.live);
    const expected = {
      total: liveRows.length,
      pendingCount: liveRows.filter(r => r.status === 'PENDING').length,
      conflictedCount: liveRows.filter(r => r.status === 'CONFLICTED').length,
      deletedCameraCount: rows.length - liveRows.length,
    };
    const sum = await summary(s.ga.api, `wardId=${wardId}`);
    expect(sum.status).toBe(200);
    expect(sum.data, '요약 숫자(등록된 카메라 기준 + 삭제된 카메라 따로)').toMatchObject({ ...expected, needsReviewCount: expected.pendingCount + expected.conflictedCount });
    expect(expected.deletedCameraCount, '준비: 삭제된 카메라 상황이 있다').toBe(2);
    expect(sum.data?.byType.fire, '유형별 건수는 등록된 카메라만').toBe(liveRows.filter(r => r.type === 'FIRE').length);

    // 직접 판정 API 는 삭제된 카메라 상황에도 성공한다
    const direct = await feedback(s.ga.api, i6, 'REAL');
    expect(direct.status, '삭제된 카메라 상황에 직접 판정').toBe(200);
    expect(direct.json.data?.myVerdict).toBe('REAL');

    // 관리자 통계(목록)는 전체 기록 기준: 삭제된 카메라 상황도 이 피보호자의 전체 건수에 들어간다
    const adminRes = await s.admin.api.raw('GET', `/api/admin/anomaly?wardId=${wardId}&size=50`);
    expect(adminRes.status(), '관리자 이력 조회').toBe(200);
    const adminJson = (await adminRes.json()) as { data: { totalElements: number; content: { incidentId: number; cameraLabel: string | null }[] } };
    expect(adminJson.data.totalElements, '관리자 이력은 삭제된 카메라 상황까지 전체').toBe(rows.length);
    expect(adminJson.data.content.filter(c => c.cameraLabel === null).length, '관리자 이력에서 삭제된 카메라 상황은 방 이름 null 로 남아 있다').toBe(expected.deletedCameraCount);
    // 관리자 집계(summary): 삭제된 카메라 상황 2건을 시드하면 그만큼 늘고, 카메라를 지운 뒤에도 줄지 않는다(이 피보호자 이름으로 좁힌 값의 차이만 본다)
    const t = s.adminTotals;
    test.info().annotations.push({ type: '관리자 집계', description: `시드 전 ${t.before} -> 시드 후 ${t.seeded} -> 카메라 삭제 후 ${t.afterDelete}, FIRE ${t.fireAfterDelete}` });
    expect(t.seeded - t.before, '관리자 집계(total)가 시드한 2건만큼 늘었다').toBe(2);
    expect(t.afterDelete, '카메라를 지운 뒤에도 관리자 집계는 줄지 않는다(전체 기록 기준)').toBe(t.seeded);
    expect(t.fireAfterDelete, '삭제된 카메라의 FIRE 상황도 유형 필터 집계에 들어 있다(2건 이상)').toBeGreaterThanOrEqual(2);
    expect(await adminTotal(s.admin.api), '지금 관리자 집계는 이 피보호자의 전체 상황 수와 같다').toBe(rows.length);

    // 사용 중지한 카메라 상황은 계속 묻는다(삭제가 아니다): 카메라를 사용 중지로 바꾸고 새 상황을 시드해 스케줄러가 한 바퀴 더 도는 것을 본다
    // (서비스 전체 카메라 상한 때문에 카메라를 한 대만 써서, 사용 중지 확인은 같은 카메라로 두 번째 바퀴에서 한다)
    expect((await s.ward.api.raw('PATCH', `/api/ward/camera/${s.c1.id}`, { isActive: false })).status(), '카메라 사용 중지').toBe(200);
    const i2 = seedIncident({ wardId, sessionId: s.c1.sessionId, startedAgoMin: 90, lastAgoMin: 85 });
    const afterOff = await summary(s.ga.api, `wardId=${wardId}`);
    expect(afterOff.data?.total, '사용 중지는 삭제가 아니라 요약에 그대로 센다(새 상황 포함)').toBe(expected.total + 1);
    expect(afterOff.data?.deletedCameraCount, '사용 중지 카메라 상황은 삭제된 카메라로 세지 않는다').toBe(expected.deletedCameraCount);
    const asked = await waitUntil(
      () => psqlRows(`SELECT count(*) FROM anomaly_review_reminder_log WHERE incident_id = ${i2} AND guardian_id IN (${sqlStr(ga)}, ${sqlStr(gb)});`)[0][0] === '2',
      480_000,
      10_000,
    );
    // 카메라 자리를 바로 돌려준다(afterAll 정리를 기다리지 않는다)
    await deleteCamera(s.ward.api, s.c1.id);
    expect(asked, '사용 중지한 카메라의 미응답 상황 i2 는 다음 스케줄러 바퀴에서 GA·GB 에게 재촉이 기록돼야 한다(8분 안에 안 생김)').toBe(true);
  });
});
