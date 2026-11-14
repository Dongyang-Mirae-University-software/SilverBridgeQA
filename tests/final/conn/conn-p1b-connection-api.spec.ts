/**
 * 최종 QA - 연결(CONN) P1 묶음 b, API 중심: N02 N04 A03 A04 A05 A07 A08 A11.
 *
 * 임시 사용자만 쓴다. 임시 사용자에게는 푸시 토큰이 없어 실제 푸시·문자는 나가지 않고 알림 이력(notification_log)만 남는다.
 * Redis 는 임시 보호자·임시 피보호자 id 가 들어간 키만 읽고 지운다.
 */
import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import {
  call, clearConnRateKeys, clearCounter, connRows, connStatus, counterTtl, counterValue, expectRes, holdTransaction, liveConnCount, notiRows,
  REQUEST_API, maxOver, TAGS, addMed, kstAfter,
} from './_helpers-conn-p1b';

const DUP_MESSAGE = '이미 연결되어 있거나 요청 중인 관계입니다.';
const PREVIEW = (targetId: string) => `/api/guardian/connection/preview?targetId=${encodeURIComponent(targetId)}`;

function setTempRole(userId: string, role: 'GUARDIAN' | 'WARD') {
  psql(`UPDATE users SET role = ${sqlStr(role)} WHERE id = ${sqlStr(userId)} AND email LIKE 'e2e.temp.%@silverbridge.test';`);
}
function setTempStatus(userId: string, status: 'ACTIVE' | 'RESTRICTED' | 'INACTIVE') {
  psql(`UPDATE users SET status = ${sqlStr(status)} WHERE id = ${sqlStr(userId)} AND email LIKE 'e2e.temp.%@silverbridge.test';`);
}
function idExists(id: string): boolean {
  return psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(id)};`) !== '0';
}

test.describe('CONN 연결 P1 묶음 b (API)', () => {
  test('CONN-N02 요청 전 preview로 가린 이름 확인', TAGS, async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD', { name: '김영희' });
    const otherGuardian = await tempUser('GUARDIAN');
    const g = await loginAs(guardian);
    try {
      await test.step('호출 전: 연결·알림·횟수가 모두 비어 있다', async () => {
        expect(connRows(guardian.id, ward.id)).toHaveLength(0);
        expect(notiRows(ward.id)).toHaveLength(0);
        expect(counterValue(guardian.id, ward.id), '요청 횟수 키').toBe('');
      });

      await test.step('preview 는 targetId 와 가린 이름만 돌려준다', async () => {
        const r = await call(g.api, 'GET', PREVIEW(ward.id));
        expectRes(r, 200, undefined, 'preview');
        const data = r.data as Record<string, unknown>;
        expect(Object.keys(data).sort(), '응답 칸은 targetId, maskedName 둘뿐').toEqual(['maskedName', 'targetId']);
        expect(data.targetId).toBe(ward.id);
        expect(data.maskedName, '첫 글자와 마지막 글자만 보인다').toBe('김*희');
        // 값을 단언에 넣지 않고 포함 여부(boolean)만 단언한다
        expect(r.text.includes(ward.phone ?? '(없음)'), '전화번호가 응답에 없다').toBe(false);
        expect(r.text.includes(ward.email), '이메일이 응답에 없다').toBe(false);
        expect(r.text.includes(ward.name), '실제 이름이 응답에 없다').toBe(false);
      });

      await test.step('같은 기준으로 판정한다: 역할이 다르면 400, 이미 요청 중이면 409', async () => {
        expectRes(await call(g.api, 'GET', PREVIEW(otherGuardian.id)), 400, 'INVALID_CONNECTION_ROLE', '보호자 ID 로 미리보기');
        expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, '요청');
        expectRes(await call(g.api, 'GET', PREVIEW(ward.id)), 409, 'CONNECTION_ALREADY_EXISTS', '요청 중인 상대 미리보기');
      });

      await test.step('화면: 링크로 열면 "이 분이 맞나요?" 와 가린 이름이 보인다', async () => {
        clearCounter(guardian.id, ward.id);
        psql(`DELETE FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`);
        const rowsBefore = notiRows(ward.id).length;
        const page = await openAs(g.who, `/guardian/wards/register?targetId=${ward.id}`);
        await expect(page.getByText('이 분이 맞나요? 김*희')).toBeVisible();
        expect(connRows(guardian.id, ward.id), '화면 확인만으로는 요청이 생기지 않는다').toHaveLength(0);
        expect(notiRows(ward.id).length, '알림도 늘지 않는다').toBe(rowsBefore);
        expect(counterValue(guardian.id, ward.id), '횟수 세기 없음').toBe('');
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearConnRateKeys(guardian.id);
    }
  });

  test('CONN-N04 피보호자 거절하면 보호자에게 알림', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    try {
      expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '아들' }), 200, undefined, '요청');
      const [row] = connRows(guardian.id, ward.id);
      expect(row.status).toBe('PENDING');
      expect(counterValue(guardian.id, ward.id), '요청 뒤 횟수').toBe('1');
      const ttlBefore = counterTtl(guardian.id, ward.id);

      expectRes(await call(w.api, 'DELETE', `/api/ward/connection/request/${row.id}/refusal`), 200, undefined, '거절');
      expect(connStatus(row.id), '거절됨').toBe('REFUSED');

      await expect
        .poll(() => notiRows(guardian.id, 'CONNECTION_REFUSED').length, { message: '보호자에게 거절 알림 이력이 1건', timeout: 20_000, intervals: [1000, 2000] })
        .toBe(1);
      const [noti] = notiRows(guardian.id, 'CONNECTION_REFUSED');
      expect(noti.title).toBe('연결 거절');
      expect(noti.body).toBe('연결 요청이 거절되었습니다.');

      expect(counterValue(guardian.id, ward.id), '거절로는 24시간 횟수가 초기화되지 않는다').toBe('1');
      expect(counterTtl(guardian.id, ward.id), '유효 시간도 그대로 이어진다').toBeLessThanOrEqual(ttlBefore);
      expect(counterTtl(guardian.id, ward.id)).toBeGreaterThan(0);
      expect((await w.api.get<unknown[]>('/api/ward/connection/pending')).length, '피보호자 받은 요청 목록에서 사라진다').toBe(0);
      test.info().annotations.push({
        type: '푸시',
        description: '임시 피보호자·보호자에게는 푸시 토큰이 없어 실제 푸시는 나가지 않고 알림 이력(CONNECTION_REFUSED)만 확인했다',
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearConnRateKeys(guardian.id);
    }
  });

  test('CONN-A03 targetId 빈 값·형식 오류·없는 ID·대소문자 틀림', TAGS, async ({ tempUser, loginAs }) => {
    const requester = await tempUser('GUARDIAN');
    const previewer = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD', { name: '박대소' });
    const r = await loginAs(requester);
    const p = await loginAs(previewer);
    const upper = ward.id.toUpperCase();
    const missing = 'zz9q8w';
    expect(upper, '준비: 대문자형 ID 가 원래 ID 와 달라야 한다').not.toBe(ward.id);
    test.skip(idExists(upper) || idExists(missing), '준비: 대소문자만 다른 ID 나 없는 ID 로 쓸 값이 실제로 존재한다');
    try {
      await test.step('요청: 빈 값·공백·5자·7자는 400 INVALID_INPUT', async () => {
        for (const [label, targetId] of [['빈 값', ''], ['공백 6칸', '      '], ['5자', ward.id.slice(0, 5)], ['7자', `${ward.id}x`]] as const) {
          expectRes(await call(r.api, 'POST', REQUEST_API, { targetId, relation: '딸' }), 400, 'INVALID_INPUT', label);
        }
      });
      await test.step('요청: 6자이지만 없는 ID(특수문자·눈에 안 보이는 글자·없는 ID)는 404 USER_NOT_FOUND', async () => {
        for (const [label, targetId] of [
          ['특수문자 6자', '!@#$%^'],
          ['눈에 안 보이는 글자 6자', '​'.repeat(6)],
          ['없는 ID', missing],
        ] as const) {
          const res = await call(r.api, 'POST', REQUEST_API, { targetId, relation: '딸' });
          expect(res.status, `${label}: 500 이면 안 된다`).not.toBe(500);
          expectRes(res, 404, 'USER_NOT_FOUND', label);
        }
      });
      await test.step('요청: 널 문자가 섞인 6자는 500 이 아니라 400 INVALID_INPUT', async () => {
        const res = await call(r.api, 'POST', REQUEST_API, { targetId: 'ab\u0000cde', relation: '딸' });
        expect(res.status, '500 이면 안 된다').not.toBe(500);
        expectRes(res, 400, 'INVALID_INPUT', '널 문자 포함');
      });
      await test.step('요청: 대소문자만 다른 ID 는 엉뚱한 사람에게도, 원래 사람에게도 가지 않는다', async () => {
        expectRes(await call(r.api, 'POST', REQUEST_API, { targetId: upper, relation: '딸' }), 404, 'USER_NOT_FOUND', '대소문자 불일치');
        expect(connRows(requester.id, ward.id), '원래 피보호자에게 요청이 생기지 않는다').toHaveLength(0);
        expect(Number(psql(`SELECT count(*) FROM connection WHERE guardian_id = ${sqlStr(requester.id)};`)), '이 보호자의 연결 행이 하나도 없다').toBe(0);
        expect(notiRows(ward.id), '피보호자에게 알림도 없다').toHaveLength(0);
      });

      await test.step('미리보기: 입력 오류(빈 값·5자·7자)는 케이스대로 400 INVALID_INPUT 이어야 한다', async () => {
        const results: string[] = [];
        for (const [label, targetId] of [['빈 값', ''], ['5자', ward.id.slice(0, 5)], ['7자', `${ward.id}x`]] as const) {
          const res = await call(p.api, 'GET', PREVIEW(targetId));
          results.push(`${label}=${res.status}${res.code ? ` ${res.code}` : ''}`);
          expect(res.status, `${label}: 500 이면 안 된다`).not.toBe(500);
          // 배포 코드의 미리보기는 길이 검사(@Size)가 없어 404 USER_NOT_FOUND 로 끝난다. 케이스(400)와 다르면 문서와 코드 차이로 실패를 남긴다.
          expect.soft(res.status, `미리보기 ${label}: 케이스는 400 (오류 코드 ${res.code ?? '없음'})`).toBe(400);
        }
        test.info().annotations.push({ type: '문서와 코드 차이 확인', description: `미리보기 입력 오류 결과: ${results.join(', ')}` });
      });

      await test.step('미리보기: 6자이지만 없는 ID·대소문자 불일치는 404 USER_NOT_FOUND 이고 500 이 없다, 그리고 요청은 만들어지지 않는다', async () => {
        for (const [label, targetId] of [
          ['빈 값', ''], ['5자', ward.id.slice(0, 5)], ['7자', `${ward.id}x`],
          ['특수문자 6자', '!@#$%^'], ['눈에 안 보이는 글자 6자', '​'.repeat(6)], ['없는 ID', missing], ['대소문자 불일치', upper],
        ] as const) {
          const res = await call(p.api, 'GET', PREVIEW(targetId));
          expect(res.status, `${label}: 500 이면 안 된다`).not.toBe(500);
          if (label === '특수문자 6자' || label === '눈에 안 보이는 글자 6자' || label === '없는 ID' || label === '대소문자 불일치') {
            expectRes(res, 404, 'USER_NOT_FOUND', `미리보기 ${label}`);
          }
        }
        expect(Number(psql(`SELECT count(*) FROM connection WHERE guardian_id = ${sqlStr(previewer.id)};`)), '미리보기만으로는 연결 행이 생기지 않는다').toBe(0);
      });
    } finally {
      clearConnRateKeys(requester.id);
      clearConnRateKeys(previewer.id);
    }
  });

  test('CONN-A04 이미 대기·연결 중인 상대에게 다시 요청', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    try {
      expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, '첫 요청');
      expect(counterValue(guardian.id, ward.id)).toBe('1');

      await test.step('대기 중: 연속 5번 다시 요청해도 모두 409, 횟수는 그대로 1', async () => {
        for (let i = 1; i <= 5; i++) {
          expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 409, 'CONNECTION_ALREADY_EXISTS', `대기 중 ${i}번째`);
        }
        expect(counterValue(guardian.id, ward.id), '거절된 요청(409)은 24시간 5건 횟수에 안 센다').toBe('1');
        expect(liveConnCount(guardian.id, ward.id), '연결 행은 하나뿐').toBe(1);
      });

      await test.step('연결됨: 다시 요청하면 409, 횟수 키는 수락으로 이미 지워져 새로 생기지 않는다', async () => {
        const [row] = connRows(guardian.id, ward.id);
        expectRes(await call(w.api, 'POST', `/api/ward/connection/${row.id}/accept`), 200, undefined, '수락');
        expect(counterValue(guardian.id, ward.id), '수락하면 초기화').toBe('');
        const res = await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '아들' });
        expectRes(res, 409, 'CONNECTION_ALREADY_EXISTS', '연결 중');
        expect(res.message, '안내 문구').toBe(DUP_MESSAGE);
        expect(counterValue(guardian.id, ward.id), '연결 중 거절도 세지 않는다').toBe('');
        expect(liveConnCount(guardian.id, ward.id)).toBe(1);
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearConnRateKeys(guardian.id);
    }
  });

  test('CONN-A05 같은 쌍 24시간 6번째 요청 429', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const guardianB = await tempUser('GUARDIAN');
    const wardB = await tempUser('WARD');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const gb = await loginAs(guardianB);
    const wb = await loginAs(wardB);
    try {
      await test.step('요청 후 거절·취소를 번갈아 5번 반복하면 횟수가 1씩 늘고 거절·취소로 줄지 않는다', async () => {
        for (let i = 1; i <= 5; i++) {
          expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, `${i}번째 요청`);
          expect(counterValue(guardian.id, ward.id), `${i}번째 요청 뒤 횟수`).toBe(String(i));
          const row = connRows(guardian.id, ward.id).at(-1)!;
          if (i % 2 === 1) {
            expectRes(await call(w.api, 'DELETE', `/api/ward/connection/request/${row.id}/refusal`), 200, undefined, `${i}번째 거절`);
            expect(connStatus(row.id)).toBe('REFUSED');
          } else {
            expectRes(await call(g.api, 'DELETE', `/api/guardian/connection/cancel/${row.id}`), 200, undefined, `${i}번째 취소`);
            expect(connStatus(row.id)).toBe('CANCELLED');
          }
          expect(counterValue(guardian.id, ward.id), `${i}번째 거절·취소 뒤에도 횟수 그대로`).toBe(String(i));
        }
      });

      await test.step('6번째 요청은 429 CONNECTION_REQUEST_COOLDOWN, retryAfterSeconds 와 Retry-After 가 함께 온다', async () => {
        const res = await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' });
        expectRes(res, 429, 'CONNECTION_REQUEST_COOLDOWN', '6번째');
        const retry = (res.data as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
        expect(typeof retry, 'data.retryAfterSeconds 는 숫자').toBe('number');
        expect(retry!, '남은 시간은 0 보다 크고 24시간 이하').toBeGreaterThan(0);
        expect(retry!).toBeLessThanOrEqual(24 * 3600);
        expect(Number(res.headers['retry-after']), 'Retry-After 헤더는 data 값과 같다').toBe(retry);
        expect(connRows(guardian.id, ward.id), '요청 행은 5개만').toHaveLength(5);
        expect(counterValue(guardian.id, ward.id), '막힌 요청은 세지 않는다').toBe('5');
        await expect
          .poll(() => notiRows(ward.id, 'CONNECTION_REQUEST').length, { message: '막힌 요청은 알림도 만들지 않는다 (요청 5건에 알림 정확히 5건)', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(5);
      });

      await test.step('다른 보호자-피보호자 쌍에서 수락하면 횟수가 초기화되고 다시 끊고 요청하면 1부터 센다', async () => {
        expectRes(await call(gb.api, 'POST', REQUEST_API, { targetId: wardB.id, relation: '딸' }), 200, undefined, 'B 요청');
        expect(counterValue(guardianB.id, wardB.id)).toBe('1');
        const [row] = connRows(guardianB.id, wardB.id);
        expectRes(await call(wb.api, 'POST', `/api/ward/connection/${row.id}/accept`), 200, undefined, 'B 수락');
        expect(counterValue(guardianB.id, wardB.id), '수락하면 초기화').toBe('');
        expectRes(await call(gb.api, 'DELETE', `/api/guardian/connection/disconnection/${row.id}`), 200, undefined, 'B 해제');
        expectRes(await call(gb.api, 'POST', REQUEST_API, { targetId: wardB.id, relation: '딸' }), 200, undefined, 'B 다시 요청');
        expect(counterValue(guardianB.id, wardB.id), '다시 1부터').toBe('1');
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearCounter(guardianB.id, wardB.id);
      clearConnRateKeys(guardian.id);
      clearConnRateKeys(guardianB.id);
    }
  });

  test('CONN-A07 수락 때 역할 변경·보호자 정지·탈퇴 진행', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const requested = async () => {
      const guardian = await tempUser('GUARDIAN');
      const ward = await tempUser('WARD');
      const g = await loginAs(guardian);
      const w = await loginAs(ward);
      expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, '요청');
      const [row] = connRows(guardian.id, ward.id);
      return { guardian, ward, g, w, id: row.id };
    };
    const cleanup: { guardianId: string; wardId: string }[] = [];
    try {
      await test.step('요청 뒤 보호자의 역할이 바뀌면: 400 INVALID_CONNECTION_ROLE, 요청은 정리된다(CANCELLED)', async () => {
        const c = await requested();
        cleanup.push({ guardianId: c.guardian.id, wardId: c.ward.id });
        setTempRole(c.guardian.id, 'WARD');
        expectRes(await call(c.w.api, 'POST', `/api/ward/connection/${c.id}/accept`), 400, 'INVALID_CONNECTION_ROLE', '역할 바뀜 수락');
        expect(connStatus(c.id), '이상한 요청이 PENDING 으로 남지 않는다').toBe('CANCELLED');
        expect((await c.w.api.get<unknown[]>('/api/ward/connection/pending')).length).toBe(0);
        expect((await c.w.api.get<unknown[]>('/api/ward/connection/active')).length, '연결도 생기지 않는다').toBe(0);
        // 같은 요청을 다시 수락하면 이미 끝난 요청이다
        expectRes(await call(c.w.api, 'POST', `/api/ward/connection/${c.id}/accept`), 409, 'CONNECTION_NOT_PENDING', '정리된 요청 재수락');
      });

      await test.step('요청 뒤 피보호자의 역할이 바뀌어도 수락은 400 INVALID_CONNECTION_ROLE 이고 요청은 정리된다', async () => {
        const c = await requested();
        cleanup.push({ guardianId: c.guardian.id, wardId: c.ward.id });
        setTempRole(c.ward.id, 'GUARDIAN');
        expectRes(await call(c.w.api, 'POST', `/api/ward/connection/${c.id}/accept`), 400, 'INVALID_CONNECTION_ROLE', '피보호자 역할 바뀜 수락');
        expect(connStatus(c.id)).toBe('CANCELLED');
      });

      await test.step('요청 뒤 보호자가 정지(RESTRICTED)·탈퇴 진행(INACTIVE)이면: 400 CONNECTION_REQUESTER_NOT_ACTIVE, 연결은 생기지 않는다', async () => {
        for (const status of ['RESTRICTED', 'INACTIVE'] as const) {
          const c = await requested();
          cleanup.push({ guardianId: c.guardian.id, wardId: c.ward.id });
          setTempStatus(c.guardian.id, status);
          expectRes(await call(c.w.api, 'POST', `/api/ward/connection/${c.id}/accept`), 400, 'CONNECTION_REQUESTER_NOT_ACTIVE', `보호자 ${status} 수락`);
          expect(connStatus(c.id), `${status}: 연결(ACTIVE)이 되면 안 된다`).not.toBe('ACTIVE');
          expect((await c.w.api.get<unknown[]>('/api/ward/connection/active')).length, `${status}: 피보호자 보호자 목록이 비어 있다`).toBe(0);
        }
        test.info().annotations.push({
          type: '문서와 코드 차이',
          description:
            '문서는 정지·탈퇴 진행 보호자의 수락을 400 CONNECTION_TARGET_NOT_ACTIVE 로 적었지만, 배포 코드(ConnectionService.acceptConnectionAsWard)는 수락 전용 코드 CONNECTION_REQUESTER_NOT_ACTIVE(400)를 쓴다. 코드 값으로 고정했다. 이 경우 요청 행은 정리되지 않고 PENDING 으로 남는다(보호자가 다시 ACTIVE 가 되면 수락 가능).',
        });
      });
    } finally {
      for (const pair of cleanup) {
        clearCounter(pair.guardianId, pair.wardId);
        clearConnRateKeys(pair.guardianId);
      }
    }
  });

  test('CONN-A08 같은 연결을 동시에 만들거나 수락', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const cleanup: { guardianId: string; wardId: string }[] = [];
    try {
      await test.step('같은 요청 2건을 동시에: 1건만 200, 나머지는 409 CONNECTION_ALREADY_EXISTS 와 같은 안내 문구, 연결 1건', async () => {
        for (let round = 1; round <= 3; round++) {
          const guardian = await tempUser('GUARDIAN');
          const ward = await tempUser('WARD');
          cleanup.push({ guardianId: guardian.id, wardId: ward.id });
          const g = await loginAs(guardian);
          const results = await Promise.all([
            call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }),
            call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }),
          ]);
          const statuses = results.map(r => r.status).sort();
          expect(statuses, `${round}회차 응답 상태 코드`).toEqual([200, 409]);
          const dup = results.find(r => r.status === 409)!;
          expect(dup.code, `${round}회차 중복 응답 코드`).toBe('CONNECTION_ALREADY_EXISTS');
          expect(dup.message, `${round}회차 안내 문구`).toBe(DUP_MESSAGE);
          expect(liveConnCount(guardian.id, ward.id), `${round}회차 연결 행`).toBe(1);
        }
      });

      await test.step('같은 요청을 동시에 2건 수락: 연결은 1건, 연결 상태 ACTIVE', async () => {
        const guardian = await tempUser('GUARDIAN');
        const ward = await tempUser('WARD');
        cleanup.push({ guardianId: guardian.id, wardId: ward.id });
        const g = await loginAs(guardian);
        const w = await loginAs(ward);
        expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, '요청');
        const [row] = connRows(guardian.id, ward.id);
        const results = await Promise.all([
          call(w.api, 'POST', `/api/ward/connection/${row.id}/accept`),
          call(w.api, 'POST', `/api/ward/connection/${row.id}/accept`),
        ]);
        const statuses = results.map(r => r.status).sort();
        test.info().annotations.push({ type: '동시 수락 응답', description: `상태 코드 ${statuses.join(', ')}` });
        expect(connRows(guardian.id, ward.id), '연결 행은 1건').toHaveLength(1);
        expect(connStatus(row.id)).toBe('ACTIVE');
        expect(liveConnCount(guardian.id, ward.id)).toBe(1);
        expect(statuses, '동시 수락: 한 건은 200, 다른 한 건은 409').toEqual([200, 409]);
        const late = results.find(r => r.status === 409)!;
        expect(late.code, '늦은 수락의 오류 코드(이미 처리된 요청)').toBe('CONNECTION_NOT_PENDING');
        expect(late.message, '늦은 수락의 안내 문구').toBe('수락 대기 중인 연결 관계가 아닙니다.');
        // 보호자에게 가는 수락 알림은 1건이어야 한다 (같은 수락이 두 번 알려지면 안 된다)
        await expect
          .poll(() => notiRows(guardian.id, 'CONNECTION_ACCEPTED').length, { message: '수락 알림 이력', timeout: 20_000, intervals: [1000, 2000] })
          .toBeGreaterThanOrEqual(1);
        expect(await maxOver(() => notiRows(guardian.id, 'CONNECTION_ACCEPTED').length, 3_000), '동시에 두 번 눌러도 수락 알림은 1건에서 늘지 않는다').toBe(1);
      });
    } finally {
      for (const pair of cleanup) {
        clearCounter(pair.guardianId, pair.wardId);
        clearConnRateKeys(pair.guardianId);
      }
    }
  });

  test('CONN-A11 회원 탈퇴·역할 변경 때 연결 정리와 안내', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const kept: { guardianId: string; wardId: string }[] = [];
    try {
      await test.step('보호자 탈퇴: 연결이 바로 해제 상태, 상대(피보호자)에게 해제 알림, 그 보호자가 등록한 약 중지, 남은 보호자에게 중지 안내', async () => {
        const leaving = await tempUser('GUARDIAN', { phone: null });
        const staying = await tempUser('GUARDIAN', { phone: null });
        const ward = await tempUser('WARD');
        connect(leaving.id, ward.id);
        connect(staying.id, ward.id);
        kept.push({ guardianId: leaving.id, wardId: ward.id });
        const l = await loginAs(leaving);
        const w = await loginAs(ward);
        const medId = await addMed(l.api, ward.id, 'E2E탈퇴약', kstAfter(6));
        const stayingMedId = await addMed((await loginAs(staying)).api, ward.id, 'E2E남는약', kstAfter(7));
        const connId = connRows(leaving.id, ward.id)[0].id;

        // 탈퇴 뒤 계정 행 삭제(purge)가 잠깐 늦어지게 해서 "탈퇴 커밋 직후, purge 전" 상태를 들여다본다 (임시 보호자 행만 잠근다)
        const settingId = psql(
          `INSERT INTO guardian_anomaly_setting (guardian_id, review_reminder_enabled) VALUES (${sqlStr(leaving.id)}, false) RETURNING id;`,
        );
        const held = holdTransaction(`SELECT 1 FROM guardian_anomaly_setting WHERE id = ${settingId} FOR UPDATE;`, 25);
        held.catch(() => undefined);
        await expect
          .poll(
            () => {
              try {
                psql(`SELECT 1 FROM guardian_anomaly_setting WHERE id = ${settingId} FOR UPDATE NOWAIT;`);
                return false;
              } catch {
                return true;
              }
            },
            { message: '준비: 잠금을 잡았다', timeout: 15_000, intervals: [500, 1000] },
          )
          .toBe(true);

        const withdraw = l.api
          .raw('DELETE', '/api/user/me', { password: leaving.password })
          .then(res => res.status(), () => 0);

        await expect
          .poll(() => psql(`SELECT status FROM users WHERE id = ${sqlStr(leaving.id)};`), { message: '탈퇴 커밋(INACTIVE)', timeout: 20_000, intervals: [500, 1000] })
          .toBe('INACTIVE');
        await expect
          .poll(() => connStatus(connId), { message: '탈퇴 직후 연결이 바로 해제 상태', timeout: 15_000, intervals: [500, 1000] })
          .toBe('DISCONNECTED');
        expect(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(leaving.id)};`), '준비: 아직 purge 전').toBe('1');

        await expect
          .poll(() => notiRows(ward.id, 'CONNECTION_DISCONNECTED').length, { message: '피보호자에게 해제 알림', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        const [noti] = notiRows(ward.id, 'CONNECTION_DISCONNECTED');
        expect(noti.body, '피보호자에게 가는 해제 문구(배포 코드의 단문)').toBe('가족 연결이 해제됐어요.');

        // 등록한 약 중지: 탈퇴한 보호자가 등록한 약만 사라지고, 남은 보호자가 등록한 약은 그대로
        await expect
          .poll(() => psql(`SELECT count(*) FROM medication WHERE id = ${medId};`), { message: '탈퇴한 보호자가 등록한 약이 중지(삭제)됨', timeout: 20_000, intervals: [1000, 2000] })
          .toBe('0');
        expect(medDeletedOrGone(stayingMedId), '남은 보호자가 등록한 약은 그대로 살아 있다').toBe(false);
        await expect
          .poll(() => notiRows(staying.id, 'MEDICATION_STOPPED').length, { message: '남은 보호자에게 중지 안내', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        expect(notiRows(staying.id, 'MEDICATION_STOPPED')[0].body, '중지 안내 문구').toContain('약 1건이 중지되었습니다');
        expect(notiRows(ward.id, 'MEDICATION_STOPPED'), '피보호자 본인에게는 중지 안내를 보내지 않는다').toHaveLength(0);

        await held.catch(() => undefined);
        await withdraw;
        await expect
          .poll(() => psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(leaving.id)};`), { message: '잠금이 풀린 뒤 계정 행 삭제', timeout: 30_000, intervals: [1000, 2000] })
          .toBe('0');
        expect((await w.api.get<unknown[]>('/api/ward/connection/active')).length, '피보호자 보호자 목록에는 남은 보호자 1명만').toBe(1);
      });

      await test.step('관리자 역할 변경(피보호자 -> 보호자): 연결이 해제되고 상대 보호자에게 "관리자가 연결을 해제했습니다", 그 사람이 받던 약 중지', async () => {
        const admin = await tempUser('ADMIN');
        const guardian = await tempUser('GUARDIAN', { phone: null });
        const ward = await tempUser('WARD');
        connect(guardian.id, ward.id);
        kept.push({ guardianId: guardian.id, wardId: ward.id });
        const a = await loginAs(admin);
        const g = await loginAs(guardian);
        const medId = await addMed(g.api, ward.id, 'E2E역할변경약', kstAfter(6));
        const connId = connRows(guardian.id, ward.id)[0].id;

        expectRes(await call(a.api, 'PATCH', `/api/admin/user/${ward.id}`, { role: 'GUARDIAN' }), 200, undefined, '역할 변경');
        expect(psql(`SELECT role FROM users WHERE id = ${sqlStr(ward.id)};`)).toBe('GUARDIAN');
        await expect.poll(() => connStatus(connId), { message: '연결이 바로 해제 상태', timeout: 15_000, intervals: [500, 1000] }).toBe('DISCONNECTED');
        await expect
          .poll(() => notiRows(guardian.id, 'CONNECTION_DISCONNECTED').length, { message: '상대 보호자에게 해제 알림', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        expect(notiRows(guardian.id, 'CONNECTION_DISCONNECTED')[0].body, '관리자 조치로 안내').toBe('관리자가 연결을 해제했습니다.');
        expect(medDeletedOrGone(medId), '역할이 바뀐 사람이 피보호자로서 받던 약은 중지(삭제 처리)').toBe(true);
      });

      await test.step('관리자 역할 변경(보호자 -> 피보호자): 연결이 해제되고 피보호자에게 알림, 보호자가 등록해 준 약은 그대로', async () => {
        const admin = await tempUser('ADMIN');
        const guardian = await tempUser('GUARDIAN', { phone: null });
        const ward = await tempUser('WARD');
        connect(guardian.id, ward.id);
        kept.push({ guardianId: guardian.id, wardId: ward.id });
        const a = await loginAs(admin);
        const g = await loginAs(guardian);
        const medId = await addMed(g.api, ward.id, 'E2E등록약', kstAfter(6));
        const connId = connRows(guardian.id, ward.id)[0].id;

        expectRes(await call(a.api, 'PATCH', `/api/admin/user/${guardian.id}`, { role: 'WARD' }), 200, undefined, '역할 변경');
        await expect.poll(() => connStatus(connId), { message: '연결이 바로 해제 상태', timeout: 15_000, intervals: [500, 1000] }).toBe('DISCONNECTED');
        await expect
          .poll(() => notiRows(ward.id, 'CONNECTION_DISCONNECTED').length, { message: '피보호자에게 해제 알림', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        expect(notiRows(ward.id, 'CONNECTION_DISCONNECTED')[0].body).toBe('가족 연결이 해제됐어요.');
        expect(medDeletedOrGone(medId), '보호자 역할이었던 사람이 등록한 약은 건드리지 않는다').toBe(false);
        test.info().annotations.push({
          type: '문서와 코드 차이',
          description:
            '케이스는 "상대에게 관리자 조치로 안내"와 "해당 보호자가 등록한 약 중지"를 한꺼번에 적었지만 배포 코드는 나눠 처리한다. 피보호자가 받는 해제 문구는 누가 끊었든 단문 "가족 연결이 해제됐어요."(관리자 표시 없음), "관리자가 연결을 해제했습니다."는 보호자가 받는다. 약 중지는 탈퇴한 보호자가 등록한 약(탈퇴)과 역할이 바뀐 피보호자가 받던 약(역할 변경)에만 적용되고, 역할이 바뀐 보호자가 등록해 준 약은 남는다. 코드 값으로 고정했다.',
        });
      });
    } finally {
      for (const pair of kept) {
        clearCounter(pair.guardianId, pair.wardId);
      }
    }
  });
});

/** 약 행이 없거나 삭제 표시가 있으면 true, 살아 있으면 false */
function medDeletedOrGone(medicationId: number): boolean {
  const out = psql(`SELECT (deleted_at IS NOT NULL)::text FROM medication WHERE id = ${medicationId};`);
  return out === '' ? true : out === 'true';
}
