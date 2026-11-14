/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1b: 안부 말벗 규칙 (시간대·창·7일 조회·질문 번호)
 * 근거: BE 프로젝트_설명.txt 3-21 (2440-2510행), CompanionService·CompanionGuardianService·CompanionProperties
 * dev 는 COMPANION_ENABLED=true, COMPANION_TEST_ALL_WARDS=true 이고 COMPANION_RISK_PATTERN_* 는 설정돼 있지 않다(기본 꺼짐).
 */
import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import {
  SLOTS, backdateConnection, call, expectedQuestion, kstDate, kstMinutes, openSessionRaw, seedFinishedSession, slotInWindowNow,
  wardSessionCount, withdrawQuietly,
} from './_helpers-chat-p1b';
import { finishSession } from './_helpers-chat';

const TAGS = { tag: ['@P1', '@CHAT'] };

test.describe('CHAT P1b - 안부 말벗 규칙', () => {
  test.fixme('CHAT-A31 COMPANION_ENABLED 꺼짐(기본) 환경', TAGS, async () => {
    // dev BE 는 COMPANION_ENABLED=true 로 떠 있고, 스위치를 끄려면 서버 설정·컨테이너를 바꿔야 해서 이 QA 에서는 할 수 없다.
    // 코드 기준 기대값(확인용): 기기 API 는 503 COMPANION_DISABLED(CompanionService.requireUsable), today 는 200 이고 currentSlot=null,
    // 질문 푸시(CompanionPromptScheduler)는 가지 않는다. 문서에는 코드명이 없고(확인 필요) 코드에만 있다.
  });

  // A32 는 실행 시각에 따라 두 갈래로 나눈다. 해당하지 않는 시각에는 skip(이유 명시)으로 남겨 "확인 안 됨"이 결과에 보이게 한다.
  // 창 안 갈래는 아무 창(09/12/15/18/21시 ~ +60분) 안에서, 창 밖 갈래는 창 밖 시각(예: 10:30)에 돌려야 확인된다.
  test('CHAT-A32a 창 안에서 시작하고, 마친 같은 시간대 두 번째 시작은 거절', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const windowSlot = slotInWindowNow();
    test.skip(windowSlot === null, '지금 시각(KST)이 창 밖이라 이 갈래는 확인되지 않았다. 창 안 시각에 다시 돌려야 한다.');
    test.skip(kstMinutes() % 60 >= 57, '창이 곧 닫히는 시각(창 끝 3분 이내)이라 도중에 창이 닫힐 수 있어 건너뛴다. 다른 시각에 다시 돌려야 한다.');
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    try {
      const today = await call(ward.api, 'GET', '/api/ward/companion/today');
      expect(today.status).toBe(200);
      expect(today.json.data.currentSlot, '서버가 알려 주는 지금 열 수 있는 시간대').toBe(windowSlot);
      expect(today.json.data.slots).toHaveLength(5);

      // 창 안: 처음 시작은 되고, 마친 뒤 같은 시간대 두 번째 시작은 거절된다 (시간대당 1번)
      const first = await openSessionRaw(ward.api, '/api/ward/companion/sessions');
      expect(first.status, '창 안 첫 시작').toBe(200);
      expect(first.raw.json.data.slot).toBe(windowSlot);
      const finished = await finishSession(ward.api, first.sessionId);
      expect(finished.status).toBe(200);
      const again = await call(ward.api, 'POST', '/api/ward/companion/sessions');
      expect(again.status, '마친 시간대 두 번째 시작').toBe(409);
      expect(again.json?.code).toBe('COMPANION_SLOT_DONE');
      expect(wardSessionCount(wardUser.id), '두 번째 시작은 대화를 더 만들지 않는다').toBe(1);
      const after = await call(ward.api, 'GET', '/api/ward/companion/today');
      expect(after.json.data.slots.find((s: { slot: string }) => s.slot === windowSlot).status).toBe('DONE');
      test.info().annotations.push({
        type: '문서와 차이',
        description: '문서에 코드명이 없어 확인 필요로 적혀 있었다. 코드는 창 밖 409 COMPANION_NOT_IN_WINDOW, 마친 시간대 409 COMPANION_SLOT_DONE. ' +
          '창 경계 08:59/09:00/09:59/10:00 는 서버 시계로만 정해져 API 로 만들 수 없다(코드: 시작 시각 이상, 시작+60분 미만).',
      });
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-A32b 창 밖 시각 시작은 거절', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    test.skip(slotInWindowNow() !== null, '지금 시각(KST)이 창 안이라 창 밖 거절은 확인되지 않았다. 창 밖 시각(예: 10:30)에 다시 돌려야 한다.');
    const toNextStart = Math.min(...SLOTS.map(s => ((Number(s.slice(0, 2)) * 60 - kstMinutes()) + 1440) % 1440));
    test.skip(toNextStart <= 3, '창이 곧 열리는 시각(시작 3분 전 이내)이라 도중에 창이 열릴 수 있어 건너뛴다. 다른 시각에 다시 돌려야 한다.');
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    try {
      const today = await call(ward.api, 'GET', '/api/ward/companion/today');
      expect(today.status).toBe(200);
      expect(today.json.data.currentSlot, '창 밖이라 지금 열 수 있는 시간대 없음').toBeNull();
      expect(today.json.data.slots).toHaveLength(5);
      // 창 밖(예: 10:30) 시작은 거절된다. 아무 대화도 만들어지지 않는다
      const out = await call(ward.api, 'POST', '/api/ward/companion/sessions');
      expect(out.status).toBe(409);
      expect(out.json?.code).toBe('COMPANION_NOT_IN_WINDOW');
      expect(wardSessionCount(wardUser.id), '거절된 시작은 대화 행을 남기지 않는다').toBe(0);
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-A38 보호자가 피보호자 동의를 바꾸거나 7일 넘은 날짜 조회', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    backdateConnection(guardianUser.id, wardUser.id, 30);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);
    const base = `/api/guardian/ward/${wardUser.id}/companion`;

    // 동의 변경은 보호자 토큰으로 403, 피보호자 값은 그대로 기본 꺼짐
    for (const consent of [true, false]) {
      const put = await call(guardian.api, 'PUT', '/api/ward/companion/transcript-consent', { consent });
      expect(put.status, `보호자가 consent=${consent} 로 바꾸기`).toBe(403);
    }
    const consent = await call(ward.api, 'GET', '/api/ward/companion/transcript-consent');
    expect(consent.json.data.consented, '피보호자 동의 값은 바뀌지 않았다').toBe(false);

    // 날짜별 조회: 오늘 포함 7일(오늘-6 ~ 오늘)만 열린다
    for (const [offset, label] of [[0, '오늘'], [-6, '6일 전(7일 중 가장 오래된 날)']] as const) {
      const res = await call(guardian.api, 'GET', `${base}/days/${kstDate(offset)}`);
      expect(res.status, `${label} 조회`).toBe(200);
      expect(res.json.data.date).toBe(kstDate(offset));
    }
    for (const [text, label] of [
      [kstDate(-7), '7일 전'],
      [kstDate(-8), '8일 전'],
      [kstDate(1), '내일(미래)'],
      ['2026-13-40', '잘못된 형식 2026-13-40'],
      ['abc', '날짜 아닌 문자'],
      ['2026-1-5', '0 없는 날짜'],
    ] as const) {
      const res = await call(guardian.api, 'GET', `${base}/days/${text}`);
      expect(res.status, `${label} 조회는 4xx`).toBe(400);
      expect(res.json?.code, `${label} 오류 코드`).toBe('COMPANION_DATE_OUT_OF_RANGE');
      expect(res.json?.data, `${label} 데이터 없음`).toBeUndefined();
    }

    // 대화 상세도 7일 밖은 막힌다 (경계 6일 전은 열린다)
    const oldId = seedFinishedSession(wardUser.id, { date: kstDate(-8), slot: '09:00', mood: 'CALM' });
    const edgeId = seedFinishedSession(wardUser.id, { date: kstDate(-6), slot: '09:00', mood: 'CALM' });
    const old = await call(guardian.api, 'GET', `${base}/sessions/${oldId}`);
    expect(old.status, '8일 전 대화 상세').toBe(400);
    expect(old.json?.code).toBe('COMPANION_DATE_OUT_OF_RANGE');
    const edge = await call(guardian.api, 'GET', `${base}/sessions/${edgeId}`);
    expect(edge.status, '6일 전 대화 상세').toBe(200);
    expect(edge.json.data.sessionId).toBe(edgeId);

    test.info().annotations.push({
      type: '기획 확인 필요',
      description: '정책 확인 필요(7일 전 포함 여부): 케이스 원문은 "7일 경계(7일 전)는 통과", 코드(VIEW_DAYS=7, 오늘 포함)는 7일 전을 400 으로 막는다. 문서(BE 2474행 "7일 안")는 어느 쪽인지 분명하지 않다. 지금 단언은 배포 코드 값을 유지한다.',
    });
    test.info().annotations.push({
      type: '문서와 차이',
      description: '케이스는 "7일 경계(7일 전)는 통과"인데 코드는 오늘 포함 7일이라 6일 전까지 통과하고 7일 전은 400 이다. ' +
        '코드 값(7일 전 400, 6일 전 200)으로 고정했다. 오류 코드명은 문서에 없고 코드에서 COMPANION_DATE_OUT_OF_RANGE(400).',
    });
  });

  test('CHAT-N31 오늘 시간대별 질문·상태 조회', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);

    // 시각이 분 경계를 넘으면 기대 상태가 달라질 수 있어, 호출 앞뒤 분이 같을 때만 비교한다
    let snapshot: { minutes: number; data: any } | null = null;
    for (let tries = 0; tries < 3 && !snapshot; tries++) {
      const before = kstMinutes();
      const res = await call(ward.api, 'GET', '/api/ward/companion/today');
      expect(res.status).toBe(200);
      if (kstMinutes() === before) snapshot = { minutes: before, data: res.json.data };
    }
    expect(snapshot, '분 경계를 넘지 않은 조회').not.toBeNull();
    const data = snapshot!.data;
    expect(data.date).toBe(kstDate());
    expect(data.slots.map((s: { slot: string }) => s.slot), '시간대 5개').toEqual([...SLOTS]);
    expect(data.currentSlot).toBe(slotInWindowNow());
    for (const slot of data.slots as Array<{ slot: string; status: string; mood: string | null }>) {
      const start = Number(slot.slot.slice(0, 2)) * 60;
      const expected = snapshot!.minutes < start ? 'UPCOMING' : snapshot!.minutes < start + 60 ? 'AVAILABLE' : 'MISSED';
      expect(slot.status, `${slot.slot} 상태 (각 60분 창)`).toBe(expected);
      expect(slot.mood, `${slot.slot} 기분`).toBeNull();
    }

    // 질문은 companion_question 의 고정 번호: 보호자 화면용 응답의 시간대별 질문이 규칙(활성 질문 id 순서, 날짜 mod 개수)과 같고, 다시 불러도 같다
    const base = `/api/guardian/ward/${wardUser.id}/companion/today`;
    const first = await call(guardian.api, 'GET', base);
    const second = await call(guardian.api, 'GET', base);
    expect(first.status).toBe(200);
    for (const slot of first.json.data.slots as Array<{ slot: string; question: string; sessionId: number | null }>) {
      expect(slot.question, `${slot.slot} 질문 문장`).toBe(expectedQuestion(slot.slot, kstDate()).text);
      expect(slot.sessionId).toBeNull();
    }
    expect(second.json.data.slots.map((s: { question: string }) => s.question)).toEqual(first.json.data.slots.map((s: { question: string }) => s.question));
    test.info().annotations.push({
      type: '확인 범위',
      description: '피보호자용 today 응답에는 질문 문장이 없어(시간대·상태·기분만) 질문 번호는 보호자용 응답으로 확인했다. 지금 dev 는 모든 피보호자가 테스트 계정(testMode=true)이다: ' +
        `testMode=${data.testMode}.`,
    });
  });

  test.fixme('CHAT-N39 7일 위험 누적 알림 (COMPANION_RISK_PATTERN)', TAGS, async () => {
    // 이 알림(CompanionRiskPatternListener)은 COMPANION_RISK_PATTERN_ENABLED=true 일 때만 돈다. dev BE 에는 이 값이 없어 꺼져 있고,
    // 켜려면 서버 설정·컨테이너를 바꿔야 해서 할 수 없다. 꺼진 경우는 CHAT-A45 에서 본다.
    // 코드 기준 기대값(확인용): 최근 windowDays(7)일 중 턴 위험 확률 0.97 이상인 서로 다른 날이 minDays(2)일 이상이면 연결된 이용 중 보호자에게
    // COMPANION_RISK_PATTERN 알림 1번(피보호자당 7일에 1번), 문구에 대답 원문·확률 없음. 문서에는 기준 일수가 없다(확인 필요).
    // 보호자 화면의 "확인할 일"(걱정·우울 3일 연속)과는 다른 계산이라 숫자가 같지 않다.
  });

  test.fixme('CHAT-N42 30일 지난 대화 글은 매일 04:55 삭제', TAGS, async () => {
    // CompanionTranscriptRetentionScheduler 는 매일 04:55(KST)에만 돌고 수동으로 부를 길이 없다(API·관리 화면 없음, 서버 변경 금지).
    // 임시 사용자 자신의 행에 31일 전·29일 전 글을 심어 둘 수는 있지만, 지우는 동작은 04:55 에 일어나서 이 실행 안에서 확인할 수 없다.
    // 코드 기준 기대값(확인용): created_at 이 now-30일보다 앞선 턴의 bot_text·answer_text 만 NULL 로 비우고 mood·대화 행은 남긴다.
  });
});
