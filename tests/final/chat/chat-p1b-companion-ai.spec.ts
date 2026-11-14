/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1b: 안부 말벗 입력 검증·동시성·알림·정리 (AI 를 실제로 부르는 것 포함)
 * 근거: BE 프로젝트_설명.txt 3-21 (2440-2510행), CompanionService·CompanionTurnSlots·CompanionNoticeListener·CompanionWithdrawalListener
 * dev 는 모든 피보호자가 테스트 계정이라 시간대와 상관없이 /test/sessions 로 대화를 연다. 대답마다 Claude(AI) 를 부르니 호출은 최소로 한다.
 * 말벗·챗을 쓴 임시 피보호자는 끝날 때 제품 탈퇴 API 로 지워 AI 서버 쪽 기록도 삭제 대기열로 정리한다.
 */
import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import { relaxAuthRates } from '../auth/_helpers-auth';
import {
  NORMAL_TEXT, RISK_TEXT, clearCompanionRiskSmsKeys, companionTurnTexts, finishSession, notificationRows, replyText,
  suppressCompanionRiskSms, waitForNotificationRows, waitForRiskDispatchLog,
} from './_helpers-chat';
import {
  Part, backdateConnection, binaryColumnsInCompanionTables, call, callLong, callPatch, clearSuppressedSmsKeys, consentRowCount, fetchBotAudio, kstDate,
  makeJpeg, noticeLogRows, openSessionRaw, padJpeg, padMp3, purgeQueued, replyAudioRaw, riskPatternNoticeCount, seedFinishedSession,
  sessionRow, sleep, suppressSmsFor, userRowCount, waitUntil, wardSessionCount, wardSessionIds, wardTurnCount, withdrawQuietly,
} from './_helpers-chat-p1b';
import { countBackendLog } from '../../../src/remote';

const TAGS = { tag: ['@P1', '@CHAT'] };
const TEST_PATH = '/api/ward/companion/test/sessions' as const;
const MB = 1024 * 1024;
const WORRY_TEXT = '요즘 몸이 여기저기 아프고 밤마다 잠을 못 자서 걱정이 많고 마음이 무거워요';

function fakeWav(size: number): Buffer {
  const header = Buffer.from('RIFF0000WAVEfmt ');
  return Buffer.concat([header, Buffer.alloc(size - header.length)]);
}

function fakeJpeg(size: number): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4)]);
}

const part = (name: string, mimeType: string, buffer: Buffer): Part => ({ name, mimeType, buffer });

