/**
 * 최종 QA - 복약·약 봉투 OCR·문의(CONN) P0: A28 A33 A34 A35 A36 N39 A46 A57.
 *
 * 임시 사용자만 쓴다. 약은 보호자 API 로 등록한다(복용 시각은 6시간 뒤라 알림 유예 창에 들지 않는다).
 * OCR 케이스 중 AI(Claude)를 실제로 부르는 것은 N39 한 건뿐이다.
 */
import { request } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psql, remoteBash } from '../../../src/remote';
import { connect } from '../../../src/variables';
import {
  bigFakeJpeg, connectionId, createMedication, expectError, idorLogCount, intakeCount, logLineCount, medicationRow, postFile, read, TAGS,
  waitIdorLog,
} from './_helpers-conn';

const NO_SUCH_ID = 2147483000;

/** 인증 없이 호출 */
async function anonymousStatus(method: 'GET' | 'POST' | 'DELETE' | 'PATCH', path: string, data?: unknown) {
  const ctx = await request.newContext({ baseURL: env.apiUrl });
  try {
    return (await ctx.fetch(path, { method, data })).status();
  } finally {
    await ctx.dispose();
  }
}

/** 컨테이너 로그에서 최근 N초 안에 글자가 몇 줄에 나왔는지 (읽기 전용) */
function logCount(container: string, needle: string, sinceSeconds = 600): number {
  if (!/^[\w가-힣.\-/]+$/.test(needle)) throw new Error('허용되지 않는 검색어');
  if (!/^[\w\-]+$/.test(container)) throw new Error('허용되지 않는 컨테이너');
  const out = remoteBash(`docker logs --since ${sinceSeconds}s ${container} 2>&1 | grep -cF '${needle}' || true\n`);
  return Number(out.trim()) || 0;
}

/** 표 전체를 글자로 바꿔 검색어가 들어 있는 행 수 (읽기 전용) */
function rowsContaining(table: string, needle: string): number {
  if (!/^[a-z_]+$/.test(table) || !/^[\w가-힣.\-]+$/.test(needle)) throw new Error('허용되지 않는 값');
  return Number(psql(`SELECT count(*) FROM ${table} t WHERE t::text LIKE '%${needle}%';`));
}

