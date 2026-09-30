/**
 * 변수 QA - 관리자 영역 (low 12건)
 *
 * 부작용 차단:
 *  - 임시 사용자(tempUser)와 [QA-ADMIN] 접두어 공지/임시저장/문의만 쓰고, 끝나면 모두 지운다.
 *  - 임시 사용자는 FCM 토큰이 없고 전화번호가 미배정 국번(0100001xxxx)이라 외부 발송이 나가지 않는다.
 *  - SMS/이메일/알림톡 발송 API 는 부르지 않는다. 로그인 rate limit 은 Redis 키 삭제로만 다룬다.
 *  - 공지는 전 사용자에게 보이므로 만든 즉시(테스트 끝) 삭제한다.
 */
import { APIResponse, Page, request } from '@playwright/test';

import { Api } from '../../src/api';
import { env } from '../../src/env';
import { expect, test, waitForRealtime } from '../../src/fixtures';
import { psql, redisDelPattern, sqlStr } from '../../src/remote';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface Body {
  status: number;
  text: string;
  json: { success?: boolean; message?: string; data?: any };
}

async function bodyOf(res: APIResponse): Promise<Body> {
  const text = await res.text();
  try {
    return { status: res.status(), text, json: JSON.parse(text) };
  } catch {
    return { status: res.status(), text, json: {} };
  }
}

/** 관리자 조치가 남긴 감사 로그 정리 (삭제 API 가 없어 DB 로 지운다) */
function cleanAuditLog(adminId: string, targetIds: string[]) {
  const targets = targetIds.map(sqlStr).join(', ');
  psql(`DELETE FROM admin_audit_log WHERE admin_id = ${sqlStr(adminId)}${targets ? ` OR target_id IN (${targets})` : ''};`);
}

/** 응답 트리에서 PageResponse(content 배열 + size) 를 찾는다 */
function findPage(json: any): { content: any[]; page: number; size: number; totalElements: number } | undefined {
  if (json && typeof json === 'object') {
    if (Array.isArray(json.content) && typeof json.size === 'number') return json;
    for (const value of Object.values(json)) {
      const found = findPage(value);
      if (found) return found;
    }
  }
  return undefined;
}

/** 화면의 연결 카드 */
function card(page: Page, partnerName: string) {
  return page.locator('li[data-role]').filter({ hasText: partnerName });
}

async function settle<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await sleep(500);
    value = await read();
  }
  return value;
}

/** 공지 만들기 (성공하면 id 를 돌려준다) */
async function createAnnouncement(api: Api, title: string, content: string) {
  const res = await bodyOf(await api.raw('POST', '/api/admin/announcement/create', { title, content }));
  const id: number | undefined = res.status === 200 ? res.json.data?.id : undefined;
  return { res, id };
}

async function deleteAnnouncements(api: Api, ids: number[]) {
  for (const id of ids) await api.raw('DELETE', `/api/admin/announcement/delete/${id}`).catch(() => undefined);
}

