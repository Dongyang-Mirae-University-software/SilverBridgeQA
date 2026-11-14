/**
 * 최종 QA - 카메라·이상감지(CAM) P0 - 흉기 감지(N22), 미등록 세션(A22)과 자동화할 수 없는 케이스
 *
 * 흉기 사진은 gosky 의 데이터셋(읽기만)에서 받아 쓴다. 임시 사용자·카메라는 끝나면 지운다.
 * 카메라 상한(서비스 전체 3대)이 공용 값이라 시작할 때 자리를 확인하고 없으면 이유를 남기고 건너뛴다. 다른 영역과 동시에 돌리지 않는다.
 */
import { fetchRemoteFile, psqlRows, countBackendLog, sqlStr } from '../../../src/remote';
import { suppressAnomalySmsFallback } from '../../../src/fire';
import { expect, test } from '../../../src/fixtures';
import { readFileSync } from 'node:fs';
import { connect } from '../../../src/variables';
import {
  createAiSession,
  disposeFireRun,
  fireJpeg,
  freeRoom,
  loginApi,
  newTempUser,
  postFrame,
  releaseFireCamera,
  setupSubscribedCamera,
  sleep,
  stopAiSession,
  streamFireUntilIncident,
  wardProxy,
} from './_helpers-cam';

const TAGS = { tag: ['@P0', '@CAM'] };
test.describe.configure({ mode: 'serial' });
const KNIFE_REMOTE =
  process.env.E2E_KNIFE_IMAGE ??
  '/home/apps/SilverBridgeSky/project-check/datasets/knife/test/images/10098_bmp_bmp.rf.f7579e7b394a89138141c02c9afc7bcb.jpg';

test.afterAll(async () => {
  await disposeFireRun();
});

