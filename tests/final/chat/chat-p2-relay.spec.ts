/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P2: AI 챗봇 중계 (보호자 /api/guardian/chat, 피보호자 /api/ward/chat)
 * 근거: BE ChatRelayService.sanitizedContext·buildBody·validate, ChatRelayRequest(@Size·@Pattern), AI 서버 chat_logs.context_json(userContext)
 * 챗 전송은 Claude(AI) 를 실제로 부른다 - 케이스에 필요한 만큼만 보낸다(짧은 인사말). 상담 내용·토큰·전화번호는 메시지·annotation 에 넣지 않는다.
 */
import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { aiChatLogCount } from './_helpers-chat';
import {
  ABSENT, aiContextField, callFull, chatSend, cleanupChat, kstDate, loginSafe, track, TAGS,
} from './_helpers-chat-p2';

const HELLO = '안녕하세요';

/** BE ChatRelayService.isSearchableAddress 와 같은 규칙 */
function isSearchableAddress(address: string): boolean {
  const tokens = address.trim().split(/\s+/);
  if (/^세종(특별자치시|시)?$/.test(tokens[0])) return true;
  const sido = /^(서울|부산|대구|인천|광주|대전|울산|경기|강원|충북|충남|충청북도|충청남도|전북|전남|전라북도|전라남도|경북|경남|경상북도|경상남도|제주)(특별시|광역시|특별자치도|도)?$/;
  return tokens.length >= 2 && sido.test(tokens[0]) && /^\S+[시군구]$/.test(tokens[1]);
}

/** BE 가 AI 로 보내는 context 의 최종 JSON 바이트 수를 같은 규칙으로 계산한다 (피보호자 경로: guardianWards 칸 없음, 본인 프로필 포함) */
function finalContextBytes(pad: string, user: { name: string; phone: string; gender: string; birthDate: string; address: string }): number {
  const [by, bm, bd] = user.birthDate.split('-').map(Number);
  const [ty, tm, td] = kstDate().split('-').map(Number);
  const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
  const context: Record<string, unknown> = { pad, role: 'WARD' };
  if (user.name) context.name = user.name;
  if (user.phone) context.phone = user.phone;
  context.birthDate = user.birthDate;
  context.age = age;
  context.gender = user.gender;
  if (isSearchableAddress(user.address)) context.address = user.address.trim();
  return Buffer.byteLength(JSON.stringify(context), 'utf8');
}

function ownProfile(userId: string) {
  const out = psql(`SELECT name, coalesce(phone,''), gender, birth_date::text, coalesce(address,'') FROM users WHERE id = ${sqlStr(userId)};`);
  const [name, phone, gender, birthDate, address] = out.split('|');
  return { name, phone, gender, birthDate, address };
}

