/**
 * 최종 QA - 카메라·이상감지(CAM) P2 - 보호자 판정 보류 항목(연결 해제 뒤 응답, 오탐 뒤 새 감지)
 *
 * A32 는 DB 에 상황을 시드하고(임시 피보호자 자신의 행만) API 로 응답한다. 카메라·문자 없음.
 * A33 은 실제 화재 사진을 보내 상황을 만들므로 카메라 1대(서비스 전체 상한 3대 중 1자리)를 쓰고 끝나면 바로 지운다.
 *   문자 대체 발송은 임시 사용자 자신의 상한 키로 막는다(suppressAnomalySmsFallback). 약 7분 걸린다(클립 쿨다운 5분).
 * 두 케이스 모두 "보류" 항목이라 현재 배포 코드의 동작을 한 값으로 고정하고, 문서와의 차이를 annotation 에 남긴다.
 */
import { expect, test } from '../../../src/fixtures';
import { psqlRows, sqlStr } from '../../../src/remote';
import type { Api } from '../../../src/api';
import {
  cleanupAll,
  connect,
  countRows,
  disconnectAsGuardian,
  errOf,
  feedback,
  fireJpeg,
  incidentIdsOfWard,
  incidentRow,
  kstMinuteOfDay,
  loginUser,
  mkUser,
  needSlots,
  pollIncident,
  proxyFor,
  seedIncident,
  fakeSession,
  setupStreamingCamera,
  startPump,
  suppressAnomalySmsFallback,
  TAGS,
} from './_helpers-cam-p2';

test.afterEach(async () => {
  await cleanupAll();
});

const clipRows = (incidentId: number) =>
  psqlRows(`SELECT id, status FROM anomaly_clip WHERE incident_id = ${incidentId} ORDER BY id;`).map(r => ({ id: Number(r[0]), status: r[1] }));

async function guardianClipIds(api: Api, incidentId: number): Promise<number[]> {
  const res = await api.raw('GET', `/api/guardian/anomaly/${incidentId}/clips`);
  expect(res.status(), '보호자 클립 목록').toBe(200);
  const json = (await res.json()) as { data?: { clipId: number }[] };
  return (json.data ?? []).map(c => c.clipId);
}

