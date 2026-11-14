/**
 * 최종 QA - 카메라·이상감지(CAM) P1b - 이상감지 신호 판정·쿨다운
 *
 * 공유 AI 서버에 실제 사진을 보낸다(임시 계정 카메라 1대, 서비스 전체 상한 3대 - 자리가 날 때까지 기다림, 끝나면 바로 지움).
 * BE 가 AI 서버에 거는 WebSocket 으로만 신호가 들어와서(AI 키 없이 신호를 만들어 넣을 길이 없음) AI 가 정하는 값(종류·danger)을
 * 마음대로 바꿀 수 없다. 사진을 골라 AI 가 그렇게 판정하도록 만든다.
 * N21·N25 는 푸시가 나가지 않게 본인·보호자의 앱 푸시(FCM)를 꺼 둔다. N26 만 쿨다운을 보려고 문자 채널을 켠다(전달돼야 쿨다운이 남는다).
 */
import { readFileSync } from 'node:fs';

import { setChannel } from './_helpers-cam';
import { expect, test } from '../../../src/fixtures';
import { fetchRemoteFile, psqlRows, sqlStr } from '../../../src/remote';
import {
  cleanupAll,
  connect,
  deleteCamera,
  fireJpeg,
  history,
  HistoryItem,
  loginUser,
  mkUser,
  plainJpeg,
  proxyFor,
  rowsRetry,
  setupStreamingCamera,
  sleep,
  startPump,
  stopAiSession,
  suppressAnomalySmsFallback,
  TAGS,
  totalCameras,
  waitForCameraSlots,
  waitUntil,
} from './_helpers-cam-p1b';

test.afterEach(async () => {
  await cleanupAll();
});

const DATASET = '/home/apps/SilverBridgeSky/project-check/datasets/fire/test/images/';
/** AI 학습 데이터셋의 시험 사진 중 라벨이 연기(smoke) 하나뿐인 것(박스가 큰 순) */
const SMOKE_ONLY = [
  'H_04313_png_jpg.rf.ac2cf3c9616ddd52c5b4349f608826ea.jpg',
  'H_07678_png_jpg.rf.42e4f8a95af46bd66d082df2a4d3fe13.jpg',
  'H_06758_png_jpg.rf.9ce0f3a7f3866d1587989a243cf24873.jpg',
];
/** 같은 데이터셋에서 AI 가 불꽃은 찾지만 위험(danger)은 false 로 판정하는 사진(확신도 0.4 안팎) - 프로브로 확인한 값 */
const FIRE_BUT_NOT_DANGER = [
  '0000002861_jpg.rf.b462e98b5d231bf3f5440c200b2bb266.jpg',
  '88_jpg.rf.bbbe35b866afcde75b712e5c0f5575e7.jpg',
];

const datasetJpeg = (name: string) => readFileSync(fetchRemoteFile(DATASET + name, `p1b-${name.slice(0, 24)}.jpg`));

/** 임시 피보호자·보호자 1명, 연결, 문자·푸시 차단, 카메라 1대(BE 가 구독할 때까지) */
async function setup(withSms = false) {
  const ward = mkUser('WARD', 'E2E신호본인');
  const guardian = mkUser('GUARDIAN', 'E2E신호보호자');
  connect(guardian.id, ward.id);
  suppressAnomalySmsFallback(ward.id);
  const w = await loginUser(ward);
  const g = await loginUser(guardian);
  if (withSms) {
    // 쿨다운은 "전달된" 알림에만 남는다(어느 채널로도 못 전달되면 쿨다운을 풀어 재감지 때 다시 알린다). 임시 계정은 푸시 기기가 없어
    // 문자 채널을 켠 수신자만 전달된다 - 보호자·본인 문자 몇 건(실제 접수, 최소)
    expect(await setChannel(g.api, 'SMS', true), '준비: 보호자 문자 켜기').toBe(200);
    expect(await setChannel(w.api, 'SMS', true), '준비: 본인 문자 켜기').toBe(200);
  } else {
    expect(await setChannel(g.api, 'FCM', false), '준비: 보호자 푸시 끄기').toBe(200);
    expect(await setChannel(w.api, 'FCM', false), '준비: 본인 푸시 끄기').toBe(200);
  }
  const ok = await waitForCameraSlots(1, 540_000);
  test.skip(!ok, `카메라 상한 여유 없음(서비스 전체 ${totalCameras()}대 / 상한 3대) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다`);
  const proxy = await proxyFor(w.login);
  const camera = await setupStreamingCamera(w.api, proxy, await plainJpeg(), '거실');
  return { ward, guardian, w, g, proxy, camera };
}

