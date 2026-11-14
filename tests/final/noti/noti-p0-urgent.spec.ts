/**
 * 최종 QA - 알림(NOTI) P0 - 끌 수 없는 알림(SOS·이상감지)의 발송 경로
 *
 * - N23 은 문자 1건을 실제로 보낸다(임시 보호자의 미배정 번호 010-0001-xxxx, Solapi 는 접수만 한다).
 * - A33 은 전화번호·토큰이 없는 보호자만 써서 외부 발송이 없다(SOS 부분만 실행한다).
 * - N26·A32 와 A33 의 화재 단계는 화면 송출로 공유 AI 서버에 화재 사진을 보낸다.
 *   카메라 등록·이상감지 신호는 CAM 영역에서만 실행하기로 해서 이 영역에서는 작성만 해 두었다.
 *   N26·A32 는 맨 앞에서 NOTI_ALLOW_CAMERA_SIGNAL=1 이 아니면 건너뛴다(A33 의 화재 단계도 같은 조건).
 *   NOTI 폴더를 통째로 돌려도 카메라 등록·화재 신호가 나가지 않는다.
 */
import { fireImage, sendFireFrames, startManualSession, stopManualSession, waitSubscribed, wardStreamer } from '../../../src/fire';
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psqlRows } from '../../../src/remote';
import { connect } from '../../../src/variables';
import { logRows, NOTI_TAGS, sendSos, setChannels, waitForLog } from './_helpers-noti';

const CAMERA_LABEL = '거실';
const CAMERA_SIGNAL_SKIP_REASON = 'CAM 영역 소관: 카메라 등록·이상감지 신호는 NOTI_ALLOW_CAMERA_SIGNAL=1 일 때만 보낸다';

test.describe('SOS 문자 대체', () => {
  test('NOTI-N23 SOS 푸시가 안 가면 문자로 대신(SMS_FALLBACK)', NOTI_TAGS, async ({ tempUser, loginAs }) => {
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    const guardian = await tempUser('GUARDIAN'); // 푸시 토큰 없음, 전화번호 있음
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const w = await loginAs(ward);

    await sendSos(w.api);
    const [row] = await waitForLog(guardian.id, 'WARD_SOS');
    test.info().annotations.push({ type: 'WARD_SOS 발송 결과', description: `${row.result} ${row.channels}` });

    expect(row.result, '푸시 토큰이 없으니 문자로 대신 보내고 전달(SMS_FALLBACK)로 센다').toBe('SMS_FALLBACK');
    const channels = JSON.parse(row.channels) as { channel: string; status: string; reason: string | null }[];
    expect(channels.find(c => c.channel === 'FCM'), '앱 푸시는 기기 없음으로 실패').toMatchObject({ status: 'FAILED', reason: 'NO_DEVICE' });
    expect(channels.find(c => c.channel === 'SMS'), '문자는 접수됨').toMatchObject({ status: 'DELIVERED' });
  });
});

