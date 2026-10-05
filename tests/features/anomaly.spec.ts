/**
 * 이상감지(화재) 전 과정: 카메라 영상 → AI 판정(danger) → BE 이상감지 상황 → 보호자 실시간 이벤트·알림 → 보호자 판정 → 관리자 로그
 *
 *   [피보호자] BE 에 카메라 등록 (sessionId 발급)          ← FE 에 화면이 없어 API 로
 *   [화면]     화면 송출 > 사진 직접 보내기 로 화재 사진 전송   ← 실제 UI
 *   [AI]       5프레임마다 분석 → fire, danger=true 를 WS 로 broadcast
 *   [BE]       등록된 세션만 구독 → FIRE 판정 → anomaly_incident/event → 보호자·본인 알림
 *   [화면]     이상감지 모니터에 "화재 감지됨"              ← 실제 UI
 *   [BE]       보호자 이력 조회·판정, 관리자 이상감지 로그   ← FE 에 화면이 없어 API 로
 *
 * 실제 발송: 이상감지 알림은 FCM 고정 + SMS·알림톡은 사용자가 켠 경우만이다. E2E 계정은 기본값(앱 푸시만)이라
 * 문자·알림톡은 나가지 않는다 - 테스트가 그것까지 확인한다.
 *
 * 사용 계정: ward1(카메라 주인) ↔ guardian1
 */
import { Page } from '@playwright/test';

import { ACCOUNTS } from '../../src/accounts';
import { Api } from '../../src/api';
import { env } from '../../src/env';
import { expect, test, waitForRealtime } from '../../src/fixtures';
import { countBackendLog, fetchRemoteFile, psqlRows, redisDelPattern, sqlStr } from '../../src/remote';

const G1 = ACCOUNTS.guardian1;
const W1 = ACCOUNTS.ward1;
/** AI 서버는 STREAM_SAMPLE_EVERY_N_FRAMES(=5) 프레임마다 한 번 분석한다 */
const FRAMES_TO_SEND = 6;

interface Camera {
  id: number;
  sessionId: string;
  deviceId: string;
  label: string;
}

interface Incident {
  incidentId: number;
  wardId: string;
  cameraLabel: string | null;
  detectedType: string;
  detectedTypeLabel: string;
  eventCount: number;
  maxConfidence: number;
  reviewStatus: string;
  myVerdict: string | null;
}

/** 화면 송출 페이지의 관리자 영역 ("고급 송출 설정"에도 같은 이름의 입력칸이 있어서 범위를 좁힌다) */
function adminPanel(streamer: Page) {
  return streamer.locator('details').filter({ has: streamer.locator('summary[aria-label="관리자 설정 열기"]') });
}

async function prepareManualSession(streamer: Page, sessionId: string, cameraIdentifier: string) {
  const admin = adminPanel(streamer);
  await admin.locator('summary').click();
  await admin.getByRole('tab', { name: '사진 직접 보내기' }).click();
  await admin.getByLabel('송출 이름').fill(sessionId);
  await admin.getByLabel('카메라 식별값').fill(cameraIdentifier);
  await admin.getByRole('button', { name: '전송 준비' }).click();
  await expect(admin.getByText('세션이 생성됐습니다.')).toBeVisible();
  await expect(admin.getByText(`전송 준비 완료: ${sessionId}`)).toBeVisible();
}

async function sendFireFrames(streamer: Page, sessionId: string, firePath: string) {
  const admin = adminPanel(streamer);
  await admin.getByLabel('보낼 사진 선택').setInputFiles(firePath);
  const send = admin.getByRole('button', { name: '선택한 사진 보내기' });
  for (let i = 0; i < FRAMES_TO_SEND; i++) {
    const [response] = await Promise.all([
      streamer.waitForResponse(r => r.url().includes(`/stream-sessions/${sessionId}/frame`)),
      send.click(),
    ]);
    expect(response.status(), `프레임 ${i + 1} 업로드`).toBe(200);
    await expect(send).toBeEnabled();
  }
  await expect(admin.getByText('프레임 업로드 완료')).toBeVisible();
}

