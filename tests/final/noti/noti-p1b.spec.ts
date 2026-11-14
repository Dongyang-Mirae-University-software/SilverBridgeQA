/**
 * 최종 QA - 알림(NOTI) P1b - 보호자 알림 종류, 채널 수신 설정
 *
 * 외부로 나가는 것(최소): 문자 2건(N14, A26: 임시 피보호자의 미배정 번호 010-0001-xxxx, Solapi 는 접수만 한다),
 * 이메일 1건(N16: 임시 이메일 주소 e2e.temp.*@silverbridge.test).
 * 카메라 등록·이상감지 신호가 필요한 테스트(N17, A23, A18 의 화재 단계)는 CAM_SIGNAL_ALLOWED=1 일 때만 돈다.
 * 복약 알림은 서버 스케줄러가 1분마다 선점하므로 N28·A18 은 1~3분 걸린다.
 */
import { env } from '../../../src/env';
import { fireImage, sendFireFrames, startManualSession, stopManualSession, waitSubscribed } from '../../../src/fire';
import { connect } from '../../../src/variables';
import {
  addMedication,
  CAM_SIGNAL_ALLOWED,
  CAM_SIGNAL_SKIP_REASON,
  CHANNEL_SETTING,
  channelSettingRows,  channelsOf,
  clearChannelSettingRows,
  clearTypePreferenceRow,
  expect,
  kstDoseTimeAgo,
  logRows,
  logTexts,
  NOTI_P1_TAGS,
  reminderClaimCount,
  requestConnection,
  sendSos,
  setChannels,
  summarize,
  test,
  TYPE_SETTING,
  typePreferenceRowCount,
  waitForLog,
} from './_helpers-noti-p1b';
import { psql, sqlStr } from '../../../src/remote';
import type { Page } from '@playwright/test';
import type { Api } from '../../../src/api';

/** 카메라 정리: 세션 중지가 실패해도 카메라 삭제는 반드시 시도한다 */
async function cleanupCamera(api: Api, cameraId: number, sessionId: string, streamer: Page | undefined) {
  if (streamer) await stopManualSession(streamer, sessionId).catch(() => undefined);
  await api.call('DELETE', `/api/ward/camera/${cameraId}`).catch(() => undefined);
}

type TypeSettings = Record<string, { enabled: boolean; required: boolean }>;
type ChannelSettings = { settings: { channelType: string; enabled: boolean }[] };

const LOCKED = { enabled: true, required: true };
const OPTIONAL_ON = { enabled: true, required: false };
const CAMERA_LABEL = '거실';

const channelMap = (data: ChannelSettings) => Object.fromEntries(data.settings.map(s => [s.channelType, s.enabled]));

