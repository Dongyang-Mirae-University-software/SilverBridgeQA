/**
 * 최종 QA - 복약 알림(스케줄러, CONN) P1a: A39 A40 A41 A42 A43 N33 N34 N35.
 *
 * 서버 스케줄러(1분 주기, 서버 시계)를 그대로 쓴다. 시계를 바꿀 수 없으므로 임시 피보호자의 약 복용 시각을 "지금 기준 몇 분 전"으로 잡고,
 * 스케줄러가 한 바퀴 돌 때까지 기다린다(최대 약 3분). 약은 먼저 알림 창 밖(1시간 반 뒤)에 만들어 두고, 한 문장으로 한꺼번에 "지금"으로 옮겨
 * 스케줄러가 준비 도중의 일부만 집는 일이 없게 한다.
 *
 * 임시 사용자는 전화번호·푸시 토큰이 없어 실제 문자·푸시는 나가지 않는다. 알림이 "어떻게 갔는지"는 notification_log 로 본다.
 * 약·알림 기록은 임시 사용자가 지워질 때 함께 지워진다(CASCADE).
 */
import { APIResponse } from '@playwright/test';

import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { psql, psqlRows, sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import { read } from './_helpers-conn';
import {
  captureFrames, cleanAdminAudit, clockSafe, insertMedicationRow, kstClockOf, kstDayOf, kstHm, kstTime, medRow, notifCount, notifRows,
  reminderLogCount, TAGS, todayAt,
} from './_helpers-conn-p1a';

type Api = { raw: (m: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', p: string, d?: unknown) => Promise<APIResponse> };

const TICK_TIMEOUT = 190_000; // 스케줄러 한 바퀴(60초) + 처리 + 원격 조회 여유
const FIRST_BODY = '약 드실 시간이에요.';
const RETRY_BODY = "약 드셨으면 앱에서 '먹었어요'를 눌러 주세요.";

const ids = (list: number[]) => list.join(', ');

/** 약들의 복용 시각을 한 문장으로 옮긴다(스케줄러가 일부만 집지 못하게) */
function setDose(medIds: number[], hm: string) {
  psql(`UPDATE medication SET dose_time = ${sqlStr(hm)}::time WHERE id IN (${ids(medIds)});`);
}

/** 같은 상태가 될 때까지 스케줄러 한 바퀴 이상을 기다린다 */
function waitTick<T>(probe: () => T, message: string) {
  return expect.poll(probe, { message, timeout: TICK_TIMEOUT, intervals: [3000, 5000] });
}

async function intake(api: Api, medicationId: number) {
  const res = await api.raw('POST', `/api/ward/medication/${medicationId}/intake`);
  expect(res.status(), '복용 체크').toBe(200);
}

function missedLogs(guardianId: string, wardId: string): { missed: number; total: number }[] {
  return psqlRows(`SELECT missed_count, total_count FROM medication_missed_alert_log
                   WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} AND dose_date = (now() AT TIME ZONE 'Asia/Seoul')::date;`)
    .map(([missed, total]) => ({ missed: Number(missed), total: Number(total) }));
}

test.describe('CONN 복약 알림 P1a (스케줄러)', () => {
  test('CONN-N33 먹을 시간 첫 알림(1분 주기)', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.skip(!clockSafe(25, 15), '자정 앞뒤에는 "지금 몇 분 전" 시각이 하루를 넘나들어 건너뜀');
    test.setTimeout(330_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connect(guardian.id, ward.id);
    const w = await loginAs(ward);
    // 피보호자가 모든 채널을 켜 둬도 이 알림이 어느 채널로 가는지 본다(전화번호가 없어 실제 문자는 나갈 수 없다)
    const channels = ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: true }));
    expect((await w.api.raw('PUT', '/api/user/me/notification-settings', { settings: channels })).status()).toBe(200);

    const page = await openAs(w.who, null);
    const frames = captureFrames(page);
    await page.goto('/ward');
    await waitForRealtime(page);

    const med = insertMedicationRow({ wardId: ward.id, createdBy: guardian.id, name: '[QA-P1a] 첫알림', doseExpr: kstTime(90) });
    setDose([med], kstHm(-1));

    await waitTick(() => reminderLogCount(med, 1), '첫 알림 기록(회차 1)이 남는다').toBe(1);
    await waitTick(() => notifRows('MEDICATION_REMINDER', ward.id).length, '피보호자 알림 이력').toBe(1);

    const [log] = notifRows('MEDICATION_REMINDER', ward.id, ward.id);
    expect(log, '피보호자 본인에게, 피보호자 기준 이력').toBeTruthy();
    expect(log.title).toBe('실버브릿지');
    expect(log.body, '한 줄 문구').toBe(FIRST_BODY);
    expect(log.body.includes('/'), '한 줄(줄바꿈 없음)').toBe(false);
    expect(log.channels, '앱 푸시(FCM)만 시도한다').toContain('FCM');
    for (const forbidden of ['SMS', 'KAKAO', 'EMAIL']) {
      expect(log.channels.includes(forbidden), `${forbidden} 채널은 시도하지 않는다(알림톡·이메일 없음)`).toBe(false);
    }
    expect(notifCount('MEDICATION_REMINDER', guardian.id), '보호자에게는 가지 않는다').toBe(0);
    expect(reminderLogCount(med), '같은 약·날·회차 1번').toBe(1);
    expect(frames.some(f => f.includes('MEDICATION_REMINDER')), '화면 실시간 알림은 없다').toBe(false);

    test.info().annotations.push({
      type: '문서-코드 불일치(결정 필요)',
      description:
        '결정 필요: 문자 채널이 의도적으로 빠졌는지 BE·기획 확인 필요. 문서·케이스는 "앱 푸시·문자(켜 둔 것만)", 문구 "[실버브릿지] 약 드실 시간이에요."인데 배포 코드는 MEDICATION_REMINDER 의 허용 채널이 FCM 하나뿐이고 ' +
        '이력의 제목은 "실버브릿지", 본문은 "약 드실 시간이에요."이다([실버브릿지] 접두어는 문자 채널이 붙이는 것인데 문자는 이 종류에서 안 쓴다). 코드 값으로 고정했다. ' +
        '푸시를 눌렀을 때 복약 화면으로 이동(XCUT-G19·FEUX-G38)은 서비스 워커 동작이라 이 케이스에서 확인하지 않았다.',
    });
  });

  test('CONN-N34 같은 시각 약 묶음 알림과 재알림', TAGS, async ({ tempUser, loginAs }) => {
    test.skip(!clockSafe(25, 15), '자정 앞뒤에는 건너뜀');
    test.setTimeout(480_000);
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    const g3 = await tempUser('GUARDIAN', { phone: null });
    const w1 = await tempUser('WARD', { phone: null });
    const w2 = await tempUser('WARD', { phone: null });
    const w3 = await tempUser('WARD', { phone: null });
    connect(g1.id, w1.id);
    connect(g2.id, w2.id);
    connect(g3.id, w3.id);
    const wApi2 = await loginAs(w2);

    const far = kstTime(90);
    const six = Array.from({ length: 6 }, (_, i) => insertMedicationRow({ wardId: w1.id, createdBy: g1.id, name: `[QA-P1a] 묶음${i + 1}`, doseExpr: far }));
    const checkedA = insertMedicationRow({ wardId: w2.id, createdBy: g2.id, name: '[QA-P1a] 체크A', doseExpr: far });
    const checkedB = insertMedicationRow({ wardId: w2.id, createdBy: g2.id, name: '[QA-P1a] 체크B', doseExpr: far });
    // w3: 이미 1시간 넘게 전에 첫 알림을 보낸 것으로 기록된 약(재알림은 1시간이 지나면 포기)
    const stale = insertMedicationRow({ wardId: w3.id, createdBy: g3.id, name: '[QA-P1a] 오래전', doseExpr: kstTime(-5) });
    psql(`INSERT INTO medication_reminder_log (medication_id, dose_date, attempt, sent_at)
          VALUES (${stale}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, now() - interval '61 minutes');`);

    const due = kstHm(-1);
    setDose([...six, checkedA, checkedB], due);

    await test.step('같은 시각 약 6개: 한 알림으로 묶어 1건, 기록은 약마다', async () => {
      await waitTick(() => reminderLogCount(six[0], 1) + six.slice(1).reduce((n, m) => n + reminderLogCount(m, 1), 0), '6개 약의 첫 알림 기록').toBe(6);
      await waitTick(() => notifRows('MEDICATION_REMINDER', w1.id).length, '묶음 알림 이력').toBe(1);
      const [log] = notifRows('MEDICATION_REMINDER', w1.id);
      expect(log.body, '여러 개여도 문구는 한 줄(코드 값)').toBe(FIRST_BODY);
      expect(notifRows('MEDICATION_REMINDER', w1.id), '이력은 묶음당 1줄').toHaveLength(1);
      await waitTick(() => notifRows('MEDICATION_REMINDER', w2.id).length, '체크 시험용 피보호자의 첫 알림').toBe(1);
      expect(notifRows('MEDICATION_REMINDER', w2.id)[0].body).toBe(FIRST_BODY);
    });

    await test.step('피보호자가 체크하면 15분 뒤 재알림이 가지 않는다', async () => {
      await intake(wApi2.api, checkedA);
      await intake(wApi2.api, checkedB);
    });

    await test.step('15분이 지난 것으로 보내 시각을 옮기면 체크 안 한 쪽만 한 번 재알림', async () => {
      // 보낸 시각을 16분 전으로 옮긴다(임시 피보호자의 기록만)
      psql(`UPDATE medication_reminder_log SET sent_at = now() - interval '16 minutes' WHERE medication_id IN (${ids([...six, checkedA, checkedB])});`);
      await waitTick(() => six.reduce((n, m) => n + reminderLogCount(m, 2), 0), '체크 안 한 6개 약의 재알림 기록(회차 2)').toBe(6);
      await waitTick(() => notifRows('MEDICATION_REMINDER', w1.id).length, '재알림 이력').toBe(2);
      const logs = notifRows('MEDICATION_REMINDER', w1.id);
      expect(logs[1].body, '재알림 문구').toBe(RETRY_BODY);
      expect(logs, '재알림도 묶어서 1건').toHaveLength(2);
      // 같은 한 바퀴에서 체크한 쪽과 1시간 지난 쪽은 재알림이 없다
      expect(reminderLogCount(checkedA, 2) + reminderLogCount(checkedB, 2), '체크한 약은 재알림 없음').toBe(0);
      expect(notifRows('MEDICATION_REMINDER', w2.id), '체크한 피보호자는 첫 알림 1건뿐').toHaveLength(1);
      expect(reminderLogCount(stale, 2), '첫 알림 후 1시간이 지난 약은 재알림을 포기').toBe(0);
      expect(notifRows('MEDICATION_REMINDER', w3.id), '1시간 지난 약은 어떤 알림도 새로 가지 않는다').toHaveLength(0);
    });

    test.info().annotations.push({
      type: '문서-코드 불일치(결정 필요)',
      description: '묶음 알림 문구가 문서("아침 약 6개 드실 시간입니다(08:00)…")와 다르고 코드는 한 줄 고정 문구다. 코드 값으로 고정했다. 기획 확인 필요.',
    });
    test.info().annotations.push({
      type: '확인하지 못한 것',
      description:
        '푸시 data 의 medicationIds(쉼표 목록)·medicationId(첫 약)는 알림 이력 표에 저장되지 않아 확인할 수 없다(실제 푸시 수신이 필요). ' +
        '재알림 15분은 서버 시계를 못 바꿔 "보낸 시각을 16분 전으로 옮기는" 방식으로 만들었다. 문서의 "아침 약 6개 드실 시간입니다(08:00)…" 문구는 배포 코드에 없고(문구 규칙 2026-10-27) 한 줄 고정 문구다.',
    });
  });

  test('CONN-A39 약 알림 대상 정리(연결 끊김·역할 변경·보호자 탈퇴)', TAGS, async ({ tempUser, loginAs }) => {
    test.skip(!clockSafe(25, 15), '자정 앞뒤에는 건너뜀');
    test.setTimeout(540_000);
    const admin = await tempUser('ADMIN');
    const a = await loginAs(admin);

    const gx = await tempUser('GUARDIAN', { phone: null }); // W0 약의 등록자(연결 없음)
    const w0 = await tempUser('WARD', { phone: null });
    const gc = await tempUser('GUARDIAN', { phone: null });
    const wc = await tempUser('WARD', { phone: null });
    const gr = await tempUser('GUARDIAN', { phone: null });
    const wr = await tempUser('WARD', { phone: null });
    const gw = await tempUser('GUARDIAN', { phone: null });
    const gk = await tempUser('GUARDIAN', { phone: null });
    const ww = await tempUser('WARD', { phone: null });
    connect(gc.id, wc.id);
    connect(gr.id, wr.id);
    connect(gw.id, ww.id);
    connect(gk.id, ww.id);
    const far = kstTime(90);
    const mk = (wardId: string, by: string, name: string) => insertMedicationRow({ wardId, createdBy: by, name: `[QA-P1a] ${name}`, doseExpr: far });
    const m0 = mk(w0.id, gx.id, '보호자없음');
    const mc = mk(wc.id, gc.id, '대조');
    const mr = mk(wr.id, gr.id, '역할변경');
    const mwGone1 = mk(ww.id, gw.id, '탈퇴자등록1');
    const mwGone2 = mk(ww.id, gw.id, '탈퇴자등록2');
    const mwKeep = mk(ww.id, gk.id, '남은보호자등록');

    try {
      await test.step('역할 변경: 피보호자가 보호자로 바뀌면 옛 약이 중지된다', async () => {
        const res = await a.api.raw('PATCH', `/api/admin/user/${wr.id}`, { role: 'GUARDIAN' });
        expect(res.status(), '역할 변경').toBe(200);
        expect(psql(`SELECT role FROM users WHERE id = ${sqlStr(wr.id)};`)).toBe('GUARDIAN');
        expect(medRow(mr)?.deleted, '옛 약은 중지(삭제 표시)된다').toBe(true);
      });

      await test.step('보호자 탈퇴: 그가 등록한 약만 중지되고 남은 보호자에게만 안내', async () => {
        const gwApi = await loginAs(gw);
        const out = await gwApi.api.raw('DELETE', '/api/user/me', { password: gw.password });
        expect(out.status(), '탈퇴 요청').toBe(200);
        expect(medRow(mwGone1) === null || medRow(mwGone1)!.deleted, '탈퇴한 보호자가 등록한 약 1은 중지').toBe(true);
        expect(medRow(mwGone2) === null || medRow(mwGone2)!.deleted, '탈퇴한 보호자가 등록한 약 2는 중지').toBe(true);
        expect(medRow(mwKeep)?.deleted, '남은 보호자가 등록한 약은 그대로').toBe(false);
        await waitTick(() => notifRows('MEDICATION_STOPPED', gk.id).length, '남은 보호자에게 중지 안내').toBe(1);
        const [stop] = notifRows('MEDICATION_STOPPED', gk.id, ww.id);
        expect(stop.title).toBe('복약 일정 중지');
        expect(stop.body, '중지된 건수 안내').toContain('2건이 중지되었습니다');
        expect(notifCount('MEDICATION_STOPPED', ww.id), '피보호자에게는 안내하지 않는다').toBe(0);
        // 정리 확인용: 탈퇴한 임시 보호자 행이 임시 사용자 정리(deleteTempUser)에 걸리는 모양으로 남아 있는지
        test.info().annotations.push({
          type: '탈퇴 뒤 임시 보호자 행',
          description: psql(`SELECT status || ' | 임시 이메일 형식 ' || (email LIKE 'e2e.temp.%')::text FROM users WHERE id = ${sqlStr(gw.id)};`) || '행 없음',
        });
        expect(notifCount('MEDICATION_STOPPED', gw.id), '탈퇴한 보호자에게도 안 간다').toBe(0);
      });

      // 이제 약들을 한꺼번에 "지금"으로 옮긴다
      const due = kstHm(-1);
      setDose([m0, mc, mr, mwKeep], due);

      await test.step('연결된 보호자가 있는 약(대조)은 알림이 가고, 나머지는 안 간다', async () => {
        await waitTick(() => reminderLogCount(mc, 1), '대조 약의 첫 알림').toBe(1);
        expect(reminderLogCount(m0), '보호자가 0명인 피보호자의 약은 알림 없음').toBe(0);
        expect(reminderLogCount(mr), '역할이 바뀐 사용자의 옛 약은 알림 없음').toBe(0);
        expect(notifCount('MEDICATION_REMINDER', wr.id), '역할이 바뀐 사용자에게 복약 알림 이력 없음').toBe(0);
        expect(notifCount('MEDICATION_REMINDER', w0.id), '보호자 0명 피보호자에게 복약 알림 이력 없음').toBe(0);
        expect(medRow(m0)?.deleted, '보호자가 0명이어도 약은 유지된다').toBe(false);
      });

      await test.step('다시 연결하면 이어서 알림이 간다', async () => {
        const gn = await tempUser('GUARDIAN', { phone: null });
        connect(gn.id, w0.id);
        await waitTick(() => reminderLogCount(m0, 1), '재연결 뒤 같은 약의 첫 알림').toBe(1);
      });
    } finally {
      cleanAdminAudit([admin.id]);
    }
  });

  test('CONN-A40 30분 유예·자정·시각 수정 경계', TAGS, async ({ tempUser, loginAs }) => {
    test.skip(!clockSafe(40, 15), '자정 앞뒤에는 건너뜀');
    test.setTimeout(330_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const far = kstTime(90);
    const mk = (name: string) => insertMedicationRow({ wardId: ward.id, createdBy: guardian.id, name: `[QA-P1a] ${name}`, doseExpr: far });

    const inGrace = mk('유예안');
    const outGrace = mk('유예밖');
    const checked = mk('체크한약');
    const keepLog = mk('기록유지');

    await test.step('준비: 체크한 약의 시각을 이미 지난 시각으로 고치고, 기록이 있는 약을 지난 시각으로 고친다', async () => {
      await intake(w.api, checked);
      expect((await g.api.raw('PATCH', `/api/guardian/medication/${checked}`, { doseTime: kstHm(-2) })).status()).toBe(200);

      psql(`INSERT INTO medication_reminder_log (medication_id, dose_date, attempt, sent_at)
            VALUES (${keepLog}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, now());`);
      expect((await g.api.raw('PATCH', `/api/guardian/medication/${keepLog}`, { doseTime: kstHm(-20) })).status()).toBe(200);
      expect(reminderLogCount(keepLog), '이미 지난 시각으로 고쳐도 받은 알림 기록은 지워지지 않는다(거짓 알림 방지)').toBe(1);
    });

    // 29분·31분은 스케줄러 주기(1분) 때문에 경계에서 흔들려 28분·32분으로 잡는다
    setDose([inGrace], kstHm(-28));
    setDose([outGrace], kstHm(-32));

    await waitTick(() => reminderLogCount(inGrace, 1), '28분 지난 약은 유예(30분) 안이라 발송').toBe(1);
    expect(reminderLogCount(outGrace), '32분 지난 약은 유예 밖이라 발송 안 함').toBe(0);
    expect(reminderLogCount(checked), '체크한 약은 시각을 고쳐도 알림이 가지 않는다').toBe(0);
    expect(reminderLogCount(keepLog), '기록이 있는 약은 다시 보내지 않는다').toBe(1);
    expect(notifRows('MEDICATION_REMINDER', ward.id), '이번 바퀴의 알림은 유예 안의 약 1건뿐').toHaveLength(1);

    test.info().annotations.push({
      type: '확인하지 못한 것',
      description:
        '자정을 넘기는 경계(밤 11시 50분 약을 자정 뒤에 놓치면 건너뜀)는 서버 시계를 바꿀 수 없어 확인하지 않았다(코드 MedicationReminderPlanner.graceWindowStart 가 자정 이후 첫 30분은 00:00 부터 보는 규칙). 수동 확인 필요. ' +
        '유예 29분·31분 대신 28분·32분으로 확인했다(스케줄러 1분 주기 때문에 경계가 흔들려서). 즉 경계 +-2분까지만 확인했고 30분 정각 바로 앞뒤는 확인하지 않았다.',
    });
  });

  test('CONN-A41 중복 발송 방지(서버 재시작·동시)', TAGS, async ({ tempUser }) => {
    test.skip(!clockSafe(25, 15), '자정 앞뒤에는 건너뜀');
    test.setTimeout(480_000);
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const w1 = await tempUser('WARD', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    const w2 = await tempUser('WARD', { phone: null });
    connect(g1.id, w1.id);
    connect(g2.id, w2.id);

    await test.step('DB 가 같은 약·날·회차의 두 번째 기록을 거부한다(UNIQUE)', async () => {
      const spare = insertMedicationRow({ wardId: w1.id, createdBy: g1.id, name: '[QA-P1a] 유일성', doseExpr: kstTime(90) });
      const insert = `INSERT INTO medication_reminder_log (medication_id, dose_date, attempt, sent_at)
                      VALUES (${spare}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, now());`;
      psql(insert);
      expect(() => psql(insert), '같은 약·날·회차를 한 번 더 넣으면 오류').toThrow(/uq_medication_reminder/);
      expect(reminderLogCount(spare, 1)).toBe(1);
      // 회차가 다르면(재알림) 허용
      psql(`INSERT INTO medication_reminder_log (medication_id, dose_date, attempt, sent_at)
            VALUES (${spare}, (now() AT TIME ZONE 'Asia/Seoul')::date, 2, now());`);
      expect(reminderLogCount(spare)).toBe(2);
    });

    const med = insertMedicationRow({ wardId: w1.id, createdBy: g1.id, name: '[QA-P1a] 한번만', doseExpr: kstTime(90) });
    setDose([med], kstHm(-1));

    await test.step('스케줄러 한 바퀴: 1건만 발송', async () => {
      await waitTick(() => reminderLogCount(med, 1), '첫 알림 기록').toBe(1);
      await waitTick(() => notifRows('MEDICATION_REMINDER', w1.id).length, '알림 이력').toBe(1);
    });

    await test.step('다음 바퀴(다른 약이 발송되는 것으로 확인)가 지나도 그 약은 그대로 1건', async () => {
      const sentinel = insertMedicationRow({ wardId: w2.id, createdBy: g2.id, name: '[QA-P1a] 다음바퀴표시', doseExpr: kstTime(90) });
      setDose([sentinel], kstHm(-1));
      await waitTick(() => reminderLogCount(sentinel, 1), '다음 바퀴가 돌았다(표시용 약이 발송됨)').toBe(1);
      expect(reminderLogCount(med, 1), '같은 약·날·회차 기록은 1건').toBe(1);
      expect(notifRows('MEDICATION_REMINDER', w1.id), '알림 이력도 1건').toHaveLength(1);
    });

    test.info().annotations.push({
      type: '확인하지 못한 것',
      description: '서버 재시작·스케줄러 동시 실행은 서버를 건드릴 수 없어 만들지 못했다. 대신 DB UNIQUE(uq_medication_reminder)가 두 번째 기록을 거부하는 것과, 서로 다른 두 바퀴에서 1건만 남는 것을 확인했다.',
    });
  });

  test('CONN-A42 저녁 요약 제외 규칙', TAGS, async ({ tempUser, loginAs }) => {
    test.skip(!clockSafe(25, 15), '자정 앞뒤에는 건너뜀');
    test.setTimeout(540_000);
    const g = await tempUser('GUARDIAN', { phone: null });
    const gs = await tempUser('GUARDIAN', { phone: null });
    const w1 = await tempUser('WARD', { phone: null });
    const w2 = await tempUser('WARD', { phone: null });
    const ws = await tempUser('WARD', { phone: null });
    connect(g.id, w1.id);
    connect(g.id, w2.id);
    connect(gs.id, ws.id);
    const gApi = await loginAs(g);
    const w2Api = await loginAs(w2);

    const cutoff = kstHm(-3); // 이 보호자가 정한 요약 시각: 지금보다 3분 전(이미 지났고 발송 창 안)
    for (const wardId of [w1.id, w2.id]) {
      const res = await gApi.api.raw('PUT', `/api/guardian/ward/${wardId}/medication-alert-setting`, { missedAlertEnabled: true, missedAlertTime: cutoff });
      expect(res.status(), '요약 시각 설정').toBe(200);
    }

    const yesterday = `(now() - interval '1 day')`;
    const mk = (wardId: string, name: string, dose: string, createdAtExpr: string) =>
      insertMedicationRow({ wardId, createdBy: g.id, name: `[QA-P1a] ${name}`, doseExpr: dose, createdAtExpr });
    const dose = (offset: number) => kstHm(offset);
    // 기준 시각(cutoff)은 지금-3분. 약은 모두 지금 이전 시각이라 서버가 "복용 시각이 지난 약"으로 본다
    const before = mk(w1.id, '기준전', dose(-11), yesterday); // 제외 아님: 센다
    const exact = mk(w1.id, '정각등록', dose(-8), todayAt(`'${dose(-8)}'::time`)); // 정각에 등록: 센다
    const late = mk(w1.id, '등록후시각', dose(-7), todayAt(`('${dose(-7)}'::time + interval '5 minutes')`)); // 등록 전에 지난 시각: 제외
    const after = mk(w1.id, '기준후', dose(-2), yesterday); // 요약 시각 이후의 약: 제외
    const takenOnly = mk(w2.id, '체크됨', dose(-11), yesterday); // 미체크 0건인 피보호자
    await intake(w2Api.api, takenOnly);

    await test.step('요약: 정각 등록은 세고, 시각 이후·등록 전 시각의 약은 제외, 미체크 0건이면 안 보냄', async () => {
      await waitTick(() => missedLogs(g.id, w1.id).length, '요약 발송 기록').toBe(1);
      const [row] = missedLogs(g.id, w1.id);
      expect(row, '센 약: 기준전·정각등록 2건 중 2건 미체크').toEqual({ missed: 2, total: 2 });
      await waitTick(() => notifRows('MEDICATION_MISSED', g.id, w1.id).length, '요약 알림 이력').toBe(1);
      const [log] = notifRows('MEDICATION_MISSED', g.id, w1.id);
      expect(log.title).toBe(`오늘 복약 확인 · ${w1.name}님`);
      expect(log.body, '정한 시각까지의 약만 센다').toBe(`${cutoff.slice(0, 5)}까지 예정된 복약 2건 중 2건이 체크되지 않았습니다.`);
      expect(missedLogs(g.id, w2.id), '미체크 0건인 피보호자에게는 안 보낸다').toHaveLength(0);
      expect(notifRows('MEDICATION_MISSED', g.id, w2.id), '미체크 0건이면 알림 이력도 없다').toHaveLength(0);
      expect(medRow(before)?.deleted && medRow(after)?.deleted, '약은 지워지지 않았다').toBeFalsy();
    });

    await test.step('대시보드 "확인이 필요한 일"·약 카드와 같은 기준(등록 전 시각 제외, 정각 등록은 포함)', async () => {
      const dash = await read(await gApi.api.raw('GET', '/api/guardian/dashboard'));
      expect(dash.status).toBe(200);
      const data = dash.body.data as { pendingActions: { medication: number }; medication: { uncheckedCount: number } };
      // 요약은 정한 시각까지(2건)만 세지만 대시보드는 "지금까지 지난 미체크"라 기준후(지금-2분)도 센다 = 3건. 등록후시각(제외)은 둘 다 빠진다
      expect(data.medication.uncheckedCount, '대시보드 미체크 약(기준전·정각등록·기준후)').toBe(3);
      expect(data.pendingActions.medication, '확인이 필요한 일의 복약 건수').toBe(3);
      const cards = await read(await gApi.api.raw('GET', '/api/guardian/medication'));
      const card = (cards.body.data as { wardId: string; medications: { medicationId: number; doseTime: string; createdAt: string }[] }[]).find(c => c.wardId === w1.id)!;
      const registeredAfter = (id: number) => {
        const item = card.medications.find(m => m.medicationId === id)!;
        // 오늘 등록했고 등록 시각이 복용 시각보다 늦으면 "등록 후 시각"(어제 등록한 약은 해당 없음)
        return kstDayOf(item.createdAt) === kstDayOf(Date.now()) && kstClockOf(item.createdAt) > item.doseTime;
      };
      expect(registeredAfter(late), '카드: 등록 후 시각(회색)').toBe(true);
      expect(registeredAfter(exact), '카드: 정각 등록은 등록 후가 아니다').toBe(false);
      expect(registeredAfter(before)).toBe(false);
      expect(registeredAfter(after)).toBe(false);
    });

    await test.step('같은 날 두 번째는 안 간다(하루 1번)', async () => {
      // 다른 보호자의 요약이 발송되는 것으로 "다음 바퀴가 돌았다"를 확인한다
      insertMedicationRow({ wardId: ws.id, createdBy: gs.id, name: '[QA-P1a] 표시용', doseExpr: dose(-11), createdAtExpr: yesterday });
      const gsLogin = await loginAs(gs);
      const res = await gsLogin.api.raw('PUT', `/api/guardian/ward/${ws.id}/medication-alert-setting`, { missedAlertEnabled: true, missedAlertTime: kstHm(-1) });
      expect(res.status()).toBe(200);
      await waitTick(() => missedLogs(gs.id, ws.id).length, '다음 바퀴가 돌았다(다른 보호자의 요약이 발송됨)').toBe(1);
      expect(missedLogs(g.id, w1.id), '같은 날 같은 피보호자 요약 기록은 1건').toHaveLength(1);
      expect(notifRows('MEDICATION_MISSED', g.id, w1.id), '알림 이력도 1건').toHaveLength(1);
    });
  });

  test.fixme('CONN-A43 기능 끄기 환경변수', TAGS, async () => {
    // MEDICATION_REMINDER_ENABLED=false·MEDICATION_MISSED_ALERT_ENABLED=false 는 서버 환경변수라 값을 바꾸려면 컨테이너를 다시 띄워야 한다.
    // 서버 설정·컨테이너 변경은 금지라 자동화할 수 없다(검토 결과도 fixme 가 맞다고 함). 근거: N33·N35 의 발송 성공으로 현재 둘 다 켜져 있음을 간접 확인. 현재 배포본은 둘 다 켜진 상태이고(이 파일의 N33·N35 가 발송을 확인),
    // 코드(MedicationReminderScheduler)는 앞의 것이 false 면 첫·재알림만, 뒤의 것이 false 면 저녁 요약만 건너뛴다. 수동 확인 필요.
  });

  test('CONN-N35 저녁 체크 안 된 약 요약(보호자)', TAGS, async ({ tempUser, loginAs }) => {
    test.skip(!clockSafe(25, 15), '자정 앞뒤에는 건너뜀');
    test.setTimeout(330_000);
    const g1 = await tempUser('GUARDIAN', { phone: null }); // 둘 다 켬
    const g2 = await tempUser('GUARDIAN', { phone: null }); // 계정 토글 끔
    const g3 = await tempUser('GUARDIAN', { phone: null }); // 피보호자별 설정 끔
    const ward = await tempUser('WARD', { phone: null });
    for (const g of [g1, g2, g3]) connect(g.id, ward.id);
    const [a1, a2, a3] = [await loginAs(g1), await loginAs(g2), await loginAs(g3)];
    const cutoff = kstHm(-3);
    const alertPath = `/api/guardian/ward/${ward.id}/medication-alert-setting`;

    expect((await a1.api.raw('PUT', alertPath, { missedAlertEnabled: true, missedAlertTime: cutoff })).status()).toBe(200);
    expect((await a2.api.raw('PUT', alertPath, { missedAlertEnabled: true, missedAlertTime: cutoff })).status()).toBe(200);
    expect((await a2.api.raw('PUT', '/api/guardian/notification-type-setting', { medication: false })).status(), '계정 토글 끔').toBe(200);
    expect((await a3.api.raw('PUT', alertPath, { missedAlertEnabled: false, missedAlertTime: cutoff })).status(), '이 피보호자 알림 끔').toBe(200);

    const yesterday = `(now() - interval '1 day')`;
    insertMedicationRow({ wardId: ward.id, createdBy: g1.id, name: '[QA-P1a] 미체크', doseExpr: kstHm(-11), createdAtExpr: yesterday });
    insertMedicationRow({ wardId: ward.id, createdBy: g1.id, name: '[QA-P1a] 요약시각이후', doseExpr: kstHm(-2), createdAtExpr: yesterday });

    await waitTick(() => notifRows('MEDICATION_MISSED', g1.id, ward.id).length, '켜 둔 보호자의 요약').toBe(1);
    const [log] = notifRows('MEDICATION_MISSED', g1.id, ward.id);
    expect(log.title).toBe(`오늘 복약 확인 · ${ward.name}님`);
    expect(log.body, '정한 시각까지의 약만 센다(그 뒤 약은 뺀다)').toBe(`${cutoff.slice(0, 5)}까지 예정된 복약 1건 중 1건이 체크되지 않았습니다.`);
    expect(log.channels, '앱 푸시를 시도한다').toContain('FCM');
    expect(missedLogs(g1.id, ward.id), '하루 한 번 기록').toEqual([{ missed: 1, total: 1 }]);

    expect(notifCount('MEDICATION_MISSED', g2.id), '계정 토글이 꺼진 보호자에게는 안 간다').toBe(0);
    expect(missedLogs(g2.id, ward.id), '계정 토글 끈 보호자는 발송 기록도 없다').toHaveLength(0);
    expect(notifCount('MEDICATION_MISSED', g3.id), '피보호자별 설정이 꺼진 보호자에게는 안 간다').toBe(0);
    expect(missedLogs(g3.id, ward.id)).toHaveLength(0);
    expect(notifCount('MEDICATION_MISSED', ward.id), '피보호자 본인에게는 안 간다').toBe(0);

    test.info().annotations.push({
      type: '문서-코드 불일치(결정 필요)',
      description:
        '기획 확인 필요. 문서·케이스의 문구는 "아직 체크되지 않았습니다"인데 배포 코드(MedicationMissedAlertService)의 본문은 "HH:MM까지 예정된 복약 N건 중 M건이 체크되지 않았습니다." 로 "아직"이 없다. 코드 값으로 고정했다. ' +
        '"약을 안 드셨습니다" 같은 단정은 쓰지 않는 점은 그대로다.',
    });
  });
});
