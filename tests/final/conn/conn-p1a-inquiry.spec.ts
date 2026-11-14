/**
 * 최종 QA - 문의하기(CONN) P1a: A55 A58 N40 N41.
 *
 * 임시 보호자·임시 관리자만 쓴다. 문의 행은 작성자(임시 보호자)가 지워질 때 함께 지워지고,
 * 관리자 답변이 남기는 감사 로그(admin_audit_log)는 끝에 임시 관리자 id 로 지운다.
 * 임시 사용자는 푸시 토큰·전화번호가 없어 실제 발송은 나가지 않는다.
 */
import { APIResponse } from '@playwright/test';

import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { read } from './_helpers-conn';
import { captureFrames, cleanAdminAudit, notifCount, notifRows, rawCall, TAGS } from './_helpers-conn-p1a';

type Api = { raw: (m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string, d?: unknown) => Promise<APIResponse> };

interface InquiryItem {
  id: number;
  category: string;
  title: string;
  content: string;
  status: string;
  answer: string | null;
  answeredAt: string | null;
  createdAt: string;
}

interface AdminList {
  totalCount: number;
  waitingCount: number;
  answeredCount: number;
  inquiries: {
    content: { id: number; category: string; title: string; authorId: string; authorName: string | null; status: string; createdAt: string }[];
    page: number;
    size: number;
    totalElements: number;
    totalPages: number;
    last: boolean;
  };
}

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

async function createInquiry(api: Api, body: Record<string, unknown>) {
  const r = await read(await api.raw('POST', '/api/guardian/inquiry', body));
  return r;
}

async function adminList(api: Api, query: string): Promise<AdminList> {
  const r = await read(await api.raw('GET', `/api/admin/inquiry${query}`));
  expect(r.status, `관리자 문의 목록 ${query}`).toBe(200);
  return r.body.data as AdminList;
}

