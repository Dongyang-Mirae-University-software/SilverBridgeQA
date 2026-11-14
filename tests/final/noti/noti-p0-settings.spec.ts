/**
 * 최종 QA - 알림(NOTI) P0 - 채널 수신 설정과 보호자 알림 종류 설정
 *
 * A27 만 문자 1건을 실제로 보낸다(임시 사용자의 미배정 번호 010-0001-xxxx, Solapi 는 접수만 한다).
 * 나머지는 전화번호·푸시 토큰이 없는 보호자만 써서 외부 발송이 없다.
 */
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import { anonymous, bodyOf, logRows, NOTI_TAGS, sendSos, setChannels, waitForLog } from './_helpers-noti';

const TYPE_SETTING = '/api/guardian/notification-type-setting';
const LOCKED = { enabled: true, required: true };

// 비밀번호 찾기 문자(pw-reset-sms)는 IP 기준 1분 10회 공용 제한이라 직렬로 돌리고 다른 영역과 동시에 돌리지 않는다
test.describe('채널 수신 설정', () => {
  test.describe.configure({ mode: 'serial' });

  test('NOTI-A27 문자 인증번호는 설정 무관하게 발송', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    const user = await tempUser('GUARDIAN');
    const phone = user.phone!;
    const { api } = await loginAs(user);

    await test.step('준비: 앱 푸시·문자·알림톡·이메일을 모두 꺼 둔다', async () => {
      await setChannels(api, false);
      const settings = await api.get<{ settings: { channelType: string; enabled: boolean }[] }>('/api/user/me/notification-settings');
      expect(settings.settings.length).toBeGreaterThan(0);
      expect(settings.settings.filter(s => s.enabled), '준비: 켜진 채널이 없어야 한다').toEqual([]);
    });

    const ctx = await anonymous();
    try {
      await test.step('비밀번호 찾기 문자 인증번호를 요청하면 발송된다 (실제 문자 1건)', async () => {
        const res = await ctx.post('/api/auth/find-password/sms/send', { data: { name: user.name, phone } });
        const body = await bodyOf(res);
        expect(res.status(), `발송 실패(500)면 문자가 안 나간 것이다: ${JSON.stringify(body).slice(0, 150)}`).toBe(200);
        expect(body.data).toMatchObject({ expiresInSeconds: 300, codeLength: 6 });
        expect(redis('EXISTS', `password:sms:verify:${phone}`), '서버가 인증코드를 저장했다(발송 단계까지 감)').toBe('1');
      });
      await test.step('알림 보내는 길(notification_log)을 지나지 않는다', async () => {
        expect(logRows(user.id), '인증 문자는 알림 이력에 남지 않는다').toEqual([]);
      });
    } finally {
      await ctx.dispose();
      redis('DEL', `password:sms:verify:${phone}`);
      redis('DEL', `sms:sendcount:${phone}`);
    }
  });
});

