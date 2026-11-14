/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1a: 챗봇 화면 (보호자 /guardian/chatbot, 피보호자 /ward/chatbot)
 * 근거: FE 배포본 a8666240 ChatbotContent·ChatBubble·ChatUiPrompt·chatPolicy, BE 3-16
 * 챗 전송은 Claude(AI) 를 실제로 부른다. 예약은 절대 확정하지 않는다(대상 선택 단계까지만).
 */
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

import { Page } from '@playwright/test';

import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { acceptNextConfirm, expect, test } from '../../../src/fixtures';
import { tokenCookies } from '../../../src/session';
import { connect } from '../../../src/variables';
import { aiPsql } from './_helpers-chat';
import { callFull, chatLogs, cleanupChat, loginSafe, TAGS, track } from './_helpers-chat-p1a';

const isChatPost = (role: 'guardian' | 'ward') => (r: { url(): string; request(): { method(): string } }) =>
  r.url().endsWith(`/api/${role}/chat`) && r.request().method() === 'POST';

/** 보호자 화면에서 글을 써서 보내고, 요청 본문과 응답을 돌려준다 */
async function askGuardian(page: Page, text: string) {
  await page.getByLabel('궁금한 점 입력').fill(text);
  const [response] = await Promise.all([
    page.waitForResponse(isChatPost('guardian'), { timeout: 150_000 }),
    page.getByRole('button', { name: '보내기' }).click(),
  ]);
  return { request: response.request().postDataJSON() as Record<string, any>, status: response.status(), json: await response.json() };
}

