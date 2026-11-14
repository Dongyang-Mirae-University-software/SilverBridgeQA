/**
 * 최종 QA - 알림(NOTI) P2 - 채널별 발송 규칙(건너뜀·실패 사유)
 *
 * 임시 사용자만 쓴다. 모두 전화번호가 없고(문자·알림톡 없음) 푸시 토큰도 없어서 외부로 나가는 것이 없다.
 * 실제 알림은 연결 요청(CONNECTION_REQUEST, 피보호자가 받는다)·문의 답변·복약 알림으로 일으키고,
 * 결과는 임시 사용자 자신의 알림 이력(notification_log)으로 읽는다.
 * 알림톡 승인 문구(템플릿)는 배포 설정(application.yaml)에서 이상감지(ANOMALY_DETECTED) 하나뿐이다.
 */
import { Api } from '../../../src/api';
import { TempUser } from '../../../src/seed';
import {
  addMedication,
  auditCountOf,
  blankEmail,
  bodyOf,
  channelsOf,
  CAM_SIGNAL_ALLOWED,
  CAM_SIGNAL_SKIP_REASON,
  CHANNEL_SETTING,
  createInquiry,
  deleteAuditRowsOf,
  expect,
  kstDoseTimeAgo,
  logTexts,
  P2_TAGS,
  requestConnection,
  test,
  waitForLog,
  withEmailChanged,
} from './_helpers-noti-p2';
import { connect } from '../../../src/variables';

type Channel = 'FCM' | 'SMS' | 'KAKAO_ALIMTALK' | 'EMAIL';

/** 네 채널의 켜짐·꺼짐을 한 번에 정한다 */
async function setChannelFlags(api: Api, flags: Record<Channel, boolean>) {
  const res = await api.raw('PUT', CHANNEL_SETTING, {
    settings: (Object.keys(flags) as Channel[]).map(channelType => ({ channelType, enabled: flags[channelType] })),
  });
  expect(res.status(), `준비: 채널 설정 저장 ${JSON.stringify(flags)}`).toBe(200);
}

/** 보호자가 피보호자에게 연결 요청을 보내 피보호자에게 CONNECTION_REQUEST 알림을 일으킨다 */
async function connectionRequestRow(guardian: Api, ward: TempUser, nth = 1) {
  expect(await requestConnection(guardian, ward.id), '준비: 연결 요청').toBe(200);
  const rows = await waitForLog(ward.id, 'CONNECTION_REQUEST', nth);
  expect(rows, `연결 요청 알림 이력은 ${nth}줄`).toHaveLength(nth);
  test.info().annotations.push({ type: 'CONNECTION_REQUEST 발송 결과', description: `${rows[nth - 1].result} ${rows[nth - 1].channels}` });
  return rows[nth - 1];
}

