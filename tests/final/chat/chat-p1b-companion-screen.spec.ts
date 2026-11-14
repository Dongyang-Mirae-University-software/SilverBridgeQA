/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1b: 안부 말벗 화면
 * 근거: BE 3-21(2440-2510행), FE 배포본 a8666240 WardCompanionContent(피보호자 /ward/companion)·GuardianEmotionContent·GuardianCompanionSessionContent(보호자 /guardian/emotion)
 * dev 는 모든 피보호자가 테스트 계정이라 /ward/companion 에 시간대 고르기 화면(테스트 모드)이 열린다.
 */
import { expect, test } from '../../../src/fixtures';
import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { tokenCookies } from '../../../src/session';
import { connect } from '../../../src/variables';
import { companionTurnTexts, finishSession, replyText } from './_helpers-chat';
import {
  backdateConnection, call, expectedQuestion, kstDate, openSessionRaw, seedFinishedSession, sessionRow, slotInWindowNow, wardSessionIds,
  withdrawQuietly,
} from './_helpers-chat-p1b';

const TAGS = { tag: ['@P1', '@CHAT'] };
const TEST_PATH = '/api/ward/companion/test/sessions' as const;
const NORMAL_TEXT = '오늘 친구와 산책하고 와서 기분이 좋아요';

