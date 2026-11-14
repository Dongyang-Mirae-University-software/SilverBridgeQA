/**
 * 최종 QA - 복약(CONN) P2: A31 A38 A44 A45 A53.
 *
 * 임시 사용자만 쓴다. 임시 사용자는 전화번호·푸시 토큰이 없어 실제 푸시·문자는 나가지 않는다.
 * 화면 글자는 배포 FE(a8666240, v13) 기준이다: 피보호자 "/ward/medication", 보호자 "/guardian/medication".
 * 서버 오류(5xx)는 공용 5xx 감시가 실패로 잡으므로, 응답을 못 받은 상태(오프라인·연결 끊김)로 흉내 낸다.
 * 약 봉투 읽기(Claude 호출)는 화면 동작만 보는 케이스라 읽기 응답을 가짜로 바꿔 실제 호출을 만들지 않는다.
 */
import { runInNewContext } from 'node:vm';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psql, psqlRows, sqlStr } from '../../../src/remote';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { intakeCount, medicationRow } from './_helpers-conn';
import {
  clockSafe, connectDaysAgo, insertMedicationRow, kstHm, kstTime, medCountOf, notifRows, reminderLogCount,
} from './_helpers-conn-p1a';
import { call, expectRes, renderBagPng } from './_helpers-conn-p1b';
import { TAGS } from './_helpers-conn-p2';

const CHECK_FAILED_NOTICE = '체크하지 못했어요. 목록을 다시 불러왔으니 한 번 더 눌러 주세요';
const DELETE_FAILED_NOTICE = '삭제하지 못했어요. 목록을 다시 불러왔으니 확인 후 다시 시도해 주세요.';
const EDIT_FAILED_NOTICE = '저장에 실패했습니다. 다시 시도해 주세요.';
const ALERT_SAVE_FAILED_NOTICE = '알림 시각을 저장하지 못했어요. 다시 골라 주세요.';

/** 이미 며칠 전에 등록한 약으로 만든다(복용 시각 뒤에 등록한 약으로 보여 "내일부터"가 되는 일을 막는다) */
function addOldMed(wardId: string, createdBy: string, name: string, doseTime = '12:00:00'): number {
  return insertMedicationRow({ wardId, createdBy, name, doseExpr: doseTime, createdAtExpr: "now() - interval '2 days'" });
}

