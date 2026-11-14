/**
 * 최종 QA - 관리자(ADM) P1a: 공지 관리 · 공지 조회(사용자)
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 공지는 이 테스트 전용 제목 접두사로 만들고, 끝나면(실패해도) 접두사·id 로 지운다.
 *  - 공지 행은 임시 관리자 id 로만 넣고(DB 직접 삽입), 감사 로그도 이 관리자 id 것만 지운다.
 *  - 실패 메시지에는 상태 코드·개수만 넣는다.
 */
import { sqlStr } from '../../../src/remote';
import { deleteTempUser } from '../../../src/seed';
import {
  allKeys, auditCountOf, bodyOf, codePoints, deleteAuditOf, deleteNoticeIds, deleteNoticesByPrefix, expect, expectError,
  insertNotices, isNewestFirst, NOTICE_CONTENT, NOTICE_PREVIEW, noticeCount, psqlOne, settle, TAGS, test, uniq,
} from './_helpers-adm-p1a';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const enc = encodeURIComponent;

// ─────────────────────────────────────────────────────────────────────────────
// 공지 관리(관리자)
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A03 공지 작성 입력 검증', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const prefix = `QA공지검증P1a${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const ids: number[] = [];
  later(() => deleteNoticeIds(ids));
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));

  const okTitle = `${prefix}-정상`;
  const bads: Array<[string, string]> = [
    ['빈 값', ''],
    ['공백만', '   '],
    ['보이지 않는 글자만', '​​⁠'],
    ['NUL 문자', '\u0000'],
  ];
  // 1) 작성(POST): 제목·본문 각각 나쁜 값 -> 400 (500 아님), 저장·감사 로그 없음
  for (const [label, bad] of bads) {
    const t = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: bad, content: '본문' }));
    expect(t.status, `제목 ${label}: 응답 상태 ${t.status}`).toBe(400);
    const c = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: okTitle, content: bad }));
    expect(c.status, `본문 ${label}: 응답 상태 ${c.status}`).toBe(400);
  }
  const longTitle = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: 'a'.repeat(201), content: '본문' }));
  expect(longTitle.status, `제목 201자 응답 상태 ${longTitle.status}`).toBe(400);
  const longContent = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: okTitle, content: 'a'.repeat(5001) }));
  expect(longContent.status, `본문 5001자 응답 상태 ${longContent.status}`).toBe(400);
  expect(Number(psqlOne(`SELECT count(*) FROM announcement WHERE author_id = ${sqlStr(admin.id)};`)), '거부된 요청인데 공지가 저장됐다').toBe(0);
  expect(auditCountOf(admin.id, 'ANNOUNCEMENT_CREATE'), '거부된 요청인데 감사 로그가 남았다').toBe(0);

  // 2) 수정(PUT): 먼저 정상 공지 1건(경계값: 제목 200자·본문 5000자)을 만들고 나쁜 값으로 고쳐 본다
  const edgeTitle = prefix + '-' + 'ㄱ'.repeat(200 - prefix.length - 1);
  const created = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: edgeTitle, content: 'a'.repeat(5000) }));
  expect(created.status, `경계값(제목 200자·본문 5000자) 작성 응답 상태 ${created.status}`).toBe(200);
  const id = created.json.data.id as number;
  ids.push(id);
  const baseline = auditCountOf(admin.id, 'ANNOUNCEMENT_UPDATE');
  for (const [label, bad] of bads) {
    const t = await bodyOf(await a.api.raw('PUT', `/api/admin/announcement/update/${id}`, { title: bad, content: '본문' }));
    expect(t.status, `수정 제목 ${label}: 응답 상태 ${t.status}`).toBe(400);
    const c = await bodyOf(await a.api.raw('PUT', `/api/admin/announcement/update/${id}`, { title: okTitle, content: bad }));
    expect(c.status, `수정 본문 ${label}: 응답 상태 ${c.status}`).toBe(400);
  }
  const lt = await bodyOf(await a.api.raw('PUT', `/api/admin/announcement/update/${id}`, { title: 'a'.repeat(201), content: '본문' }));
  expect(lt.status, `수정 제목 201자 응답 상태 ${lt.status}`).toBe(400);
  const lc = await bodyOf(await a.api.raw('PUT', `/api/admin/announcement/update/${id}`, { title: okTitle, content: 'a'.repeat(5001) }));
  expect(lc.status, `수정 본문 5001자 응답 상태 ${lc.status}`).toBe(400);
  expect(auditCountOf(admin.id, 'ANNOUNCEMENT_UPDATE'), '거부된 수정인데 감사 로그가 남았다').toBe(baseline);
  const detail = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/select/detail/${id}`));
  expect(detail.status).toBe(200);
  expect(detail.json.data.title, '거부된 수정인데 제목이 바뀌었다').toBe(edgeTitle);
  expect(codePoints(detail.json.data.content), '거부된 수정인데 본문이 바뀌었다').toBe(5000);
});

test('ADM-N01 관리자 공지 목록: 기본 쪽 나누기와 최신순', TAGS, async ({ tempUser, signIn, later }) => {
  const tag = uniq();
  const prefix = `QA공지목록P1a${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));
  insertNotices(admin.id, prefix, 25);
  expect(noticeCount(prefix), '준비: 공지 25건').toBe(25);

  // 기본 호출: 모양·기본 크기·정렬
  const def = await bodyOf(await a.api.raw('GET', '/api/admin/announcement/select'));
  expect(def.status, `기본 목록 응답 상태 ${def.status}`).toBe(200);
  const page = def.json.data;
  expect(Object.keys(page).sort(), 'PageResponse 칸').toEqual(['content', 'last', 'page', 'size', 'totalElements', 'totalPages']);
  expect(page.page, '기본 page').toBe(0);
  expect(page.size, '기본 size').toBe(20);
  expect(page.content.length, '기본 한 쪽 개수').toBe(20);
  expect(page.totalElements, '전체 건수(내 25건 이상)').toBeGreaterThanOrEqual(25);
  expect(page.last, '25건 이상이면 첫 쪽은 마지막 쪽이 아니다').toBe(false);
  expect(isNewestFirst(page.content), '작성일시 내림차순(같으면 id 내림차순)').toBe(true);
  for (const item of page.content) expect(codePoints(item.content ?? ''), '목록 본문은 앞 100자까지').toBeLessThanOrEqual(100);

  // 내 25건만 검색해서 쪽 나누기·정렬·본문 축약을 정확히 본다
  const first = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/select?keyword=${enc(prefix)}`));
  expect(first.status).toBe(200);
  expect(first.json.data.totalElements).toBe(25);
  expect(first.json.data.totalPages).toBe(2);
  expect(first.json.data.content.map((item: { title: string }) => item.title), '1쪽은 가장 새 20건 순서대로').toEqual(
    Array.from({ length: 20 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
  );
  expect(first.json.data.content[0].content, '본문은 앞 100자').toBe(NOTICE_PREVIEW);
  expect(first.json.data.last).toBe(false);
  const second = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/select?keyword=${enc(prefix)}&page=1`));
  expect(second.json.data.content.map((item: { title: string }) => item.title), '2쪽은 나머지 5건').toEqual(
    Array.from({ length: 5 }, (_, i) => `${prefix}-${String(i + 21).padStart(2, '0')}`),
  );
  expect(second.json.data.last).toBe(true);
  const detail = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/select/detail/${first.json.data.content[0].id}`));
  expect(detail.json.data.content, '상세는 본문 전문').toBe(NOTICE_CONTENT);
});

test('ADM-N04 공지 작성·수정·삭제와 감사 로그', TAGS, async ({ tempUser, signIn, later }) => {
  const tag = uniq();
  const prefix = `QA공지CRUDP1a${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const ids: number[] = [];
  later(() => deleteNoticeIds(ids));
  later(() => deleteAuditOf([admin.id]));

  const created = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: `${prefix}-작성`, content: '처음 본문' }));
  expect(created.status, `작성 응답 상태 ${created.status}`).toBe(200);
  const id = created.json.data.id as number;
  ids.push(id);
  // 작성 즉시 게시: 사용자 목록·상세에 보인다
  const visible = await settle(
    async () => bodyOf(await a.api.raw('GET', `/api/commonness/announcement/select?size=50`)),
    r => (r.json.data ?? []).some((item: { id: number }) => item.id === id),
    15_000,
  );
  expect((visible.json.data ?? []).some((item: { id: number }) => item.id === id), '작성 직후 사용자 목록에 보여야 한다').toBe(true);

  const before = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/select/detail/${id}`));
  await new Promise(resolve => setTimeout(resolve, 1_100)); // 수정 시각이 작성 시각과 구분되려면 1초는 지나야 한다
  const updated = await bodyOf(await a.api.raw('PUT', `/api/admin/announcement/update/${id}`, { title: `${prefix}-수정`, content: '고친 본문' }));
  expect(updated.status, `수정 응답 상태 ${updated.status}`).toBe(200);
  expect(updated.json.data.title).toBe(`${prefix}-수정`);
  expect(updated.json.data.content).toBe('고친 본문');
  const after = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/select/detail/${id}`));
  expect(new Date(after.json.data.updatedAt).getTime(), '제목·내용이 바뀌면 updated_at 이 갱신된다').toBeGreaterThan(new Date(before.json.data.updatedAt).getTime());

  const del = await bodyOf(await a.api.raw('DELETE', `/api/admin/announcement/delete/${id}`));
  expect(del.status, `삭제 응답 상태 ${del.status}`).toBe(200);
  const gone = await bodyOf(await a.api.raw('GET', `/api/commonness/announcement/select/detail/${id}`));
  expectError(gone, 404, 'ANNOUNCEMENT_NOT_FOUND', '삭제된 공지 상세');
  const list = await bodyOf(await a.api.raw('GET', `/api/commonness/announcement/select?size=50`));
  expect((list.json.data ?? []).some((item: { id: number }) => item.id === id), '삭제 뒤 목록에서 사라져야 한다').toBe(false);

  // 세 작업 모두 감사 로그(대상 id 포함)
  for (const action of ['ANNOUNCEMENT_CREATE', 'ANNOUNCEMENT_UPDATE', 'ANNOUNCEMENT_DELETE']) {
    expect(
      Number(psqlOne(`SELECT count(*) FROM admin_audit_log WHERE admin_id = ${sqlStr(admin.id)} AND action = ${sqlStr(action)} AND target_id = ${sqlStr(String(id))};`)),
      `${action} 감사 로그`,
    ).toBe(1);
  }
});