test.describe('이용 제한·탈퇴 진행 계정', () => {
  test('NOTI-A33 정지·탈퇴 진행 계정에는 알림을 보내지 않고 NOT_SENT 기록', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(300_000);
    // 전화번호가 없어서, 정책이 깨져 보내려 해도 외부 발송은 나가지 않는다
    const ward = await tempUser('WARD', { phone: null });
    const normal = await tempUser('GUARDIAN', { phone: null }); // 대조군: 발송을 시도해야 한다
    const restricted = await tempUser('GUARDIAN', { phone: null, status: 'RESTRICTED' });
    const withdrawing = await tempUser('GUARDIAN', { phone: null, status: 'INACTIVE' });
    for (const g of [normal, restricted, withdrawing]) connect(g.id, ward.id);
    const w = await loginAs(ward);

    await test.step('SOS', async () => {
      await sendSos(w.api);
      await waitForLog(normal.id, 'WARD_SOS');
      // 이력 행이 먼저 만들어지고 결과가 뒤에 채워질 수 있어, 결과가 정해질 때까지 기다려 FAILED 로 고정한다
      await expect
        .poll(() => logRows(normal.id, 'WARD_SOS')[0]?.result, { timeout: 20_000, intervals: [500, 1_000], message: '대조군은 시도했지만 전화번호·토큰이 없어 전달 수단이 없으니 FAILED' })
        .toBe('FAILED');

      const [r] = await waitForLog(restricted.id, 'WARD_SOS');
      expect(r.result, '이용 제한 보호자').toBe('NOT_SENT');
      expect(r.reason).toBe('RESTRICTED_ACCOUNT');
      expect(r.channels, '채널 시도 없음').toBe('[]');

      const [x] = await waitForLog(withdrawing.id, 'WARD_SOS');
      expect(x.result, '탈퇴 진행 보호자').toBe('NOT_SENT');
      expect(x.reason).toBe('WITHDRAWING_ACCOUNT');
    });

    await test.step('화재 (CAM 영역 소관 - NOTI_ALLOW_CAMERA_SIGNAL=1 일 때만)', async () => {
      if (process.env.NOTI_ALLOW_CAMERA_SIGNAL !== '1') {
        test.info().annotations.push({ type: '건너뜀', description: '이상감지 신호를 일으키는 단계는 CAM 영역에서만 실행 (NOTI_ALLOW_CAMERA_SIGNAL=1 로 켠다)' });
        return;
      }
      const g = await loginAs(normal);
      const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
      const streamer = await wardStreamer(w.api.login);
      try {
        await startManualSession(streamer, camera.sessionId, camera.deviceId);
        await waitSubscribed(camera.sessionId);
        await sendFireFrames(streamer, camera.sessionId, fireImage());
        const [fr] = await waitForLog(restricted.id, 'ANOMALY_DETECTED', 1, 60_000);
        expect(fr.result).toBe('NOT_SENT');
        expect(fr.reason).toBe('RESTRICTED_ACCOUNT');
        const [fx] = await waitForLog(withdrawing.id, 'ANOMALY_DETECTED', 1, 60_000);
        expect(fx.result).toBe('NOT_SENT');
        expect(fx.reason).toBe('WITHDRAWING_ACCOUNT');
      } finally {
        await stopManualSession(streamer, camera.sessionId);
        await w.api.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
      }
    });
  });

  test('NOTI-A36 기록 저장이 실패해도 SOS·화재 알림은 나감', NOTI_TAGS, async () => {
    test.fixme(
      true,
      '알림 이력(notification_log) 저장만 실패하게 만들려면 DB 제약·권한이나 서버 설정을 바꿔야 한다. 공유 dev 의 DB·컨테이너를 건드릴 수 없어 자동화하지 않는다 (BE 단위 테스트로 확인할 항목). 관련 이력 NOT_SENT·FAILED 기록은 A33·N23 에서 본다',
    );
  });
});

