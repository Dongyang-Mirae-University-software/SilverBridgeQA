/**
 * 최종 QA - 관리자(ADM) P2: 공지 관리
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 공지·임시저장은 이 테스트 전용 제목 접두사로 만들고 끝나면(실패해도) 지운다.
 *  - DB 행은 임시 관리자 id 로만 넣고, 감사 로그도 이 관리자 id 것만 지운다.
 *  - 실패 메시지에는 상태 코드·개수만 넣는다.
 */
import {
  auditCountOf, bodyOf, deleteAuditOf, deleteNoticeIds, deleteNoticesByPrefix, enc, expect, expectCode, getBody,
  insertNoticeRaw, noticeCount, psqlOne, settle, TAGS, test, uniq,
} from './_helpers-adm-p2';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const MISSING_ID = 9_000_000_000_001;

test('ADM-N02 공지 목록 값 보정과 제목 검색', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const prefix = `QAP2N02${tag}`;
  const contentToken = `QAP2C${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));

  // %, _, \ 는 글자 그대로 찾아야 한다: 각 글자마다 "그 글자가 든 제목"과 "와일드카드로 읽으면 걸리는 제목"을 한 쌍씩 둔다
  const abc = insertNoticeRaw(admin.id, `${prefix} AbCdEf`, '본문');
  const pct = insertNoticeRaw(admin.id, `${prefix} 50% 할인`, '본문');
  const pctDecoy = insertNoticeRaw(admin.id, `${prefix} 500 won`, '본문');
  const us = insertNoticeRaw(admin.id, `${prefix} a_b`, '본문');
  const usDecoy = insertNoticeRaw(admin.id, `${prefix} aXb`, '본문');
  const bs = insertNoticeRaw(admin.id, `${prefix} c\\d`, '본문');
  const bsDecoy = insertNoticeRaw(admin.id, `${prefix} cXd`, '본문');
  const onlyContent = insertNoticeRaw(admin.id, `${prefix} 본문전용`, `본문에만 있는 말 ${contentToken}`);
  const mine = [abc, pct, pctDecoy, us, usDecoy, bs, bsDecoy, onlyContent];

  const search = async (keyword: string) => {
    const res = await getBody(a.api, `/api/admin/announcement/select?size=50&keyword=${enc(keyword)}`);
    expect(res.status, `검색 응답 상태 ${res.status}`).toBe(200);
    return res.json.data as { content: { id: number; title: string }[]; page: number; size: number; totalElements: number };
  };
  // 한 글자 검색은 dev 의 다른 공지도 걸리므로 totalElements 를 보고 끝 쪽까지 넘겨 가며 모은다
  const searchAll = async (keyword: string) => {
    const content: { id: number; title: string }[] = [];
    for (let pageNo = 0; pageNo < 200; pageNo++) {
      const res = await getBody(a.api, `/api/admin/announcement/select?size=50&page=${pageNo}&keyword=${enc(keyword)}`);
      expect(res.status, `검색 ${pageNo}쪽 응답 상태 ${res.status}`).toBe(200);
      const data = res.json.data as { content: { id: number; title: string }[]; totalElements: number };
      content.push(...data.content);
      if (data.content.length === 0 || content.length >= data.totalElements) break;
    }
    return { content };
  };
  const idsOf = (page: { content: { id: number }[] }) => page.content.map(item => item.id).sort((x, y) => x - y);

  await test.step('값 보정: 음수 page 는 0, size 999 는 50', async () => {
    const res = await getBody(a.api, '/api/admin/announcement/select?page=-1&size=999');
    expect(res.status, `page=-1,size=999 응답 상태 ${res.status}`).toBe(200);
    expect(res.json.data.page, '음수 page 는 0 으로').toBe(0);
    expect(res.json.data.size, 'size 999 는 50 으로').toBe(50);
    expect(res.json.data.content.length, '내용은 50건 이하').toBeLessThanOrEqual(50);
    // 내 공지 8건만 걸러서 보면 한 쪽에 전부 들어온다
    const scoped = await getBody(a.api, `/api/admin/announcement/select?page=-1&size=999&keyword=${enc(prefix)}`);
    expect(scoped.json.data.page).toBe(0);
    expect(scoped.json.data.size).toBe(50);
    expect(scoped.json.data.content.map((item: { id: number }) => item.id).sort((x: number, y: number) => x - y)).toEqual([...mine].sort((x, y) => x - y));
  });

  await test.step('대문자·소문자 검색은 같은 한 건', async () => {
    expect(idsOf(await search(`${prefix} abcdef`)), '소문자 검색').toEqual([abc]);
    expect(idsOf(await search(`${prefix.toUpperCase()} ABCDEF`)), '대문자 검색').toEqual([abc]);
  });

  await test.step('제목만 검색한다(본문에만 있는 말은 안 걸림)', async () => {
    expect((await search(contentToken)).totalElements, '본문에만 있는 말').toBe(0);
    expect(idsOf(await search(`${prefix} 본문전용`)), '제목으로는 찾아진다').toEqual([onlyContent]);
  });

  await test.step('%, _, \\ 는 글자 그대로', async () => {
    expect(idsOf(await search(`${prefix} 50%`)), "'50%' 는 와일드카드가 아니라 글자").toEqual([pct]);
    expect(idsOf(await search(`${prefix} a_b`)), "'a_b' 의 _ 는 글자").toEqual([us]);
    expect(idsOf(await search(`${prefix} c\\d`)), "'c\\d' 의 \\ 는 글자").toEqual([bs]);
    // 글자 하나만 넣어도 그 글자가 든 제목만 온다(전체가 나오면 와일드카드로 읽은 것)
    for (const [char, hit, decoys] of [['%', pct, [pctDecoy, abc]], ['_', us, [usDecoy, abc]], ['\\', bs, [bsDecoy, abc]]] as const) {
      const page = await searchAll(char);
      const ids = page.content.map(item => item.id);
      expect(ids, `'${char}' 검색에 내 해당 공지가 있다`).toContain(hit);
      for (const decoy of decoys) expect(ids, `'${char}' 검색에 해당 글자가 없는 내 공지가 섞였다`).not.toContain(decoy);
      expect(page.content.filter(item => !item.title.includes(char)).length, `'${char}' 검색에 그 글자가 없는 제목이 섞였다`).toBe(0);
    }
  });
});

test('ADM-N03 탭 건수 summary', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(300_000);
  const tag = uniq();
  const prefix = `QAP2N03${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const notices: number[] = [];
  const drafts: number[] = [];
  later(() => deleteNoticeIds(notices, drafts));
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));

  const summary = async (query = '') => {
    const res = await getBody(a.api, `/api/admin/announcement/summary${query}`);
    expect(res.status, `summary 응답 상태 ${res.status}`).toBe(200);
    return res.json.data as { publishedCount: number; draftCount: number };
  };

  // 게시 2건·임시저장 3건을 더하면 건수가 정확히 +2·+3 (공용 건수라 다른 곳이 동시에 바꾸면 3번까지 다시 잰다)
  let note = '';
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const s0 = await summary();
    for (let i = 1; i <= 2; i++) {
      const res = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: `${prefix}-게시${attempt}-${i}`, content: '게시 본문' }));
      expect(res.status, `공지 생성 응답 상태 ${res.status}`).toBe(200);
      notices.push(res.json.data.id as number);
    }
    for (let i = 1; i <= 3; i++) {
      const res = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/draft/create', { title: `${prefix}-임시${attempt}-${i}`, content: '임시 본문' }));
      expect(res.status, `임시저장 생성 응답 상태 ${res.status}`).toBe(200);
      drafts.push(res.json.data.id as number);
    }
    const s1 = await summary();
    // 검색어를 붙여도 전체 건수 그대로(같은 순간의 값끼리 비교하려고 바로 이어서 잰다)
    const s2 = await summary(`?keyword=${enc(prefix)}`);
    const s3 = await summary(`?keyword=${enc(`QAP2없는말${tag}`)}`);
    note = `시도 ${attempt}: 게시 ${s1.publishedCount - s0.publishedCount}(기대 +2), 임시저장 ${s1.draftCount - s0.draftCount}(기대 +3), 검색어를 붙인 값이 같은지 ${JSON.stringify(s2) === JSON.stringify(s1) && JSON.stringify(s3) === JSON.stringify(s1)}`;
    ok =
      s1.publishedCount - s0.publishedCount === 2 &&
      s1.draftCount - s0.draftCount === 3 &&
      JSON.stringify(s2) === JSON.stringify(s1) &&
      JSON.stringify(s3) === JSON.stringify(s1);
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(ok, `summary 가 기대와 다르다. ${note}`).toBe(true);

  // 화면 '전체' 탭 = 게시 + 임시저장
  const page = await openAs(a.who, null);
  await page.goto('/admin/notices');
  await expect(page.getByRole('heading', { level: 1, name: '공지사항', exact: true })).toBeVisible();
  const tabs = page.getByRole('navigation', { name: '공지 상태 필터' });
  let match = false;
  let seen = '';
  for (let i = 0; i < 4 && !match; i++) {
    const { publishedCount, draftCount } = await summary();
    await page.reload();
    await expect(tabs).toBeVisible();
    // 숫자가 오기 전 처음 그려지는 '(0)' 을 읽지 않도록, 내 게시 공지가 있어 0 이 될 수 없는 '전체' 숫자가 채워질 때까지 기다린다
    await expect.poll(async () => (await tabs.innerText()).replace(/\s+/g, ' '), { timeout: 15_000 }).toMatch(/전체 \([1-9]\d*\)/);
    const text = (await tabs.innerText()).replace(/\s+/g, ' ');
    seen = `${text} / API 게시 ${publishedCount}, 임시저장 ${draftCount}`;
    match = text.includes(`전체 (${publishedCount + draftCount})`) && text.includes(`게시됨 (${publishedCount})`) && text.includes(`임시저장 (${draftCount})`);
  }
  expect(match, `탭 숫자가 summary 와 다르다: ${seen}`).toBe(true);
});