test.describe('CONN 복약 P2', () => {
  test('CONN-A31 timeSlot·doseTime 오류', TAGS, async ({ tempUser, loginAs }) => {
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connectDaysAgo(guardian.id, ward.id, 3);
    const g = await loginAs(guardian);
    const path = `/api/guardian/ward/${ward.id}/medication`;
    const base = { name: '[QA-P2] 시간대약', doseAmount: 1 };

    await test.step('대조: 올바른 시간대와 시각은 200 으로 등록된다', async () => {
      expectRes(await call(g.api, 'POST', path, { ...base, timeSlot: 'MORNING', doseTime: '08:00:00' }), 200, undefined, '정상');
      expect(medCountOf(ward.id)).toBe(1);
    });

    await test.step('timeSlot 누락·허용 밖 값은 400 INVALID_INPUT 이고 약이 늘지 않는다', async () => {
      const bad: [string, Record<string, unknown>][] = [
        ['timeSlot 누락', { ...base, doseTime: '08:00:00' }],
        ['timeSlot null', { ...base, timeSlot: null, doseTime: '08:00:00' }],
        ['timeSlot 허용 밖 값', { ...base, timeSlot: 'NOON', doseTime: '08:00:00' }],
        ['timeSlot 소문자', { ...base, timeSlot: 'morning', doseTime: '08:00:00' }],
      ];
      for (const [label, body] of bad) expectRes(await call(g.api, 'POST', path, body), 400, 'INVALID_INPUT', label);
      expect(medCountOf(ward.id), '실패한 요청은 약을 만들지 않는다').toBe(1);
    });

    await test.step('doseTime 형식 오류는 400 INVALID_INPUT 이고 약이 늘지 않는다', async () => {
      const bad: [string, unknown][] = [
        ['시각 범위 밖 25:00:00', '25:00:00'],
        ['분 범위 밖 08:61:00', '08:61:00'],
        ['글자 "8시"', '8시'],
        ['글자 "abc"', 'abc'],
        ['숫자 800', 800],
      ];
      for (const [label, doseTime] of bad) {
        expectRes(await call(g.api, 'POST', path, { ...base, timeSlot: 'MORNING', doseTime }), 400, 'INVALID_INPUT', label);
      }
      expect(medCountOf(ward.id), '실패한 요청은 약을 만들지 않는다').toBe(1);
    });

    await test.step('timeSlot 에 숫자(허용 목록 밖 값)를 보내도 400 이어야 한다', async () => {
      const res = await call(g.api, 'POST', path, { ...base, name: '[QA-P2] 숫자시간대약', timeSlot: 1, doseTime: '12:00:00' });
      const stored = psql(`SELECT coalesce(string_agg(time_slot, ','), '<없음>') FROM medication WHERE ward_id = ${sqlStr(ward.id)} AND name = '[QA-P2] 숫자시간대약';`);
      test.info().annotations.push({
        type: 'timeSlot 숫자 1 실측',
        description: `상태 ${res.status}, 저장된 시간대 ${stored}. 고칠 곳 추정: BE MedicationCreateRequest 의 timeSlot 역직렬화(숫자 순번을 받지 않게 Jackson ACCEPT_INT_ENUM 끄기)`,
      });
      expect.soft(res.status, 'timeSlot 숫자 1 (허용 목록 밖 값)의 상태 코드').toBe(400);
    });
  });

  test('CONN-A38 복약 처리 실패 시 화면 안내', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connectDaysAgo(guardian.id, ward.id, 3);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    test.info().annotations.push({
      type: '한계(5xx 본문 안내)',
      description: "케이스의 '500 실패'는 연결 끊김(abort)으로만 흉내 냈다. page.route 의 route.fulfill 로 만든 가짜 500 응답도 브라우저 response 이벤트를 일으켜 공용 5xx 감시(src/browser.ts)가 실패로 잡으므로, 서버가 500 본문(code·message)을 줄 때의 화면 안내는 이 틀 안에서 확인하지 않는다. 서버 안내 문구 표시는 404 본문으로 확인한다",
    });

    await test.step('피보호자 체크 실패(404): 안내가 뜨고 목록을 다시 불러와 지워진 약이 빠지며, 다시 누르면 체크된다', async () => {
      const m1 = addOldMed(ward.id, guardian.id, '[QA-P2] 체크약1');
      const m2 = addOldMed(ward.id, guardian.id, '[QA-P2] 체크약2');
      const wardPage = await openAs(w.who, '/ward/medication');
      await expect(wardPage.getByText('[QA-P2] 체크약1')).toBeVisible();
      await expect(wardPage.getByText('[QA-P2] 체크약2')).toBeVisible();

      // 그 사이 보호자가 한 약을 지운다 - 이 화면은 낡은 목록을 들고 있다
      expect((await g.api.raw('DELETE', `/api/guardian/medication/${m2}`)).status(), '보호자 삭제').toBe(200);
      const failed = wardPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/ward/medication/intake/batch'));
      await wardPage.getByRole('button', { name: /약 먹었어요$/ }).click();
      const res = await failed;
      expect(res.status(), '지워진 약이 섞인 묶음 체크').toBe(404);
      const body = (await res.json()) as { code?: string; message?: string };
      expect(body.code).toBe('MEDICATION_NOT_FOUND');

      const alert = wardPage.getByRole('alert').filter({ hasText: '체크하지 못했어요' });
      await expect(alert, '실패 안내').toHaveText(CHECK_FAILED_NOTICE);
      await expect(wardPage.getByText('[QA-P2] 체크약2'), '다시 불러온 목록에서 지워진 약이 빠진다').toHaveCount(0);
      await expect(wardPage.getByText('[QA-P2] 체크약1')).toBeVisible();
      expect(intakeCount(m1), '한 트랜잭션이라 남은 약도 체크되지 않았다').toBe(0);

      // 서버 안내 문구(케이스 기대값)를 화면이 보여 주는지: 배포 FE 는 원인과 상관없는 고정 문구만 쓴다
      expect.soft(await alert.innerText(), '서버가 준 안내 문구가 화면에 보인다').toContain(body.message ?? '(서버 문구 없음)');

      await wardPage.getByRole('button', { name: /약 먹었어요$/ }).click();
      await expect.poll(() => intakeCount(m1), { message: '다시 누르면 체크된다' }).toBe(1);
      await expect(wardPage.getByText('오늘 약 다 먹었어요')).toBeVisible();
    });

    await test.step('피보호자 체크 실패(연결 끊김): 실패 안내가 보이고, 연결이 돌아오면 다시 눌러 체크된다', async () => {
      const m3 = addOldMed(ward.id, guardian.id, '[QA-P2] 오프라인약', '13:00:00');
      const wardPage = await openAs(w.who, '/ward/medication');
      await expect(wardPage.getByText('[QA-P2] 오프라인약')).toBeVisible();
      // 브라우저 오프라인 모드는 화면의 요청 처리기가 연결 복구를 기다려 멈추므로, 체크 요청만 연결이 끊긴 것으로 처리한다
      const BATCH = '**/api/ward/medication/intake/batch';
      await wardPage.route(BATCH, route => route.abort('internetdisconnected'));
      await wardPage.getByRole('button', { name: /약 먹었어요$/ }).click();
      await expect(wardPage.getByRole('alert').filter({ hasText: '체크하지 못했어요' }), '연결 끊김 실패 안내').toHaveText(CHECK_FAILED_NOTICE);
      expect(intakeCount(m3), '체크되지 않았다').toBe(0);
      await wardPage.unroute(BATCH);
      await wardPage.getByRole('button', { name: /약 먹었어요$/ }).click();
      await expect.poll(() => intakeCount(m3), { message: '연결이 돌아온 뒤 다시 누르면 체크된다' }).toBe(1);
    });

    await test.step('보호자 삭제 실패(이미 지워진 약): 안내가 뜨고 목록을 다시 불러와 그 약이 빠진다', async () => {
      const keep = addOldMed(ward.id, guardian.id, '[QA-P2] 남는약', '07:00:00');
      const gone = addOldMed(ward.id, guardian.id, '[QA-P2] 지워질약', '07:00:00');
      const guardianPage = await openAs(g.who, '/guardian/medication');
      await expect(guardianPage.getByText('[QA-P2] 지워질약')).toBeVisible();
      // 다른 경로(다른 보호자 대신 API)로 먼저 지운다
      expect((await g.api.raw('DELETE', `/api/guardian/medication/${gone}`)).status(), '먼저 삭제').toBe(200);
      await guardianPage.getByRole('button', { name: '[QA-P2] 지워질약 삭제', exact: true }).click();
      const failed = guardianPage.waitForResponse(r => r.request().method() === 'DELETE' && r.url().endsWith(`/api/guardian/medication/${gone}`));
      await guardianPage.getByRole('button', { name: '[QA-P2] 지워질약 삭제하기', exact: true }).click();
      const res = await failed;
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      expect(res.status(), '이미 지워진 약 삭제').toBe(404);
      expect(body.code).toBe('MEDICATION_NOT_FOUND');
      const alert = guardianPage.getByRole('alert').filter({ hasText: '삭제하지 못했어요' });
      await expect(alert, '삭제 실패 안내').toHaveText(DELETE_FAILED_NOTICE);
      await expect(guardianPage.getByText('[QA-P2] 지워질약'), '다시 불러온 목록에서 빠진다').toHaveCount(0);
      await expect(guardianPage.getByText('[QA-P2] 남는약')).toBeVisible();
      expect(medicationRow(keep)?.deleted, '남는 약은 그대로').toBe(false);
      expect.soft(await alert.innerText(), '서버가 준 안내 문구(원인)가 화면에 보인다').toContain(body.message ?? '(서버 문구 없음)');
    });

    await test.step('보호자 수정 저장 실패(이미 지워진 약): 수정 창에 실패 안내가 뜨고 창이 닫히지 않는다', async () => {
      const target = addOldMed(ward.id, guardian.id, '[QA-P2] 수정약', '07:30:00');
      const guardianPage = await openAs(g.who, '/guardian/medication');
      await expect(guardianPage.getByText('[QA-P2] 수정약')).toBeVisible();
      expect((await g.api.raw('DELETE', `/api/guardian/medication/${target}`)).status(), '먼저 삭제').toBe(200);
      await guardianPage.getByRole('button', { name: '[QA-P2] 수정약 수정', exact: true }).click();
      const dialog = guardianPage.getByRole('dialog', { name: '약 수정' });
      await expect(dialog).toBeVisible();
      const failed = guardianPage.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith(`/api/guardian/medication/${target}`));
      await dialog.getByRole('button', { name: '수정', exact: true }).click();
      const res = await failed;
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      expect(res.status(), '이미 지워진 약 수정').toBe(404);
      await expect(dialog, '저장 실패 안내').toContainText(EDIT_FAILED_NOTICE);
      expect.soft(await dialog.innerText(), '서버가 준 안내 문구(원인)가 화면에 보인다').toContain(body.message ?? '(서버 문구 없음)');
    });

    await test.step('보호자 알림 시각 저장 실패(오프라인): 안내가 뜬다', async () => {
      addOldMed(ward.id, guardian.id, '[QA-P2] 시각약', '08:30:00');
      const guardianPage = await openAs(g.who, '/guardian/medication');
      const alertCard = guardianPage.getByRole('region', { name: '알림 설정' });
      await alertCard.getByRole('button', { name: /안 드시면 알림 받을 시각/ }).click();
      await guardianPage.getByRole('group', { name: '오전 오후' }).getByRole('button', { name: '오후', exact: true }).click();
      await guardianPage.getByRole('group', { name: '시' }).getByRole('button', { name: '6', exact: true }).click();
      await guardianPage.getByRole('group', { name: '분' }).getByRole('button', { name: '30', exact: true }).click();
      await guardianPage.route('**/medication-alert-setting', route => route.abort('internetdisconnected'));
      await guardianPage.getByRole('button', { name: '오후 6:30로 정하기' }).click();
      await expect(alertCard.getByRole('alert'), '시각 저장 실패 안내').toHaveText(ALERT_SAVE_FAILED_NOTICE);
      const now = await call(g.api, 'GET', `/api/guardian/ward/${ward.id}/medication-alert-setting`);
      expectRes(now, 200, undefined, '저장 값 조회');
      expect(String((now.data as { missedAlertTime?: string }).missedAlertTime).startsWith('18:30'), '실패했으니 18:30 은 저장되지 않았다').toBe(false);
    });
  });

  test('CONN-A44 알림 설정 API 오류·권한', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const stranger = await tempUser('WARD', { phone: null });
    connectDaysAgo(guardian.id, ward.id, 3);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const settingPath = (wardId: string) => `/api/guardian/ward/${wardId}/medication-alert-setting`;

    await test.step('대조: 연결된 피보호자에게 19:30 으로 정하면 200', async () => {
      const res = await call(g.api, 'PUT', settingPath(ward.id), { missedAlertEnabled: true, missedAlertTime: '19:30:00' });
      expectRes(res, 200, undefined, '정상');
      expect(String((res.data as { missedAlertTime?: string }).missedAlertTime).startsWith('19:30'), '저장된 시각').toBe(true);
    });

    await test.step('연결되지 않은 피보호자를 지정하면 403 MEDICATION_NOT_AUTHORIZED (조회·변경 모두)', async () => {
      expectRes(await call(g.api, 'PUT', settingPath(stranger.id), { missedAlertTime: '20:00:00' }), 403, 'MEDICATION_NOT_AUTHORIZED', '연결 안 된 변경');
      expectRes(await call(g.api, 'GET', settingPath(stranger.id)), 403, 'MEDICATION_NOT_AUTHORIZED', '연결 안 된 조회');
    });

    await test.step('missedAlertTime 형식 오류는 400 INVALID_INPUT 이고 기존 값은 그대로', async () => {
      for (const [label, value] of [['시각 범위 밖', '25:00:00'], ['글자', '저녁 7시'], ['숫자', 1930]] as const) {
        expectRes(await call(g.api, 'PUT', settingPath(ward.id), { missedAlertTime: value }), 400, 'INVALID_INPUT', label);
      }
      const now = await call(g.api, 'GET', settingPath(ward.id));
      expectRes(now, 200, undefined, '조회');
      expect(String((now.data as { missedAlertTime?: string }).missedAlertTime).startsWith('19:30'), '기존 시각 유지').toBe(true);
    });

    await test.step('피보호자가 호출하면 403 FORBIDDEN', async () => {
      expectRes(await call(w.api, 'PUT', settingPath(ward.id), { missedAlertTime: '20:00:00' }), 403, 'FORBIDDEN', '피보호자 변경');
      expectRes(await call(w.api, 'GET', settingPath(ward.id)), 403, 'FORBIDDEN', '피보호자 조회');
    });

    await test.step('화면: 복약 현황 조회가 실패하면 오류 안내가 보이고, [새로고침]으로 다시 불러오면 알림 설정이 나온다', async () => {
      addOldMed(ward.id, guardian.id, '[QA-P2] 설정화면약', '08:30:00');
      const page = await openAs(g.who, null);
      const LIST = '**/api/guardian/medication';
      await page.route(LIST, route => route.abort('failed'));
      await page.goto('/guardian/medication');
      await expect(page.getByText('복약 현황을 불러오지 못했습니다.'), '조회 실패 안내').toBeVisible();
      await expect(page.getByRole('region', { name: '알림 설정' }), '실패했을 때 알림 설정 칸은 없다').toHaveCount(0);
      await page.unroute(LIST);
      await page.getByRole('button', { name: '새로고침', exact: true }).click();
      await expect(page.getByText('복약 현황을 불러오지 못했습니다.')).toHaveCount(0);
      await expect(page.getByRole('region', { name: '알림 설정' }).getByRole('button', { name: /안 드시면 알림 받을 시각 오후 7:30/ }), '다시 불러온 설정 시각').toBeVisible();
    });
  });

  test('CONN-A45 복약 푸시·알림 채널 꺼짐 상태', TAGS, async ({ tempUser, loginAs, request }) => {
    test.setTimeout(330_000);
    test.skip(!clockSafe(25, 15), '자정 앞뒤에는 "지금 몇 분 전" 시각이 하루를 넘나들어 건너뜀');
    await relaxAuthRates();

    await test.step('푸시를 누르면 가는 화면: 복약 알림은 /ward/medication, 놓친 약·중지 알림은 /guardian/medication', async () => {
      const res = await request.get(`${env.baseUrl}/push-sw-logic.js`);
      expect(res.status(), '서비스 워커 논리 파일').toBe(200);
      const context: { self: { SilverBridgePush?: { getPath: (data: { type: string }, role: string | null, action?: string) => string } }; atob: typeof atob } = { self: {}, atob };
      runInNewContext(await res.text(), context);
      const getPath = context.self.SilverBridgePush!.getPath;
      const expected: Record<string, string> = {
        MEDICATION_REMINDER: '/ward/medication',
        MEDICATION_MISSED: '/guardian/medication',
        MEDICATION_STOPPED: '/guardian/medication',
      };
      for (const role of ['WARD', 'GUARDIAN', null]) {
        const actual = Object.fromEntries(Object.keys(expected).map(type => [type, getPath({ type }, role)]));
        expect(actual, `역할 ${role ?? '모름'} 의 이동 경로`).toEqual(expected);
      }
      test.info().annotations.push({
        type: '자동화 한계',
        description: '실제 푸시를 받아 알림을 누르는 동작(서비스 워커 notificationclick)은 브라우저 자동화로 만들 수 없어, 배포된 push-sw-logic.js 의 이동 경로 계산(getPath)만 확인했다',
      });
    });

    await test.step('푸시·문자 등 모든 채널을 꺼 둔 피보호자: 복약 알림이 "보내지 않음(NOT_SENT)"으로 이력에 남는다', async () => {
      const guardian = await tempUser('GUARDIAN', { phone: null });
      const ward = await tempUser('WARD', { phone: null });
      connectDaysAgo(guardian.id, ward.id, 3);
      const w = await loginAs(ward);
      const off = ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: false }));
      expect((await w.api.raw('PUT', '/api/user/me/notification-settings', { settings: off })).status(), '채널 설정 저장').toBe(200);

      const med = insertMedicationRow({ wardId: ward.id, createdBy: guardian.id, name: '[QA-P2] 꺼둔채널약', doseExpr: kstTime(90) });
      psql(`UPDATE medication SET dose_time = ${sqlStr(kstHm(-1))}::time WHERE id = ${med};`);

      await expect
        .poll(() => reminderLogCount(med, 1), { message: '스케줄러가 첫 알림 기록(회차 1)을 남긴다', timeout: 200_000, intervals: [3000, 5000] })
        .toBe(1);
      await expect
        .poll(() => notifRows('MEDICATION_REMINDER', ward.id).length, { message: '알림 이력 한 줄', timeout: 30_000, intervals: [2000] })
        .toBe(1);
      const [log] = notifRows('MEDICATION_REMINDER', ward.id);
      expect(log.result, '이력 결과').toBe('NOT_SENT');
      expect(log.reason, '보내지 않은 이유').toBe('NO_ENABLED_CHANNEL');
      expect(log.channels.includes('FCM'), '시도한 채널이 없다').toBe(false);
      test.info().annotations.push({
        type: '보류 항목(XCUT-G28) 실측',
        description: '채널을 모두 꺼 둔 피보호자의 복약 알림은 이력에 result=NOT_SENT, 사유=NO_ENABLED_CHANNEL("수신자가 받을 채널을 꺼 둠")로 남고 재알림 판단 기록(회차 1)은 정상으로 남는다. 보호자에게는 이 상태를 알리지 않는다',
      });
    });
  });

  test('CONN-A53 OCR 결과 오독·중복 이름은 사람이 확인', TAGS, async ({ tempUser, loginAs, openAs, page }) => {
    test.setTimeout(240_000);
    await relaxAuthRates();
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connectDaysAgo(guardian.id, ward.id, 3);
    const g = await loginAs(guardian);
    const misread = '타이레놀정5OO밀리그램'; // 숫자 0 을 영문 O 로 한 글자 오독
    const dup = '아스피린장용정100밀리그램';
    const png = await renderBagPng(page, [{ name: '타이레놀정500밀리그램', dose: '1정' }]);

    const guardianPage = await openAs(g.who, null);
    const drug = (name: string, confidence: 'high' | 'low') => ({
      name, perDose: 1, timesPerDay: 1, days: 3, slots: ['MORNING'], timing: '식후', confidence, inList: null, suggestions: null,
    });
    await guardianPage.route('**/medication/ocr', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, message: '약 봉투를 읽었습니다.', data: { readable: true, drugs: [drug(misread, 'low'), drug(dup, 'high'), drug(dup, 'high')] } }),
      }),
    );
    const batchBodies: { drugs: { name: string; doseAmount: number }[]; times: { doseTime: string }[] }[] = [];
    guardianPage.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/medication/batch')) batchBodies.push(JSON.parse(request.postData() ?? '{}'));
    });
    await guardianPage.goto('/guardian/medication');
    await guardianPage.getByRole('button', { name: '첫 약 추가하기' }).click();
    const dialog = guardianPage.getByRole('dialog', { name: '약 추가' });
    await expect(dialog).toBeVisible();

    await test.step('1글자 오독은 노란 칸으로 확인만 시키고 이름을 고치지 않으며, 같은 이름 둘은 막는다', async () => {
      await dialog.locator('input[type="file"]').setInputFiles({ name: 'bag.png', mimeType: 'image/png', buffer: png });
      await expect(dialog.getByText('약 3개를 찾았어요')).toBeVisible({ timeout: 30_000 });
      await expect(dialog.getByText('노란 칸의 약 이름을 한 번 더 확인해 주세요').first()).toBeVisible();
      const first = dialog.getByLabel('1번째 약 이름');
      await expect(first, '오독한 이름도 자동으로 고치지 않는다').toHaveValue(misread);
      await expect(first, '확인이 필요한 칸은 안내 문구와 연결된다').toHaveAttribute('aria-describedby', /low-confidence/);
      await expect(dialog.getByLabel('2번째 약 이름')).not.toHaveAttribute('aria-describedby', /low-confidence/);
      await expect(dialog.getByText('같은 이름의 약이 두 번 들어 있어요. 하나를 빼 주세요')).toBeVisible();
      await expect(dialog.getByRole('button', { name: '다음', exact: true }), '같은 이름이 있으면 다음으로 갈 수 없다').toBeDisabled();
      expect(medCountOf(ward.id), '읽기만으로는 등록되지 않는다').toBe(0);
      expect(batchBodies, '등록 요청도 나가지 않았다').toHaveLength(0);
    });

    await test.step('같은 이름 하나를 빼면 다음으로 가고, 등록하면 확인 필요 칸도 읽은 이름 그대로 등록된다(200)', async () => {
      await dialog.getByRole('button', { name: '3번째 약 빼기' }).click();
      await expect(dialog.getByText('같은 이름의 약이 두 번 들어 있어요. 하나를 빼 주세요')).toHaveCount(0);
      await dialog.getByRole('button', { name: '다음', exact: true }).click();
      await expect(dialog.getByRole('heading', { name: '언제 드세요?' })).toBeVisible();
      const batch = guardianPage.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/medication/batch'));
      await dialog.getByRole('button', { name: '등록', exact: true }).click();
      expect((await batch).status(), '일괄 등록 응답').toBe(200);
      expect(batchBodies).toHaveLength(1);
      expect(batchBodies[0].drugs.map(d => d.name), '보낸 이름은 읽은 그대로').toEqual([misread, dup]);
      const names = psqlRows(`SELECT DISTINCT name FROM medication WHERE ward_id = ${sqlStr(ward.id)} ORDER BY name;`).map(row => row[0]).sort();
      expect(names, 'DB 에도 읽은 이름 그대로').toEqual([misread, dup].sort());
    });

    await test.step('서버도 같은 이름이 두 번 든 일괄 등록을 400 MEDICATION_BATCH_DUPLICATE_NAME 으로 막는다(공백·대소문자 달라도)', async () => {
      const before = medCountOf(ward.id);
      const batchPath = `/api/guardian/ward/${ward.id}/medication/batch`;
      const times = [{ doseTime: '08:00:00' }];
      const same = { drugs: [{ name: '[QA-P2] 중복약', doseAmount: 1 }, { name: '[QA-P2] 중복약', doseAmount: 1 }], times };
      const spaced = { drugs: [{ name: '[QA-P2] Dup Drug', doseAmount: 1 }, { name: '  [qa-p2]   dup drug ', doseAmount: 1 }], times };
      expectRes(await call(g.api, 'POST', batchPath, same), 400, 'MEDICATION_BATCH_DUPLICATE_NAME', '같은 이름');
      expectRes(await call(g.api, 'POST', batchPath, spaced), 400, 'MEDICATION_BATCH_DUPLICATE_NAME', '공백·대소문자만 다른 이름');
      expect(medCountOf(ward.id), '한 트랜잭션이라 하나도 등록되지 않는다').toBe(before);
    });

    test.info().annotations.push({
      type: '외부 호출',
      description: 'Claude 호출을 만들지 않으려고 읽기 응답을 가짜로 바꿨다. 실제 오독 사진의 확신도(low) 판정은 AI 서버 몫이라 이 케이스에서 확인하지 않았다',
    });
  });
});