test.describe('이상감지 알림 (공유 AI 서버에 화재 사진을 보낸다 - 이 영역에서는 실행하지 않음)', () => {
  test('NOTI-N25 흉기·낙상 감지 알림 문구와 종류(WEAPON/FALL)', NOTI_TAGS, async () => {
    test.fixme(
      true,
      '흉기·낙상 신호를 만들 사진 도구가 QA 저장소에 없다(src/fire.ts 는 화재 사진 전용). AI 모델이 흉기·낙상으로 판정해야 하는 사진은 CAM 영역에서 따로 준비해야 한다. 문구(제목 "[흉기 감지] {이름}님 댁 {장소}", 알림톡 감지 종류 변수)는 BE 단위 테스트(AnomalyNotificationListener)로 본다',
    );
  });

  test('NOTI-N26 푸시·문자·알림톡 모두 없을 때만 이상감지 문자 대체', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.skip(process.env.NOTI_ALLOW_CAMERA_SIGNAL !== '1', CAMERA_SIGNAL_SKIP_REASON);
    test.setTimeout(300_000);
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    const ward = await tempUser('WARD', { phone: null }); // 본인 문자 대체가 나가지 않게
    const guardian = await tempUser('GUARDIAN'); // 푸시 토큰 없음, 전화번호 있음 -> 문자 대체 1건
    connect(guardian.id, ward.id);
    const w = await loginAs(ward);
    const g = await loginAs(guardian);
    await setChannels(g.api, false); // 문자·알림톡 꺼 둠

    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
    const streamer = await wardStreamer(w.api.login);
    try {
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);
      await sendFireFrames(streamer, camera.sessionId, fireImage());
      const [row] = await waitForLog(guardian.id, 'ANOMALY_DETECTED', 1, 60_000);
      test.info().annotations.push({ type: 'ANOMALY_DETECTED 발송 결과', description: `${row.result} ${row.channels}` });
      expect(row.result, '어느 채널로도 전달되지 않아 문자로 대신 보내고 SMS_FALLBACK').toBe('SMS_FALLBACK');
      const channels = JSON.parse(row.channels) as { channel: string; status: string }[];
      expect(channels.find(c => c.channel === 'SMS'), '문자 대체가 접수됨').toMatchObject({ status: 'DELIVERED' });

      // 이력에 남는 푸시 제목·본문 (문자 문구는 이 문구에 앱 이름을 붙인 것)
      const [[title, body]] = psqlRows(`SELECT title, body FROM notification_log WHERE id = ${row.id};`);
      expect(title).toBe(`[화재 감지] ${ward.name}님 댁 ${CAMERA_LABEL}`);
      expect(body).toContain(`${CAMERA_LABEL} 카메라에서 화재가 감지되었습니다.`);

      // 문자 문구는 DB 에 남지 않아 이 테스트로는 확인하지 못한다.
      // BE AnomalyNotificationListener.smsFallbackText 코드와 대조한 기대 문구(화재는 행동 안내가 없는 경우):
      //   "[실버브릿지] {이름}님 댁 {위치}에서 화재 감지. 앱에서 확인해 주세요."
      // 실제 수신 문구는 문자 발송사(Solapi) 접수 기록 화면에서 이 임시 보호자 번호로 조회해 확인해야 한다.
      test.info().annotations.push({ type: '미확인', description: '문자 문구(SMS 본문)는 DB 에 안 남아 확인하지 못함. BE smsFallbackText 코드와 대조한 기대 문구만 주석에 적음. 발송사 접수 기록으로 확인 필요' });
    } finally {
      await stopManualSession(streamer, camera.sessionId);
      await w.api.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
    }
  });

  test('NOTI-A32 전달 0건이면 쿨다운(5분/3분) 풀림, 정지·탈퇴 차단은 안 풀림', NOTI_TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.skip(process.env.NOTI_ALLOW_CAMERA_SIGNAL !== '1', CAMERA_SIGNAL_SKIP_REASON);
    test.setTimeout(420_000);
    // 모두 전화번호·토큰이 없어 외부 발송은 없다. 보호자는 전달 수단이 없어 FAILED, 정지 보호자는 NOT_SENT
    const ward = await tempUser('WARD', { phone: null });
    const failing = await tempUser('GUARDIAN', { phone: null });
    const blocked = await tempUser('GUARDIAN', { phone: null, status: 'RESTRICTED' });
    connect(failing.id, ward.id);
    connect(blocked.id, ward.id);
    const w = await loginAs(ward);
    const g = await loginAs(failing);

    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
    const streamer = await wardStreamer(w.api.login);
    try {
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);

      await test.step('첫 감지: 전달 실패(FAILED) / 정지 보호자 차단(NOT_SENT)', async () => {
        await sendFireFrames(streamer, camera.sessionId, fireImage());
        const [f] = await waitForLog(failing.id, 'ANOMALY_DETECTED', 1, 60_000);
        expect(f.result).toBe('FAILED');
        const [b] = await waitForLog(blocked.id, 'ANOMALY_DETECTED', 1, 60_000);
        expect(b.result).toBe('NOT_SENT');
        expect(b.reason).toBe('RESTRICTED_ACCOUNT');
      });

      // 감지 쿨다운은 BE 설정 AnomalyProperties.cooldownMinutes(코드 기본 1분, dev 설정으로 바뀔 수 있음)를 따른다.
      // 그래서 고정으로 길게 기다리지 않고, 기본값(1분) + 여유만 기다린 뒤 두 번째 failing 행이 생길 때까지 다시 보내며 확인한다.
      // 알림 쿨다운(보호자 5분) 안에서 다시 감지해야 하므로 전체 대기는 5분을 넘기지 않는다.
      await new Promise(resolve => setTimeout(resolve, 65_000));

      await test.step('5분 안 재감지: FAILED 였던 보호자는 다시 알림 시도, 차단된 보호자는 쿨다운 유지(새 행 없음)', async () => {
        let secondRowAt = 0;
        for (let attempt = 0; attempt < 4 && !secondRowAt; attempt++) {
          await sendFireFrames(streamer, camera.sessionId, fireImage());
          const deadline = Date.now() + 30_000; // AI 응답이 늦어도 이 시간 안에는 기록된다고 본다
          while (Date.now() < deadline) {
            if (logRows(failing.id, 'ANOMALY_DETECTED').length >= 2) {
              secondRowAt = Date.now();
              break;
            }
            await new Promise(resolve => setTimeout(resolve, 2_000));
          }
        }
        expect(secondRowAt, '두 번째 감지로 failing 보호자의 새 행(2건)이 생겨야 한다').toBeGreaterThan(0);
        // 두 번째 failing 행이 생긴 시각 이후 5초까지 차단된 보호자 쪽에 새 행이 없는지 본다(같은 감지의 발송 루프 안에서 같이 처리됨)
        await new Promise(resolve => setTimeout(resolve, Math.max(0, secondRowAt + 5_000 - Date.now())));
        expect(logRows(blocked.id, 'ANOMALY_DETECTED').length, '정지·탈퇴 차단(NOT_SENT)은 쿨다운이 안 풀려 새 행이 없다').toBe(1);
        expect(logRows(failing.id, 'ANOMALY_DETECTED').every(r => r.result === 'FAILED')).toBe(true);
      });
    } finally {
      await stopManualSession(streamer, camera.sessionId);
      await w.api.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
    }
  });
});