test('ADM-N06 임시저장 작성 후 게시', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const prefix = `QA임시저장P1a${tag}`;
  const adminA = await tempUser('ADMIN');
  const adminB = await tempUser('ADMIN');
  const a = await signIn(adminA);
  const b = await signIn(adminB);
  const notices: number[] = [];
  const drafts: number[] = [];
  later(() => deleteNoticeIds(notices, drafts));
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([adminA.id, adminB.id]));

  const summary = async () => {
    const res = await bodyOf(await a.api.raw('GET', '/api/admin/announcement/summary'));
    expect(res.status).toBe(200);
    return res.json.data as { publishedCount: number; draftCount: number };
  };

  // 목록 항목에 viewCount 없음 + 게시하면 임시저장 -1, 게시 +1 (공용 건수라 다른 곳이 동시에 바꾸면 처음부터 3번까지 다시 잰다)
  let note = '';
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    const title = `${prefix}-시도${attempt}`;
    const draft = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/draft/create', { title, content: '임시 본문' }));
    expect(draft.status, `임시저장 생성 응답 상태 ${draft.status}`).toBe(200);
    const draftId = draft.json.data.id as number;
    drafts.push(draftId);

    const list = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/draft/select?keyword=${enc(title)}`));
    expect(list.status).toBe(200);
    expect(list.json.data.content, '내 임시저장 1건').toHaveLength(1);
    expect([...allKeys(list.json.data.content[0])], '임시저장 목록 항목에 viewCount 가 있다').not.toContain('viewCount');
    expect(list.json.data.content[0].authorName, '작성자 이름').toBe(adminA.name);

    const s0 = await summary();
    const published = await bodyOf(await a.api.raw('POST', `/api/admin/announcement/draft/publish/${draftId}`));
    expect(published.status, `게시 응답 상태 ${published.status}`).toBe(200);
    notices.push(published.json.data.id as number);
    const s1 = await summary();
    note = `시도 ${attempt}: 임시저장 ${s1.draftCount - s0.draftCount}(기대 -1), 게시 ${s1.publishedCount - s0.publishedCount}(기대 +1)`;
    ok = s1.draftCount - s0.draftCount === -1 && s1.publishedCount - s0.publishedCount === 1;
    const gone = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/draft/select/detail/${draftId}`));
    expectError(gone, 404, 'ANNOUNCEMENT_DRAFT_NOT_FOUND', '게시한 임시저장 상세');
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(ok, `게시 뒤 건수가 기대와 다르다. ${note}`).toBe(true);

  // 탈퇴한 작성자의 임시저장: authorName·authorId 는 null
  const orphan = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/draft/create', { title: `${prefix}-탈퇴`, content: '탈퇴 작성자 본문' }));
  expect(orphan.status).toBe(200);
  drafts.push(orphan.json.data.id as number);
  deleteTempUser(adminA.id); // 이 시험이 만든 임시 관리자 본인 행
  const seen = await bodyOf(await b.api.raw('GET', `/api/admin/announcement/draft/select?keyword=${enc(prefix + '-탈퇴')}`));
  expect(seen.status, `다른 관리자의 목록 응답 상태 ${seen.status}`).toBe(200);
  expect(seen.json.data.content, '탈퇴 작성자의 임시저장 1건').toHaveLength(1);
  expect(seen.json.data.content[0].authorId, '탈퇴한 작성자 authorId').toBeNull();
  expect(seen.json.data.content[0].authorName, '탈퇴한 작성자 authorName').toBeNull();
});

