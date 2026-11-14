/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P2: 안부 말벗 (한 대화 8번 주고받기 / 질문 안내 푸시 / 관리자 오늘 집계)
 * 근거: BE 프로젝트_설명.txt 2459·2476·2481-2485, CompanionPromptScheduler·NotificationType·CompanionStatsService, 보호자 말벗 API(attention)
 * 임시 사용자만 쓴다. 대화는 테스트 대화(/test/sessions)로 열고, 끝나면 제품 탈퇴 API 로 지운다.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import { callLong, notificationRows, NORMAL_TEXT, replyText } from './_helpers-chat';
import {
  backdateConnection, openSessionRaw, seedFinishedSession, sessionRow, withdrawQuietly,
} from './_helpers-chat-p1b';
import { callFull, cleanupChat, kstDate, loginSafe, TAGS } from './_helpers-chat-p2';

const TEST_PATH = '/api/ward/companion/test/sessions' as const;
const BE = path.join(homedir(), 'SilverBridgeBe/src/main/java/kr/silverbridge/main/domain');

test.describe('CHAT P2 - 안부 말벗', () => {
  test.afterEach(async () => {
    await cleanupChat(test.info());
  });

  test('CHAT-N34 한 대화에서 최대 8번 주고받기', TAGS, async ({ tempUser }) => {
    test.setTimeout(600_000);
    const wardUser = await tempUser('WARD');
    const ward = await loginSafe(wardUser);
    try {
      const opened = await openSessionRaw(ward.api, TEST_PATH, '09:00');
      expect(opened.status, '테스트 대화 열기').toBe(200);
      expect(opened.maxTurns, '최대 턴 수').toBe(8);
      const id = opened.sessionId;

      const endedFlags: boolean[] = [];
      let last: any = null;
      for (let turn = 1; turn <= 8; turn++) {
        const res = await replyText(ward.api, id, NORMAL_TEXT);
        expect(res.status, `${turn}번째 대답`).toBe(200);
        expect(res.json.data.turnNo, `${turn}번째 대답의 turnNo`).toBe(turn);
        expect(typeof res.json.data.reply, `${turn}번째 말벗 응답 문장`).toBe('string');
        expect(res.json.data.reply.length, `${turn}번째 말벗 응답 문장 길이`).toBeGreaterThan(0);
        endedFlags.push(res.json.data.ended === true);
        last = res.json.data;
        if (res.json.data.ended === true) break;
      }
      // 8번째까지 정상이고, 7번째까지는 대화가 이어지고, 8번째 대답에서 끝난다
      expect(endedFlags, '턴마다 ended (1~7번째는 false, 8번째는 true)').toEqual([false, false, false, false, false, false, false, true]);
      expect(last.endReason, '끝난 이유').toBe('MAX_TURNS');
      expect(sessionRow(id)).toEqual(expect.objectContaining({ status: 'FINISHED', turnCount: 8 }));
      // 끝난 대화에는 더 못 보낸다
      const extra = await callLong(ward.api, 'POST', `/api/ward/companion/sessions/${id}/reply`, { text: NORMAL_TEXT });
      expect(extra.status, '9번째 대답').toBe(409);
      expect(extra.json?.code).toBe('COMPANION_SESSION_ENDED');
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-N40 질문 안내는 하루 5번 앱 푸시만, 문자 없음', TAGS, async ({ tempUser }) => {
    test.setTimeout(240_000);
    // 1) 코드: 5개 시간대에 정각 안내, 채널은 FCM(앱 푸시) 하나뿐
    const scheduler = readFileSync(path.join(BE, 'companion/service/CompanionPromptScheduler.java'), 'utf8');
    expect(scheduler, '정각 스케줄: 09·12·15·18·21시 (KST)').toContain('@Scheduled(cron = "0 0 9,12,15,18,21 * * *", zone = "Asia/Seoul")');
    expect(scheduler, '안내는 COMPANION_PROMPT 알림 하나로 보낸다').toContain('NotificationType.COMPANION_PROMPT');
    expect(scheduler, '스케줄러가 문자·알림톡을 직접 부르지 않는다').not.toMatch(/Sms|Kakao|Alimtalk|SolApi|Solapi/i);
    const slots = readFileSync(path.join(BE, 'companion/entity/CompanionSlot.java'), 'utf8');
    expect([...slots.matchAll(/S\d\d\("(\d\d:\d\d)"/g)].map(m => m[1]), '시간대').toEqual(['09:00', '12:00', '15:00', '18:00', '21:00']);
    const types = readFileSync(path.join(BE, 'notification/dispatch/NotificationType.java'), 'utf8');
    expect(
      /^\s*COMPANION_PROMPT\((.*)\),?\s*$/m.exec(types)?.[1],
      'COMPANION_PROMPT 정책·채널: 사용자 설정 안에서 FCM 만',
    ).toBe('Policy.SETTINGS_ONLY, EnumSet.of(NotificationChannelType.FCM)');

    // 2) 실제 발송 경로: 테스트 안내(정각 안내와 같은 문구·채널)를 임시 피보호자에게 3번 보내고 알림 이력을 본다
    const wardUser = await tempUser('WARD');
    const ward = await loginSafe(wardUser);
    const slotsToSend = ['09:00', '15:00', '21:00'];
    for (const slot of slotsToSend) {
      const res = await callFull(ward.api, 'POST', '/api/ward/companion/test/prompt', { slot }, 30_000);
      expect(res.status, `테스트 안내 ${slot}`).toBe(204);
    }
    const rows = await expect
      .poll(() => notificationRows(wardUser.id, 'COMPANION_PROMPT').length, { message: '알림 이력에 안내 3건', timeout: 40_000 })
      .toBe(3)
      .then(() => notificationRows(wardUser.id, 'COMPANION_PROMPT'));
    for (const row of rows) {
      expect(row.title, '안내 제목').toBe('안부 말벗');
      expect(row.body, '안내 문구').toMatch(/시 안부 인사 시간이에요\. 오늘 이야기를 들려주세요\.$/);
      expect(row.channels, '채널 결과에 문자·알림톡·이메일 없음').not.toMatch(/SMS|KAKAO|ALIMTALK|EMAIL/i);
    }
    expect(rows.map(r => r.body.split(' ')[0] + ' ' + r.body.split(' ')[1]), '시간대별 문구(3건)').toEqual(['오전 9시', '오후 3시', '오후 9시']);
    test.info().annotations.push({
      type: '부분 확인',
      description: '"앱 푸시만 하루 5번"은 직접 확인하지 않았다(통과와 따로 센다). 정각 스케줄러(5번)를 기다려 돌려 보지는 않았다 - 스케줄 표현식·시간대 5개·채널 정의는 코드로, 안내 문구·채널은 테스트 안내 3번(정각 안내와 같은 코드 경로)의 알림 이력으로 확인했다. 임시 피보호자는 푸시 토큰이 없어 실제 푸시는 나가지 않는다.',
    });
  });

  test('CHAT-N44 관리자 말벗 오늘 집계와 AI 상태 칸', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(240_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    const adminLogin = await loginSafe(await tempUser('ADMIN'));
    const guardian = await loginSafe(guardianUser);
    connect(guardianUser.id, wardUser.id);
    backdateConnection(guardianUser.id, wardUser.id, 10);
    // 3일 연속 걱정(WORRY): 오늘·어제·그제 대화를 직접 넣는다 (AI·알림을 거치지 않는다)
    for (const offset of [0, -1, -2]) {
      seedFinishedSession(wardUser.id, { date: kstDate(offset), slot: '09:00', mood: 'WORRY' });
    }

    // 보호자 화면이 보는 위험 계산 (attention)
    const guardianView = await callFull(guardian.api, 'GET', `/api/guardian/ward/${wardUser.id}/companion/today`, undefined, 30_000);
    expect(guardianView.status).toBe(200);
    expect(guardianView.json.data.attention, '보호자 화면: 3일 이어진 걱정').toEqual({ mood: 'WORRY', days: 3 });

    // 관리자 오늘 집계
    const startedAt = Date.now();
    const stats = await callFull(adminLogin.api, 'GET', '/api/admin/ai-stats/companion', undefined, 30_000);
    expect(stats.status, '관리자 말벗 집계').toBe(200);
    expect(Date.now() - startedAt, 'AI 를 부르지 않고 우리 DB 로 계산하므로 바로 온다').toBeLessThan(10_000);
    const data = stats.json.data;
    expect(Object.keys(data).sort(), '집계 칸').toEqual([
      'alertSentCount', 'askedCount', 'continuingWards', 'date', 'generatedAt', 'moodDistribution', 'noDialogueWardCount', 'noDialogueWards', 'responseRate',
    ]);
    expect(data.date, '집계 날짜(KST)').toBe(kstDate());
    expect(data.moodDistribution.wardCount, '오늘 마친 대화가 있는 어르신에 이 피보호자 포함').toBeGreaterThanOrEqual(1);
    expect(data.moodDistribution.worry, '오늘 기분 분포에 걱정 1명 이상').toBeGreaterThanOrEqual(1);
    const mine = (data.continuingWards as Array<{ wardId: string; mood: string; days: number }>).filter(w => w.wardId === wardUser.id);
    expect(mine, '걱정·우울이 이어지는 어르신 목록에서 이 피보호자(보호자 화면과 같은 값)').toEqual([
      expect.objectContaining({ wardId: wardUser.id, mood: guardianView.json.data.attention.mood, days: guardianView.json.data.attention.days }),
    ]);
    expect(data.noDialogueWards.map((w: { wardId: string }) => w.wardId), '오늘 대화한 이 피보호자는 "대화 없음"에 없다').not.toContain(wardUser.id);

    // AI 상태 카드의 companion 칸: API 값과 화면 글자가 맞는다
    const status = await callFull(adminLogin.api, 'GET', '/api/admin/dashboard/ai-status', undefined, 30_000);
    expect(status.status, 'AI 상태 API').toBe(200);
    expect(Object.keys(status.json.data), 'AI 상태 API 에 companion 칸').toContain('companion');
    const apiValue = status.json.data.companion?.status ?? null;
    const labels: Record<string, string> = { OK: '정상', DISABLED: '일시 중단' };
    const expectedLabel = apiValue === null ? '확인 불가' : labels[apiValue];
    expect(expectedLabel, `companion 상태값 ${apiValue} 의 화면 글자 규칙`).toBeTruthy();

    const page = await openAs(adminLogin.who, '/admin');
    await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
    const bar = page.getByRole('region', { name: 'AI 서비스 상태' });
    await expect(bar, 'AI 서비스 상태 영역').toBeVisible();
    await expect(bar.getByText('안부 말벗 · 기분 분석'), 'companion 칸').toBeVisible();
    // 로딩 중 문구('확인 중')가 지나가고 결과 글자가 보일 때까지
    await expect
      .poll(async () => {
        const lines = (await bar.innerText()).split('\n').map(l => l.trim()).filter(Boolean);
        const at = lines.indexOf('안부 말벗 · 기분 분석');
        return at >= 0 ? lines[at + 1] : null;
      }, { message: 'companion 칸의 상태 글자', timeout: 30_000 })
      .toBe(expectedLabel);
    await expect(page.getByText('AI 안부 말벗 · 정서 분석'), '말벗 집계 카드').toBeVisible();
  });
});
