/**
 * 최종 QA - 카메라·이상감지(CAM) P2 - 판정 재질문(3일 경계, 동수 상황의 미응답 보호자)
 *
 * 재질문 스케줄러는 서비스 전체에서 5분마다 한 번 돈다(밤 22~08시 KST 에는 발송을 아침으로 미룸). 그래서 시나리오(카메라 1대,
 * 임시 보호자 3명, 시드 상황 3건)를 한 번만 만들고 한 바퀴를 기다린 뒤 두 케이스가 나눠 본다(serial).
 * 카메라 1대는 삭제된 카메라의 상황이 재질문에서 빠지는 규칙 때문에 꼭 필요하다. 쓴 카메라는 afterAll 에서 바로 지운다.
 * 임시 사용자만 쓰고, 재질문은 앱 푸시(FCM)뿐이라 문자·메일은 나가지 않는다.
 */
import type { Api } from '../../../src/api';
import { expect, test } from '../../../src/fixtures';
import { psqlRows, sqlStr } from '../../../src/remote';
import {
  cleanupAll,
  connect,
  countRows,
  feedback,
  history,
  isQuiet,
  kstHour,
  kstMinuteOfDay,
  loginUser,
  mkUser,
  needSlots,
  registerOk,
  seedIncident,
  TAGS,
  waitUntil,
  incidentRow,
} from './_helpers-cam-p2';

test.afterAll(async () => {
  await cleanupAll();
});

interface Scenario {
  wardId: string;
  ga: { id: string; api: Api };
  gb: { id: string; api: Api };
  gc: { id: string; api: Api };
  inside: number;
  outside: number;
  tie: number;
  remindersInside: string[];
  remindersOutside: string[];
  remindersTie: string[];
  conflictRows: { guardianId: string; sent: boolean }[];
  conflictNoticeCount: { ga: number; gc: number };
}

let scenario: Promise<Scenario> | undefined;