test('ADM-N07 관리자 공지 화면: 탭·검색·페이지 번호', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const prefix = `QA공지화면P1a${tag}`;
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  const created: number[] = [];
  later(() => deleteNoticeIds(created));
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));
  insertNotices(admin.id, prefix, 12);

  const page = await openAs(a.who, null);
  await page.goto('/admin/notices');
  await expect(page.getByRole('heading', { level: 1, name: '공지사항', exact: true })).toBeVisible();

  // 탭 숫자 = summary (공용 건수라 두 번 재서 맞는 쪽을 본다)
  const tabs = page.getByRole('navigation', { name: '공지 상태 필터' });
  let match = false;
  let seen = '';
  for (let i = 0; i < 4 && !match; i++) {
    const res = await bodyOf(await a.api.raw('GET', '/api/admin/announcement/summary'));
    const { publishedCount, draftCount } = res.json.data as { publishedCount: number; draftCount: number };
    await page.reload();
    await expect(tabs).toBeVisible();
    // 숫자가 오기 전 처음 그려지는 '(0)' 을 읽지 않도록, 내 공지 12건이 있어 0 이 될 수 없는 '전체' 숫자가 바뀔 때까지 기다린다
    await expect.poll(async () => (await tabs.innerText()).replace(/\s+/g, ' '), { timeout: 15_000 }).toMatch(/전체 \([1-9]\d*\)/);
    const text = (await tabs.innerText()).replace(/\s+/g, ' ');
    seen = `${text} / API 게시 ${publishedCount}, 임시저장 ${draftCount}`;
    match = text.includes(`전체 (${publishedCount + draftCount})`) && text.includes(`게시됨 (${publishedCount})`) && text.includes(`임시저장 (${draftCount})`);
  }
  expect(match, `탭 숫자가 summary 와 다르다: ${seen}`).toBe(true);

  // 검색 + 2쪽 이동 (한 쪽 10건, 내 12건)
  const search = page.getByPlaceholder('공지 제목 검색');
  await search.fill(prefix);
  await expect(page.getByText('1–10 / 전체 12건')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(10);
  await page.getByRole('button', { name: '2', exact: true }).click();
  await expect(page.getByText('11–12 / 전체 12건')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(2);

  // 작성: 새 공지 -> 목록 즉시 갱신
  const newTitle = `${prefix}-화면작성`;
  await page.getByRole('button', { name: '공지 작성' }).click();
  await page.getByLabel('제목').fill(newTitle);
  await page.getByLabel('내용').fill('화면에서 작성한 본문');
  await page.getByRole('button', { name: '게시', exact: true }).click();
  await search.fill(newTitle);
  const row = page.locator('tbody tr', { hasText: newTitle });
  await expect(row, '작성 뒤 목록에 바로 보여야 한다').toHaveCount(1);
  const row0 = await bodyOf(await a.api.raw('GET', `/api/admin/announcement/select?keyword=${enc(newTitle)}`));
  created.push(...(row0.json.data.content as { id: number }[]).map(item => item.id));

  // 수정
  const editedTitle = `${prefix}-화면수정`;
  await row.getByRole('button', { name: '수정' }).click();
  await page.getByLabel('제목').fill(editedTitle);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await search.fill(editedTitle);
  await expect(page.locator('tbody tr', { hasText: editedTitle }), '수정 뒤 목록에 바로 보여야 한다').toHaveCount(1);
  await search.fill(newTitle);
  await expect(page.locator('tbody tr', { hasText: newTitle })).toHaveCount(0);

  // 삭제 (확인창 수락)
  await search.fill(editedTitle);
  page.once('dialog', dialog => void dialog.accept());
  await page.locator('tbody tr', { hasText: editedTitle }).getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('tbody tr', { hasText: editedTitle }), '삭제 뒤 목록에서 바로 사라져야 한다').toHaveCount(0);
  expect(noticeCount(editedTitle), '삭제된 공지가 DB 에 남았다').toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// 공지 조회(사용자)
// ─────────────────────────────────────────────────────────────────────────────

test('ADM-A07 공지 목록 값 상한(size 50, 음수 page)', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const prefix = `QA공지상한P1a${tag}`;
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const g = await signIn(guardian);
  const a = await signIn(admin);
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));
  // 50 상한을 보려면 전체가 51건 이상이어야 한다: 모자란 만큼만 내 공지를 채운다(최대 55)
  const summary = await bodyOf(await a.api.raw('GET', '/api/admin/announcement/summary'));
  const missing = Math.min(55, Math.max(0, 52 - (summary.json.data.publishedCount as number)));
  insertNotices(admin.id, prefix, Math.max(missing, 3));

  const big = await bodyOf(await g.api.raw('GET', '/api/commonness/announcement/select?size=1000&page=-5'));
  expect(big.status, `size=1000, page=-5 응답 상태 ${big.status}`).toBe(200);
  expect(Array.isArray(big.json.data), '목록은 배열 그대로').toBe(true);
  expect(big.json.data.length, 'size 1000 은 50 으로 보정').toBe(50);
  const def = await bodyOf(await g.api.raw('GET', '/api/commonness/announcement/select'));
  expect(big.json.data[0].id, '음수 page 는 0 쪽(기본 호출의 첫 항목과 같다)').toBe(def.json.data[0].id);
});

