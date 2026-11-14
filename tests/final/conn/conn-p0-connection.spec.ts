/**
 * 최종 QA - 연결(CONN) P0: N07 목록 노출 범위, N08 해제 즉시 차단, A09 남의 연결 ID(IDOR).
 * 임시 사용자만 쓴다. 연결 요청·수락·해제는 실제 API 로 한다.
 */
import { ADDRESS } from '../../../src/accounts';
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { connect, suppressSosNotify } from '../../../src/variables';
import {
  clearCooldown, connectionId, connectionStatus, createMedication, expectError, idorLogCount, TAGS, waitIdorLog,
} from './_helpers-conn';

type Item = Record<string, unknown>;

const CONTACT_KEYS = [
  'partnerPhone', 'partnerAddress', 'partnerAddressDetail', 'partnerPostcode', 'partnerGender', 'partnerBirthDate', 'partnerEmail',
];
/** 어떤 응답에도 나오면 안 되는 이름(비밀번호·소셜 로그인 내부 정보·권한·계정 상태·마지막 로그인) */
const FORBIDDEN_KEY = /password|provider|role|lastlogin|accountstatus|userstatus|refresh|token|fcm/i;

function allKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach(v => allKeys(v, keys));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      allKeys(v, keys);
    }
  }
  return keys;
}

function expectNoForbidden(label: string, value: unknown) {
  const bad = [...allKeys(value)].filter(k => FORBIDDEN_KEY.test(k));
  expect(bad, `${label}: 노출되면 안 되는 칸`).toEqual([]);
  // 값을 단언에 넣지 않고 일치 여부(boolean)만 단언한다 - 실패해도 비밀번호가 오류 문구·리포트에 찍히지 않는다
  expect(JSON.stringify(value).includes(env.password), `${label}: 비밀번호 값이 응답에 섞이면 안 된다`).toBe(false);
}