test.describe('카메라·이상감지 P0 - 흉기·미등록 세션', () => {
  test('CAM-N22 흉기 감지 기록·알림 문구', TAGS, async () => {
    test.setTimeout(420_000);
    const ward = newTempUser('WARD', { name: 'E2E흉기본인' });
    const guardian = newTempUser('GUARDIAN', { name: 'E2E흉기보호자' });
    connect(guardian.id, ward.id);
    suppressAnomalySmsFallback(ward.id);
    const w = await loginApi(ward);
    const g = await loginApi(guardian);
    const proxy = await wardProxy(w.login);
    const label = await freeRoom(w.api);
    const knife = readFileSync(fetchRemoteFile(KNIFE_REMOTE, 'knife-sample.jpg'));
    const startedAt = new Date().toISOString();
    const { camera } = await setupSubscribedCamera(w.api, proxy, label, knife);
    const incident = await streamFireUntilIncident(proxy, camera.sessionId, g.api, ward.id, label, 'WEAPON', 90_000, knife);
    expect(incident, '흉기 사진을 이어서 보냈지만 90초 안에 WEAPON 상황이 생기지 않았다(AI 흉기 모델 꺼짐 또는 사진 신뢰도 부족)').toBeTruthy();
    expect(incident!.detectedType).toBe('WEAPON');
    expect(incident!.detectedTypeLabel).toBe('흉기');
    await sleep(3_000);
    const rows = psqlRows(`SELECT recipient_id, type, title, replace(body, E'\\n', ' ') FROM notification_log WHERE ward_id = ${sqlStr(ward.id)} AND type LIKE 'ANOMALY_DETECTED%'
                           AND created_at >= ${sqlStr(startedAt)}::timestamptz;`);
    const guardianRow = rows.find(r => r[0] === guardian.id)!;
    const selfRow = rows.find(r => r[0] === ward.id)!;
    expect(guardianRow, '보호자 알림 기록').toBeTruthy();
    expect(guardianRow[2], '보호자 제목').toContain('흉기 감지');
    expect(guardianRow[3], '보호자 문구').toContain('흉기가 감지되었습니다.');
    expect(guardianRow[3], '보호자 안내는 바로 연락·112 신고').toMatch(/바로 연락해 안전을 확인하고, 위험하면 112에 신고해 주세요/);
    expect(selfRow, '본인 알림 기록').toBeTruthy();
    expect(selfRow[3], '본인 안내는 피신·112 연락').toBe('집에서 흉기가 감지됐어요. 안전한 곳으로 피하고 112에 연락하세요.');
    expect(Number(psqlRows(`SELECT count(*) FROM anomaly_event WHERE ward_id = ${sqlStr(ward.id)} AND detected_type = 'WEAPON';`)[0][0])).toBeGreaterThanOrEqual(1);
    await releaseFireCamera(); // 카메라 상한 자리를 바로 돌려준다(AI 세션 종료 + 카메라 삭제)
    await proxy.dispose();
  });

  test('CAM-A22 등록 안 된 세션은 구독하지 않아 알림 0건', TAGS, async () => {
    test.setTimeout(300_000);
    const ward = newTempUser('WARD', { name: 'E2E미등록' });
    const guardian = newTempUser('GUARDIAN', { name: 'E2E미등록보호자' });
    connect(guardian.id, ward.id); // 보호자가 있어야 잘못 구독됐을 때 알림 기록이 생긴다(보호자 0명이면 알림 0건이 당연하다)
    suppressAnomalySmsFallback(ward.id);
    const w = await loginApi(ward);
    const proxy = await wardProxy(w.login);
    const sessionId = `e2e_unreg_${Date.now().toString(36)}`;
    try {
      // 대조군: 등록한 카메라의 세션은 BE 가 구독해야 한다 -> BE 가 AI WebSocket 에 붙어 있다는 증거(끊겨 있으면 아래 0건은 아무것도 증명하지 못한다)
      const control = await setupSubscribedCamera(w.api, proxy, await freeRoom(w.api));
      test.info().annotations.push({ type: 'BE-AI 연결 대조군', description: `등록 카메라 세션이 ${control.subscribedMs}ms 만에 구독됨` });
      await releaseFireCamera(); // 카메라 상한 자리를 바로 돌려준다
      const startedAt = new Date().toISOString();
      // BE 에 카메라를 등록하지 않고 AI 에만 세션을 만들어 화재 사진을 보낸다
      expect((await createAiSession(proxy, sessionId, `e2e_dev_${Date.now().toString(36)}`)).status(), 'AI 세션 생성').toBe(200);
      const jpeg = fireJpeg();
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        expect((await postFrame(proxy, sessionId, jpeg)).status()).toBe(200);
        await sleep(250);
      }
      // BE 의 60초 재동기화가 한 번 이상 돌 시간을 준다
      await sleep(75_000);
      expect(countBackendLog(`세션 구독: sessionId=${sessionId}`, 200), '미등록 세션을 구독했다').toBe(0);
      expect(Number(psqlRows(`SELECT count(*) FROM anomaly_event WHERE session_id = ${sqlStr(sessionId)};`)[0][0]), '미등록 세션의 이력').toBe(0);
      expect(
        Number(psqlRows(`SELECT count(*) FROM notification_log WHERE ward_id = ${sqlStr(ward.id)} AND created_at >= ${sqlStr(startedAt)}::timestamptz;`)[0][0]),
        '미등록 세션의 알림',
      ).toBe(0);
    } finally {
      await stopAiSession(proxy, sessionId);
      await proxy.dispose();
    }
  });

  test.fixme('CAM-N23 낙상 감지 기록·알림 문구', TAGS, async () => {
    // 낙상 신호를 만들 수 없다: 낙상 모델·샘플 사진이 QA 가 쓸 수 있는 곳에 없다(gosky 데이터셋에 fall 폴더 없음, AI FALL_ENABLED 기본 꺼짐,
    // 낙상은 1.5초 유지 조건). 신호 주입 경로는 BE 가 AI 서버에 거는 WebSocket 뿐이라 BE 쪽에서 흉내 낼 수도 없다.
    // 확인할 내용: FALL 기록, 제목 '낙상 감지', 보호자 '바로 연락해 안전을 확인해 주세요', 본인 '넘어지신 것이 감지됐어요. 도움이 필요하면 가족에게 연락하세요.'
  });

  test.fixme('CAM-N24 흉기+낙상 동시 위험은 각각 기록', TAGS, async () => {
    // 낙상 신호를 만들 수 없어(CAM-N23 참고) 두 종류가 함께 위험인 신호를 만들 수 없다.
    // 확인할 내용: WEAPON·FALL 이력·알림·클립이 각각 생성, 쿨다운·상황도 (카메라,종류)별, camera-analysis 는 대표 1건
  });

  test.fixme('CAM-N52 반쯤 열린 연결은 180초 뒤 닫고 다시 붙는다', TAGS, async () => {
    // BE-AI WebSocket 을 메시지 없이 반쯤 열린 상태로 만들려면 공유 dev 서버의 네트워크·AI 서버를 건드려야 한다(금지).
    // BE 는 60초마다 목록을 요청하고 AI 가 답하므로 정상 상태에서는 180초 무수신이 생기지 않는다.
    // 확인할 내용: 로그 [ANOMALY-AI-WS-STALE] 뒤 재접속(간격 상한 20초+흔들기), 등록 세션 재구독
  });

  test.fixme('CAM-N53 돌아오지 않은 카메라: 화면 OFFLINE 후 2분 뒤 푸시 1회', TAGS, async () => {
    // AI 서버 재시작이 필요하다(컨테이너 재시작 금지). 푸시는 임시 계정에 FCM 토큰이 없어 도착을 확인할 수도 없다.
    // 확인할 내용: 즉시 camera-analysis status=offline, 2분 뒤 ACTIVE 보호자에게 CAMERA_LINK_LOST 앱 푸시 1회(카메라당 6시간 1회, 앱 푸시만)
  });

  test.fixme('CAM-A19 AI 서버 장애·키 미설정·종료 중이면 503, 느리면 8초에 끊김', TAGS, async () => {
    // AI 서버를 내리거나 지연시켜야 한다(서버 설정·컨테이너 변경 금지). 일부(status null)는 CAM-N18 에서 응답 흉내로 화면만 확인했다.
    // 확인할 내용: 503 CAMERA_STREAM_UNAVAILABLE, 8초 안 종료, 리다이렉트 미추적, live status null, Redis 장애 503 SERVICE_UNAVAILABLE
  });

  test.fixme('CAM-A28 알림 줄이 가득 차도 화재 알림이 밀리지 않는다', TAGS, async () => {
    // urgentNotificationExecutor(서버 내부 스레드 풀)에 부하를 넣을 수 없다(공유 서버 부하·지연 주입 금지, 코드는 AnomalyNotificationListener 의 @Async("urgentNotificationExecutor")로만 확인).
    // 확인할 내용: 화재 알림이 일반 알림 줄에 막히지 않음, 큐가 차면 [NOTIFY-REJECTED] ERROR 로그
  });
});
