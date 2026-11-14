/**
 * 최종 QA - 문의하기(CONN) P2: A56 A59.
 *
 * 임시 사용자만 쓴다. Redis 는 임시 보호자 id 가 들어간 속도 제한 키만 지운다(패턴 삭제 금지).
 * 관리자 목록은 임시 보호자의 이름으로 걸러(keyword) 내 문의만 보고, 남의 문의 내용은 읽지도 적지도 않는다.
 */
import { expect, test } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import { deleteTempUser } from '../../../src/seed';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { cleanAdminAudit } from './_helpers-conn-p1a';
import { call, expectRes } from './_helpers-conn-p1b';
import { inquiryCountOf, TAGS } from './_helpers-conn-p2';

const CREATE = '/api/guardian/inquiry';

function rateKeys(guardianId: string) {
  return { minute: `rate:inquiry-create:1m:${guardianId}`, hour: `rate:inquiry-create:1h:${guardianId}` };
}

function body(n: number | string) {
  return { category: 'SERVICE', title: `[QA-P2] 문의 ${n}`, content: `[QA-P2] 문의 내용 ${n}` };
}

test.describe('CONN 문의하기 P2', () => {
  test('CONN-A56 문의 속도 제한과 동시 중복', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    await relaxAuthRates();
    const minuteGuardian = await tempUser('GUARDIAN', { phone: null });
    const hourGuardian = await tempUser('GUARDIAN', { phone: null });
    const burstGuardian = await tempUser('GUARDIAN', { phone: null });
    const m = await loginAs(minuteGuardian);
    const h = await loginAs(hourGuardian);
    const b = await loginAs(burstGuardian);

    try {
      await test.step('1분에 5건까지 쓸 수 있고 6번째는 429 TOO_MANY_REQUESTS(Retry-After 1분 이내)', async () => {
        for (let i = 1; i <= 5; i++) expectRes(await call(m.api, 'POST', CREATE, body(i)), 200, undefined, `${i}번째`);
        const sixth = await call(m.api, 'POST', CREATE, body(6));
        expectRes(sixth, 429, 'TOO_MANY_REQUESTS', '6번째');
        const retry = Number(sixth.headers['retry-after']);
        expect(retry, 'Retry-After 는 1분 창의 남은 시간(1~60초)').toBeGreaterThanOrEqual(1);
        expect(retry).toBeLessThanOrEqual(60);
        expect(inquiryCountOf(minuteGuardian.id), '저장된 문의는 5건').toBe(5);
      });

      await test.step('1시간에 30건까지 쓸 수 있고 31번째는 429(Retry-After 가 1분보다 길다)', async () => {
        const keys = rateKeys(hourGuardian.id);
        const statuses: number[] = [];
        let last = await call(h.api, 'GET', CREATE); // 몸통 없이 목록 조회로 준비 확인
        expectRes(last, 200, undefined, '준비');
        for (let i = 1; i <= 31; i++) {
          if ((i - 1) % 5 === 0) redis('DEL', keys.minute); // 분당 제한이 먼저 걸리지 않게 이 임시 보호자의 1분 키만 비운다
          last = await call(h.api, 'POST', CREATE, body(i));
          statuses.push(last.status);
        }
        expect(statuses.slice(0, 30).every(status => status === 200), '1~30번째는 모두 200').toBe(true);
        expect(statuses[30], '31번째').toBe(429);
        expect(last.code, '31번째 오류 코드').toBe('TOO_MANY_REQUESTS');
        expect(Number(last.headers['retry-after']), 'Retry-After 는 1시간 창의 남은 시간(1분보다 길다)').toBeGreaterThan(60);
        expect(inquiryCountOf(hourGuardian.id), '저장된 문의는 30건').toBe(30);
      });

      await test.step('같은 문의를 동시에 10번 보내도 5건만 저장되고 나머지는 429 (모두 저장되지 않는다)', async () => {
        const results = await Promise.all(Array.from({ length: 10 }, () => call(b.api, 'POST', CREATE, body('같은 문의'))));
        const okCount = results.filter(r => r.status === 200).length;
        const limited = results.filter(r => r.status === 429 && r.code === 'TOO_MANY_REQUESTS').length;
        expect(okCount, '통과한 요청').toBe(5);
        expect(limited, '429 로 막힌 요청').toBe(5);
        expect(inquiryCountOf(burstGuardian.id), '저장된 문의 수는 통과한 수와 같다').toBe(5);
      });
    } finally {
      for (const id of [minuteGuardian.id, hourGuardian.id, burstGuardian.id]) redis('DEL', ...Object.values(rateKeys(id)));
    }
  });

  test('CONN-A59 작성자 탈퇴·큰 page 번호', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    await relaxAuthRates();
    const stamp = Date.now().toString(36).slice(-5);
    const author = await tempUser('GUARDIAN', { name: `큐문의${stamp}`, phone: null });
    const keeper = await tempUser('GUARDIAN', { name: `큐보관${stamp}`, phone: null });
    const admin = await tempUser('ADMIN', { phone: null });
    const a = await loginAs(author);
    const k = await loginAs(keeper);
    const ad = await loginAs(admin);
    const answerText = `[QA-P2] 관리자 답변 ${stamp}`;
    const adminList = (query: string) => call(ad.api, 'GET', `/api/admin/inquiry?keyword=${encodeURIComponent(author.name)}${query}`);
    const pageOfList = (res: Awaited<ReturnType<typeof adminList>>) =>
      (res.data as { inquiries: { content: unknown[]; page: number; size: number; totalElements: number } }).inquiries;

    try {
      const authorInquiryIds: number[] = [];
      for (let i = 1; i <= 3; i++) {
        const res = await call(a.api, 'POST', CREATE, body(i));
        expectRes(res, 200, undefined, `작성자 문의 ${i}`);
        authorInquiryIds.push(Number((res.data as { id: number }).id));
      }
      expect(inquiryCountOf(author.id)).toBe(3);

      await test.step('관리자 목록: size 51 은 50 으로, 0 이하는 기본 20 으로 보정된다', async () => {
        for (const [size, want] of [[51, 50], [1000000, 50], [50, 50], [0, 20], [-5, 20]] as const) {
          const res = await adminList(`&size=${size}`);
          expectRes(res, 200, undefined, `size=${size}`);
          expect(pageOfList(res).size, `size=${size} 의 적용 크기`).toBe(want);
          expect(pageOfList(res).content.length, `size=${size}: 내 문의 3건`).toBe(3);
        }
      });

      await test.step('관리자 목록: 아주 큰 page 는 500 이 아니라 마지막 가능 페이지로 보정되고 빈 목록·정확한 전체 건수', async () => {
        for (const [size, lastPage] of [[20, Math.floor(2147483647 / 20)], [50, Math.floor(2147483647 / 50)]] as const) {
          const res = await adminList(`&page=2147483647&size=${size}`);
          expectRes(res, 200, undefined, `page=2147483647 size=${size}`);
          expect(pageOfList(res).page, `size=${size}: 마지막 가능 페이지로 보정`).toBe(lastPage);
          expect(pageOfList(res).content, `size=${size}: 빈 목록`).toEqual([]);
          expect(pageOfList(res).totalElements, `size=${size}: 전체 건수`).toBe(3);
        }
        const negative = await adminList('&page=-3');
        expectRes(negative, 200, undefined, 'page=-3');
        expect(pageOfList(negative).page, '음수 page 는 0').toBe(0);
        expect(pageOfList(negative).content.length).toBe(3);
        expectRes(await adminList('&page=99999999999'), 400, 'INVALID_INPUT', 'int 밖 page 글자');
      });

      await test.step('내 문의 목록(보호자): 큰 page 는 빈 배열, size 51 은 최대 50 으로 보정되어 200', async () => {
        const big = await call(a.api, 'GET', `${CREATE}?page=2147483647&size=20`);
        expectRes(big, 200, undefined, 'page=2147483647');
        expect(big.data, '빈 배열').toEqual([]);
        const wide = await call(a.api, 'GET', `${CREATE}?size=51`);
        expectRes(wide, 200, undefined, 'size=51');
        expect((wide.data as unknown[]).length, '내 문의 3건').toBe(3);
      });

      await test.step('답변한 관리자가 없어져도 문의와 답변은 남는다(답변자만 비워진다)', async () => {
        const res = await call(k.api, 'POST', CREATE, body('보관'));
        expectRes(res, 200, undefined, '보관할 문의');
        const keptId = Number((res.data as { id: number }).id);
        expectRes(await call(ad.api, 'POST', `/api/admin/inquiry/${keptId}/answer`, { answer: answerText }), 200, undefined, '관리자 답변');
        expect(psql(`SELECT status || '|' || (answered_by = ${sqlStr(admin.id)})::text FROM inquiry WHERE id = ${keptId};`), '답변 완료, 답변자는 이 임시 관리자').toBe('ANSWERED|true');

        cleanAdminAudit([admin.id]); // 답변이 남긴 감사 기록(이 임시 관리자의 것)만 지운다
        deleteTempUser(admin.id);
        expect(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(admin.id)};`), '임시 관리자는 지워졌다').toBe('0');
        expect(psql(`SELECT (answer = ${sqlStr(answerText)})::text || '|' || coalesce(answered_by, '<null>') || '|' || status FROM inquiry WHERE id = ${keptId};`), '답변은 그대로, 답변자는 비고, 상태 유지').toBe('true|<null>|ANSWERED');
        const mine = await call(k.api, 'GET', `${CREATE}/${keptId}`);
        expectRes(mine, 200, undefined, '작성자가 본 상세');
        expect((mine.data as { answer?: string }).answer, '작성자에게 보이는 답변').toBe(answerText);
      });

      await test.step('작성자가 탈퇴(회원 행 삭제)하면 그 사람의 문의도 함께 지워진다', async () => {
        const before = inquiryCountOf(author.id);
        expect(before).toBe(3);
        deleteTempUser(author.id);
        expect(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(author.id)};`), '작성자 행이 지워졌다').toBe('0');
        expect(inquiryCountOf(author.id), '작성자 문의가 함께 지워졌다').toBe(0);
        expect(psql(`SELECT count(*) FROM inquiry WHERE id IN (${authorInquiryIds.join(', ')});`), '작성자 문의 행 모두').toBe('0');
        test.info().annotations.push({
          type: '자동화 한계',
          description: '실제 탈퇴 흐름은 계정을 먼저 탈퇴 진행 중으로 두고 나중에 회원 행을 지워 정리한다. 기다릴 수 없어 마지막 단계(회원 행 삭제)를 임시 사용자 한 명에게 직접 해서 문의가 함께 지워지는 연결(CASCADE)만 확인했다',
        });
      });
    } finally {
      cleanAdminAudit([admin.id]);
    }
  });
});