test.describe('CHAT P1b - 안부 말벗 AI 연동', () => {
  test.afterEach(() => {
    clearCompanionRiskSmsKeys();
    clearSuppressedSmsKeys();
  });

  test('CHAT-A39 reply 입력 검증: 빈 글, 파일 크기·장수 초과, 형식 아님', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    try {
      const opened = await openSessionRaw(ward.api, TEST_PATH, '09:00');
      expect(opened.status).toBe(200);
      const id = opened.sessionId;
      const replyPath = `/api/ward/companion/sessions/${id}/reply`;

      // 글 대답: 빈 글·공백·글 없음은 400 COMPANION_ANSWER_EMPTY, 501자는 400 COMPANION_ANSWER_TOO_LONG
      for (const [label, body, code] of [
        ['빈 글', { text: '' }, 'COMPANION_ANSWER_EMPTY'],
        ['공백만', { text: '   ' }, 'COMPANION_ANSWER_EMPTY'],
        ['text 없음', {}, 'COMPANION_ANSWER_EMPTY'],
        ['501자', { text: '가'.repeat(501) }, 'COMPANION_ANSWER_TOO_LONG'],
      ] as const) {
        const res = await callLong(ward.api, 'POST', replyPath, body);
        expect(res.status, `${label} 상태`).toBe(400);
        expect(res.json?.code, `${label} 코드`).toBe(code);
      }

      // 음성 대답 (multipart)
      const audioCases: Array<[string, Part | null, Part[], number, string]> = [
        ['음성 5MB 초과(5MB+1바이트)', part('a.wav', 'audio/wav', fakeWav(5 * MB + 1)), [], 413, 'COMPANION_AUDIO_TOO_LARGE'],
        ['음성 아닌 파일', part('a.wav', 'audio/wav', Buffer.from('this is not an audio file')), [], 400, 'COMPANION_AUDIO_INVALID'],
        ['음성 파트 없음', null, [part('f.jpg', 'image/jpeg', fakeJpeg(100))], 400, 'COMPANION_AUDIO_INVALID'],
        ['사진 1MB 초과(1MB+1바이트)', part('a.wav', 'audio/wav', fakeWav(1000)), [part('f.jpg', 'image/jpeg', fakeJpeg(MB + 1))], 413, 'COMPANION_FRAME_TOO_LARGE'],
        ['사진 6장', part('a.wav', 'audio/wav', fakeWav(1000)), Array.from({ length: 6 }, (_, i) => part(`f${i}.jpg`, 'image/jpeg', fakeJpeg(1000))), 413, 'COMPANION_FRAME_TOO_LARGE'],
        ['사진 아닌 파일', part('a.wav', 'audio/wav', fakeWav(1000)), [part('f.jpg', 'image/jpeg', Buffer.from('not an image'))], 400, 'COMPANION_FRAME_INVALID'],
      ];
      for (const [label, audio, frames, status, code] of audioCases) {
        const res = await replyAudioRaw(ward.api, id, audio, frames);
        expect(res.status, `${label} 상태`).toBe(status);
        expect(res.json?.code, `${label} 코드`).toBe(code);
      }

      // 거절된 요청은 AI 를 부르지 않았다: 턴 행이 하나도 없고 대화는 그대로 열려 있다
      expect(wardTurnCount(id), '거절 뒤 턴 행 수').toBe(0);
      expect(sessionRow(id)).toEqual(expect.objectContaining({ status: 'OPEN', turnCount: 0 }));
      test.info().annotations.push({
        type: '문서와 차이',
        description: '문서에 코드명이 없어 확인 필요로 적혀 있었다. 코드: 글 비어 있음 400 COMPANION_ANSWER_EMPTY, 501자 400 COMPANION_ANSWER_TOO_LONG, ' +
          '음성 5MB 초과 413 COMPANION_AUDIO_TOO_LARGE, 음성 형식 아님 400 COMPANION_AUDIO_INVALID, 사진 1MB 초과·6장 413 COMPANION_FRAME_TOO_LARGE(장수 초과도 같은 코드), ' +
          '사진 형식 아님 400 COMPANION_FRAME_INVALID. 경계값(5MB·1MB·5장) 통과는 CHAT-N33 에서 본다.',
      });
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-A40 끝난 대화·8번 초과 reply', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(600_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    try {
      // 1) 마친 대화에 reply: 409 COMPANION_SESSION_ENDED, 기록은 늘지 않는다
      const first = await openSessionRaw(ward.api, TEST_PATH, '09:00');
      expect(first.status).toBe(200);
      expect((await finishSession(ward.api, first.sessionId)).status).toBe(200);
      const afterFinish = await replyText(ward.api, first.sessionId, NORMAL_TEXT);
      expect(afterFinish.status).toBe(409);
      expect(afterFinish.json?.code).toBe('COMPANION_SESSION_ENDED');
      expect(wardTurnCount(first.sessionId), '마친 대화의 턴 행').toBe(0);

      // 2) 끝까지 주고받은 대화에 한 번 더 reply: 대화가 끝날 때까지 대답한 뒤 다음 reply 는 거절된다
      const second = await openSessionRaw(ward.api, TEST_PATH, '12:00');
      expect(second.status).toBe(200);
      const maxTurns = second.maxTurns ?? 8;
      expect(maxTurns, '문서: 최대 8번 주고받음').toBe(8);
      let replies = 0;
      let ended = false;
      for (let i = 0; i < maxTurns && !ended; i++) {
        const res = await replyText(ward.api, second.sessionId, NORMAL_TEXT);
        expect(res.status, `${i + 1}번째 대답`).toBe(200);
        replies++;
        ended = res.json.data.ended === true;
      }
      expect(ended, `${maxTurns}번 안에 대화가 끝나야 한다`).toBe(true);
      expect(sessionRow(second.sessionId)?.status).toBe('FINISHED');
      const rowsBefore = companionTurnTexts(second.sessionId).length;
      expect(rowsBefore, '대답마다 턴 행 1개').toBe(replies);
      const extra = await replyText(ward.api, second.sessionId, NORMAL_TEXT);
      expect(extra.status, '끝난 뒤 추가 reply').toBe(409);
      expect(extra.json?.code).toBe('COMPANION_SESSION_ENDED');
      expect(companionTurnTexts(second.sessionId), '기록이 더 늘지 않는다').toHaveLength(rowsBefore);
      expect(sessionRow(second.sessionId)?.turnCount).toBe(rowsBefore);
      test.info().annotations.push({
        type: '실측',
        description: `대화가 ${replies}번 대답에서 끝났다 (최대 ${maxTurns}번). 끝난 뒤 reply 는 409 COMPANION_SESSION_ENDED.`,
      });
      test.info().annotations.push({
        type: '문서와 차이',
        description: '문서에 코드명이 없어 확인 필요로 적혀 있었다. 코드는 끝난 대화 409 COMPANION_SESSION_ENDED (8번 다 쓴 대화도 마지막 대답에서 ended=true 로 닫히므로 같은 코드).',
      });
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-A41 한 대화에서 reply 동시 2개', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    try {
      const opened = await openSessionRaw(ward.api, TEST_PATH, '15:00');
      expect(opened.status).toBe(200);
      const id = opened.sessionId;
      const [a, b] = await Promise.all([
        replyText(ward.api, id, NORMAL_TEXT),
        replyText(ward.api, id, '점심에는 국수를 먹었어요'),
      ]);
      expect([a.status, b.status].sort(), '하나는 200, 나머지는 409').toEqual([200, 409]);
      const rejected = a.status === 409 ? a : b;
      expect(rejected.json?.code).toBe('COMPANION_TURN_IN_PROGRESS');
      // 응답이 중복 저장되지 않는다: 턴 행은 1개뿐
      expect(companionTurnTexts(id)).toHaveLength(1);
      expect(sessionRow(id)?.turnCount).toBe(1);
      await finishSession(ward.api, id);
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-A42 서버 전체 동시 8개 초과', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(600_000);
    await relaxAuthRates();
    const wards: Array<{ user: Awaited<ReturnType<typeof tempUser>>; api: Awaited<ReturnType<typeof loginAs>>['api']; sessionId: number }> = [];
    try {
      // 서로 다른 피보호자 9명이 각자 대화를 연다 (열 때도 자리를 쓰므로 한 명씩)
      for (let i = 0; i < 9; i++) {
        const user = await tempUser('WARD');
        const { api } = await loginAs(user);
        wards.push({ user, api, sessionId: 0 });
        const opened = await openSessionRaw(api, TEST_PATH, '09:00');
        expect(opened.status, `${i + 1}번째 대화 열기`).toBe(200);
        wards[i].sessionId = opened.sessionId;
      }
      // 9개를 동시에 reply 한다
      let firstBusySeen = false;
      const replies = wards.map(w => replyText(w.api, w.sessionId, NORMAL_TEXT).then(r => {
        if (r.status === 503) firstBusySeen = true;
        return r;
      }));
      // 첫 503 이 도착한 뒤(8자리가 찬 채 200 들이 아직 진행 중일 때)에 다른 API 를 부른다
      expect(await waitUntil(() => firstBusySeen, 60_000, 200), '첫 503(COMPANION_BUSY) 도착').toBe(true);
      // 다른 기능은 영향이 없다: 말벗 자리를 쓰지 않는 조회는 바로 200
      const started = Date.now();
      const other = await call(wards[0].api, 'GET', '/api/user/me');
      const elapsed = Date.now() - started;
      expect(other.status, '말벗이 붐벼도 다른 API 는 정상').toBe(200);
      expect(elapsed, '다른 API 응답 시간(ms)').toBeLessThan(5_000);
      const results = await Promise.all(replies);

      const statuses = results.map(r => r.status);
      const busy = results.filter(r => r.status === 503);
      const ok = results.filter(r => r.status === 200);
      // 서버 전체 동시 자리는 공용 상태라 같은 때 다른 말벗 호출이 겹치면 개수가 틀어질 수 있다. 넓혀서 통과시키지 않고 실패로 두고 단독 재실행한다.
      expect(ok.length, `동시에 통과하는 것은 정확히 8개 (실제 ${statuses.join(',')})`).toBe(8);
      expect(busy.length, `9번째는 503 정확히 1개 (실제 ${statuses.join(',')})`).toBe(1);
      for (const r of busy) expect(r.json?.code).toBe('COMPANION_BUSY');
      test.info().annotations.push({ type: '실측', description: `동시 reply 9개 중 200 ${ok.length}개, 503 ${busy.length}개` });
    } finally {
      for (const w of wards) await withdrawQuietly(w.api, w.user.password);
    }
  });

  test('CHAT-A45 위험 누적 알림 스위치 꺼짐(기본)이면 알림 없음', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(420_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    backdateConnection(guardianUser.id, wardUser.id, 30);
    suppressCompanionRiskSms(guardianUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);
    try {
      // 며칠 전부터 위험 확률이 높았던 기록을 심는다 (스위치가 켜져 있었다면 누적 판정에 쓰였을 기록)
      seedFinishedSession(wardUser.id, { date: kstDate(-2), slot: '09:00', mood: 'WORRY', riskProb: 0.99 });
      seedFinishedSession(wardUser.id, { date: kstDate(-1), slot: '09:00', mood: 'WORRY', riskProb: 0.99 });

      // 오늘 위험 신호가 있는 대화를 한다: 단일 대화 위험(COMPANION_RISK)은 스위치와 무관하게 1번 간다
      const opened = await openSessionRaw(ward.api, TEST_PATH, '09:00');
      expect(opened.status).toBe(200);
      const turn = await replyText(ward.api, opened.sessionId, RISK_TEXT);
      expect(turn.status).toBe(200);
      expect(turn.json.data.analysis.riskFlag, 'AI 가 위험 신호로 판단').toBe(true);
      await finishSession(ward.api, opened.sessionId);
      const riskRows = await waitForNotificationRows(guardianUser.id, 1, 'COMPANION_RISK');
      expect(riskRows, '단일 대화 위험 알림은 스위치와 무관하게 1번').toHaveLength(1);
      expect(await waitForRiskDispatchLog(wardUser.id, opened.sessionId), '위험 알림 발송 처리 로그').toBeGreaterThan(0);

      // 누적 알림은 없다: 이력 0건, 선점 기록 0건 (발송 처리가 끝난 뒤에도 늘지 않는지 잠시 더 본다)
      const patternRows = await waitForNotificationRows(guardianUser.id, 1, 'COMPANION_RISK_PATTERN', 10_000);
      expect(patternRows, 'COMPANION_RISK_PATTERN 알림 이력').toEqual([]);
      expect(notificationRows(guardianUser.id, 'COMPANION_RISK_PATTERN')).toEqual([]);
      expect(riskPatternNoticeCount(wardUser.id), '누적 알림 선점 기록').toBe(0);

      // 보호자 화면의 위험 표시는 정상이다
      const detail = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${opened.sessionId}`);
      expect(detail.status).toBe(200);
      expect(detail.json.data.riskAlerted).toBe(true);
      const page = await openAs(guardian.who, `/guardian/emotion/sessions/${opened.sessionId}?wardId=${wardUser.id}`);
      await expect(page.getByText(/위험 알림 보냄/)).toBeVisible();
      test.info().annotations.push({
        type: '확인 범위',
        description: '누적 알림은 스케줄러가 아니라 턴 저장 뒤 이벤트(CompanionRiskPatternListener)로 돈다. 스위치(COMPANION_RISK_PATTERN_ENABLED)는 dev 에 설정돼 있지 않아 꺼짐이다. ' +
          '이 테스트는 꺼진 상태에서 누적 알림이 가지 않는다는 것만 본다(켜진 경우는 서버 설정을 바꿔야 해 CHAT-N39 는 수동).',
      });
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-N33 음성으로 대답 (음성 5MB·사진 1MB×5장 이내)', TAGS, async ({ tempUser, loginAs, browser }) => {
    test.setTimeout(480_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    try {
      // 동의해 두면 받아 적은 글이 저장된다 (음성·사진 자체는 어떤 경우에도 저장되지 않는다)
      expect((await call(ward.api, 'PUT', '/api/ward/companion/transcript-consent', { consent: true })).status).toBe(200);
      const opened = await openSessionRaw(ward.api, TEST_PATH, '09:00');
      expect(opened.status).toBe(200);
      const id = opened.sessionId;

      // 말벗이 한 말의 목소리를 받아 어르신 대답 음성으로 쓴다 (실제 사람 말소리라 받아 적기가 된다)
      expect(opened.audioIndex, '대화 열기 응답의 말벗 목소리 번호(audio.index)').not.toBeNull();
      const speech = await fetchBotAudio(ward.api, id, opened.audioIndex as number);
      expect(speech, '말벗 목소리 받기').not.toBeNull();
      const jpeg = await makeJpeg(browser);
      const mime = speech!.contentType.split(';')[0] || 'audio/mpeg';

      // 경계값: 음성 5MB(5×1024×1024) + 사진 1MB(1024×1024) 5장은 통과해야 한다 (문서: 음성 5MB·사진 1MB×5장까지)
      const boundary = await replyAudioRaw(
        ward.api, id,
        part('a.mp3', mime, padMp3(speech!.buffer, 5 * MB)),
        Array.from({ length: 5 }, (_, i) => part(`f${i}.jpg`, 'image/jpeg', padJpeg(jpeg, MB))),
      );
      // 합계가 정확히 10MB(+머리글)라서 앞단 nginx 의 본문 상한(10MB)에 걸리면 JSON 코드 없는 HTML 413 이 온다
      expect.soft(
        boundary.status,
        `경계값 요청(음성 5MB + 사진 1MB 5장) 상태 - 응답 코드 ${boundary.json?.code ?? '-'} (JSON 응답 ${boundary.json !== null})`,
      ).toBe(200);

      // 보통 크기: 말소리 + 사진 2장은 통과하고 받아 적은 글로 다음 말이 이어진다
      const normal = boundary.status === 200
        ? boundary
        : await replyAudioRaw(ward.api, id, part('a.mp3', mime, speech!.buffer), [part('f0.jpg', 'image/jpeg', jpeg), part('f1.jpg', 'image/jpeg', jpeg)]);
      expect(normal.status, `보통 크기 음성 대답 상태 - 응답 코드 ${normal.json?.code ?? '-'}`).toBe(200);
      const data = normal.json.data;
      expect(typeof data.transcript, '받아 적은 글').toBe('string');
      expect(data.transcript.trim().length, '받아 적은 글이 비어 있지 않다').toBeGreaterThan(0);
      expect(typeof data.reply, '다음 말벗 말').toBe('string');
      expect(data.reply.trim().length).toBeGreaterThan(0);
      expect(data.turnNo).toBe(1);

      // 음성·사진은 저장되지 않는다: 말벗 표에 이진(음성·사진) 열이 없고, 저장된 것은 받아 적은 글뿐이다
      expect(binaryColumnsInCompanionTables(), '말벗 표의 이진 열').toEqual([]);
      const rows = companionTurnTexts(id);
      expect(rows).toEqual([expect.objectContaining({ turnNo: 1, hasAnswer: true, hasBot: true })]);
      test.info().annotations.push({
        type: '확인 범위',
        description: '음성·사진 비저장은 BE DB 의 말벗 표에 이진 열이 없는지와 저장된 행이 글뿐인지까지만 확인했다. 파일·오브젝트 저장소와 AI 서버 쪽 저장은 확인하지 못했다. ' +
          '경계값 요청(음성 5MB + 사진 1MB 5장)이 막히는 것은 문서와 어긋나는 진짜 버그로 판정(인프라 nginx 와 BE 멀티파트 10MB 상한)되어 단언을 그대로 둔다.',
      });
      await finishSession(ward.api, id);
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-N43 탈퇴·역할 변경 시 말벗 기록 삭제와 AI 재시도', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(420_000);
    const leaver = await tempUser('WARD');
    const switcher = await tempUser('WARD');
    const admin = await tempUser('ADMIN');
    const leaverApi = (await loginAs(leaver)).api;
    const switcherApi = (await loginAs(switcher)).api;
    const adminApi = (await loginAs(admin)).api;
    let roleChanged = false;
    try {
      // 탈퇴할 피보호자: AI 에 열린 대화 1개 + 마친 기록 1개
      const openedLeaver = await openSessionRaw(leaverApi, TEST_PATH, '09:00');
      expect(openedLeaver.status).toBe(200);
      seedFinishedSession(leaver.id, { date: kstDate(-1), slot: '12:00', mood: 'CALM' });
      expect(wardSessionCount(leaver.id)).toBe(2);

      const withdraw = await call(leaverApi, 'DELETE', '/api/user/me', { password: leaver.password });
      expect(withdraw.status, '탈퇴').toBe(200);
      expect(userRowCount(leaver.id), '회원 행 삭제').toBe(0);
      expect(wardSessionCount(leaver.id), '탈퇴 뒤 우리 DB 말벗 기록').toBe(0);
      // AI 쪽은 삭제 대기열로 지운다: 바로 한 번 시도하고, 성공하면 대기열에서 빠지고 BE 로그에 완료 줄이 남는다
      const purgedLog = `[COMPANION-PURGE] AI 말벗 데이터 삭제 완료: wardId=${leaver.id}`;
      expect(await waitUntil(() => countBackendLog(purgedLog, 300) > 0, 60_000), '탈퇴 직후 AI 삭제 완료 로그').toBe(true);
      expect(purgeQueued(leaver.id), '삭제 완료 뒤 대기열이 비었다').toBe(false);

      // 역할 변경(피보호자 → 보호자): 말벗 기록·동의가 지워지고 AI 삭제 대기열로 간다
      expect((await call(switcherApi, 'PUT', '/api/ward/companion/transcript-consent', { consent: true })).status).toBe(200);
      const openedSwitcher = await openSessionRaw(switcherApi, TEST_PATH, '09:00');
      expect(openedSwitcher.status).toBe(200);
      seedFinishedSession(switcher.id, { date: kstDate(-1), slot: '12:00', mood: 'CALM' });
      expect(wardSessionCount(switcher.id)).toBe(2);
      expect(consentRowCount(switcher.id)).toBe(1);
      const patch = await callPatch(adminApi, `/api/admin/user/${switcher.id}`, { role: 'GUARDIAN' });
      expect(patch.status, '관리자 역할 변경').toBe(200);
      roleChanged = true;
      expect(wardSessionCount(switcher.id), '역할 변경 뒤 말벗 기록').toBe(0);
      expect(consentRowCount(switcher.id), '역할 변경 뒤 동의 기록').toBe(0);
      expect(wardSessionIds(switcher.id)).toEqual([]);
      const switchedLog = `[COMPANION-PURGE] AI 말벗 데이터 삭제 완료: wardId=${switcher.id}`;
      expect(await waitUntil(() => countBackendLog(switchedLog, 300) > 0, 60_000), '역할 변경 직후 AI 삭제 완료 로그').toBe(true);
      expect(purgeQueued(switcher.id)).toBe(false);
      test.info().annotations.push({
        type: '확인 못 한 부분',
        description: '[부분 확인 - 수동 확인 필요] AI 서버를 잠시 내려 두었다가 올리는 부분(매시 35분 재시도)은 서버·컨테이너를 바꿀 수 없어 하지 못했다. 정상 상태에서의 삭제와 대기열 정리까지만 확인했다. 이 케이스는 완전 통과로 세지 않는다.',
      });
    } finally {
      // 테스트가 중간에 멈췄을 때만 필요하다: 아직 남아 있는 사용자는 탈퇴 경로로 지워 AI 기록도 정리한다
      if (userRowCount(leaver.id) > 0) await withdrawQuietly(leaverApi, leaver.password);
      // 역할을 바꾼 뒤에는 옛 토큰이 무효라 탈퇴 호출이 안 된다(이미 AI 삭제도 끝났다)
      if (!roleChanged && userRowCount(switcher.id) > 0) await withdrawQuietly(switcherApi, switcher.password);
    }
  });

  test('CHAT-X02 걱정 기분이 여러 날 이어지면 보호자에게 주의 알림 (알림 끈 보호자 제외)', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(600_000);
    const wardUser = await tempUser('WARD', { name: `주의확인${Date.now().toString(36).slice(-4)}` });
    const onUser = await tempUser('GUARDIAN'); // 주의 알림 켬(기본)
    const offUser = await tempUser('GUARDIAN'); // 주의 알림 끔
    const adminUser = await tempUser('ADMIN');
    connect(onUser.id, wardUser.id);
    connect(offUser.id, wardUser.id);
    backdateConnection(onUser.id, wardUser.id, 30);
    backdateConnection(offUser.id, wardUser.id, 30);
    suppressSmsFor('COMPANION_NOTICE', onUser.id, offUser.id);
    suppressSmsFor('COMPANION_RISK', onUser.id, offUser.id);
    const on = await loginAs(onUser);
    const off = await loginAs(offUser);
    const ward = await loginAs(wardUser);
    const admin = await loginAs(adminUser);
    try {
      const turnOff = await call(off.api, 'PUT', '/api/guardian/notification-type-setting', { companionNotice: false });
      expect(turnOff.status).toBe(200);
      expect((await call(off.api, 'GET', '/api/guardian/notification-type-setting')).json.data.companionNotice.enabled, '주의 알림 끔').toBe(false);
      expect((await call(on.api, 'GET', '/api/guardian/notification-type-setting')).json.data.companionNotice.enabled, '주의 알림 기본 켜짐').toBe(true);

      // 앞의 두 날은 걱정 기록을 심고, 오늘은 실제 대화로 걱정스러운 기분으로 마치게 한다 (연속 3일)
      seedFinishedSession(wardUser.id, { date: kstDate(-2), slot: '09:00', mood: 'WORRY' });
      seedFinishedSession(wardUser.id, { date: kstDate(-1), slot: '09:00', mood: 'WORRY' });
      const statsBefore = await call(admin.api, 'GET', '/api/admin/ai-stats/companion');
      expect(statsBefore.status).toBe(200);
      const alertsBefore = statsBefore.json.data.alertSentCount as number;

      let finalMood: string | null = null;
      for (const slot of ['09:00', '12:00', '15:00'] as const) {
        const opened = await openSessionRaw(ward.api, TEST_PATH, slot);
        expect(opened.status).toBe(200);
        expect((await replyText(ward.api, opened.sessionId, WORRY_TEXT)).status).toBe(200);
        const finished = await finishSession(ward.api, opened.sessionId);
        expect(finished.status).toBe(200);
        finalMood = finished.json.data.mood;
        if (finalMood === 'WORRY' || finalMood === 'DEPRESSED') break;
      }
      expect(['WORRY', 'DEPRESSED'], `오늘 대화의 기분(AI 판정 ${finalMood}) - 걱정·우울이어야 3일 연속이 된다`).toContain(finalMood);

      // 켠 보호자는 주의 알림 1번, 끈 보호자는 없다. 발송 처리 로그가 나온 뒤에 센다
      const rows = await waitForNotificationRows(onUser.id, 1, 'COMPANION_NOTICE', 45_000);
      expect(rows, '켠 보호자의 COMPANION_NOTICE 이력').toHaveLength(1);
      expect(rows[0].result).not.toBe('NOT_SENT');
      expect(rows[0].body).toContain(wardUser.name);
      expect(rows[0].body).toContain('3일째');
      expect(rows[0].body, '문구에 대화 내용이 없다').not.toContain('아프고');
      const sentLog = `[COMPANION-NOTICE] 주의 알림 발송: wardId=${wardUser.id}`;
      expect(await waitUntil(() => countBackendLog(sentLog, 300) > 0, 30_000), '주의 알림 발송 처리 로그').toBe(true);
      expect(notificationRows(offUser.id, 'COMPANION_NOTICE'), '끈 보호자는 주의 알림이 없다').toEqual([]);
      expect(notificationRows(onUser.id, 'COMPANION_NOTICE'), '발송 처리 뒤에도 1번').toHaveLength(1);
      const log = noticeLogRows(wardUser.id);
      expect(log, '주의 알림 선점 기록은 피보호자·날짜당 1건').toHaveLength(1);
      expect(log[0]).toEqual(expect.objectContaining({ date: kstDate(), mood: finalMood, days: 3 }));

      // 보호자 화면의 '확인할 일'과 관리자 집계가 같은 계산 결과를 보인다 (알림을 끈 보호자 화면에도 확인할 일은 보인다)
      for (const who of [on, off]) {
        const today = await call(who.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/today`);
        expect(today.status).toBe(200);
        expect(today.json.data.attention, '확인할 일').toEqual({ mood: finalMood, days: 3 });
      }
      const stats = await call(admin.api, 'GET', '/api/admin/ai-stats/companion');
      expect(stats.status).toBe(200);
      // 남의 어르신 정보가 단언 메시지·첨부에 남지 않게 내 wardId 항목만 꺼내 쓴다
      const mine = (stats.json.data.continuingWards as Array<{ wardId: string; mood: string; days: number }>)
        .filter(w => w.wardId === wardUser.id)
        .map(w => ({ wardId: w.wardId, mood: w.mood, days: w.days }))[0];
      expect(mine, '관리자 집계의 이어지는 어르신(내 항목만)').toEqual({ wardId: wardUser.id, mood: finalMood, days: 3 });
      test.info().annotations.push({
        type: '보조 확인',
        description: `관리자 집계 알림 보냄 수 증가 ${(stats.json.data.alertSentCount as number) - alertsBefore} (공용 숫자라 다른 테스트 알림도 섞일 수 있어 통과 조건으로 쓰지 않는다. 이 알림 확인은 위의 알림 이력·발송 로그가 한다).`,
      });
      const inbox = await call(on.api, 'GET', '/api/user/me/notifications');
      expect(inbox.status).toBe(200);
      expect((inbox.json.data.content as Array<{ type: string }>).filter(n => n.type === 'COMPANION_NOTICE')).toHaveLength(1);
      test.info().annotations.push({
        type: '문서와 차이',
        description: '케이스 사전 조건의 "COMPANION_RISK_PATTERN 스위치 켬"은 이 알림과 무관하다. 코드에서 "걱정·우울 3일 이상 연속" 주의 알림(COMPANION_NOTICE, CompanionNoticeListener)은 스위치 없이 돌고 ' +
          '기준은 3일이다(CompanionMoodDays.NOTICE_DAYS). 위험 누적(COMPANION_RISK_PATTERN)은 스위치가 꺼져 있어 CHAT-N39 는 수동으로 둔다.',
      });
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });
});
