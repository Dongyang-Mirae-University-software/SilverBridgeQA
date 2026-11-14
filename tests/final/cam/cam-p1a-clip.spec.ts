/**
 * 최종 QA - 카메라·이상감지(CAM) P1a - 5초 클립·판정·상황 묶기
 *
 * 앞의 A37 은 임시 피보호자의 시드 행만 쓴다(카메라 없음).
 * 나머지는 화재 신호를 한 번 만들어 나눠 쓴다(getClipRun): 임시 피보호자 1명 + 보호자 2명 + 카메라 1대, 화재 사진을 계속 보낸다.
 * 이 묶음은 serial 이다. 앞 테스트가 만든 상태(클립 1개·상황 1건)를 뒤 테스트가 이어 쓰고, 한 번 실패하면 나머지는 건너뛴다.
 * 순서: N46 클립 저장 -> A39 쿨다운·12개 상한 -> N48 보호자 목록·재생 -> N49 피보호자 열람 -> N39 동시 응답 -> N40 오탐 숨김
 *       -> N31 상황 묶기 -> N32 새 상황 -> N50 지워지는 길(카메라 삭제로 클립 삭제, 마지막)
 * 끝나면 펌프·AI 세션·카메라·임시 사용자를 모두 지운다. 클립 파일은 서버의 고아 파일 청소(매시 15분)가 회수한다.
 * 실행 안내: 카메라 상한(서비스 전체 3대)이 공용이라 남은 자리가 없으면 최대 10분 기다린다.
 */
import { request } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { countBackendLog, psqlRows, redis, sqlStr } from '../../../src/remote';
import {
  authedCtx,
  cleanupAll,
  clipFileNameOf,
  clipFileSize,
  clipRowsOf,
  connect,
  disposeClipRun,
  errOf,
  feedback,
  getClipRun,
  guardianClipList,
  incidentRow,
  loginUser,
  mkUser,
  seedClip,
  seedIncident,
  setConnections,
  sleep,
  TAGS,
  trackOwnRedisKey,
  waitEventCount,
} from './_helpers-cam-p1a';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await disposeClipRun();
});

const fakeSession = () => `e2e-p1a-${Math.random().toString(36).slice(2, 10)}`;
const CLIP_NOT_FOUND_MESSAGE = '영상을 찾을 수 없습니다.';

