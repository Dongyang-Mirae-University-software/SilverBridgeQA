/**
 * 최종 QA - 카메라·이상감지(CAM) P1b - 보호자 이상감지 이력 목록·요약
 *
 * 이상감지 상황은 임시 피보호자 자신의 행으로 DB 에 시드한다(목록·요약 API 만 보는 케이스라 실제 화재 신호는 쓰지 않는다).
 * "지금 등록된 카메라"의 상황은 실제로 카메라 1대를 등록해서 만들고(서비스 전체 상한 3대 - 자리가 날 때까지 기다림),
 * "삭제된 카메라"의 상황은 카메라가 없는 가짜 세션으로 만든다(BE 는 카메라 행이 없는 세션을 삭제된 카메라로 본다).
 * 끝나면 카메라와 임시 사용자를 바로 지운다(상황·클립·판정은 사용자 삭제 때 외래키로 함께 지워진다).
 */
import { Api } from '../../../src/api';
import { expect, test } from '../../../src/fixtures';
import { psqlRows, sqlStr } from '../../../src/remote';
import {
  cleanupAll,
  connect,
  deleteCamera,
  errOf,
  fakeSession,
  feedback,
  history,
  HistoryItem,
  incidentIdsOfWard,
  loginUser,
  mkUser,
  registerOk,
  seedClip,
  seedIncident,
  seedIncidentAt,
  summary,
  TAGS,
  waitForCameraSlots,
} from './_helpers-cam-p1b';

test.afterEach(async () => {
  await cleanupAll();
});

interface Dataset {
  wardId: string;
  ward2Id: string;
  gApi: Api;
  wApi: Api;
  cameraId: number;
  cameraLabel: string;
  /** 시작이 가장 늦은 것부터(최신순) 기대하는 상황 id 순서(두 피보호자 전체) */
  expectedOrder: number[];
  ids: Record<'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h', number>;
  clipId: number;
}

/**
 * 피보호자 W(카메라 거실 1대) + W2(카메라 없음), 보호자 G 가 둘 다 연결.
 *   등록된 카메라(거실): a=FIRE 확인필요(-50분, 클립 1개) / b=FALL 실제위험(-40분, G 가 REAL 응답) / c=FIRE 동수(-35분)
 *   삭제된 카메라(가짜 세션): d=WEAPON 확인필요(-30분) / f,g=FIRE 확인필요(둘 다 -25분, 같은 시작 시각) / e=FIRE 오탐(-20분)
 *   W2(카메라 없음): h=FIRE 확인필요(-10분)
 */
async function buildDataset(): Promise<Dataset> {
  const ward = mkUser('WARD');
  const ward2 = mkUser('WARD');
  const guardian = mkUser('GUARDIAN');
  connect(guardian.id, ward.id);
  connect(guardian.id, ward2.id);
  const g = await loginUser(guardian);
  const w = await loginUser(ward);

  const ok = await waitForCameraSlots(1, 540_000);
  test.skip(!ok, '카메라 상한 여유 없음(서비스 전체 3대가 계속 차 있음) - 다른 사용자·영역의 카메라가 정리된 뒤 다시 돌린다');
  const camera = await registerOk(w.api, '거실');

  const dead = fakeSession();
  const dead2 = fakeSession();
  const tied = new Date(Date.now() - 25 * 60_000).toISOString();
  const a = seedIncident({ wardId: ward.id, sessionId: camera.sessionId, type: 'FIRE', startedAgoMin: 50, lastAgoMin: 50, review: 'PENDING', eventCount: 3 });
  const clipId = seedClip({ incidentId: a, wardId: ward.id, sessionId: camera.sessionId });
  const b = seedIncident({ wardId: ward.id, sessionId: camera.sessionId, type: 'FALL', startedAgoMin: 40, lastAgoMin: 40, review: 'PENDING' });
  const c = seedIncident({ wardId: ward.id, sessionId: camera.sessionId, type: 'FIRE', startedAgoMin: 35, lastAgoMin: 35, review: 'CONFLICTED' });
  const d = seedIncident({ wardId: ward.id, sessionId: dead, type: 'WEAPON', startedAgoMin: 30, lastAgoMin: 30, review: 'PENDING' });
  const f = seedIncidentAt({ wardId: ward.id, sessionId: dead, type: 'FIRE', startedAtIso: tied, review: 'PENDING' });
  const gg = seedIncidentAt({ wardId: ward.id, sessionId: dead, type: 'FIRE', startedAtIso: tied, review: 'PENDING' });
  const e = seedIncident({ wardId: ward.id, sessionId: dead, type: 'FIRE', startedAgoMin: 20, lastAgoMin: 20, review: 'FALSE_ALARM' });
  const h = seedIncident({ wardId: ward2.id, sessionId: dead2, type: 'FIRE', startedAgoMin: 10, lastAgoMin: 10, review: 'PENDING' });

  // b 는 G 가 직접 REAL 로 응답해서 내 응답(myVerdict)이 생기게 한다
  const fb = await feedback(g.api, b, 'REAL');
  expect(fb.status, '준비: 판정 응답').toBe(200);

  return {
    wardId: ward.id,
    ward2Id: ward2.id,
    gApi: g.api,
    wApi: w.api,
    cameraId: camera.id,
    cameraLabel: camera.label,
    expectedOrder: [h, e, gg, f, d, c, b, a],
    ids: { a, b, c, d, e, f, g: gg, h },
    clipId,
  };
}

