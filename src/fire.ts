/**
 * 실제 화재 신호를 만드는 도우미 (화면 송출 > 사진 직접 보내기 → 공유 AI 서버 → BE 구독 → 이상감지)
 *
 * 공유 AI 서버에 실제 화재 사진을 보내고 dev 에 이상감지 기록이 생긴다. 사용자 승인(2026-10-05)을 받은 테스트에서만 쓴다.
 * 임시 사용자로만 쓰면 FCM 토큰이 없고 문자·알림톡은 기본값이 꺼져 있어 실제 발송은 없다.
 */
import { Page } from '@playwright/test';

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

/** AI 서버는 STREAM_SAMPLE_EVERY_N_FRAMES(=5) 프레임마다 한 번 분석한다 */
const FRAMES_TO_SEND = 6;

export function fireImage() {
  return fetchRemoteFile(env.fireImageRemotePath, 'fire-sample.jpg');
}

/** 화면 송출 페이지의 관리자 영역 ("고급 송출 설정"에도 같은 이름의 입력칸이 있어서 범위를 좁힌다) */
function adminPanel(streamer: Page) {
  return streamer.locator('details').filter({ has: streamer.locator('summary[aria-label="관리자 설정 열기"]') });
}

/** 송출 화면(/guardian/stream)에서 등록된 카메라의 sessionId 로 사진 송출을 준비한다 */
export async function startManualSession(streamer: Page, sessionId: string, cameraIdentifier: string) {
  const admin = adminPanel(streamer);
  await admin.locator('summary').click();
  await admin.getByRole('tab', { name: '사진 직접 보내기' }).click();
  await admin.getByLabel('송출 이름').fill(sessionId);
  await admin.getByLabel('카메라 식별값').fill(cameraIdentifier);
  await admin.getByRole('button', { name: '전송 준비' }).click();
  await expect(admin.getByText(`전송 준비 완료: ${sessionId}`)).toBeVisible();
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

export async function sendFireFrames(streamer: Page, sessionId: string, firePath: string, frames = FRAMES_TO_SEND) {
  const admin = adminPanel(streamer);
  await admin.getByLabel('보낼 사진 선택').setInputFiles(firePath);
  const send = admin.getByRole('button', { name: '선택한 사진 보내기' });
  for (let i = 0; i < frames; i++) {
    const [response] = await Promise.all([
      streamer.waitForResponse(r => r.url().includes(`/stream-sessions/${sessionId}/frame`)),
      send.click(),
    ]);
    expect(response.status(), `프레임 ${i + 1} 업로드`).toBe(200);
    await expect(send).toBeEnabled();
  }
}

/** 송출을 끝낸다. 실패해도 테스트 정리를 막지 않는다 */
export async function stopManualSession(streamer: Page, sessionId: string) {
  await adminPanel(streamer).getByRole('button', { name: '전송 종료' }).click({ timeout: 5_000 }).catch(() => undefined);
  await streamer.request.post(`/api/streams/v1/stream-sessions/${sessionId}/stop`).catch(() => undefined);
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