test.describe('JWT 무효화 시각 정밀도', () => {
  test('[ADMIN-G03] 역할 변경 직후 같은 초에 재로그인해 받은 새 토큰도 유효하다 (401 이 나지 않는다)', async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const admin = await tempUser('ADMIN');
    const target = await tempUser('WARD');
    const a = await loginAs(admin);

    // 조치 응답 후 재로그인까지의 지연(ms). 짧을수록 같은 초에 걸릴 확률이 높다
    const delays = [0, 0, 0, 400, 400, 400, 800, 800, 800, 1200, 1200, 1200];
    const rounds = delays.length;
    const failures: string[] = [];
    const byDelay: Record<number, string> = {};
    let role: 'WARD' | 'GUARDIAN' = 'WARD';
    try {
      for (let i = 1; i <= rounds; i++) {
        // 로그인 rate limit(분당 10회)과 이전 무효화 키를 PATCH 전에 정리 (PATCH~로그인 사이에는 원격 호출을 끼우지 않는다)
        redisDelPattern('rate:signin:*');
        redisDelPattern(`password:invalidate:${target.id}`);
        role = role === 'WARD' ? 'GUARDIAN' : 'WARD';

        const patch = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { role }));
        expect(patch.status, `${i}회차 역할 변경 응답: ${patch.text}`).toBe(200);

        // 조치 응답 후 (지연 뒤) 재로그인 -> 내 정보 조회
        const sent = Date.now();
        if (delays[i - 1] > 0) await sleep(delays[i - 1]);
        let step = 'ok';
        try {
          const login = await Api.signin(target.email, target.password);
          const api = await Api.fromLogin(login);
          const me = await api.raw('GET', '/api/user/me');
          await api.dispose();
          if (me.status() !== 200) step = `me ${me.status()}`;
        } catch (error) {
          step = `signin ${(error as { status?: number }).status ?? 'ERR'}`;
        }
        byDelay[delays[i - 1]] = `${byDelay[delays[i - 1]] ?? ''}${step === 'ok' ? 'O' : 'X'}`;
        if (step !== 'ok') failures.push(`${i}회차(조치 후 ${Date.now() - sent}ms): ${step}`);
      }
      console.log(`[G03] 지연별 결과(O=정상, X=401): ${JSON.stringify(byDelay)}`);

      // 대조군: 조치 1.5초 뒤의 로그인은 항상 정상이어야 한다
      redisDelPattern('rate:signin:*');
      await a.api.raw('PATCH', `/api/admin/user/${target.id}`, { role: role === 'WARD' ? 'GUARDIAN' : 'WARD' });
      await sleep(1_500);
      const control = await Api.signin(target.email, target.password).then(
        async login => {
          const api = await Api.fromLogin(login);
          const status = (await api.raw('GET', '/api/user/me')).status();
          await api.dispose();
          return status;
        },
        () => 0,
      );

      test.info().annotations.push({ type: '실측', description: `${rounds}회 중 ${failures.length}회 실패 [${failures.join(' / ')}], 지연별 ${JSON.stringify(byDelay)}, 1.5초 뒤 대조군 me=${control}` });
      console.log(`[G03] 대조군(조치 1.5초 뒤) me=${control}`);
      expect(
        failures,
        `역할 변경 후 재로그인한 새 토큰이 ${failures.length}/${rounds}회 401 이다 (지연별 ${JSON.stringify(byDelay)}, 1.5초 뒤 대조군 me=${control}). JWT iat 는 초 단위로 절삭, 무효화 시각은 ms 라 같은 초의 새 토큰도 iat <= invalidatedAt 로 무효 처리됨`,
      ).toEqual([]);
    } finally {
      redisDelPattern(`password:invalidate:${target.id}`);
      cleanAuditLog(admin.id, [target.id]);
    }
  });
});

test.describe('공지 조회수 동시성', () => {
  test('[ADMIN-G06] 공지 상세를 동시에 여러 번 조회해도 조회수는 성공한 요청 수만큼 정확히 늘어난다', async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const admin = await tempUser('ADMIN');
    const guardian = await tempUser('GUARDIAN');
    const [a, g] = [await loginAs(admin), await loginAs(guardian)];

    const created = await createAnnouncement(a.api, `[QA-ADMIN] G06 ${Date.now().toString(36)}`, '조회수 동시성 확인용 (곧 삭제됨)');
    expect(created.id, `준비: 공지 생성 ${created.res.text}`).toBeTruthy();
    const id = created.id!;
    try {
      const readCount = async () => Number((await a.api.get<{ viewCount: number }>(`/api/admin/announcement/select/detail/${id}`)).viewCount);
      const before = await readCount();

      // 부하가 커지지 않게 20건씩 3라운드만 발사한다
      let ok = 0;
      for (let round = 0; round < 3; round++) {
        const results = await Promise.all(
          Array.from({ length: 20 }, () => g.api.raw('GET', `/api/commonness/announcement/select/detail/${id}`)),
        );
        ok += results.filter(r => r.status() === 200).length;
      }
      await sleep(500);
      const after = await readCount();
      const increased = after - before;

      test.info().annotations.push({ type: '실측', description: `성공 조회 ${ok}건, 조회수 ${before} -> ${after} (증가 ${increased})` });
      expect(
        increased,
        `동시 조회 ${ok}건에 조회수가 ${increased} 만 늘었다 (읽기-수정-쓰기라 증가분이 유실됨. update view_count = view_count + 1 원자 쿼리여야 함)`,
      ).toBe(ok);
    } finally {
      await deleteAnnouncements(a.api, [id]);
      cleanAuditLog(admin.id, [String(id)]);
    }
  });
});