const idsOf = (items: HistoryItem[]) => items.map(i => i.incidentId);

test.describe('카메라·이상감지 P1b - 이력 목록·요약', () => {
  test('CAM-A29 이력 필터에 잘못된 값은 400', TAGS, async () => {
    const ward = mkUser('WARD');
    const guardian = mkUser('GUARDIAN');
    connect(guardian.id, ward.id);
    const g = await loginUser(guardian);
    for (let i = 0; i < 3; i++) seedIncident({ wardId: ward.id, sessionId: fakeSession(), type: 'FIRE', lastAgoMin: 10 + i });

    // 잘못된 필터 값: 빈 목록이 아니라 400 INVALID_INPUT (대소문자 구분, FIRE·FALL·WEAPON / DELETED·EXISTING 만)
    const bad = [
      'type=fire',
      'type=NORMAL',
      'type=SMOKE',
      'type=UNKNOWN',
      'camera=ALL',
      'camera=existing',
      'camera=NORMAL',
      'type=FIRE&camera=ALL',
      `wardId=${ward.id}&type=smoke`,
      `wardId=${ward.id}&camera=deleted`,
    ];
    for (const q of bad) {
      const r = await history(g.api, q);
      expect(r.status, `?${q} -> 실제 ${r.status} ${r.code ?? ''} (빈 목록 ${r.page?.content.length ?? '-'})`).toBe(400);
      expect(r.code, `?${q} 에러 코드`).toBe('INVALID_INPUT');
      expect(r.page, `?${q} 400 인데 본문에 이력이 들어 있다`).toBeUndefined();
    }
    // 올바른 값은 같은 계정에서 200 이어야 한다(검증이 정상 값까지 막지 않는다)
    for (const q of ['type=FIRE', 'type=FALL', 'type=WEAPON', 'camera=EXISTING', 'camera=DELETED', 'type=FIRE&camera=DELETED']) {
      const r = await history(g.api, q);
      expect(r.status, `?${q} 정상 값 -> 실제 ${r.status}`).toBe(200);
    }
    // 쪽수·크기가 숫자가 아니면 400
    for (const q of ['size=abc', 'page=abc']) {
      const r = await history(g.api, q);
      expect(r.status, `?${q} -> 실제 ${r.status}`).toBe(400);
      expect(r.code).toBe('INVALID_INPUT');
    }

    // 쪽수·크기는 400 이 아니라 보정한다: 크기 0·음수는 1, 50 초과는 50, 쪽수 음수는 0
    const zero = await history(g.api, 'size=0');
    expect(zero.status, 'size=0').toBe(200);
    expect(zero.page?.size, 'size=0 은 1로 보정').toBe(1);
    expect(zero.page?.content.length, 'size=0 보정 뒤 1건').toBe(1);
    expect(zero.page?.totalPages).toBe(3);
    const negative = await history(g.api, 'size=-5');
    expect(negative.status, 'size=-5').toBe(200);
    expect(negative.page?.size, 'size=-5 는 1로 보정').toBe(1);
    const over = await history(g.api, 'size=1000');
    expect(over.status, 'size=1000').toBe(200);
    expect(over.page?.size, 'size=1000 은 50으로 보정').toBe(50);
    expect(over.page?.content.length).toBe(3);
    const negPage = await history(g.api, 'page=-3&size=2');
    expect(negPage.status, 'page=-3').toBe(200);
    expect(negPage.page?.page, 'page=-3 은 0으로 보정').toBe(0);
    expect(negPage.page?.content.length).toBe(2);
    // 아주 큰 쪽수는 500 이 아니라 마지막 가능한 쪽으로 맞춘다(offset 이 int 를 넘지 않게)
    const huge = await history(g.api, 'page=2147483647&size=50');
    expect(huge.status, 'page=2147483647 -> 500 이면 안 된다').toBe(200);
    expect(huge.page?.page, '아주 큰 쪽수는 int 안의 마지막 쪽으로 보정').toBe(Math.floor(2147483647 / 50));
    expect(huge.page?.content).toEqual([]);
    // 보정 뒤에도 전체 건수는 그대로
    expect(zero.page?.totalElements).toBe(3);
    expect(over.page?.totalElements).toBe(3);
  });

  test('CAM-N33 보호자 이력 목록 필터·쪽수', TAGS, async () => {
    test.setTimeout(720_000);
    const d = await buildDataset();
    const { a, b, c, d: dd, e, f, g, h } = d.ids;
    const all = d.expectedOrder;

    // 1) wardId 없으면 연결된 피보호자 전체, 최신순(시작 시각 내림차순, 같으면 id 내림차순)
    const full = await history(d.gApi, 'size=50');
    expect(full.status).toBe(200);
    expect(full.page?.totalElements, '연결된 두 피보호자 전체 8건').toBe(8);
    expect(idsOf(full.page!.content), '최신순(시작 시각, 같으면 id 내림차순)').toEqual(all);
    expect(g, '준비: 같은 시작 시각인 두 상황의 id 순서').toBeGreaterThan(f);

    // 2) wardId 지정은 그 피보호자만
    const w1 = await history(d.gApi, `wardId=${d.wardId}&size=50`);
    expect(w1.status).toBe(200);
    expect(idsOf(w1.page!.content), 'W 만').toEqual(all.filter(id => id !== h));
    expect(w1.page?.totalElements).toBe(7);
    const w2 = await history(d.gApi, `wardId=${d.ward2Id}`);
    expect(idsOf(w2.page!.content), 'W2 만').toEqual([h]);

    // 3) type 필터: 목록과 totalElements 가 필터 기준
    const fire = await history(d.gApi, 'type=FIRE&size=50');
    expect(idsOf(fire.page!.content), 'FIRE').toEqual(all.filter(id => [h, e, g, f, c, a].includes(id)));
    expect(fire.page?.totalElements, 'FIRE totalElements').toBe(6);
    const fall = await history(d.gApi, 'type=FALL');
    expect(idsOf(fall.page!.content), 'FALL').toEqual([b]);
    expect(fall.page?.totalElements).toBe(1);
    const weapon = await history(d.gApi, 'type=WEAPON');
    expect(idsOf(weapon.page!.content), 'WEAPON').toEqual([dd]);
    expect(weapon.page?.totalElements).toBe(1);

    // 4) camera 필터: EXISTING = 지금 등록된 카메라(cameraLabel 있음), DELETED = 삭제된 카메라(cameraLabel null)
    const existing = await history(d.gApi, 'camera=EXISTING&size=50');
    expect(idsOf(existing.page!.content), 'EXISTING').toEqual([c, b, a]);
    expect(existing.page?.totalElements, 'EXISTING totalElements').toBe(3);
    expect(existing.page!.content.every(i => i.cameraLabel === d.cameraLabel), '등록된 카메라의 상황은 방 이름이 보인다').toBe(true);
    const deleted = await history(d.gApi, 'camera=DELETED&size=50');
    expect(idsOf(deleted.page!.content), 'DELETED').toEqual([h, e, g, f, dd]);
    expect(deleted.page?.totalElements, 'DELETED totalElements').toBe(5);
    expect(deleted.page!.content.every(i => i.cameraLabel === null), '삭제된 카메라의 상황은 방 이름이 null').toBe(true);
    // type 과 camera 를 함께
    const fireDeleted = await history(d.gApi, 'type=FIRE&camera=DELETED&size=50');
    expect(idsOf(fireDeleted.page!.content)).toEqual([h, e, g, f]);
    expect(fireDeleted.page?.totalElements).toBe(4);
    const fireExisting = await history(d.gApi, 'type=FIRE&camera=EXISTING');
    expect(idsOf(fireExisting.page!.content)).toEqual([c, a]);
    const weaponExisting = await history(d.gApi, 'type=WEAPON&camera=EXISTING');
    expect(weaponExisting.status, '결과가 0건이어도 400 이 아니라 200').toBe(200);
    expect(weaponExisting.page?.content).toEqual([]);
    expect(weaponExisting.page?.totalElements).toBe(0);
    // wardId + 필터
    const wardFall = await history(d.gApi, `wardId=${d.wardId}&type=FALL&camera=EXISTING`);
    expect(idsOf(wardFall.page!.content)).toEqual([b]);

    // 5) 쪽수: 크기 3 이면 3·3·2 건, 겹침·빠짐 없이 전체 순서와 같다. totalElements 는 쪽마다 같다
    const pages = [await history(d.gApi, 'page=0&size=3'), await history(d.gApi, 'page=1&size=3'), await history(d.gApi, 'page=2&size=3')];
    expect(pages.map(p => p.page?.content.length), '쪽별 건수').toEqual([3, 3, 2]);
    expect(pages.map(p => p.page?.totalElements), '쪽마다 totalElements 같음').toEqual([8, 8, 8]);
    expect(pages.map(p => p.page?.totalPages)).toEqual([3, 3, 3]);
    expect(pages.map(p => p.page?.last), '마지막 쪽 표시').toEqual([false, false, true]);
    expect(pages.flatMap(p => idsOf(p.page!.content)), '쪽을 이으면 전체 최신순').toEqual(all);
    const filteredPage = await history(d.gApi, 'type=FIRE&page=1&size=4');
    expect(idsOf(filteredPage.page!.content), '필터 기준 쪽수(FIRE 6건, 크기 4 의 2쪽)').toEqual(all.filter(id => [h, e, g, f, c, a].includes(id)).slice(4));
    expect(filteredPage.page?.totalPages).toBe(2);

    // 6) 항목에 incidentId·reviewStatus·myVerdict·clip·clipCount 가 있다
    const byId = new Map(full.page!.content.map(i => [i.incidentId, i]));
    const itemA = byId.get(a)!;
    expect(itemA.reviewStatus).toBe('PENDING');
    expect(itemA.myVerdict, '응답 안 한 상황').toBeNull();
    expect(itemA.clipCount, '클립 1개').toBe(1);
    expect(itemA.clip?.clipId, '클립 요약의 clipId').toBe(d.clipId);
    expect(itemA.eventCount, '묶인 감지 횟수').toBe(3);
    const itemB = byId.get(b)!;
    expect(itemB.reviewStatus, 'G 가 REAL 로 응답한 상황').toBe('REAL');
    expect(itemB.myVerdict).toBe('REAL');
    expect(itemB.clip ?? null, '클립 없는 상황').toBeNull();
    expect(itemB.clipCount).toBe(0);
    expect(byId.get(c)!.reviewStatus).toBe('CONFLICTED');
    expect(byId.get(e)!.reviewStatus).toBe('FALSE_ALARM');
    expect(byId.get(dd)!.detectedType).toBe('WEAPON');
    for (const item of full.page!.content) {
      expect(typeof item.incidentId).toBe('number');
      expect(item, `상황 ${item.incidentId} 에 myVerdict 칸`).toHaveProperty('myVerdict');
      expect(item, `상황 ${item.incidentId} 에 clipCount 칸`).toHaveProperty('clipCount');
      expect(item, `상황 ${item.incidentId} 에 clip 칸`).toHaveProperty('clip');
    }

    // 7) 연결 안 된 피보호자를 지정하면 403 (필터보다 먼저)
    const other = mkUser('GUARDIAN');
    const o = await loginUser(other);
    const notLinked = await errOf(await o.api.raw('GET', `/api/guardian/anomaly/history?wardId=${d.wardId}&type=FIRE`));
    expect(notLinked.status, '연결 안 된 보호자가 wardId 지정').toBe(403);
    expect(notLinked.code).toBe('ANOMALY_NOT_AUTHORIZED');
    const noWard = await history(o.api, '');
    expect(noWard.status, '연결이 없는 보호자는 wardId 없이 빈 목록').toBe(200);
    expect(noWard.page?.content).toEqual([]);
    expect(await deleteCamera(d.wApi, d.cameraId), '정리: 카메라 삭제').toBe(200);
  });

  test('CAM-N34 이력 요약(summary) 숫자', TAGS, async () => {
    test.setTimeout(720_000);
    const d = await buildDataset();
    const sum = async (q = '') => {
      const r = await summary(d.gApi, q);
      expect(r.status, `summary ${q}`).toBe(200);
      return r.data!;
    };
    const totalOfHistory = async (q: string) => (await history(d.gApi, q)).page!.totalElements;

    // 등록된 카메라(거실)의 상황 a(FIRE 확인필요)·b(FALL 실제위험)·c(FIRE 동수)만 기본 집계. 삭제된 카메라 상황 5건은 따로
    const s1 = await sum();
    expect(s1, '요약(두 피보호자 전체)').toEqual({
      total: 3,
      pendingCount: 1,
      conflictedCount: 1,
      needsReviewCount: 2,
      byType: { fire: 2, fall: 1, weapon: 0 },
      deletedCameraCount: 5,
    });
    expect(s1.needsReviewCount, '확인 필요 = 확인 필요 + 동수').toBe(s1.pendingCount + s1.conflictedCount);
    expect(s1.total + s1.deletedCameraCount, 'total + deletedCameraCount = 카메라 필터 없는 이력 전체').toBe(await totalOfHistory('size=1'));
    expect(s1.total, 'total = camera=EXISTING 이력의 totalElements').toBe(await totalOfHistory('camera=EXISTING&size=1'));
    expect(s1.deletedCameraCount, 'deletedCameraCount = camera=DELETED 이력의 totalElements').toBe(await totalOfHistory('camera=DELETED&size=1'));

    // wardId 지정은 그 피보호자만(W 는 삭제된 카메라 상황 4건, W2 는 등록된 카메라가 없어 total 0)
    const sw = await sum(`wardId=${d.wardId}`);
    expect(sw).toEqual({ total: 3, pendingCount: 1, conflictedCount: 1, needsReviewCount: 2, byType: { fire: 2, fall: 1, weapon: 0 }, deletedCameraCount: 4 });
    const sw2 = await sum(`wardId=${d.ward2Id}`);
    expect(sw2, 'W2: 등록된 카메라 없음').toEqual({ total: 0, pendingCount: 0, conflictedCount: 0, needsReviewCount: 0, byType: { fire: 0, fall: 0, weapon: 0 }, deletedCameraCount: 1 });

    // 사용 중지는 삭제가 아니다: 숫자가 그대로
    expect((await d.wApi.raw('PATCH', `/api/ward/camera/${d.cameraId}`, { isActive: false })).status(), '카메라 사용 중지').toBe(200);
    expect(await sum(), '사용 중지 뒤에도 같은 숫자').toEqual(s1);
    expect((await history(d.gApi, 'camera=EXISTING')).page?.totalElements, '사용 중지 카메라 상황은 EXISTING').toBe(3);

    // 카메라를 지우면 그 상황 3건도 삭제된 카메라 쪽으로 넘어간다. byType 은 0 이어도 세 칸이 모두 있다
    expect(await deleteCamera(d.wApi, d.cameraId), '카메라 삭제').toBe(200);
    const s2 = await sum();
    expect(s2, '카메라 삭제 뒤 요약').toEqual({
      total: 0,
      pendingCount: 0,
      conflictedCount: 0,
      needsReviewCount: 0,
      byType: { fire: 0, fall: 0, weapon: 0 },
      deletedCameraCount: 8,
    });
    expect(Object.keys(s2.byType).sort(), 'byType 은 fire·fall·weapon 을 항상 포함').toEqual(['fall', 'fire', 'weapon']);
    expect(s2.total + s2.deletedCameraCount, '삭제 뒤에도 total + deleted = 전체').toBe(await totalOfHistory('size=1'));
    // 이력 행·판정은 지워지지 않고 DELETED 로 계속 보인다
    expect((await history(d.gApi, 'camera=DELETED')).page?.totalElements).toBe(8);
    expect(incidentIdsOfWard(d.wardId).length, '이력 행은 그대로').toBe(7);
    expect(psqlRows(`SELECT count(*) FROM anomaly_incident WHERE ward_id = ${sqlStr(d.wardId)} AND review_status = 'REAL';`)[0][0], '판정도 그대로').toBe('1');
  });
});