async function stopManualSession(streamer: Page) {
  const admin = adminPanel(streamer);
  await admin.getByRole('button', { name: '전송 종료' }).click();
  await expect(admin.getByText('송출이 종료됐습니다.')).toBeVisible();
}

/** 보호자 브라우저의 STOMP 연결로 anomaly-detected 토픽을 엿듣는다 (FE 는 이 토픽을 구독하지 않음) */
async function listenAnomalyEvents(page: Page, guardianId: string) {
  await page.evaluate(id => {
    const w = window as unknown as {
      __connectionStompClient: { subscribe: (d: string, cb: (m: { body: string }) => void) => void };
      __e2eAnomaly: unknown[];
    };
    w.__e2eAnomaly = [];
    w.__connectionStompClient.subscribe(`/topic/${id}/anomaly-detected`, m => w.__e2eAnomaly.push(JSON.parse(m.body)));
  }, guardianId);
  return () => page.evaluate(() => (window as unknown as { __e2eAnomaly: Record<string, unknown>[] }).__e2eAnomaly);
}

async function recentIncidents(guardianApi: Api) {
  const page = await guardianApi.get<{ content: Incident[] }>(`/api/guardian/anomaly/history?wardId=${W1.id}&page=0&size=20`);
  return page.content;
}

/** 방 이름은 이전 실행과 겹칠 수 있어, 테스트 전에 있던 상황(before)은 빼고 찾는다 */
async function findIncident(guardianApi: Api, cameraLabel: string, before: Set<number>) {
  return (await recentIncidents(guardianApi)).find(item => item.cameraLabel === cameraLabel && !before.has(item.incidentId));
}

/** 카메라 이름은 정해진 방 목록 중 하나이고 한 방에 1대뿐이라, ward1 이 아직 쓰지 않은 방을 고른다 */
async function pickFreeRoom(wardApi: Api) {
  const rooms = await wardApi.get<{ label: string; registered: boolean }[]>('/api/ward/camera/rooms');
  const free = rooms.find(room => !room.registered);
  if (!free) throw new Error('ward1 의 모든 방에 카메라가 등록돼 있다 - 남은 테스트 카메라를 지워야 한다');
  return free.label;
}

async function prepareRun(wardApi: Api, guardianApi: Api) {
  // 이전 실행의 쿨다운(이력 1분·알림 5분)이 남아 있으면 이번 감지가 기록·알림되지 않으므로 지운다
  redisDelPattern(`anomaly:*${W1.id}*`);
  redisDelPattern(`anomaly:*${G1.id}*`);
  return {
    firePath: fetchRemoteFile(env.fireImageRemotePath, 'fire-sample.jpg'),
    cameraLabel: await pickFreeRoom(wardApi),
    before: new Set((await recentIncidents(guardianApi)).map(item => item.incidentId)),
    startedAt: new Date().toISOString(),
  };
}