test.describe('관리자 목록 페이징', () => {
  test('[ADMIN-G09] 관리자 목록 4종은 page<0 을 0 으로, size 를 1~50 으로 똑같이 보정한다 (문의 목록만 400 이거나 상한이 없으면 안 된다)', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const a = await loginAs(admin);

    const lists = [
      { label: '회원', path: '/api/admin/user' },
      { label: '이상감지', path: '/api/admin/anomaly' },
      { label: '알림 이력', path: '/api/admin/notification' },
      { label: '문의', path: '/api/admin/inquiry' },
    ];
    const queries = ['size=0', 'size=-1', 'page=-1', 'size=51', 'size=1000'];

    const seen: string[] = [];
    // 쿼리별로 목록마다 실제 적용된 (page, size) 를 모아 4종이 같은지 비교한다
    const applied: Record<string, Record<string, string>> = {};
    // 참고: 필터 없는 회원 목록 자체의 응답 (페이징 보정과 무관한 500 인지 가려낸다)
    for (const probe of ['/api/admin/user', '/api/admin/user?keyword=e2e']) {
      const r = await bodyOf(await a.api.raw('GET', probe));
      seen.push(`[참고] ${probe} -> ${r.status}`);
    }
    for (const list of lists) {
      for (const query of queries) {
        const r = await bodyOf(await a.api.raw('GET', `${list.path}?${list.label === '회원' ? 'keyword=e2e&' : ''}${query}`));
        const page = findPage(r.json.data);
        seen.push(`${list.label} ${query} -> ${r.status}${page ? ` (page=${page.page}, size=${page.size})` : ` ${r.json.message ?? ''}`}`);
        (applied[query] ??= {})[list.label] = page ? `page=${page.page},size=${page.size}` : `HTTP ${r.status}`;

        expect.soft(r.status, `${list.label} 목록 ${query}: 보정되어 200 이어야 하는데 ${r.status} ${r.json.message ?? ''}`).toBe(200);
        if (page) {
          expect.soft(page.page, `${list.label} 목록 ${query}: page 는 0 이상으로 보정되어야 한다 (실제 ${page.page})`).toBeGreaterThanOrEqual(0);
          expect.soft(page.size, `${list.label} 목록 ${query}: size 는 1~50 으로 보정되어야 한다 (실제 ${page.size})`).toBeGreaterThanOrEqual(1);
          expect.soft(page.size, `${list.label} 목록 ${query}: size 상한 50 이 없다 (실제 ${page.size})`).toBeLessThanOrEqual(50);
        }
      }
    }
    // 핵심: 같은 page/size 입력이면 4종 목록이 똑같이 보정되어야 한다 (예: size=0 이 어떤 목록은 1, 어떤 목록은 20 이면 불일치)
    for (const query of queries) {
      const byList = applied[query] ?? {};
      const distinct = [...new Set(Object.values(byList))];
      expect.soft(
        distinct,
        `${query}: 관리자 목록 4종의 보정 결과가 서로 다르다 ${JSON.stringify(byList)} (회원/문의는 size<=0 을 1 로, 이상감지/알림 이력은 20 으로 보정). 한 가지 규칙으로 통일되어야 한다`,
      ).toHaveLength(1);
    }

    console.log(`[G09]\n${seen.join('\n')}`);
    test.info().annotations.push({ type: '실측', description: seen.join(' | ') });
  });
});