test.describe('보호자 알림 종류', () => {
  test('NOTI-A39 복약 중지 안내(MEDICATION_STOPPED)는 끄지 못함', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    test.setTimeout(180_000);
    // 전화번호가 없고 푸시 토큰도 없어 외부 발송은 없다
    const ward = await tempUser('WARD', { phone: null });
    const registrar = await tempUser('GUARDIAN', { phone: null }); // 약을 등록한 뒤 탈퇴할 보호자
    const remaining = await tempUser('GUARDIAN', { phone: null }); // 남는 보호자(복약 알림을 꺼 둔다)
    connect(registrar.id, ward.id);
    connect(remaining.id, ward.id);
    const [r, m] = [await login(registrar), await login(remaining)];

    await test.step('준비: 남는 보호자가 복약 알림(medication)을 끈다', async () => {
      const updated = await m.api.call<TypeSettings>('PUT', TYPE_SETTING, { medication: false });
      expect(updated.medication, '복약 알림 꺼짐').toEqual({ enabled: false, required: false });
      expect((await m.api.get<TypeSettings>(TYPE_SETTING)).medication.enabled, '다시 조회해도 꺼짐').toBe(false);
    });

    await test.step('준비: 등록 보호자가 피보호자에게 약 1건을 등록한다', async () => {
      const dose = kstDoseTimeAgo(0) ?? '08:00:00';
      await addMedication(r.api, ward.id, dose);
    });

    await test.step('등록 보호자 탈퇴(실제 탈퇴 API)', async () => {
      const res = await r.api.raw('DELETE', '/api/user/me', { password: registrar.password });
      expect(res.status(), '준비: 탈퇴 성공').toBe(200);
    });

    const [row] = await waitForLog(remaining.id, 'MEDICATION_STOPPED', 1, 45_000);
    test.info().annotations.push({ type: 'MEDICATION_STOPPED 발송 결과', description: `${row.result} ${row.channels}` });
    expect(row.result, '복약 알림을 꺼 둬도 보내지 않음(NOT_SENT)이 아니다. 푸시 토큰이 없어 전달만 실패(FAILED)').toBe('FAILED');
    expect(row.reason, '보내지 않은 사유가 없다').toBe('');
    expect(channelsOf(row.channels).find(c => c.channel === 'FCM'), '앱 푸시를 시도했다').toMatchObject({ status: 'FAILED', reason: 'NO_DEVICE' });
    expect(logTexts(row.id).body, '문구에 중지된 약 건수가 들어간다').toContain('약 1건이 중지되었습니다');

    expect(logRows(ward.id, 'MEDICATION_STOPPED'), '피보호자 본인에게는 보내지 않는다').toEqual([]);
    expect((await m.api.get<TypeSettings>(TYPE_SETTING)).medication.enabled, '안내가 나가도 설정은 꺼진 그대로').toBe(false);
  });

  test('NOTI-A43 처음 저장을 동시에 두 번 보내도 성공', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const g = await login(guardian);

    const statuses: number[] = [];
    const rowCounts: number[] = [];
    // 같은 경쟁은 운이 필요해서 여러 번 반복한다. 매번 이 보호자 자신의 행만 지워 "행 없음" 상태로 만든다
    for (let round = 0; round < 5; round++) {
      clearTypePreferenceRow(guardian.id);
      const responses = await Promise.all(
        Array.from({ length: 2 }, () => g.api.raw('PUT', TYPE_SETTING, { medication: false, cameraLinkLost: false, companionNotice: false })),
      );
      statuses.push(...responses.map(res => res.status()));
      rowCounts.push(typePreferenceRowCount(guardian.id));
    }

    expect(statuses.filter(status => status !== 200), `둘 다 200 이어야 한다(요청 ${statuses.length}건 중 200 아닌 것)`).toEqual([]);
    expect(rowCounts, '매 회 행은 1개(UNIQUE)').toEqual(rowCounts.map(() => 1));
    const final = await g.api.get<TypeSettings>(TYPE_SETTING);
    expect([final.medication.enabled, final.cameraLinkLost.enabled, final.companionNotice.enabled], '저장한 값(꺼짐)이 남는다').toEqual([false, false, false]);
  });

  test('NOTI-A45 설정을 못 읽으면 카메라 끊김 안내를 전원에게 보냄', NOTI_P1_TAGS, async () => {
    test.info().annotations.push({
      type: '코드 확인',
      description: 'BE CameraLinkLostNotifier.receivers: 끄기 설정 조회(cameraLinkLostDisabledGuardians)가 RuntimeException 이면 거르지 않고 연결된 보호자 전원(guardianIds)을 그대로 돌려준다 -> 전원에게 발송(안전 쪽)으로 코드와 케이스 기대값이 맞다',
    });
    test.fixme(
      true,
      '설정 조회 실패를 만들려면 공유 dev 의 DB·서버 설정을 건드려야 하고(금지), 카메라 끊김 안내는 AI 서버 연결이 끊겼다 돌아오는 상황과 카메라 등록(CAM 영역)이 필요하다. BE 단위 테스트(CameraLinkLostNotifier)로 확인할 항목. 코드상 끄기 설정 조회가 예외면 전원에게 보내는 쪽(수신자 목록 확인 실패)이 되는지 코드 리뷰로 본다',
    );
  });

  test('NOTI-N27 기본 조회는 전부 켜짐, SOS·이상감지는 required:true', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const g = await login(guardian);
    expect(typePreferenceRowCount(guardian.id), '준비: 신규 보호자라 설정 행이 없다').toBe(0);

    const res = await g.api.raw('GET', TYPE_SETTING);
    expect(res.status()).toBe(200);
    const data = ((await res.json()) as { data: TypeSettings }).data;
    expect(data.sos, 'SOS 는 켜짐·필수').toEqual(LOCKED);
    expect(data.anomalyDetection, '이상감지는 켜짐·필수').toEqual(LOCKED);
    expect(data, '나머지는 켜짐·선택(끌 수 있음). 말벗 위험 신호(companionRisk)는 코드가 필수(잠금)로 내린다').toEqual({
      sos: LOCKED,
      anomalyDetection: LOCKED,
      anomalyReviewReminder: OPTIONAL_ON,
      medication: OPTIONAL_ON,
      cameraLinkLost: OPTIONAL_ON,
      companionRisk: LOCKED,
      companionNotice: OPTIONAL_ON,
    });
    expect(typePreferenceRowCount(guardian.id), '조회만으로는 행이 생기지 않는다').toBe(0);
    test.info().annotations.push({
      type: '문서와 차이',
      description: '케이스 문구는 sos·anomalyDetection 만 required:true 이고 나머지는 required:false 인데, 배포 코드(GuardianNotificationPreferenceService.toResponse)는 안부 말벗 위험 신호 companionRisk 도 required:true(잠금)다. 코드 값으로 고정했다',
    });
  });

  test('NOTI-N28 판정 재촉·복약 요약·카메라 끊김 끄기/켜기', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    test.setTimeout(420_000);
    const dose = kstDoseTimeAgo(2);
    test.skip(dose === null, '한국 시간 자정 직후라 "2분 전 복용 시각"이 어제가 된다. 몇 분 뒤 다시 실행');

    // 복약 알림 발송 확인용 두 쌍. 전화번호·푸시 토큰이 없어 외부 발송은 없다
    const wardOff = await tempUser('WARD', { phone: null });
    const wardControl = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const guardianControl = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, wardOff.id);
    connect(guardianControl.id, wardControl.id);
    const [g, gc] = [await login(guardian), await login(guardianControl)];

    await test.step('세 항목을 끄면 200 이고 세 항목만 false', async () => {
      const res = await g.api.raw('PUT', TYPE_SETTING, { anomalyReviewReminder: false, medication: false, cameraLinkLost: false });
      expect(res.status()).toBe(200);
      const updated = ((await res.json()) as { data: TypeSettings }).data;
      expect(updated).toEqual({
        sos: LOCKED,
        anomalyDetection: LOCKED,
        anomalyReviewReminder: { enabled: false, required: false },
        medication: { enabled: false, required: false },
        cameraLinkLost: { enabled: false, required: false },
        companionRisk: LOCKED,
        companionNotice: OPTIONAL_ON,
      });
      expect(await g.api.get<TypeSettings>(TYPE_SETTING), '다시 조회해도 같다').toEqual(updated);
      expect(
        psql(`SELECT medication_enabled::text || ',' || camera_link_lost_enabled::text FROM guardian_notification_preference WHERE guardian_id = ${sqlStr(guardian.id)};`),
        'DB 칸(복약, 카메라 끊김)도 false',
      ).toBe('false,false');
    });

    const [medOff, medControl] = [
      await addMedication(g.api, wardOff.id, dose!),
      await addMedication(gc.api, wardControl.id, dose!),
    ];

    await test.step('끈 동안: 같은 시각 약인데 켜 둔 쪽 피보호자만 "약 드실 시간" 알림을 받는다(복약 알림이 꺼진 보호자의 피보호자는 못 받음)', async () => {
      // 대조군이 받았다는 것은 스케줄러가 두 약을 모두 본 주기가 한 번 돌았다는 증거다
      await waitForLog(wardControl.id, 'MEDICATION_REMINDER', 1, 150_000);
      expect(reminderClaimCount(medControl), '대조군 약은 선점됨').toBeGreaterThanOrEqual(1);
      expect(reminderClaimCount(medOff), '끈 보호자의 피보호자 약은 선점 기록도 없다').toBe(0);
      expect(logRows(wardOff.id, 'MEDICATION_REMINDER'), '끈 보호자의 피보호자에게 알림이 가지 않았다').toEqual([]);
    });

    await test.step('다시 켜면 true 로 돌아오고 알림이 재개된다', async () => {
      const res = await g.api.raw('PUT', TYPE_SETTING, { anomalyReviewReminder: true, medication: true, cameraLinkLost: true });
      expect(res.status()).toBe(200);
      const back = await g.api.get<TypeSettings>(TYPE_SETTING);
      expect([back.anomalyReviewReminder, back.medication, back.cameraLinkLost]).toEqual([OPTIONAL_ON, OPTIONAL_ON, OPTIONAL_ON]);
      await waitForLog(wardOff.id, 'MEDICATION_REMINDER', 1, 150_000);
      expect(reminderClaimCount(medOff), '켠 뒤에는 약이 선점됨').toBeGreaterThanOrEqual(1);
    });

    test.info().annotations.push({
      type: '확인 범위',
      description: '설정 저장·복원과 복약 알림(피보호자 "약 드실 시간") 발송 중단·재개까지 확인. 판정 재촉은 NOTI-N28b, 복약 미복용 요약은 NOTI-N28c(둘 다 fixme), 카메라 끊김 안내는 NOTI-A45 쪽(코드 확인)으로 넘겼다',
    });
  });

  test('NOTI-N28b 판정 재촉을 끄면 재촉이 안 나감', NOTI_P1_TAGS, async () => {
    test.fixme(
      true,
      '판정 재촉은 상황이 닫힌 뒤 60분 기다려야 나가고 밤 22시-8시에는 미뤄진다(anomaly.review-reminder). 서버 설정은 바꿀 수 없어 자동화하지 않는다. BE 단위 테스트(AnomalyReviewReminderPlanner)로 확인할 항목',
    );
  });

  test('NOTI-N28c 복약 미복용 요약을 끄면 보호자 요약이 안 나감', NOTI_P1_TAGS, async () => {
    test.fixme(
      true,
      '미복용 요약(MEDICATION_MISSED)은 하루 한 번 정해진 시각(21:00 KST)에만 나가고 약을 체크하지 않은 채 그 시각을 기다려야 한다. 테스트에서 시각을 앞당길 수 없다(서버 설정 변경 금지). BE 단위 테스트로 확인할 항목',
    );
  });
});