test.describe('이메일·문자·알림톡 건너뜀과 실패 사유', () => {
  test('NOTI-A19 카카오 가상 이메일 계정은 메일을 보내지 않고 이력에도 안 남김', P2_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const guardian2 = await tempUser('GUARDIAN', { phone: null }); // 같은 피보호자에게 두 번째 연결 요청을 보낼 다른 보호자(같은 보호자의 중복 요청을 피함)
    const ward = await tempUser('WARD', { phone: null });
    const [g, g2, w] = [await login(guardian), await login(guardian2), await login(ward)];
    await setChannelFlags(w.api, { FCM: false, SMS: false, KAKAO_ALIMTALK: false, EMAIL: true });

    // 대조(먼저): 이메일 칸이 비어 있으면 이메일 채널이 살아 있어 EMAIL FAILED/NO_EMAIL 줄이 생긴다.
    // 이것이 보여야 아래 가상 이메일의 "줄 없음"이 "이메일 채널이 꺼졌거나 설정이 저장 안 됨"이 아니라 "가상 이메일이라 건너뜀"이다
    const control = await withEmailChanged(ward.id, ward.email, blankEmail(), () => connectionRequestRow(g.api, ward, 1));
    expect(channelsOf(control.channels), '대조: 이메일 칸이 비면 이메일 채널이 NO_EMAIL 로 실패 기록(이메일 채널은 살아 있다)').toEqual([{ channel: 'EMAIL', status: 'FAILED', reason: 'NO_EMAIL' }]);

    const virtual = `kakao_${Date.now()}${Math.floor(Math.random() * 1000)}@kakao.com`;
    const row = await withEmailChanged(ward.id, ward.email, virtual, () => connectionRequestRow(g2.api, ward, 2));

    expect(channelsOf(row.channels), '이메일 시도 줄이 이력에 없다(발송 안 함, 실패도 아님)').toEqual([]);
    expect(row.result, '실패(FAILED)로 기록되지 않는다 - 보낼 채널이 없어 NOT_SENT').toBe('NOT_SENT');
    expect(row.reason, '사유는 켜진 채널 없음(대상 아님)').toBe('NO_ENABLED_CHANNEL');
    test.info().annotations.push({
      type: '문서와 코드 차이',
      description: '케이스의 "이력 줄 없음"은 채널별 결과(channel_results)에 EMAIL 줄이 없다는 뜻으로 확인했다. 알림 이력 행 자체는 남는다(켜 둔 채널이 이메일뿐이라 NOT_SENT / NO_ENABLED_CHANNEL). 근거: EmailNotificationChannel 이 NOT_APPLICABLE 을 돌려주고 디스패처는 그 시도를 기록하지 않는다',
    });
  });

  test('NOTI-A21 이메일 주소 없음은 NO_EMAIL 사유', P2_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const [g, w] = [await login(guardian), await login(ward)];
    await setChannelFlags(w.api, { FCM: false, SMS: false, KAKAO_ALIMTALK: false, EMAIL: true });

    const row = await withEmailChanged(ward.id, ward.email, blankEmail(), () => connectionRequestRow(g.api, ward));

    expect(channelsOf(row.channels), '이메일 채널이 NO_EMAIL 로 실패 기록').toEqual([{ channel: 'EMAIL', status: 'FAILED', reason: 'NO_EMAIL' }]);
    expect(row.result, '시도한 채널이 모두 실패면 FAILED').toBe('FAILED');
  });

  test('NOTI-A22 알림톡 승인 문구 없는 종류는 알림톡만 건너뜀', P2_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const [g, w] = [await login(guardian), await login(ward)];
    await setChannelFlags(w.api, { FCM: true, SMS: false, KAKAO_ALIMTALK: true, EMAIL: false });

    const row = await connectionRequestRow(g.api, ward);

    const channels = channelsOf(row.channels);
    expect(channels.map(c => c.channel), '알림톡은 시도 기록 자체가 없고 푸시만 시도했다').toEqual(['FCM']);
    expect(channels[0], '다른 채널(푸시)은 평소대로 시도됐다(기기 없음 사유)').toEqual({ channel: 'FCM', status: 'FAILED', reason: 'NO_DEVICE' });
    expect(row.result, '알림톡을 건너뛴 것이 실패로 번지지 않는다: 푸시 결과 하나만 반영').toBe('FAILED');
  });

  test('NOTI-A28 전화번호 없는 사용자는 문자가 NO_PHONE', P2_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD', { phone: null });
    const [g, w] = [await login(guardian), await login(ward)];
    await setChannelFlags(w.api, { FCM: false, SMS: true, KAKAO_ALIMTALK: false, EMAIL: false });

    const row = await connectionRequestRow(g.api, ward);

    expect(channelsOf(row.channels), '문자 채널이 NO_PHONE 으로 기록').toEqual([{ channel: 'SMS', status: 'FAILED', reason: 'NO_PHONE' }]);
    expect(row.result, '문자만 시도했고 실패라 FAILED').toBe('FAILED');
  });

  test('NOTI-A24 알림톡 실패 시 문자로 대신 보내지 않음', P2_TAGS, async () => {
    test.fixme(
      true,
      '자동화 불가: 알림톡이 나가는 종류는 이상감지(ANOMALY_DETECTED) 하나뿐이라 카메라 등록·화재 신호(CAM 영역)와 실제 알림톡 발송이 필요하다. 게다가 이상감지는 푸시도 알림톡도 못 가면 별개 규칙(필수 문자 대체)이 문자를 보내므로, "알림톡 실패가 문자로 번지지 않음"은 디스패처 결과로 구분되지 않는다. 알림톡 쪽 문자 대체 금지는 AlimtalkSender 의 setDisableSms(true) 코드로 확인하고 BE 단위 테스트(AlimtalkSender)에 맡긴다',
    );
  });

  test('NOTI-A25 알림톡 스위치(ALIMTALK_ENABLED) 끄면 발송 안 함', P2_TAGS, async () => {
    test.fixme(
      true,
      '자동화 불가: ALIMTALK_ENABLED 는 서버 환경변수라 테스트가 바꿀 수 없고(서버 설정 변경 금지) 발송 확인에는 카메라 화재 신호(CAM 영역)가 필요하다. 코드 근거: AlimtalkProperties.templateFor 가 enabled=false 면 null 을 돌려 KakaoAlimtalkNotificationChannel 이 건너뜀 처리한다',
    );
  });
});