test('ADM-A07 일반 사용자 공지 목록에 작성자 이름·ID 노출 금지', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const prefix = `QA공지작성자P1a${tag}`;
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const g = await signIn(guardian);
  later(() => deleteNoticesByPrefix(prefix));
  insertNotices(admin.id, prefix, 3); // 가장 새 공지라 size=50 첫 쪽에 들어온다

  // 작성자 이름·ID 노출: 일반 사용자 응답에 관리자 이름·ID 가 없어야 한다(문서: 현재 보류 = 노출됨)
  const big = await bodyOf(await g.api.raw('GET', '/api/commonness/announcement/select?size=50'));
  expect(big.status, `size=50 응답 상태 ${big.status}`).toBe(200);
  const mine = (big.json.data as { title: string }[]).filter(item => item.title.startsWith(prefix));
  expect(mine.length, '준비: 내 공지가 응답에 포함').toBeGreaterThan(0);
  test.info().annotations.push({ type: '보류 항목(ADMIN-G30)', description: '일반 사용자 응답의 authorName 에 관리자 이름이 그대로 실린다는 알려진 문제. 기대(노출 금지)로 단언하므로 노출되면 실패한다.' });
  expect.soft(JSON.stringify(big.json.data).includes(admin.name), '일반 사용자 공지 목록에 관리자 이름이 보인다').toBe(false);
  expect.soft(JSON.stringify(big.json.data).includes(admin.id), '일반 사용자 공지 목록에 관리자 ID 가 보인다').toBe(false);
});