test.describe('회원 목록 연결 필터', () => {
  test('[ADMIN-G10] 회원 목록에서 연결 필터(NONE)를 걸면 연결 축이 없는 관리자 계정은 목록에서 빠진다', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const plainGuardian = await tempUser('GUARDIAN');
    const a = await loginAs(admin);

    const search = async (keyword: string, extra = '') => {
      const r = await bodyOf(await a.api.raw('GET', `/api/admin/user?connection=NONE${extra}&keyword=${encodeURIComponent(keyword)}`));
      expect(r.status, `목록 조회 응답: ${r.text.slice(0, 200)}`).toBe(200);
      return (findPage(r.json.data)?.content ?? []) as { userId: string; role: string; connectionState: unknown }[];
    };

    // 대조군: 연결이 없는 임시 보호자는 NONE 필터에 나온다
    const guardians = await search(plainGuardian.email);
    expect(guardians.map(u => u.userId), '준비: 연결 없는 보호자는 connection=NONE 에 나와야 한다').toContain(plainGuardian.id);

    const admins = await search(admin.email);
    const admins2 = await search(admin.email, '&role=ADMIN');
    const found = [...admins, ...admins2].filter(u => u.userId === admin.id);
    test.info().annotations.push({ type: '실측', description: `connection=NONE 결과에 관리자 행 ${found.length}건 (connectionState=${JSON.stringify(found[0]?.connectionState)})` });
    expect(found.length, 'Swagger 는 "관리자는 연결 필터를 걸면 목록에서 빠진다"고 하는데 연결이 없는 ADMIN 이 connection=NONE 결과에 포함된다').toBe(0);
  });
});

test.describe('피보호자 강제 연결 실시간 반영', () => {
  test('[ADMIN-G13] 화면을 보고 있는 피보호자에게 관리자 강제 연결이 새로고침 없이 보호자 목록에 나타난다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    const suffix = Date.now().toString(36).slice(-4);
    const guardian = await tempUser('GUARDIAN', { name: `QA강제${suffix}` });
    const ward = await tempUser('WARD');
    const admin = await tempUser('ADMIN');
    const a = await loginAs(admin);
    const { who } = await loginAs(ward);

    try {
      const page = await openAs(who, '/ward/guardians');
      await waitForRealtime(page);
      await page.getByRole('tab', { name: '내 보호자 리스트' }).click();
      await expect(page.getByText('연결된 보호자가 없습니다.')).toBeVisible();

      const res = await bodyOf(await a.api.raw('POST', '/api/admin/connection', { guardianId: guardian.id, wardId: ward.id }));
      expect(res.status, `강제 연결 응답: ${res.text}`).toBe(200);

      // 새로고침/포커스 이동 없이 반영을 기다린다
      const shown = await settle(async () => await card(page, guardian.name).count(), count => count > 0, 20_000);
      test.info().annotations.push({ type: '실측', description: `20초 안에 보호자 카드 ${shown}개 표시` });
      expect(
        shown,
        '피보호자 FE 가 WS connection-accepted 를 구독하지 않아(WARD_CONNECTION_TOPICS 에 없음) 강제 연결된 보호자가 새로고침 전에는 목록에 나타나지 않는다',
      ).toBeGreaterThan(0);
    } finally {
      cleanAuditLog(admin.id, []);
    }
  });
});

test.describe('대시보드 카메라 지표', () => {
  test('[ADMIN-G20] 비활성(is_active=false) 카메라를 등록해도 "끊김 카메라" 수는 늘지 않는다', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const ward = await tempUser('WARD');
    const a = await loginAs(admin);

    type Safety = { aiConnected: boolean; totalCameras: number; streamingCameras: number | null; safetyEvents: { disconnectedCameras: number | null } };
    const before = await a.api.get<Safety>('/api/admin/dashboard/safety');
    test.info().annotations.push({ type: '실측(사전)', description: `aiConnected=${before.aiConnected}, total=${before.totalCameras}, streaming=${before.streamingCameras}, disconnected=${before.safetyEvents.disconnectedCameras}` });
    // AI 미연결이면 streaming/disconnected 가 null(알 수 없음)이라 지표 자체를 비교할 수 없다
    test.fixme(!before.aiConnected, 'AI 서버가 끊겨 있어(AI-6) 스트리밍/끊김 카메라 지표가 null 이라 비교할 수 없다. AI 복구 후 재실행');

    try {
      psql(`INSERT INTO camera (ward_id, session_id, device_id, label, registered_by, is_active)
            VALUES (${sqlStr(ward.id)}, ${sqlStr(`qa-g20-${ward.id}`)}, ${sqlStr(`qa-g20-dev-${ward.id}`)}, '[QA-ADMIN] G20 비활성', ${sqlStr(ward.id)}, false);`);
      const after = await a.api.get<Safety>('/api/admin/dashboard/safety');
      const [d0, d1] = [before.safetyEvents.disconnectedCameras ?? 0, after.safetyEvents.disconnectedCameras ?? 0];
      test.info().annotations.push({ type: '실측', description: `비활성 카메라 1대 추가: total ${before.totalCameras} -> ${after.totalCameras}, disconnected ${d0} -> ${d1}` });
      expect(d1, `사용자가 끈(비활성) 카메라 1대가 "끊김"으로 집계됐다 (끊김 ${d0} -> ${d1}). 활성 등록 카메라 기준이어야 한다`).toBe(d0);
    } finally {
      psql(`DELETE FROM camera WHERE ward_id = ${sqlStr(ward.id)};`);
    }
  });
});

