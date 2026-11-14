/**
 * 최종 QA - 카메라·이상감지(CAM) P0 - API·권한·AI 서버 인증 묶음
 *
 * 임시 사용자만 쓴다. 카메라를 만드는 케이스(A05, A11, N03)는 만든 카메라를 바로 지운다(서비스 전체 상한 3대).
 * 카메라 상한은 서비스 전체 공용 값이다: A11·N03 은 시작할 때 남은 자리를 확인해 없으면 이유를 남기고 건너뛴다.
 * A05 는 전체를 3대까지 채우는 케이스라 짧게 끝내고 바로 지운다. 그동안 다른 영역·실사용자의 등록이 409 로 막히므로
 * 실행 안내: CAM 테스트는 다른 영역과 동시에 돌리지 않는다.
 * AI 서버 직접 호출은 공개 주소로 키 없이/틀린 키로 보내는 거부 확인만 한다(AI 키는 QA 환경에 없다).
 */
import { request } from '@playwright/test';

import { Api } from '../../../src/api';
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { countBackendLog } from '../../../src/remote';
import { Camera, errOf, expectErr, freeRoom, skipUnlessCameraSlot, sleep, totalCameras } from './_helpers-cam';

const TAGS = { tag: ['@P0', '@CAM'] };

test.describe.configure({ mode: 'serial' });

/** AI 서버 공개 주소(FE 번들의 NEXT_PUBLIC_AI_API_DOMAIN 값). 다르면 E2E_AI_URL 로 바꾼다 */
const AI_URL = process.env.E2E_AI_URL ?? 'https://testai.gosky.kr';