test('ADM-N05 조회만 해서는 수정일이 안 바뀌고 조회수는 정확히 오름', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(600_000);
  const tag = uniq();
  const prefix = `QAP2N05${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const users = [];
  for (let i = 0; i < 20; i++) users.push(await tempUser(i % 2 ? 'WARD' : 'GUARDIAN', { phone: null }));
  const sessions = [];
  for (const user of users) sessions.push(await signIn(user));

  const created = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: `${prefix} 조회수`, content: '조회수 확인용 본문' }));
  expect(created.status, `준비: 공지 생성 응답 상태 ${created.status}`).toBe(200);
  const id = created.json.data.id as number;
  later(() => deleteNoticeIds([id]));
  later(() => deleteAuditOf([admin.id]));

  const row = () => psqlOne(`SELECT view_count || '|' || updated_at::text FROM announcement WHERE id = ${id};`).split('|');
  const [viewsBefore, updatedBefore] = row();
  const adminBefore = (await getBody(a.api, `/api/admin/announcement/select/detail/${id}`)).json.data;
  expect(Number(viewsBefore), '준비: 처음 조회수').toBe(0);
  // 관리자가 상세를 열어 봐도 조회수는 안 오른다
  expect(row()[0], '관리자 조회로는 조회수가 오르지 않는다').toBe(viewsBefore);

  // 사용자 20명이 동시에 상세를 본다
  const results = await Promise.all(sessions.map(s => s.api.raw('GET', `/api/commonness/announcement/select/detail/${id}`)));
  expect(results.map(r => r.status()), '20명의 상세 조회 응답 상태').toEqual(Array(20).fill(200));

  const [viewsAfter, updatedAfter] = row();
  expect(Number(viewsAfter) - Number(viewsBefore), '조회수는 정확히 +20 (빠짐 없음)').toBe(20);
  expect(updatedAfter, '조회만 했으므로 수정 일시(updated_at)는 그대로').toBe(updatedBefore);
  const adminAfter = (await getBody(a.api, `/api/admin/announcement/select/detail/${id}`)).json.data;
  expect(adminAfter.updatedAt, '관리자 화면의 수정 일시도 그대로(수정됨 표시가 생기지 않는다)').toBe(adminBefore.updatedAt);
  expect(adminAfter.viewCount, '관리자 상세의 조회수').toBe(20);
});

test('ADM-A04 검색어 50자 초과', TAGS, async ({ tempUser, signIn, later }) => {
  const tag = uniq();
  const prefix = `QAP2A04${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));

  // 정확히 50자 제목의 공지: 50자 검색은 찾아지고, 끝에 한 글자를 더한 51자 검색은 잘라서 찾지 않고 거절한다
  const title50 = (prefix + 'a'.repeat(50)).slice(0, 50);
  expect(Array.from(title50).length, '준비: 제목 50자').toBe(50);
  const id = insertNoticeRaw(admin.id, title50, '본문');

  const ok = await getBody(a.api, `/api/admin/announcement/select?keyword=${enc(title50)}`);
  expect(ok.status, `50자 검색 응답 상태 ${ok.status}`).toBe(200);
  expect(ok.json.data.content.map((item: { id: number }) => item.id), '50자는 그대로 찾는다').toEqual([id]);

  for (const [label, keyword] of [
    ['51자(앞 50자는 실제 제목)', `${title50}x`],
    ['한글 51자', '가'.repeat(51)],
  ] as const) {
    const res = await getBody(a.api, `/api/admin/announcement/select?keyword=${enc(keyword)}`);
    expectCode(res, 400, 'INVALID_INPUT', `공지 목록 ${label}`);
    expect(res.json.data ?? null, `${label}: 잘라서 찾은 결과가 실려 오면 안 된다`).toBeNull();
    const draft = await getBody(a.api, `/api/admin/announcement/draft/select?keyword=${enc(keyword)}`);
    expectCode(draft, 400, 'INVALID_INPUT', `임시저장 목록 ${label}`);
  }
});

