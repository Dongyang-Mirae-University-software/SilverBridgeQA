/**
 * 최종 QA - 연결(CONN) P1 묶음 b, 화면·실시간 중심: N01 N03 N05 N06.
 *
 * 임시 사용자만 쓴다. 임시 사용자에게는 푸시 토큰이 없어 실제 푸시·문자는 나가지 않고 알림 이력(notification_log)만 남는다.
 * 화면 글자는 배포 FE(a8666240, v13) 기준이다: 피보호자 "내 가족"(/ward/guardians), 보호자 "연결된 가족"(/guardian/wards),
 * 보호자 "피보호자 등록"(/guardian/wards/register).
 */
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import {
  call, clearConnRateKeys, clearCounter, connRows, connStatus, counterValue, expectRes, frameBodies, notiRows, REQUEST_API, maxOver, TAGS, watchWs,
} from './_helpers-conn-p1b';

test.describe('CONN 연결 P1 묶음 b (화면·실시간)', () => {
  test('CONN-N01 보호자가 6자리 ID로 연결 요청', TAGS, async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN', { name: '이보호' });
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    try {
      const wardPage = await openAs(w.who, null);
      const wardFrames = await watchWs(wardPage);
      await wardPage.goto('/ward/guardians');
      await waitForRealtime(wardPage);
      const guardianPage = await openAs(g.who, '/guardian/wards/register');

      const input = guardianPage.getByLabel('어르신의 회원 ID');
      await test.step('입력칸은 6자리 형식(예시·길이)을 안내한다 (CONN-G05, FEUX-G26)', async () => {
        await expect(input).toBeVisible();
        const placeholder = (await input.getAttribute('placeholder')) ?? '';
        expect.soft(placeholder.replace(/^예\)\s*/, ''), '안내 예시는 영문·숫자 6자리 형식').toMatch(/^[A-Za-z0-9]{6}$/);
        await input.click();
        await input.pressSequentially('WD-2026-0188');
        expect.soft((await input.inputValue()).length, '6자를 넘게 입력해도 입력칸에는 6자까지만 남는다').toBeLessThanOrEqual(6);
        await input.fill('');
      });

      await test.step('피보호자 6자리 ID 와 관계를 골라 요청한다', async () => {
        await input.fill(ward.id);
        await guardianPage.getByRole('button', { name: '딸', exact: true }).click();
        const posted = guardianPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/guardian/connection/request'));
        await guardianPage.getByRole('button', { name: '연결 요청 보내기' }).click();
        expect((await posted).status(), '요청 응답').toBe(200);
        await expect(guardianPage.getByText('연결 요청을 보냈어요. 어르신이 수락하면 연결돼요')).toBeVisible();
      });

      await test.step('DB: PENDING 한 건, 보호자가 시작, 관계 딸, 24시간 횟수 1', async () => {
        const rows = connRows(guardian.id, ward.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('PENDING');
        expect(psql(`SELECT initiated_by || '|' || relation FROM connection WHERE id = ${rows[0].id};`)).toBe(`${guardian.id}|딸`);
        expect(counterValue(guardian.id, ward.id)).toBe('1');
      });

      await test.step('피보호자 화면: 새로고침 없이 요청 카드(보호자 이름·관계)와 알림이 뜬다', async () => {
        const card = wardPage.getByRole('listitem').filter({ hasText: guardian.name });
        await expect(card).toBeVisible();
        await expect(card, '수락 전에 누가 보냈는지(이름·관계)가 보인다 (CONN-G03)').toContainText('(딸)');
        await expect(wardPage.getByText('보호자가 연결을 요청했습니다.'), '화면 알림').toBeVisible();
        const frames = frameBodies(wardFrames, 'connection-request');
        expect(frames, '실시간 신호 connection-request 1건').toHaveLength(1);
        expect(frames[0].from, '신호에 보낸 보호자 ID').toBe(guardian.id);
        expect(Number(frames[0].connectionId)).toBe(connRows(guardian.id, ward.id)[0].id);
      });

      await test.step('알림 이력: 피보호자에게 연결 요청 알림 1건 (보호자 이름이 들어간 단문)', async () => {
        await expect
          .poll(() => notiRows(ward.id, 'CONNECTION_REQUEST').length, { message: '연결 요청 알림 이력', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        expect(notiRows(ward.id, 'CONNECTION_REQUEST')[0].body).toBe(`${guardian.name}님이 가족 연결을 요청했어요. 앱에서 확인해 주세요.`);
        test.info().annotations.push({
          type: '푸시',
          description: '임시 피보호자에게는 푸시 토큰이 없어 실제 푸시 도달은 확인하지 못했다. 푸시를 시도한 알림 이력(CONNECTION_REQUEST)과 화면 알림으로 확인했다',
        });
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearConnRateKeys(guardian.id);
    }
  });

  test('CONN-N03 피보호자 수락하면 ACTIVE, 보호자에게 알림', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const guardian = await tempUser('GUARDIAN', { name: '최보호' });
    const guardian2 = await tempUser('GUARDIAN', { name: '정보호' });
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const g2 = await loginAs(guardian2);
    const w = await loginAs(ward);
    try {
      expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '아들' }), 200, undefined, '요청');
      expect(counterValue(guardian.id, ward.id)).toBe('1');
      const [row] = connRows(guardian.id, ward.id);

      // 취소 신호는 화면에 전달하지 않는다: 아래 "오류 뒤 목록 다시 불러오기" 단계에서 화면이 낡은 목록을 들고 있게 만들기 위해서다
      const wardPage = await openAs(w.who, null);
      await watchWs(wardPage, { drop: /connection-request-cancelled/ });
      await wardPage.goto('/ward/guardians');
      await waitForRealtime(wardPage);
      const guardianPage = await openAs(g.who, null);
      const guardianFrames = await watchWs(guardianPage);
      await guardianPage.goto('/guardian/wards');
      await waitForRealtime(guardianPage);

      await test.step('피보호자가 요청 카드의 [수락]을 누른다', async () => {
        const card = wardPage.getByRole('listitem').filter({ hasText: guardian.name });
        await expect(card).toContainText('(아들)');
        const accepted = wardPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/api/ward/connection/${row.id}/accept`));
        await card.getByRole('button', { name: '수락', exact: true }).click();
        expect((await accepted).status()).toBe(200);
        await expect(wardPage.getByText('요청 수락 완료')).toBeVisible();
        await wardPage.getByRole('button', { name: '확인', exact: true }).click();
        await expect(wardPage.getByText('요청 수락 완료')).toHaveCount(0);
      });

      await test.step('DB: ACTIVE, 연결 시각 기록, 24시간 횟수 초기화', async () => {
        expect(connStatus(row.id)).toBe('ACTIVE');
        expect(psql(`SELECT (connected_at IS NOT NULL)::text FROM connection WHERE id = ${row.id};`), '연결 시각').toBe('true');
        expect(counterValue(guardian.id, ward.id), '수락하면 요청 횟수 키가 지워진다').toBe('');
      });

      await test.step('보호자: 새로고침 없이 연결된 가족으로 바뀌고 수락 신호·알림 이력이 온다', async () => {
        await expect(guardianPage.getByRole('listitem').filter({ hasText: ward.name }), '보호자 화면 목록에 피보호자').toBeVisible();
        expect(frameBodies(guardianFrames, 'connection-accepted').map(f => Number(f.connectionId)), '수락 신호').toEqual([row.id]);
        await expect
          .poll(() => notiRows(guardian.id, 'CONNECTION_ACCEPTED').length, { message: '수락 알림 이력', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        const [noti] = notiRows(guardian.id, 'CONNECTION_ACCEPTED');
        expect(noti.title).toBe('연결 수락');
        expect(noti.body).toBe('피보호자가 연결 요청을 수락했습니다.');
      });

      await test.step('오류 뒤 요청 목록 다시 불러오기 (FEUX-G27): 이미 취소된 요청을 수락하면 409 이고 목록에서 바로 빠진다', async () => {
        expectRes(await call(g2.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, '둘째 보호자 요청');
        const second = connRows(guardian2.id, ward.id)[0];
        const card = wardPage.getByRole('listitem').filter({ hasText: guardian2.name });
        await expect(card).toBeVisible();
        expectRes(await call(g2.api, 'DELETE', `/api/guardian/connection/cancel/${second.id}`), 200, undefined, '둘째 보호자 취소');
        await expect.poll(() => connStatus(second.id)).toBe('CANCELLED');
        await expect(card, '준비: 취소 신호를 막았으니 화면에는 아직 남아 있다').toBeVisible();

        const failed = wardPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/api/ward/connection/${second.id}/accept`));
        await card.getByRole('button', { name: '수락', exact: true }).click();
        const res = await failed;
        expect(res.status(), '취소된 요청 수락').toBe(409);
        expect((await res.json()).code).toBe('CONNECTION_NOT_PENDING');
        await expect(card, '오류 뒤 목록을 다시 불러와 취소된 요청 카드가 사라진다').toHaveCount(0);
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearCounter(guardian2.id, ward.id);
      clearConnRateKeys(guardian.id);
      clearConnRateKeys(guardian2.id);
    }
  });

  test('CONN-N05 보호자가 대기 요청 취소 - 푸시 없이 화면만 갱신', TAGS, async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN', { name: '한보호' });
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    try {
      const wardPage = await openAs(w.who, null);
      const wardFrames = await watchWs(wardPage);
      await wardPage.goto('/ward/guardians');
      await waitForRealtime(wardPage);

      expectRes(await call(g.api, 'POST', REQUEST_API, { targetId: ward.id, relation: '딸' }), 200, undefined, '요청');
      const [row] = connRows(guardian.id, ward.id);
      const card = wardPage.getByRole('listitem').filter({ hasText: guardian.name });
      await expect(card, '받은 요청 목록에 카드가 뜬다').toBeVisible();
      await expect(wardPage.getByText('보호자가 연결을 요청했습니다.'), '요청 알림 토스트').toBeVisible();
      await expect
        .poll(() => notiRows(ward.id).length, { message: '요청 알림 이력 1건이 먼저 쌓인다', timeout: 20_000, intervals: [1000, 2000] })
        .toBe(1);
      const logBefore = notiRows(ward.id).length;

      expectRes(await call(g.api, 'DELETE', `/api/guardian/connection/cancel/${row.id}`), 200, undefined, '취소');
      expect(connStatus(row.id)).toBe('CANCELLED');

      await test.step('피보호자 화면: 새로고침 없이 요청 카드가 사라지고 취소 신호가 온다', async () => {
        await expect(card).toHaveCount(0);
        await expect
          .poll(() => frameBodies(wardFrames, 'connection-request-cancelled').map(f => Number(f.connectionId)), { message: '취소 신호', timeout: 15_000 })
          .toEqual([row.id]);
        await expect.soft(wardPage.getByText('보호자가 연결을 요청했습니다.'), '취소된 요청의 알림 토스트도 닫힌다 (FEUX-G22)').toHaveCount(0);
      });

      await test.step('푸시·문자·알림 이력은 새로 생기지 않는다', async () => {
        // 있으면 안 되는 알림이 늦게 생기는지 3초 동안 여러 번 읽어 본다 (없는 것을 확인하는 단계)
        expect(await maxOver(() => notiRows(ward.id).length, 3_000), '피보호자 알림 이력 수 그대로').toBe(logBefore);
        expect(notiRows(ward.id).every(n => n.type === 'CONNECTION_REQUEST'), '요청 알림 말고 다른 종류가 없다').toBe(true);
        expect(notiRows(guardian.id), '보호자에게도 이력이 없다').toHaveLength(0);
        expect(frameBodies(wardFrames, 'connection-cancelled'), '"연결이 해제되었습니다" 신호(connection-cancelled)는 보내지 않는다').toHaveLength(0);
      });
    } finally {
      clearCounter(guardian.id, ward.id);
      clearConnRateKeys(guardian.id);
    }
  });

  test('CONN-N06 보호자·피보호자 어느 쪽이든 끊으면 상대에게 알림', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const cleanup: { guardianId: string; wardId: string }[] = [];
    const makePair = async (guardianName: string) => {
      const guardian = await tempUser('GUARDIAN', { name: guardianName });
      const ward = await tempUser('WARD');
      psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
            VALUES (${sqlStr(guardian.id)}, ${sqlStr(ward.id)}, 'ACTIVE', ${sqlStr(guardian.id)}, now(), '딸');`);
      cleanup.push({ guardianId: guardian.id, wardId: ward.id });
      return { guardian, ward, g: await loginAs(guardian), w: await loginAs(ward), id: connRows(guardian.id, ward.id)[0].id };
    };
    try {
      await test.step('보호자가 끊으면: 피보호자 화면에 해제 알림, 실시간 신호에 해제한 쪽(GUARDIAN)', async () => {
        const p = await makePair('윤보호');
        const wardPage = await openAs(p.w.who, null);
        const wardFrames = await watchWs(wardPage);
        await wardPage.goto('/ward/guardians');
        await waitForRealtime(wardPage);
        const card = wardPage.getByRole('listitem').filter({ hasText: p.guardian.name });
        await expect(card).toBeVisible();
        const guardianPage = await openAs(p.g.who, '/guardian/wards');
        await guardianPage.getByRole('button', { name: '연결 해제' }).click();
        await expect(guardianPage.getByText('연결을 해제할까요?')).toBeVisible();
        const done = guardianPage.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/api/guardian/connection/disconnection/${p.id}`));
        await guardianPage.getByRole('button', { name: '연결 해제' }).last().click();
        expect((await done).status()).toBe(200);

        expect(connStatus(p.id), '연결 끝남').toBe('DISCONNECTED');
        await expect(card, '피보호자 목록에서 바로 사라진다').toHaveCount(0);
        // 2026-11-16(CONN-N06): 피보호자가 받는 문구에 해제한 쪽을 표시한다(보호자 탈퇴는 단문 유지 - M-2)
        const WARD_BODY = '보호자가 가족 연결을 해제했어요.';
        await expect(wardPage.getByText(WARD_BODY), '피보호자 화면 알림').toBeVisible();
        const frames = frameBodies(wardFrames, 'connection-cancelled');
        expect(frames).toHaveLength(1);
        expect(frames[0].disconnectedBy, '누가 해제했는지').toBe('GUARDIAN');
        expect(frames[0].body).toBe(WARD_BODY);
        await expect
          .poll(() => notiRows(p.ward.id, 'CONNECTION_DISCONNECTED').length, { message: '피보호자 알림 이력', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        // 케이스·CONN-G12: 누가 해제했는지가 사용자 눈에 보여야 한다. 신호의 disconnectedBy 만으로 대신하지 않는다.
        expect(notiRows(p.ward.id, 'CONNECTION_DISCONNECTED')[0].body, '피보호자 알림 문구에 해제한 쪽(보호자)이 표시된다').toBe(WARD_BODY);
        expect(notiRows(p.guardian.id, 'CONNECTION_DISCONNECTED'), '끊은 사람에게는 알림이 가지 않는다').toHaveLength(0);
      });

      await test.step('피보호자가 끊으면: 보호자 화면에 "피보호자가 연결을 해제했습니다", 실시간 신호에 해제한 쪽(WARD)', async () => {
        const p = await makePair('강보호');
        const guardianPage = await openAs(p.g.who, null);
        const guardianFrames = await watchWs(guardianPage);
        await guardianPage.goto('/guardian/wards');
        await waitForRealtime(guardianPage);
        const card = guardianPage.getByRole('listitem').filter({ hasText: p.ward.name });
        await expect(card).toBeVisible();
        const wardPage = await openAs(p.w.who, '/ward/guardians');
        await wardPage.getByRole('button', { name: '연결 끊기' }).click();
        const done = wardPage.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/api/ward/connection/disconnection/${p.id}`));
        await wardPage.getByRole('button', { name: '끊기', exact: true }).click();
        expect((await done).status()).toBe(200);
        await expect(wardPage.getByText('연결 해제 완료')).toBeVisible();

        expect(connStatus(p.id)).toBe('DISCONNECTED');
        await expect(card, '보호자 목록에서 바로 사라진다').toHaveCount(0);
        await expect(guardianPage.getByText('피보호자가 연결을 해제했습니다.'), '보호자 화면 알림').toBeVisible();
        const frames = frameBodies(guardianFrames, 'connection-cancelled');
        expect(frames).toHaveLength(1);
        expect(frames[0].disconnectedBy, '누가 해제했는지').toBe('WARD');
        await expect
          .poll(() => notiRows(p.guardian.id, 'CONNECTION_DISCONNECTED').length, { message: '보호자 알림 이력', timeout: 20_000, intervals: [1000, 2000] })
          .toBe(1);
        expect(notiRows(p.guardian.id, 'CONNECTION_DISCONNECTED')[0].body).toBe('피보호자가 연결을 해제했습니다.');
        expect(notiRows(p.ward.id, 'CONNECTION_DISCONNECTED'), '끊은 사람에게는 알림이 가지 않는다').toHaveLength(0);
      });

      test.info().annotations.push({
        type: '참고 (2026-11-16 CONN-N06 반영)',
        description:
          '피보호자가 받는 알림은 해제한 쪽을 붙인 단문("보호자가 가족 연결을 해제했어요."), 보호자가 받는 알림은 "피보호자가 연결을 해제했습니다."이다. 해제한 쪽은 실시간 신호의 disconnectedBy(GUARDIAN/WARD)로도 전달된다.',
      });
    } finally {
      for (const pair of cleanup) clearCounter(pair.guardianId, pair.wardId);
    }
  });
});