test.describe('CONN 복약·OCR·문의 P0', () => {
  test('CONN-A28 로그인 없음·역할 반대 복약 API', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const id = await createMedication(g.api, ward.id);
    const bodyCreate = { name: 'E2E역할약', timeSlot: 'MORNING', doseTime: '09:00:00' };

    await test.step('토큰 없음은 전부 401', async () => {
      expect(await anonymousStatus('GET', '/api/guardian/medication')).toBe(401);
      expect(await anonymousStatus('POST', `/api/guardian/ward/${ward.id}/medication`, bodyCreate)).toBe(401);
      expect(await anonymousStatus('DELETE', `/api/guardian/medication/${id}`)).toBe(401);
      expect(await anonymousStatus('GET', '/api/ward/medication/today')).toBe(401);
      expect(await anonymousStatus('POST', `/api/ward/medication/${id}/intake`)).toBe(401);
      expect(await anonymousStatus('POST', '/api/ward/medication/intake/batch', { medicationIds: [id], taken: true })).toBe(401);
    });

    await test.step('피보호자가 보호자 API(등록·수정·삭제·일괄·목록)를 부르면 403', async () => {
      await expectError(await w.api.raw('POST', `/api/guardian/ward/${ward.id}/medication`, bodyCreate), 403, undefined, '등록');
      await expectError(await w.api.raw('PATCH', `/api/guardian/medication/${id}`, { name: '바꿈' }), 403, undefined, '수정');
      await expectError(await w.api.raw('DELETE', `/api/guardian/medication/${id}`), 403, undefined, '삭제');
      await expectError(await w.api.raw('POST', `/api/guardian/ward/${ward.id}/medication/delete-batch`, { medicationIds: [id] }), 403, undefined, '일괄 삭제');
      await expectError(await w.api.raw('GET', '/api/guardian/medication'), 403, undefined, '보호자 목록');
      expect(medicationRow(id)?.deleted, '약은 그대로').toBe(false);
    });

    await test.step('보호자가 피보호자 체크 API 를 부르면 403', async () => {
      await expectError(await g.api.raw('POST', `/api/ward/medication/${id}/intake`), 403, undefined, '체크');
      await expectError(await g.api.raw('DELETE', `/api/ward/medication/${id}/intake`), 403, undefined, '체크 해제');
      await expectError(await g.api.raw('POST', '/api/ward/medication/intake/batch', { medicationIds: [id], taken: true }), 403, undefined, '묶음 체크');
      await expectError(await g.api.raw('GET', '/api/ward/medication/today'), 403, undefined, '오늘 약');
    });

    await test.step('보호자용 체크 API 는 존재하지 않는다 (경로가 없다)', async () => {
      const guesses: [string, string][] = [
        ['POST', `/api/guardian/medication/${id}/intake`],
        ['POST', `/api/guardian/ward/${ward.id}/medication/${id}/intake`],
        ['PUT', `/api/guardian/medication/${id}/intake`],
        ['POST', '/api/guardian/medication/intake/batch'],
      ];
      for (const [method, path] of guesses) {
        const res = await g.api.raw(method as 'POST' | 'PUT', path, { medicationIds: [id], taken: true });
        const status = res.status();
        test.info().annotations.push({ type: `보호자 체크 경로 ${method}`, description: `${path.replace(ward.id, '<ward>')} -> ${status}` });
        expect([404, 405], `${method} ${path.replace(ward.id, '<ward>')} -> ${status}`).toContain(status);
      }
      expect(intakeCount(id), '체크 기록이 생기지 않았다').toBe(0);
    });
  });

  test('CONN-A33 delete-batch 범위·IDOR', TAGS, async ({ tempUser, loginAs }) => {
    const g1 = await tempUser('GUARDIAN');
    const g2 = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD');
    const w2 = await tempUser('WARD');
    const w3 = await tempUser('WARD');
    connect(g1.id, w1.id);
    connect(g2.id, w2.id);
    const a = await loginAs(g1);
    const b = await loginAs(g2);
    const m1 = await createMedication(a.api, w1.id, 'E2E삭제약1');
    const m2 = await createMedication(a.api, w1.id, 'E2E삭제약2');
    const mx = await createMedication(b.api, w2.id, 'E2E남의약');
    const url = `/api/guardian/ward/${w1.id}/medication/delete-batch`;

    await test.step('개수 범위: 0개·101개는 400', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [] }), 400, undefined, '0개');
      await expectError(await a.api.raw('POST', url, { medicationIds: Array.from({ length: 101 }, (_, i) => i + 1) }), 400, undefined, '101개');
      await expectError(await a.api.raw('POST', url, {}), 400, undefined, '목록 없음');
    });
    await test.step('같은 ID 중복은 400', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [m1, m1] }), 400, 'MEDICATION_DELETE_BATCH_DUPLICATE', '중복');
    });
    await test.step('남의 피보호자 약이 섞이면 403 + IDOR 로그, 전부 취소', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [m1, mx] }), 403, 'MEDICATION_NOT_AUTHORIZED', '섞임');
      expect(medicationRow(m1)?.deleted, '내 약도 지워지지 않는다(전부/전무)').toBe(false);
      expect(medicationRow(mx)?.deleted, '남의 약은 그대로').toBe(false);
      await waitIdorLog('guardianId', g1.id, 1);
    });
    await test.step('없는 약이 섞이면 404, 전부 취소', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [m1, NO_SUCH_ID] }), 404, 'MEDICATION_NOT_FOUND', '없는 약');
      expect(medicationRow(m1)?.deleted).toBe(false);
    });
    await test.step('연결 안 된 피보호자 경로는 403', async () => {
      await expectError(await a.api.raw('POST', `/api/guardian/ward/${w2.id}/medication/delete-batch`, { medicationIds: [mx] }), 403, 'MEDICATION_NOT_AUTHORIZED', '남의 wardId');
      await expectError(await a.api.raw('POST', `/api/guardian/ward/${w3.id}/medication/delete-batch`, { medicationIds: [mx] }), 403, 'MEDICATION_NOT_AUTHORIZED', '미연결 wardId');
      expect(medicationRow(mx)?.deleted).toBe(false);
    });
    await test.step('정상 삭제와 이미 지운 약 건너뛰기', async () => {
      const ok = await read(await a.api.raw('POST', url, { medicationIds: [m1, m2] }));
      expect(ok.status).toBe(200);
      expect(ok.body.data).toBe(2);
      expect(medicationRow(m1)?.deleted).toBe(true);
      expect(medicationRow(m2)?.deleted).toBe(true);
      const again = await read(await a.api.raw('POST', url, { medicationIds: [m1] }));
      expect(again.status, '이미 지운 약은 건너뛰고 성공').toBe(200);
      expect(again.body.data).toBe(0);
    });
  });

  test('CONN-A34 intake/batch 범위·IDOR', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD');
    const w2 = await tempUser('WARD');
    connect(guardian.id, w1.id);
    connect(guardian.id, w2.id);
    const g = await loginAs(guardian);
    const a = await loginAs(w1);
    const m1a = await createMedication(g.api, w1.id, 'E2E체크약A');
    const m1b = await createMedication(g.api, w1.id, 'E2E체크약B');
    const m2 = await createMedication(g.api, w2.id, 'E2E남의체크약');
    const url = '/api/ward/medication/intake/batch';

    await test.step('개수 범위: 0개·51개는 400', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [], taken: true }), 400, undefined, '0개');
      await expectError(await a.api.raw('POST', url, { medicationIds: Array.from({ length: 51 }, (_, i) => i + 1), taken: true }), 400, undefined, '51개');
      await expectError(await a.api.raw('POST', url, { medicationIds: [m1a] }), 400, undefined, 'taken 없음');
    });
    await test.step('같은 ID 중복은 400', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [m1a, m1a], taken: true }), 400, 'MEDICATION_INTAKE_BATCH_DUPLICATE', '중복');
    });
    await test.step('남의 약이 섞이면 전체 403 MEDICATION_NOT_OWNED + IDOR 로그', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [m1a, m2], taken: true }), 403, 'MEDICATION_NOT_OWNED', '남의 약');
      expect(intakeCount(m1a), '내 약도 체크되지 않는다(전체 실패)').toBe(0);
      expect(intakeCount(m2)).toBe(0);
      await waitIdorLog('wardId', w1.id, 1);
    });
    await test.step('없는 약이 섞이면 전체 404', async () => {
      await expectError(await a.api.raw('POST', url, { medicationIds: [m1a, NO_SUCH_ID], taken: true }), 404, 'MEDICATION_NOT_FOUND', '없는 약');
      expect(intakeCount(m1a)).toBe(0);
    });
    await test.step('정상 묶음 체크와 해제', async () => {
      const ok = await read(await a.api.raw('POST', url, { medicationIds: [m1a, m1b], taken: true }));
      expect(ok.status).toBe(200);
      expect(intakeCount(m1a)).toBe(1);
      expect(intakeCount(m1b)).toBe(1);
      expect((await a.api.raw('POST', url, { medicationIds: [m1a, m1b], taken: false })).status()).toBe(200);
      expect(intakeCount(m1a)).toBe(0);
    });
  });

  test('CONN-A35 연결 안 된 피보호자의 복약 접근', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const active = await tempUser('WARD');
    const pending = await tempUser('WARD');
    const dropped = await tempUser('WARD');
    const stranger = await tempUser('WARD');
    connect(guardian.id, active.id);
    connect(guardian.id, dropped.id);
    const g = await loginAs(guardian);
    await createMedication(g.api, active.id, 'E2E연결된약');
    expect((await g.api.raw('POST', '/api/guardian/connection/request', { targetId: pending.id, relation: '딸' })).status()).toBe(200);
    expect((await g.api.raw('DELETE', `/api/guardian/connection/disconnection/${connectionId(guardian.id, dropped.id)}`)).status()).toBe(200);

    const targets: [string, string][] = [['대기 중(PENDING)', pending.id], ['해제됨', dropped.id], ['연결 안 된', stranger.id]];
    for (const [label, wardId] of targets) {
      await test.step(`${label} wardId 로 등록·일괄 등록·삭제·설정 보기·설정 바꾸기`, async () => {
        const base = `/api/guardian/ward/${wardId}`;
        await expectError(await g.api.raw('POST', `${base}/medication`, { name: 'E2E금지약', timeSlot: 'MORNING', doseTime: '09:00:00' }), 403, 'MEDICATION_NOT_AUTHORIZED', `${label} 등록`);
        await expectError(await g.api.raw('POST', `${base}/medication/batch`, { drugs: [{ name: 'E2E금지약' }], times: [{ doseTime: '09:00:00' }] }), 403, 'MEDICATION_NOT_AUTHORIZED', `${label} 일괄 등록`);
        await expectError(await g.api.raw('POST', `${base}/medication/delete-batch`, { medicationIds: [1] }), 403, 'MEDICATION_NOT_AUTHORIZED', `${label} 일괄 삭제`);
        await expectError(await g.api.raw('GET', `${base}/medication-alert-setting`), 403, 'MEDICATION_NOT_AUTHORIZED', `${label} 설정 보기`);
        await expectError(await g.api.raw('PUT', `${base}/medication-alert-setting`, { missedAlertEnabled: true }), 403, 'MEDICATION_NOT_AUTHORIZED', `${label} 설정 바꾸기`);
        expect(Number(psql(`SELECT count(*) FROM medication WHERE ward_id = '${wardId}';`)), `${label}: 약이 만들어지지 않았다`).toBe(0);
      });
    }
    await expectError(await g.api.raw('GET', '/api/guardian/ward/zz!/medication-alert-setting'), 403, 'MEDICATION_NOT_AUTHORIZED', '형식이 틀린 wardId');
    await waitIdorLog('guardianId', guardian.id, 15);

    await test.step('목록에는 연결된 피보호자만 있고, 수락 전 피보호자의 정보는 안 보인다', async () => {
      const cards = await g.api.get<{ wardId: string }[]>('/api/guardian/medication');
      expect(cards.map(c => c.wardId), '복약 현황에 대기·해제·미연결 피보호자가 섞이면 안 된다').toEqual([active.id]);
      const select = await g.api.get<Record<string, unknown>[]>('/api/guardian/connection/select');
      const pendingCard = select.find(i => i.partnerUserId === pending.id);
      expect(pendingCard?.status).toBe('PENDING');
      for (const key of ['partnerPhone', 'partnerEmail', 'partnerAddress', 'partnerBirthDate']) {
        expect(pendingCard?.[key] ?? null, `대기 중 피보호자 ${key}`).toBeNull();
      }
    });
  });

  test('CONN-A36 남의 약 수정·삭제·체크와 없는 약', TAGS, async ({ tempUser, loginAs }) => {
    const g1 = await tempUser('GUARDIAN');
    const g2 = await tempUser('GUARDIAN');
    const w1 = await tempUser('WARD');
    const w2 = await tempUser('WARD');
    connect(g1.id, w1.id);
    connect(g2.id, w2.id);
    const a = await loginAs(g1);
    const b = await loginAs(g2);
    const aw = await loginAs(w1);
    const mine = await createMedication(a.api, w1.id, 'E2E내약');
    const theirs = await createMedication(b.api, w2.id, 'E2E남약');

    await test.step('남의 약: 수정·삭제 403 MEDICATION_NOT_AUTHORIZED, 체크 403 MEDICATION_NOT_OWNED', async () => {
      await expectError(await a.api.raw('PATCH', `/api/guardian/medication/${theirs}`, { name: '탈취' }), 403, 'MEDICATION_NOT_AUTHORIZED', '수정');
      await expectError(await a.api.raw('DELETE', `/api/guardian/medication/${theirs}`), 403, 'MEDICATION_NOT_AUTHORIZED', '삭제');
      await expectError(await aw.api.raw('POST', `/api/ward/medication/${theirs}/intake`), 403, 'MEDICATION_NOT_OWNED', '체크');
      const row = medicationRow(theirs);
      expect(row?.name, '남의 약 이름 그대로').toBe('E2E남약');
      expect(row?.deleted).toBe(false);
      expect(intakeCount(theirs)).toBe(0);
      await waitIdorLog('wardId', w1.id, 1);
    });

    await test.step('다른 피보호자로 옮기기는 안 된다', async () => {
      const res = await a.api.raw('PATCH', `/api/guardian/medication/${mine}`, { wardId: w2.id, name: 'E2E이동시도' });
      test.info().annotations.push({ type: '이동 시도 응답', description: String(res.status()) });
      // 배포 코드: PATCH 는 body 의 wardId 를 무시하고 이름만 바꾸므로 200 이다
      expect(res.status(), '이동 시도는 wardId 를 무시하고 200').toBe(200);
      expect(medicationRow(mine)?.wardId, '약은 원래 피보호자 것이다').toBe(w1.id);
    });

    await test.step('지운 약·없는 약은 404', async () => {
      expect((await a.api.raw('DELETE', `/api/guardian/medication/${mine}`)).status()).toBe(200);
      await expectError(await a.api.raw('DELETE', `/api/guardian/medication/${mine}`), 404, 'MEDICATION_NOT_FOUND', '지운 약 삭제');
      await expectError(await a.api.raw('PATCH', `/api/guardian/medication/${mine}`, { name: '또' }), 404, 'MEDICATION_NOT_FOUND', '지운 약 수정');
      await expectError(await aw.api.raw('POST', `/api/ward/medication/${mine}/intake`), 404, 'MEDICATION_NOT_FOUND', '지운 약 체크');
      await expectError(await a.api.raw('DELETE', `/api/guardian/medication/${NO_SUCH_ID}`), 404, 'MEDICATION_NOT_FOUND', '없는 약 삭제');
      await expectError(await aw.api.raw('POST', `/api/ward/medication/${NO_SUCH_ID}/intake`), 404, 'MEDICATION_NOT_FOUND', '없는 약 체크');
    });
  });

  test('CONN-N39 사진·결과는 어디에도 저장·로그 안 됨', TAGS, async ({ tempUser, loginAs, page }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);

    const stamp = Date.now().toString(36);
    // 이 테스트만의 가짜 약 이름 - 사진에서 읽힌 약 이름이 로그·DB 에 남는지 찾는 표지 (진짜 약 이름은 다른 사람 기록과 섞여 쓸 수 없다)
    const fakeDrug = `큐에이정${String(Date.now() % 100000).padStart(5, '0')}`;
    const patient = `큐에이환자${stamp.slice(-3).replace(/[^0-9a-z]/g, 'x')}`;
    const pharmacy = '큐에이튼튼약국';
    const fileName = `qa-conn-n39-${stamp}.png`;

    // 약 봉투 모양의 사진을 화면으로 그려 PNG 로 만든다 (개인정보처럼 보이는 환자 이름·약국 포함)
    await page.setViewportSize({ width: 900, height: 600 });
    await page.setContent(`
      <body style="margin:0;background:#fff;font-family:'Noto Sans CJK KR','Noto Sans KR',sans-serif;color:#000">
        <div style="padding:28px 36px;border:4px solid #000;margin:20px">
          <div style="font-size:30px;font-weight:700">약 봉 투 (조제약)</div>
          <div style="font-size:26px;margin-top:10px">환자명: ${patient} &nbsp; 주민번호: 480101-1</div>
          <div style="font-size:26px">조제일: 2026-11-13 &nbsp; ${pharmacy}</div>
          <hr style="border:2px solid #000">
          <div style="font-size:34px;font-weight:700;margin-top:12px">코싹정</div>
          <div style="font-size:28px">1회 1정 &nbsp; 1일 3회 &nbsp; 3일분 &nbsp; (식후 30분)</div>
          <div style="font-size:28px">복용시간: 아침 &nbsp; 점심 &nbsp; 저녁</div>
          <div style="font-size:34px;font-weight:700;margin-top:16px">타이레놀정500밀리그램</div>
          <div style="font-size:28px">1회 1정 &nbsp; 1일 3회 &nbsp; 3일분 &nbsp; (식후 30분)</div>
          <div style="font-size:34px;font-weight:700;margin-top:16px">${fakeDrug}</div>
          <div style="font-size:28px">1회 1정 &nbsp; 1일 2회 &nbsp; 3일분 &nbsp; (식후 30분)</div>
        </div>
      </body>`);
    const png = await page.screenshot({ type: 'png' });

    const aiContainer = 'silverbridge-ai-server';
    const needles = [patient, pharmacy, fileName.replace('.png', ''), fileName, fakeDrug];
    let blocked: { status: number; code: string } | null = null;

    const { res, ctx } = await postFile(`/api/guardian/ward/${ward.id}/medication/ocr`, g.login, { buffer: png, name: fileName, mimeType: 'image/png' });
    try {
      const r = await read(res);
      if (r.status !== 200) {
        // 응답이 정상이 아니어도 DB·로그 점검(사진 속 글자 0건)은 아래에서 먼저 돌린다. 판정은 맨 끝에서 한다
        blocked = { status: r.status, code: r.body.code ?? '(코드 없음)' };
      } else {
      expect(res.headers()['cache-control'] ?? '', '응답은 저장하지 않게(no-store)').toContain('no-store');

      const data = r.body.data as { readable: boolean; drugs: Record<string, unknown>[] };
      expect(Object.keys(data).sort(), '응답 최상위 칸은 허용 목록만').toEqual(['drugs', 'readable']);
      expect(data.readable, '준비한 사진은 읽혀야 한다').toBe(true);
      const allowed = ['name', 'perDose', 'timesPerDay', 'days', 'slots', 'timing', 'confidence', 'inList', 'suggestions'];
      for (const drug of data.drugs) {
        const extra = Object.keys(drug).filter(k => !allowed.includes(k));
        expect(extra, '허용 목록 밖 칸(reason·성분 등)이 없다').toEqual([]);
      }
      expect(r.text, '환자 이름·약국이 응답에 되돌아오지 않는다').not.toContain(patient);
      expect(r.text).not.toContain(pharmacy);
      expect(r.text).not.toMatch(/"reason"|ingredient|성분/);
      const readFake = data.drugs.some(d => String(d.name ?? '').includes(fakeDrug.slice(-5)));
      test.info().annotations.push({
        type: 'OCR 결과',
        description: `약 ${data.drugs.length}개 읽힘, 가짜 약 이름 ${readFake ? '읽힘(로그·DB 검사가 의미 있다)' : '못 읽음(검사는 했지만 약한 확인)'}`,
      });
      }
    } finally {
      await ctx.dispose();
    }

    await new Promise(resolve => setTimeout(resolve, 3_000));

    await test.step('DB: 사진 속 이름·파일 이름이 어느 표에도 없다', async () => {
      for (const table of ['medication', 'notification_log', 'access_log', 'admin_audit_log', 'inquiry']) {
        for (const needle of needles) {
          expect(rowsContaining(table, needle), `${table} 에 검색어가 저장되면 안 된다`).toBe(0);
        }
      }
      expect(Number(psql(`SELECT count(*) FROM medication WHERE ward_id = '${ward.id}';`)), '자동 등록은 없다').toBe(0);
    });
    await test.step('서버 로그(BE·AI): 사진 속 이름·파일 이름이 없다', async () => {
      for (const needle of needles) {
        expect(logCount(env.apiContainer, needle), `BE 로그에 ${needle === fileName ? '파일 이름' : '사진 속 글자'}`).toBe(0);
        expect(logCount(aiContainer, needle), `AI 로그에 ${needle === fileName ? '파일 이름' : '사진 속 글자'}`).toBe(0);
      }
    });
    test.info().annotations.push({
      type: '자동화 한계',
      description: '디스크 저장·AI 가 받은 파일명(image.jpg 고정)은 서버 안을 직접 볼 수 없어 로그 검색 + BE 코드로만 확인했다(수동 확인 필요)',
    });
    if (blocked) {
      // 속도 제한(429)만 건너뛴다. 503(AI 키 빠짐 등)·504 같은 설정·서버 문제는 실패로 남긴다
      test.skip(blocked.status === 429, `OCR 속도 제한으로 점검 불가: 429 ${blocked.code} (DB·로그 점검은 끝냈다)`);
      expect(blocked.status, `OCR 응답이 정상이 아니다: 오류 코드 ${blocked.code}`).toBe(200);
    }
  });

  test('CONN-A46 OCR 로그인·역할·연결 권한', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN');
    const stranger = await tempUser('WARD');
    const ward = await tempUser('WARD');
    const admin = await tempUser('ADMIN');
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const a = await loginAs(admin);
    const big = bigFakeJpeg(9.5);
    const url = `/api/guardian/ward/${stranger.id}/medication/ocr`;
    const timings: Record<string, number> = {};
    async function upload(label: string, login: typeof g.login | null, file = { buffer: big, name: 'qa-big.jpg', mimeType: 'image/jpeg' }) {
      const { res, ms, ctx } = await postFile(url, login, file);
      timings[label] = ms;
      const r = await read(res);
      await ctx.dispose();
      return r;
    }

    const anon = await upload('토큰 없음', null);
    expect(anon.status, '토큰 없음').toBe(401);

    const asWard = await upload('피보호자', w.login);
    expect(asWard.status, `피보호자 토큰: 큰 사진이어도 413 이 아닌 403 (본문 ${asWard.text.slice(0, 120)})`).toBe(403);
    const asAdmin = await upload('관리자', a.login);
    expect(asAdmin.status, '관리자 토큰').toBe(403);

    const unconnectedBig = await upload('미연결+큰 사진', g.login);
    expect(unconnectedBig.status, '미연결 wardId 는 사진 크기 검사(413)보다 먼저 403').toBe(403);
    expect(unconnectedBig.body.code).toBe('MEDICATION_NOT_AUTHORIZED');
    const unconnectedText = await upload('미연결+사진 아님', g.login, { buffer: Buffer.from('not an image'), name: 'a.txt', mimeType: 'text/plain' });
    expect(unconnectedText.status, '미연결 wardId 는 형식 검사(400)보다 먼저 403').toBe(403);
    expect(unconnectedText.body.code).toBe('MEDICATION_NOT_AUTHORIZED');
    await waitIdorLog('guardianId', guardian.id, 2);

    // AI 호출 없음: BE 의 [MED-OCR] 로그 중 이 임시 보호자(guardianId)의 줄이 0건 (임시 사용자 기준이라 다른 실행과 섞이지 않는다)
    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(logLineCount(env.apiContainer, ['[MED-OCR]', `guardianId=${guardian.id}`]), 'AI 호출 기록([MED-OCR])이 없다').toBe(0);

    // 업로드가 끝나기 전에 거절되는지: 같은 큰 사진을 "연결된 보호자" 정상 경로로 올린 시간(대조)과 비교한다
    const connectedWard = await tempUser('WARD');
    connect(guardian.id, connectedWard.id);
    const control = await postFile(`/api/guardian/ward/${connectedWard.id}/medication/ocr`, g.login, { buffer: big, name: 'qa-big.jpg', mimeType: 'image/jpeg' });
    const controlRes = await read(control.res);
    await control.ctx.dispose();
    timings['대조(연결된 보호자+큰 사진)'] = control.ms;
    expect(controlRes.status, '대조: 연결된 보호자가 8MB 넘는 사진을 올리면 413').toBe(413);

    test.info().annotations.push({ type: '업로드 소요(ms)', description: JSON.stringify(timings) });
    const rejected = Math.max(timings['피보호자'], timings['관리자']);
    if (control.ms >= 1_500) {
      expect(rejected, `역할이 다르면 업로드가 끝나기 전에 거절돼야 한다 (거절 ${rejected}ms, 끝까지 올린 대조 ${control.ms}ms)`).toBeLessThan(control.ms * 0.7);
    } else {
      test.info().annotations.push({
        type: '수동 확인 필요',
        description: `대조 업로드가 ${control.ms}ms 로 너무 빨라 "업로드 끝나기 전 403" 시간 비교가 의미 없다 (403 상태 코드만 확인함)`,
      });
    }
  });

  test('CONN-A57 남의 문의 열람과 없는 문의', TAGS, async ({ tempUser, loginAs }) => {
    const owner = await tempUser('GUARDIAN');
    const other = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const o = await loginAs(owner);
    const x = await loginAs(other);
    const w = await loginAs(ward);

    const title = 'E2E최종문의제목';
    const content = 'E2E최종문의내용 - 남이 보면 안 된다';
    const created = await read(await o.api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title, content }));
    expect(created.status, `문의 작성 (${created.text.slice(0, 120)})`).toBe(200);
    const id = (created.body.data as { id: number }).id;
    expect(id).toBeGreaterThan(0);

    const mine = await read(await o.api.raw('GET', `/api/guardian/inquiry/${id}`));
    expect(mine.status, '작성자는 열람').toBe(200);
    expect((mine.body.data as { title: string }).title).toBe(title);

    const theirs = await expectError(await x.api.raw('GET', `/api/guardian/inquiry/${id}`), 403, 'INQUIRY_NOT_AUTHORIZED', '남의 문의');
    expect(theirs.text, '내용이 없다').not.toContain(title);
    expect(theirs.text).not.toContain('남이 보면');
    expect(theirs.body.data ?? null).toBeNull();
    await waitIdorLog('userId', other.id, 1);

    await expectError(await x.api.raw('GET', `/api/guardian/inquiry/${NO_SUCH_ID}`), 404, 'INQUIRY_NOT_FOUND', '없는 문의');
    await expectError(await w.api.raw('GET', `/api/guardian/inquiry/${id}`), 403, undefined, '피보호자 토큰');
    expect(await anonymousStatus('GET', `/api/guardian/inquiry/${id}`), '토큰 없음').toBe(401);

    const list = await x.api.get<{ id: number }[]>('/api/guardian/inquiry');
    expect(list.map(i => i.id), '다른 보호자 목록에 섞이지 않는다').not.toContain(id);
    expect(idorLogCount('userId', owner.id), '작성자는 IDOR 로그가 없다').toBe(0);
  });
});