test.describe('카메라·이상감지 P0 - API·권한', () => {
  test('CAM-N03 송출 시작 전에 카메라가 먼저 등록된다', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(150_000);
    skipUnlessCameraSlot();
    const ward = await tempUser('WARD');
    const w = await loginAs(ward);
    const page = await openAs(w.who, null);

    // AI 서버(FE 프록시) 호출은 흉내 낸다 - 이 케이스는 "등록 -> 송출" 순서만 본다
    const calls: { method: string; kind: 'register' | 'session' | 'other'; body: string }[] = [];
    page.on('request', r => {
      if (r.method() !== 'POST') return;
      if (/\/api\/ward\/camera$/.test(r.url())) calls.push({ method: 'POST', kind: 'register', body: r.postData() ?? '' });
      else if (/\/api\/streams\/v1\/stream-sessions$/.test(r.url())) calls.push({ method: 'POST', kind: 'session', body: r.postData() ?? '' });
    });
    await page.route('**/api/streams/**', route => {
      const url = route.request().url();
      if (/stream-sessions$/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session_id: 'e2e_stub', status: 'running' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    let cameraId: number | undefined;
    try {
      await page.goto('/ward/camera');
      await page.getByRole('button', { name: /이 기기를 카메라로 등록/ }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('radiogroup', { name: '방 선택' }).getByRole('button', { name: '거실' }).click();
      await dialog.getByRole('button', { name: '다음', exact: true }).click();
      await dialog.getByRole('button', { name: '이렇게 놓았어요' }).click();
      await dialog.getByRole('radiogroup', { name: '촬영 방식' }).getByRole('radio').first().click();
      await dialog.getByRole('button', { name: '다음', exact: true }).click();
      const start = dialog.getByRole('button', { name: '등록하고 촬영 시작' });
      await expect(start).toBeEnabled({ timeout: 30_000 });

      // 먼저 등록이 실패하는 경우(409 상한·연결 끊김. 5xx 응답은 화면 감시기가 서버 오류로 세므로 연결 자체를 끊는다): 송출(AI 세션 생성)을 시작하지 않고 경고를 보여야 한다
      let failMode: 409 | 'abort' | null = 409;
      await page.route(/\/api\/ward\/camera$/, async route => {
        if (route.request().method() !== 'POST' || !failMode) return route.fallback();
        if (failMode === 'abort') return route.abort('failed');
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'CAMERA_LIMIT_REACHED', message: '카메라를 더 등록할 수 없습니다.' }) });
      });
      for (const mode of [409, 'abort'] as const) {
        failMode = mode;
        await expect(start).toBeEnabled({ timeout: 15_000 });
        await start.click();
        const alert = dialog.getByRole('alert');
        if (mode === 409) await expect(alert.filter({ hasText: '카메라를 더 등록할 수 없어요' }), '등록 409 경고 문구').toBeVisible({ timeout: 15_000 });
        else await expect(alert.first(), '등록 연결 끊김 경고').toBeVisible({ timeout: 15_000 });
        test.info().annotations.push({ type: `등록 ${mode} 경고`, description: ((await alert.first().textContent()) ?? '').trim().slice(0, 80) });
        await sleep(1_500);
        expect(calls.filter(c => c.kind === 'session'), `등록이 ${mode} 으로 실패했는데 송출(AI 세션 생성) 요청이 나갔다`).toEqual([]);
        expect(await w.api.get<Camera[]>('/api/ward/camera'), `등록 ${mode} 실패 뒤 카메라가 만들어졌다`).toHaveLength(0);
      }
      failMode = null; // 이제부터는 실제 등록
      await expect(start).toBeEnabled({ timeout: 15_000 });
      await start.click();

      await expect.poll(() => calls.some(c => c.kind === 'session'), { timeout: 30_000, message: '송출(AI 세션 생성) 요청이 나가야 한다' }).toBe(true);
      const mine = await w.api.get<Camera[]>('/api/ward/camera');
      expect(mine, '카메라가 BE 에 등록돼 있어야 한다').toHaveLength(1);
      cameraId = mine[0].id;

      const registerIndex = calls.findIndex(c => c.kind === 'register');
      const sessionIndex = calls.findIndex(c => c.kind === 'session');
      expect(registerIndex, '카메라 등록(POST /api/ward/camera) 요청이 있어야 한다').toBeGreaterThanOrEqual(0);
      expect(registerIndex, '등록이 송출 시작보다 먼저여야 한다').toBeLessThan(sessionIndex);
      const sessionBody = JSON.parse(calls[sessionIndex].body) as { sessionId?: string; cameraIdentifier?: string };
      expect(sessionBody.sessionId, '송출 세션 ID 는 등록 응답의 sessionId 와 같다').toBe(mine[0].sessionId);
      expect(sessionBody.cameraIdentifier, '송출 식별값은 등록 응답의 deviceId 와 같다').toBe(mine[0].deviceId);
    } finally {
      const cams = await w.api.get<Camera[]>('/api/ward/camera').catch(() => [] as Camera[]);
      for (const c of cams) await w.api.raw('DELETE', `/api/ward/camera/${c.id ?? cameraId}`).catch(() => undefined);
    }
  });

  test('CAM-A05 서비스 전체 3대 초과 등록은 409', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const filled: { api: Api; id: number }[] = [];
    try {
      // 전체가 3대가 될 때까지 임시 피보호자 카메라로 채운다 (다른 사용자·사용 중지 포함 전체 합산)
      const first = await loginAs(await tempUser('WARD'));
      let owner = first;
      while (totalCameras() < 3) {
        const w = filled.length === 0 ? first : await loginAs(await tempUser('WARD'));
        const cam = await w.api.post<Camera>('/api/ward/camera', { label: '거실' });
        filled.push({ api: w.api, id: cam.id });
        owner = w;
        if (filled.length > 3) throw new Error('카메라를 3대까지 채우지 못했다');
      }
      if (filled.length === 0) {
        // 이미 3대 이상이어도 내 카메라 없이 검사할 수 있다 - 같은 방 검사만 건너뛴다
        owner = first;
      }
      expect(totalCameras(), '준비: 전체 3대 이상').toBeGreaterThanOrEqual(3);

      const fresh = await loginAs(await tempUser('WARD'));

      // 1) 방 오류(400)가 가장 먼저
      expectErr(await errOf(await fresh.api.raw('POST', '/api/ward/camera', { label: '없는방' })), 400, 'CAMERA_ROOM_INVALID', '목록에 없는 방');
      // 2) 같은 방(409 CAMERA_LABEL_DUPLICATED)이 상한보다 먼저 - 내 카메라가 있는 방에 다른 기기로 등록
      if (filled.length > 0) {
        expectErr(await errOf(await owner.api.raw('POST', '/api/ward/camera', { label: '거실' })), 409, 'CAMERA_LABEL_DUPLICATED', '같은 방');
      }
      // 3) 상한(409 CAMERA_LIMIT_REACHED), 문구에 숫자 없음
      const limit = await errOf(await fresh.api.raw('POST', '/api/ward/camera', { label: '거실' }));
      expectErr(limit, 409, 'CAMERA_LIMIT_REACHED', '상한 초과');
      expect(limit.message ?? '', '상한 문구에 숫자가 없어야 한다').not.toMatch(/\d/);
      expect(totalCameras(), '거절된 등록은 카메라를 만들지 않는다').toBeGreaterThanOrEqual(3);
      expect((await fresh.api.get<Camera[]>('/api/ward/camera')).length).toBe(0);
    } finally {
      for (const f of filled) await f.api.raw('DELETE', `/api/ward/camera/${f.id}`).catch(() => undefined);
    }
  });

  test('CAM-A09 로그인 없이 카메라 API·프록시 접근은 401', TAGS, async () => {
    const anon = await request.newContext({ baseURL: env.apiUrl });
    const fe = await request.newContext({ baseURL: env.baseUrl });
    try {
      const targets: [string, string, unknown?][] = [
        ['GET', '/api/ward/camera'],
        ['GET', '/api/ward/camera/rooms'],
        ['GET', '/api/ward/camera/live'],
        ['POST', '/api/ward/camera', { label: '거실' }],
        ['PATCH', '/api/ward/camera/1', { label: '침실' }],
        ['DELETE', '/api/ward/camera/1'],
        ['GET', '/api/ward/camera/1/latest-frame'],
        ['GET', '/api/guardian/camera'],
        ['GET', '/api/guardian/camera/live'],
        ['GET', '/api/guardian/camera/e2e_none/status'],
        ['GET', '/api/guardian/camera/e2e_none/latest-frame'],
        ['POST', '/api/guardian/camera/e2e_none/stream-ticket'],
        ['GET', '/api/ward/anomaly/1/clips'],
        ['GET', '/api/ward/anomaly/clips/1/file'],
        ['GET', '/api/guardian/anomaly/history'],
        ['GET', '/api/guardian/anomaly/history/summary'],
        ['POST', '/api/guardian/anomaly/1/feedback', { verdict: 'REAL' }],
        ['GET', '/api/guardian/anomaly/1/clips'],
        ['GET', '/api/guardian/anomaly/clips/1/file'],
      ];
      const wrong: string[] = [];
      for (const [method, path, data] of targets) {
        const res = await anon.fetch(path, { method, data });
        if (res.status() !== 401) wrong.push(`${method} ${path} -> ${res.status()}`);
      }
      expect(wrong, '로그인 없이 401 이 아닌 응답').toEqual([]);

      // 영상 열기: 티켓이 없으면 401 CAMERA_STREAM_TICKET_INVALID
      const mjpeg = await errOf(await anon.get('/api/camera/stream/e2e_none/mjpeg'));
      expectErr(mjpeg, 401, 'CAMERA_STREAM_TICKET_INVALID', 'mjpeg 티켓 없음');

      // FE 프록시: 로그인 없이는 만들기가 401, 조회성 경로(예전 /live-streams)는 열려 있지 않다
      const create = await fe.post('/api/streams/v1/stream-sessions', { data: { sessionId: 'e2e_anon', cameraIdentifier: 'e2e_anon' } });
      expect(create.status(), `프록시 세션 생성이 로그인 없이 ${create.status()}`).toBe(401);
      const list = await fe.get('/api/streams/v1/live-streams');
      expect([401, 404, 405], `프록시 목록 조회가 ${list.status()} 로 열려 있다`).toContain(list.status());
      test.info().annotations.push({ type: 'FE 프록시', description: `POST 세션 생성 ${create.status()}, GET 목록 ${list.status()}(조회성 경로는 BE 로 옮겨져 GET 은 405)` });
    } finally {
      await anon.dispose();
      await fe.dispose();
    }
  });

  // 관리자 이상감지 로그에 클립 정보가 없는지는 임시 피보호자 기록이 필요해 화재 묶음(cam-p0-fire.spec.ts)의 CAM-A10 에서 확인한다
  test('CAM-A10 역할이 다르면 403', TAGS, async ({ tempUser, loginAs }) => {
    const ward = await loginAs(await tempUser('WARD'));
    const guardian = await loginAs(await tempUser('GUARDIAN'));
    const admin = await loginAs(await tempUser('ADMIN'));

    const wrong: string[] = [];
    const check = async (who: string, api: Api, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown) => {
      const res = await api.raw(method, path, data);
      if (res.status() !== 403) wrong.push(`${who} ${method} ${path} -> ${res.status()}`);
    };
    // 보호자 토큰으로 피보호자 카메라 계열
    for (const [m, p, d] of [
      ['GET', '/api/ward/camera'],
      ['GET', '/api/ward/camera/rooms'],
      ['GET', '/api/ward/camera/live'],
      ['POST', '/api/ward/camera', { label: '거실' }],
      ['PATCH', '/api/ward/camera/1', { label: '침실' }],
      ['DELETE', '/api/ward/camera/1'],
      ['GET', '/api/ward/camera/1/latest-frame'],
      ['GET', '/api/ward/anomaly/1/clips'],
    ] as ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?][]) await check('보호자', guardian.api, m, p, d);
    // 피보호자 토큰으로 보호자 카메라 계열·티켓 발급·판정
    for (const [m, p, d] of [
      ['GET', '/api/guardian/camera'],
      ['GET', '/api/guardian/camera/live'],
      ['GET', '/api/guardian/camera/e2e_none/status'],
      ['GET', '/api/guardian/camera/e2e_none/latest-frame'],
      ['POST', '/api/guardian/camera/e2e_none/stream-ticket'],
      ['POST', '/api/guardian/anomaly/1/feedback', { verdict: 'REAL' }],
      ['GET', '/api/guardian/anomaly/history'],
    ] as ['GET' | 'POST' | 'PATCH' | 'DELETE', string, unknown?][]) await check('피보호자', ward.api, m, p, d);
    // 관리자는 클립을 열 수 없다
    for (const p of ['/api/guardian/anomaly/1/clips', '/api/guardian/anomaly/clips/1/file', '/api/ward/anomaly/1/clips', '/api/ward/anomaly/clips/1/file']) {
      await check('관리자', admin.api, 'GET', p);
    }
    expect(wrong, '403 이 아닌 응답').toEqual([]);
  });

  test('CAM-A11 남의 카메라 수정·삭제·정지 화면은 403, 없는 카메라는 404', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(150_000);
    const a = await loginAs(await tempUser('WARD'));
    const b = await loginAs(await tempUser('WARD'));
    skipUnlessCameraSlot();
    const camera = await a.api.post<Camera>('/api/ward/camera', { label: '거실' });
    try {
      const results = {
        patch: await errOf(await b.api.raw('PATCH', `/api/ward/camera/${camera.id}`, { label: '침실' })),
        del: await errOf(await b.api.raw('DELETE', `/api/ward/camera/${camera.id}`)),
        frame: await errOf(await b.api.raw('GET', `/api/ward/camera/${camera.id}/latest-frame`)),
      };
      for (const [name, r] of Object.entries(results)) {
        expectErr(r, 403, 'CAMERA_NOT_AUTHORIZED', name);
        expect(r.message, name).toBe('본인이 등록한 카메라만 사용할 수 있습니다.');
        expect(r.raw, `${name} 응답에 방 이름·세션ID 가 없어야 한다`).not.toContain(camera.sessionId);
        expect(r.raw, `${name} 응답에 방 이름이 없어야 한다`).not.toContain('거실');
      }
      // 시도는 [IDOR-ATTEMPT] WARN 로그로 남는다
      await expect.poll(() => countBackendLog(`타인 카메라 접근 시도: wardId=${b.user.id}`), { timeout: 20_000 }).toBeGreaterThan(0);
      // 없는 카메라는 404
      for (const [method, path, data] of [
        ['PATCH', '/api/ward/camera/999999999', { label: '침실' }],
        ['DELETE', '/api/ward/camera/999999999', undefined],
        ['GET', '/api/ward/camera/999999999/latest-frame', undefined],
      ] as ['PATCH' | 'DELETE' | 'GET', string, unknown][]) {
        expect((await errOf(await b.api.raw(method, path, data))).status, `${method} 없는 카메라`).toBe(404);
      }
      // 내 카메라는 그대로
      expect((await a.api.get<Camera[]>('/api/ward/camera')).map(c => c.label)).toEqual(['거실']);
    } finally {
      await a.api.raw('DELETE', `/api/ward/camera/${camera.id}`).catch(() => undefined);
      void freeRoom;
    }
  });

  test('CAM-A20 FE 무인증 프록시와 AI 키·WS 주소 노출', TAGS, async ({ tempUser, loginAs, openAs }) => {
    // 1) 프록시: 로그인 없음 401, 보호자 로그인 403, 조회 경로는 열려 있지 않음
    const anon = await request.newContext({ baseURL: env.baseUrl });
    const guardian = await loginAs(await tempUser('GUARDIAN'));
    const asGuardian = await request.newContext({ baseURL: env.baseUrl, extraHTTPHeaders: { Cookie: `careai_access_token=${guardian.login.accessToken}` } });
    try {
      expect((await anon.post('/api/streams/v1/stream-sessions', { data: { sessionId: 'e2e_a20', cameraIdentifier: 'e2e_a20' } })).status()).toBe(401);
      expect((await anon.post('/api/streams/v1/stream-sessions/e2e_a20/frame')).status(), '로그인 없는 프레임 업로드').toBe(401);
      const guardianCreate = await asGuardian.post('/api/streams/v1/stream-sessions', { data: { sessionId: 'e2e_a20', cameraIdentifier: 'e2e_a20' } });
      expect(guardianCreate.status(), '보호자 로그인으로 송출 세션 만들기').toBe(403);
      for (const path of ['/api/streams/v1/live-streams', '/api/streams/v1/live-streams/e2e_a20/mjpeg', '/api/streams/v1/live-streams/e2e_a20/latest-frame', '/api/streams/v1/models']) {
        const res = await anon.get(path);
        expect([401, 404, 405], `로그인 없이 GET ${path} -> ${res.status()}`).toContain(res.status());
        expect(res.status(), `GET ${path} 가 열려 있다`).not.toBe(200);
      }
    } finally {
      await anon.dispose();
      await asGuardian.dispose();
    }

    // 2) 번들·연결: 보호자 화면과 피보호자 화면 모두에 AI 키·WS 직결 코드가 내려오지 않는다.
    // Next 는 환경변수 "이름"이 아니라 "값"을 번들에 넣으므로 이름(NEXT_PUBLIC_STREAM_WS_URL) 대신 값(wss:// AI 주소, /api/v1/ws/live)을 본다.
    const aiHost = new URL(AI_URL).host;
    const collect = async (who: Parameters<typeof openAs>[0], paths: string[], click?: (p: import('@playwright/test').Page) => Promise<void>) => {
      const page = await openAs(who, null);
      const scripts: string[] = [];
      const sockets: string[] = [];
      const reading: Promise<void>[] = [];
      page.on('response', r => {
        if (/\.js(\?|$)/.test(r.url()) && r.url().includes(new URL(env.baseUrl).host)) reading.push(r.text().then(t => void scripts.push(t), () => undefined));
      });
      page.on('websocket', ws => sockets.push(ws.url()));
      for (const p of paths) {
        await page.goto(p);
        if (click) await click(page).catch(() => undefined);
        await page.waitForTimeout(4_000);
      }
      await Promise.all(reading);
      return { all: scripts.join('\n'), sockets };
    };
    const noDirectAiCode = (all: string, where: string) => {
      expect(/x-api-key/i.test(all), `${where} 번들에 x-api-key 헤더 코드가 있다`).toBe(false);
      expect(/STREAM_API_KEY/.test(all), `${where} 번들에 STREAM_API_KEY 가 있다`).toBe(false);
      expect(all.includes('api/v1/ws/live'), `${where} 번들에 AI WebSocket 직결 주소(/api/v1/ws/live)가 있다`).toBe(false);
      expect(all.includes(`wss://${aiHost}`), `${where} 번들에 wss://${aiHost} 직결 주소가 있다`).toBe(false);
    };

    const g = await collect(guardian.who, ['/guardian/detection'], async p => {
      await p.getByRole('button', { name: /실시간 카메라 보기/ }).click();
    });
    expect(g.all.length, '준비: 보호자 화면 스크립트를 읽었다').toBeGreaterThan(100_000);
    noDirectAiCode(g.all, '보호자 화면');
    expect(g.all.includes(aiHost), `보호자 화면 번들에 AI 서버 주소(${aiHost})가 들어 있다`).toBe(false);
    expect(g.sockets.filter(u => u.includes(aiHost)), '보호자 화면이 AI 서버에 WebSocket 으로 직접 붙었다').toEqual([]);

    const ward = await loginAs(await tempUser('WARD'));
    const w = await collect(ward.who, ['/ward', '/ward/game', '/ward/camera']);
    expect(w.all.length, '준비: 피보호자 화면 스크립트를 읽었다').toBeGreaterThan(100_000);
    noDirectAiCode(w.all, '피보호자 화면');
    expect(w.sockets.filter(u => u.includes(aiHost)), '피보호자 화면이 AI 서버에 WebSocket 으로 직접 붙었다').toEqual([]);
    const wardHasAiHost = w.all.includes(aiHost);
    test.info().annotations.push({
      type: 'AI 주소 노출',
      description: `피보호자 화면 번들에 AI 서버 주소가 ${wardHasAiHost ? '들어 있다 - 게임 화면(WardGameContent)이 NEXT_PUBLIC_AI_API_DOMAIN 으로 게임 iframe(/api/v1/games/embed)을 열기 때문이며 설계상 공개 주소다(키는 없음)' : '없다'}. 보호자 화면에는 없다`,
    });
  });

  test('CAM-A43 X-API-Key 없음·틀림은 401 AUTH_INVALID_KEY', TAGS, async () => {
    const ctx = await request.newContext({ baseURL: AI_URL });
    try {
      const notes: string[] = [];
      let jsonChecked = 0;
      // 키가 필요한 경로(모델·카메라·분석·챗·송출 목록·예약 자격증명). 서버에 올라 있지 않은 경로(404)는 따로 적는다
      const targets: [string, string][] = [
        ['GET', '/api/v1/models'],
        ['GET', '/api/v1/cameras'],
        ['GET', '/api/v1/analysis/results'],
        ['GET', '/api/v1/chat/stats'],
        ['POST', '/api/v1/chat'],
        ['GET', '/api/v1/live-streams'],
        ['POST', '/api/v1/reservation-credentials'],
        ['GET', '/api/v1/games'], // 게임 목록은 게임 키가 필요하다(embed 는 공개)
      ];
      const notMounted: string[] = [];
      for (const [method, path] of targets) {
        for (const headers of [{}, { 'x-api-key': 'e2e-wrong-key' }] as Record<string, string>[]) {
          const res = await ctx.fetch(path, { method, headers, data: method === 'POST' ? {} : undefined });
          const contentType = res.headers()['content-type'] ?? '';
          const label = `${method} ${path} ${headers['x-api-key'] ? '틀린 키' : '키 없음'}`;
          if (res.status() === 404) {
            notMounted.push(label);
            continue;
          }
          expect(res.status(), label).toBe(401);
          if (contentType.includes('json')) {
            type Body = { success?: boolean; errorCode?: string; data?: unknown };
            const json = (await res.json()) as Body & { detail?: Body };
            const body: Body = json.detail ?? json;
            expect(body.success, label).toBe(false);
            expect(body.errorCode, label).toBe('AUTH_INVALID_KEY');
            expect(body.data ?? null, label).toBeNull();
            jsonChecked++;
          } else {
            notes.push(`${label}: ${contentType || '본문 없음'}`);
          }
        }
      }
      expect(notMounted.length, `확인한 경로가 모두 404 다(주소가 틀렸다): ${notMounted.join(', ')}`).toBeLessThan(targets.length * 2);
      if (notMounted.length) test.info().annotations.push({ type: '서버에 없는 경로(404)', description: notMounted.join(' | ') });
      test.info().annotations.push({
        type: jsonChecked ? '본문 형식' : '앱 응답 미확인',
        description: notes.length
          ? `JSON 이 아닌 응답(앞단 nginx 의 401 안내 페이지)이라 앱의 401 AUTH_INVALID_KEY 형식은 확인하지 못했다(JSON 으로 확인 ${jsonChecked}건): ${notes.join(' | ')}`
          : 'JSON 으로 모두 확인',
      });

      // 공개 경로: 게임 iframe(FE 피보호자 게임 화면이 쓴다)은 키 없이 200
      const embed = await ctx.get('/api/v1/games/embed?userId=1&gameSlug=maze');
      expect(embed.status(), '게임 embed 는 인증 없이 열린다').toBe(200);
      expect(embed.headers()['content-type'] ?? '', '게임 embed 는 HTML').toContain('text/html');
      // /health 는 공개 주소(nginx)가 열어 두지 않는다
      const health = await ctx.get('/health');
      test.info().annotations.push({ type: '/health', description: `공개 주소 GET /health -> ${health.status()}(문서의 "인증 없이 200"은 이 주소로 확인하지 못했다. nginx 가 앱 /health 를 열지 않음)` });
    } finally {
      await ctx.dispose();
    }
  });

  test('CAM-A44 WS 키 불일치는 close 1008 AUTH_INVALID_KEY', TAGS, async () => {
    const wsBase = AI_URL.replace(/^http/, 'ws');
    const attempt = (url: string, headers?: Record<string, string>) =>
      new Promise<{ opened: boolean; code?: number; reason?: string }>(resolve => {
        const result: { opened: boolean; code?: number; reason?: string } = { opened: false };
        const Ctor = WebSocket as unknown as new (u: string, init?: { headers: Record<string, string> }) => WebSocket;
        const ws = headers ? new Ctor(url, { headers }) : new Ctor(url);
        const timer = setTimeout(() => {
          try { ws.close(); } catch { /* 이미 닫힘 */ }
          resolve(result);
        }, 10_000);
        ws.onopen = () => { result.opened = true; };
        ws.onclose = e => { clearTimeout(timer); result.code = e.code; result.reason = e.reason; resolve(result); };
      });
    const urls = {
      키없음: { url: `${wsBase}/api/v1/ws/live`, headers: undefined as Record<string, string> | undefined },
      틀린헤더: { url: `${wsBase}/api/v1/ws/live`, headers: { 'x-api-key': 'e2e-wrong-key' } },
      틀린쿼리: { url: `${wsBase}/api/v1/ws/live?apiKey=e2e-wrong-key`, headers: undefined },
    };
    // 서버가 살아 있는지: 같은 주소에 HTTPS 로 핸드셰이크 GET(Upgrade 헤더 포함)을 보내 거절 응답(401/403)이 실제로 오는지 본다.
    // 응답이 없거나 연결 오류(DNS·TLS·서버 꺼짐)면 WebSocket close 1006 이 나오더라도 통과시키지 않는다.
    const ctx = await request.newContext({ baseURL: AI_URL });
    const handshake: Record<string, number> = {};
    try {
      for (const [name, u] of Object.entries(urls)) {
        const httpUrl = u.url.replace(/^ws/, 'http');
        const res = await ctx.get(httpUrl, {
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            ...(u.headers ?? {}),
          },
          maxRedirects: 0,
          timeout: 15_000,
        });
        handshake[name] = res.status();
        expect([401, 403], `${name}: HTTPS 핸드셰이크 응답 ${res.status()} (서버 응답이 없거나 연결 오류면 예외로 실패한다)`).toContain(res.status());
      }
    } finally {
      await ctx.dispose();
    }

    const results = {
      키없음: await attempt(urls.키없음.url),
      틀린헤더: await attempt(urls.틀린헤더.url, urls.틀린헤더.headers),
      틀린쿼리: await attempt(urls.틀린쿼리.url),
    };
    test.info().annotations.push({ type: '접속 결과', description: JSON.stringify({ close: results, 핸드셰이크: handshake }) });
    for (const [name, r] of Object.entries(results)) {
      expect(r.opened, `${name}: 틀린 키인데 연결이 열렸다`).toBe(false);
      // 앞단(nginx)이 핸드셰이크를 거절하면 WebSocket close 코드는 1006 으로 보인다. 위 HTTPS 응답으로 서버가 살아 있고 거절했음을 따로 확인했다
      expect([1008, 1006], `${name}: close ${r.code} ${r.reason}`).toContain(r.code);
    }
    test.info().annotations.push({
      type: '확인하지 못함',
      description: '앱의 close 1008 AUTH_INVALID_KEY 는 확인하지 못했다: 앞단 nginx 가 키 없음·틀린 헤더·틀린 쿼리 세 경우를 모두 같은 응답으로 막아 서로 구분할 수 없다. 올바른 키로 접속되는 부분도 QA 환경에 AI 키가 없어 확인하지 못했다',
    });
  });

  test.fixme('CAM-N55 라이브 WS 기본 동작(connected·ping·list·subscribe·unsubscribe)', TAGS, async () => {
    // 올바른 X-API-Key 가 있어야 접속할 수 있다. QA 환경(.env)에는 AI 키가 없고, 키를 서버에서 꺼내 쓰는 것은 금지다.
    // 키가 주어지면: /api/v1/ws/live 접속 -> connected -> {action:'ping'} -> pong -> {action:'list'} -> live_streams
    //   -> {action:'subscribe',sessionId} -> subscribed + session_status + latest_analysis 1회 -> {action:'unsubscribe'} -> unsubscribed
  });
});