test.describe('카메라·이상감지 P1a - 5초 클립', () => {
  test('CAM-A37 숨김·만료·없음은 모두 404 ANOMALY_CLIP_NOT_FOUND(이유 구분 없음)', TAGS, async () => {
    const ward = mkUser('WARD');
    const g = mkUser('GUARDIAN');
    const other = mkUser('GUARDIAN', 'E2E클립남남');
    connect(g.id, ward.id);
    const sid = fakeSession();
    const incidentId = seedIncident({ wardId: ward.id, sessionId: sid });
    const hidden = seedClip({ incidentId, wardId: ward.id, sessionId: sid, status: 'HIDDEN' });
    const hiddenOld = seedClip({ incidentId, wardId: ward.id, sessionId: sid, status: 'HIDDEN', createdAgoMin: 26 * 60 });
    const expired = seedClip({ incidentId, wardId: ward.id, sessionId: sid, status: 'VISIBLE', createdAgoMin: 31 * 24 * 60 });
    const gl = await loginUser(g);
    const ol = await loginUser(other);

    const responses: { label: string; status: number; code?: string; message?: string; raw: string }[] = [];
    for (const [label, id] of [['오탐으로 숨긴 클립', hidden], ['숨긴 지 24시간이 지난 클립', hiddenOld], ['보관 30일이 지난 클립', expired], ['없는 clipId', 999_999_999]] as const) {
      const err = await errOf(await gl.api.raw('GET', `/api/guardian/anomaly/clips/${id}/file`));
      responses.push({ label, ...err });
    }
    for (const r of responses) {
      expect(r.status, `${r.label} -> 실제 ${r.status} ${r.code ?? ''}`).toBe(404);
      expect(r.code, `${r.label} 에러 코드`).toBe('ANOMALY_CLIP_NOT_FOUND');
    }
    // 이유가 응답으로 드러나지 않는다: 네 응답의 문구가 모두 같고 숨김·만료를 뜻하는 말이 없다
    expect(new Set(responses.map(r => r.message)).size, '네 응답의 문구가 모두 같아야 한다').toBe(1);
    expect(responses[0].message).toBe(CLIP_NOT_FOUND_MESSAGE);
    expect(responses.map(r => r.raw).join(' '), '응답 본문에 이유(숨김·오탐·만료)가 드러나면 안 된다').not.toMatch(/오탐|숨김|비공개|만료|보관|hidden|expired/i);
    // 연결 안 된 보호자도 같은 404(숨긴 클립이 있다는 사실도 드러나지 않는다. 존재 확인이 연결 확인보다 먼저다)
    const strangerHidden = await errOf(await ol.api.raw('GET', `/api/guardian/anomaly/clips/${hidden}/file`));
    expect(strangerHidden.status, '연결 안 된 보호자가 숨긴 클립 요청').toBe(404);
    expect(strangerHidden.code).toBe('ANOMALY_CLIP_NOT_FOUND');
    // 목록에도 숨김·만료 클립은 나오지 않는다
    const list = await guardianClipList(gl.api, incidentId);
    expect(list.status).toBe(200);
    expect(list.items, '숨김·만료 클립은 목록에서 빠진다').toEqual([]);
    expect(clipRowsOf(incidentId).length, '시드한 행 3개는 DB 에는 있다(숨김 2·만료 1)').toBe(3);
  });

  test('CAM-N46 화재 감지 뒤 5초 클립 저장(앞3+뒤2)', TAGS, async () => {
    test.setTimeout(900_000);
    const run = await getClipRun();
    test.info().annotations.push({ type: '시간', description: `상황 생성까지 ${Math.round(run.detectionMs / 1000)}초, 클립 확인까지 ${run.clipFirstSeenMs === null ? '60초 넘음' : `${Math.round(run.clipFirstSeenMs / 1000)}초`}` });
    expect(run.clipFirstSeenMs, '상황이 생긴 뒤 60초 안에 클립이 만들어져야 한다(문서: 감지 후 약 3~10초)').not.toBeNull();

    const list = await guardianClipList(run.gaApi, run.incident.incidentId);
    expect(list.status).toBe(200);
    expect(list.items.length, '화재 상황의 클립은 1개(같은 카메라 5분 쿨다운)').toBe(1);
    const clip = list.items[0];
    expect(clip.incidentId).toBe(run.incident.incidentId);
    expect(clip.detectedAt, 'detectedAt').toBeTruthy();
    // 앞 3초 + 뒤 2초 = 약 5초
    expect(clip.durationMs, `클립 길이(실제 ${clip.durationMs}ms)`).not.toBeNull();
    expect(clip.durationMs!, `클립 길이 ${clip.durationMs}ms 는 앞3+뒤2=약 5초`).toBeGreaterThanOrEqual(4_000);
    expect(clip.durationMs!, `클립 길이 ${clip.durationMs}ms 는 앞3+뒤2=약 5초`).toBeLessThanOrEqual(6_500);
    expect(clip.sizeBytes, `파일 크기 ${clip.sizeBytes}`).toBeGreaterThan(0);
    expect(clip.sizeBytes, '클립 최대 크기(10MB) 이하').toBeLessThanOrEqual(10 * 1024 * 1024);
    test.info().annotations.push({ type: '클립', description: `길이 ${clip.durationMs}ms, ${clip.width}x${clip.height}, ${clip.sizeBytes}바이트 (문서: 약 1.9MB)` });

    // DB 에는 파일 이름만(UUID.webm), 서버 /data/clips 에 같은 크기의 파일이 있다
    const fileName = clipFileNameOf(clip.clipId);
    expect(fileName, 'DB 에는 경로 없이 UUID 이름만').toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webm$/);
    expect(clipFileSize(fileName), '/data/clips 의 파일 크기가 DB 의 sizeBytes 와 같다').toBe(clip.sizeBytes);

    // 이력·알림은 클립과 무관: 완성 알림 없음(알림 종류에 클립이 없다), 이력 항목에 대표 클립이 붙는다
    const types = psqlRows(`SELECT DISTINCT type FROM notification_log WHERE ward_id = ${sqlStr(run.ward.id)};`).map(r => r[0]);
    expect(types.filter(t => /CLIP/i.test(t)), '클립 완성 알림은 없다').toEqual([]);
    const history = await run.gaApi.get<{ content: { incidentId: number; clip: { clipId: number } | null; clipCount: number }[] }>(`/api/guardian/anomaly/history?wardId=${run.ward.id}`);
    const item = history.content.find(i => i.incidentId === run.incident.incidentId);
    expect(item?.clip?.clipId, '이력 항목의 대표 클립').toBe(clip.clipId);
    expect(item?.clipCount).toBe(1);
    expect(countBackendLog(`클립 저장: clipId=${clip.clipId}`, 900), 'BE 로그에 이 클립의 저장 기록').toBeGreaterThan(0);
  });

  test('CAM-A39 클립 한도: 쿨다운 5분·상황당 12개·디스크 1GB 미만·Redis 장애', TAGS, async () => {
    test.setTimeout(900_000);
    const run = await getClipRun();
    const id = run.incident.incidentId;
    const key = `anomaly:clip:${run.camera.sessionId}:FIRE`;
    trackOwnRedisKey(key);

    // 1) 쿨다운 5분: 클립을 만든 직후 쿨다운 키가 남아 있고(남은 초 1~300), 다음 감지가 와도 클립은 늘지 않는다
    const ttl = Number(redis('TTL', key));
    expect(ttl, `클립 쿨다운 키의 남은 초(${ttl})`).toBeGreaterThan(0);
    expect(ttl, `클립 쿨다운은 5분(300초) 이하(${ttl})`).toBeLessThanOrEqual(300);
    const before = incidentRow(id)!;
    await waitEventCount(id, before.eventCount + 1, 200_000);
    const age = Number(psqlRows(`SELECT extract(epoch from (now() - min(created_at)))::int FROM anomaly_clip WHERE incident_id = ${id};`)[0][0]);
    const during = clipRowsOf(id).length;
    test.info().annotations.push({ type: '쿨다운 확인', description: `두 번째 감지가 기록됐을 때 첫 클립으로부터 ${age}초, 클립 ${during}개, 감지 ${incidentRow(id)?.eventCount}회` });
    expect(age, '두 번째 감지가 쿨다운(300초) 안에 도착해야 이 확인이 의미가 있다').toBeLessThan(295);
    expect(during, '쿨다운 중 재감지는 클립을 만들지 않는다(이력은 늘었다)').toBe(1);

    // 2) 상황당 12개: 쿨다운 키를 지우고(내 카메라 키) 클립 행을 12개로 채운 뒤 다음 감지에서 13번째가 만들어지지 않는지 본다
    redis('DEL', key);
    const have = clipRowsOf(id).length;
    const seeded: number[] = [];
    try {
      for (let i = 0; i < 12 - have; i++) seeded.push(seedClip({ incidentId: id, wardId: run.ward.id, sessionId: run.camera.sessionId, createdAgoMin: 60 + i }));
      expect(clipRowsOf(id).length, '시드 뒤 클립 행 12개').toBe(12);
      // 이 상황 번호까지 넣어 다른 상황·다른 에이전트의 로그로는 통과하지 못하게 한다
      const capLog = `상황당 클립 상한 도달 - 기록 안 함: incidentId=${id}`;
      const logBefore = countBackendLog(capLog, 900);
      const e0 = incidentRow(id)!.eventCount;
      await waitEventCount(id, e0 + 1, 200_000);
      await expect
        .poll(() => countBackendLog(capLog, 900), { timeout: 120_000, intervals: [5_000], message: '12개가 찬 상황에서 새 감지가 와도 "상황당 클립 상한 도달" 기록이 새로 생기지 않았다' })
        .toBeGreaterThan(logBefore);
      expect(clipRowsOf(id).length, '13번째 클립은 기록되지 않는다').toBe(12);
      // 이력은 그대로 쌓인다
      expect(incidentRow(id)!.eventCount, '클립이 막혀도 감지 이력은 늘어난다').toBeGreaterThan(e0);
    } finally {
      if (seeded.length) psqlRows(`DELETE FROM anomaly_clip WHERE id IN (${seeded.join(',')}) RETURNING id;`);
      // 상한 경로가 쿨다운을 다시 5분 잡는다. 시드를 지운 뒤 5분이 지나 새 클립이 생겨 뒤 테스트(N48·N49)의 클립 개수가 흔들리지 않게,
      // 내 카메라의 쿨다운 키를 길게 다시 걸어 둔다(N40 이 새 클립을 보려고 직접 지운다)
      redis('SET', key, '1', 'EX', '3000');
    }
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: '디스크 여유 1GB 미만(서버 디스크를 채울 수 없음)과 Redis 장애(Redis 를 멈출 수 없음) 때 클립을 안 만들고 이력·알림은 나가는 부분은 서버 조작이 필요해 확인하지 못했다',
    });
  });

  test('CAM-N48 보호자 클립 목록·파일 재생(206 구간 요청)', TAGS, async ({ openAs }) => {
    test.setTimeout(300_000);
    const run = await getClipRun();
    const id = run.incident.incidentId;
    // 시작할 때 목록을 다시 읽어 그 길이를 기준으로 한다(개수를 1로 고정하지 않음)
    const base = (await guardianClipList(run.gaApi, id)).items;
    const real = base[0];
    // 최신순 확인용으로 더 오래된 시드 클립 2개(파일 없음)를 잠깐 붙였다 지운다
    const seeded = [
      seedClip({ incidentId: id, wardId: run.ward.id, sessionId: run.camera.sessionId, createdAgoMin: 120 }),
      seedClip({ incidentId: id, wardId: run.ward.id, sessionId: run.camera.sessionId, createdAgoMin: 240 }),
    ];
    try {
      const list = await guardianClipList(run.gaApi, id);
      expect(list.status).toBe(200);
      expect(list.items.map(c => c.clipId), '목록은 최신순').toEqual([...base.map(c => c.clipId), ...seeded]);
      expect(Object.keys(list.items[0]).sort(), '목록 항목 필드').toEqual(['clipId', 'createdAt', 'detectedAt', 'durationMs', 'height', 'incidentId', 'sizeBytes', 'width']);
    } finally {
      psqlRows(`DELETE FROM anomaly_clip WHERE id IN (${seeded.join(',')}) RETURNING id;`);
    }

    const ctx = await authedCtx(run.gaLogin);
    const url = `/api/guardian/anomaly/clips/${real.clipId}/file`;
    const full = await ctx.get(url);
    expect(full.status(), '파일 전체').toBe(200);
    expect(full.headers()['content-type']).toContain('video/webm');
    const cache = full.headers()['cache-control'] ?? '';
    expect(cache, '캐시 금지').toContain('no-store');
    expect(cache).toContain('private');
    const body = await full.body();
    expect(body.length, '받은 바이트 수 = 목록의 sizeBytes').toBe(real.sizeBytes);
    expect([...body.subarray(0, 4)], 'WebM(EBML) 시그니처').toEqual([0x1a, 0x45, 0xdf, 0xa3]);

    const part = await ctx.get(url, { headers: { Range: 'bytes=0-99' } });
    expect(part.status(), 'Range bytes=0-99').toBe(206);
    expect(part.headers()['content-range']).toBe(`bytes 0-99/${real.sizeBytes}`);
    expect((await part.body()).length).toBe(100);
    const tail = await ctx.get(url, { headers: { Range: 'bytes=100-' } });
    expect(tail.status(), 'Range bytes=100-').toBe(206);
    expect((await tail.body()).length).toBe(real.sizeBytes - 100);
    // 헤더 없는 요청(<video src> 직접)은 401
    const anon = await request.newContext({ baseURL: env.apiUrl });
    try {
      expect((await anon.get(url)).status(), 'Authorization 없이 파일').toBe(401);
    } finally {
      await anon.dispose();
    }

    // 화면: 이력 카드의 "영상 보기" -> 영상 화면, Authorization fetch 뒤 blob URL 로 재생
    const page = await openAs({ label: 'clip-guardian', login: run.gaLogin }, null);
    const fileCalls: { auth: boolean; status: number; range: boolean }[] = [];
    page.on('response', async res => {
      if (res.url().includes(`/api/guardian/anomaly/clips/${real.clipId}/file`)) {
        fileCalls.push({ auth: Boolean(res.request().headers()['authorization']), status: res.status(), range: Boolean(res.request().headers()['range']) });
      }
    });
    await page.goto('/guardian/detection');
    const open = page.getByRole('button', { name: '영상 보기' }).first();
    await expect(open).toBeVisible({ timeout: 30_000 });
    await open.click();
    const dialog = page.getByRole('dialog', { name: '감지 영상' });
    await expect(dialog).toBeVisible();
    const video = dialog.locator('video');
    await expect(video).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => video.getAttribute('src'), { timeout: 20_000 }).toMatch(/^blob:/);
    expect(fileCalls.length, '화면이 클립 파일을 fetch 했다').toBeGreaterThan(0);
    expect(fileCalls.every(c => c.auth), '파일 요청에 Authorization 헤더가 붙는다').toBe(true);
    // FE 는 썸네일용으로 Range 요청(응답 206)을, 재생용으로 Range 없는 전체 요청(응답 200)을 보낸다(anomaly.ts). 요청 종류마다 응답은 하나로 정해진다
    expect(fileCalls.every(c => c.status === (c.range ? 206 : 200)), `파일 응답(range 여부/상태: ${fileCalls.map(c => `${c.range}/${c.status}`).join(',')})`).toBe(true);
    expect(fileCalls.some(c => !c.range), '재생용 전체 요청이 있다').toBe(true);
  });

  test('CAM-N49 피보호자 본인 클립 열람(보호자 1명 이상일 때)', TAGS, async () => {
    const run = await getClipRun();
    const id = run.incident.incidentId;
    const baseItems = (await guardianClipList(run.gaApi, id)).items;
    const clip = baseItems[0];
    const baseCount = baseItems.length; // 시작할 때 길이를 기준으로 비교(1로 고정하지 않음)
    expect(clipRowsOf(id).length, '시작 때 DB 클립 행과 보호자 목록 길이가 같다').toBe(baseCount);
    const ward2 = mkUser('WARD', 'E2E클립다른본인');
    const w2 = await loginUser(ward2);

    const listUrl = `/api/ward/anomaly/${id}/clips`;
    const fileUrl = `/api/ward/anomaly/clips/${clip.clipId}/file`;
    const ctx = await authedCtx(run.wardLogin);
    // 보호자가 ACTIVE 1명 이상이면 200
    const ok = await run.wardApi.raw('GET', listUrl);
    expect(ok.status(), '보호자 2명일 때 본인 목록').toBe(200);
    expect(((await ok.json()) as { data: unknown[] }).data.length).toBe(baseCount);
    const okFile = await ctx.get(fileUrl);
    expect(okFile.status(), '보호자 2명일 때 본인 파일').toBe(200);
    expect(okFile.headers()['content-type']).toContain('video/webm');
    // 다른 피보호자는 403 ANOMALY_CLIP_NOT_OWNED
    const notOwned = await errOf(await w2.api.raw('GET', listUrl));
    expect(notOwned.status, '다른 피보호자가 남의 상황 클립').toBe(403);
    expect(notOwned.code).toBe('ANOMALY_CLIP_NOT_OWNED');
    // 보호자 1명만 남아도 보인다
    setConnections(run.ward.id, 'DISCONNECTED');
    psqlRows(`UPDATE connection SET status = 'ACTIVE' WHERE ward_id = ${sqlStr(run.ward.id)} AND guardian_id = ${sqlStr(run.ga.id)} RETURNING id;`);
    try {
      expect((await run.wardApi.raw('GET', listUrl)).status(), '보호자 1명일 때 본인 목록').toBe(200);
      expect((await ctx.get(fileUrl)).status(), '보호자 1명일 때 본인 파일').toBe(200);
      // 보호자 0명이면 404 (파일은 지우지 않고 보이지만 않는다)
      setConnections(run.ward.id, 'DISCONNECTED');
      const noneList = await errOf(await run.wardApi.raw('GET', listUrl));
      expect(noneList.status, `보호자 0명일 때 목록 -> 실제 ${noneList.status} ${noneList.code ?? ''}`).toBe(404);
      expect(noneList.code).toBe('ANOMALY_CLIP_NOT_FOUND');
      const noneFile = await ctx.get(fileUrl);
      expect(noneFile.status(), '보호자 0명일 때 파일').toBe(404);
      expect(((await noneFile.json()) as { code?: string }).code).toBe('ANOMALY_CLIP_NOT_FOUND');
      expect(clipRowsOf(id).length, '연결이 끊겨도 클립 행은 지우지 않는다').toBe(baseCount);
      expect(clipFileSize(clipFileNameOf(clip.clipId)), '연결이 끊겨도 파일은 지우지 않는다').toBe(clip.sizeBytes);
    } finally {
      setConnections(run.ward.id, 'ACTIVE');
    }
    // 다시 연결되면 다시 보인다
    expect((await run.wardApi.raw('GET', listUrl)).status(), '다시 연결된 뒤 본인 목록').toBe(200);
    expect((await ctx.get(fileUrl)).status(), '다시 연결된 뒤 본인 파일').toBe(200);
  });

  test('CAM-N39 두 보호자가 같은 순간 반대로 답해도 동수', TAGS, async () => {
    test.setTimeout(600_000);
    const run = await getClipRun();
    const id = run.incident.incidentId;
    // 같은 순간 반대로: 5번 뒤집어 가며 반복해도 매번 정확히 동수(CONFLICTED)
    for (let round = 0; round < 5; round++) {
      const [a, b] = round % 2 === 0 ? (['REAL', 'FALSE_ALARM'] as const) : (['FALSE_ALARM', 'REAL'] as const);
      const [ra, rb] = await Promise.all([feedback(run.gaApi, id, a), feedback(run.gbApi, id, b)]);
      expect([ra.status, rb.status], `${round + 1}번째 동시 응답 상태`).toEqual([200, 200]);
      expect(incidentRow(id)?.review, `${round + 1}번째 동시 응답 뒤 판정`).toBe('CONFLICTED');
      expect(psqlRows(`SELECT guardian_id, verdict FROM anomaly_incident_feedback WHERE incident_id = ${id} ORDER BY guardian_id;`).sort(), '응답 내역').toEqual(
        [[run.ga.id, a], [run.gb.id, b]].sort(),
      );
    }
    // 같은 보호자가 같은 답을 동시에 2번: 오류 없이 한 표
    const [d1, d2] = await Promise.all([feedback(run.gaApi, id, 'REAL'), feedback(run.gaApi, id, 'REAL')]);
    expect([d1.status, d2.status], '같은 답 동시 2번').toEqual([200, 200]);
    expect(psqlRows(`SELECT count(*) FROM anomaly_incident_feedback WHERE incident_id = ${id} AND guardian_id = ${sqlStr(run.ga.id)};`)[0][0], '같은 보호자는 한 표').toBe('1');
    // 동수 상태로 맞춘다(A=REAL, B=FALSE_ALARM)
    expect((await feedback(run.gbApi, id, 'FALSE_ALARM')).json.data?.reviewStatus).toBe('CONFLICTED');
    expect(incidentRow(id)?.review).toBe('CONFLICTED');
    // 이후 감지가 와도 판정을 PENDING 으로 되돌리지 않는다
    const e0 = incidentRow(id)!.eventCount;
    await waitEventCount(id, e0 + 1, 200_000);
    expect(incidentRow(id)?.review, '새 감지 뒤에도 판정 유지').toBe('CONFLICTED');
    const history = await run.gaApi.get<{ content: { incidentId: number; reviewStatus: string }[] }>(`/api/guardian/anomaly/history?wardId=${run.ward.id}`);
    expect(history.content.find(i => i.incidentId === id)?.reviewStatus).toBe('CONFLICTED');
  });

  test('CAM-N40 오탐 판정 시 클립 숨김, 알림은 취소 안 함', TAGS, async () => {
    test.setTimeout(900_000);
    const run = await getClipRun();
    const id = run.incident.incidentId;
    const oldIds = (await guardianClipList(run.gaApi, id)).items.map(c => c.clipId);
    expect(oldIds.length, '시작 전 클립 1개 이상').toBeGreaterThan(0);
    // 엇갈림(CONFLICTED)일 때는 숨기지 않는다
    expect(incidentRow(id)?.review).toBe('CONFLICTED');
    expect((await guardianClipList(run.gaApi, id)).items.map(c => c.clipId), '엇갈림이면 클립이 보인다').toEqual(oldIds);

    // 다수가 오탐: 숨김
    const tVerdict = new Date().toISOString();
    // B 는 이미 FALSE_ALARM 이라 A 도 FALSE_ALARM 으로 바꾸면 2:0
    expect((await feedback(run.gaApi, id, 'FALSE_ALARM')).json.data?.reviewStatus).toBe('FALSE_ALARM');
    expect(incidentRow(id)?.review).toBe('FALSE_ALARM');
    const hiddenList = await guardianClipList(run.gaApi, id);
    expect(hiddenList.items, '오탐 판정 뒤 목록은 비어 있다').toEqual([]);
    for (const clipId of oldIds) {
      const file = await errOf(await run.gaApi.raw('GET', `/api/guardian/anomaly/clips/${clipId}/file`));
      expect(file.status, '오탐으로 숨긴 클립 파일').toBe(404);
      expect(file.code).toBe('ANOMALY_CLIP_NOT_FOUND');
    }
    expect(psqlRows(`SELECT count(*) FROM anomaly_clip WHERE incident_id = ${id} AND status = 'HIDDEN' AND hidden_at IS NOT NULL;`)[0][0], 'DB 에서 HIDDEN + hidden_at').toBe(String(oldIds.length));
    // 이미 보낸 알림을 취소하거나 정정하는 알림을 더 보내지 않는다(감지·동수 안내 종류만 있다)
    // 비동기 알림이 늦게 쌓일 수 있어 고정 3초 대신, 판정 뒤 다음 감지가 기록될 때까지 기다린 뒤 확인한다
    await waitEventCount(id, incidentRow(id)!.eventCount + 1, 200_000);
    const extra = psqlRows(`SELECT DISTINCT type FROM notification_log WHERE ward_id = ${sqlStr(run.ward.id)} AND created_at >= ${sqlStr(tVerdict)}::timestamptz
                            AND type NOT IN ('ANOMALY_DETECTED', 'ANOMALY_DETECTED_SELF', 'ANOMALY_REVIEW_CONFLICTED');`);
    expect(extra, '오탐 판정 뒤 정정·취소 알림은 없다').toEqual([]);

    // 판정이 바뀌면 숨김 해제(1:1 엇갈림도 숨기지 않는다)
    expect((await feedback(run.gaApi, id, 'REAL')).json.data?.reviewStatus).toBe('CONFLICTED');
    expect((await guardianClipList(run.gaApi, id)).items.map(c => c.clipId), '판정이 바뀌면 클립이 다시 보인다').toEqual(oldIds);
    expect(psqlRows(`SELECT count(*) FROM anomaly_clip WHERE incident_id = ${id} AND status = 'VISIBLE' AND hidden_at IS NULL;`)[0][0]).toBe(String(oldIds.length));

    // 대기 중(PENDING) 상황은 숨기지 않는다(시드한 상황)
    const ward2 = mkUser('WARD', 'E2E클립대기본인');
    connect(run.ga.id, ward2.id);
    const sid2 = `e2e-p1a-${Math.random().toString(36).slice(2, 10)}`;
    const pendingId = seedIncident({ wardId: ward2.id, sessionId: sid2 });
    seedClip({ incidentId: pendingId, wardId: ward2.id, sessionId: sid2 });
    expect((await guardianClipList(run.gaApi, pendingId)).items.length, '대기 중 상황의 클립은 보인다').toBe(1);

    // 다시 오탐(2:0) -> 숨김. 판정 뒤 같은 상황에서 새로 저장된 클립은 보인다
    expect((await feedback(run.gaApi, id, 'FALSE_ALARM')).json.data?.reviewStatus).toBe('FALSE_ALARM');
    expect((await guardianClipList(run.gaApi, id)).items).toEqual([]);
    redis('DEL', `anomaly:clip:${run.camera.sessionId}:FIRE`);
    await expect
      .poll(async () => (await guardianClipList(run.gaApi, id)).items.filter(c => !oldIds.includes(c.clipId)).length, {
        timeout: 240_000,
        intervals: [5_000],
        message: '판정 뒤 같은 상황에서 새로 저장된 클립이 목록에 나오지 않았다(감지 -> 클립까지 최대 4분 기다림)',
      })
      .toBeGreaterThan(0);
    const fresh = (await guardianClipList(run.gaApi, id)).items.find(c => !oldIds.includes(c.clipId))!;
    expect((await run.gaApi.raw('GET', `/api/guardian/anomaly/clips/${fresh.clipId}/file`)).status(), '판정 뒤 새 클립 파일').toBe(200);
    expect(incidentRow(id)?.review, '새 클립이 생겨도 판정은 FALSE_ALARM 그대로').toBe('FALSE_ALARM');
    expect(psqlRows(`SELECT count(*) FROM anomaly_clip WHERE incident_id = ${id} AND status = 'HIDDEN';`)[0][0], '이전 클립은 계속 숨김').toBe(String(oldIds.length));
    test.info().annotations.push({ type: '확인하지 못한 부분', description: '"오탐 24시간 뒤 실제 삭제"는 매일 05:00(KST) 청소 스케줄러가 해서 기다릴 수 없어 확인하지 못했다(숨김은 즉시, API 로는 404)' });
  });
});