test('ADM-N08 사용자 공지 목록·상세', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const prefix = `QA공지조회P1a${tag}`;
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { phone: null });
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const a = await signIn(admin);
  const w = await signIn(ward);
  const g = await signIn(guardian);
  later(() => deleteNoticesByPrefix(prefix));
  later(() => deleteAuditOf([admin.id]));
  insertNotices(admin.id, prefix, 25);

  for (const [role, who] of [['WARD', w], ['GUARDIAN', g], ['ADMIN', a]] as const) {
    const list = await bodyOf(await who.api.raw('GET', '/api/commonness/announcement/select'));
    expect(list.status, `${role} 목록 응답 상태 ${list.status}`).toBe(200);
    expect(Array.isArray(list.json.data), `${role}: 목록은 배열 그대로(페이지 정보 없음)`).toBe(true);
    expect(list.json.data.length, `${role}: 기본 size 20`).toBe(20);
    expect(isNewestFirst(list.json.data), `${role}: 최신순`).toBe(true);
    for (const item of list.json.data) expect(codePoints(item.content ?? ''), `${role}: 본문 앞 100자`).toBeLessThanOrEqual(100);
    const sized = await bodyOf(await who.api.raw('GET', '/api/commonness/announcement/select?size=25'));
    expect(sized.json.data.length, `${role}: size=25`).toBe(25);

    const first = (list.json.data as { id: number; title: string; content: string }[]).find(item => item.title.startsWith(prefix));
    expect(first, `${role}: 목록에 내 공지가 있다`).toBeTruthy();
    expect(first!.content, `${role}: 목록 본문은 앞 100자`).toBe(NOTICE_PREVIEW);
    const detail = await bodyOf(await who.api.raw('GET', `/api/commonness/announcement/select/detail/${first!.id}`));
    expect(detail.status, `${role} 상세 응답 상태 ${detail.status}`).toBe(200);
    expect(detail.json.data.content, `${role}: 상세는 전문`).toBe(NOTICE_CONTENT);
  }
});

