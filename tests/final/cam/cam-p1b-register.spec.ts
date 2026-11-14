/**
 * 최종 QA - 카메라·이상감지(CAM) P1b - 카메라 등록·수정·삭제·정지 화면
 *
 * 임시 사용자만 쓴다. 카메라를 만드는 케이스는 서비스 전체 상한(3대)이 공용 값이라 자리가 날 때까지 기다렸다 하고
 * (끝내 자리가 없으면 이유를 남기고 건너뜀), 만든 카메라는 케이스가 끝나면 바로 지운다(afterEach, 실패해도).
 * N09·A06 은 전체를 3대까지 채우는 케이스라 짧게 끝내고 바로 지운다. 실행 안내: 다른 영역과 동시에 돌리지 않는다.
 * 화면(UI) 단계는 AI 서버를 흉내 내거나(N02) 실제 AI 로 보낸다(A21 - 임시 계정 카메라, 사진은 가짜 카메라 영상).
 */
import { expect, test } from '../../../src/fixtures';
import { countBackendLog, psqlRows, sqlStr } from '../../../src/remote';
import { randomUUID } from 'node:crypto';
import {
  Camera,
  cleanupAll,
  createAiSession,
  deleteCamera,
  errOf,
  loginUser,
  mkUser,
  plainJpeg,
  postFrame,
  proxyFor,
  registerCameraRetry,
  registerOk,
  seedClip,
  seedIncident,
  sleep,
  startPump,
  stopAiSession,
  TAGS,
  totalCameras,
  trackCamera,
  tryRegister,
  waitForCameraSlots,
  waitUntil,
} from './_helpers-cam-p1b';

test.afterEach(async () => {
  await cleanupAll();
});

const ROOMS = ['거실', '침실', '주방', '화장실', '현관', '베란다', '작은방', '작은방2'];

interface CameraView {
  id: number;
  sessionId: string;
  deviceId: string;
  label: string;
  isActive: boolean;
  recommendedFps: number;
}
interface LiveView extends CameraView {
  status: string | null;
  lastFrameAt: string | null;
}

async function needSlots(n: number, minutes = 9) {
  const ok = await waitForCameraSlots(n, minutes * 60_000);
  test.skip(!ok, `카메라 상한 여유 없음(서비스 전체 ${totalCameras()}대 / 상한 3대, ${n}자리 필요) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다`);
}

const cameraRows = (wardId: string) =>
  psqlRows(`SELECT id, session_id, device_id, label, is_active FROM camera WHERE ward_id = ${sqlStr(wardId)} ORDER BY id;`).map(r => ({
    id: Number(r[0]),
    sessionId: r[1],
    deviceId: r[2],
    label: r[3],
    isActive: r[4] === 't',
  }));