test.describe('카메라·이상감지 P1a - 상황 묶기', () => {
  test('CAM-N31 10분 안 같은 카메라·종류는 한 상황', TAGS, async () => {
    test.setTimeout(600_000);
    const run = await getClipRun();
    const id = run.incident.incidentId;
    const e0 = incidentRow(id)!.eventCount;
    expect(e0, '앞 테스트들에서 이미 여러 번 이어서 감지됐다').toBeGreaterThanOrEqual(2);
    // 시작이 55분 전(같은 KST 날짜 안)이어도 마지막 감지 기준으로 이어진다 - 1시간 이어지는 감지를 시작 시각 조정으로 만든다
    psqlRows(`UPDATE anomaly_incident SET started_at = greatest(now() - interval '55 minutes', (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul') + interval '1 minute') WHERE id = ${id} RETURNING id;`);
    const spanMin = Number(psqlRows(`SELECT extract(epoch from (last_detected_at - started_at))::int / 60 FROM anomaly_incident WHERE id = ${id};`)[0][0]);
    test.info().annotations.push({ type: '이어진 길이', description: `시작~마지막 감지 ${spanMin}분(자정 가까운 시각이면 55분보다 짧을 수 있다)` });
    await waitEventCount(id, e0 + 1, 200_000);

    const sessionIncidents = psqlRows(`SELECT id FROM anomaly_incident WHERE ward_id = ${sqlStr(run.ward.id)} AND session_id = ${sqlStr(run.camera.sessionId)} AND detected_type = 'FIRE';`);
    expect(sessionIncidents.map(r => Number(r[0])), '같은 카메라·종류의 상황은 1건').toEqual([id]);
    const events = Number(psqlRows(`SELECT count(*) FROM anomaly_event WHERE incident_id = ${id};`)[0][0]);
    expect(events, '감지 기록은 여러 줄').toBeGreaterThanOrEqual(e0 + 1);
    expect(incidentRow(id)!.eventCount, 'eventCount 가 감지 줄 수만큼 늘어난다').toBeGreaterThanOrEqual(e0 + 1);
    // 화면·통계 숫자는 상황 수
    const history = await run.gaApi.get<{ content: { incidentId: number; eventCount: number }[]; totalElements: number }>(`/api/guardian/anomaly/history?wardId=${run.ward.id}&type=FIRE`);
    expect(history.totalElements, '이력은 상황 1건').toBe(1);
    expect(history.content[0].eventCount).toBeGreaterThanOrEqual(e0 + 1);
    const summary = await run.gaApi.get<{ total: number; byType: { fire: number } }>(`/api/guardian/anomaly/history/summary?wardId=${run.ward.id}`);
    expect(summary.total, '요약 total 은 상황 수(감지 줄 수가 아님)').toBe(1);
    expect(summary.byType.fire).toBe(1);
  });

  test('CAM-N32 마지막 감지 10분 초과·자정·다른 카메라·종류는 새 상황', TAGS, async () => {
    test.setTimeout(600_000);
    const run = await getClipRun();
    const baseId = run.incident.incidentId;
    const wardId = run.ward.id;
    const sid = run.camera.sessionId;
    // 다른 카메라(같은 종류)·다른 종류(같은 카메라)의 상황을 최근 시각으로 시드한다
    const otherCam = seedIncident({ wardId, sessionId: `e2e-p1a-${Math.random().toString(36).slice(2, 10)}`, type: 'FIRE', lastAgoMin: 1 });
    const otherType = seedIncident({ wardId, sessionId: sid, type: 'WEAPON', lastAgoMin: 1 });
    const snap = (i: number) => psqlRows(`SELECT event_count, extract(epoch from last_detected_at)::bigint FROM anomaly_incident WHERE id = ${i};`)[0].join('/');
    const before = { otherCam: snap(otherCam), otherType: snap(otherType) };
    const baseCount = incidentRow(baseId)!.eventCount;
    // 마지막 감지를 11분 전으로 돌린다
    psqlRows(`UPDATE anomaly_incident SET last_detected_at = now() - interval '11 minutes', started_at = least(started_at, now() - interval '11 minutes') WHERE id = ${baseId} RETURNING id;`);
    const fireIncidents = () => psqlRows(`SELECT id FROM anomaly_incident WHERE ward_id = ${sqlStr(wardId)} AND session_id = ${sqlStr(sid)} AND detected_type = 'FIRE' ORDER BY id;`).map(r => Number(r[0]));
    await expect.poll(() => fireIncidents().length, { timeout: 200_000, intervals: [5_000], message: '마지막 감지 11분 뒤의 새 감지가 새 상황으로 갈라지지 않았다' }).toBe(2);
    const [oldId, newId] = fireIncidents();
    expect(oldId).toBe(baseId);
    expect(newId, '새 상황 번호').toBeGreaterThan(baseId);
    expect(incidentRow(baseId)!.eventCount, '이전 상황에는 새 감지가 더해지지 않는다').toBe(baseCount);
    expect(incidentRow(newId)!.eventCount, '새 상황의 감지 횟수').toBeGreaterThanOrEqual(1);
    // 다른 카메라·다른 종류는 섞이지 않는다
    expect(snap(otherCam), '다른 카메라의 상황은 그대로').toBe(before.otherCam);
    expect(snap(otherType), '같은 카메라 다른 종류(WEAPON)의 상황은 그대로').toBe(before.otherType);
    const history = await run.gaApi.get<{ totalElements: number }>(`/api/guardian/anomaly/history?wardId=${wardId}&type=FIRE`);
    expect(history.totalElements, '화재 상황 3건(지금 카메라의 이전·새 상황 2건 + 다른 카메라 1건)').toBe(3);
    test.info().annotations.push({ type: '확인하지 못한 부분', description: 'KST 자정(23:59 -> 00:01) 경계는 실제 시각이 그 때여야 만들 수 있어 확인하지 못했다(코드: AnomalyIncidentService.isContinuation 이 KST 날짜를 비교)' });
  });
});