test('ADM-N09 공지가 여러 건이면 이전 공지도 화면에서 볼 수 있음', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const prefix = `QA공지이전P1a${tag}`;
  const admin = await tempUser('ADMIN');
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null });
  const g = await signIn(guardian);
  const w = await signIn(ward);
  later(() => deleteNoticesByPrefix(prefix));
  insertNotices(admin.id, prefix, 25);
  const title = (n: number) => `${prefix}-${String(n).padStart(2, '0')}`;
  const card = (page: import('@playwright/test').Page, n: number) => page.getByRole('heading', { level: 2, name: title(n), exact: true });

  for (const [label, who, path] of [['보호자', g.who, '/guardian/notices'], ['피보호자', w.who, '/ward/notices']] as const) {
    const page = await openAs(who, path);
    await expect(card(page, 1), `${label}: 가장 새 공지`).toBeVisible();
    await expect(card(page, 20), `${label}: 첫 쪽의 20번째 공지`).toBeVisible();
    await expect(card(page, 25), `${label}: 첫 쪽에는 21번째 이후 공지가 없다`).toHaveCount(0);
    await page.getByRole('button', { name: '더 보기' }).click();
    await expect(card(page, 25), `${label}: 더 보기 뒤 이전 공지(25번째)가 보여야 한다`).toBeVisible();
  }

  // 상세: 전문이 보이고, 열면 조회수가 오른다
  const page = await openAs(g.who, '/guardian/notices');
  await card(page, 1).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(NOTICE_CONTENT), '상세에 본문 전문').toBeVisible();
  await expect
    .poll(() => Number(psqlOne(`SELECT view_count FROM announcement WHERE title = ${sqlStr(title(1))};`)), { timeout: 15_000, message: '상세를 열면 조회수 +1' })
    .toBe(1);
  test.info().annotations.push({ type: '문서와 코드 차이', description: '문서는 상세에서 조회수가 보인다고 적었지만(ADMIN-G11 남음) 사용자 공지 상세 창은 제목·날짜·본문만 그린다. 조회수 표시를 기대로 단언한다.' });
  expect.soft(await dialog.innerText(), '상세에 조회수가 보여야 한다').toMatch(/조회/);
});
