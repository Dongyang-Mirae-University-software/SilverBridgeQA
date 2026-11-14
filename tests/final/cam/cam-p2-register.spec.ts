/**
 * 최종 QA - 카메라·이상감지(CAM) P2 - 카메라 등록·방 이름 수정
 *
 * 임시 사용자만 쓴다. 카메라를 만드는 케이스는 서비스 전체 상한(3대)이 공용 값이라 자리가 날 때까지 기다렸다 하고
 * (끝내 자리가 없으면 이유를 남기고 건너뜀), 만든 카메라는 케이스가 끝나면 바로 지운다(afterEach, 실패해도).
 * 환경변수를 바꿔야 하는 A07 은 서버 설정 변경 금지라 fixme 로 둔다.
 */
import { expect, test } from '../../../src/fixtures';
import {
  Camera,
  cleanupAll,
  errOf,
  loginUser,
  mkUser,
  needSlots,
  registerCameraRetry,
  registerOk,
  TAGS,
  totalCameras,
} from './_helpers-cam-p2';
import type { Api } from '../../../src/api';

test.afterEach(async () => {
  await cleanupAll();
});

interface CameraView extends Camera {
  isActive: boolean;
}

async function patchCamera(api: Api, id: number, body: Record<string, unknown>) {
  const res = await api.raw('PATCH', `/api/ward/camera/${id}`, body);
  const text = await res.text();
  const json = (text.startsWith('{') ? JSON.parse(text) : {}) as { code?: string; message?: string; data?: CameraView };
  return { status: res.status(), code: json.code, message: json.message, data: json.data };
}

const myCameras = (api: Api) => api.get<CameraView[]>('/api/ward/camera');

