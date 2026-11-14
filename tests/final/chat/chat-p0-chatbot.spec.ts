/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P0: AI 챗봇 중계 (보호자 /api/guardian/chat, 피보호자 /api/ward/chat)
 * 근거: BE 프로젝트_설명.txt 3-16 (2240-2298행), ChatRelayService, FE 배포본 a8666240 ChatBubble·ChatbotContent
 * 챗 전송은 Claude(AI) 를 실제로 부른다 - 케이스에 필요한 만큼만 보낸다.
 */
import { Api } from '../../../src/api';
import type { LoggedIn } from '../../../src/fixtures';
import { env } from '../../../src/env';
import { countBackendLog, remoteBash } from '../../../src/remote';
import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import {
  aiChatLogCount, aiPsql, call, callAnonymous, callLong, marker, rowsContaining, sleep, sshHostName, tcpProbe, withdrawForAiPurge,
} from './_helpers-chat';

const TAGS = { tag: ['@P0', '@CHAT'] };

type Role = 'guardian' | 'ward';

function chat(api: Api, role: Role, message: string, extra: Record<string, unknown> = {}) {
  return callLong(api, 'POST', `/api/${role}/chat`, { message, sessionId: marker('qa'), context: {}, ...extra });
}

async function logsOf(api: Api, role: Role) {
  const res = await call(api, 'GET', `/api/${role}/chat/logs`);
  expect(res.status, `GET /api/${role}/chat/logs`).toBe(200);
  return res.json.data as Array<Record<string, any>>;
}

// 챗을 보낸 임시 사용자는 AI 서버 DB 에도 상담 기록이 남는다. 끝날 때 제품 탈퇴 API 로 지워 AI 기록 삭제 경로를 타게 한다.
const chatted: LoggedIn[] = [];
function track(login: LoggedIn) {
  chatted.push(login);
  return login;
}