test.describe('입력 문자 검증', () => {
  test('[ADMIN-G21] 입력에 NUL(\\u0000) 문자가 있으면 500 이 아니라 400 "잘못된 입력값입니다." 를 받는다', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    // 피보호자는 이용 제한 자체가 막혀 있어(400) 정지 사유 검증은 보호자 대상으로 한다
    const restrictTarget = await tempUser('GUARDIAN');
    const [a, g] = [await loginAs(admin), await loginAs(guardian)];

    const annIds: number[] = [];
    try {
      const nul = 'a\u0000b';

      // 답변 대상 문의는 알림이 나가지 않도록 DB 로 만든다
      const inquiryId = psql(`INSERT INTO inquiry (user_id, category, title, content, status)
                              VALUES (${sqlStr(guardian.id)}, 'ETC', '[QA-ADMIN] G21', '답변 NUL 확인용', 'WAITING') RETURNING id;`)
        .split('\n')[0].trim();

      const cases: { label: string; run: () => Promise<Body> }[] = [
        { label: '문의 작성 title', run: async () => bodyOf(await g.api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title: nul, content: 'x' })) },
        { label: '문의 작성 content', run: async () => bodyOf(await g.api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title: '[QA-ADMIN] G21', content: nul })) },
        { label: '문의 답변', run: async () => bodyOf(await a.api.raw('POST', `/api/admin/inquiry/${inquiryId}/answer`, { answer: nul })) },
        { label: '공지 title', run: async () => bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: nul, content: 'x' })) },
        { label: '회원 이름', run: async () => bodyOf(await a.api.raw('PATCH', `/api/admin/user/${ward.id}`, { name: nul })) },
        { label: '정지 사유', run: async () => bodyOf(await a.api.raw('PATCH', `/api/admin/user/${restrictTarget.id}`, { status: 'RESTRICTED', statusReason: nul })) },
      ];

      const seen: string[] = [];
      for (const c of cases) {
        const r = await c.run();
        if (r.status === 200 && typeof r.json.data?.id === 'number' && c.label.startsWith('공지')) annIds.push(r.json.data.id);
        seen.push(`${c.label} -> ${r.status} ${r.json.message ?? ''}`);
        expect.soft(r.status, `${c.label} 에 NUL 문자를 보내면 400 이어야 하는데 ${r.status} ${r.json.message ?? ''} (PostgreSQL 이 0x00 을 거부해 DataIntegrityViolation -> 500)`).toBe(400);
        if (r.status === 400) expect.soft(r.json.message, `${c.label}: 400 메시지`).toBe('잘못된 입력값입니다.');
      }
      test.info().annotations.push({ type: '실측', description: seen.join(' | ') });
    } finally {
      await deleteAnnouncements(a.api, annIds);
      psql(`DELETE FROM inquiry WHERE user_id = ${sqlStr(guardian.id)};`);
      cleanAuditLog(admin.id, [ward.id, restrictTarget.id, ...annIds.map(String)]);
    }
  });

  test('[ADMIN-G22] 공백류(NBSP/ZWSP)뿐인 제목·이름은 400 이고, 글자 수는 이모지도 1자로 센다', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const ward = await tempUser('WARD');
    const a = await loginAs(admin);

    const annIds: number[] = [];
    try {
      const seen: string[] = [];
      const announce = async (label: string, title: string, content: string, expected: 200 | 400) => {
        const { res, id } = await createAnnouncement(a.api, title, content);
        if (id !== undefined) annIds.push(id);
        seen.push(`${label} -> ${res.status}`);
        return { res, expected, label };
      };

      // 공백류만으로 된 제목/내용은 비어 있는 것과 같으므로 400
      const blanks = [
        await announce('공지 제목 NBSP', ' ', '본문', 400),
        await announce('공지 제목 ZWSP', '​', '본문', 400),
        await announce('공지 내용 NBSP', '[QA-ADMIN] G22', '  ', 400),
      ];
      for (const b of blanks) {
        expect.soft(b.res.status, `${b.label}: 공백류뿐인 입력이 ${b.res.status} 로 저장됐다 (@NotBlank 는 NBSP/ZWSP 를 공백으로 보지 않음). 400 이어야 한다`).toBe(400);
      }

      // 회원 이름: NBSP 만 -> 400
      const nbspName = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${ward.id}`, { name: ' ' }));
      seen.push(`회원 이름 NBSP -> ${nbspName.status}`);
      expect.soft(nbspName.status, `회원 이름이 NBSP 뿐인데 ${nbspName.status} (trim() 은 U+0020 이하만 제거). 400 이어야 한다`).toBe(400);

      // 글자 수는 코드포인트 기준: 이모지 11자(UTF-16 22단위)는 이름 20자 제한 안쪽이라 200
      const emojiName = '🙂'.repeat(11);
      const named = await bodyOf(await a.api.raw('PATCH', `/api/admin/user/${ward.id}`, { name: emojiName }));
      seen.push(`회원 이름 이모지 11자 -> ${named.status}`);
      expect.soft(named.status, `이모지 11자(20자 이내)인 이름이 ${named.status} ${named.json.message ?? ''} 로 거부됐다 (UTF-16 22단위로 계산)`).toBe(200);

      // 공지 제목 이모지 101자(UTF-16 202단위)는 200자 이내라 200
      const longTitle = await announce('공지 제목 이모지 101자', '🙂'.repeat(101), '본문', 200);
      expect.soft(longTitle.res.status, `이모지 101자(200자 이내) 제목이 ${longTitle.res.status} ${longTitle.res.json.message ?? ''} 로 거부됐다 (UTF-16 202단위로 계산)`).toBe(200);

      test.info().annotations.push({ type: '실측', description: seen.join(' | ') });
    } finally {
      await deleteAnnouncements(a.api, annIds);
      cleanAuditLog(admin.id, [ward.id, ...annIds.map(String)]);
    }
  });
});

test.describe('목록 API 규모', () => {
  test('[ADMIN-G24] 공지·문의·임시저장 목록은 페이징되거나 목록에 본문 전체를 싣지 않는다', async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const admin = await tempUser('ADMIN');
    const guardian = await tempUser('GUARDIAN');
    const [a, g] = [await loginAs(admin), await loginAs(guardian)];

    const annIds: number[] = [];
    const draftIds: number[] = [];
    try {
      const body5000 = 'ㄱ'.repeat(5000);
      const tag = `[QA-ADMIN] G24 ${Date.now().toString(36)}`;
      for (let i = 0; i < 3; i++) {
        const { id } = await createAnnouncement(a.api, `${tag} ${i}`, body5000);
        if (id !== undefined) annIds.push(id);
        const d = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/draft/create', { title: `${tag} d${i}`, content: body5000 }));
        if (d.status === 200 && typeof d.json.data?.id === 'number') draftIds.push(d.json.data.id);
      }
      expect(annIds, '준비: 공지 3건 생성').toHaveLength(3);
      psql(`INSERT INTO inquiry (user_id, category, title, content, status)
            SELECT ${sqlStr(guardian.id)}, 'ETC', ${sqlStr(`${tag} q`)} || n, repeat('ㄱ', 2000), 'WAITING' FROM generate_series(1, 3) n;`);

      const targets = [
        { label: '공지 공개 목록', api: g.api, path: '/api/commonness/announcement/select', body: 5000 },
        { label: '공지 관리자 목록', api: a.api, path: '/api/admin/announcement/select', body: 5000 },
        { label: '임시저장 목록', api: a.api, path: '/api/admin/announcement/draft/select', body: 5000 },
        { label: '내 문의 목록', api: g.api, path: '/api/guardian/inquiry', body: 2000 },
      ];
      const seen: string[] = [];
      for (const t of targets) {
        const started = Date.now();
        const r = await bodyOf(await t.api.raw('GET', t.path));
        const ms = Date.now() - started;
        expect(r.status, `${t.label} 응답 ${r.text.slice(0, 200)}`).toBe(200);
        const paged = !Array.isArray(r.json.data) && !!findPage(r.json.data);
        const items: any[] = Array.isArray(r.json.data) ? r.json.data : findPage(r.json.data)?.content ?? [];
        const withBody = items.filter(i => typeof i.content === 'string' && i.content.length >= t.body).length;
        seen.push(`${t.label}: ${items.length}건, 본문 전체 포함 ${withBody}건, 응답 ${r.text.length}바이트 ${ms}ms, 페이징 ${paged}`);
        expect.soft(
          paged || withBody === 0,
          `${t.label}: 페이징 없이 전량을 반환하면서 항목마다 본문 전체(${t.body}자)를 싣는다 (본문 포함 ${withBody}건, 응답 ${r.text.length}바이트)`,
        ).toBe(true);
      }
      test.info().annotations.push({ type: '실측', description: seen.join(' | ') });
    } finally {
      await deleteAnnouncements(a.api, annIds);
      for (const id of draftIds) await a.api.raw('DELETE', `/api/admin/announcement/draft/delete/${id}`).catch(() => undefined);
      psql(`DELETE FROM inquiry WHERE user_id = ${sqlStr(guardian.id)};`);
      cleanAuditLog(admin.id, [...annIds, ...draftIds].map(String));
    }
  });
});

test.describe('문의 작성 남용 방지', () => {
  test('[ADMIN-G26] 같은 보호자가 같은 문의를 한꺼번에 여러 번 보내면 전부 저장되지 않는다 (rate limit 또는 중복 방지)', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api } = await loginAs(guardian);

    const total = 20;
    try {
      const results = await Promise.all(
        Array.from({ length: total }, () => api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title: '[QA-ADMIN] G26 도배', content: '같은 내용 반복' })),
      );
      const statuses = results.map(r => r.status());
      const saved = Number(psql(`SELECT count(*) FROM inquiry WHERE user_id = ${sqlStr(guardian.id)};`));
      const counts = statuses.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
      test.info().annotations.push({ type: '실측', description: `동시 ${total}건: 응답 ${JSON.stringify(counts)}, 저장된 문의 ${saved}행` });
      expect(saved, `동일 문의 ${total}건이 전부 저장됐다 (응답 ${JSON.stringify(counts)}). 계정 기준 분당 상한 또는 중복 제출 방지가 없다`).toBeLessThan(total);
    } finally {
      psql(`DELETE FROM inquiry WHERE user_id = ${sqlStr(guardian.id)};`);
    }
  });
});

test.describe('Swagger/문서와 구현 일치', () => {
  test('[ADMIN-G31] 문서(Swagger)가 말하는 대로 동작한다 (타인 문의 상태코드, 관리자 NONE 필터, 전화번호 하이픈 검색, 공지 403 표기)', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const owner = await tempUser('GUARDIAN');
    const other = await tempUser('GUARDIAN');
    const [a, o] = [await loginAs(admin), await loginAs(other)];

    // 런타임 OpenAPI 문서 (열려 있지 않으면 소스에 적힌 문구로 대신한다)
    let docs: any;
    try {
      const ctx = await request.newContext({ baseURL: env.apiUrl });
      const res = await ctx.get('/v3/api-docs');
      if (res.ok()) docs = await res.json();
      await ctx.dispose();
    } catch {
      docs = undefined;
    }
    const documented = (method: string, path: string): string[] | undefined => {
      const responses = docs?.paths?.[path]?.[method]?.responses;
      return responses ? Object.keys(responses) : undefined;
    };

    try {
      // 1) 타인 문의 상세
      const inquiryId = psql(`INSERT INTO inquiry (user_id, category, title, content, status)
                              VALUES (${sqlStr(owner.id)}, 'ETC', '[QA-ADMIN] G31', '타인 접근 확인용', 'WAITING') RETURNING id;`)
        .split('\n')[0].trim();
      const foreign = await bodyOf(await o.api.raw('GET', `/api/guardian/inquiry/${inquiryId}`));
      const docCodes = documented('get', '/api/guardian/inquiry/{id}') ?? ['404 (소스의 @ApiResponse 설명: 타인 문의 404)'];
      test.info().annotations.push({ type: '타인 문의', description: `실제 ${foreign.status}, 문서 응답코드 ${docCodes.join(',')}` });
      console.log(`[G31] 타인 문의 실제 ${foreign.status}, 문서 ${docCodes.join(',')}, api-docs ${docs ? '읽음' : '못 읽음'}`);
      expect.soft(
        docCodes.some(code => code.startsWith(String(foreign.status))),
        `타인 문의 상세는 실제로 ${foreign.status} 인데 문서에는 ${docCodes.join(',')} 만 적혀 있다 (문서와 구현 불일치)`,
      ).toBe(true);

      // 2) 관리자 계정은 연결 필터(NONE)를 걸면 목록에서 빠진다
      const noneRes = await bodyOf(await a.api.raw('GET', `/api/admin/user?connection=NONE&keyword=${encodeURIComponent(admin.email)}`));
      const noneRows = (findPage(noneRes.json.data)?.content ?? []) as { userId: string }[];
      expect.soft(noneRows.some(u => u.userId === admin.id), '문서는 "관리자는 연결 필터에서 빠진다"고 하는데 connection=NONE 결과에 ADMIN 이 있다').toBe(false);

      // 3) 전화번호는 문서 예시(010-1234-5678)처럼 하이픈을 넣어도 검색된다
      const phone = other.phone!;
      const hyphen = `${phone.slice(0, 3)}-${phone.slice(3, 7)}-${phone.slice(7)}`;
      const plainRes = await bodyOf(await a.api.raw('GET', `/api/admin/user?keyword=${encodeURIComponent(phone)}`));
      const hyphenRes = await bodyOf(await a.api.raw('GET', `/api/admin/user?keyword=${encodeURIComponent(hyphen)}`));
      const ids = (r: Body) => ((findPage(r.json.data)?.content ?? []) as { userId: string }[]).map(u => u.userId);
      expect(ids(plainRes), '준비: 숫자만 검색하면 임시 보호자가 나와야 한다').toContain(other.id);
      test.info().annotations.push({ type: '전화번호 검색', description: `숫자만 ${ids(plainRes).length}건, 하이픈 ${ids(hyphenRes).length}건` });
      expect.soft(ids(hyphenRes), `문서 예시처럼 하이픈 포함 번호(${hyphen})로 검색하면 0건이다 (저장 형식은 숫자만이라 정규화가 없음)`).toContain(other.id);

      // 4) 공지 관리자 API 문서에 403 이 있어야 한다 (다른 관리자 API 는 명시)
      const annCodes = documented('post', '/api/admin/announcement/create');
      if (annCodes) {
        expect.soft(annCodes, '관리자 공지 API 문서에 403 응답이 빠져 있다').toContain('403');
      } else {
        test.info().annotations.push({ type: '공지 403 표기', description: 'OpenAPI 문서(/v3/api-docs)를 읽지 못해 확인하지 못함' });
      }
    } finally {
      psql(`DELETE FROM inquiry WHERE user_id = ${sqlStr(owner.id)};`);
    }
  });

  test('[ADMIN-G32] 이상감지 로그/알림 이력의 흔한 한 글자 이름 검색은 200 으로 빠르게 응답한다', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const a = await loginAs(admin);

    const seen: string[] = [];
    const matched = await bodyOf(await a.api.raw('GET', `/api/admin/user?keyword=${encodeURIComponent('a')}&size=1`));
    seen.push(`이름/이메일에 a 가 들어간 회원 ${findPage(matched.json.data)?.totalElements ?? '?'}명`);

    for (const path of ['/api/admin/anomaly', '/api/admin/notification']) {
      for (const keyword of ['a', '김']) {
        const started = Date.now();
        const r = await bodyOf(await a.api.raw('GET', `${path}?keyword=${encodeURIComponent(keyword)}`));
        const ms = Date.now() - started;
        seen.push(`${path} keyword=${keyword} -> ${r.status} ${ms}ms`);
        expect.soft(r.status, `${path} keyword=${keyword} 응답 ${r.status} ${r.json.message ?? ''} (일치 회원 전부가 IN 절 바인드 파라미터가 됨)`).toBe(200);
        expect.soft(ms, `${path} keyword=${keyword} 응답이 ${ms}ms 로 느리다`).toBeLessThan(3_000);
      }
    }
    console.log(`[G32]\n${seen.join('\n')}`);
    test.info().annotations.push({ type: '실측', description: seen.join(' | ') });
  });
});
