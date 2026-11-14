/**
 * 최종 QA - 알림(NOTI) P1a - 끌 수 없는 알림의 문자 대체 규칙(SOS·이상감지)
 *
 * - A30 의 SOS 부분은 임시 보호자의 자기 Redis 키(notify:sms-fallback:<종류>:<보호자 id>)만 다루고, 전화번호가 없는 보호자라
 *   외부 발송이 없다. 화재(이상감지) 단계는 카메라 등록·이상감지 신호가 필요해 CAM_SIGNAL_ALLOWED=1 일 때만 돈다.
 * - A29 는 카메라 등록·화재 신호와 실제 알림톡·문자 접수가 필요해 CAM_SIGNAL_ALLOWED=1 일 때만 돈다(작성만 해 두었다).
 */
import { fireImage, sendFireFrames, startManualSession, stopManualSession, waitSubscribed, wardStreamer } from '../../../src/fire';
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { redis } from '../../../src/remote';
import { connect } from '../../../src/variables';
import { logRows, sendSos, waitForLog } from './_helpers-noti';
import { CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON, P1A_TAGS } from './_helpers-noti-p1a';

const CAMERA_LABEL = '거실';

interface Channel { channel: string; status: string; reason: string | null }
const channelsOf = (row: { channels: string }) => JSON.parse(row.channels) as Channel[];

