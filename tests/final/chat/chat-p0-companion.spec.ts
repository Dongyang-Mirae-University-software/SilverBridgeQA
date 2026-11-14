/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P0: 안부 말벗 (/api/ward/companion/*, /api/guardian/ward/{id}/companion/*)
 * 근거: BE 프로젝트_설명.txt 3-21 (2440-2510행), CompanionService·CompanionGuardianService·CompanionSessionWriter,
 *       FE 배포본 a8666240 GuardianEmotionContent·GuardianCompanionSessionContent
 * dev 는 모든 피보호자가 테스트 계정(testMode=true)이라 시각과 상관없이 시간대를 골라 대화를 열 수 있다.
 * 대답마다 Claude(AI) 를 실제로 부른다. 위험 알림은 보호자 문자 대체 발송을 Redis 상한 키로 막고 이력만 확인한다.
 */
import { request } from '@playwright/test';

import { env } from '../../../src/env';
import { countBackendLog } from '../../../src/remote';
import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import {
  RISK_TEXT, NORMAL_TEXT, call, callAnonymous, companionTurnTexts, disconnectAsGuardian, finishSession, marker,
  clearCompanionRiskSmsKeys, notificationRows, openTestSession, replyText, riskDispatchLogCount, sleep, suppressCompanionRiskSms,
  waitForNotificationRows, waitForRiskDispatchLog,
} from './_helpers-chat';

const TAGS = { tag: ['@P0', '@CHAT'] };

function todayKst() {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

async function logged(needle: string) {
  for (let i = 0; i < 4; i++) {
    if (countBackendLog(needle) > 0) return true;
    await sleep(1_500);
  }
  return false;
}

test.describe('CHAT P0 - 안부 말벗', () => {
  // 문자 대체 상한 키는 이 테스트의 임시 보호자 것만 넣었으므로 끝날 때 그 키만 지운다
  test.afterEach(() => clearCompanionRiskSmsKeys());

  test('CHAT-N35 대화 저장 동의 기본 꺼짐, 동의 후 다음 대화부터 글 저장', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);

    // 기본은 동의 안 함
    const consent0 = await call(ward.api, 'GET', '/api/ward/companion/transcript-consent');
    expect(consent0.status).toBe(200);
    expect(consent0.json.data.consented).toBe(false);
    expect(consent0.json.data.consentedAt).toBeNull();
    expect(consent0.json.data.retentionDays).toBe(30);

    // 동의 전 대화: 글은 저장되지 않고 기분은 저장된다
    const before = await openTestSession(ward.api, '18:00');
    expect((await replyText(ward.api, before, NORMAL_TEXT)).status).toBe(200);
    const beforeResult = await finishSession(ward.api, before);
    expect(beforeResult.status).toBe(200);
    expect(beforeResult.json.data.mood, '동의와 상관없이 기분은 저장').toBeTruthy();
    expect(companionTurnTexts(before)).toEqual([expect.objectContaining({ hasAnswer: false, hasBot: false })]);

    // 동의
    const put = await call(ward.api, 'PUT', '/api/ward/companion/transcript-consent', { consent: true });
    expect(put.status).toBe(200);
    expect(put.json.data.consented).toBe(true);
    expect(put.json.data.consentedAt).toBeTruthy();
    expect((await call(ward.api, 'GET', '/api/ward/companion/transcript-consent')).json.data.consented).toBe(true);

    // 동의 뒤 대화: 말벗이 한 말과 어르신 답이 저장된다
    const after = await openTestSession(ward.api, '12:00');
    expect((await replyText(ward.api, after, NORMAL_TEXT)).status).toBe(200);
    expect((await finishSession(ward.api, after)).status).toBe(200);
    const turns = companionTurnTexts(after);
    expect(turns).toHaveLength(1);
    expect(turns[0].hasAnswer, '어르신 답 저장').toBe(true);
    expect(turns[0].hasBot, '말벗 말 저장').toBe(true);
    expect(turns[0].mood).toBeTruthy();

    // 보호자 화면: 동의 뒤 대화는 글이 보이고, 동의 전 대화는 글이 없다(기분은 보임)
    const seen = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${after}`);
    expect(seen.status).toBe(200);
    expect(seen.json.data.transcript).toBe('AVAILABLE');
    expect(seen.json.data.turns[0].answerText).toBe(NORMAL_TEXT);
    expect(seen.json.data.turns[0].botText).toBeTruthy();
    const old = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${before}`);
    expect(old.json.data.transcript).toBe('NO_CONSENT');
    expect(old.json.data.turns[0].answerText).toBeNull();
    expect(old.json.data.turns[0].mood).toBeTruthy();
    test.info().annotations.push({
      type: '확인 못 한 부분',
      description: '음성 대답(받아 적은 글 저장)은 실제 음성 파일·STT 가 필요해 글 대답으로만 확인했다.',
    });
  });

  test('CHAT-N36 동의 철회 즉시 저장된 글 삭제, 기분은 유지', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);
    const answer = `${marker('QAN36')} ${NORMAL_TEXT}`;

    expect((await call(ward.api, 'PUT', '/api/ward/companion/transcript-consent', { consent: true })).status).toBe(200);
    const sessionId = await openTestSession(ward.api, '09:00');
    expect((await replyText(ward.api, sessionId, answer)).status).toBe(200);
    const finished = await finishSession(ward.api, sessionId);
    const mood = finished.json.data.mood as string;
    expect(mood).toBeTruthy();
    expect(companionTurnTexts(sessionId)[0]).toEqual(expect.objectContaining({ hasAnswer: true, hasBot: true }));
    const visible = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${sessionId}`);
    expect(visible.json.data.transcript).toBe('AVAILABLE');

    // 철회: 저장된 글은 그 자리에서 지워지고 기분은 남는다
    const revoke = await call(ward.api, 'PUT', '/api/ward/companion/transcript-consent', { consent: false });
    expect(revoke.status).toBe(200);
    expect(revoke.json.data.consented).toBe(false);
    expect(revoke.json.data.consentedAt).toBeNull();
    const turns = companionTurnTexts(sessionId);
    expect(turns).toHaveLength(1);
    expect(turns[0].hasAnswer, '철회 즉시 어르신 답 삭제').toBe(false);
    expect(turns[0].hasBot, '철회 즉시 말벗 말 삭제').toBe(false);
    expect(turns[0].mood, '턴 기분은 유지').toBeTruthy();

    // 보호자는 글을 더 볼 수 없고 기분은 그대로 본다
    const after = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${sessionId}`);
    expect(after.status).toBe(200);
    expect(after.json.data.mood).toBe(mood);
    expect(after.json.data.transcript).toBe('NO_CONSENT');
    expect(after.json.data.turns[0].answerText).toBeNull();
    expect(after.json.data.turns[0].botText).toBeNull();
    expect(after.text).not.toContain(answer);

    const page = await openAs(guardian.who, `/guardian/emotion/sessions/${sessionId}?wardId=${wardUser.id}`);
    await expect(page.getByRole('heading', { name: /나눈 이야기/ })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(answer);
  });

  test('CHAT-N38 위험 신호 때 보호자에게 위험 알림(끌 수 없는 강제 푸시)', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD', { name: `위험확인${marker('Z')}`.slice(0, 12) });
    connect(guardianUser.id, wardUser.id);
    suppressCompanionRiskSms(guardianUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);

    // 보호자 알림을 모두 끈다
    const off = await call(guardian.api, 'PUT', '/api/user/me/notification-settings', {
      settings: ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: false })),
    });
    expect(off.status, '알림 모두 끄기').toBe(200);
    const check = await call(guardian.api, 'GET', '/api/user/me/notification-settings');
    expect(check.json.data.settings.every((s: { enabled: boolean }) => s.enabled === false), '채널이 모두 꺼져 있다').toBe(true);

    const sessionId = await openTestSession(ward.api, '09:00');
    const turn = await replyText(ward.api, sessionId, RISK_TEXT);
    expect(turn.status).toBe(200);
    expect(turn.json.data.analysis.riskFlag, 'AI 가 위험 신호로 판단').toBe(true);
    expect((await finishSession(ward.api, sessionId)).json.data.analysis.alertLevel).toBe('URGENT');

    const rows = await waitForNotificationRows(guardianUser.id, 1);
    expect(rows, 'COMPANION_RISK 알림 이력').toHaveLength(1);
    expect(rows[0].result, '설정을 꺼도 보내려고 시도한다 (NOT_SENT 아님)').not.toBe('NOT_SENT');
    // 채널별 결과(JSON)에서 FCM 칸이 "설정 꺼짐으로 건너뜀" 이 아니라 실제 시도 결과여야 한다
    const channelResults = JSON.parse(rows[0].channels) as unknown;
    const fcmEntry = Array.isArray(channelResults)
      ? (channelResults as Array<Record<string, unknown>>).find(c => [c.channel, c.channelType, c.type].includes('FCM'))
      : (channelResults as Record<string, unknown>)?.FCM;
    test.info().annotations.push({ type: '실측', description: `FCM 채널 결과: ${JSON.stringify(fcmEntry)}` });
    expect(fcmEntry, '채널 결과에 FCM 칸이 있다').toBeTruthy();
    expect(JSON.stringify(fcmEntry), '푸시(FCM)는 설정 꺼짐 건너뜀이 아니라 시도 결과(SENT·FAILED·NO_DEVICE 등)').toMatch(/SENT|FAILED|NO_DEVICE|NO_TOKEN|DELIVERED|ATTEMPT/i);
    expect(JSON.stringify(fcmEntry), '설정 꺼짐으로 건너뛰지 않았다').not.toMatch(/SKIP|DISABLED|SETTING_OFF|OPT_OUT/i);
    // 문구에 대화 내용이 없다
    expect(rows[0].title).toBe('안부 말벗 확인 필요');
    expect(rows[0].body).toContain(wardUser.name);
    expect(rows[0].body).not.toContain('죽');
    expect(rows[0].body).not.toContain(RISK_TEXT);
    // 받은 알림함에도 긴급으로 1건
    const inbox = await call(guardian.api, 'GET', '/api/user/me/notifications');
    const risk = inbox.json.data.content.filter((n: { type: string }) => n.type === 'COMPANION_RISK');
    expect(risk).toHaveLength(1);
    expect(JSON.stringify(risk[0])).not.toContain('죽');
  });

  test('CHAT-N41 기분을 판단 못 하면 null (정상·0 아님)', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);

    // 대답 없이 마친 대화 = AI 가 기분을 판단할 근거가 없는 대화
    const sessionId = await openTestSession(ward.api, '12:00');
    const finished = await finishSession(ward.api, sessionId);
    expect(finished.status).toBe(200);
    expect(finished.json.data.mood, '결과 mood').toBeNull();
    expect(finished.json.data.analysis.answeredCount).toBe(0);

    const wardToday = await call(ward.api, 'GET', '/api/ward/companion/today');
    const slot = wardToday.json.data.slots.find((s: { slot: string }) => s.slot === '12:00');
    expect(slot.status).toBe('DONE');
    expect(slot.mood, '피보호자 오늘 현황 mood').toBeNull();

    const gToday = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/today`);
    expect(gToday.json.data.current.mood, '보호자 지금 기분').toBeNull();
    const gSlot = gToday.json.data.slots.find((s: { slot: string }) => s.slot === '12:00');
    expect(gSlot.mood).toBeNull();
    const week = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/week`);
    expect(week.json.data.days.at(-1).mood, '주간 오늘 mood').toBeNull();

    // 화면: "확인할 수 없어요", 정상·기쁨·0 으로 채우지 않는다
    const page = await openAs(guardian.who, '/guardian/emotion');
    const now = page.getByRole('region', { name: '지금 기분' });
    await expect(now).toBeVisible();
    await expect(now).toContainText('지금 기분은 확인할 수 없어요');
    await expect(page.getByText('확인할 수 없어요').nth(1), '시간대 칸에도 표시').toBeVisible();
    await expect(page.getByRole('button', { name: '오늘 기분 기록 없음' })).toBeVisible();
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/정상|기쁨 상태|평온 상태/);
    test.info().annotations.push({
      type: '확인 범위',
      description: 'AI 가 판단 못 하는 입력을 만들 수 없어 "대답 없이 마친 대화(mood=null)" 로 대신했다.',
    });
  });

  test('CHAT-A33 로그인 없음 401, 역할 다름 403', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await loginAs(await tempUser('GUARDIAN'));
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    const admin = await loginAs(await tempUser('ADMIN'));
    const date = todayKst();

    const wardCalls: Array<['GET' | 'POST' | 'PUT', string, unknown?]> = [
      ['GET', '/api/ward/companion/today'],
      ['GET', '/api/ward/companion/transcript-consent'],
      ['PUT', '/api/ward/companion/transcript-consent', { consent: true }],
      ['POST', '/api/ward/companion/sessions'],
      ['POST', '/api/ward/companion/test/sessions', { slot: '09:00' }],
      ['POST', '/api/ward/companion/sessions/1/reply', { text: '안녕' }],
      ['POST', '/api/ward/companion/sessions/1/finish'],
    ];
    for (const [method, path, body] of wardCalls) {
      expect((await callAnonymous(method, path, body)).status, `토큰 없음 ${method} ${path}`).toBe(401);
      expect((await call(guardian.api, method, path, body)).status, `보호자 토큰 ${method} ${path}`).toBe(403);
      expect((await call(admin.api, method, path, body)).status, `관리자 토큰 ${method} ${path}`).toBe(403);
    }
    const base = `/api/guardian/ward/${wardUser.id}/companion`;
    for (const path of [`${base}/today`, `${base}/week`, `${base}/days/${date}`, `${base}/sessions/1`]) {
      expect((await callAnonymous('GET', path)).status, `토큰 없음 GET ${path}`).toBe(401);
      expect((await call(ward.api, 'GET', path)).status, `피보호자 토큰 GET ${path}`).toBe(403);
      expect((await call(admin.api, 'GET', path)).status, `관리자 토큰 GET ${path}`).toBe(403);
    }
    // 위 호출이 동의 상태를 바꾸지 않았다 (피보호자 본인 값은 기본 꺼짐)
    expect((await call(ward.api, 'GET', '/api/ward/companion/transcript-consent')).json.data.consented).toBe(false);
  });

  test('CHAT-A34 남의 대화 session id 로 reply·finish (IDOR)', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const owner = await loginAs(await tempUser('WARD'));
    const attackerUser = await tempUser('WARD');
    const attacker = await loginAs(attackerUser);
    const sessionId = await openTestSession(owner.api, '15:00');

    const reply = await replyText(attacker.api, sessionId, '남의 대화에 끼어들기');
    expect(reply.status).toBe(403);
    expect(reply.json?.code).toBe('COMPANION_SESSION_NOT_OWNED');
    const finish = await finishSession(attacker.api, sessionId);
    expect(finish.status).toBe(403);
    expect(finish.json?.code).toBe('COMPANION_SESSION_NOT_OWNED');

    // 음성 대답 경로 (multipart) 도 같다
    const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${attacker.login.accessToken}` } });
    try {
      const audio = await ctx.post(`/api/ward/companion/sessions/${sessionId}/reply/audio`, {
        multipart: { audio: { name: 'a.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF0000WAVEfmt ') } },
      });
      expect(audio.status()).toBe(403);
      expect((await audio.json()).code).toBe('COMPANION_SESSION_NOT_OWNED');
    } finally {
      await ctx.dispose();
    }
    expect(await logged(`[IDOR-ATTEMPT] 다른 피보호자의 안부 대화 접근 시도: wardId=${attackerUser.id}`), '[IDOR-ATTEMPT] 로그').toBe(true);

    // 주인의 대화는 그대로 열려 있다 (남이 끝내지 못했다) - 주인이 마친다
    const own = await finishSession(owner.api, sessionId);
    expect(own.status).toBe(200);
    expect(own.json.data.sessionId).toBe(sessionId);
  });

  test('CHAT-A35 연결 안 된 피보호자의 말벗 기록 조회 (IDOR)', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    const neverUser = await tempUser('GUARDIAN');
    const never = await loginAs(neverUser);
    const droppedUser = await tempUser('GUARDIAN');
    connect(droppedUser.id, wardUser.id);
    const dropped = await loginAs(droppedUser);
    await disconnectAsGuardian(dropped.api, droppedUser.id, wardUser.id);

    const sessionId = await openTestSession(ward.api, '15:00');
    const date = todayKst();
    const base = `/api/guardian/ward/${wardUser.id}/companion`;
    for (const [label, who] of [['연결 없음', never], ['연결 해제됨', dropped]] as const) {
      for (const path of [`${base}/today`, `${base}/week`, `${base}/days/${date}`, `${base}/sessions/${sessionId}`]) {
        const res = await call(who.api, 'GET', path);
        expect(res.status, `${label} GET ${path}`).toBe(403);
        expect(res.json?.code, `${label} GET ${path}`).toBe('COMPANION_NOT_AUTHORIZED');
        expect(res.json?.data, `${label} 데이터 없음`).toBeUndefined();
      }
    }
    for (const id of [neverUser.id, droppedUser.id]) {
      expect(await logged(`[IDOR-ATTEMPT] 연결되지 않은 피보호자 안부 대화 조회 시도: guardianId=${id}`), `[IDOR-ATTEMPT] ${id}`).toBe(true);
    }
    await finishSession(ward.api, sessionId); // 열어 둔 대화를 마친다
  });

  test('CHAT-A36 새로 연결한 보호자는 연결 전 대화를 못 본다', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginAs(wardUser);
    const guardianUser = await tempUser('GUARDIAN');
    const guardian = await loginAs(guardianUser);

    // 연결 전에 대화를 마친다 (실제 기분이 기록된다)
    const sessionId = await openTestSession(ward.api, '15:00');
    expect((await replyText(ward.api, sessionId, NORMAL_TEXT)).status).toBe(200);
    const finished = await finishSession(ward.api, sessionId);
    expect(finished.json.data.mood, '연결 전 대화에는 기분이 있다').toBeTruthy();
    await sleep(2_000);
    connect(guardianUser.id, wardUser.id);

    const base = `/api/guardian/ward/${wardUser.id}/companion`;
    const week = await call(guardian.api, 'GET', `${base}/week`);
    expect(week.status).toBe(200);
    expect(week.json.data.days.every((d: { mood: string | null }) => d.mood === null), '주간 기분이 모두 비어 있다').toBe(true);
    const day = await call(guardian.api, 'GET', `${base}/days/${todayKst()}`);
    expect(day.status).toBe(200);
    expect(day.json.data.current, '지금 기분 없음').toBeNull();
    expect(day.json.data.answeredCount).toBe(0);
    for (const slot of day.json.data.slots) {
      expect(slot.sessionId, `${slot.slot} 대화 없음`).toBeNull();
      expect(slot.mood).toBeNull();
    }
    const detail = await call(guardian.api, 'GET', `${base}/sessions/${sessionId}`);
    expect(detail.status, '연결 전 대화 상세').toBe(404);
    expect(detail.json?.code).toBe('COMPANION_SESSION_NOT_FOUND');
  });

  test('CHAT-A37 동의 안 한 대화는 보호자에게 글이 빠져 보인다', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);
    const m = marker('QAA37');
    const answer = `${m} 점심에 국수를 먹었어요`;

    const sessionId = await openTestSession(ward.api, '12:00');
    const turn = await replyText(ward.api, sessionId, answer);
    expect(turn.status).toBe(200);
    expect((await finishSession(ward.api, sessionId)).status).toBe(200);

    const res = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${sessionId}`);
    expect(res.status).toBe(200);
    const data = res.json.data;
    expect(data.transcript).toBe('NO_CONSENT');
    expect(data.mood, '기분은 보인다').toBeTruthy();
    expect(data.riskAlerted, '위험 표시 칸은 있다').toBe(false);
    for (const t of data.turns) {
      expect(t.answerText).toBeNull();
      expect(t.botText).toBeNull();
    }
    expect(res.text).not.toContain(m);
    expect(countBackendLog(m, 300), 'BE 로그에 대화 내용 없음').toBe(0);
  });

  test('CHAT-A44 위험 알림은 대화당 1번만 (중복 방지)', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    suppressCompanionRiskSms(guardianUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);

    const sessionId = await openTestSession(ward.api, '09:00');
    const first = await replyText(ward.api, sessionId, RISK_TEXT);
    expect(first.status).toBe(200);
    expect(first.json.data.analysis.riskFlag, '첫 위험 신호').toBe(true);
    const rowsAfterFirst = await waitForNotificationRows(guardianUser.id, 1);
    expect(rowsAfterFirst).toHaveLength(1);

    // 같은 대화에서 위험 신호가 또 나오고, 대화를 마칠 때 또 한 번 확인해도 알림은 늘지 않는다
    // 케이스 조건("한 대화에서 위험 신호 두 번")을 반드시 만든다: 첫 대답에서 대화가 끝나면 조건이 안 만들어진 것이라 실패로 둔다
    expect(first.json.data.ended, '첫 위험 대답 뒤에도 대화가 이어져야 두 번째 위험 신호를 보낼 수 있다').toBe(false);
    const second = await replyText(ward.api, sessionId, '정말 사는 게 싫고 죽고 싶어요');
    expect(second.status).toBe(200);
    expect(second.json.data.analysis.riskFlag, '두 번째 위험 신호').toBe(true);
    await finishSession(ward.api, sessionId);
    // 고정 대기 대신 발송 처리 로그를 확인한 뒤 이력 수를 센다 (두 번째·마칠 때 발송이 있었다면 로그도 늘어난다)
    await waitForRiskDispatchLog(wardUser.id, sessionId);
    await waitForNotificationRows(guardianUser.id, 2, 'COMPANION_RISK', 10_000); // 중복이 생긴다면 이 안에 보인다
    expect(riskDispatchLogCount(wardUser.id, sessionId), '발송 처리는 대화당 1번').toBe(1);
    expect(notificationRows(guardianUser.id), '푸시는 대화당 1번').toHaveLength(1);
    const detail = await call(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${sessionId}`);
    expect(detail.json.data.riskAlerted).toBe(true);
  });

  test('CHAT-A46 연결 해제·정지된 보호자는 위험 알림을 못 받는다', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const wardUser = await tempUser('WARD');
    const activeUser = await tempUser('GUARDIAN'); // 대조군: 알림을 받아야 한다
    const droppedUser = await tempUser('GUARDIAN');
    const restrictedUser = await tempUser('GUARDIAN', { status: 'RESTRICTED' });
    connect(activeUser.id, wardUser.id);
    connect(droppedUser.id, wardUser.id);
    connect(restrictedUser.id, wardUser.id);
    suppressCompanionRiskSms(activeUser.id, droppedUser.id, restrictedUser.id);
    const active = await loginAs(activeUser);
    const dropped = await loginAs(droppedUser);
    const ward = await loginAs(wardUser);

    // 위험 대화 직전에 한 보호자가 연결을 해제한다
    await disconnectAsGuardian(dropped.api, droppedUser.id, wardUser.id);

    const sessionId = await openTestSession(ward.api, '09:00');
    const turn = await replyText(ward.api, sessionId, RISK_TEXT);
    expect(turn.status).toBe(200);
    expect(turn.json.data.analysis.riskFlag).toBe(true);
    await finishSession(ward.api, sessionId);

    const activeRows = await waitForNotificationRows(activeUser.id, 1);
    expect(activeRows, '연결 중인 보호자는 알림을 받는다').toHaveLength(1);
    // 발송 처리 로그(보호자 반복이 끝난 뒤에 남는 줄)를 확인한 뒤 센다
    expect(await waitForRiskDispatchLog(wardUser.id, sessionId), '위험 알림 발송 처리 로그').toBeGreaterThan(0);
    expect(notificationRows(droppedUser.id), '연결 해제된 보호자는 알림 이력도 없다').toEqual([]);
    const restrictedRows = notificationRows(restrictedUser.id);
    test.info().annotations.push({ type: '실측', description: `정지 보호자 이력 ${restrictedRows.length}건: ${restrictedRows.map(r => `${r.result}/${r.reason}`).join(',')}` });
    expect(restrictedRows.length, '정지 보호자 이력은 0건이거나 NOT_SENT 1건').toBeLessThanOrEqual(1);
    expect(restrictedRows.every(r => r.result === 'NOT_SENT' && r.reason === 'RESTRICTED_ACCOUNT'), '정지된 보호자에게는 보내지지 않는다').toBe(true);

    // 해제된 보호자는 그 대화를 볼 수 없고, 연결 중인 보호자는 위험 표시를 본다
    const droppedView = await call(dropped.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${sessionId}`);
    expect(droppedView.status).toBe(403);
    expect(droppedView.json?.code).toBe('COMPANION_NOT_AUTHORIZED');
    expect((await call(dropped.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/week`)).status).toBe(403);
    const activeView = await call(active.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${sessionId}`);
    expect(activeView.status).toBe(200);
    expect(activeView.json.data.riskAlerted).toBe(true);
  });

  test('CHAT-X01 말벗 위험 신호가 보호자 알림, 알림 이력, 관리자 집계까지 같게 보인다', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(360_000);
    const wardUser = await tempUser('WARD', { name: `교차${marker('Y')}`.slice(0, 12) });
    const activeUser = await tempUser('GUARDIAN'); // 알림 설정을 모두 꺼 둔 보호자
    const droppedUser = await tempUser('GUARDIAN');
    const restrictedUser = await tempUser('GUARDIAN', { status: 'RESTRICTED' });
    connect(activeUser.id, wardUser.id);
    connect(droppedUser.id, wardUser.id);
    connect(restrictedUser.id, wardUser.id);
    suppressCompanionRiskSms(activeUser.id, droppedUser.id, restrictedUser.id);
    const active = await loginAs(activeUser);
    const dropped = await loginAs(droppedUser);
    const ward = await loginAs(wardUser);
    const admin = await loginAs(await tempUser('ADMIN'));

    const off = await call(active.api, 'PUT', '/api/user/me/notification-settings', {
      settings: ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: false })),
    });
    expect(off.status).toBe(200);
    await disconnectAsGuardian(dropped.api, droppedUser.id, wardUser.id);

    const statsBefore = await call(admin.api, 'GET', '/api/admin/ai-stats/companion');
    expect(statsBefore.status).toBe(200);
    const alertsBefore = statsBefore.json.data.alertSentCount as number;

    const sessionId = await openTestSession(ward.api, '09:00');
    const turn = await replyText(ward.api, sessionId, RISK_TEXT);
    expect(turn.status).toBe(200);
    expect(turn.json.data.analysis.riskFlag).toBe(true);
    await finishSession(ward.api, sessionId);

    // 1) 보호자 푸시: 설정을 꺼도 1번, 문구에 대화 내용 없음
    const rows = await waitForNotificationRows(activeUser.id, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].result).not.toBe('NOT_SENT');
    expect(rows[0].body).not.toContain('죽');
    // 3) 해제·정지된 보호자에게는 가지 않는다 (발송 처리 로그가 나온 뒤에 센다)
    expect(await waitForRiskDispatchLog(wardUser.id, sessionId), '위험 알림 발송 처리 로그').toBeGreaterThan(0);
    expect(notificationRows(droppedUser.id)).toEqual([]);
    const restrictedRows = notificationRows(restrictedUser.id);
    expect(restrictedRows.length, '정지 보호자 이력은 0건이거나 NOT_SENT 1건').toBeLessThanOrEqual(1);
    expect(restrictedRows.every(r => r.result === 'NOT_SENT'), '정지 보호자는 NOT_SENT').toBe(true);

    // 2) 보호자 말벗 화면의 위험 표시
    const view = await call(active.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/sessions/${sessionId}`);
    expect(view.json.data.riskAlerted).toBe(true);
    const page = await openAs(active.who, `/guardian/emotion/sessions/${sessionId}?wardId=${wardUser.id}`);
    await expect(page.getByText(/위험 알림 보냄/)).toBeVisible();

    // 관리자 알림 이력: 이 피보호자의 위험 알림 중 실제 발송 시도는 1줄
    const history = await call(admin.api, 'GET', `/api/admin/notification?keyword=${encodeURIComponent(wardUser.name)}&period=TODAY&size=50`);
    expect(history.status).toBe(200);
    const items = (history.json.data.content as Array<Record<string, any>>).filter(i => i.type === 'COMPANION_RISK' && i.wardId === wardUser.id);
    test.info().annotations.push({ type: '실측', description: `관리자 알림 이력 항목 키: ${Object.keys(items[0] ?? {}).join(',')}` });
    const attempted = items.filter(i => i.result !== 'NOT_SENT');
    expect(attempted, '관리자 알림 이력에 위험 알림 1줄').toHaveLength(1);
    expect(JSON.stringify(attempted[0])).not.toContain('죽');

    // 관리자 말벗 오늘 집계: 위험 알림 보냄 수가 1 늘었다 (같은 대화 1건)
    const statsAfter = await call(admin.api, 'GET', '/api/admin/ai-stats/companion');
    // 같은 시각에 다른 위험 알림이 있을 수 있어 "정확히 1" 이 아니라 "1 이상" 으로 본다 (이 대화 1건은 위 이력·로그로 이미 확인했다)
    const delta = statsAfter.json.data.alertSentCount - alertsBefore;
    test.info().annotations.push({ type: '실측', description: `관리자 오늘 집계 alertSentCount 증가분 ${delta}` });
    expect(delta, '관리자 오늘 집계 증가분(이 대화 1건 이상)').toBeGreaterThanOrEqual(1);
  });
});