test.describe('카메라·이상감지 P1a - 수동 확인(fixme)', () => {
  test.fixme('CAM-A38 클립 생성 실패는 이력·알림에 영향 없음', TAGS, async () => {
    // AI 클립 API 가 422·25초 타임아웃·500 으로 실패하게 만들 수 없다: BE 가 부르는 AI 주소·키는 서버 설정이고(변경 금지),
    // QA 쪽에서 BE-AI 사이 응답을 바꿀 길이 없다(AI 서버·컨테이너 조작 금지). 정상 응답만 받는 dev 에서는 실패 경로가 열리지 않는다.
    // 확인할 내용: 이력·알림은 정상, 클립 재시도 없음(422 포함), 클립 목록 비어 있음, 25초 마감은 전용 데몬 스레드가 끊음(BE 278-279, 1917-1924)
    // 수동 확인: BE 통합 테스트(AnomalyClipIntegrationTest·AnomalyClipExecutorSaturationTest)가 같은 경로를 다룬다
  });

  test.fixme('CAM-N47 낙상 클립은 앞 8초+뒤 1초', TAGS, async () => {
    // 낙상 신호를 만들 수 없다: 낙상 모델·샘플 사진이 QA 가 쓸 수 있는 곳에 없다(CAM-N23 과 같은 이유 - AI FALL_ENABLED 기본 꺼짐,
    // 6초 유지 조건, 신호 주입 경로는 BE 가 AI 서버에 거는 WebSocket 뿐). 클립 요청 파라미터(앞 8·뒤 1, AI 계약 범위 앞 0~8/뒤 0~3/합계 1~10)는
    // BE 안에서 AI 로 나가는 요청이라 밖에서 관찰할 수도 없다.
    // 확인할 내용: 낙상 클립 약 3.4MB, 앞 8초·뒤 1초, 화재·흉기는 3/2(BE 277-279, 1913-1917)
  });
});