test.describe('문자 대체 규칙', () => {
  test('NOTI-A29 이미 알림톡이 전달됐거나 켜 둔 문자를 시도했으면 대체 문자 없음', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.skip(!CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON);
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 알림톡·문자 발송 요청이 생기는 테스트');
    test.setTimeout(300_000);
    const ward = await tempUser('WARD', { phone: null });
    const viaAlimtalk = await tempUser('GUARDIAN'); // 임시 번호(010-0001-xxxx) 있음, 알림톡만 켬
    const viaSms = await tempUser('GUARDIAN', { phone: null }); // 문자만 켬, 번호가 없어 문자 시도가 실패
    connect(viaAlimtalk.id, ward.id);
    connect(viaSms.id, ward.id);
    const [w, ga, gb] = [await loginAs(ward), await loginAs(viaAlimtalk), await loginAs(viaSms)];
    const only = (enabled: string) =>
      ({ settings: ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: channelType === enabled })) });
    expect((await ga.api.raw('PUT', '/api/user/me/notification-settings', only('KAKAO_ALIMTALK'))).status(), '준비: 알림톡만 켬').toBe(200);
    expect((await gb.api.raw('PUT', '/api/user/me/notification-settings', only('SMS'))).status(), '준비: 문자만 켬').toBe(200);

    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
    const streamer = await wardStreamer(w.api.login);
    try {
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);
      await sendFireFrames(streamer, camera.sessionId, fireImage());
      const [a] = await waitForLog(viaAlimtalk.id, 'ANOMALY_DETECTED', 1, 60_000);
      const [b] = await waitForLog(viaSms.id, 'ANOMALY_DETECTED', 1, 60_000);

      const aChannels = channelsOf(a);
      test.info().annotations.push({ type: '알림톡 보호자 결과', description: `${a.result} ${aChannels.map(c => `${c.channel}:${c.status}`).join(',')}` });
      expect(aChannels.find(c => c.channel === 'KAKAO_ALIMTALK'), '알림톡이 접수(전달)됨').toMatchObject({ status: 'DELIVERED' });
      expect(a.result, '전달됐으니 문자 대체 없이 DELIVERED').toBe('DELIVERED');
      expect(aChannels.filter(c => c.channel === 'SMS'), '대체 문자 시도가 없다').toHaveLength(0);

      const bChannels = channelsOf(b);
      expect(bChannels.find(c => c.channel === 'SMS'), '켜 둔 문자는 번호가 없어 실패').toMatchObject({ status: 'FAILED', reason: 'NO_PHONE' });
      expect(bChannels.filter(c => c.channel === 'SMS'), '같은 문자를 다시 시도(대체 문자)하지 않는다 - 문자 시도는 1건').toHaveLength(1);
      expect(b.result, '전달 수단이 없어 FAILED(SMS_FALLBACK 아님)').toBe('FAILED');
    } finally {
      await stopManualSession(streamer, camera.sessionId);
      await w.api.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
    }
  });

  test('NOTI-A30 문자 대체는 받는 사람별 시간당 30건 상한 (SOS 부분)', P1A_TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    test.info().annotations.push({ type: '부분 확인', description: '이 테스트는 SOS 종류의 상한만 본다. "종류별로 따로 센다"(화재는 SOS 한도와 별개)는 아래 화재 부분 테스트(CAM_SIGNAL_ALLOWED=1 필요)에서만 확인한다' });
    const guardian = await tempUser('GUARDIAN', { phone: null }); // 번호가 없어 문자는 접수되지 않는다(외부 발송 없음)
    const ward1 = await tempUser('WARD', { phone: null });
    const ward2 = await tempUser('WARD', { phone: null });
    connect(guardian.id, ward1.id);
    connect(guardian.id, ward2.id);
    const [w1, w2] = [await loginAs(ward1), await loginAs(ward2)];
    const sosKey = `notify:sms-fallback:WARD_SOS:${guardian.id}`;
    const smsOf = (row: { channels: string }) => channelsOf(row).find(c => c.channel === 'SMS');

    try {
      await test.step('SOS 문자 29건 소진: 30번째는 상한 안이라 문자를 시도한다(번호가 없어 NO_PHONE)', async () => {
        redis('SET', sosKey, '29', 'EX', '3600');
        await sendSos(w1.api);
        const [row] = await waitForLog(guardian.id, 'WARD_SOS');
        expect(smsOf(row), '30번째는 막히지 않는다').toMatchObject({ status: 'FAILED', reason: 'NO_PHONE' });
        expect(redis('GET', sosKey), '접수되지 않은 문자는 한 건을 돌려받아 29 그대로').toBe('29');
      });

      await test.step('SOS 문자 30건 소진: 31번째는 RATE_LIMITED 로 기록', async () => {
        redis('SET', sosKey, '30', 'EX', '3600');
        await sendSos(w2.api);
        await expect.poll(() => logRows(guardian.id, 'WARD_SOS').length, { timeout: 30_000, intervals: [1_000, 2_000] }).toBe(2);
        const row = logRows(guardian.id, 'WARD_SOS')[1];
        expect(smsOf(row), '31번째 문자 대체는 한도 초과로 생략').toMatchObject({ status: 'FAILED', reason: 'RATE_LIMITED' });
        expect(row.result, '시도한 채널이 모두 실패').toBe('FAILED');
        expect(redis('GET', sosKey), '세어진 값은 31').toBe('31');
      });
    } finally {
      redis('DEL', sosKey); // 임시 보호자 자신의 키만 정리
    }
  });

  test('NOTI-A30 문자 대체는 종류별로 따로 셈 (화재 부분)', P1A_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.skip(!CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON);
    test.setTimeout(480_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    connect(guardian.id, ward.id);
    const [g, w] = [await loginAs(guardian), await loginAs(ward)];
    const sosKey = `notify:sms-fallback:WARD_SOS:${guardian.id}`;
    const fireKey = `notify:sms-fallback:ANOMALY_DETECTED:${guardian.id}`;
    const smsOf = (row: { channels: string }) => channelsOf(row).find(c => c.channel === 'SMS');
    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
    const streamer = await wardStreamer(w.api.login);
    try {
      redis('SET', sosKey, '30', 'EX', '3600'); // SOS 한도는 이미 소진
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);
      await sendFireFrames(streamer, camera.sessionId, fireImage());
      const [first] = await waitForLog(guardian.id, 'ANOMALY_DETECTED', 1, 60_000);
      expect(smsOf(first), 'SOS 한도가 소진돼도 화재 문자 대체는 한도에 걸리지 않는다(번호가 없어 NO_PHONE)').toMatchObject({ status: 'FAILED', reason: 'NO_PHONE' });

      redis('SET', fireKey, '30', 'EX', '3600');
      // 감지 쿨다운이 지날 때까지 프레임을 다시 보내며 두 번째 행이 생길 때까지 기다린다(고정 대기 없음)
      await expect
        .poll(
          async () => {
            await sendFireFrames(streamer, camera.sessionId, fireImage());
            return logRows(guardian.id, 'ANOMALY_DETECTED').length;
          },
          { timeout: 240_000, intervals: [15_000], message: '두 번째 화재 이력이 생겨야 한다' },
        )
        .toBeGreaterThanOrEqual(2);
      expect(smsOf(logRows(guardian.id, 'ANOMALY_DETECTED')[1]), '화재 31번째는 한도 초과로 생략').toMatchObject({ status: 'FAILED', reason: 'RATE_LIMITED' });
    } finally {
      await stopManualSession(streamer, camera.sessionId);
      await w.api.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
      redis('DEL', sosKey, fireKey); // 임시 보호자 자신의 키만 정리
    }
  });
});