test.describe('끌 수 없는 알림의 문자 대체', () => {
  test('NOTI-A31 재촉·동수 안내·복약 알림에는 문자 대체가 없음', P2_TAGS, async ({ tempUser, login }) => {
    test.setTimeout(300_000);
    const dose = kstDoseTimeAgo(2);
    test.skip(dose === null, '한국 시간 자정 직후라 "2분 전 복용 시각"이 어제가 된다. 몇 분 뒤 다시 실행');

    const ward = await tempUser('WARD', { phone: null }); // 번호가 없어도 문자를 시도했다면 NO_PHONE 줄이 남아 알아챌 수 있다
    const guardian = await tempUser('GUARDIAN', { phone: null });
    connect(guardian.id, ward.id);
    const [g, w] = [await login(guardian), await login(ward)];
    await setChannelFlags(w.api, { FCM: true, SMS: true, KAKAO_ALIMTALK: true, EMAIL: false });
    await addMedication(g.api, ward.id, dose!);

    const [row] = await waitForLog(ward.id, 'MEDICATION_REMINDER', 1, 150_000);
    test.info().annotations.push({ type: 'MEDICATION_REMINDER 발송 결과', description: `${row.result} ${row.channels}` });

    expect(channelsOf(row.channels), '푸시만 시도했다(기기 없음). 문자를 켜 두었어도 문자·알림톡 시도 줄이 없다').toEqual([{ channel: 'FCM', status: 'FAILED', reason: 'NO_DEVICE' }]);
    expect(row.result, '푸시 실패인데도 SMS_FALLBACK 이 아니라 FAILED 로 끝난다(문자 대체 없음)').toBe('FAILED');
    test.info().annotations.push({
      type: '확인 범위',
      description: '부분 확인: 이 test 는 복약 알림(MEDICATION_REMINDER)만 확인한다. 판정 재촉(ANOMALY_REVIEW_REQUIRED)과 동수 재확인 안내(ANOMALY_REVIEW_CONFLICTED)는 NOTI-A31b·A31c 로 나눴다. 케이스의 "푸시 토큰 없는 보호자"는 복약 알림의 실제 수신자가 피보호자라 피보호자로 확인했다',
    });
  });

  test('NOTI-A31b 판정 재촉(ANOMALY_REVIEW_REQUIRED)에는 문자 대체가 없음', P2_TAGS, async () => {
    test.skip(!CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON);
    test.fixme(
      true,
      '아직 자동화 안 됨(부분 확인): 게이트를 열어도 이 영역에는 카메라 등록·이상감지 신호와 판정 재촉 대기를 만드는 도우미가 없다. 코드상 허용 채널이 FCM 뿐이고 정책이 SETTINGS_ONLY 라 문자 대체(FORCED_PUSH_*)를 타지 않는다. CAM 영역(cam-p1b-remind)에서 재촉 알림이 생기면 그 이력의 채널 줄에 SMS 가 없는지로 확인한다',
    );
  });

  test('NOTI-A31c 동수 재확인 안내(ANOMALY_REVIEW_CONFLICTED)에는 문자 대체가 없음', P2_TAGS, async () => {
    test.skip(!CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON);
    test.fixme(
      true,
      '아직 자동화 안 됨(부분 확인): 게이트를 열어도 이 영역에는 카메라 등록·이상감지 신호와 보호자 둘의 엇갈린 판정을 만드는 도우미가 없다. 코드상 허용 채널이 FCM 뿐이고 정책이 SETTINGS_ONLY 라 문자 대체를 타지 않는다',
    );
  });
});

