/**
 * 최종 QA - 카메라·이상감지(CAM) P2 - 정지 화면(최근 한 장) 받기와 속도 제한
 *
 * 카메라 1대(서비스 전체 상한 3대 중 1자리)에 AI 세션을 만들고 평범한 사진 한 장을 보낸 뒤, 보호자 정지 화면(N13)과
 * 피보호자 정지 화면 속도 제한(A12)이 나눠 본다. 쓴 카메라·AI 세션·임시 사용자는 afterAll 에서 바로 지운다.
 * 속도 제한 키는 임시 피보호자 자신의 키(정확한 이름)만 지운다. 화재 신호를 보내지 않으므로 문자·알림은 나가지 않는다.
 */
import { expect, test } from '../../../src/fixtures';
import {
  Camera,
  cleanupAll,
  connect,
  createAiSession,
  loginUser,
  mkUser,
  needSlots,
  plainJpeg,
  postFrame,
  proxyFor,
  registerOk,
  TAGS,
  totalCameras,
  trackOwnRedisKey,
} from './_helpers-cam-p2';

test.afterAll(async () => {
  await cleanupAll();
});

type Logged = Awaited<ReturnType<typeof loginUser>>;

interface Rig {
  ward: Logged;
  guardian: Logged;
  camera: Camera;
}

let rig: Promise<Rig> | undefined;

async function build(): Promise<Rig> {
  const wardU = mkUser('WARD', 'E2E정지화면');
  const guardianU = mkUser('GUARDIAN', 'E2E정지보호자');
  connect(guardianU.id, wardU.id);
  const ward = await loginUser(wardU);
  const guardian = await loginUser(guardianU);
  const proxy = await proxyFor(ward.login);
  await needSlots(1);
  const camera = await registerOk(ward.api, '거실', undefined, proxy);
  expect((await createAiSession(proxy, camera.sessionId, camera.deviceId)).status(), '준비: AI 세션 생성(FE 프록시)').toBe(200);
  expect((await postFrame(proxy, camera.sessionId, await plainJpeg())).status(), '준비: 사진 한 장 보내기').toBe(200);
  return { ward, guardian, camera };
}

function getRig() {
  rig ??= build();
  return rig;
}

test.describe('카메라·이상감지 P2 - 정지 화면', () => {
  // 카메라를 한 번만 만들어 두 케이스가 나눠 쓴다. 병렬이면 워커마다 카메라를 따로 만든다
  test.describe.configure({ mode: 'serial' });

  test('CAM-N13 최근 한 장 받기(보호자)', TAGS, async () => {
    const r = await getRig();
    // 보호자 정지 화면도 이 임시 보호자 자신의 속도 제한 키(분·시간)를 만든다. 정확한 이름으로 정리 목록에 올린다
    for (const window of ['1m', '1h']) trackOwnRedisKey(`rate:camera-frame:${window}:${r.guardian.user.id}`);
    const res = await r.guardian.api.raw('GET', `/api/guardian/camera/${r.camera.sessionId}/latest-frame`);
    expect(res.status(), '보호자 정지 화면').toBe(200);
    expect(res.headers()['content-type'], 'content-type').toBe('image/jpeg');
    expect(res.headers()['cache-control'], 'Cache-Control').toBe('no-store');
    const body = await res.body();
    expect(body.length, '받은 바이트 수').toBeGreaterThan(1000);
    expect([...body.subarray(0, 3)], 'JPEG 시작 바이트(FF D8 FF)').toEqual([0xff, 0xd8, 0xff]);
  });

  test('CAM-A12 정지 화면 속도 제한: 분 30회, 31번째는 429', TAGS, async () => {
    test.setTimeout(240_000);
    const r = await getRig();
    // 이 임시 피보호자 자신의 속도 제한 키(분·시간)를 정확한 이름으로 정리 목록에 올린다
    for (const window of ['1m', '1h']) trackOwnRedisKey(`rate:camera-ward-frame:${window}:${r.ward.user.id}`);
    const url = `/api/ward/camera/${r.camera.id}/latest-frame`;

    const t0 = Date.now();
    for (let i = 1; i <= 30; i++) {
      const res = await r.ward.api.raw('GET', url);
      expect(res.status(), `${i}번째 호출`).toBe(200);
    }
    // 분당 창은 첫 호출 때 시작하는 60초 고정 창이다. 30번이 55초를 넘기면 창이 초기화되어 31번째가 200 이 될 수 있어 판정할 수 없다
    test.skip(Date.now() - t0 > 55_000, `30번 호출에 ${Math.round((Date.now() - t0) / 1000)}초가 걸려 1분 창이 지났을 수 있다 - 서버가 한가할 때 다시 돌린다`);
    const over = await r.ward.api.raw('GET', url);
    const elapsedSec = Math.round((Date.now() - t0) / 1000);
    expect(over.status(), `31번째 호출(1분 창 안, 경과 ${elapsedSec}초)`).toBe(429);
    const body = (await over.json()) as { code?: string; data?: { retryAfterSeconds?: number } };
    expect(body.code, '31번째 에러 코드').toBe('TOO_MANY_REQUESTS');
    const retryAfter = Number(over.headers()['retry-after']);
    expect(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After 는 1~60초 정수(실제 ${over.headers()['retry-after']})`).toBe(true);
    expect(body.data?.retryAfterSeconds, 'data.retryAfterSeconds 는 Retry-After 와 같다').toBe(retryAfter);

    // 다른 피보호자는 영향 없음(속도 제한 키는 호출한 사용자별)
    const other = await loginUser(mkUser('WARD', 'E2E정지다른'));
    trackOwnRedisKey(`rate:camera-ward-frame:1m:${other.user.id}`);
    trackOwnRedisKey(`rate:camera-ward-frame:1h:${other.user.id}`);
    // 카메라 자리가 남아 있으면 두 번째 임시 피보호자 자신의 카메라로 정지 화면이 정상(200)으로 오는지 본다(자리를 기다리지는 않는다)
    if (totalCameras() < 3) {
      const otherProxy = await proxyFor(other.login);
      const otherCam = await registerOk(other.api, '거실', undefined, otherProxy);
      expect((await createAiSession(otherProxy, otherCam.sessionId, otherCam.deviceId)).status(), '준비: 다른 피보호자 AI 세션').toBe(200);
      expect((await postFrame(otherProxy, otherCam.sessionId, await plainJpeg())).status(), '준비: 다른 피보호자 사진 한 장').toBe(200);
      const okRes = await other.api.raw('GET', `/api/ward/camera/${otherCam.id}/latest-frame`);
      expect(okRes.status(), '다른 피보호자는 자기 정지 화면을 정상으로 받는다(첫 사용자는 429 상태)').toBe(200);
      expect(okRes.headers()['content-type'], '다른 피보호자 content-type').toBe('image/jpeg');
    } else {
      const otherRes = await other.api.raw('GET', url);
      expect(otherRes.status(), '다른 피보호자의 호출(속도 제한과 무관, 남의 카메라라 403)').toBe(403);
      test.info().annotations.push({ type: '약하게 확인한 부분', description: `카메라 자리가 없어(서비스 전체 ${totalCameras()}대) 다른 피보호자의 정상 200 은 보지 못했다. 속도 제한이 소유 확인보다 먼저라 429 가 아닌 403 이 나온 것으로 키가 사용자별임만 확인했다` });
    }
  });
});