const incidentsOf = (wardId: string) => rowsRetry(`SELECT id, detected_type FROM anomaly_incident WHERE ward_id = ${sqlStr(wardId)} ORDER BY id;`).map(r => ({ id: Number(r[0]), type: r[1] }));
const eventsOf = (wardId: string) => rowsRetry(`SELECT extract(epoch from detected_at)::bigint FROM anomaly_event WHERE ward_id = ${sqlStr(wardId)} ORDER BY id;`).map(r => Number(r[0]));
const noticesOf = (wardId: string, type: string) =>
  rowsRetry(`SELECT extract(epoch from created_at)::bigint, result FROM notification_log WHERE ward_id = ${sqlStr(wardId)} AND type = ${sqlStr(type)} ORDER BY id;`).map(r => ({ at: Number(r[0]), result: r[1] }));

async function waitIncident(g: Awaited<ReturnType<typeof setup>>['g'], wardId: string, timeoutMs: number): Promise<HistoryItem | undefined> {
  let found: HistoryItem | undefined;
  await waitUntil(async () => {
    const r = await history(g.api, `wardId=${wardId}&size=10`);
    found = r.page?.content[0];
    return !!found;
  }, timeoutMs, 4_000);
  return found;
}

test.describe('카메라·이상감지 P1b - 신호 판정·쿨다운', () => {
  test('CAM-A27 이력 저장 실패 시 쿨다운 해제, 이후 신호 정상 수신', TAGS, async () => {
    test.fixme(
      true,
      '이력 저장이 한 번 실패하는 상황을 공유 dev 서버에서 만들 수 없다: 신호의 유일한 진입점이 BE 가 AI 서버에 거는 WebSocket(AiLiveStreamSubscriber)이라 HTTP·DB·Redis 로 신호를 주입할 수 없고, ' +
        '저장 실패(롤백)는 DB 장애를 일으켜야 해서 금지다. 보류 이슈 ANOM-G14(BE AnomalyDetectionService 가 롤백 시 쿨다운을 되돌림 - releaseCooldownIfRolledBack)는 ' +
        'BE 단위 테스트로만 확인된다. 수동 확인 절차: 전용 환경에서 anomaly_event 저장 단계에 예외를 한 번 강제한 뒤 같은 카메라로 바로 화재 신호를 보내 ' +
        'anomaly:cooldown:{sessionId}:FIRE 키가 남지 않고 다음 신호가 이력·알림으로 이어지는지 본다.',
    );
  });

  test('CAM-N21 연기(smoke)도 화재(FIRE)로 기록', TAGS, async () => {
    test.setTimeout(600_000);
    const s = await setup();
    // 라벨이 연기 하나뿐인 사진을 보낸다. 이상감지 상황이 생길 때까지 후보 사진을 차례로 쓴다
    let incident: HistoryItem | undefined;
    let used = '';
    for (const name of SMOKE_ONLY) {
      const pump = startPump(s.proxy, s.camera.sessionId, datasetJpeg(name), 400);
      incident = await waitIncident(s.g, s.ward.id, 75_000);
      await pump.stop();
      if (incident) {
        used = name.slice(0, 12);
        break;
      }
    }
    const analysis = ((await (await s.g.api.raw('GET', `/api/guardian/camera/${s.camera.sessionId}/status`)).json()) as { data?: { analysis?: { detectedType: string; danger: boolean; confidence: number } | null } }).data?.analysis;
    test.info().annotations.push({ type: '연기 사진 분석', description: `사진 ${used || '(없음)'}, 분석 ${analysis ? `${analysis.detectedType}/danger=${analysis.danger}/${analysis.confidence.toFixed(2)}` : 'null'}` });
    expect(incident, `연기 사진 ${SMOKE_ONLY.length}장 중 어느 것으로도 이상감지 상황이 생기지 않았다`).toBeTruthy();
    expect(incident!.detectedType, '연기도 화재(FIRE)로 기록').toBe('FIRE');
    expect((incident as HistoryItem & { detectedTypeLabel?: string }).detectedTypeLabel, '화면 표시 이름').toBe('화재');
    // 기록된 감지는 모두 FIRE (SMOKE 값은 저장되지 않는다)
    const types = psqlRows(`SELECT DISTINCT detected_type FROM anomaly_event WHERE ward_id = ${sqlStr(s.ward.id)};`).map(r => r[0]);
    expect(types, '감지 기록의 종류').toEqual(['FIRE']);
    // 알림 문구도 화재 문구 (보호자: "…에서 화재가 감지되었습니다.", 본인: 대피 안내)
    const guardianRows = psqlRows(`SELECT replace(title, E'\\n', ' '), replace(body, E'\\n', ' ') FROM notification_log WHERE ward_id = ${sqlStr(s.ward.id)} AND type = 'ANOMALY_DETECTED' ORDER BY id;`);
    expect(guardianRows.length, '보호자 알림 기록').toBeGreaterThanOrEqual(1);
    expect(guardianRows[0][0], '보호자 제목').toContain('화재');
    expect(guardianRows[0][1], '보호자 문구').toContain('화재가 감지되었습니다.');
    expect(guardianRows[0][1], '문구에 연기라는 별도 종류가 없다').not.toContain('연기가 감지');
    const selfRows = psqlRows(`SELECT replace(body, E'\\n', ' ') FROM notification_log WHERE ward_id = ${sqlStr(s.ward.id)} AND type = 'ANOMALY_DETECTED_SELF' ORDER BY id;`);
    expect(selfRows.length, '본인 알림 기록').toBeGreaterThanOrEqual(1);
    expect(selfRows[0][0], '본인 문구는 대피 안내').toMatch(/밖으로 나가세요/);
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: 'AI 가 보낸 원래 종류 이름이 smoke 인지는 BE 가 FIRE 로 바꾼 뒤에 보여서 구분하지 못했다(연기만 있는 사진으로 FIRE 이력·알림이 생긴 것까지 확인). smoke -> FIRE 변환 자체는 BE 단위 테스트(DetectedTypeTest)가 확인',
    });
  });

  test('CAM-N25 danger 플래그만 믿는다', TAGS, async () => {
    test.setTimeout(600_000);
    const s = await setup();
    type Snap = { detectedType: string; danger: boolean; confidence: number } | null | undefined;
    const analysisNow = async (): Promise<Snap> =>
      ((await (await s.g.api.raw('GET', `/api/guardian/camera/${s.camera.sessionId}/status`)).json()) as { data?: { analysis?: Snap } }).data?.analysis;

    // 1) AI 가 불꽃(FIRE)은 찾지만 위험(danger)은 false 로 판정하는 사진을 보낸다 - AI 의 분석을 보고 그런 사진인지 확인한다
    let chosen: string | undefined;
    let pump: ReturnType<typeof startPump> | undefined;
    let seen: Snap;
    for (const name of FIRE_BUT_NOT_DANGER) {
      pump = startPump(s.proxy, s.camera.sessionId, datasetJpeg(name), 400);
      const ready = await waitUntil(async () => {
        seen = await analysisNow();
        return !!seen && seen.detectedType === 'FIRE' && seen.danger === false;
      }, 40_000, 4_000);
      if (ready) {
        chosen = name;
        break;
      }
      await pump.stop();
      pump = undefined;
    }
    expect(chosen, `준비: AI 가 FIRE 이면서 danger=false 로 판정하는 사진을 찾지 못했다(마지막 분석 ${JSON.stringify(seen)})`).toBeTruthy();
    test.info().annotations.push({ type: '분석', description: `FIRE/danger=false/확신도 ${seen!.confidence.toFixed(2)} (사진 ${chosen!.slice(0, 12)})` });

    // 2) 이 사진을 이력 쿨다운(1분)·AI 처리 시간보다 충분히 오래(100초) 보내도 기록·알림이 없다
    // 100초 동안 10초마다 분석을 읽어, 내내 danger=false 였는지 기록한다(고정 대기 대신 관찰)
    let polls = 0;
    let dangerTrueSeen = 0;
    const observeUntil = Date.now() + 100_000;
    await waitUntil(async () => {
      const snap = await analysisNow().catch(() => undefined);
      if (snap) {
        polls++;
        if (snap.danger !== false) dangerTrueSeen++;
      }
      return Date.now() >= observeUntil;
    }, 110_000, 10_000);
    const still = await analysisNow();
    await pump!.stop();
    test.info().annotations.push({ type: '관찰', description: `분석 ${polls}번 읽음, danger 가 false 가 아니었던 횟수 ${dangerTrueSeen}` });
    expect(polls, '관찰 중 분석을 읽어야 한다').toBeGreaterThan(3);
    expect(dangerTrueSeen, '관찰 중 한 번도 danger=true 가 아니었다').toBe(0);
    expect(still?.danger, '관찰 중에도 AI 는 danger=false').toBe(false);
    expect(psqlRows(`SELECT count(*) FROM anomaly_incident WHERE ward_id = ${sqlStr(s.ward.id)};`)[0][0], 'danger=false 신호로 이상감지 상황이 생기면 안 된다').toBe('0');
    expect(psqlRows(`SELECT count(*) FROM anomaly_event WHERE ward_id = ${sqlStr(s.ward.id)};`)[0][0], 'danger=false 신호로 감지 기록이 생기면 안 된다').toBe('0');
    expect(psqlRows(`SELECT count(*) FROM notification_log WHERE ward_id = ${sqlStr(s.ward.id)} AND type LIKE 'ANOMALY_DETECTED%';`)[0][0], 'danger=false 신호로 알림이 나가면 안 된다').toBe('0');

    // 3) 대조군: 같은 카메라로 danger=true 사진(화재)을 보내면 기록·알림이 생긴다(파이프라인이 살아 있다는 증거)
    const fire = startPump(s.proxy, s.camera.sessionId, fireJpeg(), 400);
    const incident = await waitIncident(s.g, s.ward.id, 90_000);
    await fire.stop();
    expect(incident, '대조군: danger=true 화재 사진으로는 상황이 생겨야 한다').toBeTruthy();
    expect(incident!.detectedType).toBe('FIRE');
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: '"확신도 0.9 인데 danger=false" 신호와 "모르는 종류 danger·danger 칸 없음은 WARN 만"은 AI 서버가 정하는 값이라 사진으로 만들 수 없었다(AI 는 확신도에 맞춰 danger 를 채움). BE 단위 테스트(AnomalySignalParserTest·AnomalySignalParserMultiDangerTest)가 확인. 여기서는 확신도 0.4 안팎·danger=false 신호가 기록·알림을 만들지 않는 것까지 확인',
    });
  });

  test('CAM-N26 이력 1분·보호자 5분·본인 3분 쿨다운', TAGS, async () => {
    test.setTimeout(1_500_000);
    const s = await setup(true);
    const wardId = s.ward.id;
    const pump = startPump(s.proxy, s.camera.sessionId, fireJpeg(), 500);
    const first = await waitIncident(s.g, wardId, 150_000);
    expect(first, '화재 사진으로 상황이 생겨야 한다').toBeTruthy();
    const t0 = eventsOf(wardId)[0];
    // 첫 감지부터 7분 동안 같은 카메라·종류로 계속 감지시킨다(분석은 프레임마다 나와 30초 간격보다 촘촘하다)
    // 시각은 DB 시계로만 잰다(PC 시계와 섞지 않는다)
    const dbNow = () => Number(rowsRetry('SELECT extract(epoch from now())::bigint;')[0][0]);
    await waitUntil(() => dbNow() >= t0 + 420, 480_000, 10_000);
    const events = eventsOf(wardId).filter(t => t <= t0 + 420);
    const guardian = noticesOf(wardId, 'ANOMALY_DETECTED').filter(n => n.at <= t0 + 420);
    const self = noticesOf(wardId, 'ANOMALY_DETECTED_SELF').filter(n => n.at <= t0 + 420);
    await pump.stop();
    const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]);
    test.info().annotations.push({
      type: '7분 동안',
      description: `감지 기록 ${events.length}건(간격 ${gaps(events).join(',')}초), 보호자 알림 ${guardian.length}건(${gaps(guardian.map(n => n.at)).join(',')}초), 본인 알림 ${self.length}건(${gaps(self.map(n => n.at)).join(',')}초), 알림 결과 ${[...new Set([...guardian, ...self].map(n => n.result))].join('/')}`,
    });
    // 이력은 1분에 1건
    expect(Math.min(...gaps(events)), '감지 기록은 1분(60초) 간격보다 촘촘하지 않다').toBeGreaterThanOrEqual(58);
    expect(events.length, '7분 동안 감지 기록은 1분에 1건 꼴(7~9건)').toBeGreaterThanOrEqual(7);
    expect(events.length).toBeLessThanOrEqual(9);
    // 보호자 알림은 5분에 1회: 처음 + 쿨다운(5분)이 끝난 뒤 첫 감지에서 다시 온다. 정확한 건수는 1분 경계에 따라 흔들려 간격으로 본다(건수는 annotation)
    expect(guardian.length, '보호자 알림이 쿨다운이 끝난 뒤 다시 왔다(2건 이상)').toBeGreaterThanOrEqual(2);
    expect(Math.min(...gaps(guardian.map(n => n.at))), '보호자 알림 간격은 5분 이상').toBeGreaterThanOrEqual(295);
    // 본인 알림은 3분에 1회
    expect(self.length, '본인 알림이 쿨다운이 끝난 뒤 다시 왔다(2건 이상)').toBeGreaterThanOrEqual(2);
    expect(Math.min(...gaps(self.map(n => n.at))), '본인 알림 간격은 3분 이상').toBeGreaterThanOrEqual(175);
    // 본인 쿨다운(3분)이 보호자(5분)보다 짧아서 같은 시간에 본인 알림이 더 많거나 같다
    expect(self.length, '본인 알림(3분)은 보호자 알림(5분)보다 적지 않다').toBeGreaterThanOrEqual(guardian.length);

    // 다른 카메라는 별도 카운트: 카메라를 지우고 새 카메라(새 세션)로 바로 화재를 보내면 쿨다운 중이어도 새 상황·새 알림이 온다
    const guardianBefore = noticesOf(wardId, 'ANOMALY_DETECTED').length;
    const selfBefore = noticesOf(wardId, 'ANOMALY_DETECTED_SELF').length;
    await stopAiSession(s.proxy, s.camera.sessionId);
    // 두 번째 카메라(cam2)도 setupStreamingCamera 가 AI 세션을 정리 목록에 올린다
    expect(await deleteCamera(s.w.api, s.camera.id), '첫 카메라 삭제').toBe(200);
    const cam2 = await setupStreamingCamera(s.w.api, s.proxy, await plainJpeg(), '거실');
    const pump2 = startPump(s.proxy, cam2.sessionId, fireJpeg(), 500);
    let second: HistoryItem | undefined;
    await waitUntil(async () => {
      const r = await history(s.g.api, `wardId=${wardId}&camera=EXISTING&size=10`);
      second = r.page?.content.find(i => i.incidentId !== first!.incidentId);
      return !!second;
    }, 150_000, 4_000);
    await waitUntil(() => noticesOf(wardId, 'ANOMALY_DETECTED').length > guardianBefore && noticesOf(wardId, 'ANOMALY_DETECTED_SELF').length > selfBefore, 60_000, 4_000);
    await pump2.stop();
    expect(second, '새 카메라의 화재로 새 상황이 생겨야 한다').toBeTruthy();
    const guardian2 = noticesOf(wardId, 'ANOMALY_DETECTED');
    const self2 = noticesOf(wardId, 'ANOMALY_DETECTED_SELF');
    expect(guardian2.length, '새 카메라의 첫 보호자 알림은 별도 카운트로 바로 온다').toBeGreaterThan(guardianBefore);
    expect(self2.length, '새 카메라의 첫 본인 알림도 바로 온다').toBeGreaterThan(selfBefore);
    const sinceLastGuardian = guardian2[guardianBefore].at - guardian2[guardianBefore - 1].at;
    test.info().annotations.push({ type: '다른 카메라', description: `직전 보호자 알림과 ${sinceLastGuardian}초 간격(쿨다운 300초보다 짧으면 별도 카운트가 증명됨)` });
    expect(sinceLastGuardian, '직전 보호자 알림과 5분이 안 지났는데도 새 카메라 알림이 왔다 = 별도 카운트').toBeLessThan(300);
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: '"다른 종류(흉기·낙상)는 별도 카운트"는 흉기·낙상 사진을 쓰지 않아 확인하지 않았다(키가 카메라·종류 단위라는 것은 BE 코드 AnomalyNotificationCooldown 기준). 알림은 보호자·본인 문자 채널로 전달시키고 알림 기록 줄과 시각으로 셌다(문자 약 6건 실제 접수)',
    });
  });
});