test('ADM-A05 없는 공지·이미 삭제된 공지', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const prefix = `QAP2A05${tag}`;
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const a = await signIn(admin);
  const g = await signIn(guardian);
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));
  expect(psqlOne(`SELECT count(*) FROM announcement WHERE id = ${MISSING_ID};`), '준비: 없는 id').toBe('0');

  const body = { title: `${prefix} 수정`, content: '수정 본문' };
  const probe = async (id: number, label: string) => {
    expectCode(await getBody(a.api, `/api/admin/announcement/select/detail/${id}`), 404, 'ANNOUNCEMENT_NOT_FOUND', `${label} 관리자 상세`);
    expectCode(await bodyOf(await a.api.raw('PUT', `/api/admin/announcement/update/${id}`, body)), 404, 'ANNOUNCEMENT_NOT_FOUND', `${label} 수정`);
    expectCode(await bodyOf(await a.api.raw('DELETE', `/api/admin/announcement/delete/${id}`)), 404, 'ANNOUNCEMENT_NOT_FOUND', `${label} 삭제`);
    expectCode(await getBody(g.api, `/api/commonness/announcement/select/detail/${id}`), 404, 'ANNOUNCEMENT_NOT_FOUND', `${label} 사용자 상세`);
  };

  await probe(MISSING_ID, '없는 id');
  expect(await auditCountOf(admin.id, 'ANNOUNCEMENT_DELETE'), '없는 id 삭제 시도는 감사 로그를 남기지 않는다').toBe(0);

  // 만들고 지운 공지: 한 번 지우면 200, 이후에는 전부 404
  const created = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: `${prefix} 삭제될 공지`, content: '본문' }));
  expect(created.status, `준비: 공지 생성 응답 상태 ${created.status}`).toBe(200);
  const id = created.json.data.id as number;
  const del = await bodyOf(await a.api.raw('DELETE', `/api/admin/announcement/delete/${id}`));
  expect(del.status, `첫 삭제 응답 상태 ${del.status}`).toBe(200);
  expect(noticeCount(prefix), '지운 공지가 DB 에 남았다').toBe(0);

  await probe(id, '삭제한 id');
  // 두 번째 이후 삭제는 감사 로그를 더 남기지 않는다: 작성 1건 + 삭제 1건뿐
  const audit = await settle(
    () => psqlOne(`SELECT count(*) FROM admin_audit_log WHERE admin_id = '${admin.id}';`),
    count => Number(count) >= 2,
    15_000,
  );
  expect(Number(audit), '감사 로그 행 수(작성 1 + 삭제 1)').toBe(2);
  expect(await auditCountOf(admin.id, 'ANNOUNCEMENT_DELETE'), '삭제 감사 로그는 정확히 1건').toBe(1);
});