/** 피보호자 화면에서 '이 기기를 카메라로 등록' -> 방 고르기 -> 촬영 방식까지 가서 '등록하고 촬영 시작' 버튼을 돌려준다 */
async function walkToStartButton(page: import('@playwright/test').Page, room: string) {
  await page.getByRole('button', { name: /이 기기를 카메라로 등록/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radiogroup', { name: '방 선택' }).getByRole('button', { name: room, exact: true }).click();
  await dialog.getByRole('button', { name: '다음', exact: true }).click();
  await dialog.getByRole('button', { name: '이렇게 놓았어요' }).click();
  await dialog.getByRole('radiogroup', { name: '촬영 방식' }).getByRole('radio').first().click();
  await dialog.getByRole('button', { name: '다음', exact: true }).click();
  const start = dialog.getByRole('button', { name: '등록하고 촬영 시작' });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  return { dialog, start };
}

test.describe('카메라·이상감지 P1b - 카메라 등록·관리', () => {
  test('CAM-N01 고를 수 있는 방 8개 조회', TAGS, async ({ openAs }) => {
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    const rooms = await w.api.get<{ label: string; registered: boolean }[]>('/api/ward/camera/rooms');
    expect(rooms.map(r => r.label), '방 8개(거실·침실·주방·화장실·현관·베란다·작은방·작은방2)와 순서').toEqual(ROOMS);
    expect(rooms.every(r => r.registered === false), '카메라가 없는 피보호자는 모든 방이 등록 안 됨').toBe(true);
    expect(await w.api.get<unknown[]>('/api/ward/camera'), '준비: 카메라 없음').toEqual([]);

    // 등록 화면은 이 목록에서만 고르게 된다: 방 선택 버튼이 정확히 8개, 같은 순서·같은 이름
    const page = await openAs({ label: 'n01-ward', login: w.login }, '/ward/camera');
    await page.getByRole('button', { name: /이 기기를 카메라로 등록/ }).first().click();
    const dialog = page.getByRole('dialog');
    const buttons = dialog.getByRole('radiogroup', { name: '방 선택' }).getByRole('button');
    await expect(buttons, '등록 화면의 방 선택 버튼').toHaveCount(8);
    await expect(buttons).toHaveText(ROOMS);
    expect(await w.api.get<unknown[]>('/api/ward/camera'), '방 선택만 봤을 뿐 카메라가 만들어지면 안 된다').toEqual([]);
  });

  test('CAM-A01 정해진 8개 밖의 방은 400', TAGS, async () => {
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    try {
      for (const label of ['서재', '방', 'living room', 'KITCHEN', '거실1', '작은방3', '작은 방', '안방']) {
        const r = await errOf(await w.api.raw('POST', '/api/ward/camera', { label }));
        expect(r.status, `label=${label} -> 실제 ${r.status} ${r.code ?? ''}`).toBe(400);
        expect(r.code, `label=${label} 에러 코드`).toBe('CAMERA_ROOM_INVALID');
      }
      // 기기 토큰이 있어도 같은 규칙
      const withDevice = await errOf(await w.api.raw('POST', '/api/ward/camera', { label: '서재', deviceId: 'dev_e2e_p1b_a01' }));
      expect(withDevice.status).toBe(400);
      expect(withDevice.code).toBe('CAMERA_ROOM_INVALID');
    } finally {
      // 거절돼야 하는 요청이 통과해 카메라가 생겼다면 남기지 않는다
      for (const c of await w.api.get<CameraView[]>('/api/ward/camera').catch(() => [] as CameraView[])) await deleteCamera(w.api, c.id);
    }
    expect(cameraRows(ward.id), '거절된 요청으로 카메라가 만들어지지 않았다').toEqual([]);
  });

  test('CAM-A02 방 이름 빈 값·공백·보이지 않는 문자·제어문자·31자', TAGS, async () => {
    test.setTimeout(720_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    const bad: [string, string][] = [
      ['빈 값', ''],
      ['공백만', '   '],
      ['탭만', '\t'],
      ['보이지 않는 문자(제로폭)만', '​​'],
      ['한글 채움 문자만', 'ㅤ'],
      ['제어문자 포함', '\u0007거실'],
      ['NUL 포함', '거실\u0000'],
      ['31자', '가'.repeat(31)],
    ];
    try {
      // 등록: 모두 400 INVALID_INPUT
      for (const [name, label] of bad) {
        const r = await errOf(await w.api.raw('POST', '/api/ward/camera', { label }));
        expect(r.status, `등록 ${name} -> 실제 ${r.status} ${r.code ?? ''}`).toBe(400);
        expect(r.code, `등록 ${name} 에러 코드`).toBe('INVALID_INPUT');
      }
      expect(cameraRows(ward.id), '거절된 등록으로 카메라가 생기지 않았다').toEqual([]);

      // 수정(PATCH): 같은 규칙으로 400, 방 이름은 그대로
      await needSlots(1);
      const cam = await registerOk(w.api, '거실');
      for (const [name, label] of bad) {
        const r = await errOf(await w.api.raw('PATCH', `/api/ward/camera/${cam.id}`, { label }));
        expect(r.status, `수정 ${name} -> 실제 ${r.status} ${r.code ?? ''}`).toBe(400);
        expect(r.code, `수정 ${name} 에러 코드`).toBe('INVALID_INPUT');
      }
      expect(cameraRows(ward.id).map(c => c.label), '거절된 수정 뒤에도 방 이름은 그대로(빈 값으로 수정 불가)').toEqual(['거실']);
      // 올바른 방으로는 수정된다(검증이 정상 값까지 막지 않는다)
      const ok = await w.api.raw('PATCH', `/api/ward/camera/${cam.id}`, { label: '침실' });
      expect(ok.status(), '정상 수정').toBe(200);
      expect(cameraRows(ward.id).map(c => c.label)).toEqual(['침실']);
    } finally {
      for (const c of await w.api.get<CameraView[]>('/api/ward/camera').catch(() => [] as CameraView[])) await deleteCamera(w.api, c.id);
    }
  });

  test('CAM-A04 같은 피보호자의 다른 기기가 쓰는 방은 409', TAGS, async () => {
    test.setTimeout(720_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    await needSlots(1);
    const a = await registerOk(w.api, '거실'); // 기기 A
    expect(a.deviceId, '기기 A 토큰').toBeTruthy();

    // 기기 B(토큰 없음 = 새 기기)가 같은 방을 등록하면 409 CAMERA_LABEL_DUPLICATED
    const b1 = await tryRegister(w.api, { label: '거실' });
    expect(b1.status, `기기 B(새 기기)가 사용 중인 방 -> 실제 ${b1.status} ${b1.code ?? ''}`).toBe(409);
    expect(b1.code).toBe('CAMERA_LABEL_DUPLICATED');
    // 내 것이 아닌 토큰을 들고 와도 새 기기로 취급되어 같은 결과
    const b2 = await tryRegister(w.api, { label: '거실', deviceId: 'dev_e2e_p1b_other' });
    expect(b2.status, `기기 B(모르는 토큰) -> 실제 ${b2.status} ${b2.code ?? ''}`).toBe(409);
    expect(b2.code).toBe('CAMERA_LABEL_DUPLICATED');
    expect(cameraRows(ward.id).length, '거절된 등록으로 카메라가 늘지 않았다').toBe(1);

    // 기기 A 를 사용 중지해도 방을 차지한다
    expect((await w.api.raw('PATCH', `/api/ward/camera/${a.id}`, { isActive: false })).status(), '기기 A 사용 중지').toBe(200);
    for (const body of [{ label: '거실' }, { label: '거실', deviceId: 'dev_e2e_p1b_other' }]) {
      const r = await tryRegister(w.api, body);
      expect(r.status, `사용 중지 상태의 방 -> 실제 ${r.status} ${r.code ?? ''}`).toBe(409);
      expect(r.code).toBe('CAMERA_LABEL_DUPLICATED');
    }
    const rooms = await w.api.get<{ label: string; registered: boolean }[]>('/api/ward/camera/rooms');
    expect(rooms.find(r => r.label === '거실')?.registered, '사용 중지 카메라의 방도 등록됨으로 보인다').toBe(true);
    expect(cameraRows(ward.id).length).toBe(1);
  });

  test('CAM-A06 동시에 등록해도 3대를 넘지 않는다', TAGS, async () => {
    test.setTimeout(900_000);
    // 서비스 전체가 2대인 상태를 만든다(다른 사용자 카메라 + 내가 채운 카메라)
    const ready = await waitUntil(() => totalCameras() <= 2, 9 * 60_000, 15_000);
    test.skip(!ready, `카메라 상한 여유 없음(서비스 전체 ${totalCameras()}대) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다`);
    const rooms = ['거실', '침실'];
    const filler = mkUser('WARD');
    const f = await loginUser(filler);
    let used = 0;
    while (totalCameras() < 2) {
      const r = await registerCameraRetry(f.api, { label: rooms[used++] }, 60_000);
      expect(r.status, `준비: 2대 채우기 ${r.status} ${r.code ?? ''}`).toBe(200);
    }
    const racers = await Promise.all(Array.from({ length: 5 }, async () => loginUser(mkUser('WARD'))));
    test.info().annotations.push({ type: '실행 안내', description: '서비스 전체 카메라 상한(3대)을 몇 초 동안 가득 채우는 케이스다. 다른 영역과 동시에 돌리지 않는다(그동안 다른 사용자의 카메라 등록이 잠깐 막힐 수 있다)' });
    const before = totalCameras();
    // 시작값 기준: 남은 자리는 3 - before. 다른 영역이 동시에 등록하면 이 값이 달라지므로 시작값을 기록해 둔다
    expect(before, '준비: 서비스 전체 2대 이하(다른 영역이 동시에 등록하면 이 값이 달라진다)').toBeLessThanOrEqual(2);
    const freeSlots = 3 - before;

    // 서로 다른 사용자 5명이 같은 순간에 등록
    const results = await Promise.all(racers.map(r => tryRegister(r.api, { label: '거실' })));
    for (const [i, r] of results.entries()) if (r.camera) trackCamera(racers[i].api, r.camera.id, r.camera.sessionId);
    const ok = results.filter(r => r.status === 200);
    const limited = results.filter(r => r.status === 409 && r.code === 'CAMERA_LIMIT_REACHED');
    test.info().annotations.push({ type: '결과', description: `성공 ${ok.length}건, 상한 409 ${limited.length}건, 그 밖 ${results.length - ok.length - limited.length}건, 등록 전 ${before}대 -> 등록 후 ${totalCameras()}대` });
    expect(ok.length, `남은 자리(${freeSlots}) 만큼만 성공해야 한다(실제 ${results.map(r => r.status).join(',')})`).toBe(freeSlots);
    expect(limited.length, `나머지 ${results.length - freeSlots}건은 409 CAMERA_LIMIT_REACHED`).toBe(results.length - freeSlots);
    expect(totalCameras(), '서비스 전체는 정확히 3대').toBe(3);
  });

  test('CAM-N02 방 선택 후 카메라 등록 성공', TAGS, async ({ openAs }) => {
    test.setTimeout(300_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    await needSlots(1);
    const page = await openAs({ label: 'n02-ward', login: w.login }, null);
    // AI 서버(FE 프록시) 호출은 흉내 낸다 - 이 케이스는 "방 선택 -> 등록 저장"을 본다
    await page.route('**/api/streams/**', route => {
      const url = route.request().url();
      if (/stream-sessions$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session_id: 'e2e_stub', status: 'running' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/ward/camera');
    const { start } = await walkToStartButton(page, '거실');
    const registered = page.waitForResponse(r => /\/api\/ward\/camera$/.test(r.url()) && r.request().method() === 'POST', { timeout: 120_000 });
    await start.click();
    const res = await registered;
    expect(res.status(), '등록 응답').toBe(200);
    const body = ((await res.json()) as { data: CameraView }).data;
    const mine = cameraRows(ward.id);
    if (mine[0]) trackCamera(w.api, mine[0].id, mine[0].sessionId);

    expect(body.label, '방 이름(한글 그대로)').toBe('거실');
    expect(body.isActive).toBe(true);
    expect(body.recommendedFps, '권장 fps(dev 서버 설정 15)').toBe(15);
    expect(body.sessionId, '세션 ID').toBeTruthy();
    expect(body.deviceId, '기기 ID').toBeTruthy();
    // DB 에 session_id·device_id·방 이름이 응답과 같게 저장
    expect(mine.length, '내 카메라 행 1개').toBe(1);
    expect(mine[0].sessionId).toBe(body.sessionId);
    expect(mine[0].deviceId).toBe(body.deviceId);
    expect(mine[0].label).toBe('거실');
    const hex = psqlRows(`SELECT encode(convert_to(label, 'UTF8'), 'hex') FROM camera WHERE id = ${mine[0].id};`)[0][0];
    expect(hex, '방 이름이 한글 그대로(UTF-8 거실)').toBe(Buffer.from('거실', 'utf8').toString('hex'));
    // 방 목록에서 그 방은 등록됨으로 바뀐다
    const rooms = await w.api.get<{ label: string; registered: boolean }[]>('/api/ward/camera/rooms');
    expect(rooms.find(r => r.label === '거실')?.registered).toBe(true);
    expect(rooms.filter(r => r.registered).length, '다른 방은 그대로').toBe(1);
  });

  test('CAM-N05 내 카메라 목록·연결 상태 조회', TAGS, async () => {
    test.setTimeout(420_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    // 카메라가 없으면 두 조회 모두 200 과 빈 목록
    expect(await w.api.get<unknown[]>('/api/ward/camera')).toEqual([]);
    expect(await w.api.get<unknown[]>('/api/ward/camera/live')).toEqual([]);

    await needSlots(1);
    const cam = await registerOk(w.api, '거실');
    const proxy = await proxyFor(w.login);
    trackCamera(w.api, cam.id, cam.sessionId, proxy);
    const list = await w.api.get<CameraView[]>('/api/ward/camera');
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ id: cam.id, sessionId: cam.sessionId, deviceId: cam.deviceId, label: '거실', isActive: true, recommendedFps: 15 });

    const live = async () => (await w.api.get<LiveView[]>('/api/ward/camera/live')).find(c => c.id === cam.id);
    // 송출 전: offline, 마지막 프레임 시각 없음. 같은 카메라 정보와 recommendedFps 가 함께 온다
    const first = await live();
    expect(first, 'live 에 내 카메라').toBeTruthy();
    expect(first).toMatchObject({ sessionId: cam.sessionId, deviceId: cam.deviceId, label: '거실', status: 'offline', lastFrameAt: null, recommendedFps: 15 });

    // 송출 중: running + 마지막 프레임 시각
    const jpeg = await plainJpeg();
    expect((await createAiSession(proxy, cam.sessionId, cam.deviceId)).status(), 'AI 세션 생성').toBe(200);
    const pump = startPump(proxy, cam.sessionId, jpeg, 400);
    await expect.poll(async () => (await live())?.status, { timeout: 40_000, intervals: [2_000], message: '송출 중인데 running 이 되지 않았다' }).toBe('running');
    expect((await live())?.lastFrameAt, '송출 중 마지막 프레임 시각').not.toBeNull();

    // 프레임이 10초 넘게 끊기면 disconnected
    await pump.stop();
    await expect.poll(async () => (await live())?.status, { timeout: 60_000, intervals: [2_000], message: '프레임을 끊었는데 disconnected 가 되지 않았다' }).toBe('disconnected');

    // 세션을 끝내면 offline
    await stopAiSession(proxy, cam.sessionId);
    await expect.poll(async () => (await live())?.status, { timeout: 40_000, intervals: [2_000], message: '세션을 끝냈는데 offline 이 되지 않았다' }).toBe('offline');
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: 'AI 서버 장애일 때 status null(확인 불가)이 오는 경로는 AI 서버를 내릴 수 없어 확인하지 못했다(P0 CAM-N18 이 화면 쪽만 응답 흉내로 확인)',
    });
  });

  test('CAM-N07 카메라 삭제 시 그 카메라 클립도 삭제', TAGS, async () => {
    test.setTimeout(420_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    await needSlots(1);
    const cam = await registerOk(w.api, '거실');
    const incidentId = seedIncident({ wardId: ward.id, sessionId: cam.sessionId, type: 'FIRE', lastAgoMin: 5 });
    // 클립 행만 DB 에 시드한다(서버 컨테이너 안에는 파일을 만들지 않는다). 파일 이름은 BE 가 받아들이는 UUID 형식이라
    // BE 가 삭제 단계에서 이 이름의 파일 삭제를 시도한다(파일이 없어도 오류 없이 지나간다)
    const fileName = `${randomUUID()}.webm`;
    const clipId = seedClip({ incidentId, wardId: ward.id, sessionId: cam.sessionId, fileName, sizeBytes: 8 });
    const clipRows = () => Number(psqlRows(`SELECT count(*) FROM anomaly_clip WHERE session_id = ${sqlStr(cam.sessionId)};`)[0][0]);
    expect(clipRows(), '준비: 클립 행').toBe(1);

    expect(await deleteCamera(w.api, cam.id), '카메라 삭제').toBe(200);
    expect(await w.api.get<unknown[]>('/api/ward/camera'), '삭제한 카메라는 목록에서 사라진다').toEqual([]);
    // 클립 정리는 커밋 뒤에 이어서 일어난다 - 행이 사라질 때까지 기다린다
    const gone = await waitUntil(() => clipRows() === 0, 60_000, 3_000);
    expect(gone, `카메라 삭제 뒤 클립 행 ${clipRows()}개(번호 ${clipId})`).toBe(true);
    // BE 로그: 카메라 삭제로 클립 정리가 돌았다(파일 삭제 단계 포함)
    const logged = await waitUntil(() => countBackendLog(`카메라 삭제로 클립 삭제: wardId=${ward.id}`, 300) >= 1, 30_000, 3_000);
    expect(logged, 'BE 로그에 "카메라 삭제로 클립 삭제" 가 남아야 한다').toBe(true);
    test.info().annotations.push({ type: '확인하지 못한 부분', description: '클립 파일 자체가 디스크에서 지워졌는지는 서버 컨테이너 안을 건드리지 않는 규칙 때문에 보지 않았다(행 삭제와 BE 로그까지 확인)' });
    // 이력(상황)은 남는다
    expect(psqlRows(`SELECT count(*) FROM anomaly_incident WHERE id = ${incidentId};`)[0][0], '상황 이력은 남는다').toBe('1');

    // 삭제된 방은 다시 등록할 수 있다
    const again = await registerCameraRetry(w.api, { label: '거실' });
    expect(again.status, `삭제한 방 다시 등록 -> 실제 ${again.status} ${again.code ?? ''}`).toBe(200);
    expect(again.camera?.sessionId, '새 카메라는 새 세션').not.toBe(cam.sessionId);
  });

  test('CAM-N08 같은 기기·같은 방 재등록은 통과', TAGS, async () => {
    test.setTimeout(720_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    await needSlots(1);
    test.info().annotations.push({ type: '실행 안내', description: '서비스 전체 카메라 상한(3대)을 잠깐 가득 채운다. 다른 영역과 동시에 돌리지 않는다(그동안 다른 사용자의 카메라 등록이 잠깐 막힐 수 있다)' });
    const mine = await registerOk(w.api, '거실');
    // 서비스 전체를 3대까지 채운다(다른 임시 사용자의 카메라로)
    let guard = 0;
    while (totalCameras() < 3 && guard++ < 3) {
      const other = await loginUser(mkUser('WARD'));
      const r = await registerCameraRetry(other.api, { label: '거실' }, 30_000);
      if (r.status !== 200) break;
    }
    expect(totalCameras(), '준비: 서비스 전체 3대 이상이 차 있다').toBeGreaterThanOrEqual(3);
    // 증거: 새 기기로 다른 빈 방을 등록하면 상한 409 (= 상한이 실제로 차 있다)
    const limit = await tryRegister(w.api, { label: '침실' });
    expect(limit.status, `준비 확인: 새 기기는 상한에 걸려야 한다 -> 실제 ${limit.status}`).toBe(409);
    expect(limit.code).toBe('CAMERA_LIMIT_REACHED');

    // 같은 기기·같은 방으로 다시 등록: 409 아님, 기존 카메라로 처리
    const total = totalCameras();
    const again = await tryRegister(w.api, { label: '거실', deviceId: mine.deviceId });
    expect(again.status, `같은 기기·같은 방 재등록 -> 실제 ${again.status} ${again.code ?? ''}`).toBe(200);
    expect(again.camera?.id, '같은 카메라 번호').toBe(mine.id);
    expect(again.camera?.sessionId, '같은 세션').toBe(mine.sessionId);
    expect(again.camera?.deviceId, '같은 기기 토큰').toBe(mine.deviceId);
    expect(again.camera?.label).toBe('거실');
    expect(cameraRows(ward.id).length, '내 카메라는 1대 그대로').toBe(1);
    expect(totalCameras(), '서비스 전체 대수도 그대로').toBe(total);
  });

  test('CAM-N09 전체 3대까지 등록되고 삭제 뒤 다시 등록 가능', TAGS, async () => {
    test.setTimeout(900_000);
    // 서비스 전체에는 실사용자 카메라 2대가 계속 있어(상한 3대) 3대를 모두 내가 채울 수 없다. 남은 자리만큼 채운다
    await needSlots(1);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    const rooms = ['거실', '침실', '주방'];
    const mine: Camera[] = [];
    test.info().annotations.push({ type: '실행 안내', description: '서비스 전체 카메라 상한(3대)을 잠깐 가득 채운다. 다른 영역과 동시에 돌리지 않는다(그동안 다른 사용자의 카메라 등록이 잠깐 막힐 수 있다)' });
    const othersAtStart = totalCameras();
    while (totalCameras() < 3 && mine.length < 3) {
      const r = await registerCameraRetry(w.api, { label: rooms[mine.length] }, 30_000);
      // 다른 영역이 동시에 자리를 채웠다면 거기서 멈춘다
      if (r.status === 409 && r.code === 'CAMERA_LIMIT_REACHED') break;
      expect(r.status, `${mine.length + 1}번째 등록 -> 실제 ${r.status} ${r.code ?? ''}`).toBe(200);
      mine.push(r.camera!);
    }
    test.skip(mine.length === 0, '준비: 내가 등록할 자리가 없다(다른 영역이 자리를 채웠다)');
    test.info().annotations.push({ type: '준비', description: `시작 전 서비스 전체 ${othersAtStart}대, 내가 등록한 ${mine.length}대(서로 다른 기기 토큰)` });
    expect(totalCameras(), '3대째까지 등록됨').toBe(3);
    expect(new Set(mine.map(c => c.deviceId)).size, '서로 다른 기기').toBe(mine.length);

    // 4번째는 상한 409
    const over = await tryRegister(w.api, { label: '현관' });
    expect(over.status, `상한 초과 -> 실제 ${over.status}`).toBe(409);
    expect(over.code).toBe('CAMERA_LIMIT_REACHED');

    // 1대 삭제하면 새 기기로 등록된다(상한은 새 등록에서만 검사)
    expect(await deleteCamera(w.api, mine[0].id), '1대 삭제').toBe(200);
    const fresh = await registerCameraRetry(w.api, { label: '현관' }, 120_000);
    expect(fresh.status, `삭제 뒤 새 기기 등록 -> 실제 ${fresh.status} ${fresh.code ?? ''}`).toBe(200);
    expect(fresh.camera?.deviceId, '새 기기 토큰').not.toBe(mine[0].deviceId);
    expect(totalCameras(), '다시 3대').toBe(3);
  });

  test('CAM-N10 본인 카메라 마지막 정지 화면 보기', TAGS, async ({ openAs }) => {
    test.setTimeout(420_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    await needSlots(1);
    const cam = await registerOk(w.api, '거실');
    const proxy = await proxyFor(w.login);
    trackCamera(w.api, cam.id, cam.sessionId, proxy);
    const url = `/api/ward/camera/${cam.id}/latest-frame`;

    // 아직 받은 장면이 없으면 404 CAMERA_NOT_STREAMING
    const none = await errOf(await w.api.raw('GET', url));
    expect(none.status, `장면 없음 -> 실제 ${none.status} ${none.code ?? ''}`).toBe(404);
    expect(none.code).toBe('CAMERA_NOT_STREAMING');

    // 장면을 보내면 마지막 프레임 1장(JPEG)
    const jpeg = await plainJpeg();
    expect((await createAiSession(proxy, cam.sessionId, cam.deviceId)).status(), 'AI 세션 생성').toBe(200);
    for (let i = 0; i < 3; i++) expect((await postFrame(proxy, cam.sessionId, jpeg)).status(), `프레임 ${i + 1}`).toBe(200);
    let frameStatus = 0;
    await expect
      .poll(async () => (frameStatus = (await w.api.raw('GET', url)).status()), { timeout: 30_000, intervals: [1_000], message: '프레임을 보냈는데 정지 화면이 200 이 되지 않았다' })
      .toBe(200);
    const res = await w.api.raw('GET', url);
    expect(res.headers()['content-type'] ?? '', '정지 화면은 이미지').toMatch(/^image\/jpeg/);
    const bytes = await res.body();
    expect(bytes.length, '정지 화면 크기').toBeGreaterThan(1000);
    expect([bytes[0], bytes[1]], 'JPEG 시작 표식').toEqual([0xff, 0xd8]);

    // 실시간 영상은 보호자 전용: 피보호자는 보호자 카메라 API 를 쓸 수 없다
    const guardianLive = await errOf(await w.api.raw('GET', '/api/guardian/camera/live'));
    expect(guardianLive.status, '피보호자가 보호자 실시간 목록 호출').toBe(403);

    // 화면: 다른 기기의 카메라 카드의 '찍히는 장면 보기' 로 정지 화면이 보인다(이 브라우저는 그 카메라의 기기가 아니다)
    const page = await openAs({ label: 'n10-ward', login: w.login }, '/ward/camera');
    await page.getByRole('button', { name: '찍히는 장면 보기' }).click();
    const dialog = page.getByRole('dialog', { name: '거실 카메라' });
    await expect(dialog).toBeVisible();
    const img = dialog.getByRole('img', { name: '거실 카메라가 찍는 장면' });
    await expect(img, '정지 화면 이미지').toBeVisible({ timeout: 20_000 });
    expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth), '이미지가 실제로 그려졌다').toBeGreaterThan(0);
  });

  test('CAM-A21 화면 송출 실패·중복 시작 처리', TAGS, async ({ openAs }) => {
    test.setTimeout(600_000);
    const ward = mkUser('WARD');
    const w = await loginUser(ward);
    await needSlots(1);
    const page = await openAs({ label: 'a21-ward', login: w.login }, null);

    // 실제 AI 로 보내되 요청 수를 센다. 프레임 업로드는 켜고 끌 수 있게 가로챈다
    const proxy = await proxyFor(w.login);
    // 등록 응답을 받는 즉시 정리 목록에 올린다(이후 단계가 실패해도 AI 세션과 카메라가 남지 않게)
    const tracked = new Set<number>();
    page.on('response', res => {
      if (res.request().method() !== 'POST' || !/\/api\/ward\/camera$/.test(res.url()) || res.status() !== 200) return;
      res
        .json()
        .then((j: { data?: CameraView }) => {
          if (j.data && !tracked.has(j.data.id)) {
            tracked.add(j.data.id);
            trackCamera(w.api, j.data.id, j.data.sessionId, proxy);
          }
        })
        .catch(() => undefined);
    });
    const counts = { register: 0, session: 0, frames: 0, stops: 0 };
    let failFrames = false;
    page.on('request', r => {
      if (r.method() !== 'POST') return;
      if (/\/api\/ward\/camera$/.test(r.url())) counts.register++;
      else if (/\/api\/streams\/v1\/stream-sessions$/.test(r.url())) counts.session++;
      else if (/\/stream-sessions\/[^/]+\/stop$/.test(r.url())) counts.stops++;
    });
    await page.route(/\/api\/streams\/v1\/stream-sessions\/[^/]+\/frame$/, route => {
      counts.frames++;
      return failFrames ? route.abort('failed') : route.continue();
    });
    await page.goto('/ward/camera');
    const { start } = await walkToStartButton(page, '거실');

    // 1) 송출 시작 버튼 연타: 등록·세션 생성은 1번씩만
    const box = await start.boundingBox();
    expect(box, '시작 버튼 위치').toBeTruthy();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    for (let i = 0; i < 6; i++) {
      await page.mouse.click(x, y);
      await sleep(40);
    }
    await expect.poll(() => counts.session, { timeout: 60_000, message: '송출(AI 세션 생성) 요청이 나가야 한다' }).toBeGreaterThanOrEqual(1);
    // 연타로 나간 요청이 더 늘지 않을 때까지(3초 동안 요청 수가 그대로) 기다린다
    let stable = { reg: -1, ses: -1, since: Date.now() };
    await waitUntil(
      () => {
        if (stable.reg !== counts.register || stable.ses !== counts.session) stable = { reg: counts.register, ses: counts.session, since: Date.now() };
        return Date.now() - stable.since >= 3_000;
      },
      30_000,
      500,
    );
    const cams = cameraRows(ward.id);
    expect(counts.register, `연타(6번) 뒤 등록 요청 수`).toBe(1);
    expect(counts.session, `연타(6번) 뒤 세션 생성 요청 수`).toBe(1);
    expect(cams.length, '카메라는 1대만 만들어졌다').toBe(1);
    const live = async () => (await w.api.get<LiveView[]>('/api/ward/camera/live')).find(c => c.id === cams[0].id)?.status;
    await expect.poll(live, { timeout: 60_000, intervals: [2_000], message: '송출이 시작돼 running 이 되어야 한다' }).toBe('running');

    // 2) 프레임 업로드가 계속 실패하면: 10초 넘으면 '연결이 불안정해요', 30초 넘으면 '다시 연결 중입니다'
    failFrames = true;
    await expect(page.getByText('연결이 불안정해요').first(), '업로드 실패 10초 뒤 안내').toBeVisible({ timeout: 40_000 });
    await expect(page.getByText('다시 연결 중입니다').first(), '업로드 실패 30초 뒤 큰 안내').toBeVisible({ timeout: 60_000 });
    failFrames = false;
    await expect(page.getByText('다시 연결 중입니다'), '업로드가 돌아오면 안내가 사라진다').toHaveCount(0, { timeout: 60_000 });
    await expect.poll(live, { timeout: 60_000, intervals: [2_000], message: '업로드가 돌아오면 다시 running' }).toBe('running');

    // 3) 화면을 떠나면 송출 세션이 끝나야 한다(AI 세션 종료 = 연결 상태 offline)
    const stopsBefore = counts.stops;
    await page.goto('about:blank');
    let last: string | null | undefined;
    const ended = await waitUntil(async () => (last = await live()) === 'offline', 45_000, 3_000);
    test.info().annotations.push({
      type: '화면 이탈 뒤 상태',
      description: `마지막 관찰 상태 ${last}, 이탈 전 stop 요청 ${stopsBefore}번(이탈 뒤에는 브라우저가 닫혀 세지 못함)`,
    });
    test.info().annotations.push({ type: '진짜 버그(FE)', description: '배포 FE 는 화면 이탈(탭 닫기·다른 주소 이동) 때 송출 세션 stop 을 보내지 않는다. 이 단언은 약하게 바꾸지 않고 그대로 둔다(실패 = 버그 유지)' });
    expect(ended, `화면을 떠난 뒤 45초가 지나도 송출 세션이 끝나지 않았다(상태 ${last}). 배포 FE 는 화면 이탈 때 stop 을 부르지 않고 AI 가 10초 뒤 disconnected 로만 표시한다`).toBe(true);
  });
});
