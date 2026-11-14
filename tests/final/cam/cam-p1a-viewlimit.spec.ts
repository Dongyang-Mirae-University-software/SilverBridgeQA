/**
 * 최종 QA - 카메라·이상감지(CAM) P1a - 동시 시청 상한(CAM-A17)
 *
 * 서로 다른 카메라 3대가 필요한데 서비스 전체 상한이 3대라서, 실시간 묶음(cam-p1a-live)과 파일을 나눴다.
 * 그 파일이 끝나면 자기 카메라를 모두 지우므로 여기서는 자리가 날 때까지 기다린다.
 * 이 PC 의 다른 파일 카메라는 모두 지워진 상태에서 시작한다. 그래도 3자리가 3분 안에 나지 않으면(고정 계정 카메라 2대가 계속 있음) 환경 한계로 skip 한다.
 */
import { expect, test } from '../../../src/fixtures';
import { Api } from '../../../src/api';
import {
  cleanupAll,
  connect,
  createAiSession,
  loginUser,
  mkUser,
  plainJpeg,
  postFrame,
  proxyFor,
  registerCamera,
  sleep,
  startPump,
  TAGS,
  trackCameraP1a,
  waitForCameraSlots,
  Camera,
} from './_helpers-cam-p1a';
import { mjpegUrl, totalCameras } from './_helpers-cam';

test.afterAll(async () => {
  await cleanupAll();
});

/** 열어 둔 영상 연결. 서버가 끊으면 endedAt 이 채워진다 */
function openLongStream(url: string) {
  const ctl = new AbortController();
  const state = { status: 0, contentType: '', bytes: 0, endedAt: 0, errorBody: '' };
  const done = (async () => {
    try {
      const res = await fetch(url, { signal: ctl.signal });
      state.status = res.status;
      state.contentType = res.headers.get('content-type') ?? '';
      if (res.status !== 200) {
        state.errorBody = (await res.text()).slice(0, 200);
        return;
      }
      const reader = res.body!.getReader();
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        state.bytes += value?.length ?? 0;
      }
    } catch {
      /* 끊김(서버 종료·우리가 abort) */
    } finally {
      state.endedAt = Date.now();
    }
  })();
  return { state, done, abort: () => ctl.abort() };
}

async function issueTicket(api: Api, sid: string): Promise<string> {
  const res = await api.raw('POST', `/api/guardian/camera/${sid}/stream-ticket`);
  expect(res.status(), `티켓 발급 상태 ${res.status()}`).toBe(200);
  return ((await res.json()) as { data: { ticket: string } }).data.ticket;
}

test.describe('카메라·이상감지 P1a - 동시 시청 상한', () => {
  test('CAM-A17 동시 시청 상한: 전체 20 / 한 사람 2', TAGS, async () => {
    test.setTimeout(600_000);
    // 다른 카메라가 정리되기를 최대 3분 기다린다. 서비스 전체 상한이 3대인데 고정 계정(진짜 사용자)의 카메라가 계속 남아 있으면
    // 서로 다른 카메라 3대를 만들 수 없다. 이것은 앱 결함이 아니라 환경 한계라 통과로 두지 않고 "실행 못 함(skip)"으로 분명히 남긴다.
    const gotSlots = await waitForCameraSlots(3, 180_000);
    test.skip(!gotSlots, `환경 한계: 서비스 전체 카메라 상한(3대) 중 ${totalCameras()}대를 다른 사용자가 계속 쓰고 있어 서로 다른 카메라 3대를 만들 수 없다. 동시 시청 한 사람 2개 상한은 확인하지 못했다`);
    const ward = mkUser('WARD', 'E2E시청상한본인');
    const g = mkUser('GUARDIAN', 'E2E시청상한');
    connect(g.id, ward.id);
    const wl = await loginUser(ward);
    const gl = await loginUser(g);
    const proxy = await proxyFor(wl.login);
    const jpeg = await plainJpeg();
    const cams: Camera[] = [];
    for (let i = 0; i < 3; i++) {
      const cam = await registerCamera(wl.api);
      trackCameraP1a(wl.api, cam.id, cam.sessionId, proxy);
      expect((await createAiSession(proxy, cam.sessionId, cam.deviceId)).status()).toBe(200);
      expect((await postFrame(proxy, cam.sessionId, jpeg)).status()).toBe(200);
      cams.push(cam);
    }
    const pumps = cams.map(c => startPump(proxy, c.sessionId, jpeg, 400));
    const open = async (cam: Camera) => openLongStream(mjpegUrl(cam.sessionId, await issueTicket(gl.api, cam.sessionId)));
    const s1 = await open(cams[0]);
    const s2 = await open(cams[1]);
    try {
      await expect.poll(() => Math.min(s1.state.bytes, s2.state.bytes), { timeout: 20_000, intervals: [500] }).toBeGreaterThan(0);
      const s3 = await open(cams[2]);
      await s3.done;
      expect(s3.state.status, '한 사람의 세 번째 영상').toBe(429);
      expect(s3.state.errorBody).toContain('CAMERA_STREAM_LIMIT_EXCEEDED');
      // 다른 API(목록·로그인)는 정상
      expect((await gl.api.raw('GET', '/api/guardian/camera/live')).status(), '시청 상한 중에도 다른 API').toBe(200);
      await loginUser(g);
      // 열린 영상이 끝나면 다시 열린다
      s1.abort();
      await s1.done;
      await expect
        .poll(async () => {
          const retry = await open(cams[2]);
          await sleep(1_500);
          const ok = retry.state.status === 200 && retry.state.bytes > 0;
          retry.abort();
          await retry.done;
          return ok;
        }, { timeout: 30_000, intervals: [2_000], message: '열린 영상 하나를 끊었는데 세 번째 영상이 열리지 않았다' })
        .toBe(true);
    } finally {
      s1.abort();
      s2.abort();
      await Promise.all([s1.done, s2.done]);
      for (const p of pumps) await p.stop();
    }
    test.info().annotations.push({ type: '확인하지 못한 부분', description: '서버 전체 동시 시청 20개 상한은 다중 계정·카메라 수십 대가 필요해(카메라 상한 3대) 확인하지 못했다' });
  });
});