async function build(): Promise<Scenario> {
  const hour = kstHour();
  test.skip(isQuiet(hour), `야간(22~08시 KST, 현재 ${hour}시)에는 재질문 스케줄러가 발송을 아침으로 미루므로 이 케이스를 볼 수 없다`);
  const minute = kstMinuteOfDay();
  test.skip(minute >= 21 * 60 + 40, `밤(22시) 직전(현재 ${hour}시 ${minute % 60}분)에 시작하면 스케줄러 한 바퀴가 밤에 걸려 결과가 흔들린다`);

  const wardU = mkUser('WARD', 'E2E재질문본인');
  const [gaU, gbU, gcU] = [mkUser('GUARDIAN', 'E2E재질문A'), mkUser('GUARDIAN', 'E2E재질문B'), mkUser('GUARDIAN', 'E2E재질문C')];
  for (const g of [gaU, gbU, gcU]) connect(g.id, wardU.id);
  const ward = await loginUser(wardU);
  const [ga, gb, gc] = [await loginUser(gaU), await loginUser(gbU), await loginUser(gcU)];
  await needSlots(1);

  const cam = await registerOk(ward.api, '거실');
  const sid = cam.sessionId;
  // 3일(72시간) 경계: 71시간(2일 23시간) 전에 시작한 상황과 73시간(3일 1시간) 전에 시작한 상황. 둘 다 마지막 감지는 10분 뒤라 이미 닫힘
  const inside = seedIncident({ wardId: wardU.id, sessionId: sid, startedAgoMin: 71 * 60, lastAgoMin: 71 * 60 - 10 });
  const outside = seedIncident({ wardId: wardU.id, sessionId: sid, startedAgoMin: 73 * 60, lastAgoMin: 73 * 60 - 10 });
  // 동수 상황: 닫힌 지 1시간 15분. A 는 실제 위험, B 는 오탐으로 답해 1:1. C 는 답하지 않는다
  const tie = seedIncident({ wardId: wardU.id, sessionId: sid, startedAgoMin: 80, lastAgoMin: 75 });
  expect((await feedback(ga.api, tie, 'REAL')).status, '준비: A 응답').toBe(200);
  const b = await feedback(gb.api, tie, 'FALSE_ALARM');
  expect(b.status, '준비: B 응답').toBe(200);
  expect(b.json.data?.reviewStatus, '준비: 1:1 동수').toBe('CONFLICTED');

  // 스케줄러가 한 바퀴 돌 때까지 기다린다. 5분마다 도는 공용 스케줄러라 최대 약 6분
  const reminded = await waitUntil(() => countRows(`SELECT count(*) FROM anomaly_review_reminder_log WHERE incident_id = ${inside};`) >= 3, 450_000, 10_000);
  expect(reminded, '스케줄러(5분 주기)가 돌지 않았다 - 3일 안 상황의 재질문 기록이 7분 30초 안에 생기지 않음(재질문 기능이 꺼졌거나 서버 시각 문제)').toBe(true);
  const conflicted = await waitUntil(
    () => countRows(`SELECT count(*) FROM anomaly_review_conflict_log WHERE incident_id = ${tie} AND guardian_id = ${sqlStr(gaU.id)} AND sent = true;`) === 1,
    450_000,
    10_000,
  );
  expect(conflicted, '같은 바퀴의 동수 안내(대조군: 먼저 답한 A 에게 가는 안내)가 기록되지 않았다').toBe(true);

  const remindersOf = (id: number) =>
    psqlRows(`SELECT guardian_id FROM anomaly_review_reminder_log WHERE incident_id = ${id} ORDER BY guardian_id;`).map(r => r[0]);
  const conflictRows = psqlRows(`SELECT guardian_id, sent FROM anomaly_review_conflict_log WHERE incident_id = ${tie};`).map(r => ({ guardianId: r[0], sent: r[1] === 't' }));
  const noticeCount = (id: string) =>
    countRows(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(id)} AND type = 'ANOMALY_REVIEW_CONFLICTED';`);
  return {
    wardId: wardU.id,
    ga: { id: gaU.id, api: ga.api },
    gb: { id: gbU.id, api: gb.api },
    gc: { id: gcU.id, api: gc.api },
    inside,
    outside,
    tie,
    remindersInside: remindersOf(inside),
    remindersOutside: remindersOf(outside),
    remindersTie: remindersOf(tie),
    conflictRows,
    conflictNoticeCount: { ga: noticeCount(gaU.id), gc: noticeCount(gcU.id) },
  };
}

function getScenario() {
  scenario ??= build();
  return scenario;
}

test.describe('카메라·이상감지 P2 - 판정 재질문', () => {
  // 시나리오를 한 번만 만들어 두 케이스가 나눠 본다. 병렬이면 워커마다 따로 만들어 카메라·6분 대기가 늘어난다
  test.describe.configure({ mode: 'serial' });

  test('CAM-A34 재질문 3일 경계: 2일 23시간은 묻고 3일 1시간은 더 묻지 않는다', TAGS, async () => {
    test.setTimeout(1_200_000);
    const s = await getScenario();
    const all = [s.ga.id, s.gb.id, s.gc.id].sort();
    expect(s.remindersInside, '2일 23시간 된 미응답 상황은 세 보호자 모두에게 한 번씩 재질문 기록이 남는다').toEqual(all);
    expect(s.remindersOutside, '3일 1시간 된 미응답 상황은 같은 바퀴에서도 재질문 기록이 없다').toEqual([]);
    expect(incidentRow(s.outside)?.review, '3일이 지나도 상황은 지워지지 않고 확인 필요(PENDING) 그대로다').toBe('PENDING');
    // 기록·답하기는 그대로: 3일 지난 상황에도 보호자가 직접 열어 답할 수 있다
    const answer = await feedback(s.ga.api, s.outside, 'REAL');
    expect(answer.status, '3일 지난 상황에 답하기').toBe(200);
    expect(answer.json.data?.reviewStatus, '한 명이 실제 위험으로 답하면 REAL').toBe('REAL');
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: 'ANOMALY_REVIEW_REMINDER_ENABLED=false(서버 환경변수로 재질문만 끄기)는 서버 설정 변경이 필요해 확인하지 못했다. 3일 경계(71시간·73시간)는 위 값으로 확인했다',
    });
  });

  test('CAM-A35 동수 상황의 미응답 보호자에게는 안내·재촉이 가지 않고, 직접 열어 답하는 길은 열려 있다', TAGS, async () => {
    test.setTimeout(1_200_000);
    const s = await getScenario();
    // 대조군: 먼저 답한 A 에게는 동수 안내가 가고(sent=true), 방금 답해 동수를 만든 B 는 보내지 않은 기록(sent=false)만 남는다
    expect(s.conflictRows.find(r => r.guardianId === s.ga.id), '먼저 답한 A 의 동수 안내 기록').toEqual({ guardianId: s.ga.id, sent: true });
    expect(s.conflictRows.find(r => r.guardianId === s.gb.id), '동수를 만든 B 의 기록').toEqual({ guardianId: s.gb.id, sent: false });
    // 답하지 않은 C: 동수 안내 기록도 재촉 기록도 없다
    expect(
      s.conflictRows.filter(r => r.guardianId === s.gc.id),
      '미응답 C 에게는 동수 안내 기록이 없다',
    ).toEqual([]);
    expect(s.remindersTie, '동수가 된 상황에는 PENDING 이 아니라서 건별 재촉 기록도 없다').toEqual([]);
    expect(s.conflictNoticeCount.gc, '미응답 C 의 받은 알림 중 동수 안내').toBe(0);
    // 앱에서 직접 열어 답하는 길: C 의 이력에 동수 상황이 내 응답 없이 보이고, 답하면 2:1 로 REAL 이 된다
    const list = await history(s.gc.api, `wardId=${s.wardId}&size=50`);
    expect(list.status, 'C 의 이력 조회').toBe(200);
    const item = list.page?.content.find(i => i.incidentId === s.tie);
    expect(item, 'C 의 이력에 동수 상황이 보인다').toBeDefined();
    expect(item?.reviewStatus).toBe('CONFLICTED');
    expect(item?.myVerdict, 'C 는 아직 답하지 않았다').toBeNull();
    const answer = await feedback(s.gc.api, s.tie, 'REAL');
    expect(answer.status, 'C 가 직접 답하기').toBe(200);
    expect(answer.json.data?.reviewStatus, 'A 실제 위험·B 오탐·C 실제 위험 = 2:1 로 REAL').toBe('REAL');
  });
});