test.describe('문의 답변 알림', () => {
  test('NOTI-N15 문의 답변 알림이 켜 둔 채널로 도착', P2_TAGS, async ({ tempUser, login }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const admin = await tempUser('ADMIN');
    const [g, a] = [await login(guardian), await login(admin)];

    try {
      // 푸시만 켠 보호자: 문의 답변이 푸시 채널로만 시도된다(기기가 없어 NO_DEVICE 실패로 기록되지만 "켜 둔 채널로만 보냈다"가 확인 대상)
      await setChannelFlags(g.api, { FCM: true, SMS: false, KAKAO_ALIMTALK: false, EMAIL: false });
      const first = await createInquiry(g.api, 'QA 문의 1');
      const answer1 = await a.api.raw('POST', `/api/admin/inquiry/${first}/answer`, { answer: 'QA 답변 1' });
      expect(answer1.status(), `준비: 관리자 답변 등록 (${JSON.stringify((await bodyOf(answer1)).message)})`).toBe(200);
      const [row] = await waitForLog(guardian.id, 'INQUIRY_ANSWERED');
      expect(channelsOf(row.channels), '켜 둔 푸시 채널만 시도').toEqual([{ channel: 'FCM', status: 'FAILED', reason: 'NO_DEVICE' }]);
      expect(logTexts(row.id).title, '알림 제목').toBe('문의 답변 완료');

      // 모든 채널을 끄면 보내지 않고 NOT_SENT 로 기록된다
      await setChannelFlags(g.api, { FCM: false, SMS: false, KAKAO_ALIMTALK: false, EMAIL: false });
      const second = await createInquiry(g.api, 'QA 문의 2');
      expect((await a.api.raw('POST', `/api/admin/inquiry/${second}/answer`, { answer: 'QA 답변 2' })).status(), '준비: 두 번째 답변').toBe(200);
      const rows = await waitForLog(guardian.id, 'INQUIRY_ANSWERED', 2);
      expect(rows[1].result, '꺼 둔 채널로는 보내지 않는다').toBe('NOT_SENT');
      expect(rows[1].reason, '사유').toBe('NO_ENABLED_CHANNEL');
      expect(channelsOf(rows[1].channels)).toEqual([]);
      expect(auditCountOf(admin.id), '준비 확인: 임시 관리자의 답변 활동 기록 2건').toBe(2);
    } finally {
      deleteAuditRowsOf(admin.id);
    }
  });

  test('NOTI-N15b 피보호자 칸이 빈 알림(문의 답변)만 있는 받은 알림 목록', P2_TAGS, async ({ tempUser, login }) => {
    // N15 와 따로 둔 이유: 채널 발송은 정상이고, 받은 알림 목록 조회가 BE 에서 500 으로 깨지는 별개 문제다
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const admin = await tempUser('ADMIN');
    const [g, a] = [await login(guardian), await login(admin)];

    try {
      await setChannelFlags(g.api, { FCM: true, SMS: false, KAKAO_ALIMTALK: false, EMAIL: false });
      const sentInquiry = await createInquiry(g.api, 'QA 문의 b1');
      expect((await a.api.raw('POST', `/api/admin/inquiry/${sentInquiry}/answer`, { answer: 'QA 답변 b1' })).status(), '준비: 답변 1').toBe(200);
      const [sent] = await waitForLog(guardian.id, 'INQUIRY_ANSWERED');
      await setChannelFlags(g.api, { FCM: false, SMS: false, KAKAO_ALIMTALK: false, EMAIL: false });
      const skippedInquiry = await createInquiry(g.api, 'QA 문의 b2');
      expect((await a.api.raw('POST', `/api/admin/inquiry/${skippedInquiry}/answer`, { answer: 'QA 답변 b2' })).status(), '준비: 답변 2').toBe(200);
      const rows = await waitForLog(guardian.id, 'INQUIRY_ANSWERED', 2);

      // 문의 답변 알림은 특정 피보호자가 없는 알림(wardId 비어 있음)이다. 보낸 알림은 보호자의 받은 알림 목록에도 보여야 한다
      const inbox = await g.api.raw('GET', '/api/user/me/notifications?size=50');
      expect(inbox.status(), `받은 알림 목록 조회 200 (실제 ${inbox.status()})`).toBe(200);
      const ids = ((await bodyOf(inbox)).data as { content: { id: number }[] }).content.map(i => i.id);
      expect(ids, '보낸(푸시 시도) 문의 답변 알림은 목록에 보인다').toContain(sent.id);
      expect(ids, '보내지 않은(NOT_SENT) 알림은 목록에 없다').not.toContain(rows[1].id);
      test.info().annotations.push({
        type: '버그 의심 근거',
        description: 'BE UserNotificationService.getMyNotifications 65-69행: 피보호자 id 가 하나도 없으면 빈 불변 맵(Map.of())에서 null 키로 get 해 NullPointerException(500). 피보호자 칸이 채워진 알림이 하나라도 섞이면 괜찮다. 이 test 는 약하게 만들지 않고 BE 수정 뒤 통과해야 한다',
      });
    } finally {
      deleteAuditRowsOf(admin.id);
    }
  });
});