test.describe('채널 수신 설정', () => {
  test('NOTI-A15 설정에 빈 값·알 수 없는 channelType·enabled 누락', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);

    const bad: [string, unknown][] = [
      ['settings 가 빈 배열', { settings: [] }],
      ['settings 항목이 null', { settings: [null] }],
      ['항목이 빈 객체 {}', { settings: [{}] }],
      ['알 수 없는 channelType', { settings: [{ channelType: 'FAX', enabled: true }] }],
      ['enabled 누락', { settings: [{ channelType: 'SMS' }] }],
      ['channelType 누락', { settings: [{ enabled: true }] }],
      ['settings 키 자체가 없음', {}],
      ['정상 항목 뒤에 null 이 섞임', { settings: [{ channelType: 'SMS', enabled: true }, null] }],
    ];
    for (const [label, body] of bad) {
      const res = await u.api.raw('PUT', CHANNEL_SETTING, body);
      expect.soft(res.status(), `${label}: 400 이어야 한다(500 이면 안내 없이 서버 오류) - ${await summarize(res)}`).toBe(400);
    }

    const after = channelMap(await u.api.get<ChannelSettings>(CHANNEL_SETTING));
    expect(after, '잘못된 요청은 아무것도 바꾸지 않는다(정상 항목이 섞여 있어도 SMS 는 그대로 꺼짐)').toEqual({ FCM: true, SMS: false, KAKAO_ALIMTALK: false, EMAIL: false });
    expect(channelSettingRows(user.id), 'DB 에 저장된 행도 없다').toEqual([]);
  });

  test('NOTI-A16 처음 저장을 동시에 두 번 보내도 둘 다 성공', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    test.setTimeout(240_000);
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);
    const allChannels = (enabled: boolean) => ({ settings: ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled })) });

    const statuses: number[] = [];
    const rowSummaries: string[] = [];
    for (let round = 0; round < 5; round++) {
      clearChannelSettingRows(user.id);
      const responses = await Promise.all([u.api.raw('PUT', CHANNEL_SETTING, allChannels(true)), u.api.raw('PUT', CHANNEL_SETTING, allChannels(false))]);
      statuses.push(...responses.map(res => res.status()));
      const rows = channelSettingRows(user.id);
      rowSummaries.push(`${rows.length}행/채널 ${new Set(rows.map(r => r.channel)).size}종`);
    }

    expect(statuses.filter(status => status !== 200), `둘 다 200 이어야 한다(500 이나 중복 오류 없음, 요청 ${statuses.length}건 중 200 아닌 것)`).toEqual([]);
    expect(rowSummaries, '매 회 채널마다 정확히 1행(중복 행 없음)').toEqual(rowSummaries.map(() => '4행/채널 4종'));
    const final = await u.api.get<ChannelSettings>(CHANNEL_SETTING);
    expect(new Set(Object.values(channelMap(final))).size, '둘 중 나중 값 하나로 통일되어 남는다(채널끼리 값이 섞이지 않음)').toBe(1);
  });

  test('NOTI-A17 이메일 킬스위치(NOTIFICATION_EMAIL_ENABLED=false)', NOTI_P1_TAGS, async () => {
    test.fixme(
      true,
      '서버 환경변수 NOTIFICATION_EMAIL_ENABLED 를 false 로 바꿔 BE 를 다시 띄워야 한다. 공유 dev 의 컨테이너·서버 설정 변경은 금지라 자동화하지 않는다(BE 통합 테스트로 확인). 코드상 스위치가 꺼지면 EmailNotificationChannel 빈이 만들어지지 않고 디스패처가 대상 아님으로 건너뛰며 설정값은 그대로 둔다',
    );
  });

  test('NOTI-A18 이메일로 SOS·이상감지·복약 알림·재촉은 안 나감', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    test.setTimeout(420_000);
    const dose = kstDoseTimeAgo(2);
    test.skip(dose === null, '한국 시간 자정 직후라 "2분 전 복용 시각"이 어제가 된다. 몇 분 뒤 다시 실행');

    // 전화번호가 없어 문자 대체도 나가지 않는다. 푸시 토큰이 없어 외부 발송은 없다
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, ward.id);
    const [w, g] = [await login(ward), await login(guardian)];
    const emailOn = { settings: [{ channelType: 'EMAIL', enabled: true }] };
    for (const who of [w, g]) {
      expect((await who.api.raw('PUT', CHANNEL_SETTING, emailOn)).status(), '준비: 이메일 켬').toBe(200);
      expect(channelMap(await who.api.get<ChannelSettings>(CHANNEL_SETTING)).EMAIL, '준비: 이메일이 켜져 있다').toBe(true);
    }

    await test.step('SOS: 이메일 켠 보호자에게 이메일 시도가 없다', async () => {
      await sendSos(w.api);
      const [row] = await waitForLog(guardian.id, 'WARD_SOS');
      const channels = channelsOf(row.channels);
      expect(channels.find(c => c.channel === 'FCM'), '앱 푸시는 시도했다(대조: 이력이 정상으로 남았다)').toBeDefined();
      expect(channels.map(c => c.channel), '이메일은 시도하지 않았다').not.toContain('EMAIL');
    });

    await test.step('복약 알림: 이메일 켠 피보호자에게 앱 푸시만 시도한다', async () => {
      await addMedication(g.api, ward.id, dose!);
      const [row] = await waitForLog(ward.id, 'MEDICATION_REMINDER', 1, 150_000);
      const channels = channelsOf(row.channels);
      expect(channels.map(c => c.channel), '복약 알림은 앱 푸시(FCM)만').toEqual(['FCM']);
    });

    test.info().annotations.push({
      type: '확인 범위',
      description: 'SOS·복약 알림(피보호자)에서 이메일을 시도하지 않는 것까지 확인. 화재(이상감지)는 NOTI-A18b(CAM_SIGNAL_ALLOWED=1 게이트), 판정 재촉은 NOTI-A18c(fixme)로 나눴다. 이메일이 허용되는 종류에서는 실제로 이메일이 시도되는 대조는 N16 에서 본다',
    });
  });

  test('NOTI-A18b 이메일로 화재(이상감지) 알림은 안 나감', NOTI_P1_TAGS, async ({ tempUser, login, openAs }) => {
    test.skip(!CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON);
    test.setTimeout(300_000);
    const ward = await tempUser('WARD', { phone: null });
    const guardian = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, ward.id);
    const [w, g] = [await login(ward), await login(guardian)];
    expect((await g.api.raw('PUT', CHANNEL_SETTING, { settings: [{ channelType: 'EMAIL', enabled: true }] })).status(), '준비: 보호자가 이메일 켬').toBe(200);

    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
    let streamer: Page | undefined;
    try {
      streamer = await openAs(g.who, '/guardian/stream');
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);
      await sendFireFrames(streamer, camera.sessionId, fireImage());
      const [row] = await waitForLog(guardian.id, 'ANOMALY_DETECTED', 1, 60_000);
      const channels = channelsOf(row.channels).map(c => c.channel);
      expect(channels, '앱 푸시는 시도했다(대조: 이력이 정상으로 남았다)').toContain('FCM');
      expect(channels, '화재 알림에 이메일 시도가 없다').not.toContain('EMAIL');
    } finally {
      await cleanupCamera(w.api, camera.id, camera.sessionId, streamer);
    }
  });

  test('NOTI-A18c 이메일로 판정 재촉(ANOMALY_REVIEW_REQUIRED)은 안 나감', NOTI_P1_TAGS, async () => {
    test.fixme(
      true,
      '판정 재촉은 상황이 닫힌 뒤 60분(anomaly.review-reminder.delay-minutes) 기다려야 하고 밤 22시-8시에는 미뤄져 테스트에서 기다릴 수 없다. 서버 설정은 바꿀 수 없다(금지). BE 단위 테스트(AnomalyReviewReminderService, 채널 FCM 만 허용)로 확인할 항목',
    );
  });

  test('NOTI-A20 메일 서버가 느리면 10초 뒤 PROVIDER_ERROR로 기록', NOTI_P1_TAGS, async () => {
    test.fixme(
      true,
      '메일 서버(SMTP)를 12초 지연시키려면 서버 설정(MAIL_HOST 등)이나 네트워크를 바꿔야 한다. 공유 dev 변경은 금지라 자동화하지 않는다(EmailSendExecutor 단위 테스트로 확인). 코드상 호출 전체 제한은 notification.email.call-timeout-seconds(기본 10초)이고 시간 초과는 PROVIDER_ERROR 로 기록한다. 화면 쪽 대기 시간(XCUT-G17)은 FE 항목이라 이 케이스와 별도로 본다',
    );
  });

  test('NOTI-A23 피보호자 본인에게는 알림톡을 보내지 않음', NOTI_P1_TAGS, async ({ tempUser, login, openAs }) => {
    test.skip(!CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON);
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    test.setTimeout(300_000);
    const ward = await tempUser('WARD'); // 임시 번호(문자 접수만 된다)
    const guardian = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, ward.id);
    const [w, g] = [await login(ward), await login(guardian)];
    const on = { settings: [{ channelType: 'KAKAO_ALIMTALK', enabled: true }, { channelType: 'SMS', enabled: true }] };
    expect((await w.api.raw('PUT', CHANNEL_SETTING, on)).status(), '준비: 피보호자가 알림톡·문자를 켬').toBe(200);

    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
    let streamer: Page | undefined;
    try {
      streamer = await openAs(g.who, '/guardian/stream');
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);
      await sendFireFrames(streamer, camera.sessionId, fireImage());
      const [row] = await waitForLog(ward.id, 'ANOMALY_DETECTED_SELF', 1, 60_000);
      const channels = channelsOf(row.channels);
      test.info().annotations.push({ type: '본인용 화재 알림 채널', description: channels.map(c => `${c.channel}:${c.status}`).join(' ') });
      expect(channels.map(c => c.channel), '알림톡은 시도하지 않는다').not.toContain('KAKAO_ALIMTALK');
      expect(channels.find(c => c.channel === 'FCM'), '앱 푸시는 그대로 시도').toBeDefined();
      expect(channels.find(c => c.channel === 'SMS'), '문자는 그대로 접수됨').toMatchObject({ status: 'DELIVERED' });
    } finally {
      await cleanupCamera(w.api, camera.id, camera.sessionId, streamer);
    }
    test.info().annotations.push({ type: '미확인', description: '화면 알림(웹소켓)이 그대로 가는지는 이 테스트에서 보지 않는다' });
  });

  test('NOTI-A26 한 채널이 실패해도 나머지는 그대로 감(조건 바꿔 확인: 푸시 실패 + 문자 접수)',NOTI_P1_TAGS, async ({ tempUser, login }) => {
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD'); // 푸시 토큰 없음(푸시 실패), 임시 번호(문자 접수)
    const [g, w] = [await login(guardian), await login(ward)];
    const both = { settings: [{ channelType: 'FCM', enabled: true }, { channelType: 'SMS', enabled: true }] };
    expect((await w.api.raw('PUT', CHANNEL_SETTING, both)).status(), '준비: 푸시와 문자를 모두 켬').toBe(200);

    expect(await requestConnection(g.api, ward.id), '준비: 연결 요청').toBe(200);
    const [row] = await waitForLog(ward.id, 'CONNECTION_REQUEST');
    test.info().annotations.push({ type: 'CONNECTION_REQUEST 발송 결과', description: `${row.result} ${row.channels}` });

    const channels = channelsOf(row.channels);
    expect(channels.find(c => c.channel === 'FCM'), '푸시는 기기가 없어 실패했다').toMatchObject({ status: 'FAILED', reason: 'NO_DEVICE' });
    expect(channels.find(c => c.channel === 'SMS'), '앞 채널이 실패해도 문자는 그대로 발송(접수)됐다').toMatchObject({ status: 'DELIVERED' });
    expect(row.result, '한 채널이라도 전달되면 이력은 DELIVERED').toBe('DELIVERED');
    expect(channels, '채널별 결과가 둘 다 기록된다').toHaveLength(2);
    test.info().annotations.push({
      type: '조건 차이',
      description: '케이스는 "문자 실패(PROVIDER_REJECTED) + 푸시 정상"인데, 실제 푸시를 받을 기기(진짜 FCM 토큰)를 임시 사용자에게 만들 수 없고 문자 접수 거부도 일부러 만들 수 없다. 반대 조합(푸시 실패 NO_DEVICE + 문자 정상)으로 같은 규칙(한 채널 실패가 다른 채널을 막지 않고, 하나라도 전달되면 DELIVERED, 채널별 결과 기록)을 확인했다. "문자 실패가 PROVIDER_REJECTED 로 기록되는지"는 이 테스트로 못 보므로 BE 단위 테스트(채널별 결과 기록) 확인 항목',
    });
  });

  test('NOTI-N10 설정 처음 조회 시 푸시만 켜짐', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);
    const res = await u.api.raw('GET', CHANNEL_SETTING);
    expect(res.status()).toBe(200);
    const data = ((await res.json()) as { data: ChannelSettings }).data;
    expect(data.settings.map(s => s.channelType).sort(), '전체 방법을 나열한다').toEqual(['EMAIL', 'FCM', 'KAKAO_ALIMTALK', 'SMS']);
    expect(channelMap(data), '앱 푸시만 켜짐').toEqual({ FCM: true, SMS: false, KAKAO_ALIMTALK: false, EMAIL: false });
    expect(channelSettingRows(user.id), '조회만으로는 DB 행이 생기지 않는다').toEqual([]);
  });

  test('NOTI-N11 일부 채널만 바꾸면 보낸 것만 바뀜', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);

    const res = await u.api.raw('PUT', CHANNEL_SETTING, { settings: [{ channelType: 'SMS', enabled: true }] });
    expect(res.status()).toBe(200);
    const changed = ((await res.json()) as { data: ChannelSettings }).data;
    expect(changed.settings, '바꾼 뒤 전체 설정을 돌려준다').toHaveLength(4);
    expect(channelMap(changed), 'SMS 만 true, 나머지는 그대로').toEqual({ FCM: true, SMS: true, KAKAO_ALIMTALK: false, EMAIL: false });
    expect(channelMap(await u.api.get<ChannelSettings>(CHANNEL_SETTING)), '다시 조회해도 같다').toEqual({ FCM: true, SMS: true, KAKAO_ALIMTALK: false, EMAIL: false });
    expect(channelSettingRows(user.id), '보낸 채널(SMS)만 저장된다').toEqual([{ channel: 'SMS', enabled: true }]);

    const second = await u.api.raw('PUT', CHANNEL_SETTING, { settings: [{ channelType: 'FCM', enabled: false }] });
    expect(second.status()).toBe(200);
    expect(channelMap(await u.api.get<ChannelSettings>(CHANNEL_SETTING)), 'FCM 만 바꿔도 앞서 바꾼 SMS 는 유지').toEqual({ FCM: false, SMS: true, KAKAO_ALIMTALK: false, EMAIL: false });
  });

  test('NOTI-N12 설정 화면에서 채널 토글 저장·반영', NOTI_P1_TAGS, async ({ tempUser, login, openAs }) => {
    // 전화번호가 없는 임시 보호자라 켜 둬도 실제 발송은 없다
    const user = await tempUser('GUARDIAN', { phone: null });
    const u = await login(user);
    const page = await openAs(u.who, '/guardian/settings');
    await expect(page.getByRole('heading', { level: 1, name: '환경설정', exact: true })).toBeVisible();

    const openChannelTab = async () => {
      await page.getByRole('tab', { name: '알림 방법' }).click();
      await expect(page.getByRole('switch', { name: '푸시 알림' })).toBeVisible();
    };
    const toggle = async (name: string) => {
      const switchEl = page.getByRole('switch', { name });
      const saved = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().includes('/api/user/me/notification-settings'));
      await page.locator('label').filter({ has: switchEl }).click();
      expect((await saved).status(), `${name} 저장 요청`).toBe(200);
      await expect(switchEl).toBeChecked();
    };

    await openChannelTab();
    await expect(page.getByRole('switch', { name: '푸시 알림' }), '처음엔 푸시만 켜짐').toBeChecked();
    for (const name of ['SMS 문자', '카카오톡 알림톡', '이메일 알림']) {
      await expect(page.getByRole('switch', { name }), `${name} 처음엔 꺼짐`).not.toBeChecked();
    }
    await expect(page.getByText('미지원'), '"미지원" 표시가 없다(NOID-01)').toHaveCount(0);

    for (const name of ['SMS 문자', '카카오톡 알림톡', '이메일 알림']) await toggle(name);

    await page.reload();
    await openChannelTab();
    for (const name of ['푸시 알림', 'SMS 문자', '카카오톡 알림톡', '이메일 알림']) {
      await expect(page.getByRole('switch', { name }), `새로고침 뒤에도 ${name} 켜짐`).toBeChecked();
    }
    expect(channelMap(await u.api.get<ChannelSettings>(CHANNEL_SETTING)), '서버에도 저장돼 있다').toEqual({ FCM: true, SMS: true, KAKAO_ALIMTALK: true, EMAIL: true });
  });

  test('NOTI-N14 연결 요청을 사용자가 켠 채널로만 발송', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD'); // 임시 번호 010-0001-xxxx: 문자 1건 접수만 된다
    const [g, w] = [await login(guardian), await login(ward)];
    const smsOnly = { settings: [{ channelType: 'FCM', enabled: false }, { channelType: 'SMS', enabled: true }] };
    expect((await w.api.raw('PUT', CHANNEL_SETTING, smsOnly)).status(), '준비: 푸시 끄고 문자 켬').toBe(200);

    expect(await requestConnection(g.api, ward.id), '준비: 연결 요청').toBe(200);
    const [row] = await waitForLog(ward.id, 'CONNECTION_REQUEST');
    test.info().annotations.push({ type: 'CONNECTION_REQUEST 발송 결과', description: `${row.result} ${row.channels}` });
    expect(row.result).toBe('DELIVERED');
    expect(channelsOf(row.channels), '문자만 시도했고 푸시는 시도하지 않았다').toEqual([{ channel: 'SMS', status: 'DELIVERED', reason: null }]);
  });

  test('NOTI-N16 이메일 켜면 연결 요청이 계정 메일로 옴(연결 요청만 확인, 부분 확인)',NOTI_P1_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const [g, w] = [await login(guardian), await login(ward)];
    expect((await w.api.raw('PUT', CHANNEL_SETTING, { settings: [{ channelType: 'EMAIL', enabled: true }] })).status(), '준비: 이메일 켬').toBe(200);

    expect(await requestConnection(g.api, ward.id), '준비: 연결 요청(이메일 1통)').toBe(200);
    const [row] = await waitForLog(ward.id, 'CONNECTION_REQUEST');
    test.info().annotations.push({ type: 'CONNECTION_REQUEST 발송 결과', description: `${row.result} ${row.channels}` });
    expect(channelsOf(row.channels).find(c => c.channel === 'EMAIL'), '메일 서버가 접수함(DELIVERED)').toMatchObject({ status: 'DELIVERED', reason: null });
    expect(row.result).toBe('DELIVERED');
    test.info().annotations.push({
      type: '미확인',
      description: '메일 제목("[실버브릿지] {푸시 제목}")과 끄는 방법 안내 문구는 수신함을 읽을 수 없어(임시 주소) 확인하지 못했다. 코드(EmailNotificationChannel)의 제목 접두어와 꼬리말은 단위 테스트 대상. 문의 답변·복약 미복용 요약 메일은 이 테스트에서 보내지 않았다',
    });
  });

  test('NOTI-N17 카카오 알림톡 켜면 이상감지가 카카오톡으로도 옴', NOTI_P1_TAGS, async ({ tempUser, login, openAs }) => {
    test.skip(!CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON);
    test.skip(env.skipSms, 'E2E_SKIP_SMS=1: 실제 SMS 발송 요청이 생기는 테스트');
    test.setTimeout(300_000);
    const ward = await tempUser('WARD', { phone: null }); // 본인 문자 대체가 나가지 않게
    const guardian = await tempUser('GUARDIAN'); // 임시 번호: 알림톡 접수만 된다
    connect(guardian.id, ward.id);
    const [w, g] = [await login(ward), await login(guardian)];
    expect((await g.api.raw('PUT', CHANNEL_SETTING, { settings: [{ channelType: 'KAKAO_ALIMTALK', enabled: true }] })).status(), '준비: 알림톡 켬').toBe(200);

    const camera = await w.api.post<{ id: number; sessionId: string; deviceId: string }>('/api/ward/camera', { label: CAMERA_LABEL });
    let streamer: Page | undefined;
    try {
      streamer = await openAs(g.who, '/guardian/stream');
      await startManualSession(streamer, camera.sessionId, camera.deviceId);
      await waitSubscribed(camera.sessionId);
      await sendFireFrames(streamer, camera.sessionId, fireImage());
      const [row] = await waitForLog(guardian.id, 'ANOMALY_DETECTED', 1, 60_000);
      const channels = channelsOf(row.channels);
      test.info().annotations.push({ type: 'ANOMALY_DETECTED 발송 결과', description: `${row.result} ${channels.map(c => `${c.channel}:${c.status}`).join(' ')}` });
      expect(channels.find(c => c.channel === 'KAKAO_ALIMTALK'), '알림톡이 접수됨').toMatchObject({ status: 'DELIVERED' });
      expect(row.result).toBe('DELIVERED');
    } finally {
      await cleanupCamera(w.api, camera.id, camera.sessionId, streamer);
    }
    test.info().annotations.push({ type: '미확인', description: '알림톡 본문에 이름·장소·감지 종류·감지 시각이 채워졌는지는 발송사 접수 기록으로만 볼 수 있어 확인하지 않았다' });
  });

  test('NOTI-N18 채널 전부 꺼 두면 NOT_SENT(NO_ENABLED_CHANNEL)로 기록', NOTI_P1_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const [g, w] = [await login(guardian), await login(ward)];
    await setChannels(w.api, false);
    expect(Object.values(channelMap(await w.api.get<ChannelSettings>(CHANNEL_SETTING))), '준비: 설정 가능한 채널이 전부 꺼져 있다').toEqual([false, false, false, false]);

    expect(await requestConnection(g.api, ward.id), '준비: 연결 요청').toBe(200);
    const [row] = await waitForLog(ward.id, 'CONNECTION_REQUEST');
    expect(row.result, '알림이 나가지 않았다').toBe('NOT_SENT');
    expect(row.reason).toBe('NO_ENABLED_CHANNEL');
    expect(channelsOf(row.channels), '시도한 채널이 없다').toEqual([]);
  });

  test('NOTI-N21 알림 미허용 보호자에게 "알림 허용하기" 안내와 버튼', NOTI_P1_TAGS, async ({ tempUser, login, openAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const g = await login(guardian);
    const page = await openAs(g.who, null);
    // 브라우저 알림 권한이 "아직 묻지 않음(default)"인 상태를 만든다. 자동 요청은 조용히 무시하게 해 둔다
    await page.addInitScript(() => {
      class FakeNotification {
        static permission = 'default';
        static requestPermission() {
          return Promise.resolve('default');
        }
      }
      Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    });
    test.info().annotations.push({
      type: 'FE 근거',
      description: 'FE a8666240 에서 알림 권한 안내는 피보호자 복약 화면(WardPushPermissionNotice, "알림 켜기")뿐이다. 보호자 화면에는 "알림 허용하기" 안내·버튼 코드가 없다(NOID-05 남음)',
    });
    await page.goto('/guardian');
    await expect(page.getByRole('button', { name: '메뉴 열기' }), '준비: 보호자 화면이 열렸다').toBeVisible();

    await expect(page.getByRole('button', { name: '알림 허용하기' }), '알림 허용 버튼').toBeVisible();
    // 안내 문구 하나로 고정하고, 허용 버튼과 같은 상자 안에서만 찾는다(메뉴·카드의 "화재 알림" 글자에 헛통과하지 않게)
    const notice = page.locator('*').filter({ has: page.getByRole('button', { name: '알림 허용하기' }) }).filter({
      has: page.getByText('알림을 허용하지 않으면 화재 알림을 받을 수 없어요', { exact: true }),
    });
    await expect(notice.last(), '허용 버튼과 같은 안내 상자에 "알림을 허용하지 않으면 화재 알림을 받을 수 없어요" 문구').toBeVisible();
    test.info().annotations.push({ type: '버그 판정', description: 'FE 버그(진짜 버그): 보호자 화면에 알림 허용 안내·버튼이 없다. 안내 문구는 리뷰에서 제안한 한 문장으로 고정' });
  });
});