test.describe('카메라·이상감지 P1a - 클립이 지워지는 길', () => {
  test('CAM-N50 클립이 지워지는 5가지 길', TAGS, async () => {
    test.setTimeout(600_000);
    const run = await getClipRun();
    const id = run.incident.incidentId;
    const sid = run.camera.sessionId;
    await run.fire.stop();

    // (4) 카메라 삭제: 행과 파일이 함께 사라진다
    const rowsBefore = psqlRows(`SELECT id, file_name FROM anomaly_clip WHERE session_id = ${sqlStr(sid)} AND ward_id = ${sqlStr(run.ward.id)};`);
    expect(rowsBefore.length, '삭제 전 클립 행(숨김 포함)').toBeGreaterThan(0);
    for (const [, fileName] of rowsBefore) expect(clipFileSize(fileName), `삭제 전 파일 ${fileName}`).not.toBeNull();
    expect((await run.wardApi.raw('DELETE', `/api/ward/camera/${run.camera.id}`)).status(), '카메라 삭제').toBe(200);
    await expect
      .poll(() => Number(psqlRows(`SELECT count(*) FROM anomaly_clip WHERE session_id = ${sqlStr(sid)} AND ward_id = ${sqlStr(run.ward.id)};`)[0][0]), { timeout: 90_000, intervals: [3_000], message: '카메라를 지웠는데 클립 행이 남아 있다' })
      .toBe(0);
    await expect
      .poll(() => rowsBefore.every(([, fileName]) => clipFileSize(fileName) === null), { timeout: 90_000, intervals: [3_000], message: '카메라를 지웠는데 클립 파일이 남아 있다' })
      .toBe(true);
    const gone = await errOf(await run.gaApi.raw('GET', `/api/guardian/anomaly/clips/${rowsBefore[0][0]}/file`));
    expect(gone.status, '삭제된 카메라의 클립 파일').toBe(404);
    expect(incidentRow(id), '카메라를 지워도 상황(이력)은 남는다').toBeDefined();

    // (3) 피보호자 탈퇴: 그 피보호자의 클립 행이 지워진다(시드 행이라 파일은 없다. 외래키 연쇄 삭제와 구분되지 않아 행 삭제만 확인)
    const ward2 = mkUser('WARD', 'E2E클립탈퇴본인');
    const g2 = mkUser('GUARDIAN', 'E2E클립탈퇴보호자');
    connect(g2.id, ward2.id);
    const sid2 = `e2e-p1a-${Math.random().toString(36).slice(2, 10)}`;
    const inc2 = seedIncident({ wardId: ward2.id, sessionId: sid2 });
    seedClip({ incidentId: inc2, wardId: ward2.id, sessionId: sid2 });
    seedClip({ incidentId: inc2, wardId: ward2.id, sessionId: sid2, status: 'HIDDEN' });
    const w2 = await loginUser(ward2);
    const res = await w2.api.raw('DELETE', '/api/user/me', { password: ward2.password });
    expect(res.status(), `탈퇴 응답 ${res.status()}`).toBe(200);
    await expect
      .poll(() => Number(psqlRows(`SELECT count(*) FROM anomaly_clip WHERE ward_id = ${sqlStr(ward2.id)};`)[0][0]), { timeout: 90_000, intervals: [3_000], message: '탈퇴 뒤 클립 행이 남아 있다' })
      .toBe(0);

    // (1) 보관 30일·(2) 오탐 24시간: 물리 삭제는 매일 05:00(KST) 스케줄러라 기다릴 수 없다. API 에서 안 보이는 것은 CAM-A37 이 확인한다.
    // (5) 고아 파일 청소(매시 15분 KST)도 스케줄러라 시각을 기다려야 한다.
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: '보관 30일 경과·오탐 24시간 경과 클립의 물리 삭제(매일 05:00 KST)와 고아 파일 청소(매시 15분 KST)는 스케줄러 시각을 기다려야 해서 확인하지 못했다. 카메라 삭제(행+파일)와 탈퇴(행)는 확인했다',
    });
    await cleanupAll();
  });
});