test.describe('카메라·이상감지 P2 - 카메라 등록·수정', () => {
  test('CAM-N06 방 이름 수정', TAGS, async () => {
    test.setTimeout(1_300_000); // 자리 대기(최대 9분) + 등록 재시도(최대 10분)
    const ward = mkUser('WARD', 'E2E방수정');
    const w = await loginUser(ward);
    await needSlots(1);
    const cam = await registerOk(w.api, '거실');
    expect(cam.label, '준비: 거실로 등록').toBe('거실');

    // 비어 있는 다른 방(침실)으로 변경: 200, 새 방 이름 저장. 같은 기기(id·sessionId·deviceId)는 그대로
    const moved = await patchCamera(w.api, cam.id, { label: '침실' });
    expect(moved.status, `방 변경 실제 ${moved.status} ${moved.code ?? ''}`).toBe(200);
    expect(moved.data?.label, '응답의 새 방 이름').toBe('침실');
    expect(moved.data?.id, '같은 카메라').toBe(cam.id);
    expect(moved.data?.sessionId, 'sessionId 는 그대로').toBe(cam.sessionId);
    expect(moved.data?.deviceId, 'deviceId 는 그대로').toBe(cam.deviceId);
    const after = await myCameras(w.api);
    expect(after.map(c => ({ id: c.id, label: c.label })), '저장된 내 카메라: 한 대, 방은 침실').toEqual([{ id: cam.id, label: '침실' }]);
    const rooms = await w.api.get<{ label: string; registered: boolean }[]>('/api/ward/camera/rooms');
    expect(rooms.find(r => r.label === '침실')?.registered, '침실은 이제 등록됨').toBe(true);
    expect(rooms.find(r => r.label === '거실')?.registered, '거실은 비게 됨').toBe(false);

    // 같은 방으로 다시 수정해도 그대로 성공(멱등)
    const same = await patchCamera(w.api, cam.id, { label: '침실' });
    expect(same.status, '같은 방으로 수정').toBe(200);

    // 옛 이슈 ANOM-G12(고쳐짐): 방 이름을 빈 값·공백으로 수정할 수 없다. 거절돼도 방은 그대로다
    for (const [name, label] of [['빈 값', ''], ['공백만', '   ']] as const) {
      const bad = await patchCamera(w.api, cam.id, { label });
      expect(bad.status, `${name} 수정 실제 ${bad.status} ${bad.code ?? ''}`).toBe(400);
      expect(bad.code, `${name} 에러 코드`).toBe('INVALID_INPUT');
    }
    expect((await myCameras(w.api))[0].label, '거절된 수정 뒤에도 방은 침실').toBe('침실');

    // 같은 기기 방 변경은 상한 검사 대상이 아니다(코드: update 는 전체 상한을 보지 않는다). 지금 서비스 전체 대수를 남긴다
    test.info().annotations.push({
      type: '상한',
      description: `방 변경 시점의 서비스 전체 카메라 ${totalCameras()}대 / 상한 3대. 3대로 가득 찬 상태에서도 변경이 성공하는지는 다른 사용자 카메라 때문에 만들 수 없어 코드(CameraService.update 에 상한 검사 없음)로 확인했다`,
    });
  });

  test('CAM-A03 기기 토큰 65자 초과는 거절, 64자는 통과', TAGS, async () => {
    test.setTimeout(1_300_000); // 자리 대기(최대 9분) + 등록 재시도(최대 10분)
    const ward = mkUser('WARD', 'E2E기기토큰');
    const w = await loginUser(ward);
    const over = 'd'.repeat(65);
    const edge = 'e'.repeat(64);

    // 65자: 400 INVALID_INPUT(최대 64자). 카메라는 만들어지지 않는다
    const r65 = await errOf(await w.api.raw('POST', '/api/ward/camera', { label: '거실', deviceId: over }));
    expect(r65.status, `65자 등록 실제 ${r65.status} ${r65.code ?? ''}`).toBe(400);
    expect(r65.code, '65자 에러 코드').toBe('INVALID_INPUT');
    expect(r65.message, '65자 안내 문구').toContain('기기 토큰');
    expect(await myCameras(w.api), '거절된 요청으로 카메라가 만들어지지 않았다').toEqual([]);

    // 64자: 통과. 내 기기 토큰이 아니므로 값은 무시되고 서버가 새 기기 토큰을 발급한다(문서: 본인 소유가 아니면 신규 발급)
    await needSlots(1);
    const r64 = await registerCameraRetry(w.api, { label: '거실', deviceId: edge });
    expect(r64.status, `64자 등록 실제 ${r64.status} ${r64.code ?? ''}`).toBe(200);
    expect(r64.camera?.label).toBe('거실');
    expect(r64.camera?.deviceId, '내 소유가 아닌 기기 토큰은 쓰지 않고 새로 발급').not.toBe(edge);
    expect((await myCameras(w.api)).length, '카메라 한 대').toBe(1);
  });

  test('CAM-A08 기기 번호 없이 카메라를 여러 개 등록할 수 있는지(보류 항목: 현재 동작 기록)', TAGS, async () => {
    const ward = mkUser('WARD', 'E2E기기없음');
    const w = await loginUser(ward);
    test.setTimeout(1_300_000); // 자리 대기(최대 9분) + 두 번째 등록 재시도(최대 10분)
    // 핵심 확인이 두 번째 등록이라 처음부터 두 자리를 기다린다(자리가 끝내 없으면 이유를 남기고 건너뜀, 통과로 두지 않는다)
    await needSlots(2);

    // 기기 번호 없이 거실로 등록
    const first = await registerOk(w.api, '거실');
    // 같은 방을 기기 번호 없이 다시 등록: 같은 기기로 합쳐지지 않고(멱등 아님) 방 중복 409 CAMERA_LABEL_DUPLICATED
    const dup = await errOf(await w.api.raw('POST', '/api/ward/camera', { label: '거실' }));
    expect(dup.status, `같은 방 재등록 실제 ${dup.status} ${dup.code ?? ''}`).toBe(409);
    expect(dup.code, '같은 방 재등록 에러 코드').toBe('CAMERA_LABEL_DUPLICATED');
    expect((await myCameras(w.api)).map(c => c.id), '카메라는 한 대 그대로').toEqual([first.id]);

    // 다른 방으로 기기 번호 없이 등록: 현재 동작은 별개 카메라로 하나 더 만들어진다(ANOM-G13 보류: 같은 사용자가 여러 대 가능).
    const second = await registerCameraRetry(w.api, { label: '침실' });
    expect(second.status, `다른 방 등록 실제 ${second.status} ${second.code ?? ''}`).toBe(200);
    expect(second.camera?.id, '새 카메라').not.toBe(first.id);
    expect(second.camera?.sessionId, '새 sessionId').not.toBe(first.sessionId);
    expect(second.camera?.deviceId, '새 deviceId').not.toBe(first.deviceId);
    expect((await myCameras(w.api)).length, '같은 사용자의 카메라가 두 대').toBe(2);
    test.info().annotations.push({ type: '현재 동작(ANOM-G13 보류)', description: `기기 번호 없이 다른 방으로 등록하면 별개 카메라가 계속 만들어진다(서비스 전체 상한 3대가 유일한 제한, 등록 뒤 전체 ${totalCameras()}대). 기획 확인 필요: 한 사용자가 여러 대를 가질 수 있는지` });
  });

  test.fixme('CAM-A07 CAMERA_MAX_TOTAL 0 이하이면 상한이 꺼진다', TAGS, async () => {
    // 백엔드 환경변수 CAMERA_MAX_TOTAL=0 으로 재기동해야 한다(서버 설정·컨테이너 변경 금지, 공유 dev 서버).
    // 확인할 내용: 상한 검사 없이 4대 이상 모두 등록 성공(코드: CameraService.ensureTotalLimit 이 maxTotal <= 0 이면 바로 반환).
    // 상한을 일부러 넘겨 다른 사용자의 카메라 등록 자리도 막지 않는다. 검증용 환경에서 수동 확인.
  });
});
