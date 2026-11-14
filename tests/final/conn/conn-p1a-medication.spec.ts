/**
 * 최종 QA - 복약 등록·수정·삭제(CONN) P1a: A29 A30 A32 N26 N27 N29 N28.
 *
 * 임시 보호자·임시 피보호자만 쓴다. 약·복용 이력·알림 기록은 임시 피보호자가 지워질 때 함께 지워진다(CASCADE).
 * 약 이름은 [QA-P1a] 로 시작해 서버 로그에서도 알아볼 수 있게 한다. 시각 규칙은 서버 시계를 못 바꾸므로 "지금" 기준으로 만든다.
 */
import { APIResponse } from '@playwright/test';

import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { TempUser, TempUserOptions } from '../../../src/seed';
import { connect } from '../../../src/variables';
import { read } from './_helpers-conn';
import {
  clockSafe, insertMedicationRow, kstHm, kstTime, medCountOf, medRow, rawCall, reminderLogCount, TAGS,
} from './_helpers-conn-p1a';

type Api = { raw: (m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string, d?: unknown) => Promise<APIResponse> };

interface MedItem {
  medicationId: number;
  name: string;
  timeSlot: string;
  doseTime: string;
  doseAmount: number;
  memo: string | null;
  taken: boolean;
}

const url = (wardId: string) => `/api/guardian/ward/${wardId}/medication`;

async function create(api: Api, wardId: string, body: Record<string, unknown>) {
  return read(await api.raw('POST', url(wardId), body));
}
async function createBatch(api: Api, wardId: string, body: Record<string, unknown>) {
  return read(await api.raw('POST', `${url(wardId)}/batch`, body));
}

async function pair(tempUser: (role: TempUser['role'], options?: TempUserOptions) => Promise<TempUser>) {
  const guardian = await tempUser('GUARDIAN', { phone: null });
  const ward = await tempUser('WARD', { phone: null });
  connect(guardian.id, ward.id);
  return { guardian, ward };
}

