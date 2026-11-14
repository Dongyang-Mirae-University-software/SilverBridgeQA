/**
 * 실제 화재 신호를 만드는 도우미 (피보호자 쿠키로 FE 송출 프록시에 사진 전송 → 공유 AI 서버 → BE 구독 → 이상감지)
 *
 * 공유 AI 서버에 실제 화재 사진을 보내고 dev 에 이상감지 기록이 생긴다. 사용자 승인(2026-10-05)을 받은 테스트에서만 쓴다.
 * 임시 사용자로만 쓰면 FCM 토큰이 없고 문자·알림톡은 기본값이 꺼져 있어 실제 발송은 없다.
 */
import { readFileSync } from 'node:fs';

import { APIRequestContext, Page, request } from '@playwright/test';

import type { LoginResult } from './api';
import { env } from './env';
import { expect } from './fixtures';
import { countBackendLog, fetchRemoteFile, psqlRows, redis, sqlStr } from './remote';

/**
 * 이상감지 알림의 "푸시 미전달 시 문자 대체 발송"(2026-10-06 결정)을 이 피보호자와 연결된 보호자 전원에 대해 막는다.
 * FCM 토큰이 없는 테스트 계정은 문자 대체 대상이라, 막지 않으면 Solapi 로 실제 문자 접수(비용)가 생긴다.
 *
 * BE 의 문자 대체 시간당 상한 카운터(SmsFallbackLimiter, 키 notify:sms-fallback:{종류}:{수신자ID})를 상한보다 크게 채워 둔다.
 * 상한은 문자만 건너뛰고 푸시·실시간 이벤트·이력·쿨다운은 건드리지 않으므로, 실시간 이벤트를 보는 테스트도 그대로 동작한다.
 * 연결(connect)을 만든 뒤, 화재 신호를 보내기 전에 부른다.
 */
export function suppressAnomalySmsFallback(wardId: string, seconds = 3600) {
  const guardians = psqlRows(`SELECT guardian_id FROM connection WHERE ward_id = ${sqlStr(wardId)} AND status = 'ACTIVE';`).map(r => r[0]);
  const recipients = [wardId, ...guardians];
  for (const id of recipients) {
    for (const type of ['ANOMALY_DETECTED', 'ANOMALY_DETECTED_SELF']) {
      redis('SET', `notify:sms-fallback:${type}:${id}`, '1000000', 'EX', String(seconds));
    }
  }
  return recipients;
}

/** AI 서버는 STREAM_SAMPLE_EVERY_N_FRAMES(=5) 프레임마다 한 번 분석한다. 여러 번 분석되도록 넉넉히 보낸다 */
const FRAMES_TO_SEND = 40;

export function fireImage() {
  return fetchRemoteFile(env.fireImageRemotePath, 'fire-sample.jpg');
}

/**
 * 송출용 요청 클라이언트. FE 송출 프록시(/api/streams/**)는 피보호자(WARD) 토큰 쿠키만 받는다.
 * FE 의 화면 송출 페이지(/guardian/stream)는 FE aed059e 에서 지워졌으므로, 화면 대신 프록시 API 를 직접 부른다.
 * 쓴 뒤에는 dispose() 로 닫는다(stopManualSession 이 닫아 준다).
 */
export async function wardStreamer(wardLogin: LoginResult): Promise<APIRequestContext> {
  return request.newContext({ baseURL: env.baseUrl, extraHTTPHeaders: { Cookie: `careai_access_token=${wardLogin.accessToken}` } });
}

/** 등록된 카메라의 sessionId 로 AI 송출 세션을 연다 */
export async function startManualSession(streamer: APIRequestContext, sessionId: string, cameraIdentifier: string) {
  const res = await streamer.post('/api/streams/v1/stream-sessions', { data: { sessionId, cameraIdentifier, deviceType: 'ipad' } });
  expect(res.status(), `송출 세션 열기 ${res.status()}`).toBe(200);
}

/** BE 가 그 세션을 구독할 때까지 기다린다 (AI 방송 또는 BE 의 60초 재동기화) */
export async function waitSubscribed(sessionId: string) {
  await expect
    .poll(() => countBackendLog(`세션 구독: sessionId=${sessionId}`), {
      timeout: 90_000,
      intervals: [5_000],
      message: 'BE 가 새 AI 세션을 구독해야 한다',
    })
    .toBeGreaterThan(0);
}

/**
 * 화재 사진을 간격을 두고 보낸다. 한꺼번에 몰아 보내면 AI 가 영상 흐름으로 보지 않아 감지가 안 나온다
 * (CAM 테스트의 startPump 처럼 0.4초 간격, 기본 40장 = 약 16초 이상)
 */
export async function sendFireFrames(streamer: APIRequestContext, sessionId: string, firePath: string, frames = FRAMES_TO_SEND, intervalMs = 400) {
  const jpeg = readFileSync(firePath);
  for (let i = 0; i < frames; i++) {
    const res = await streamer.post(`/api/streams/v1/stream-sessions/${sessionId}/frame`, {
      multipart: { frame: { name: 'frame.jpg', mimeType: 'image/jpeg', buffer: jpeg } },
    });
    expect(res.status(), `프레임 ${i + 1} 업로드`).toBe(200);
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
}

/** 송출을 끝내고 클라이언트를 닫는다. 실패해도 테스트 정리를 막지 않는다 */
export async function stopManualSession(streamer: APIRequestContext, sessionId: string) {
  await streamer.post(`/api/streams/v1/stream-sessions/${sessionId}/stop`).catch(() => undefined);
  await streamer.dispose().catch(() => undefined);
}

/** 브라우저의 STOMP 연결로 /topic/{id}/anomaly-detected 를 엿듣는다 (FE 는 이 토픽을 구독하지 않음) */
export async function listenAnomalyEvents(page: Page, userId: string) {
  await page.evaluate(id => {
    const w = window as unknown as {
      __connectionStompClient: { subscribe: (d: string, cb: (m: { body: string }) => void) => void };
      __e2eAnomaly: unknown[];
    };
    w.__e2eAnomaly = [];
    w.__connectionStompClient.subscribe(`/topic/${id}/anomaly-detected`, m => w.__e2eAnomaly.push(JSON.parse(m.body)));
  }, userId);
  return () => page.evaluate(() => (window as unknown as { __e2eAnomaly: Record<string, unknown>[] }).__e2eAnomaly);
}