test.describe('이상감지(화재)', () => {
  test('카메라를 등록해 둔 뒤 송출을 시작해도, 화재가 이상감지 상황으로 기록된다 (정상 사용 순서)', async ({
    openAs,
    apiAs,
  }) => {
    test.setTimeout(180_000);
    test.info().annotations.push({
      type: 'issue',
      description:
        'AI 서버 live_ws_manager.broadcast_nowait 가 asyncio.get_running_loop() 실패 시 조용히 return 하는데, ' +
        '세션 생성·종료 API(create_stream_session / stop_stream_session)가 동기 함수(def)라 스레드풀에서 실행돼 항상 실패한다. ' +
        '→ 세션 생성 시 live_streams 가 BE 로 전달되지 않음 → BE 는 카메라 등록·AI 재접속 때만 목록을 받으므로, ' +
        '카메라 등록 후에 송출을 시작하면 그 세션을 영영 구독하지 않는다 → 화재가 나도 이상감지 0건.',
    });
    const wardApi = await apiAs('ward1');
    const guardianApi = await apiAs('guardian1');
    const { firePath, cameraLabel, before } = await prepareRun(wardApi, guardianApi);

    // 정상 순서: 카메라(기기) 등록이 먼저, 송출은 나중
    const camera = await wardApi.post<Camera>('/api/ward/camera', { label: cameraLabel });
    const streamer = await openAs('guardian1', '/guardian/stream');
    try {
      await prepareManualSession(streamer, camera.sessionId, camera.deviceId);

      // AI 의 세션 생성 방송이 빠져도(AI-1) BE 가 60초마다 세션 목록을 다시 받아 구독한다 (2026-10-01 BE-1 반영).
      // 그래서 재동기화 주기(60초)보다 넉넉히 기다린 뒤, 구독된 상태에서 화재 프레임을 보낸다.
      await expect
        .poll(() => countBackendLog(`세션 구독: sessionId=${camera.sessionId}`), {
          timeout: 90_000,
          intervals: [5_000],
          message: 'BE 가 새 AI 세션을 구독해야 한다 (AI 방송 또는 BE 의 60초 재동기화)',
        })
        .toBeGreaterThan(0);
      await sendFireFrames(streamer, camera.sessionId, firePath);
      await expect
        .poll(async () => (await findIncident(guardianApi, cameraLabel, before))?.detectedType, { timeout: 30_000 })
        .toBe('FIRE');
      await stopManualSession(streamer);
    } finally {
      await streamer.request.post(`/api/streams/v1/stream-sessions/${camera.sessionId}/stop`).catch(() => undefined);
      await wardApi.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
    }
  });

  test('화재 사진 송출 → AI 판정 → 이상감지 상황 → 보호자 실시간 이벤트·알림 → 보호자 판정 → 관리자 로그', async ({
    openAs,
    apiAs,
  }) => {
    // 위 버그를 피하는 순서(송출 먼저 → 카메라 등록)로, 구독 이후 파이프라인 전체가 동작하는지 검증한다.
    // 카메라 등록 시 BE 가 AI 에 목록을 다시 요청하므로, 이미 돌고 있는 세션은 구독된다.
    test.setTimeout(240_000);
    const wardApi = await apiAs('ward1');
    const guardianApi = await apiAs('guardian1');
    const { firePath, cameraLabel, startedAt, before } = await prepareRun(wardApi, guardianApi);
    const adminApi = await apiAs('admin');

    // 순서: 1) 카메라 등록(sessionId 발급)  2) 화면에서 그 sessionId 로 송출 시작
    //       3) 같은 deviceId 로 재등록(멱등) → BE 가 AI 세션 목록을 다시 요청 → 이미 돌고 있는 세션을 구독
    const camera = await wardApi.post<Camera>('/api/ward/camera', { label: cameraLabel });
    // 보호자가 앱을 켜 둔 상태 - 이 브라우저로 실시간 이벤트를 받는다
    const listener = await openAs('guardian1', '/guardian');
    const streamer = await openAs('guardian1', '/guardian/stream');
    try {
      await waitForRealtime(listener);
      const anomalyEvents = await listenAnomalyEvents(listener, G1.id);

      await test.step('화면 송출: 등록된 카메라 세션으로 송출 시작', async () => {
        await prepareManualSession(streamer, camera.sessionId, camera.deviceId);
      });

      await test.step('카메라 재등록(같은 deviceId, 멱등) → BE 가 AI 세션을 구독', async () => {
        const again = await wardApi.post<Camera>('/api/ward/camera', { label: cameraLabel, deviceId: camera.deviceId });
        expect(again.sessionId).toBe(camera.sessionId);
        await expect
          .poll(() => countBackendLog(`세션 구독: sessionId=${camera.sessionId}`), { timeout: 20_000 })
          .toBeGreaterThan(0);
      });

      await test.step('화면 송출: 화재 사진 전송', async () => {
        await sendFireFrames(streamer, camera.sessionId, firePath);
      });

      await test.step('이상감지 모니터: 세션을 고르면 "화재 감지됨"', async () => {
        const monitor = await openAs('guardian1', '/guardian/detection');
        const session = monitor.getByRole('button', { name: new RegExp(camera.sessionId) });
        await expect(session).toBeVisible({ timeout: 30_000 });
        await session.click();
        await expect(monitor.getByText('화재 감지됨')).toBeVisible({ timeout: 30_000 });
      });

      let incident!: Incident;
      await test.step('BE: 보호자 이력에 화재 상황이 생긴다', async () => {
        await expect
          .poll(async () => (incident = (await findIncident(guardianApi, cameraLabel, before))!)?.detectedType, {
            timeout: 60_000,
            message: 'AI danger=true → BE anomaly_incident 생성',
          })
          .toBe('FIRE');
        expect(incident.detectedTypeLabel).toBe('화재');
        expect(incident.reviewStatus).toBe('PENDING');
        expect(incident.myVerdict).toBeNull();
        expect(incident.maxConfidence).toBeGreaterThanOrEqual(0.6);
      });

      await test.step('알림 발송 기록: 보호자·본인에게 발송, 문자·알림톡은 나가지 않음', async () => {
        await expect
          .poll(
            () =>
              psqlRows(`SELECT recipient_id, type FROM notification_log
                        WHERE ward_id = ${sqlStr(W1.id)} AND type LIKE 'ANOMALY_DETECTED%'
                          AND created_at >= ${sqlStr(startedAt)}::timestamptz;`).map(([r, t]) => `${r}:${t}`),
            { timeout: 30_000 },
          )
          .toEqual(expect.arrayContaining([`${G1.id}:ANOMALY_DETECTED`, `${W1.id}:ANOMALY_DETECTED_SELF`]));
        const channels = psqlRows(`SELECT channel_results::text FROM notification_log
                                   WHERE ward_id = ${sqlStr(W1.id)} AND type LIKE 'ANOMALY_DETECTED%'
                                     AND created_at >= ${sqlStr(startedAt)}::timestamptz;`).flat().join(' ');
        test.info().annotations.push({ type: '이상감지 알림 채널 결과', description: channels });
        expect(channels).not.toContain('"SMS"');
        expect(channels).not.toContain('"KAKAO_ALIMTALK"');
      });

      await test.step('보호자 브라우저에 실시간 anomaly-detected 이벤트가 도착했다', async () => {
        await expect.poll(async () => (await anomalyEvents()).length, { timeout: 20_000 }).toBeGreaterThan(0);
        const events = await anomalyEvents();
        // WS 페이로드의 incidentId 는 문자열, REST 는 숫자로 온다
        expect(events.map(event => String(event.incidentId))).toContain(String(incident.incidentId));
        test.info().annotations.push({
          type: '참고',
          description: 'BE 는 실시간 이벤트를 보내지만 FE 는 anomaly-detected 를 구독하지 않아 보호자 화면에는 아무것도 뜨지 않는다',
        });
      });

      await test.step('보호자가 "실제 상황"으로 판정하면 판정 상태가 반영된다', async () => {
        await guardianApi.post(`/api/guardian/anomaly/${incident.incidentId}/feedback`, { verdict: 'REAL' });
        const updated = (await findIncident(guardianApi, cameraLabel, before))!;
        expect(updated.myVerdict).toBe('REAL');
        expect(updated.reviewStatus).toBe('REAL');
      });

      await test.step('관리자 이상감지 로그에 같은 상황이 보인다', async () => {
        const page = await adminApi.get<{ content: { incidentId: number }[] }>(
          `/api/admin/anomaly?wardId=${W1.id}&page=0&size=20`,
        );
        expect(page.content.map(item => item.incidentId)).toContain(incident.incidentId);
      });

      await test.step('화면 송출: 전송 종료', async () => {
        await stopManualSession(streamer);
      });
    } finally {
      // 화면에서 종료하지 못했어도 AI 세션과 카메라는 정리한다 (AI 세션 목록은 모든 보호자에게 보인다)
      await streamer.request.post(`/api/streams/v1/stream-sessions/${camera.sessionId}/stop`).catch(() => undefined);
      await wardApi.call('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
    }
  });
});