test.describe('보호자 알림 종류', () => {
  test('NOTI-N32 안부 말벗 주의 알림 끄기(companion_notice_enabled) [일부 확인: 설정 저장·잠금까지]', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const { api } = await loginAs(guardian);

    const first = await api.get<Record<string, { enabled: boolean; required: boolean }>>(TYPE_SETTING);
    expect(first.companionNotice, '처음엔 켜짐, 끌 수 있음').toEqual({ enabled: true, required: false });
    expect(first.companionRisk, '위험 알림은 필수(잠금)').toEqual(LOCKED);

    const updated = await api.call<typeof first>('PUT', TYPE_SETTING, { companionNotice: false });
    expect(updated.companionNotice).toEqual({ enabled: false, required: false });
    expect(updated.companionRisk, '주의 알림을 꺼도 위험 알림(COMPANION_RISK)은 계속 켜짐').toEqual(LOCKED);

    const again = await api.get<typeof first>(TYPE_SETTING);
    expect(again.companionNotice.enabled, '다시 조회해도 꺼져 있다').toBe(false);
    expect(again.companionRisk).toEqual(LOCKED);
    expect(
      psql(`SELECT companion_notice_enabled FROM guardian_notification_preference WHERE guardian_id = ${sqlStr(guardian.id)};`),
      'DB 칸 companion_notice_enabled = false',
    ).toBe('f');

    const tryOff = await api.call<typeof first>('PUT', TYPE_SETTING, { companionRisk: false });
    expect(tryOff.companionRisk, '위험 알림 끄기 시도는 무시').toEqual(LOCKED);

    test.info().annotations.push({
      type: '상태: 일부 확인',
      description: '발송 단계 미확인. 임시 피보호자 자신의 3일치 대화 기록 행을 직접 넣어 BE 판정 스케줄러를 기다리는 방법은 대화·판정 테이블 구조와 스케줄 시각을 이 저장소에서 확인할 수 없고, 공유 AI 호출이 따라올 수 있어 별도 검토 항목으로 남긴다',
    });
    test.info().annotations.push({
      type: '확인 범위',
      description: '설정 저장·잠금까지. 걱정·우울 3일째 대화에서 주의 알림이 안 오고 위험 알림이 오는 발송 단계는 3일 누적 기록과 AI 판단이 필요해 포함하지 않았다',
    });
  });

  test('NOTI-A38 SOS·이상감지 끄기 시도는 무시', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const [g, w] = [await loginAs(guardian), await loginAs(ward)];

    const res = await g.api.raw('PUT', TYPE_SETTING, { sos: false, anomalyDetection: false, companionRisk: false, notARealKey: false });
    expect(res.status()).toBe(200);
    const data = (await bodyOf(res)).data as Record<string, { enabled: boolean; required: boolean }>;
    expect(data.sos, 'SOS 는 필수라 그대로').toEqual(LOCKED);
    expect(data.anomalyDetection, '이상감지도 그대로').toEqual(LOCKED);
    expect(data.companionRisk).toEqual(LOCKED);

    const again = await g.api.get<typeof data>(TYPE_SETTING);
    expect(again.sos).toEqual(LOCKED);
    expect(again.anomalyDetection).toEqual(LOCKED);

    await test.step('이후 SOS 가 정상 발송 시도된다 (받는 보호자에 번호·토큰이 없어 외부 발송 없음)', async () => {
      await sendSos(w.api);
      const [row] = await waitForLog(guardian.id, 'WARD_SOS');
      expect(row.result, '보내지 않음(NOT_SENT)이면 안 된다').not.toBe('NOT_SENT');
      expect(row.channels, '앱 푸시를 시도했다').toContain('"channel": "FCM"');
    });
    test.info().annotations.push({ type: '미확인', description: '이상감지 발송은 CAM 영역 규칙(카메라 등록·이상감지 신호는 CAM 에서만)으로 이 영역에서 확인하지 못함. SOS 발송만 확인' });
  });

  test('NOTI-A42 다른 보호자 ID를 본문·쿼리로 넣어도 내 설정만 바뀜(IDOR)', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    const a = await tempUser('GUARDIAN', { phone: null });
    const b = await tempUser('GUARDIAN', { phone: null });
    const [ga, gb] = [await loginAs(a), await loginAs(b)];

    // 준비: B 도 한 번 저장해 DB 행을 만들어 둔다(행이 없으면 아래 count 0 확인이 항상 참이라 의미가 없다)
    const prepared = await gb.api.raw('PUT', TYPE_SETTING, { medication: true, cameraLinkLost: true });
    expect(prepared.status(), '준비: B 설정 저장').toBe(200);
    expect(
      psql(`SELECT count(*) FROM guardian_notification_preference WHERE guardian_id = ${sqlStr(b.id)};`),
      '준비: B 의 DB 행이 있다',
    ).toBe('1');

    const res = await ga.api.raw('PUT', `${TYPE_SETTING}?guardianId=${b.id}&userId=${b.id}`, {
      medication: false,
      cameraLinkLost: false,
      guardianId: b.id,
      userId: b.id,
    });
    expect(res.status()).toBe(200);
    const mine = (await bodyOf(res)).data as Record<string, { enabled: boolean }>;
    expect(mine.medication.enabled, 'A 자신의 설정은 바뀐다').toBe(false);
    expect(mine.cameraLinkLost.enabled).toBe(false);

    const theirs = await gb.api.get<Record<string, { enabled: boolean }>>(TYPE_SETTING);
    expect(theirs.medication.enabled, 'B 의 복약 설정은 그대로(켜짐)').toBe(true);
    expect(theirs.cameraLinkLost.enabled, 'B 의 카메라 안내 설정도 그대로').toBe(true);
    expect(
      psql(`SELECT count(*) FROM guardian_notification_preference WHERE guardian_id = ${sqlStr(b.id)} AND (medication_enabled = false OR camera_link_lost_enabled = false);`),
      'B 의 DB 행에 꺼진 칸이 없다',
    ).toBe('0');
  });
});