test.describe('CHAT P2 - AI 챗봇 중계', () => {
  test.afterEach(async () => {
    await cleanupChat(test.info());
  });

  test('CHAT-N17 context.role 은 경로의 역할로 덮어쓴다', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    const g = track(await loginSafe(await tempUser('GUARDIAN')));
    const w = track(await loginSafe(await tempUser('WARD')));
    // 보호자 경로에 WARD, 피보호자 경로에 GUARDIAN 을 넣어 보낸다
    const asGuardian = await chatSend(g.api, 'guardian', HELLO, { context: { role: 'WARD' } });
    expect(asGuardian.status, '보호자 경로 전송').toBe(200);
    const asWard = await chatSend(w.api, 'ward', HELLO, { context: { role: 'GUARDIAN' } });
    expect(asWard.status, '피보호자 경로 전송').toBe(200);

    // AI 서버가 저장한 userContext.role 이 경로의 역할이다 (관리자 AI 통계의 역할별 상담 수가 이 값으로 센다)
    await expect.poll(() => aiContextField(g.user.id, 'role'), { message: '보호자 경로의 AI 기록 role', timeout: 30_000 }).toEqual(['GUARDIAN']);
    await expect.poll(() => aiContextField(w.user.id, 'role'), { message: '피보호자 경로의 AI 기록 role', timeout: 30_000 }).toEqual(['WARD']);
    test.info().annotations.push({
      type: '부분 확인',
      description: '"관리자 AI 통계 역할별 상담 수가 이 값으로 센다"는 직접 확인하지 않았다(통과와 따로 센다). AI 서버 DB(chat_logs.context_json)에 저장된 role 을 이 임시 사용자 id 로만 조회해 확인했다. 관리자 AI 통계(byRole)는 전체 집계라 다른 사용자 상담이 섞여 증가분을 정확히 셀 수 없다. 코드 근거: AI 서버 9cf51d6 app/services/chat_stats_service.py 117-120행에서 context.userContext.role 을 소문자로 바꿔 by_role 에 센다(98행에서 칸을 만들고 145행에서 byRole 로 내보낸다).',
    });
  });

  test('CHAT-N21 wardId 공백이면 본인 상담으로 처리', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    const g = track(await loginSafe(await tempUser('GUARDIAN')));
    const res = await chatSend(g.api, 'guardian', HELLO, { context: { wardId: '   ' } });
    expect(res.status, '공백 wardId 로 전송 (403 이 아니다)').toBe(200);
    // 본인 상담: AI 기록에 wardId 가 없고 본인 프로필(이름)이 들어간다
    await expect.poll(() => aiContextField(g.user.id, 'role'), { message: 'AI 기록 role', timeout: 30_000 }).toEqual(['GUARDIAN']);
    expect(aiContextField(g.user.id, 'wardId'), 'AI 기록에 wardId 없음').toEqual([ABSENT]);
    expect(aiContextField(g.user.id, 'name'), '본인 프로필의 이름').toEqual([g.user.name]);
    const logs = await callFull(g.api, 'GET', '/api/guardian/chat/logs', undefined, 30_000);
    expect(logs.status).toBe(200);
    expect(logs.json.data, '상담 기록 1건').toHaveLength(1);
    expect(logs.json.data[0].wardId ?? null, '기록에 피보호자 id 없음(본인 상담)').toBeNull();
  });

  test('CHAT-A11 history 개수·길이·role 위반', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    const g = track(await loginSafe(await tempUser('GUARDIAN')));
    const w = track(await loginSafe(await tempUser('WARD')));
    const item = (role: string, content: string) => ({ role, content });
    const alternating = (n: number) => Array.from({ length: n }, (_, i) => item(i % 2 === 0 ? 'user' : 'assistant', '네'));

    const bad: Array<[string, unknown[]]> = [
      ['history 25개', alternating(25)],
      ['항목 4001자', [item('user', '가'.repeat(4001))]],
      ['role=system', [item('system', '네')]],
      ['role 빈 값', [item('', '네')]],
      ['content 없음', [{ role: 'user' }]],
    ];
    for (const [role, login] of [['guardian', g], ['ward', w]] as const) {
      for (const [label, history] of bad) {
        const res = await chatSend(login.api, role, HELLO, { history });
        // 서비스에 닿기 전에 요청 검증(@Size·@Pattern·@NotNull)에서 거절된다 -> 공통 처리기의 INVALID_INPUT
        expect(res.status, `${role} ${label}`).toBe(400);
        expect(res.json?.code, `${role} ${label} code`).toBe('INVALID_INPUT');
        expect(res.ms, `${role} ${label}: AI 를 부르지 않으므로 바로 거절된다`).toBeLessThan(10_000);
      }
      expect(aiChatLogCount(login.user.id), `${role}: 거절된 요청은 AI 에 닿지 않았다`).toBe(0);
    }

    // 경계: 24개, 항목 4000자(마지막 항목)는 통과한다
    const history = [...alternating(23), item('user', '가'.repeat(4000))];
    expect(history).toHaveLength(24);
    const ok = await chatSend(g.api, 'guardian', HELLO, { history });
    expect(ok.status, '24개·4000자는 통과').toBe(200);
    test.info().annotations.push({
      type: '문서 고칠 곳',
      description: 'BE 프로젝트_설명.txt 2255·2258행. 문서는 "400 CHAT_INVALID_REQUEST"라고 적었다. 코드는 history 개수(@Size 24)·항목 길이(@Size 4000)·role(@Pattern user|assistant) 위반을 요청 검증에서 먼저 잡아 400 INVALID_INPUT 으로 답한다(CHAT_INVALID_REQUEST 는 메시지 없음·메시지 2000자 초과·최종 context 8KB 초과에만 쓴다). 코드 값으로 고정했다.',
    });
    test.info().annotations.push({
      type: '확인 범위',
      description: 'BE 는 history 를 검증만 하고 AI 로 보내지 않는다(buildBody 에 history 칸이 없다). 그래서 24개 통과는 "200 으로 받아들인다"까지만 확인한다.',
    });
  });

  test('CHAT-A12 context 키 21개 또는 8KB 초과', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    const g = track(await loginSafe(await tempUser('GUARDIAN')));
    const w = track(await loginSafe(await tempUser('WARD')));

    // 키 21개: 요청 검증(@Size 20) 단계에서 거절
    const keys21 = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    const tooMany = await chatSend(g.api, 'guardian', HELLO, { context: keys21 });
    expect(tooMany.status, '키 21개').toBe(400);
    expect(tooMany.json?.code, '키 21개 code').toBe('INVALID_INPUT');

    // 값이 아주 커서 8KB 를 넘음: 서비스가 최종 크기로 거절
    const huge = await chatSend(g.api, 'guardian', HELLO, { context: { pad: 'a'.repeat(9 * 1024) } });
    expect(huge.status, 'context 9KB').toBe(400);
    expect(huge.json?.code, 'context 9KB code').toBe('CHAT_INVALID_REQUEST');

    // 최종 크기 경계: BE 가 채운 값(role·본인 프로필)을 더한 크기가 정확히 8192 바이트면 통과, 8193 이면 거절.
    // 보낸 값(pad)만 보면 둘 다 8KB 아래다 - "최종 크기 기준"인지 보는 것
    const profile = ownProfile(w.user.id);
    const base = finalContextBytes('', profile);
    const padFor = (finalBytes: number) => 'a'.repeat(finalBytes - base);
    expect(base, '준비: 채운 값만으로도 8KB 보다 작다').toBeLessThan(8192);
    expect(padFor(8192).length, '준비: 보낸 pad 는 8192 보다 작다(채운 값이 더해져 경계를 넘는다)').toBeLessThan(8192);

    const over = await chatSend(w.api, 'ward', HELLO, { context: { pad: padFor(8193) } });
    expect(over.status, '최종 8193 바이트').toBe(400);
    expect(over.json?.code, '최종 8193 바이트 code').toBe('CHAT_INVALID_REQUEST');
    expect(aiChatLogCount(w.user.id), '거절된 요청은 AI 에 닿지 않았다').toBe(0);

    const edge = await chatSend(w.api, 'ward', HELLO, { context: { pad: padFor(8192) } });
    expect(edge.status, '최종 8192 바이트는 통과 (계산이 맞아야 한다)').toBe(200);
    test.info().annotations.push({
      type: '문서 고칠 곳',
      description: 'BE 프로젝트_설명.txt 2265행. 문서는 키 21개를 "400 CHAT_INVALID_REQUEST"라고 적었다. 코드는 키 개수(@Size 20)를 요청 검증에서 먼저 잡아 400 INVALID_INPUT 으로 답하고, CHAT_INVALID_REQUEST 는 BE 가 값을 채운 뒤의 최종 크기가 8KB 를 넘을 때만 쓴다. 코드 값으로 고정했다.',
    });
  });
});
