/**
 * 최종 QA - 카메라·이상감지(CAM) P2 묶음 전용 도우미.
 *
 * - 사용자·카메라·AI 세션·Redis 키 정리는 P1b 도우미(cleanupAll)를 그대로 쓴다. 임시 사용자만 쓴다.
 * - DB 직접 접근은 임시 사용자 자신의 행만 읽거나 시드한다. 연결 해제·탈퇴는 실제 API 로 한다.
 * - 카메라 상한(서비스 전체 3대)은 공용 값이다. 카메라가 필요한 테스트는 자리가 날 때까지 기다리고, 끝내 없으면 이유를 남기고 건너뛴다.
 * - 비밀번호·토큰·전화번호는 메시지·annotation 에 찍지 않는다.
 */
import { test } from '../../../src/fixtures';
import type { Api } from '../../../src/api';
import { psqlRows, sqlStr } from '../../../src/remote';
import { totalCameras, waitForCameraSlots } from './_helpers-cam-p1b';

export * from './_helpers-cam-p1b';
export { pollIncident } from './_helpers-cam';

export const TAGS = { tag: ['@P2', '@CAM'] };

/** 카메라 자리가 need 개 날 때까지 기다린다. 끝내 없으면 이유를 남기고 이 테스트를 건너뛴다 */
export async function needSlots(need: number, minutes = 9) {
  const ok = await waitForCameraSlots(need, minutes * 60_000);
  test.skip(!ok, `카메라 상한 여유 없음(서비스 전체 ${totalCameras()}대 / 상한 3대, ${need}자리 필요) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다`);
}

/** 재촉·동수 안내는 밤(22~08시 KST)에는 아침으로 미룬다 */
export function isQuiet(hour: number): boolean {
  return hour >= 22 || hour < 8;
}

/** KST 기준 하루 중 몇 분째인지 */
export function kstMinuteOfDay(): number {
  const [h, m] = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Seoul', hour12: false, hour: '2-digit', minute: '2-digit' }).split(':').map(Number);
  return (h % 24) * 60 + m;
}

/** 이 임시 보호자-피보호자 쌍의 연결 번호(읽기만, 임시 사용자 자신의 행) */
export function activeConnectionId(guardianId: string, wardId: string): number {
  return Number(psqlRows(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1;`)[0][0]);
}

/** 임시 보호자가 실제 사용자 경로(보호자 연결 해제 API)로 자기 연결을 끊는다. 200 이 아니면 실패 */
export async function disconnectAsGuardian(api: Api, guardianId: string, wardId: string): Promise<void> {
  const res = await api.raw('DELETE', `/api/guardian/connection/disconnection/${activeConnectionId(guardianId, wardId)}`);
  if (res.status() !== 200) throw new Error(`보호자 연결 해제 API 가 ${res.status()} 를 돌려줬다`);
}

export function countRows(sql: string): number {
  return Number(psqlRows(sql)[0][0]);
}