function dateLabel(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const weekday = ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}월 ${d}일 ${weekday}요일`;
}

const squash = (text: string) => text.replace(/\s+/g, '');

test.describe('CHAT P1b - 안부 말벗 화면', () => {
  test('CHAT-N32 창 안에서 대화 시작 → 글로 대답 → 마치기', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(480_000);
    const apiWardUser = await tempUser('WARD');
    const apiWard = await loginAs(apiWardUser);
    const screenWardUser = await tempUser('WARD');
    const screenWard = await loginAs(screenWardUser);
    try {
      // 1) API: 지금 시각이 시간대 창 안이면 일반 시작(POST sessions), 창 밖이면 테스트 계정 시작(test/sessions)으로 같은 흐름을 본다
      const windowSlot = slotInWindowNow();
      const slot = windowSlot ?? '09:00';
      const opened = await openSessionRaw(apiWard.api, windowSlot ? '/api/ward/companion/sessions' : TEST_PATH, windowSlot ? undefined : slot);
      expect(opened.status, '대화 시작').toBe(200);
      expect(opened.raw.json.data.slot).toBe(slot);
      expect(opened.question, '말벗 질문').toBe(expectedQuestion(slot, kstDate()).text);
      expect(opened.maxTurns).toBe(8);
      expect(opened.raw.json.data.resumed).toBe(false);
      expect(opened.raw.json.data.turnCount).toBe(0);

      const turn = await replyText(apiWard.api, opened.sessionId, NORMAL_TEXT);
      expect(turn.status, '글로 대답').toBe(200);
      expect(turn.json.data.turnNo).toBe(1);
      expect(typeof turn.json.data.reply).toBe('string');
      expect(turn.json.data.reply.trim().length, '말벗 다음 말').toBeGreaterThan(0);
      expect(turn.json.data.analysis.riskFlag, '평범한 대답은 위험 표시 없음').toBe(false);
      const rows = companionTurnTexts(opened.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0].mood, '턴 기분 저장').toBeTruthy();

      const finished = await finishSession(apiWard.api, opened.sessionId);
      expect(finished.status, '마치기').toBe(200);
      expect(finished.json.data.sessionId).toBe(opened.sessionId);
      expect(finished.json.data.mood, '대화 기분').toBeTruthy();
      expect(finished.json.data.turnCount).toBe(1);
      expect(finished.json.data.analysis.riskFlag).toBe(false);
      expect(finished.json.data.analysis.alertLevel).toBe('INFO');
      expect(sessionRow(opened.sessionId)).toEqual(expect.objectContaining({ status: 'FINISHED', turnCount: 1, riskFlag: false }));
      const today = await call(apiWard.api, 'GET', '/api/ward/companion/today');
      const slotState = today.json.data.slots.find((s: { slot: string }) => s.slot === slot);
      expect(slotState.status, '시간대 상태').toBe('DONE');
      expect(slotState.mood).toBe(finished.json.data.mood);

      // 2) 화면: 시간대를 고르고 글로 대답한 뒤 마친다
      const page = await openAs(screenWard.who, '/ward/companion');
      await expect(page.getByRole('region', { name: '안부 말벗 테스트' })).toBeVisible();
      await page.getByRole('button', { name: '바로 이야기하기' }).click();
      await expect(page.getByRole('heading', { name: '안부 대화 내용을 가족에게 보여 줄까요?' })).toBeVisible();
      await page.getByRole('button', { name: '보여 주지 않을게요' }).click();

      const lines = page.getByRole('list', { name: '안부 대화' });
      await expect(lines).toBeVisible({ timeout: 60_000 });
      const question = expectedQuestion('09:00', kstDate()).text;
      await expect.poll(async () => squash(await lines.innerText()), { message: '말벗 첫 질문이 대화에 보인다' }).toContain(squash(question));

      await page.getByRole('button', { name: '글로 대답하기' }).click();
      const answer = `${NORMAL_TEXT} 그래서 기분이 좋아요`;
      await page.getByLabel('대답 적기').fill(answer);
      await page.getByRole('button', { name: '보내기' }).click();
      await expect(lines.getByText(answer, { exact: false })).toBeVisible({ timeout: 120_000 });
      await expect.poll(() => lines.getByRole('listitem').count(), { message: '질문·내 대답·말벗 응답' }).toBeGreaterThanOrEqual(3);

      await page.getByRole('button', { name: '대화 그만하기' }).click();
      await expect(page.getByRole('heading', { name: '오늘도 이야기 나눠 주셔서 고마워요' })).toBeVisible({ timeout: 60_000 });

      const ids = wardSessionIds(screenWardUser.id);
      expect(ids, '화면에서 만든 대화 1건').toHaveLength(1);
      expect(sessionRow(ids[0])).toEqual(expect.objectContaining({ status: 'FINISHED', turnCount: 1, riskFlag: false }));
      expect(sessionRow(ids[0])?.mood, '화면에서 한 대화의 기분 저장').toBeTruthy();
      test.info().annotations.push({
        type: '확인 범위',
        description: windowSlot
          ? `지금 시각은 ${windowSlot} 창 안이라 API 는 일반 시작(POST sessions)으로 봤다. 화면은 dev 가 모든 피보호자를 테스트 계정으로 보므로 시간대 고르기 화면(테스트 모드)으로 진행했다.`
          : 'API 는 지금이 창 밖이라 테스트 계정 시작으로 봤다(창 안 일반 시작은 창 안 시각에 다시 돌려야 확인). 화면은 테스트 모드로 진행했다.',
      });
    } finally {
      await withdrawQuietly(apiWard.api, apiWardUser.password);
      await withdrawQuietly(screenWard.api, screenWardUser.password);
    }
  });

  test('CHAT-N37 보호자가 오늘·주간·일별·대화 상세 조회', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD', { name: '확인어르신' });
    connect(guardianUser.id, wardUser.id);
    backdateConnection(guardianUser.id, wardUser.id, 30);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);

    // 걱정이 3일 이어진 기록을 심는다 (AI 판정에 기대지 않고, 보호자 조회 규칙만 본다). 오늘 대화에는 글이 있다
    const answer = `QA37 점심에 국수를 먹었어요 ${Date.now().toString(36)}`;
    const bot = '맛있게 드셨다니 좋네요. 오늘 몸은 어떠세요?';
    seedFinishedSession(wardUser.id, { date: kstDate(-2), slot: '09:00', mood: 'WORRY' });
    const yesterdayId = seedFinishedSession(wardUser.id, { date: kstDate(-1), slot: '09:00', mood: 'WORRY' });
    const todayId = seedFinishedSession(wardUser.id, { date: kstDate(), slot: '09:00', mood: 'WORRY', text: { bot, answer } });
    const base = `/api/guardian/ward/${wardUser.id}/companion`;

    // 오늘
    const today = await call(guardian.api, 'GET', `${base}/today`);
    expect(today.status).toBe(200);
    expect(today.json.data.current).toEqual(expect.objectContaining({ slot: '09:00', mood: 'WORRY' }));
    expect(today.json.data.answeredCount).toBe(1);
    expect(today.json.data.slotCount).toBe(5);
    expect(today.json.data.attention, '걱정 3일 이어짐').toEqual({ mood: 'WORRY', days: 3 });
    const slot0 = today.json.data.slots[0];
    expect(slot0).toEqual(expect.objectContaining({ slot: '09:00', status: 'DONE', mood: 'WORRY', sessionId: todayId }));
    expect(today.json.data.slots).toHaveLength(5);
    // 주간
    const week = await call(guardian.api, 'GET', `${base}/week`);
    expect(week.status).toBe(200);
    expect(week.json.data.days).toHaveLength(7);
    expect(week.json.data.days.map((d: { date: string }) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => kstDate(i - 6)));
    expect(week.json.data.days.map((d: { mood: string | null }) => d.mood)).toEqual([null, null, null, null, 'WORRY', 'WORRY', 'WORRY']);
    // 일별
    const day = await call(guardian.api, 'GET', `${base}/days/${kstDate(-1)}`);
    expect(day.status).toBe(200);
    expect(day.json.data.date).toBe(kstDate(-1));
    expect(day.json.data.slots[0]).toEqual(expect.objectContaining({ slot: '09:00', status: 'DONE', mood: 'WORRY', sessionId: yesterdayId }));
    expect(day.json.data.nextSlot, '지난 날은 다음 시간대 없음').toBeNull();

    // 대화 상세: 동의 전에는 글이 없고, 동의한 뒤에는 대화 글이 온다
    const noConsent = await call(guardian.api, 'GET', `${base}/sessions/${todayId}`);
    expect(noConsent.status).toBe(200);
    expect(noConsent.json.data.transcript).toBe('NO_CONSENT');
    expect(noConsent.json.data.turns[0].answerText).toBeNull();
    expect(noConsent.text).not.toContain(answer);
    expect((await call(ward.api, 'PUT', '/api/ward/companion/transcript-consent', { consent: true })).status).toBe(200);
    const detail = await call(guardian.api, 'GET', `${base}/sessions/${todayId}`);
    expect(detail.status).toBe(200);
    expect(detail.json.data).toEqual(expect.objectContaining({
      sessionId: todayId, date: kstDate(), slot: '09:00', status: 'FINISHED', mood: 'WORRY', turnCount: 1, riskAlerted: false, transcript: 'AVAILABLE',
    }));
    expect(detail.json.data.question, '질문 문장').toBeTruthy();
    expect(detail.json.data.turns).toEqual([expect.objectContaining({ turnNo: 1, mood: 'WORRY', answerText: answer, botText: bot })]);

    // 화면: 지금 기분, 확인할 일, 시간대별 상태, 최근 7일, 그날 대화들, 대화 상세
    const page = await openAs(guardian.who, '/guardian/emotion');
    const now = page.getByRole('region', { name: '지금 기분' });
    await expect(now).toBeVisible();
    await expect(now).toContainText(/지금\s*걱정\s*상태예요/);
    await expect(now).toContainText('오늘 5번 중 1번 대화했어요');
    const notice = page.getByRole('note', { name: '확인할 일' });
    await expect(notice).toContainText('걱정스러운 기분이 3일째 이어지고 있어요');
    await expect(page.getByRole('heading', { name: '최근 7일 기분' })).toBeVisible();
    await expect(page.getByRole('button', { name: '오늘 기분 걱정' })).toBeVisible();
    await expect(page.getByRole('button', { name: `${dateLabel(kstDate(-1))} 기분 걱정` })).toBeVisible();
    await expect(page.getByRole('button', { name: `${dateLabel(kstDate(-6))} 기분 기록 없음` })).toBeVisible();
    const slotList = page.getByRole('heading', { name: '오늘의 안부 대화' });
    await expect(slotList).toBeVisible();
    const link = page.getByRole('link', { name: /대화 보기/ });
    await expect(link).toHaveCount(1);

    // 지난 날을 누르면 그날 시간대 목록이 열린다
    await page.getByRole('button', { name: `${dateLabel(kstDate(-1))} 기분 걱정` }).click();
    await expect(page.getByRole('heading', { name: `${dateLabel(kstDate(-1))} 안부 대화` })).toBeVisible();
    await page.getByRole('button', { name: '오늘 기분 걱정' }).click();
    await expect(page.getByRole('heading', { name: '오늘의 안부 대화' })).toBeVisible();

    // 대화 상세 화면: 기분 흐름과 나눈 이야기(동의했으므로 글 포함)
    await page.getByRole('link', { name: /대화 보기/ }).click();
    await expect(page).toHaveURL(new RegExp(`/guardian/emotion/sessions/${todayId}\\?wardId=${wardUser.id}`));
    // FE 배포본 GuardianCompanionSessionContent: <h2>{formatSlotTime(slot)} 안부 대화</h2>, 09:00 는 '오전 9시'
    await expect(page.getByRole('heading', { name: '오전 9시 안부 대화', exact: true })).toBeVisible();
    const summary = page.getByRole('region', { name: '이 대화의 상태' });
    await expect(summary).toContainText('이 대화의 기분 · 걱정');
    await expect(summary).toContainText('위험 알림 없음');
    await expect(page.getByRole('heading', { name: '나눈 이야기' })).toBeVisible();
    await expect(page.getByText(answer)).toBeVisible();
    await expect(page.getByText(/맛있게 드셨다니 좋네요/)).toBeVisible();
  });

  test('CHAT-A43 [부분 확인 - 화면 안내만, 서버 쪽은 수동 확인] AI 서버 장애·90초 초과', TAGS, async ({ tempUser, loginAs, browser }) => {
    test.setTimeout(420_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    const context = await browser.newContext({ ...contextDefaults, storageState: { cookies: tokenCookies(ward.login), origins: [] } });
    await context.addInitScript(installPageStubs(), pageStubArg);
    const pageErrors: string[] = [];
    try {
      const page = await context.newPage();
      page.on('pageerror', error => pageErrors.push(`${error.name}`));
      const fail = (status: number, code: string) => (route: import('@playwright/test').Route) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ success: false, code, message: '오류' }) });

      // 대화 열기에서 AI 장애(504 시간 초과, 503 연결 불가)가 오면 화면이 안내하고, 대화는 만들어지지 않는다
      await page.route('**/api/ward/companion/test/sessions', fail(504, 'COMPANION_TIMEOUT'));
      await page.goto('/ward/companion');
      await page.getByRole('button', { name: '바로 이야기하기' }).click();
      await page.getByRole('button', { name: '보여 주지 않을게요' }).click();
      await expect(page.getByText('말벗 대답이 늦어요. 다시 보내 주세요.')).toBeVisible();
      await page.unroute('**/api/ward/companion/test/sessions');
      await page.route('**/api/ward/companion/test/sessions', fail(503, 'COMPANION_UNAVAILABLE'));
      await page.getByRole('button', { name: '바로 이야기하기' }).click();
      await expect(page.getByText('지금은 말벗과 이야기할 수 없어요. 잠시 후 다시 해 주세요.')).toBeVisible();
      await expect(page.getByRole('list', { name: '안부 대화' })).toHaveCount(0);

      // 진짜로 열고, 대답 보내기에서 AI 시간 초과(504)가 오면: 안내가 뜨고 적은 글이 남고 대화는 그대로다
      await page.unroute('**/api/ward/companion/test/sessions');
      await page.getByRole('button', { name: '바로 이야기하기' }).click();
      const lines = page.getByRole('list', { name: '안부 대화' });
      await expect(lines).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: '글로 대답하기' }).click();
      const draft = '오늘은 날씨가 좋아서 산책을 다녀왔어요';
      await page.getByLabel('대답 적기').fill(draft);
      await page.route('**/api/ward/companion/sessions/*/reply', fail(504, 'COMPANION_TIMEOUT'));
      await page.getByRole('button', { name: '보내기' }).click();
      await expect(page.getByRole('alert').filter({ hasText: '말벗 대답이 늦어요. 다시 보내 주세요.' })).toBeVisible();
      await expect(page.getByLabel('대답 적기'), '적은 글은 지우지 않는다').toHaveValue(draft);
      await expect(lines.getByText(draft), '보내지지 않은 대답은 대화에 올라가지 않는다').toHaveCount(0);

      const [sessionId] = wardSessionIds(wardUser.id);
      expect(sessionId).toBeGreaterThan(0);
      // 이 시점의 reply 요청은 화면에서 가로채 서버에 가지 않았으므로 서버 기록 확인은 하지 않는다(해도 항상 참이라 의미가 없다)

      // 장애가 풀리면 같은 글을 그대로 다시 보내 이어 갈 수 있다 (대화가 깨지지 않았다)
      await page.unroute('**/api/ward/companion/sessions/*/reply');
      await page.getByRole('button', { name: '보내기' }).click();
      await expect(lines.getByText(draft)).toBeVisible({ timeout: 120_000 });
      await page.getByRole('button', { name: '대화 그만하기' }).click();
      await expect(page.getByRole('heading', { name: '오늘도 이야기 나눠 주셔서 고마워요' })).toBeVisible({ timeout: 60_000 });
      expect(sessionRow(sessionId)).toEqual(expect.objectContaining({ status: 'FINISHED', turnCount: 1 }));
      expect(pageErrors, '화면 JS 예외').toEqual([]);
      test.info().annotations.push({
        type: '부분 확인 - 수동 확인 필요',
        description: '이 테스트가 통과해도 케이스 A43 은 완전 통과가 아니라 "화면 안내만 확인, 서버 쪽 수동 확인 남음"이다. AI 서버를 실제로 내리거나 90초 넘게 느리게 만들 수 없다(서버·컨테이너 변경 금지). 그래서 BE 의 오류 응답(504 COMPANION_TIMEOUT, 503 COMPANION_UNAVAILABLE)을 화면에서 가로채 ' +
          '화면 안내와 대화 유지만 확인했다. 서버 쪽(트랜잭션이 걸린 채 멈추지 않음, 기분 0·정상으로 저장되지 않음)은 확인하지 못했다. ' +
          '문서에 코드명이 없어 확인 필요였고, 코드는 COMPANION_UNAVAILABLE 503 / COMPANION_TIMEOUT 504 이다.',
      });
    } finally {
      await context.close();
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });
});