test('ADM-A06 같은 임시저장 공지를 동시에 게시', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const prefix = `QAP2A06${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const drafts: number[] = [];
  later(() => deleteNoticeIds([], drafts));
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));

  // 한 번에 겹칠 확률을 높이려고 임시저장 6건에 각각 게시 요청 2개씩, 12개를 한꺼번에 보낸다
  const COUNT = 6;
  for (let i = 1; i <= COUNT; i++) {
    const res = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/draft/create', { title: `${prefix}-${i}`, content: '동시 게시 본문' }));
    expect(res.status, `준비: 임시저장 생성 응답 상태 ${res.status}`).toBe(200);
    drafts.push(res.json.data.id as number);
  }
  const perDraft = await Promise.all(
    drafts.map(async id => {
      const codes = await Promise.all(
        [0, 1].map(async () => {
          const r = await bodyOf(await a.api.raw('POST', `/api/admin/announcement/draft/publish/${id}`));
          return { status: r.status, code: (r.json?.code ?? '') as string };
        }),
      );
      return { id, codes };
    }),
  );
  const results = perDraft.flatMap(p => p.codes.map(c => c.status));
  const statuses = results.reduce<Record<string, number>>((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
  test.info().annotations.push({
    type: '실측',
    description: `게시 요청 ${results.length}개의 응답 상태 분포 ${JSON.stringify(statuses)}. 문서는 '두 번 생길 수 있음(보류)' 이지만 기대값은 임시저장 1건당 공지 1건이다.`,
  });

  // 임시저장마다 200 한 번 + 404(ANNOUNCEMENT_DRAFT_NOT_FOUND) 한 번이어야 한다. 500(삭제 충돌)·200 두 번은 실패
  for (const p of perDraft) {
    const view = p.codes.map(c => `${c.status}${c.code ? ':' + c.code : ''}`).sort();
    expect(view, `임시저장 ${p.id} 동시 게시 응답(200 1개 + 404 ANNOUNCEMENT_DRAFT_NOT_FOUND 1개 기대). 전체 분포 ${JSON.stringify(statuses)}`).toEqual(['200', '404:ANNOUNCEMENT_DRAFT_NOT_FOUND']);
  }
  expect(noticeCount(prefix), `임시저장 ${COUNT}건에 게시를 동시에 두 번씩 보냈는데 공지가 그 수와 다르다(중복 게시). 상태 분포 ${JSON.stringify(statuses)}`).toBe(COUNT);
  // 게시된 임시저장은 더는 남지 않는다
  for (const id of drafts) {
    expectCode(await getBody(a.api, `/api/admin/announcement/draft/select/detail/${id}`), 404, 'ANNOUNCEMENT_DRAFT_NOT_FOUND', '게시한 임시저장 상세');
  }
});