test.describe('CONN 문의 P1a', () => {
  test('CONN-A55 문의 입력 검증과 스크립트 글', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const guardian = await tempUser('GUARDIAN');
    const admin = await tempUser('ADMIN');
    const g = await loginAs(guardian);
    const a = await loginAs(admin);
    const countRows = () => Number(psql(`SELECT count(*) FROM inquiry WHERE user_id = ${sqlStr(guardian.id)};`));
    const ok = { category: 'ETC', title: '[QA-P1a] 제목', content: '내용입니다' };

    try {
      await test.step('잘못된 입력은 모두 400(500 아님)이고 저장되지 않는다', async () => {
        const invalid: { label: string; body: Record<string, unknown> }[] = [
          { label: '제목 빈 값', body: { ...ok, title: '' } },
          { label: '제목 공백만', body: { ...ok, title: '   ' } },
          { label: '제목 NBSP 만', body: { ...ok, title: '  ' } },
          { label: '제목 제로폭 공백만', body: { ...ok, title: '​​' } },
          { label: '제목 NUL 문자', body: { ...ok, title: 'a\u0000b' } },
          { label: '제목 줄바꿈', body: { ...ok, title: 'a\nb' } },
          { label: '제목 101자', body: { ...ok, title: '가'.repeat(101) } },
          { label: '제목 없음', body: { category: 'ETC', content: '내용' } },
          { label: '내용 빈 값', body: { ...ok, content: '' } },
          { label: '내용 공백만', body: { ...ok, content: '   ' } },
          { label: '내용 제로폭 공백만', body: { ...ok, content: '​​' } },
          { label: '내용 NBSP 만', body: { ...ok, content: '  ' } },
          { label: '내용 NUL 문자', body: { ...ok, content: 'a\u0000b' } },
          { label: '내용 2001자', body: { ...ok, content: '가'.repeat(2001) } },
          { label: '내용 없음', body: { category: 'ETC', title: '제목' } },
          { label: '분류 허용 외', body: { ...ok, category: 'BOGUS' } },
          { label: '분류 빈 값', body: { ...ok, category: '' } },
          { label: '분류 없음', body: { title: '제목', content: '내용' } },
          { label: '본문 전부 없음', body: {} },
        ];
        let accepted = 0;
        for (const item of invalid) {
          const r = await createInquiry(g.api, item.body);
          // 하나가 어긋나도 나머지를 끝까지 본다(soft)
          expect.soft(r.status, `${item.label}: 400 이어야 하는데 ${r.status} (배포 코드 InquiryCreateRequest 의 내용 칸에는 제목과 달리 보이는 글자 검사가 없다)`).toBe(400);
          if (r.status === 200) accepted++;
          else expect.soft(r.body.success, `${item.label}: success`).toBe(false);
        }
        expect(countRows(), '거부된 입력은 저장되지 않는다(200 으로 받아들여진 것만 저장)').toBe(accepted);
      });

      await test.step('경계값: 제목 100자·내용 2000자는 허용, 줄바꿈 있는 내용도 허용, 제목 앞뒤 공백은 정리', async () => {
        const max = await createInquiry(g.api, { category: 'SERVICE', title: '가'.repeat(100), content: '나'.repeat(2000) });
        expect(max.status, '제목 100자·내용 2000자').toBe(200);
        const multi = await createInquiry(g.api, { category: 'ETC', title: '  앞뒤   공백  ', content: '첫 줄\n둘째 줄' });
        expect(multi.status).toBe(200);
        const saved = multi.body.data as InquiryItem;
        expect(saved.title, '제목은 앞뒤 공백을 정리하고 가운데 공백을 하나로').toBe('앞뒤 공백');
        expect(saved.content).toBe('첫 줄\n둘째 줄');
        expect(saved.status).toBe('WAITING');
      });

      await test.step('스크립트 글은 글자 그대로 저장·응답되고 JSON 으로만 내려간다', async () => {
        const marker = stamp();
        const title = `<script>window.__qaXss=1</script>${marker}`;
        const content = '<img src=x onerror="window.__qaXss=1"> <b>굵게</b>';
        const created = await createInquiry(g.api, { category: 'ETC', title, content });
        expect(created.status).toBe(200);
        const row = created.body.data as InquiryItem;
        expect(row.title, '저장된 제목(변형 없음)').toBe(title);
        expect(row.content, '저장된 내용(변형 없음)').toBe(content);
        const res = await g.api.raw('GET', `/api/guardian/inquiry/${row.id}`);
        expect(res.headers()['content-type'] ?? '', '응답은 JSON').toContain('application/json');

        // 관리자 화면: 글자로만 보이고 실행되지 않는다
        await relaxAuthRates();
        const page = await openAs(a.who, '/admin/inquiries');
        let dialogSeen = false;
        page.on('dialog', async dialog => {
          dialogSeen = true;
          await dialog.dismiss();
        });
        await page.getByPlaceholder('제목 · 작성자 · 내용 검색').fill(marker);
        const rowButton = page.getByRole('row').filter({ hasText: marker }).getByRole('button', { name: '답변' });
        await expect(rowButton, '관리자 목록에 글자 그대로 보인다').toBeVisible({ timeout: 20_000 });
        await expect(page.getByRole('row').filter({ hasText: '<script>window.__qaXss=1</script>' })).toHaveCount(1);
        await rowButton.click();
        const detail = page.getByRole('dialog');
        await expect(detail.getByRole('heading', { level: 2 })).toHaveText(title);
        await expect(detail.getByText(content)).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __qaXss?: number }).__qaXss), '스크립트가 실행되지 않았다').toBeUndefined();
        expect(dialogSeen, '경고창이 뜨지 않았다').toBe(false);
        test.info().annotations.push({
          type: '보류 항목',
          description: 'ADMIN-G23(보류): 현재 FE a8666240 의 관리자 문의 화면은 글자로만 그려(dangerouslySetInnerHTML 없음) 실행되지 않는다. 서버는 글을 거르지 않고 그대로 저장한다.',
        });
      });
    } finally {
      cleanAdminAudit([admin.id]);
    }
  });

  test('CONN-A58 이미 답한 문의 재답변·동시 답변·알림 꺼둔 작성자', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const author = await tempUser('GUARDIAN');
    const quietAuthor = await tempUser('GUARDIAN');
    const admin1 = await tempUser('ADMIN');
    const admin2 = await tempUser('ADMIN');
    const [au, qa, a1, a2] = [await loginAs(author), await loginAs(quietAuthor), await loginAs(admin1), await loginAs(admin2)];
    const audits = (id: number) => Number(psql(`SELECT count(*) FROM admin_audit_log WHERE action = 'INQUIRY_ANSWER' AND target_id = ${sqlStr(String(id))};`));
    const row = (id: number) => psql(`SELECT status || '|' || coalesce(answer, '<null>') || '|' || coalesce(answered_by, '<null>') FROM inquiry WHERE id = ${id};`);
    const newInquiry = async (api: Api, label: string) => {
      const r = await createInquiry(api, { category: 'SERVICE', title: `[QA-P1a] ${label} ${stamp()}`, content: '답변 시험용' });
      expect(r.status, '문의 작성').toBe(200);
      return (r.body.data as InquiryItem).id;
    };

    try {
      await test.step('같은 문의 재답변은 409 INQUIRY_ALREADY_ANSWERED 이고 첫 답변이 그대로', async () => {
        const id = await newInquiry(au.api, '재답변');
        const first = await a1.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: '첫 답변' });
        expect(first.status()).toBe(200);
        const again = await read(await a2.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: '두 번째 답변' }));
        expect(again.status, '재답변').toBe(409);
        expect(again.body.code).toBe('INQUIRY_ALREADY_ANSWERED');
        const sameAdmin = await a1.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: '같은 관리자 재답변' });
        expect(sameAdmin.status(), '같은 관리자의 재답변도 거부').toBe(409);
        expect(row(id)).toBe(`ANSWERED|첫 답변|${admin1.id}`);
        expect(audits(id), '답변 감사 로그는 1건').toBe(1);
        await expect.poll(() => notifCount('INQUIRY_ANSWERED', author.id), { message: '작성자 알림 기록 1건', timeout: 30_000 }).toBe(1);
        expect(notifCount('INQUIRY_ANSWERED', author.id), '재답변 시도는 알림을 만들지 않는다').toBe(1);
      });

      await test.step('권한·없는 문의', async () => {
        const id = await newInquiry(au.api, '권한');
        expect((await au.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: '보호자가 답변 시도' })).status(), '보호자 토큰').toBe(403);
        expect((await rawCall('POST', `/api/admin/inquiry/${id}/answer`, { answer: '무로그인' })).status, '무로그인').toBe(401);
        expect((await a1.api.raw('POST', '/api/admin/inquiry/999999999/answer', { answer: '없는 문의' })).status(), '없는 문의').toBe(404);
        expect(row(id).startsWith('WAITING|'), '거부된 시도 뒤에도 대기 상태').toBe(true);
      });

      await test.step('두 관리자가 동시에 답변하면 한 명만 성공(3회)', async () => {
        for (let round = 1; round <= 3; round++) {
          const id = await newInquiry(au.api, `동시 ${round}`);
          const [r1, r2] = await Promise.all([
            a1.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: `관리자1 답변 ${round}` }),
            a2.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: `관리자2 답변 ${round}` }),
          ]);
          expect([r1.status(), r2.status()].sort(), `${round}회차 응답`).toEqual([200, 409]);
          const winner = r1.status() === 200 ? { who: admin1.id, text: `관리자1 답변 ${round}` } : { who: admin2.id, text: `관리자2 답변 ${round}` };
          expect(row(id), `${round}회차 저장된 답변은 이긴 쪽 것`).toBe(`ANSWERED|${winner.text}|${winner.who}`);
          expect(audits(id), `${round}회차 감사 로그`).toBe(1);
        }
        // 알림은 답변 성립 건수만큼: 재답변 1건 + 동시 3건 = 4건
        await expect.poll(() => notifCount('INQUIRY_ANSWERED', author.id), { message: '답변이 성립한 건수만큼만 알림', timeout: 40_000, intervals: [1000, 2000] }).toBe(4);
      });

      await test.step('푸시를 꺼 둔 작성자: 답변은 저장되고 알림은 안 나간다', async () => {
        const channels = ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: false }));
        expect((await qa.api.raw('PUT', '/api/user/me/notification-settings', { settings: channels })).status()).toBe(200);
        const id = await newInquiry(qa.api, '알림 끔');
        expect((await a1.api.raw('POST', `/api/admin/inquiry/${id}/answer`, { answer: '알림 꺼둔 작성자 답변' })).status()).toBe(200);
        expect(row(id)).toBe(`ANSWERED|알림 꺼둔 작성자 답변|${admin1.id}`);
        await expect.poll(() => notifRows('INQUIRY_ANSWERED', quietAuthor.id).length, { message: '알림 이력 한 줄', timeout: 30_000, intervals: [1000, 2000] }).toBe(1);
        const [log] = notifRows('INQUIRY_ANSWERED', quietAuthor.id);
        expect(log.result, '보내지 않음').toBe('NOT_SENT');
        expect(log.reason, '채널을 다 꺼서').toBe('NO_ENABLED_CHANNEL');
        const mine = await read(await qa.api.raw('GET', `/api/guardian/inquiry/${id}`));
        expect(mine.status, '작성자 상세 조회').toBe(200);
        expect((mine.body.data as InquiryItem).answer, '작성자는 답변을 볼 수 있다').toBe('알림 꺼둔 작성자 답변');
      });
    } finally {
      cleanAdminAudit([admin1.id, admin2.id]);
    }
  });

  test('CONN-N40 보호자 문의 작성·내 목록·상세', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const guardian = await tempUser('GUARDIAN');
    const other = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const admin = await tempUser('ADMIN');
    const [g, o, w, a] = [await loginAs(guardian), await loginAs(other), await loginAs(ward), await loginAs(admin)];
    const marker = stamp();
    const created: { category: string; id: number; title: string }[] = [];

    await test.step('분류 5종으로 작성하면 WAITING 으로 저장', async () => {
      for (const category of ['ANOMALY', 'HOSPITAL', 'ACCOUNT', 'SERVICE', 'ETC']) {
        const title = `[QA-P1a] ${category} ${marker}`;
        const content = `내용 ${category} ${'가'.repeat(category === 'ETC' ? 150 : 5)}`;
        const r = await createInquiry(g.api, { category, title, content });
        expect(r.status, `${category} 작성`).toBe(200);
        const item = r.body.data as InquiryItem;
        expect(item.status).toBe('WAITING');
        expect(item.category).toBe(category);
        expect(item.answer, '답변 전').toBeNull();
        expect(item.answeredAt).toBeNull();
        expect(item.content, '작성 응답은 전체 내용').toBe(content);
        expect(psql(`SELECT status || '|' || category || '|' || user_id FROM inquiry WHERE id = ${item.id};`)).toBe(`WAITING|${category}|${guardian.id}`);
        created.push({ category, id: item.id, title });
        // 최신순은 배포 코드(findByUserIdOrderByCreatedAtDescIdDesc)가 만든 시각 같으면 id 큰 것 먼저이므로 대기 없이 id 역순으로 본다
      }
      const otherItem = await createInquiry(o.api, { category: 'SERVICE', title: `[QA-P1a] 남의 문의 ${marker}`, content: '남의 내용' });
      expect(otherItem.status).toBe(200);
    });

    await test.step('내 목록: 내 것만, 최신순, 내용은 앞 100자', async () => {
      const r = await read(await g.api.raw('GET', '/api/guardian/inquiry'));
      expect(r.status).toBe(200);
      const list = r.body.data as InquiryItem[];
      expect(list.map(i => i.id), '내 문의 5건이 최신순').toEqual([...created].reverse().map(c => c.id));
      expect(list.some(i => i.title.includes('남의 문의')), '남의 문의가 섞이면 안 된다').toBe(false);
      const etc = list.find(i => i.category === 'ETC')!;
      expect(Array.from(etc.content).length, '목록의 내용은 100자로 줄어든다').toBe(100);
      const detail = await read(await g.api.raw('GET', `/api/guardian/inquiry/${etc.id}`));
      expect(Array.from((detail.body.data as InquiryItem).content).length, '상세는 전체 내용').toBeGreaterThan(100);
      const paged = await read(await g.api.raw('GET', '/api/guardian/inquiry?page=1&size=2'));
      expect((paged.body.data as InquiryItem[]).map(i => i.id), '쪽 나누기(2건씩 둘째 쪽)').toEqual([...created].reverse().slice(2, 4).map(c => c.id));
    });

    await test.step('상세는 본인 것만: 남의 문의 403, 없는 문의 404, 다른 역할은 403', async () => {
      const mine = created[0];
      expect((await o.api.raw('GET', `/api/guardian/inquiry/${mine.id}`)).status(), '다른 보호자').toBe(403);
      const denied = await read(await o.api.raw('GET', `/api/guardian/inquiry/${mine.id}`));
      expect(denied.body.code).toBe('INQUIRY_NOT_AUTHORIZED');
      expect((await g.api.raw('GET', '/api/guardian/inquiry/999999999')).status(), '없는 문의').toBe(404);
      for (const [label, who] of [['피보호자', w], ['관리자', a]] as const) {
        expect((await who.api.raw('GET', '/api/guardian/inquiry')).status(), `${label} 목록`).toBe(403);
        expect((await who.api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title: 't', content: 'c' })).status(), `${label} 작성`).toBe(403);
      }
      expect((await rawCall('GET', '/api/guardian/inquiry')).status, '무로그인').toBe(401);
    });

    await test.step('화면: 내 문의 내역에 제목이 보이고 열면 상세가 뜬다', async () => {
      const page = await openAs(g.who, '/guardian/inquiries');
      const first = created[created.length - 1];
      const card = page.getByRole('list', { name: '내 문의 내역' }).getByRole('button', { name: `${first.title} 문의 자세히 보기` });
      await expect(card).toBeVisible({ timeout: 20_000 });
      await card.click();
      const dialog = page.getByRole('dialog', { name: '문의 상세' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText(first.title)).toBeVisible();
    });
  });

  test('CONN-N41 관리자 문의 목록·필터·답변', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const author = await tempUser('GUARDIAN', { name: `E2E문의자${stamp().slice(0, 4)}` });
    const admin = await tempUser('ADMIN');
    const [au, ad] = [await loginAs(author), await loginAs(admin)];
    const marker = `P1a${stamp()}`;
    const rows: { category: string; id: number; title: string }[] = [];
    const longContent = '가'.repeat(250);

    try {
      for (const category of ['SERVICE', 'ACCOUNT', 'HOSPITAL']) {
        const title = `[QA-P1a] ${category} ${marker}`;
        const r = await createInquiry(au.api, { category, title, content: category === 'SERVICE' ? longContent : '짧은 내용' });
        expect(r.status).toBe(200);
        rows.push({ category, id: (r.body.data as InquiryItem).id, title });
      }
      const target = rows[0];

      await test.step('목록: 검색·분류·상태 필터와 쪽 나누기', async () => {
        const all = await adminList(ad.api, `?keyword=${marker}&size=10`);
        expect(all.inquiries.content.map(i => i.id).sort((x, y) => x - y), '검색어로 내 문의 3건만').toEqual(rows.map(r => r.id).sort((x, y) => x - y));
        expect(all.inquiries.totalElements).toBe(3);
        const item = all.inquiries.content[0];
        for (const key of ['id', 'category', 'title', 'authorId', 'authorName', 'status', 'createdAt']) expect(item, `목록 한 건에 ${key}`).toHaveProperty(key);
        expect(item.authorId).toBe(author.id);
        expect(item.authorName).toBe(author.name);
        expect(item.status).toBe('WAITING');
        expect(all.inquiries.content.map(i => i.id), '최신순').toEqual([...rows].reverse().map(r => r.id));

        expect((await adminList(ad.api, `?keyword=${marker}&category=ACCOUNT`)).inquiries.content.map(i => i.id), '분류 필터').toEqual([rows[1].id]);
        expect((await adminList(ad.api, `?keyword=${marker}&status=ANSWERED`)).inquiries.totalElements, '답변 전 ANSWERED 필터').toBe(0);
        expect((await adminList(ad.api, `?keyword=${encodeURIComponent(author.name)}`)).inquiries.totalElements, '작성자 이름으로도 검색').toBeGreaterThanOrEqual(3);
        const p1 = await adminList(ad.api, `?keyword=${marker}&size=1&page=1`);
        expect(p1.inquiries.content.map(i => i.id), '쪽 나누기').toEqual([rows[1].id]);
        expect(p1.inquiries.totalPages).toBe(3);
        expect(p1.inquiries.last).toBe(false);

        // 건수(totalCount/waitingCount/answeredCount)는 필터·검색과 무관한 전체 기준 - 다른 사람이 동시에 올릴 수 있어 같아질 때까지 확인
        await expect
          .poll(async () => {
            const filtered = await adminList(ad.api, `?keyword=${marker}&category=ACCOUNT&status=WAITING`);
            const plain = await adminList(ad.api, '?size=1');
            return [filtered.totalCount - plain.totalCount, filtered.waitingCount - plain.waitingCount, filtered.answeredCount - plain.answeredCount];
          }, { message: '필터를 걸어도 탭 건수는 전체 기준', timeout: 20_000, intervals: [500, 1000] })
          .toEqual([0, 0, 0]);
        await expect
          .poll(async () => {
            const plain = await adminList(ad.api, '?size=1');
            return plain.totalCount - plain.waitingCount - plain.answeredCount;
          }, { message: '전체 = 대기 + 완료', timeout: 20_000, intervals: [500, 1000] })
          .toBe(0);
        test.info().annotations.push({
          type: '문서와 다른 점',
          description: '케이스는 "본문 100자로 줄임"이지만 배포 코드의 관리자 목록 한 건(AdminInquiryResponse)에는 본문 칸이 아예 없다. 100자 줄임은 보호자 "내 목록"(InquiryResponse.ofSummary)에만 있어 N40 에서 확인한다.',
        });
        expect(item, '관리자 목록에는 본문 칸이 없다(목록 본문 노출 없음)').not.toHaveProperty('content');
      });

      let frames: string[] = [];
      await test.step('관리자 화면에서 답변', async () => {
        const guardianPage = await openAs(au.who, null);
        frames = captureFrames(guardianPage);
        await guardianPage.goto('/guardian');
        await waitForRealtime(guardianPage);
        await expect.poll(() => frames.length, { message: '실시간 연결이 맺어져 프레임이 들어온다(검사가 헛통과하지 않게)', timeout: 15_000 }).toBeGreaterThan(0);

        await relaxAuthRates();
        const page = await openAs(ad.who, '/admin/inquiries');
        await page.getByPlaceholder('제목 · 작성자 · 내용 검색').fill(marker);
        const button = page.getByRole('row').filter({ hasText: target.title }).getByRole('button', { name: '답변' });
        await expect(button).toBeVisible({ timeout: 20_000 });
        await button.click();
        const dialog = page.getByRole('dialog');
        await expect(dialog.getByText(longContent), '관리자 상세에는 전체 내용').toBeVisible();
        await dialog.getByLabel('답변 작성').fill('관리자 답변입니다');
        const answered = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/api/admin/inquiry/${target.id}/answer`));
        await dialog.getByRole('button', { name: '답변 전송' }).click();
        expect((await answered).status(), '답변 전송').toBe(200);
      });

      await test.step('ANSWERED 로 바뀌고 감사 로그·작성자 알림이 남는다', async () => {
        expect(psql(`SELECT status || '|' || answer || '|' || answered_by FROM inquiry WHERE id = ${target.id};`)).toBe(`ANSWERED|관리자 답변입니다|${admin.id}`);
        expect(psql(`SELECT count(*) FROM admin_audit_log WHERE action = 'INQUIRY_ANSWER' AND target_id = ${sqlStr(String(target.id))} AND admin_id = ${sqlStr(admin.id)};`), '감사 로그 INQUIRY_ANSWER').toBe('1');
        const detail = await read(await ad.api.raw('GET', `/api/admin/inquiry/${target.id}`));
        expect((detail.body.data as { status: string }).status).toBe('ANSWERED');
        expect((await adminList(ad.api, `?keyword=${marker}&status=ANSWERED`)).inquiries.content.map(i => i.id), '완료 필터').toEqual([target.id]);

        await expect.poll(() => notifRows('INQUIRY_ANSWERED', author.id).length, { message: '작성자 알림 이력', timeout: 30_000, intervals: [1000, 2000] }).toBe(1);
        const [log] = notifRows('INQUIRY_ANSWERED', author.id);
        expect(log.title).toBe('문의 답변 완료');
        expect(log.body).toBe('문의하신 내용에 답변이 등록되었습니다.');
        expect(log.channels, '앱 푸시(FCM)를 시도했다(기본 설정)').toContain('FCM');
        expect(frames.some(f => /inquiry|INQUIRY/.test(f)), '화면 실시간 알림은 없다').toBe(false);
      });

      await test.step('보호자 화면에서 답변 확인', async () => {
        const page = await openAs(au.who, '/guardian/inquiries');
        const card = page.getByRole('list', { name: '내 문의 내역' }).getByRole('button', { name: `${target.title} 문의 자세히 보기` });
        await expect(card).toBeVisible({ timeout: 20_000 });
        await card.click();
        await expect(page.getByRole('dialog', { name: '문의 상세' }).getByText('관리자 답변입니다')).toBeVisible();
      });
    } finally {
      cleanAdminAudit([admin.id]);
    }
  });
});