test.describe('CHAT P1a - 챗봇 화면', () => {
  test.afterEach(async () => {
    await cleanupChat(test.info());
  });

  test('CHAT-A22 AI 서버 장애 시 503, 130초 초과 시 504 (화면 안내)', TAGS, async ({ tempUser, browser }) => {
    test.setTimeout(300_000);
    const g = track(await loginSafe(await tempUser('GUARDIAN')));
    // 일부러 만든 503/504 를 공용 감시(openAs 의 5xx 감시)가 버그로 세지 않도록, 이 테스트는 직접 컨텍스트를 연다
    const context = await browser.newContext({ ...contextDefaults, storageState: { cookies: tokenCookies(g.login), origins: [] } });
    await context.addInitScript(installPageStubs(), pageStubArg);
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      await runA22(page, g);
    } finally {
      await context.close();
    }
    expect(pageErrors, '화면에서 JS 예외 없음').toEqual([]);
  });

  async function runA22(page: Page, g: Awaited<ReturnType<typeof loginSafe>>) {
    const origin = new URL(process.env.E2E_BASE_URL ?? 'https://devdmu.gosky.kr').origin;
    let calls = 0;
    // 서버 응답만 503/504 로 바꾼다 (AI 서버를 끌 수 없어 응답 모양을 BE 문서의 오류 응답으로 흉내 낸다). 세 번째 전송부터는 진짜 서버로 보낸다
    await page.route('**/api/guardian/chat', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      calls++;
      if (calls > 2) return route.fallback();
      const [status, code] = calls === 1 ? [503, 'CHAT_UNAVAILABLE'] : [504, 'CHAT_TIMEOUT'];
      return route.fulfill({
        status,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
        body: JSON.stringify({ success: false, code, message: code === 'CHAT_UNAVAILABLE' ? 'AI 상담 서비스를 사용할 수 없습니다.' : 'AI 응답 시간이 초과되었습니다.' }),
      });
    });
    await page.goto('/guardian/chatbot');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 의료 챗봇' })).toBeVisible();

    const secret = `비밀상담${Date.now().toString(36)}`;
    const input = page.getByLabel('궁금한 점 입력');
    await input.fill(`${secret} 요즘 가슴이 답답해요`);
    await Promise.all([page.waitForResponse(isChatPost('guardian')), page.getByRole('button', { name: '보내기' }).click()]);
    const unavailable = page.getByText('지금은 상담을 이용할 수 없어요. 잠시 후 다시 시도해 주세요.');
    await expect(unavailable, '503 안내 문구').toBeVisible();
    // 다시 보낼 수 있다: 입력창이 다시 열린다
    await expect(input).toBeEnabled();

    await input.fill(`${secret} 다시 보냅니다`);
    await Promise.all([page.waitForResponse(isChatPost('guardian')), page.getByRole('button', { name: '보내기' }).click()]);
    await expect(page.getByText('답변이 오래 걸리고 있어요. 다시 시도해 주세요.'), '504 안내 문구').toBeVisible();

    // 오류 안내 말풍선에는 상담 내용(내가 쓴 글)이 들어가지 않는다
    // (안내 문구 글자만 고르면 항상 참이라, 말풍선 전체의 글을 본다. 내 말풍선에는 상담 내용이 있다는 대조도 함께 본다)
    const userBubbles = await page.locator('[class*="bubbleUser"]').allInnerTexts();
    expect(userBubbles.some(t => t.includes(secret)), '대조: 내 말풍선에는 상담 내용이 있다').toBe(true);
    for (const text of ['지금은 상담을 이용할 수 없어요. 잠시 후 다시 시도해 주세요.', '답변이 오래 걸리고 있어요. 다시 시도해 주세요.']) {
      const row = page.locator('[class*="rowAssistant"]').filter({ hasText: text });
      await expect(row, `오류 안내가 든 말풍선 줄 (${text.slice(0, 6)}...)`).toHaveCount(1);
      expect(await row.innerText(), '오류 말풍선 전체에 상담 내용이 없다').not.toContain(secret);
    }

    // 다시 보내기: 같은 입력창으로 보내면 이번에는 정상 응답이 화면에 그려진다
    await input.fill('안녕하세요');
    const [ok] = await Promise.all([page.waitForResponse(isChatPost('guardian'), { timeout: 150_000 }), page.getByRole('button', { name: '보내기' }).click()]);
    expect(ok.status(), '다시 보낸 전송').toBe(200);
    expect(calls, '서버로 간 전송 횟수(가로챈 2번 + 진짜 1번)').toBe(3);

    // FE 대기 시간은 BE 호출 상한(130초)보다 길다 (배포본 코드에서 확인: 권장 140초 이상)
    const src = spawnSync('git', ['-C', path.join(homedir(), 'SilverBridgeFe'), 'show', 'a8666240:src/service/api/chat.ts'], { encoding: 'utf8' }).stdout ?? '';
    const timeoutMs = Number(/sendChatMessage[\s\S]*?timeout:\s*([\d_]+)/.exec(src)?.[1]?.replace(/_/g, ''));
    expect(timeoutMs, 'FE 챗 전송 timeout(ms)').toBeGreaterThanOrEqual(140_000);
    test.info().annotations.push({
      type: '확인 범위',
      description: 'FE 화면만 확인, BE 503/504 는 미검증. AI 서버를 내리거나 130초 넘게 막을 수 없어 503/504 응답은 화면 요청 단계에서 가로채 만들었다. 실제 BE 503/504 코드는 코드(ChatRelayService·AiChatClient)로만 확인했다. 문서의 "다시 보내기"는 별도 버튼이 아니라 같은 입력창에 다시 쓰는 것이다.',
    });
    void g;
  }

  test('CHAT-N11 피보호자 챗 전송 정상 응답', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(300_000);
    const w = track(await loginSafe(await tempUser('WARD')));

    // API: POST /api/ward/chat
    const sent = await callFull(w.api, 'POST', '/api/ward/chat', { message: '요즘 눈이 침침해요', sessionId: `qan11${Date.now().toString(36)}`, context: {} });
    expect(sent.status, 'POST /api/ward/chat').toBe(200);
    expect(sent.json.data.reply).toBeTruthy();
    expect(['low', 'medium', 'high']).toContain(sent.json.data.riskLevel);

    // 화면: 추천 질문 버튼을 눌러 질문한다
    const page = await openAs(w.who, '/ward/chatbot');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 의료 챗봇' })).toBeVisible();
    const quick = page.getByRole('region', { name: '추천 질문' }).getByRole('button').first();
    await expect(quick).toBeVisible();
    const [response] = await Promise.all([page.waitForResponse(isChatPost('ward'), { timeout: 150_000 }), quick.click()]);
    expect(response.status(), '화면에서 보낸 전송').toBe(200);
    const data = (await response.json()).data;
    expect(['low', 'medium', 'high']).toContain(data.riskLevel);
    // 답변이 화면에 보인다 (핵심 줄이 있으면 그 글, 없으면 reply)
    const shown: string = data.layout?.headline ?? data.reply;
    const needle = /[가-힣]{4,}/.exec(shown)?.[0];
    expect(needle, '화면에서 찾을 답변 글자').toBeTruthy();
    await expect(page.locator('[class*="wardChatCard"]'), '대화 카드에 답변이 보인다').toContainText(needle!);
    // 위험도: 화면은 위험(high)일 때만 긴급 표시를 그린다. 그 밖의 값은 별도 글자로 보이지 않는다
    const urgent = page.getByRole('region', { name: '119 전화' });
    if (data.riskLevel === 'high') await expect(urgent, '위험 답변이면 119 안내').toBeVisible();
    else await expect(urgent, '위험이 아니면 119 안내 없음').toHaveCount(0);
    test.info().annotations.push({ type: '문서와 다른 점', description: `문서는 "위험도가 화면에 보인다". 배포본 FE 는 위험도 글자를 따로 그리지 않고 high 일 때만 긴급 상자·119 패널로 보인다(이번 응답 ${data.riskLevel}).` });
    expect((await chatLogs(w.api, 'ward')).length, '기록 2건(API 1 + 화면 1)').toBe(2);
  });

  test('CHAT-N12 되묻기 칩을 눌러 uiSelection 만으로 전송', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(300_000);
    const gUser = await tempUser('GUARDIAN');
    const wUser = await tempUser('WARD', { name: '큐에이한울' });
    connect(gUser.id, wUser.id);
    const g = track(await loginSafe(gUser));
    track(await loginSafe(wUser));
    const page = await openAs(g.who, '/guardian/chatbot');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 의료 챗봇' })).toBeVisible();

    const first = await askGuardian(page, '병원 예약을 하고 싶어요');
    expect(first.status).toBe(200);
    const ui = first.json.data.ui;
    expect(ui, 'AI 가 선택지(ui)를 준다').toBeTruthy();
    expect(ui.kind).toBe('select');
    const chip = page.locator('button[class*="chip"]').filter({ hasText: '큐에이한울' });
    await expect(chip, '되묻기 칩').toBeVisible();

    const [response] = await Promise.all([page.waitForResponse(isChatPost('guardian'), { timeout: 150_000 }), chip.click()]);
    const body = response.request().postDataJSON() as Record<string, any>;
    expect(body.uiSelection, 'uiSelection 만 간다').toEqual({ field: ui.field, value: expect.any(String) });
    // 배포 FE(ChatbotContent)는 칩을 누르면 message 를 undefined 로 보내 JSON 에서 칸이 빠진다
    expect(body, 'message 칸이 아예 없다').not.toHaveProperty('message');
    expect(response.status(), 'message 없이 uiSelection 만으로 통과').toBe(200);
    const next = (await response.json()).data;
    expect(next.reply, '이어진 답변').toBeTruthy();
    // 이어진 답변이 화면에 보인다
    const needle = /[가-힣]{4,}/.exec(next.layout?.headline ?? next.reply)?.[0];
    await expect(page.locator('body')).toContainText(needle!);
  });

  test('CHAT-N15 같은 sessionId 로 이어 말하면 서버 기록으로 맥락 유지', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(420_000);
    const g = track(await loginSafe(await tempUser('GUARDIAN')));
    const page = await openAs(g.who, '/guardian/chatbot');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 의료 챗봇' })).toBeVisible();

    const a = await askGuardian(page, '며칠 전부터 무릎 관절이 계속 아파요');
    expect(a.status).toBe(200);
    const b = await askGuardian(page, '그럼 어디가 아픈 걸까요');
    expect(b.status).toBe(200);
    expect(b.request.sessionId, '같은 대화창은 같은 sessionId').toBe(a.request.sessionId);
    expect(a.request, '첫 요청에 history 를 싣지 않는다').not.toHaveProperty('history');
    expect(b.request, '두 번째 요청에도 history 를 싣지 않는다(맥락은 서버 기록으로)').not.toHaveProperty('history');
    expect(JSON.stringify(b.json.data), '2번째 답이 앞 대화(무릎·관절)를 반영한다').toMatch(/무릎|관절/);

    // 서버 기록도 한 대화창으로 묶인다
    const logs = await chatLogs(g.api, 'guardian');
    expect(logs.map(l => l.sessionId)).toEqual([a.request.sessionId, a.request.sessionId]);

    // 새 대화는 다른 sessionId
    acceptNextConfirm(page, /새로 시작/);
    await page.getByRole('button', { name: '새 대화' }).click();
    const c = await askGuardian(page, '안녕하세요');
    expect(c.status).toBe(200);
    expect(c.request.sessionId, '새 대화는 새 sessionId').not.toBe(a.request.sessionId);
    const distinct = aiPsql(`SELECT count(DISTINCT context_json::json->>'sessionId') FROM chat_logs WHERE user_id = '${g.user.id}';`);
    test.info().annotations.push({ type: '실측', description: `AI 서버 기록의 context 안 sessionId 종류 수 ${distinct}` });
    expect(distinct.trim(), '기록의 sessionId 는 2종류(이어 말한 대화 1 + 새 대화 1)').toBe('2');
  });

  test('CHAT-N22 보호자 예약 대상 선택 화면', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(300_000);
    const gUser = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD', { name: '큐에이한울' });
    const w2 = await tempUser('WARD', { name: '큐에이다솜' });
    const stranger = await tempUser('WARD', { name: '큐에이남남' }); // 연결 없음
    connect(gUser.id, w1.id);
    connect(gUser.id, w2.id);
    const g = track(await loginSafe(gUser));
    track(await loginSafe(w1));
    track(await loginSafe(w2));
    const page = await openAs(g.who, '/guardian/chatbot');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 의료 챗봇' })).toBeVisible();

    const first = await askGuardian(page, '병원 예약을 하고 싶어요');
    expect(first.status).toBe(200);
    const ui = first.json.data.ui;
    expect(ui?.field, '예약 대상 선택 칸').toBe('reservation_patient');
    const options = (ui.options as Array<string | { value: string; label?: string }>).map(o => (typeof o === 'string' ? o : o.value));
    expect([...options].sort(), '선택지는 연결된 피보호자뿐').toEqual([w1.id, w2.id].sort());
    expect(options, '연결 안 된 사람은 없다').not.toContain(stranger.id);
    for (const name of ['큐에이한울', '큐에이다솜']) {
      await expect(page.locator('button[class*="chip"]').filter({ hasText: name }), `${name} 칩`).toBeVisible();
    }
    await expect(page.locator('body')).not.toContainText('큐에이남남');

    // 한 명을 고른다: 선택한 사람의 ID 가 uiSelection 과 context.wardId 로 같이 간다
    const [response] = await Promise.all([
      page.waitForResponse(isChatPost('guardian'), { timeout: 150_000 }),
      page.locator('button[class*="chip"]').filter({ hasText: '큐에이다솜' }).click(),
    ]);
    const body = response.request().postDataJSON() as Record<string, any>;
    expect(body.uiSelection).toEqual({ field: 'reservation_patient', value: w2.id });
    expect(body.context?.wardId, 'context.wardId 도 같은 사람').toBe(w2.id);
    expect(response.status()).toBe(200);
    const next = (await response.json()).data;
    expect(next.intent, '예약 흐름이 이어진다').toBe('hospital_reservation');
    expect(next.ui?.field, '다음 단계(진료과)로 넘어간다').toBe('department');
    // 이 상담은 선택한 피보호자 대신 상담으로 기록되고, AI 서버에 간 context 의 환자는 선택한 사람(DB 이름)이다
    const logs = await chatLogs(g.api, 'guardian');
    expect(logs.find(l => l.wardId === w2.id), '선택한 피보호자 기록').toBeTruthy();
    expect(logs.some(l => l.wardId === w1.id), '고르지 않은 피보호자 기록은 없다').toBe(false);
    const ctxOwner = aiPsql(`SELECT coalesce(context_json::json#>>'{userContext,wardId}','') FROM chat_logs WHERE id = ${Number(next.chatLogId)} AND user_id = '${gUser.id}';`);
    expect(ctxOwner, '선택 턴의 환자(userContext.wardId)').toBe(w2.id);
    test.info().annotations.push({ type: '문서와 다른 점', description: '이어진 AI 답(진료과 질문)에는 피보호자 이름이 글로 나오지 않는다. "선택한 사람 이름으로 진행"은 기록의 wardId 와 AI 서버에 저장된 context 의 wardId 로 확인했다(이름 칸은 이 턴 context 에 안 남는다).' });
    test.info().annotations.push({ type: '안전', description: '예약은 확정하지 않았다(대상 선택 단계까지). 끝나면 보호자·피보호자를 탈퇴시켜 AI 서버 기록·예약 계정을 지운다.' });
  });
});