test.describe('CONN 연결 P0', () => {
  test('CONN-N07 목록 4종과 상대 정보 노출 범위', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);

    await test.step('보호자가 연결을 요청한다', async () => {
      const res = await g.api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation: '딸' });
      expect(res.status()).toBe(200);
    });

    await test.step('수락 전: 보호자 select·requests 는 연락처가 전부 null', async () => {
      for (const path of ['/api/guardian/connection/select', '/api/guardian/connection/requests']) {
        const list = await g.api.get<Item[]>(path);
        expect(list, path).toHaveLength(1);
        const item = list[0];
        expect(item.status, path).toBe('PENDING');
        expect(item.partnerUserId).toBe(ward.id);
        expect(item.partnerName).toBe(ward.name);
        expect(item.relation).toBe('딸');
        for (const key of CONTACT_KEYS) expect(item[key] ?? null, `${path} ${key}`).toBeNull();
        expect(Number.isNaN(Date.parse(String(item.createdAt))), '요청일은 날짜 형식(표시 시간대는 FE 몫, 서버는 UTC 로 줌)').toBe(false);
        expectNoForbidden(path, list);
      }
    });

    let pendingId = 0;
    await test.step('수락 전: 피보호자 pending 카드는 전화번호를 가리고 최소 정보만 준다', async () => {
      const pending = await w.api.get<Item[]>('/api/ward/connection/pending');
      expect(pending).toHaveLength(1);
      const card = pending[0];
      pendingId = Number(card.connectionId);
      expect(card.guardianId).toBe(guardian.id);
      expect(card.guardianName).toBe(guardian.name);
      expect(card.relation).toBe('딸');
      expect(String(card.guardianPhone).includes('*'), '전화번호는 가려서(값은 리포트에 남기지 않는다)').toBe(true);
      expect(String(card.guardianPhone) === guardian.phone, '가린 번호가 실제 번호와 같으면 안 된다').toBe(false);
      expect(card.guardianProfileImage ?? null, '사진이 없으면 null').toBeNull();
      expect(Number.isNaN(Date.parse(String(card.requestedAt)))).toBe(false);
      const extra = Object.keys(card).filter(
        k => !['connectionId', 'guardianId', 'guardianName', 'guardianProfileImage', 'guardianPhone', 'relation', 'requestedAt'].includes(k),
      );
      expect(extra, '카드에 최소 정보 밖의 칸이 없어야 한다(주소·이메일 등)').toEqual([]);
      expectNoForbidden('pending', pending);

      const active = await w.api.get<Item[]>('/api/ward/connection/active');
      expect(active.length, '수락 전에는 내 보호자 목록이 비어 있다').toBe(0);
    });

    await test.step('피보호자가 수락한다', async () => {
      const res = await w.api.raw('POST', `/api/ward/connection/${pendingId}/accept`);
      expect(res.status()).toBe(200);
    });

    await test.step('수락 후: 보호자는 피보호자 연락처를 본다', async () => {
      const list = await g.api.get<Item[]>('/api/guardian/connection/select');
      expect(list).toHaveLength(1);
      const item = list[0];
      expect(item.status).toBe('ACTIVE');
      expect(item.partnerPhone === ward.phone, '피보호자 전화번호가 그대로 보인다').toBe(true);
      expect(item.partnerEmail === ward.email, '피보호자 이메일이 그대로 보인다').toBe(true);
      expect(item.partnerAddress).toBe(ADDRESS.address);
      expect(item.partnerAddressDetail).toBe(ADDRESS.addressDetail);
      expect(item.partnerPostcode).toBe(ADDRESS.postcode);
      expect(item.partnerGender).toBe('MALE');
      expect(item.partnerBirthDate).toBe('1970-01-01');
      expectNoForbidden('select(수락 후)', list);
    });

    await test.step('수락 후: 피보호자는 보호자 연락처를 보고 pending 은 비어 있다', async () => {
      const active = await w.api.get<Item[]>('/api/ward/connection/active');
      expect(active).toHaveLength(1);
      expect(active[0].status).toBe('ACTIVE');
      expect(active[0].partnerUserId).toBe(guardian.id);
      expect(active[0].partnerPhone === guardian.phone, '보호자 전화번호가 그대로 보인다').toBe(true);
      expect(active[0].partnerEmail === guardian.email, '보호자 이메일이 그대로 보인다').toBe(true);
      expect(active[0].partnerAddress).toBe(ADDRESS.address);
      expectNoForbidden('active', active);
      expect((await w.api.get<Item[]>('/api/ward/connection/pending')).length, '수락했으니 받은 신청이 없다').toBe(0);
    });
  });

  test('CONN-N08 연결 해제 즉시 예전 SOS·복약 기록이 안 보임', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);

    type Card = { wardId: string; medications: { medicationId: number }[] };
    type History = { content: { sosEventId: number; wardId: string }[] };

    const sos = await w.api.raw('POST', '/api/ward/sos', {});
    expect(sos.status()).toBe(201);
    const medicationId = await createMedication(g.api, ward.id);

    await test.step('해제 전: 보호자는 SOS 이력과 복약 카드를 본다', async () => {
      const history = await g.api.get<History>('/api/guardian/sos/history?page=0&size=50');
      expect(history.content.filter(i => i.wardId === ward.id)).toHaveLength(1);
      const cards = await g.api.get<Card[]>('/api/guardian/medication');
      const card = cards.find(c => c.wardId === ward.id);
      expect(card, '복약 카드').toBeTruthy();
      expect(card!.medications.map(m => m.medicationId)).toContain(medicationId);
    });

    await test.step('보호자가 연결을 끊는다', async () => {
      const id = connectionId(guardian.id, ward.id);
      const res = await g.api.raw('DELETE', `/api/guardian/connection/disconnection/${id}`);
      expect(res.status()).toBe(200);
      expect(connectionStatus(id)).toBe('DISCONNECTED');
    });

    await test.step('해제 직후: SOS 이력과 복약 정보가 목록에서 사라진다', async () => {
      const history = await g.api.get<History>('/api/guardian/sos/history?page=0&size=50');
      expect(history.content.filter(i => i.wardId === ward.id), '이력이 즉시 안 보여야 한다').toHaveLength(0);
      const cards = await g.api.get<Card[]>('/api/guardian/medication');
      expect(cards.find(c => c.wardId === ward.id), '복약 카드가 즉시 사라져야 한다').toBeUndefined();
      await expectError(await g.api.raw('GET', `/api/guardian/sos/history?wardId=${ward.id}`), 403, 'SOS_NOT_AUTHORIZED', '해제된 wardId 이력');
    });

    await test.step('피보호자 자신의 복약 화면은 영향이 없다(자기 약은 계속 보인다)', async () => {
      const today = await w.api.get<{ medications: { medicationId: number }[] }>('/api/ward/medication/today');
      expect(today.medications.map(m => m.medicationId)).toContain(medicationId);
    });
    clearCooldown(ward.id);
  });

  test('CONN-A09 남의 연결 ID로 수락·거절·취소·해제 (IDOR)', TAGS, async ({ tempUser, loginAs }) => {
    // 연결 A: 보호자 gA - 피보호자 wA (수락 대기), 연결 B: 보호자 gB - 피보호자 wB (연결됨)
    const gA = await tempUser('GUARDIAN');
    const wA = await tempUser('WARD');
    const gB = await tempUser('GUARDIAN');
    const wB = await tempUser('WARD');
    // 관련 없는 공격자 보호자·피보호자
    const atkG = await tempUser('GUARDIAN');
    const atkW = await tempUser('WARD');
    connect(gB.id, wB.id);

    const ga = await loginAs(gA);
    const atkGuardian = await loginAs(atkG);
    const atkWard = await loginAs(atkW);
    await loginAs(wA);
    expect((await ga.api.raw('POST', '/api/guardian/connection/request', { targetId: wA.id, relation: '아들' })).status()).toBe(200);

    const pendingId = connectionId(gA.id, wA.id);
    const activeId = connectionId(gB.id, wB.id);
    expect(connectionStatus(pendingId)).toBe('PENDING');
    expect(connectionStatus(activeId)).toBe('ACTIVE');

    await test.step('공격자 보호자: 남의 요청 취소·남의 연결 해제는 403 CONNECTION_NOT_AUTHORIZED', async () => {
      await expectError(await atkGuardian.api.raw('DELETE', `/api/guardian/connection/cancel/${pendingId}`), 403, 'CONNECTION_NOT_AUTHORIZED', '취소');
      await expectError(await atkGuardian.api.raw('DELETE', `/api/guardian/connection/disconnection/${activeId}`), 403, 'CONNECTION_NOT_AUTHORIZED', '보호자 해제');
    });

    await test.step('공격자 피보호자: 남에게 온 요청 수락·거절, 남의 연결 해제는 403 CONNECTION_NOT_OWNED', async () => {
      await expectError(await atkWard.api.raw('POST', `/api/ward/connection/${pendingId}/accept`), 403, 'CONNECTION_NOT_OWNED', '수락');
      await expectError(await atkWard.api.raw('DELETE', `/api/ward/connection/request/${pendingId}/refusal`), 403, 'CONNECTION_NOT_OWNED', '거절');
      await expectError(await atkWard.api.raw('DELETE', `/api/ward/connection/disconnection/${activeId}`), 403, 'CONNECTION_NOT_OWNED', '피보호자 해제');
    });

    await test.step('상태가 하나도 바뀌지 않았다', async () => {
      expect(connectionStatus(pendingId)).toBe('PENDING');
      expect(connectionStatus(activeId)).toBe('ACTIVE');
    });

    await test.step('없는 연결 ID 는 404 CONNECTION_NOT_FOUND', async () => {
      await expectError(await atkGuardian.api.raw('DELETE', '/api/guardian/connection/cancel/2147483000'), 404, 'CONNECTION_NOT_FOUND', '없는 ID 취소');
      await expectError(await atkWard.api.raw('POST', '/api/ward/connection/2147483000/accept'), 404, 'CONNECTION_NOT_FOUND', '없는 ID 수락');
    });

    await test.step('시도가 [IDOR-ATTEMPT] 로그에 남는다', async () => {
      await waitIdorLog('guardianId', atkG.id, 2);
      await waitIdorLog('wardId', atkW.id, 3);
      expect(idorLogCount('guardianId', gA.id), '정당한 사용자는 IDOR 로그가 없다').toBe(0);
    });
  });
});