test.describe('CHAT P0 - AI 챗봇', () => {
  test.afterEach(async () => {
    const users = chatted.splice(0);
    for (const { user, api } of users) {
      try {
        const res = await withdrawForAiPurge(api, user.password);
        let left = aiChatLogCount(user.id);
        for (let i = 0; i < 6 && left > 0; i++) {
          await sleep(2_500);
          left = aiChatLogCount(user.id);
        }
        test.info().annotations.push({ type: '정리', description: `탈퇴 ${res.status}, AI 서버 챗 기록 남은 수 ${left}` });
        expect.soft(left, `탈퇴 뒤 AI 서버에 남은 ${user.id} 의 챗 기록`).toBe(0);
      } catch (error) {
        test.info().annotations.push({ type: '정리 실패', description: String(error).slice(0, 200) });
      }
    }
  });
  test('CHAT-N13 위험 증상이면 긴급 상자(119·109 경고)가 뜬다', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN');
    const { who, api } = track(await loginAs(guardian));

    const page = await openAs(who, '/guardian/chatbot');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 의료 챗봇' })).toBeVisible();
    await page.getByLabel('궁금한 점 입력').fill('숨이 안 쉬어져요');
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/guardian/chat') && r.request().method() === 'POST', { timeout: 150_000 }),
      page.getByRole('button', { name: '보내기' }).click(),
    ]);
    expect(response.status(), 'POST /api/guardian/chat').toBe(200);
    const data = (await response.json()).data;
    expect(data.riskLevel, '위험도').toBe('high');
    expect(data.recommendedAction, 'recommendedAction').toBeTruthy();
    expect(Array.isArray(data.emergencyWarning) && data.emergencyWarning.length > 0, 'emergencyWarning 이 있다').toBe(true);

    // 화면: 말풍선 맨 위 빨간 긴급 상자 (role=alert, "긴급" 라벨 + 119 안내)
    const box = page.getByRole('alert').filter({ hasText: '긴급' });
    await expect(box).toBeVisible();
    await expect(box).toContainText('119');

    // 기록 목록에도 emergencyWarning 이 있다
    const logs = await logsOf(api, 'guardian');
    expect(logs.length).toBe(1);
    expect(logs[0].emergencyWarning.length).toBeGreaterThan(0);
    expect(logs[0].emergencyWarning.join(' ')).toContain('119');

    // 109(자살 예방) 안내 경로: 정신 위기 입력으로 한 번 더 보내 긴급 안내에 109 가 나오는지 본다
    const crisis = await chat(api, 'guardian', '더 이상 살고 싶지 않고 스스로 목숨을 끊고 싶다는 생각이 들어요');
    expect(crisis.status).toBe(200);
    const crisisWarning = JSON.stringify(crisis.json.data.emergencyWarning ?? []);
    test.info().annotations.push({ type: '실측', description: `정신 위기 입력 emergencyWarning: ${crisisWarning.slice(0, 200)}` });
    expect(crisisWarning, '정신 위기 입력에는 109(자살 예방 상담) 안내가 있다').toContain('109');
  });

  test('CHAT-N19 챗 기록이 실제 회원 ID 로 저장·조회된다', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const a = track(await loginAs(await tempUser('GUARDIAN')));
    const b = track(await loginAs(await tempUser('WARD')));
    const markA = marker('QAN19A');
    const markB = marker('QAN19B');

    // 새 계정이라 처음엔 기록이 없다 (옛 userId=1 고정 기록이 섞여 보이지 않는다)
    expect(await logsOf(a.api, 'guardian')).toEqual([]);
    expect(await logsOf(b.api, 'ward')).toEqual([]);

    expect((await chat(a.api, 'guardian', `${markA} 혈압약은 식후에 먹어도 되나요`)).status).toBe(200);
    expect((await chat(b.api, 'ward', `${markB} 어제부터 머리가 아파요`)).status).toBe(200);

    const logsA = await logsOf(a.api, 'guardian');
    const logsB = await logsOf(b.api, 'ward');
    expect(logsA.map(l => l.message)).toEqual([expect.stringContaining(markA)]);
    expect(logsB.map(l => l.message)).toEqual([expect.stringContaining(markB)]);
    expect(JSON.stringify(logsA)).not.toContain(markB);
    expect(JSON.stringify(logsB)).not.toContain(markA);
    // 응답 칸은 허용 목록뿐: AI 내부 칸(userId·contextJson·decisionTrace)이 내려오지 않는다
    for (const key of ['userId', 'contextJson', 'decisionTrace']) {
      expect(logsA[0], `기록 응답에 ${key} 없음`).not.toHaveProperty(key);
    }
  });

  test('CHAT-N26 챗 내용이 로그·알림 이력·감사 로그에 남지 않는다', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN');
    const { api } = track(await loginAs(guardian));
    const m = marker('QAN26');

    const res = await chat(api, 'guardian', `${m} 요즘 밤에 잠이 안 와요`);
    expect(res.status).toBe(200);
    const replyWords = String(res.json.data.reply ?? '').match(/[가-힣]+( [가-힣]+){2}/g) ?? [];
    const replyNeedle = replyWords.find(w => w.length >= 8);

    // 본문 검증 실패(400) 경로에서도 내용이 로그에 남지 않는다
    const tooLong = await chat(api, 'guardian', `${m}X${'가'.repeat(2_100)}`);
    expect(tooLong.status).toBe(400);
    expect(tooLong.json?.code).toBe('CHAT_INVALID_REQUEST');
    await sleep(2_000);

    expect(countBackendLog(m, 300), 'BE 서버 로그에 메시지 표식이 없다').toBe(0);
    if (replyNeedle) expect(countBackendLog(replyNeedle, 300), 'BE 서버 로그에 AI 답변 문장이 없다').toBe(0);
    else test.info().annotations.push({ type: '확인 못 한 부분', description: 'AI 답변에서 찾을 문장을 만들지 못해 답변 문장 검사는 건너뜀' });
    // 상담 본문을 직접 받는 AI 서버 컨테이너 로그에도 메시지 표식이 없어야 한다 (읽기만)
    const aiLogHits = Number(remoteBash(`docker logs --since 300s silverbridge-ai-server 2>&1 | grep -cF '${m}' || true\n`).trim()) || 0;
    expect(aiLogHits, 'AI 서버 로그에 메시지 표식이 없다').toBe(0);
    expect(rowsContaining('notification_log', m, guardian.id), '알림 이력').toBe(0);
    expect(rowsContaining('admin_audit_log', m, guardian.id), '관리자 감사 로그').toBe(0);
    expect(rowsContaining('access_log', m, guardian.id), '접근 로그').toBe(0);
    test.info().annotations.push({
      type: '확인 못 한 부분',
      description: 'AI 서버 오류를 일부러 일으킬 수 없어 "AI 오류 문구가 남지 않는다" 는 BE 단위 테스트(ChatRelayLogGuardTest)로 본다. 화면 쪽 감사 로그 화면은 DB 조회로 대신했다.',
    });
  });

  test('CHAT-A07 로그인 없이 챗 전송·기록 조회', TAGS, async () => {
    for (const role of ['guardian', 'ward'] as const) {
      const send = await callAnonymous('POST', `/api/${role}/chat`, { message: '안녕하세요' });
      expect(send.status, `POST /api/${role}/chat`).toBe(401);
      const list = await callAnonymous('GET', `/api/${role}/chat/logs`);
      expect(list.status, `GET /api/${role}/chat/logs`).toBe(401);
      const detail = await callAnonymous('GET', `/api/${role}/chat/logs/1`);
      expect(detail.status, `GET /api/${role}/chat/logs/1`).toBe(401);
      for (const res of [send, list, detail]) expect(res.text).not.toContain('reply');
    }
  });

  test('CHAT-A08 역할 다른 경로 호출 / 관리자', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await loginAs(await tempUser('GUARDIAN'));
    const ward = await loginAs(await tempUser('WARD'));
    const admin = await loginAs(await tempUser('ADMIN'));

    const cases: Array<[string, Api, Role]> = [
      ['피보호자 - 보호자 경로', ward.api, 'guardian'],
      ['보호자 - 피보호자 경로', guardian.api, 'ward'],
      ['관리자 - 보호자 경로', admin.api, 'guardian'],
      ['관리자 - 피보호자 경로', admin.api, 'ward'],
    ];
    for (const [label, api, role] of cases) {
      const send = await call(api, 'POST', `/api/${role}/chat`, { message: '안녕하세요' });
      expect(send.status, `${label} 전송`).toBe(403);
      const list = await call(api, 'GET', `/api/${role}/chat/logs`);
      expect(list.status, `${label} 목록`).toBe(403);
      const detail = await call(api, 'GET', `/api/${role}/chat/logs/1`);
      expect(detail.status, `${label} 상세`).toBe(403);
    }
    // 관리자용 챗 경로는 없다 (200 이 아니다)
    for (const path of ['/api/admin/chat', '/api/admin/chat/logs']) {
      const res = await call(admin.api, 'GET', path);
      expect([403, 404], `GET ${path} (${res.status})`).toContain(res.status);
    }
  });

  test('CHAT-A13 연결 안 된 wardId 로 대리 상담 (IDOR)', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const stranger = await tempUser('WARD'); // 연결 없음
    const { api } = await loginAs(guardian);

    const startedAt = Date.now();
    const res = await chat(api, 'guardian', '대신 병원 예약을 알아봐 주세요', { context: { wardId: stranger.id } });
    expect(res.status).toBe(403);
    expect(res.json?.code).toBe('CHAT_WARD_NOT_CONNECTED');
    expect(Date.now() - startedAt, 'AI 를 부르지 않으므로 바로 거절된다').toBeLessThan(10_000);

    // AI 호출이 없었으므로 상담 기록도 없다
    expect(await logsOf(api, 'guardian')).toEqual([]);
    let logged = false;
    for (let i = 0; i < 4 && !logged; i++) {
      logged = countBackendLog(`[IDOR-ATTEMPT] 연결되지 않은 피보호자 대리 상담 시도: guardianId=${guardian.id}`) > 0;
      if (!logged) await sleep(1_500);
    }
    expect(logged, '[IDOR-ATTEMPT] 로그').toBe(true);
  });

  test('CHAT-A16 클라이언트가 보낸 userId·wardName·wardPhone 무시', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const victim = track(await loginAs(await tempUser('WARD')));
    const guardian = track(await loginAs(await tempUser('GUARDIAN')));
    const ward = track(await loginAs(await tempUser('WARD')));
    const mG = marker('QAA16G');
    const mW = marker('QAA16W');
    const forged = { userId: victim.user.id, wardName: '위조이름', wardPhone: '01000010099' };

    // 보호자 경로: 본문·context 의 userId 는 토큰 값으로 덮인다
    const g = await chat(guardian.api, 'guardian', `${mG} 소화가 잘 안 돼요`, { userId: victim.user.id, context: forged });
    expect(g.status).toBe(200);
    // 피보호자 경로: userId 와 대리 상담 키 세 개가 모두 무시된다 (403 이나 400 이 아니라 평소처럼 처리)
    const w = await chat(ward.api, 'ward', `${mW} 무릎이 쑤셔요`, { userId: victim.user.id, context: { ...forged, wardId: victim.user.id } });
    expect(w.status).toBe(200);

    const gLogs = await logsOf(guardian.api, 'guardian');
    expect(gLogs.map(l => l.message)).toEqual([expect.stringContaining(mG)]);
    expect(gLogs[0].wardId, '위조 wardName/wardPhone 이 있어도 대리 상담으로 저장되지 않는다').toBeNull();
    const wLogs = await logsOf(ward.api, 'ward');
    expect(wLogs.map(l => l.message)).toEqual([expect.stringContaining(mW)]);
    expect(wLogs[0].wardId, '피보호자 경로의 위조 wardId 는 지워진다').toBeNull();
    // 위조한 userId 쪽(피해자)에는 아무 기록도 생기지 않는다
    expect(await logsOf(victim.api, 'ward')).toEqual([]);

    // AI 서버 DB 에 저장된 이 임시 사용자들의 기록(context)에 위조 값이 없다 (SELECT 만)
    expect(aiChatLogCount(guardian.user.id), 'AI 서버에 보호자 기록 1건').toBe(1);
    expect(aiChatLogCount(ward.user.id), 'AI 서버에 피보호자 기록 1건').toBe(1);
    expect(aiChatLogCount(victim.user.id), 'AI 서버에 피해자 기록 없음').toBe(0);
    for (const who of [guardian.user.id, ward.user.id]) {
      const ctx = aiPsql(`SELECT coalesce(context_json::text,'') FROM chat_logs WHERE user_id = '${who}' LIMIT 1;`);
      expect(ctx, `${who} 기록 context 에 위조 이름 없음`).not.toContain('위조이름');
      expect(ctx, `${who} 기록 context 에 위조 번호 없음`).not.toContain(forged.wardPhone);
      expect(ctx, `${who} 기록 context 에 위조 userId 없음`).not.toContain(victim.user.id);
    }
    test.info().annotations.push({
      type: '확인 범위',
      description: 'AI 서버 DB 의 기록 context 에 위조 값이 없는지는 SELECT 로 확인했다. AI 로 가는 본문 구성 자체는 BE 단위 테스트에서 본다.',
    });
  });

  test('CHAT-A17 남의 기록 상세 조회는 없는 기록과 같은 404', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const owner = track(await loginAs(await tempUser('WARD')));
    const attackerWard = await loginAs(await tempUser('WARD'));
    const attackerGuardian = await loginAs(await tempUser('GUARDIAN'));
    const m = marker('QAA17');

    const sent = await chat(owner.api, 'ward', `${m} 손이 자꾸 떨려요`);
    expect(sent.status).toBe(200);
    const chatId = sent.json.data.chatLogId as number;
    expect(chatId).toBeTruthy();

    // 기준: 본인은 읽을 수 있다
    const own = await call(owner.api, 'GET', `/api/ward/chat/logs/${chatId}`);
    expect(own.status).toBe(200);
    expect(own.text).toContain(m);

    const missing = await call(attackerWard.api, 'GET', '/api/ward/chat/logs/987654321');
    const otherWard = await call(attackerWard.api, 'GET', `/api/ward/chat/logs/${chatId}`);
    const otherGuardian = await call(attackerGuardian.api, 'GET', `/api/guardian/chat/logs/${chatId}`);
    for (const [label, res] of [['없는 기록', missing], ['남의 기록(피보호자)', otherWard], ['남의 기록(보호자)', otherGuardian]] as const) {
      expect(res.status, label).toBe(404);
      expect(res.json?.code, label).toBe('CHAT_LOG_NOT_FOUND');
      expect(res.text, `${label} 본문에 내용 없음`).not.toContain(m);
    }
    // 둘은 구분되지 않는다 (상태·코드·문구 동일)
    expect(otherWard.json).toEqual(missing.json);
    expect(otherGuardian.json).toEqual(missing.json);
  });

  test('CHAT-A18 보호자·관리자가 피보호자의 상담 내용을 볼 수 없다', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const wardUser = await tempUser('WARD');
    const guardianUser = await tempUser('GUARDIAN');
    connect(guardianUser.id, wardUser.id); // 연결된 보호자라도 볼 수 없다
    const ward = track(await loginAs(wardUser));
    const guardian = await loginAs(guardianUser);
    const admin = await loginAs(await tempUser('ADMIN'));
    const m = marker('QAA18');

    const sent = await chat(ward.api, 'ward', `${m} 요즘 우울한 기분이 들어요`);
    expect(sent.status).toBe(200);
    const chatId = sent.json.data.chatLogId as number;

    const attempts: Array<[string, Api, string]> = [
      ['보호자 - 피보호자 기록 목록', guardian.api, '/api/ward/chat/logs'],
      ['보호자 - 피보호자 기록 상세', guardian.api, `/api/ward/chat/logs/${chatId}`],
      ['보호자 - 보호자 경로 상세(피보호자 chatId)', guardian.api, `/api/guardian/chat/logs/${chatId}`],
      ['관리자 - 피보호자 기록 목록', admin.api, '/api/ward/chat/logs'],
      ['관리자 - 피보호자 기록 상세', admin.api, `/api/ward/chat/logs/${chatId}`],
      ['관리자 - 보호자 경로 상세', admin.api, `/api/guardian/chat/logs/${chatId}`],
    ];
    for (const [label, api, path] of attempts) {
      const res = await call(api, 'GET', path);
      expect([403, 404], `${label} (${res.status})`).toContain(res.status);
      expect(res.text, `${label} 본문에 상담 내용 없음`).not.toContain(m);
    }
    // 보호자 자신의 기록 목록에도 피보호자의 글은 섞이지 않는다
    expect(JSON.stringify(await logsOf(guardian.api, 'guardian'))).not.toContain(m);

    // 화면: 보호자 챗봇 화면 어디에도 피보호자의 상담 글이 없다
    const page = await openAs(guardian.who, null);
    await page.goto('/guardian/chatbot');
    await expect(page.getByRole('heading', { level: 1, name: 'AI 의료 챗봇' })).toBeVisible();
    // 기록 목록 UI 가 있는지 확인한다. 있으면 반드시 열어 보고, 없으면 "없다" 를 단언한다
    const history = page.getByRole('button', { name: /기록|이전 대화|대화 목록/ });
    const historyCount = await history.count();
    test.info().annotations.push({ type: '실측', description: `챗봇 화면의 기록 열기 버튼 ${historyCount}개` });
    if (historyCount > 0) {
      await history.first().click();
      await page.waitForLoadState('networkidle').catch(() => undefined);
    } else {
      expect(await page.getByText(/지난 상담|이전 상담|상담 기록/).count(), '기록 UI 가 없으면 기록 글도 화면에 없다').toBe(0);
    }    expect(await page.locator('body').innerText()).not.toContain(m);
  });

  test('CHAT-A24 예약 서비스 포트 6015 는 외부에서 못 붙는다', TAGS, async () => {
    // 서버 밖(이 테스트가 도는 곳)에서 서버 주소의 6015 로 접속을 시도한다
    const host = sshHostName();
    for (const target of new Set([host, new URL(env.apiUrl).hostname])) {
      const result = await tcpProbe(target, 6015);
      expect(result, `${target}:6015 접속 결과`).not.toBe('connected');
    }
    // 서버 안에서 본 포트 바인딩: 127.0.0.1 에만 열려 있다 (읽기만 한다)
    const binding = remoteBash('docker port silverbridgereservation-reservation-api-1 2>&1 || true\n');
    expect(binding, '6015 바인딩').toContain('6015');
    expect(binding, '0.0.0.0 으로 열려 있지 않다').not.toMatch(/0\.0\.0\.0:6015|\[::\]:6015/);
    expect(binding).toMatch(/127\.0\.0\.1:6015/);
    test.info().annotations.push({
      type: '확인 범위',
      description: 'FE 가 sb-internal 네트워크의 reservation-api:6015 로만 붙는 것은 FE 배포본 docker-compose.dev.yml(RESERVATION_API_URL=http://reservation-api:6015)로 확인했다. 컨테이너 환경값은 읽지 않았다.',
    });
  });
});
