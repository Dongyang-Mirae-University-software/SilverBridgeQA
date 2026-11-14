/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P2: 화면 (대시보드 SOS 달 경계 / 음성 받아쓰기 / 병원 예약 날짜 / 접근성 / FE 운영 방식)
 * 근거: BE GuardianDashboardService.monthStart, FE 배포본 a8666240(useVoiceInput·HospitalDateTimeStep·useKstNow·Sidebar·layout.tsx), 배포 서버 컨테이너 상태(읽기만)
 * 임시 사용자만 쓴다. 서버 설정·컨테이너는 바꾸지 않는다(docker inspect·top 읽기만).
 */
import AxeBuilder from '@axe-core/playwright';

import { contextDefaults } from '../../../src/browser';
import { expect, expectPageTitle, test } from '../../../src/fixtures';
import { psql, remoteBash, sqlStr } from '../../../src/remote';
import { tokenCookies } from '../../../src/session';
import { connect } from '../../../src/variables';
import {
  callFull, cleanupChat, dashboardPath, focusInside, kstDate, loginSafe, marker, TAGS, track,
} from './_helpers-chat-p2';

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** "11월 14일 (토)" - FE formatDateShort 와 같은 글자 */
function dateShort(iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${m}월 ${d}일 (${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

function addIsoDays(iso: string, days: number) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

test.describe('CHAT P2 - 화면', () => {
  test.afterEach(async () => {
    await cleanupChat(test.info());
  });

  test('CHAT-N06 이번 달 SOS 건수 달 경계 (KST 1일 00:00)', TAGS, async ({ tempUser }) => {
    test.setTimeout(180_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    // 연결 시각을 60일 앞으로 당겨, 지난달 말 SOS 가 "연결 이전 상황"으로 숨겨지지 않게 한다
    psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
          VALUES (${sqlStr(guardianUser.id)}, ${sqlStr(wardUser.id)}, 'ACTIVE', ${sqlStr(guardianUser.id)}, now() - interval '60 days', '기타');`);
    // KST 이번 달 1일 00:00:00 을 기준으로: 1분 전(전월 말일 23:59), 1밀리초 전, 정각
    const monthStart = `(date_trunc('month', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
    const insert = (offset: string) =>
      psql(`INSERT INTO sos_event (ward_id, trigger_type, created_at)
            VALUES (${sqlStr(wardUser.id)}, 'SOS_BUTTON', ${monthStart} ${offset}) RETURNING (extract(epoch from created_at) * 1000)::bigint;`)
        .split('\n')[0];
    insert("- interval '1 minute'");
    insert("- interval '1 millisecond'");
    const startMs = Number(insert(''));
    const monthStartKst = Number(psql(`SELECT (extract(epoch from ${monthStart}) * 1000)::bigint;`));
    expect(startMs, '준비: 정각 행의 시각이 KST 1일 00:00:00').toBe(monthStartKst);

    const guardian = track(await loginSafe(guardianUser));
    const res = await callFull(guardian.api, 'GET', dashboardPath(), undefined, 30_000);
    expect(res.status).toBe(200);
    expect(res.json.data.unavailable, '조회 실패 칸 없음').toEqual([]);
    expect(res.json.data.sos.thisMonthCount, '이번 달 건수: 정각 1건만 (전월 말일 23:59 두 건은 제외)').toBe(1);
    expect(Date.parse(res.json.data.sos.latest.triggeredAt), '가장 최근 1건은 정각 행').toBe(monthStartKst);
  });

  test('CHAT-N14 음성 받아쓰기로 질문 입력', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(300_000);
    const guardian = track(await loginSafe(await tempUser('GUARDIAN')));
    const spoken = `${marker('qa받아쓰기')} 안녕하세요`;
    const origin = new URL(process.env.E2E_BASE_URL ?? 'https://devdmu.gosky.kr').origin;

    // 1) 받아쓴 글이 입력칸에 들어가고, 전송하면 정상 응답. 가짜 마이크로 실제 녹음을 하고, 받아쓰기 서버 응답만 정해 둔 글로 바꾼다
    const page = await openAs(guardian.who, null);
    let sttCalls = 0;
    await page.route('**/api/guardian/chat/stt', route => {
      sttCalls++;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' },
        body: JSON.stringify({ success: true, data: { text: spoken } }),
      });
    });
    await page.goto('/guardian/chatbot');
    await expectPageTitle(page, 'AI 의료 챗봇');
    await page.getByRole('button', { name: '말로 입력하기' }).click();
    const stop = page.getByRole('button', { name: '녹음 끝내기' });
    await expect(stop, '녹음 중').toBeVisible();
    await expect(page.getByText('말씀하세요. 다 하셨으면 다시 눌러 주세요.'), '녹음 안내').toBeVisible();
    // 둥근 버튼에는 경과 시간이 안 보인다. 너무 짧은(0.3초 미만) 녹음은 서버로 보내지 않으므로 1.5초 녹음될 때까지 기다린다
    const recordingSince = Date.now();
    await expect.poll(() => Date.now() - recordingSince, { message: '녹음 경과', intervals: [250], timeout: 10_000 }).toBeGreaterThan(1_500);
    await stop.click();
    const input = page.getByLabel('궁금한 점 입력');
    await expect(input, '받아쓴 글이 입력칸에 들어간다').toHaveValue(spoken);
    expect(sttCalls, '받아쓰기 호출 1번').toBe(1);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/guardian/chat') && r.request().method() === 'POST', { timeout: 150_000 }),
      page.getByRole('button', { name: '보내기' }).click(),
    ]);
    expect(response.status(), '받아쓴 글을 전송하면 정상 응답').toBe(200);
    expect((response.request().postDataJSON() as { message: string }).message, '전송한 질문').toBe(spoken);
    await expect(page.getByText(spoken).first(), '내 말풍선').toBeVisible();

    // 2) 마이크 권한을 거부하면 안내가 보이고 받아쓰기 서버는 부르지 않는다
    const denied = await openAs(guardian.who, null);
    let deniedSttCalls = 0;
    denied.on('request', request => {
      if (request.url().endsWith('/api/guardian/chat/stt')) deniedSttCalls++;
    });
    await denied.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('거부됨', 'NotAllowedError'));
    });
    await denied.goto('/guardian/chatbot');
    await expectPageTitle(denied, 'AI 의료 챗봇');
    await denied.getByRole('button', { name: '말로 입력하기' }).click();
    await expect(denied.getByText('마이크 권한을 허용해 주세요.'), '권한 거부 안내').toBeVisible();
    await expect(denied.getByRole('button', { name: '말로 입력하기' }), '다시 누를 수 있는 상태').toBeVisible();
    expect(deniedSttCalls, '권한 거부 때는 받아쓰기 서버를 부르지 않는다').toBe(0);
    test.info().annotations.push({
      type: '확인 범위',
      description: '부분 확인. 받아쓰기 서버(음성 -> 글)의 실제 인식은 가짜 마이크의 소리로는 정해진 글이 나오지 않아 서버 응답만 정해 둔 글로 바꿨다(브라우저가 서버로 올리는 호출은 실제 녹음). 글 전송과 응답은 실제 서버다. 문서에 권한 거부 안내의 구체 문구가 없어 FE 배포본(STT_MESSAGES.permission)의 문구로 고정했다.',
    });
  });

  test('CHAT-N25 예약 날짜가 한국 시간의 오늘로 보정된다', TAGS, async ({ tempUser, browser }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginSafe(guardianUser);
    // 시계를 실제 오늘과 겹치지 않는 하루 뒤 날짜로 둔다. 로그인은 쿠키 토큰으로 하고, 예약 서비스는 아래에서 가짜 응답으로 대체하므로 시계를 옮겨도 이 케이스에는 영향이 없다
    const base = addIsoDays(new Date().toISOString().slice(0, 10), 1);

    const hospital = {
      id: 1, name: 'E2E점검병원', region: '서울', address: '서울 테스트로 1', phone: '02-000-0000', departments: ['내과'],
      operationStatus: 'OPEN', congestionLevel: 'LOW', bookingAvailable: true, description: '', openTime: '00:00', closeTime: '23:59',
    };
    const json = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

    async function openBooking(timezoneId: string, instant: string) {
      const context = await browser.newContext({
        ...contextDefaults, timezoneId, storageState: { cookies: tokenCookies(guardian.login), origins: [] },
      });
      const page = await context.newPage();
      // 예약 서비스는 가짜로 대체한다 (예약 생성은 아예 끊는다) - 이 케이스는 화면의 날짜 계산만 본다
      await page.route(/\/api\/reservation\/hospitals(\?.*)?$/, route => route.fulfill(json([hospital])));
      await page.route(/\/api\/reservation\/hospitals\/1\/available-slots/, route =>
        route.fulfill(json({ hospitalId: 1, date: '', availableSlots: ['00:30', '10:00', '11:00', '23:30'] })));
      await page.route(/\/api\/reservation\/reservations\/my/, route => route.fulfill(json([])));
      await page.route(/\/api\/reservation\/reservations$/, route => route.abort('failed'));
      await page.clock.install({ time: new Date(instant) });
      await page.goto('/guardian/hospital');
      await page.getByRole('button', { name: '새 진료 예약하기' }).click();
      await page.locator('button[class*="hospitalRow"]').filter({ hasText: 'E2E점검병원' }).click();
      await expect(page.getByRole('region', { name: '날짜' })).toBeVisible();
      return { context, page };
    }

    // A) 브라우저는 하와이 시간(UTC-10): 한국은 이미 다음 날 00:30 이다
    const kstTodayA = addIsoDays(base, 1);
    const a = await openBooking('Pacific/Honolulu', `${base}T15:30:00Z`);
    try {
      const days = a.page.getByRole('region', { name: '날짜' }).getByRole('button');
      await expect(days.first(), '첫 날짜 칸은 한국 시간의 오늘').toHaveAttribute('aria-label', `${dateShort(kstTodayA)} 오늘`);
      await expect(days, '날짜 칸 7개').toHaveCount(7);
      await expect(a.page.getByRole('region', { name: '날짜' }).getByRole('button', { name: new RegExp(`^${dateShort(base).replace(/[()]/g, '\\$&')}`) }), '브라우저의 어제 날짜는 없다').toHaveCount(0);
      await days.first().click();
      // 한국 00:30 이라 00:30 칸은 지난 시각(같아도 지난 것) -> 마감, 나머지 3칸은 고를 수 있다
      const times = a.page.getByRole('region', { name: '시간' });
      await expect(times.getByText('예약할 수 있는 시간을 확인하는 중이에요.')).toHaveCount(0);
      await expect(times.getByRole('button', { name: '오전 12시 30분 마감' }), '지난 시각은 마감').toBeDisabled();
      await expect(times.locator('button:not([disabled])'), '고를 수 있는 시각 3개').toHaveCount(3);
    } finally {
      await a.context.close();
    }

    // B) 브라우저는 키리바시 시간(UTC+14): 브라우저는 다음 날 04:30 이지만 한국은 아직 그날 23:30 이다
    const kstTodayB = base;
    const b = await openBooking('Pacific/Kiritimati', `${base}T14:30:00Z`);
    try {
      const days = b.page.getByRole('region', { name: '날짜' }).getByRole('button');
      await expect(days.first(), '첫 날짜 칸은 한국 시간의 오늘').toHaveAttribute('aria-label', `${dateShort(kstTodayB)} 오늘`);
      await days.first().click();
      // 한국 23:30 이라 오늘의 모든 시각이 지났다
      await expect(b.page.getByText('이날은 예약할 수 있는 시간이 없어요. 다른 날을 골라 주세요.'), '오늘은 남은 시각이 없다').toBeVisible();
      await days.nth(1).click();
      await expect(b.page.getByRole('region', { name: '시간' }).locator('button:not([disabled])'), '다음 날은 4개 모두 고를 수 있다').toHaveCount(4);
    } finally {
      await b.context.close();
    }
    // C) 화면을 켜 둔 채 KST 자정을 넘긴다: KST 23:59:30 에서 90초 흘리면 첫 날짜 칸이 다음 날 "오늘"로 바뀐다(1분마다 갱신)
    const midnightInstant = `${base}T14:59:30Z`; // = KST 오늘(base) 23:59:30
    const c = await openBooking('Asia/Seoul', midnightInstant);
    try {
      const days = c.page.getByRole('region', { name: '날짜' }).getByRole('button');
      await expect(days.first(), '자정 전 첫 날짜 칸').toHaveAttribute('aria-label', `${dateShort(base)} 오늘`);
      await c.page.clock.runFor(90_000);
      await expect(days.first(), '자정을 넘기면 첫 날짜 칸이 다음 날 "오늘"로 바뀐다').toHaveAttribute('aria-label', `${dateShort(addIsoDays(base, 1))} 오늘`);
    } finally {
      await c.context.close();
    }
    test.info().annotations.push({
      type: '확인 범위',
      description: '브라우저 시간대와 시계를 바꿔 "오늘"·지난 시각 계산이 한국 시간(KST)인지 확인하고, 화면을 켜 둔 채 시계를 KST 23:59:30 에서 90초 넘겨 날짜 칸이 다음 날로 바뀌는지(1분마다 갱신)도 확인했다. 예약 서비스는 가짜 응답이다. 챗봇 예약 흐름의 날짜(AI 서버 255행)는 실제 예약·Claude 호출이 얽혀 확인하지 않았다.',
    });
  });

  test('CHAT-N45 글자·배경 대비 4.5:1 이상', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const ward1 = await tempUser('WARD', { name: '큐에이한울' });
    const ward2 = await tempUser('WARD', { name: '큐에이다솜' });
    connect(guardianUser.id, ward1.id);
    connect(guardianUser.id, ward2.id);
    const guardian = await loginSafe(guardianUser);
    const ward = await loginSafe(ward1);

    const targets: Array<[string, 'guardian' | 'ward', string, string]> = [
      ['보호자 대시보드', 'guardian', '/guardian', '보호자 대시보드'],
      ['보호자 챗봇', 'guardian', '/guardian/chatbot', 'AI 의료 챗봇'],
      ['보호자 AI 기분 체크(말벗)', 'guardian', '/guardian/emotion', 'AI 기분 체크'],
      ['피보호자 챗봇', 'ward', '/ward/chatbot', 'AI 의료 챗봇'],
      ['피보호자 안부 말벗', 'ward', '/ward/companion', '안부 말벗'],
    ];
    const guardianPage = await openAs(guardian.who, null);
    const wardPage = await openAs(ward.who, null);
    const summary: string[] = [];
    for (const [label, who, url, title] of targets) {
      const page = who === 'guardian' ? guardianPage : wardPage;
      await page.goto(url);
      await expect(page, `${label} 페이지 제목`).toHaveTitle(`${title} | CareAI`);
      await expect(page.locator('main'), `${label} 본문`).toBeVisible();
      await expect(page.getByText(/불러오는 중|확인 중/), `${label}: 불러오기가 끝난 뒤에 검사한다`).toHaveCount(0, { timeout: 30_000 });
      const axe = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
      const nodes = axe.violations.flatMap(v => v.nodes);
      summary.push(`${label}: 대비 부족 ${nodes.length}곳`);
      expect.soft(nodes.map(n => n.target.join(' ')).slice(0, 5), `${label}: 대비 4.5:1 미만 칸 (최대 5개만 표시, 전체 ${nodes.length}곳)`).toEqual([]);
    }
    test.info().annotations.push({ type: '실측', description: summary.join(' / ') });
  });

  test('CHAT-N46 기본 접근성: lang=ko, 페이지 제목, 포커스, 모달 키보드, 탭 role', TAGS, async ({ tempUser, openAs }) => {
    test.setTimeout(300_000);
    const guardianUser = await tempUser('GUARDIAN');
    const ward1 = await tempUser('WARD', { name: '큐에이한울' });
    const ward2 = await tempUser('WARD', { name: '큐에이다솜' });
    connect(guardianUser.id, ward1.id);
    connect(guardianUser.id, ward2.id);
    const guardian = await loginSafe(guardianUser);
    const ward = await loginSafe(ward1);
    const guardianPage = await openAs(guardian.who, null);
    const wardPage = await openAs(ward.who, null);

    // 1) html lang="ko" 와 페이지마다 제목
    const titles: Array<['guardian' | 'ward', string, string]> = [
      ['guardian', '/guardian', '보호자 대시보드'],
      ['guardian', '/guardian/chatbot', 'AI 의료 챗봇'],
      ['guardian', '/guardian/emotion', 'AI 기분 체크'],
      ['ward', '/ward/chatbot', 'AI 의료 챗봇'],
      ['ward', '/ward/companion', '안부 말벗'],
    ];
    for (const [who, url, title] of titles) {
      const page = who === 'guardian' ? guardianPage : wardPage;
      await page.goto(url);
      await expect.soft(page, `${url} 페이지 제목`).toHaveTitle(`${title} | CareAI`);
      await expect.soft(page.locator('html'), `${url}: html lang`).toHaveAttribute('lang', 'ko');
    }

    // 2) 포커스 표시: 챗봇 화면에서 Tab 으로 움직일 때 포커스 요소마다 눈에 보이는 표시(윤곽선 또는 그림자)가 있다
    await guardianPage.goto('/guardian/chatbot');
    await expectPageTitle(guardianPage, 'AI 의료 챗봇');
    const noIndicator: string[] = [];
    for (let i = 0; i < 6; i++) {
      await guardianPage.keyboard.press('Tab');
      const info = await guardianPage.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
        const shadow = style.boxShadow !== 'none';
        return { label: `${el.tagName.toLowerCase()}[${el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 12) ?? ''}]`, visible: outline || shadow };
      });
      if (info && !info.visible) noIndicator.push(info.label);
    }
    expect.soft(noIndicator, '포커스 표시가 없는 요소').toEqual([]);

    // 3) 닫힌 메뉴는 포커스를 받지 않는다 (메뉴는 "메뉴" 버튼을 눌러야 열린다 - 닫혀 있는 동안 Tab 이 메뉴 안으로 들어가면 안 된다)
    const inClosedMenu: number[] = [];
    for (let i = 0; i < 25; i++) {
      await guardianPage.keyboard.press('Tab');
      if (await focusInside(guardianPage, '[aria-label="보호자 메뉴"]')) inClosedMenu.push(i + 1);
    }
    expect.soft(inClosedMenu, '닫힌 메뉴 안에 포커스가 간 Tab 횟수(25번 중)').toEqual([]);

    // 4) 모달 키보드: 메뉴를 열어 내 프로필 창을 열고, Tab 이 창 안에 갇히고, Esc 로 닫힌다
    await guardianPage.getByRole('button', { name: /^메뉴/ }).first().click();
    const dialog = guardianPage.locator('[role="dialog"], [role="alertdialog"]');
    await guardianPage.locator('button[aria-haspopup="dialog"]').filter({ hasText: '내 프로필' }).click();
    await expect(dialog, '내 프로필 창').toBeVisible();
    // 열자마자 Esc: 창이 닫힌다
    await guardianPage.keyboard.press('Escape');
    // 닫히는 데 애니메이션·상태 반영 지연이 있을 수 있어 잠깐(2초) 기다려 본다
    await expect.soft(dialog, '열자마자 Esc 를 누르면 창이 닫힌다').toBeHidden({ timeout: 2000 });
    const closedByEsc = await dialog.isHidden();
    if (closedByEsc) {
      await guardianPage.getByRole('button', { name: /^메뉴/ }).first().click();
      await guardianPage.locator('button[aria-haspopup="dialog"]').filter({ hasText: '내 프로필' }).click();
    }
    // Tab 12번: 포커스가 창 안에서만 돈다
    await expect(dialog, '내 프로필 창(다시 열림)').toBeVisible();
    const escaped: number[] = [];
    for (let i = 0; i < 12; i++) {
      await guardianPage.keyboard.press('Tab');
      if (!(await focusInside(guardianPage, '[role="dialog"], [role="alertdialog"]'))) escaped.push(i + 1);
    }
    expect.soft(escaped, '창 밖으로 나간 Tab 횟수(12번 중)').toEqual([]);
    // 5) 피보호자 선택 탭(wardTabs·wardRail)에 role=tab·aria-selected
    await guardianPage.goto('/guardian');
    const tabs = guardianPage.getByRole('tab');
    await expect.soft(tabs, '피보호자 탭 2개(role=tab)').toHaveCount(2);
    const selected = await tabs.evaluateAll(els => els.map(el => el.getAttribute('aria-selected')));
    expect.soft(selected.slice().sort(), '탭마다 aria-selected 가 있고 하나만 선택됨').toEqual(['false', 'true']);
  });

  test('CHAT-N48 FE dev 컨테이너 healthy (dev 는 next dev 로 운영하는 것이 의도된 설정)', TAGS, async () => {
    // 배포 서버의 FE dev 컨테이너 상태를 읽기만 한다 (docker inspect·top)
    const status = remoteBash(
      "docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}nohealth{{end}}' silver-bridge-fe-dev-web\n",
    ).trim();
    expect(status, 'FE dev 컨테이너 상태와 건강 확인').toBe('running healthy');
    const processes = remoteBash('docker top silver-bridge-fe-dev-web -eo pid,args\n').split('\n');
    const runsDev = processes.some(line => /\bnext dev\b|\bnpm run dev/.test(line));
    const runsStart = processes.some(line => /\bnext start\b|\bnpm (run )?start\b/.test(line));
    // 실행 방식은 실패로 두지 않고 실측만 남긴다: 배포본 docker-compose.dev.yml(a8666240)은 소스를 볼륨으로 붙이고 일부러 npm run dev:docker(next dev)를 띄운다
    test.info().annotations.push({
      type: '실측',
      description: `실행 방식: ${runsDev ? 'next dev' : runsStart ? 'next start' : '확인 불가'}. 결과는 "정책상 정상"이다 - dev compose 의 command 가 npm run dev:docker 이고 start_period 주석도 next dev 를 전제로 한다. next build 후 next start 는 prod(Dockerfile CMD npm run start)의 방식이다.`,
    });
    test.info().annotations.push({
      type: '배포 담당 결정 필요',
      description: 'dev 도 prod 처럼 next start 로 바꿀지(옛 항목 NOID-11)는 배포 담당이 정한다. 바꾸기로 하면 FE docker-compose.dev.yml 의 command 를 Dockerfile 빌드(next build -> next start)로 바꾸고 healthcheck start_period 를 다시 맞춘다. 이 테스트는 읽기만 했고(docker inspect·top) 서버 설정·컨테이너는 바꾸지 않았다.',
    });
  });
});