test.describe('카메라·이상감지 P2 - 보호자 판정 보류 항목', () => {
  test('CAM-A32 연결을 끊은 보호자의 응답이 판정에 반영되는지(보류 항목: 현재 동작 기록)', TAGS, async () => {
    const wardU = mkUser('WARD', 'E2E판정본인');
    const [aU, bU] = [mkUser('GUARDIAN', 'E2E판정A'), mkUser('GUARDIAN', 'E2E판정B')];
    connect(aU.id, wardU.id);
    connect(bU.id, wardU.id);
    const [a, b] = [await loginUser(aU), await loginUser(bU)];
    // 카메라가 없는 가짜 세션의 상황이다(응답·판정에는 카메라가 필요 없다). 마지막 감지 1분 전이라 재질문 스케줄러 대상도 아니다
    const incident = seedIncident({ wardId: wardU.id, sessionId: fakeSession(), lastAgoMin: 1 });

    // B 가 오탐으로 답하고(0:1 -> FALSE_ALARM), A 가 실제 위험으로 답해 1:1 동수가 된다
    const rb = await feedback(b.api, incident, 'FALSE_ALARM');
    expect(rb.status, 'B 응답').toBe(200);
    expect(rb.json.data?.reviewStatus, 'B 만 답한 상태').toBe('FALSE_ALARM');
    const ra = await feedback(a.api, incident, 'REAL');
    expect(ra.status, 'A 응답').toBe(200);
    expect(ra.json.data?.reviewStatus, '1:1 동수').toBe('CONFLICTED');

    // B 가 연결을 해제한다. B 는 더 이상 이 피보호자의 상황에 답할 수 없지만, 이미 낸 응답 기록은 남는다
    await disconnectAsGuardian(b.api, bU.id, wardU.id);
    const blocked = await errOf(await b.api.raw('POST', `/api/guardian/anomaly/${incident}/feedback`, { verdict: 'FALSE_ALARM' }));
    expect(blocked.status, `연결 해제 뒤 B 의 응답 실제 ${blocked.status} ${blocked.code ?? ''}`).toBe(403);
    expect(blocked.code, '연결 해제 뒤 B 의 응답 에러 코드').toBe('ANOMALY_NOT_AUTHORIZED');
    expect(countRows(`SELECT count(*) FROM anomaly_incident_feedback WHERE incident_id = ${incident} AND guardian_id = ${sqlStr(bU.id)};`), '해제된 B 의 응답 기록은 지워지지 않는다').toBe(1);

    // 판정 재집계: A 가 같은 답을 다시 보내면(번복 경로) 해제된 B 의 응답이 아직 세어져 계속 1:1 동수다(현재 동작)
    const again = await feedback(a.api, incident, 'REAL');
    expect(again.status, 'A 재응답').toBe(200);
    expect(again.json.data?.reviewStatus, '해제된 B 의 응답이 계속 반영되어 동수 그대로').toBe('CONFLICTED');
    expect(incidentRow(incident)?.review, '저장된 판정 상태').toBe('CONFLICTED');
    test.info().annotations.push({
      type: '현재 동작(ANOM-G05 보류)',
      description: '연결을 해제한 보호자의 응답이 재집계에서 빠지지 않는다(GuardianAnomalyService.submitFeedback 은 다른 응답을 연결 상태와 상관없이 모두 센다). 문서에는 이 경우의 기대 동작이 없다. 코드 값으로 고정했고 기대 동작은 제품 결정이 필요하다. 연결 해제는 임시 보호자 B 의 실제 해제 API 로 했다. 탈퇴 경로는 다음 케이스(CAM-A32 탈퇴)에서 따로 본다',
    });
  });

  test('CAM-A32 탈퇴한 보호자의 응답이 판정에 반영되는지(보류 항목: 현재 동작 기록)', TAGS, async () => {
    const wardU = mkUser('WARD', 'E2E탈퇴본인');
    const [aU, bU] = [mkUser('GUARDIAN', 'E2E탈퇴A'), mkUser('GUARDIAN', 'E2E탈퇴B')];
    connect(aU.id, wardU.id);
    connect(bU.id, wardU.id);
    const [a, b] = [await loginUser(aU), await loginUser(bU)];
    const incident = seedIncident({ wardId: wardU.id, sessionId: fakeSession(), lastAgoMin: 1 });

    expect((await feedback(b.api, incident, 'FALSE_ALARM')).status, 'B 응답').toBe(200);
    expect((await feedback(a.api, incident, 'REAL')).json.data?.reviewStatus, '1:1 동수').toBe('CONFLICTED');

    // B 가 제품의 회원 탈퇴 API 로 탈퇴한다(임시 보호자 자신의 계정)
    const withdraw = await b.api.raw('DELETE', '/api/user/me', { password: bU.password });
    expect(withdraw.status(), '준비: 임시 보호자 B 탈퇴').toBe(200);
    const bRows = countRows(`SELECT count(*) FROM anomaly_incident_feedback WHERE incident_id = ${incident} AND guardian_id = ${sqlStr(bU.id)};`);

    // A 가 같은 답을 다시 보내 재집계한다
    const again = await feedback(a.api, incident, 'REAL');
    expect(again.status, 'A 재응답').toBe(200);
    const review = again.json.data?.reviewStatus;
    // 현재 동작 고정: 탈퇴하면 B 의 응답 기록이 함께 사라지고 A 의 답만 남아 실제 위험(REAL)이 된다
    expect(bRows, '탈퇴한 B 의 응답 기록').toBe(0);
    expect(review, '재집계 결과(B 응답이 사라져 A 의 REAL 만 남음)').toBe('REAL');
    expect(incidentRow(incident)?.review, '저장된 판정 상태').toBe('REAL');
    test.info().annotations.push({
      type: '현재 동작(ANOM-G05 보류)',
      description: '탈퇴한 보호자의 응답 기록은 함께 지워지고 재집계에서도 빠진다(연결만 해제한 경우와 다름). 기획 확인 필요: 연결 해제와 탈퇴의 판정 처리가 달라도 되는지',
    });
  });

  test('CAM-A33 오탐 판정 뒤 같은 상황의 새 감지(보류 항목: 현재 동작 기록)', TAGS, async () => {
    test.setTimeout(1_000_000);
    const minute = kstMinuteOfDay();
    test.skip(minute >= 23 * 60 + 40 || minute < 5, `KST 자정 직전(현재 ${Math.floor(minute / 60)}시 ${minute % 60}분)에는 상황이 자정에서 끊겨 이 케이스를 볼 수 없다`);
    await needSlots(1);
    const wardU = mkUser('WARD', 'E2E오탐본인');
    const gU = mkUser('GUARDIAN', 'E2E오탐보호자');
    connect(gU.id, wardU.id);
    suppressAnomalySmsFallback(wardU.id);
    const w = await loginUser(wardU);
    const g = await loginUser(gU);
    const proxy = await proxyFor(w.login);
    const jpeg = fireJpeg();
    const camera = await setupStreamingCamera(w.api, proxy, jpeg, '거실');
    startPump(proxy, camera.sessionId, jpeg, 250);

    // 1) 화재 상황과 첫 클립이 생길 때까지
    const found = await pollIncident(g.api, wardU.id, '거실', 'FIRE', 120_000);
    expect(found, '화재 사진을 보냈지만 120초 안에 이상감지 상황이 생기지 않았다').toBeDefined();
    const id = found!.incidentId;
    await expect.poll(() => clipRows(id).length, { timeout: 90_000, intervals: [2_000], message: '첫 클립이 90초 안에 저장되지 않았다' }).toBeGreaterThanOrEqual(1);
    const firstClip = clipRows(id)[0].id;

    // 2) 오탐 판정: 상황은 FALSE_ALARM, 지금까지 저장된 클립은 비공개
    const fa = await feedback(g.api, id, 'FALSE_ALARM');
    expect(fa.status, '오탐 응답').toBe(200);
    expect(fa.json.data?.reviewStatus, '오탐 판정').toBe('FALSE_ALARM');
    expect(clipRows(id).find(c => c.id === firstClip)?.status, '오탐 확정 때 첫 클립은 비공개').toBe('HIDDEN');
    const countAtFalseAlarm = incidentRow(id)!.eventCount;

    // 3) 같은 카메라·종류의 새 감지(1분 간격 이력): 새 상황이 열리지 않고 같은 상황에 합쳐져 판정은 오탐 그대로다(현재 동작)
    await expect
      .poll(() => incidentRow(id)?.eventCount ?? 0, { timeout: 180_000, intervals: [5_000], message: '오탐 뒤 새 감지가 3분 안에 상황에 더해지지 않았다' })
      .toBeGreaterThan(countAtFalseAlarm);
    expect(incidentIdsOfWard(wardU.id), '새 상황이 따로 열리지 않고 한 건 그대로').toEqual([id]);
    expect(incidentRow(id)?.review, '새 감지가 들어와도 판정은 오탐 그대로').toBe('FALSE_ALARM');

    // 4) 새로 저장된 클립(클립 쿨다운 5분 뒤)은 공개로 태어난다
    await expect
      .poll(() => clipRows(id).length, { timeout: 480_000, intervals: [10_000], message: '오탐 뒤 두 번째 클립이 8분 안에 저장되지 않았다' })
      .toBeGreaterThanOrEqual(2);
    const rows = clipRows(id);
    const newer = rows.find(c => c.id !== firstClip)!;
    expect(newer.status, '오탐 뒤 새로 저장된 클립').toBe('VISIBLE');
    expect(rows.find(c => c.id === firstClip)?.status, '오탐 전 클립은 계속 비공개').toBe('HIDDEN');
    expect(await guardianClipIds(g.api, id), '보호자 클립 목록에는 새 클립만 보인다').toEqual([newer.id]);
    test.info().annotations.push({
      type: '현재 동작(ANOM-G07 보류)',
      description: '오탐 뒤 10분 안의 같은 카메라·종류 감지는 새 상황이 되지 않고 오탐으로 판정된 상황에 합쳐진다(AnomalyIncidentService.resolveIncident 는 판정 상태를 건드리지 않음). 문서에는 이 경우의 기대 동작이 없다. 코드 값으로 고정했다',
    });
  });
});