test.describe('CONN 복약 P1a', () => {
  test('CONN-A29 이름·메모 검증', TAGS, async ({ tempUser, loginAs }) => {
    const { guardian, ward } = await pair(tempUser);
    const g = await loginAs(guardian);
    const base = { name: '[QA-P1a] 혈압약', timeSlot: 'MORNING' };

    await test.step('잘못된 이름·메모는 400(500 아님)이고 저장되지 않는다', async () => {
      const invalid: { label: string; body: Record<string, unknown> }[] = [
        { label: '이름 빈 값', body: { ...base, name: '' } },
        { label: '이름 공백만', body: { ...base, name: '   ' } },
        { label: '이름 NBSP 만', body: { ...base, name: '  ' } },
        { label: '이름 제로폭 공백만', body: { ...base, name: '​​' } },
        { label: '이름 BOM 만', body: { ...base, name: '﻿' } },
        { label: '이름 NUL 문자', body: { ...base, name: 'a\u0000b' } },
        { label: '이름 101자', body: { ...base, name: '가'.repeat(101) } },
        { label: '이름 없음', body: { timeSlot: 'MORNING' } },
        { label: '메모 101자', body: { ...base, memo: '나'.repeat(101) } },
        { label: '메모 NUL 문자', body: { ...base, memo: 'a\u0000b' } },
        { label: '시간대 없음', body: { name: base.name } },
        { label: '시간대 허용 외', body: { ...base, timeSlot: 'NOON' } },
      ];
      for (const item of invalid) {
        const r = await create(g.api, ward.id, item.body);
        expect(r.status, `${item.label}: 상태 코드`).toBe(400);
        expect(r.body.success, `${item.label}: success`).toBe(false);
      }
      expect(medCountOf(ward.id, true), '잘못된 입력으로 저장된 약').toBe(0);
    });

    await test.step('경계값: 이름 100자·메모 100자까지 허용하고 앞뒤 공백은 정리', async () => {
      const max = await create(g.api, ward.id, { ...base, name: '가'.repeat(100), memo: '나'.repeat(100) });
      expect(max.status, '이름·메모 100자').toBe(200);
      const item = max.body.data as MedItem;
      expect(Array.from(item.name)).toHaveLength(100);
      expect(Array.from(item.memo ?? '')).toHaveLength(100);

      const spaced = await create(g.api, ward.id, { ...base, name: '  약   이름  ', memo: '  식후   30분  ' });
      expect(spaced.status).toBe(200);
      const saved = medRow((spaced.body.data as MedItem).medicationId)!;
      expect(saved.name, '이름은 앞뒤 공백 정리·가운데 공백 하나').toBe('약 이름');
      expect(saved.memo, '메모도 정리').toBe('식후 30분');

      const blankMemo = await create(g.api, ward.id, { ...base, memo: '   ' });
      expect(blankMemo.status).toBe(200);
      expect(medRow((blankMemo.body.data as MedItem).medicationId)!.memo, '공백뿐인 메모는 메모 없음').toBe('<null>');
    });

    await test.step('수정에서도 같은 규칙', async () => {
      const first = (await create(g.api, ward.id, base)).body.data as MedItem;
      for (const [label, body] of [
        ['이름 제로폭 공백만', { name: '​' }],
        ['이름 NUL 문자', { name: 'a\u0000b' }],
        ['이름 101자', { name: '가'.repeat(101) }],
        ['메모 101자', { memo: '나'.repeat(101) }],
      ] as const) {
        const r = await read(await g.api.raw('PATCH', `/api/guardian/medication/${first.medicationId}`, body));
        expect(r.status, `수정 ${label}`).toBe(400);
      }
      expect(medRow(first.medicationId)!.name, '거부된 수정은 반영되지 않는다').toBe(base.name);
    });
  });

  test('CONN-A30 복용량 경계값', TAGS, async ({ tempUser, loginAs }) => {
    const { guardian, ward } = await pair(tempUser);
    const g = await loginAs(guardian);
    const body = (doseAmount: unknown) => ({ name: '[QA-P1a] 용량', timeSlot: 'MORNING', doseAmount });

    await test.step('허용: 0.5 배수이고 0.5~99', async () => {
      for (const amount of [0.5, 1, 1.5, 2, 99]) {
        const res = await g.api.raw('POST', url(ward.id), body(amount));
        const r = await read(res);
        expect(r.status, `doseAmount=${amount}`).toBe(200);
        expect((r.body.data as MedItem).doseAmount, `응답 값 ${amount}`).toBe(amount);
        const stored = medRow((r.body.data as MedItem).medicationId)!;
        expect(Number(stored.amount), `저장된 값 ${amount}`).toBe(amount);
        expect(new RegExp(`"doseAmount":${amount}[,}]`).test(r.text), `응답 글자가 ${amount} 그대로다`).toBe(true);
        expect(r.text.includes(`"doseAmount":${amount}.0`), `응답 글자에 ${amount}.0 같은 소수점 꼴이 없다`).toBe(false);
      }
    });

    await test.step('거부: 0·0.3·1.2·99.5·100 등은 400', async () => {
      for (const amount of [0, 0.3, 1.2, 0.25, 99.5, 100, -1, -0.5, 1000]) {
        const r = await read(await g.api.raw('POST', url(ward.id), body(amount)));
        expect(r.status, `doseAmount=${amount}`).toBe(400);
      }
      for (const amount of ['abc', '1,5', true, [1], {}]) {
        const r = await read(await g.api.raw('POST', url(ward.id), body(amount)));
        expect(r.status, `doseAmount=${JSON.stringify(amount)} (숫자가 아님)`).toBe(400);
      }
      expect(medCountOf(ward.id), '허용된 5건만 저장').toBe(5);
      // 관찰: 빈 문자열은 "안 보냄"으로 읽혀 기본값 1로 등록된다(문서에 규칙 없음)
      const empty = await read(await g.api.raw('POST', url(ward.id), body('')));
      test.info().annotations.push({
        type: '관찰',
        description: `doseAmount="" (빈 문자열) -> ${empty.status}${empty.status === 200 ? `, 저장된 용량 ${(empty.body.data as MedItem).doseAmount}` : ''}`,
      });
    });

    await test.step('수정에서도 같은 규칙, 안 보내면 그대로', async () => {
      const made = (await create(g.api, ward.id, { name: '[QA-P1a] 수정용량', timeSlot: 'LUNCH', doseAmount: 2 })).body.data as MedItem;
      const patch = (data: unknown) => g.api.raw('PATCH', `/api/guardian/medication/${made.medicationId}`, data);
      for (const amount of [0, 0.3, 1.2, 99.5, 100]) expect((await patch({ doseAmount: amount })).status(), `수정 doseAmount=${amount}`).toBe(400);
      expect(Number(medRow(made.medicationId)!.amount), '거부된 수정은 반영되지 않는다').toBe(2);
      expect((await patch({ doseAmount: 0.5 })).status()).toBe(200);
      expect(Number(medRow(made.medicationId)!.amount)).toBe(0.5);
      expect((await patch({ name: '[QA-P1a] 이름만' })).status()).toBe(200);
      expect(Number(medRow(made.medicationId)!.amount), '용량을 안 보내면 그대로').toBe(0.5);
    });

    test.info().annotations.push({
      type: '문서와 다른 점',
      description: '케이스의 "화면은 빈 칸 허용 후 저장 때 1~99 검사, 지우고 2 입력하면 2정"은 예전 입력칸 화면 얘기다. FE a8666240 의 약 추가·수정 화면은 입력칸이 아니라 줄이기·늘리기 버튼(0.5 단위)이라 그 흐름이 없다. 서버 규칙(0.5 배수·0.5~99)만 확인했다.',
    });
  });

  test('CONN-A32 일괄 등록 범위·중복·롤백', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(150_000);
    const { guardian, ward } = await pair(tempUser);
    const g = await loginAs(guardian);
    const drug = (i: number) => ({ name: `[QA-P1a] 약${i}` });
    const drugs = (n: number) => Array.from({ length: n }, (_, i) => drug(i + 1));
    const times = (list: string[]) => list.map(doseTime => ({ doseTime }));
    const six = ['06:00:00', '08:00:00', '12:00:00', '15:00:00', '18:00:00', '22:00:00'];

    await test.step('범위 밖은 400: drugs 0·21개, times 0·7개', async () => {
      const cases: [string, Record<string, unknown>][] = [
        ['drugs 0개', { drugs: [], times: times(['08:00:00']) }],
        ['drugs 21개', { drugs: drugs(21), times: times(['08:00:00']) }],
        ['times 0개', { drugs: drugs(1), times: [] }],
        ['times 7개', { drugs: drugs(1), times: times([...six, '23:00:00']) }],
        ['drugs 없음', { times: times(['08:00:00']) }],
        ['times 없음', { drugs: drugs(1) }],
      ];
      for (const [label, data] of cases) {
        const r = await createBatch(g.api, ward.id, data);
        expect(r.status, label).toBe(400);
      }
      expect(medCountOf(ward.id, true), '범위 밖 요청으로 저장된 약').toBe(0);
    });

    await test.step('같은 이름·같은 시각 중복은 400 코드로 구분', async () => {
      const dupName = await createBatch(g.api, ward.id, { drugs: [{ name: '[QA-P1a] 같은약' }, { name: '[QA-P1a] 같은약' }], times: times(['08:00:00']) });
      expect(dupName.status).toBe(400);
      expect(dupName.body.code).toBe('MEDICATION_BATCH_DUPLICATE_NAME');
      const dupNameCase = await createBatch(g.api, ward.id, { drugs: [{ name: 'Tylenol' }, { name: ' tylenol ' }], times: times(['08:00:00']) });
      expect(dupNameCase.status, '대소문자·앞뒤 공백만 다른 이름도 같은 이름').toBe(400);
      expect(dupNameCase.body.code).toBe('MEDICATION_BATCH_DUPLICATE_NAME');
      const dupTime = await createBatch(g.api, ward.id, { drugs: drugs(2), times: times(['08:00:00', '08:00:00']) });
      expect(dupTime.status).toBe(400);
      expect(dupTime.body.code).toBe('MEDICATION_BATCH_DUPLICATE_TIME');
      expect(medCountOf(ward.id, true), '중복 요청으로 저장된 약').toBe(0);
    });

    await test.step('중간 약만 오류여도 하나도 저장되지 않는다(전부 취소)', async () => {
      const middleBad: [string, Record<string, unknown>[]][] = [
        ['이름 제로폭 공백만', [drug(1), { name: '​' }, drug(3)]],
        ['이름 101자', [drug(1), { name: '가'.repeat(101) }, drug(3)]],
        ['복용량 1.2', [drug(1), { name: '[QA-P1a] 약2', doseAmount: 1.2 }, drug(3)]],
        ['약 항목이 null', [drug(1), null as never, drug(3)]],
      ];
      for (const [label, list] of middleBad) {
        const r = await createBatch(g.api, ward.id, { drugs: list, times: times(['08:00:00', '13:00:00']) });
        expect(r.status, label).toBe(400);
        expect(medCountOf(ward.id, true), `${label}: 앞의 약도 저장되면 안 된다`).toBe(0);
      }
      const noConnection = await createBatch(await loginAs(await tempUser('GUARDIAN', { phone: null })).then(l => l.api), ward.id, { drugs: drugs(2), times: times(['08:00:00']) });
      expect(noConnection.status, '연결 안 된 보호자').toBe(403);
      expect(medCountOf(ward.id, true)).toBe(0);
    });

    await test.step('경계 안은 성공: 20종 x 1시각, 1종 x 6시각', async () => {
      const r1 = await createBatch(g.api, ward.id, { drugs: drugs(20), times: times(['08:00:00']) });
      expect(r1.status).toBe(200);
      expect((r1.body.data as MedItem[]).length).toBe(20);
      expect(medCountOf(ward.id)).toBe(20);
      const r2 = await createBatch(g.api, ward.id, { drugs: [{ name: '[QA-P1a] 여섯시각' }], times: times(six) });
      expect(r2.status).toBe(200);
      expect((r2.body.data as MedItem[]).length).toBe(6);
      expect(medCountOf(ward.id)).toBe(26);
    });
  });

  test('CONN-N26 보호자 단건 약 등록', TAGS, async ({ tempUser, loginAs }) => {
    const { guardian, ward } = await pair(tempUser);
    const g = await loginAs(guardian);

    await test.step('시각을 생략하면 시간대 기본 시각', async () => {
      const defaults: [string, string][] = [['MORNING', '08:00:00'], ['LUNCH', '13:00:00'], ['DINNER', '18:00:00'], ['BEDTIME', '22:00:00']];
      for (const [slot, time] of defaults) {
        const r = await create(g.api, ward.id, { name: `[QA-P1a] ${slot}`, timeSlot: slot });
        expect(r.status, slot).toBe(200);
        const item = r.body.data as MedItem;
        expect(item.timeSlot).toBe(slot);
        expect(item.doseTime, `${slot} 기본 시각`).toBe(time);
        const row = medRow(item.medicationId)!;
        expect(row.dose).toBe(time);
        expect(row.createdBy, '등록자').toBe(guardian.id);
        expect(row.wardId).toBe(ward.id);
      }
    });

    await test.step('복용량 생략은 1, 응답은 1·0.5 꼴(1.0 아님)', async () => {
      const dflt = await create(g.api, ward.id, { name: '[QA-P1a] 기본량', timeSlot: 'MORNING' });
      expect((dflt.body.data as MedItem).doseAmount).toBe(1);
      expect(dflt.text.includes('"doseAmount":1,') || dflt.text.includes('"doseAmount":1}'), '응답 글자는 1 (1.0 이 아님)').toBe(true);
      expect(dflt.text.includes('"doseAmount":1.0'), '1.0 꼴이 나오면 안 된다').toBe(false);
      expect(Number(medRow((dflt.body.data as MedItem).medicationId)!.amount)).toBe(1);
      const half = await create(g.api, ward.id, { name: '[QA-P1a] 반알', timeSlot: 'MORNING', doseAmount: 0.5 });
      expect((half.body.data as MedItem).doseAmount).toBe(0.5);
      expect(half.text.includes('"doseAmount":0.5')).toBe(true);
    });

    await test.step('시각을 주면 그 시각으로 저장되고 시간대는 시각으로 정해진다', async () => {
      const r = await create(g.api, ward.id, { name: '[QA-P1a] 시각지정', timeSlot: 'MORNING', doseTime: '19:30:00' });
      expect(r.status).toBe(200);
      const item = r.body.data as MedItem;
      expect(item.doseTime).toBe('19:30:00');
      expect(item.timeSlot, '19시 30분은 저녁').toBe('DINNER');
    });

    await test.step('보호자 현황 목록에 등록한 약이 보인다', async () => {
      const list = await read(await g.api.raw('GET', '/api/guardian/medication'));
      expect(list.status).toBe(200);
      const card = (list.body.data as { wardId: string; totalCount: number; medications: MedItem[] }[]).find(c => c.wardId === ward.id)!;
      expect(card.medications.length, '등록한 7건').toBe(7);
      expect(card.medications.every(m => m.taken === false)).toBe(true);
    });

    test.info().annotations.push({
      type: '범위',
      description: '화면(MED-G03 시간대만 바꾸면 시각도 기본값으로, MED-G09 용량 입력)은 FE a8666240 의 약 추가·수정 화면이 버튼식으로 바뀌어 이 케이스에서 화면으로 확인하지 않았다. 서버 규칙만 확인.',
    });
  });

  test('CONN-N27 일괄 등록 약 x 시각, 시간대 서버 판정', TAGS, async ({ tempUser, loginAs }) => {
    const { guardian, ward } = await pair(tempUser);
    const g = await loginAs(guardian);
    const rowsOf = (name: string) =>
      psql(`SELECT string_agg(dose_time::text || '=' || time_slot, ',' ORDER BY dose_time) FROM medication WHERE ward_id = ${sqlStr(ward.id)} AND name = ${sqlStr(name)};`);

    await test.step('약 2개 x 시각 3개 = 6건, 이미 있는 약과 이름이 같아도 허용', async () => {
      const pre = await create(g.api, ward.id, { name: '[QA-P1a] 약A', timeSlot: 'MORNING' });
      expect(pre.status).toBe(200);
      const r = await createBatch(g.api, ward.id, {
        drugs: [{ name: '[QA-P1a] 약A' }, { name: '[QA-P1a] 약B', doseAmount: 0.5 }],
        times: [{ doseTime: '18:00:00' }, { doseTime: '08:00:00' }, { doseTime: '13:00:00' }],
        memo: '식후 30분',
      });
      expect(r.status).toBe(200);
      const items = r.body.data as MedItem[];
      expect(items, '약 x 시각').toHaveLength(6);
      expect(items.map(i => i.doseTime), '시각 순서로 저장').toEqual(['08:00:00', '08:00:00', '13:00:00', '13:00:00', '18:00:00', '18:00:00']);
      expect(rowsOf('[QA-P1a] 약A'), '이미 있던 약과 같은 이름이어도 새로 3건').toBe('08:00:00=MORNING,08:00:00=MORNING,13:00:00=LUNCH,18:00:00=DINNER');
      expect(rowsOf('[QA-P1a] 약B')).toBe('08:00:00=MORNING,13:00:00=LUNCH,18:00:00=DINNER');
      expect(medCountOf(ward.id), '전체 7건').toBe(7);
      const b = items.filter(i => i.name === '[QA-P1a] 약B');
      expect(b.map(i => i.doseAmount), '복용량').toEqual([0.5, 0.5, 0.5]);
      expect(items.find(i => i.name === '[QA-P1a] 약A')!.doseAmount, '생략하면 1').toBe(1);
      expect(items.every(i => i.memo === '식후 30분'), '메모는 모든 약에 붙는다').toBe(true);
    });

    await test.step('시간대 경계: 03:59 취침전 / 04:00·10:59 아침 / 11:00·15:59 점심 / 16:00 저녁', async () => {
      const r = await createBatch(g.api, ward.id, {
        drugs: [{ name: '[QA-P1a] 경계A' }],
        times: ['03:59:00', '04:00:00', '10:59:00', '11:00:00', '15:59:00', '16:00:00'].map(doseTime => ({ doseTime })),
      });
      expect(r.status).toBe(200);
      expect(rowsOf('[QA-P1a] 경계A')).toBe(
        '03:59:00=BEDTIME,04:00:00=MORNING,10:59:00=MORNING,11:00:00=LUNCH,15:59:00=LUNCH,16:00:00=DINNER',
      );
      const r2 = await createBatch(g.api, ward.id, {
        drugs: [{ name: '[QA-P1a] 경계B' }],
        times: ['20:59:00', '21:00:00', '00:00:00'].map(doseTime => ({ doseTime })),
      });
      expect(r2.status).toBe(200);
      expect(rowsOf('[QA-P1a] 경계B')).toBe('00:00:00=BEDTIME,20:59:00=DINNER,21:00:00=BEDTIME');
    });

    await test.step('한 요청은 한 트랜잭션: 같은 요청 안에서 하나가 틀리면 전부 취소', async () => {
      const before = medCountOf(ward.id, true);
      const bad = await createBatch(g.api, ward.id, {
        drugs: [{ name: '[QA-P1a] 취소A' }, { name: '[QA-P1a] 취소A' }],
        times: [{ doseTime: '08:00:00' }],
      });
      expect(bad.status).toBe(400);
      expect(medCountOf(ward.id, true), '실패한 요청은 하나도 저장되지 않는다').toBe(before);
    });
  });

  test('CONN-N29 단건·여러 건 삭제는 soft delete', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(180_000);
    const { guardian: g1u, ward } = await pair(tempUser);
    const g2u = await tempUser('GUARDIAN', { phone: null });
    const outsiderU = await tempUser('GUARDIAN', { phone: null });
    const otherWard = await tempUser('WARD', { phone: null });
    connect(g2u.id, ward.id);
    connect(g1u.id, otherWard.id);
    const [g1, g2, outsider, w] = [await loginAs(g1u), await loginAs(g2u), await loginAs(outsiderU), await loginAs(ward)];
    const make = async (name: string, slot: string, doseTime: string) =>
      ((await create(g1.api, ward.id, { name: `[QA-P1a] ${name}`, timeSlot: slot, doseTime })).body.data as MedItem).medicationId;
    const del = (api: Api, id: number) => api.raw('DELETE', `/api/guardian/medication/${id}`);
    const batch = async (api: Api, wardId: string, ids: unknown) => read(await api.raw('POST', `${url(wardId)}/delete-batch`, { medicationIds: ids }));
    const intakeCount = (id: number) => Number(psql(`SELECT count(*) FROM medication_intake WHERE medication_id = ${id};`));
    const alive = (id: number) => medRow(id)?.deleted === false;

    const m1 = await make('아침1', 'MORNING', '08:00:00');
    const m2 = await make('아침2', 'MORNING', '08:30:00');
    const m3 = await make('점심', 'LUNCH', '13:00:00');
    const m4 = await make('저녁', 'DINNER', '18:00:00');
    const m5 = await make('취침', 'BEDTIME', '22:00:00');
    const foreign = ((await create(g1.api, otherWard.id, { name: '[QA-P1a] 다른사람', timeSlot: 'MORNING' })).body.data as MedItem).medicationId;

    await test.step('피보호자가 먹었다고 체크해 복용 이력을 만든다', async () => {
      const r = await w.api.raw('POST', `/api/ward/medication/${m1}/intake`);
      expect(r.status(), '복용 체크').toBe(200);
      expect(intakeCount(m1)).toBe(1);
    });

    await test.step('단건 삭제: 목록에서만 사라지고 복용 이력은 남는다', async () => {
      const r = await read(await del(g1.api, m1));
      expect(r.status).toBe(200);
      const row = medRow(m1)!;
      expect(row.deleted, '행은 남고 삭제 표시만').toBe(true);
      expect(intakeCount(m1), '복용 이력 유지').toBe(1);
      const list = await read(await g1.api.raw('GET', '/api/guardian/medication'));
      const card = (list.body.data as { wardId: string; medications: MedItem[] }[]).find(c => c.wardId === ward.id)!;
      expect(card.medications.map(m => m.medicationId), '보호자 목록에서 사라짐').not.toContain(m1);
      const today = await read(await w.api.raw('GET', '/api/ward/medication/today'));
      expect((today.body.data as { medications: MedItem[] }).medications.map(m => m.medicationId), '피보호자 오늘 목록에서도 사라짐').not.toContain(m1);
      const again = await read(await del(g1.api, m1));
      expect(again.status, '이미 지운 약을 또 지우면').toBe(404);
      expect(again.body.code).toBe('MEDICATION_NOT_FOUND');
    });

    await test.step('등록자가 아니어도 연결된 보호자면 삭제 가능, 연결 안 된 보호자는 403', async () => {
      expect((await del(g2.api, m4)).status(), '다른 연결 보호자').toBe(200);
      expect(medRow(m4)!.deleted).toBe(true);
      const denied = await read(await del(outsider.api, m5));
      expect(denied.status, '연결 안 된 보호자').toBe(403);
      expect(denied.body.code).toBe('MEDICATION_NOT_AUTHORIZED');
      expect(alive(m5)).toBe(true);
    });

    await test.step('delete-batch: 아침 약 삭제, 이미 지워진 약은 건너뛰고 성공, 방금 추가한 약은 지우지 않음', async () => {
      const list = await read(await g1.api.raw('GET', '/api/guardian/medication'));
      const card = (list.body.data as { wardId: string; medications: MedItem[] }[]).find(c => c.wardId === ward.id)!;
      const mornings = card.medications.filter(m => m.timeSlot === 'MORNING').map(m => m.medicationId);
      expect(mornings).toEqual([m2]);
      const justAdded = await make('방금추가한아침', 'MORNING', '09:00:00');
      const r = await batch(g1.api, ward.id, [...mornings, m1]);
      expect(r.status).toBe(200);
      expect(r.body.data, '실제로 지운 개수(이미 지워진 m1 은 건너뜀)').toBe(1);
      expect(medRow(m2)!.deleted).toBe(true);
      expect(alive(justAdded), '화면에 없던(방금 추가된) 약은 그대로').toBe(true);
      expect(intakeCount(m1)).toBe(1);
      expect(await batch(g1.api, ward.id, [m1]).then(x => x.status), '모두 이미 지운 약만 보내도 성공').toBe(200);
    });

    await test.step('전부 아니면 전무: 남의 약·없는 약이 섞이면 아무것도 지우지 않는다', async () => {
      const idor = await batch(g1.api, ward.id, [m3, foreign]);
      expect(idor.status, '다른 피보호자의 약이 섞임').toBe(403);
      expect(idor.body.code).toBe('MEDICATION_NOT_AUTHORIZED');
      expect(alive(m3), '앞의 약도 지워지지 않았다').toBe(true);
      expect(alive(foreign)).toBe(true);
      const missing = await batch(g1.api, ward.id, [m3, 999_999_999]);
      expect(missing.status, '없는 약').toBe(404);
      expect(alive(m3)).toBe(true);
      const dup = await batch(g1.api, ward.id, [m3, m3]);
      expect(dup.status).toBe(400);
      expect(dup.body.code).toBe('MEDICATION_DELETE_BATCH_DUPLICATE');
      expect((await batch(g1.api, ward.id, [])).status, '빈 목록').toBe(400);
      expect((await batch(g1.api, ward.id, Array.from({ length: 101 }, (_, i) => i + 1))).status, '101개').toBe(400);
      expect((await batch(outsider.api, ward.id, [m3])).status, '연결 안 된 보호자').toBe(403);
      expect(alive(m3)).toBe(true);
      const ok = await batch(g2.api, ward.id, [m3, m5]);
      expect(ok.status, '다른 연결 보호자가 여러 건 삭제').toBe(200);
      expect(ok.body.data).toBe(2);
      expect(medRow(m3)!.deleted && medRow(m5)!.deleted).toBe(true);
    });

    test.info().annotations.push({
      type: '범위',
      description: '화면의 삭제 실패 원인 안내(FEUX-G21)는 이 케이스에서 화면으로 확인하지 않았다(API 규칙만).',
    });
    void rawCall;
  });

  test('CONN-N28 약 수정 규칙(시간대·메모·시각)', TAGS, async ({ tempUser, loginAs }) => {
    test.skip(!clockSafe(25, 130), '자정 앞뒤에는 "지금 + 2시간" 시각이 하루를 넘어 시나리오가 틀어져 건너뜀');
    test.setTimeout(330_000);
    const { guardian, ward } = await pair(tempUser);
    const g = await loginAs(guardian);
    const patch = (id: number, data: unknown) => g.api.raw('PATCH', `/api/guardian/medication/${id}`, data);
    const made = (await create(g.api, ward.id, { name: '[QA-P1a] 수정대상', timeSlot: 'MORNING', memo: '처음 메모' })).body.data as MedItem;
    const id = made.medicationId;

    await test.step('시간대만 저녁으로 바꾸면 새 시간대 기본 시각', async () => {
      expect(made.doseTime).toBe('08:00:00');
      const r = await read(await patch(id, { timeSlot: 'DINNER' }));
      expect(r.status).toBe(200);
      expect((r.body.data as MedItem).doseTime, '08:00 이 "저녁 08:00" 으로 남으면 안 된다').toBe('18:00:00');
      expect((r.body.data as MedItem).timeSlot).toBe('DINNER');
      const row = medRow(id)!;
      expect(`${row.dose}|${row.slot}`).toBe('18:00:00|DINNER');
    });

    await test.step('시각을 바꾸면 시간대도 그 시각으로 정해진다', async () => {
      const r = await read(await patch(id, { doseTime: '12:30:00' }));
      expect(r.status).toBe(200);
      const row = medRow(id)!;
      expect(`${row.dose}|${row.slot}`).toBe('12:30:00|LUNCH');
    });

    await test.step('메모: 빈 칸은 지움, 안 보내면 그대로', async () => {
      expect(medRow(id)!.memo, '시작 메모').toBe('처음 메모');
      expect((await patch(id, { name: '[QA-P1a] 이름만 바꿈' })).status()).toBe(200);
      expect(medRow(id)!.memo, '메모를 안 보내면 그대로').toBe('처음 메모');
      expect((await patch(id, {})).status(), '아무것도 안 보냄').toBe(200);
      expect(medRow(id)!.memo, '빈 본문은 그대로 두기').toBe('처음 메모');
      expect((await patch(id, { memo: '' })).status()).toBe(200);
      expect(medRow(id)!.memo, '빈 칸을 보내면 메모 지움').toBe('<null>');
      expect((await patch(id, { memo: '   ' })).status()).toBe(200);
      expect(medRow(id)!.memo, '공백뿐이어도 메모 없음').toBe('<null>');
    });

    await test.step('이름·메모 앞뒤 공백 정리', async () => {
      expect((await patch(id, { name: '  앞뒤   공백  ', memo: '  메모   내용  ' })).status()).toBe(200);
      const row = medRow(id)!;
      expect(row.name).toBe('앞뒤 공백');
      expect(row.memo).toBe('메모 내용');
    });

    await test.step('시각 변경: 새 시각이 앞으로 남았으면 그날 알림 기록을 지우고, 이미 지난 시각이면 지우지 않는다', async () => {
      // 알림 창 밖(1시간 뒤)에 둔 약에 오늘 알림 기록을 하나 넣고 시작한다
      const r = insertMedicationRow({ wardId: ward.id, createdBy: guardian.id, name: '[QA-P1a] 알림기록', doseExpr: kstTime(60) });
      const seed = () =>
        psql(`INSERT INTO medication_reminder_log (medication_id, dose_date, attempt, sent_at)
              VALUES (${r}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, now());`);
      seed();
      expect(reminderLogCount(r), '시작: 기록 1건').toBe(1);
      expect((await patch(r, { doseTime: kstHm(120) })).status()).toBe(200);
      expect(reminderLogCount(r), '새 시각이 앞으로 남았으니 오늘 알림 기록이 지워진다').toBe(0);

      seed();
      expect((await patch(r, { doseTime: kstHm(-20) })).status()).toBe(200);
      expect(reminderLogCount(r), '이미 지난 시각으로 고치면 기록을 지우지 않는다(거짓 알림 방지)').toBe(1);

      // 시각이 그대로면 지우지 않는다
      const sameTime = medRow(r)!.dose;
      expect((await patch(r, { doseTime: sameTime })).status()).toBe(200);
      expect(reminderLogCount(r), '시각이 같으면 그대로').toBe(1);
    });

    await test.step('시각을 지금(1분 전)으로 고치면 새 시각에 알림이 가고, 이미 체크한 약은 알림이 가지 않는다', async () => {
      const w = await loginAs(ward);
      const fresh = insertMedicationRow({ wardId: ward.id, createdBy: guardian.id, name: '[QA-P1a] 새시각알림', doseExpr: kstTime(60) });
      const checked = insertMedicationRow({ wardId: ward.id, createdBy: guardian.id, name: '[QA-P1a] 새시각체크함', doseExpr: kstTime(60) });
      expect((await w.api.raw('POST', `/api/ward/medication/${checked}/intake`)).status(), '복용 체크').toBe(200);
      expect(reminderLogCount(fresh), '고치기 전에는 알림 기록 없음').toBe(0);
      expect((await patch(fresh, { doseTime: kstHm(-1) })).status()).toBe(200);
      expect((await patch(checked, { doseTime: kstHm(-1) })).status()).toBe(200);
      await expect
        .poll(() => reminderLogCount(fresh, 1), { message: '새 시각에 첫 알림 기록(회차 1)이 생긴다(스케줄러 한 바퀴 이내)', timeout: 190_000, intervals: [3000, 5000] })
        .toBe(1);
      expect(reminderLogCount(checked), '이미 체크한 약은 시각을 고쳐도 알림이 가지 않는다').toBe(0);
    });
  });
});
