/**
 * 최종 QA - 카메라·이상감지(CAM) P1a - 실시간 보기(보호자 카메라 API)
 *
 * 임시 피보호자 1명 + 보호자 1명(연결) + 연결 안 된 보호자 1명 + 카메라 1대를 한 번 만들어 나눠 쓴다(getLive).
 * 카메라는 평범한 사진(회색)만 계속 보내 이상감지 알림이 가지 않게 한다.
 * serial: 앞 테스트가 만든 상태를 뒤 테스트가 이어 쓴다(마지막 N57·N54 는 송출을 멈춘다). A18 은 따로(카메라 불필요). A17(3대 필요)은 cam-p1a-viewlimit.spec.ts 로 옮겼다.
 * 끝나면 펌프·AI 세션·카메라·임시 사용자를 모두 지운다. 카메라 상한(서비스 전체 3대)이 공용이라 자리가 없으면 최대 10분 기다린다.
 */
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { countBackendLog, psqlRows, redis, sqlStr } from '../../../src/remote';
import { Api } from '../../../src/api';
import { Page } from '@playwright/test';
import {
  cleanupAll,
  connect,
  createAiSession,
  errOf,
  loginUser,
  Logged,
  mkUser,
  plainJpeg,
  postFrame,
  proxyFor,
  registerCamera,
  setConnections,
  sleep,
  startPump,
  stopAiSession,
  suppressAnomalySmsFallback,
  TAGS,
  trackCameraP1a,
  trackOwnRedisKey,
  waitForCameraSlots,
  Camera,
} from './_helpers-cam-p1a';
import { mjpegUrl, openStreamOnce } from './_helpers-cam';
import { APIRequestContext } from '@playwright/test';
import { TempUser } from '../../../src/seed';

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  livePromise = undefined;
  await cleanupAll();
});

interface Pre {
  noSession: { statusCode: number; statusValue?: string; analysisNull: boolean; frame: { status: number; code?: string }; ticketStatus: number; stream: { status: number; code?: string } };
  noFrame: { frame: { status: number; code?: string }; statusCode: number; statusValue?: string; analysis?: unknown };
}

interface Live {
  ward: TempUser;
  ga: TempUser;
  gb: TempUser;
  wl: Logged;
  gl: Logged;
  bl: Logged;
  proxy: APIRequestContext;
  camera: Camera;
  jpeg: Buffer;
  pre: Pre;
  pump: ReturnType<typeof startPump> | null;
  resume(): Promise<void>;
  pause(): Promise<void>;
}

let livePromise: Promise<Live> | undefined;
const getLive = () => (livePromise ??= startLive());

const statusUrl = (sid: string) => `/api/guardian/camera/${sid}/status`;
const frameUrl = (sid: string) => `/api/guardian/camera/${sid}/latest-frame`;
const ticketUrl = (sid: string) => `/api/guardian/camera/${sid}/stream-ticket`;

async function statusOf(api: Api, sid: string) {
  const res = await api.raw('GET', statusUrl(sid));
  const json = (await res.json().catch(() => ({}))) as { data?: { status?: string; analysis?: unknown; lastFrameAt?: string | null; fps?: number | null; isAnalyzing?: boolean | null } };
  return { status: res.status(), data: json.data };
}

async function startLive(): Promise<Live> {
  expect(await waitForCameraSlots(1), '카메라 상한(서비스 전체 3대)에 10분 안에 자리가 나지 않았다').toBe(true);
  const ward = mkUser('WARD', 'E2E실시간본인');
  const ga = mkUser('GUARDIAN', 'E2E실시간보호자');
  const gb = mkUser('GUARDIAN', 'E2E실시간남남');
  connect(ga.id, ward.id);
  suppressAnomalySmsFallback(ward.id);
  const wl = await loginUser(ward);
  const gl = await loginUser(ga);
  const bl = await loginUser(gb);
  const proxy = await proxyFor(wl.login);
  const jpeg = await plainJpeg();
  const camera = await registerCamera(wl.api);
  trackCameraP1a(wl.api, camera.id, camera.sessionId, proxy);
  const sid = camera.sessionId;

  // A14 용으로, AI 세션이 아직 없을 때(AI 가 모르는 카메라)의 응답을 먼저 모아 둔다
  const s0 = await statusOf(gl.api, sid);
  const f0 = await errOf(await gl.api.raw('GET', frameUrl(sid)));
  const t0 = await gl.api.raw('POST', ticketUrl(sid));
  const ticket0 = ((await t0.json()) as { data?: { ticket?: string } }).data?.ticket;
  const stream0 = ticket0 ? await openStreamOnce(mjpegUrl(sid, ticket0), 20_000) : { status: 0, code: undefined };
  const noSession: Pre['noSession'] = {
    statusCode: s0.status,
    statusValue: s0.data?.status,
    analysisNull: s0.data?.analysis === null || s0.data?.analysis === undefined,
    frame: { status: f0.status, code: f0.code },
    ticketStatus: t0.status(),
    stream: { status: stream0.status, code: stream0.code },
  };
  // AI 세션은 만들었지만 프레임이 아직 없을 때
  expect((await createAiSession(proxy, sid, camera.deviceId)).status(), 'AI 세션 생성(FE 프록시)').toBe(200);
  const f1 = await errOf(await gl.api.raw('GET', frameUrl(sid)));
  const s1 = await statusOf(gl.api, sid);
  const noFrame: Pre['noFrame'] = { frame: { status: f1.status, code: f1.code }, statusCode: s1.status, statusValue: s1.data?.status, analysis: s1.data?.analysis };

  expect((await postFrame(proxy, sid, jpeg)).status(), '첫 프레임').toBe(200);
  const tSub = Date.now();
  await wl.api.post<Camera>('/api/ward/camera', { label: camera.label, deviceId: camera.deviceId });
  let subscribed = false;
  while (Date.now() - tSub < 70_000) {
    if (countBackendLog(`세션 구독: sessionId=${sid}`, 120) > 0) {
      subscribed = true;
      break;
    }
    await sleep(2_000);
  }
  expect(subscribed, 'BE 가 새 AI 세션을 구독해야 한다').toBe(true);

  const live: Live = {
    ward, ga, gb, wl, gl, bl, proxy, camera, jpeg, pre: { noSession, noFrame }, pump: null,
    async resume() {
      expect((await createAiSession(proxy, sid, camera.deviceId)).status(), 'AI 세션 다시 만들기').toBe(200);
      expect((await postFrame(proxy, sid, jpeg)).status(), '프레임').toBe(200);
      live.pump = startPump(proxy, sid, jpeg, 300);
    },
    async pause() {
      await live.pump?.stop();
      live.pump = null;
    },
  };
  live.pump = startPump(proxy, sid, jpeg, 300);
  return live;
}

/** 열어 둔 영상 연결. 서버가 끊으면 ended 가 채워진다 */
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
  const res = await api.raw('POST', ticketUrl(sid));
  expect(res.status(), `티켓 발급 상태 ${res.status()}`).toBe(200);
  return ((await res.json()) as { data: { ticket: string } }).data.ticket;
}

async function collectTopic(page: Page, dest: string) {
  await page.evaluate(d => {
    const w = window as unknown as { __connectionStompClient: { subscribe: (d: string, cb: (m: { body: string }) => void) => void }; __p1a: Record<string, unknown[]> };
    w.__p1a = w.__p1a ?? {};
    w.__p1a[d] = [];
    w.__connectionStompClient.subscribe(d, m => w.__p1a[d].push({ t: Date.now(), body: JSON.parse(m.body) }));
  }, dest);
  return () => page.evaluate(d => ((window as unknown as { __p1a: Record<string, unknown[]> }).__p1a[d] ?? []) as { t: number; body: Record<string, unknown> }[], dest);
}

test.describe('카메라·이상감지 P1a - 실시간 보기', () => {
  test('CAM-N12 카메라 상태 조회', TAGS, async () => {
    test.setTimeout(900_000);
    const live = await getLive();
    const sid = live.camera.sessionId;
    await expect
      .poll(async () => (await statusOf(live.gl.api, sid)).data?.analysis != null, { timeout: 60_000, intervals: [2_000], message: '송출 중인데 60초 안에 analysis 가 채워지지 않았다' })
      .toBe(true);
    const res = await live.gl.api.raw('GET', statusUrl(sid));
    expect(res.status()).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(Object.keys(data).sort(), '응답 필드').toEqual(['analysis', 'fps', 'isAnalyzing', 'lastFrameAt', 'status']);
    expect(data.status).toBe('running');
    expect(typeof data.lastFrameAt, 'lastFrameAt').toBe('string');
    expect(typeof data.fps, 'fps').toBe('number');
    expect(typeof data.isAnalyzing, 'isAnalyzing').toBe('boolean');
    expect(typeof data.analysis, 'analysis 는 객체').toBe('object');
    expect(data.analysis, 'analysis 는 null 이 아님').not.toBeNull();
    expect(data.analysis, 'analysis 에 감지 종류').toHaveProperty('detectedType');
    expect(data.analysis, 'analysis 에 위험 여부').toHaveProperty('danger');
    // 분석이 없으면 analysis=null: AI 가 모르는 카메라(등록 직후, AI 세션 만들기 전)의 상태
    expect(live.pre.noSession.statusCode, 'AI 세션 만들기 전 상태 조회').toBe(200);
    expect(live.pre.noSession.statusValue, 'AI 가 모르면 offline').toBe('offline');
    expect(live.pre.noSession.analysisNull, 'AI 가 모르면 analysis=null').toBe(true);
  });

  test('CAM-N58 REST 조회 5종(목록·status·latest-analysis·latest-frame·mjpeg)', TAGS, async () => {
    const live = await getLive();
    const sid = live.camera.sessionId;
    // AI 서버 REST 5종(live-streams 목록·status·latest-analysis·latest-frame·mjpeg)은 X-API-Key 가 있어야 직접 부를 수 있다.
    // QA 환경에는 AI 키가 없고(서버에서 꺼내 쓰기 금지, FE 번들의 키도 쓰지 않음) FE 프록시는 송출 3경로만 연다.
    // 그래서 BE 중계 API 로 같은 5종이 동작하는지 본다. AI 직접 응답의 {success,message,data} 형식은 확인하지 못했다.
    const list = await live.gl.api.get<{ sessionId: string; status: string | null; lastFrameAt: string | null }[]>('/api/guardian/camera/live');
    const mine = list.find(c => c.sessionId === sid);
    expect(mine?.status, '목록(live-streams)에서 내 카메라').toBe('running');
    expect(mine?.lastFrameAt).toBeTruthy();
    const st = await statusOf(live.gl.api, sid);
    expect(st.status).toBe(200);
    expect(st.data?.status, 'status').toBe('running');
    expect(st.data, 'latest-analysis 는 status.analysis 로 나온다').toHaveProperty('analysis');
    const frame = await live.gl.api.raw('GET', frameUrl(sid));
    expect(frame.status(), 'latest-frame').toBe(200);
    expect(frame.headers()['content-type']).toContain('image/jpeg');
    const bytes = await frame.body();
    expect([...bytes.subarray(0, 3)], 'JPEG 1장(FF D8 FF)').toEqual([0xff, 0xd8, 0xff]);
    expect(frame.headers()['cache-control'] ?? '').toContain('no-store');
    const ticket = await issueTicket(live.gl.api, sid);
    const stream = await openStreamOnce(mjpegUrl(sid, ticket), 20_000);
    expect(stream.status, 'mjpeg').toBe(200);
    expect(stream.contentType, 'mjpeg 형식').toContain('multipart/x-mixed-replace');
    expect(stream.firstBytes, 'mjpeg 첫 조각').toBeGreaterThan(0);
    // FE 프록시(송출 경로)의 응답 형식은 직접 볼 수 있다: {success, data}
    const pf = await postFrame(live.proxy, sid, live.jpeg);
    expect(pf.status(), '프레임 올리기(FE 프록시)').toBe(200);
    const pfBody = (await pf.json()) as { success?: boolean; data?: unknown };
    expect(pfBody.success, 'FE 프록시 응답 success').toBe(true);
    expect(pfBody, 'FE 프록시 응답 data').toHaveProperty('data');
    test.info().annotations.push({ type: '부분 확인', description: 'AI 서버 REST 5종 직접 응답의 {success,message,data} 형식과 "캐시 없을 때 fallback 스키마"는 AI 키가 없어 확인하지 못했다(AI팀 수동 확인 항목). 이 테스트가 본 것은 BE 중계 5종 동작과 FE 프록시 응답 형식뿐이다' });
  });

  test('CAM-N17 분석 상태가 화면 갱신(STOMP)으로만 온다', TAGS, async ({ openAs }) => {
    test.setTimeout(600_000);
    const live = await getLive();
    const sid = live.camera.sessionId;
    const gaPage = await openAs({ label: 'live-ga', login: live.gl.login }, '/guardian');
    const gbPage = await openAs({ label: 'live-gb', login: live.bl.login }, '/guardian');
    await Promise.all([waitForRealtime(gaPage), waitForRealtime(gbPage)]);
    const getGa = await collectTopic(gaPage, `/topic/${live.ga.id}/camera-analysis`);
    const getGb = await collectTopic(gbPage, `/topic/${live.gb.id}/camera-analysis`);
    const ids = [live.ga.id, live.gb.id, live.ward.id].map(sqlStr).join(',');
    const notifBefore = psqlRows(`SELECT count(*) FROM notification_log WHERE recipient_id IN (${ids});`)[0][0];

    // 송출 종료 -> offline 이 도착한다
    await live.pause();
    await stopAiSession(live.proxy, sid);
    await expect.poll(async () => (await getGa()).some(m => m.body.status === 'offline'), { timeout: 30_000, intervals: [1_000], message: '송출을 끝냈는데 30초 안에 offline 상태가 STOMP 로 오지 않았다' }).toBe(true);
    // 다시 송출 -> running
    await live.resume();
    await expect.poll(async () => (await getGa()).some(m => m.body.status === 'running'), { timeout: 40_000, intervals: [1_000], message: '송출을 다시 시작했는데 40초 안에 running 상태가 STOMP 로 오지 않았다' }).toBe(true);
    // 2초 안에 끝과 시작이 겹치면: 앞의 변화는 미루고 최신값(running)이 뒤에 1번 온다
    await sleep(3_000);
    await live.pause();
    await stopAiSession(live.proxy, sid);
    await live.resume();
    await expect.poll(async () => (await statusOf(live.gl.api, sid)).data?.status, { timeout: 40_000, intervals: [1_000], message: '송출을 다시 시작했는데 BE 가 running 으로 보지 않았다' }).toBe('running');
    await sleep(6_000);

    const msgs = await getGa();
    expect(msgs.length, 'STOMP 로 상태 변화 메시지를 받았다').toBeGreaterThanOrEqual(3);
    for (const m of msgs) {
      expect(m.body.sessionId, '메시지의 카메라').toBe(sid);
      expect(m.body.wardId, '메시지의 피보호자').toBe(live.ward.id);
      expect(['running', 'disconnected', 'offline', null]).toContain(m.body.status);
    }
    // 같은 카메라 최소 2초 간격(브라우저 수신 시각 기준, 전송 지터를 감안해 1.7초)
    const summary = msgs.map(m => `${m.t - msgs[0].t}ms ${String(m.body.status)}/${String(m.body.detectedType)}/${String(m.body.danger)}`).join(' | ');
    test.info().annotations.push({ type: '받은 메시지', description: summary });
    // 송출이 이어지는 동안(앞뒤 메시지가 모두 offline 이 아님)의 변화는 최소 2초 간격이다.
    // 코드(LiveAnalysisBroadcaster.onSessionsEnded·onSessionsOffline)는 송출 종료(offline) 알림을 "간격 제한 없이 바로" 보낸다 - 문서의 2초 간격에는 없는 예외라 코드 기준으로 본다.
    const runningGaps = msgs.slice(1).flatMap((m, i) => (msgs[i].body.status !== 'offline' && m.body.status !== 'offline' ? [m.t - msgs[i].t] : []));
    expect(runningGaps.length, `송출이 이어지는 동안의 메시지 쌍이 있어야 간격을 볼 수 있다(받은 메시지: ${summary})`).toBeGreaterThan(0);
    expect(Math.min(...runningGaps), `송출 중 메시지 간격(ms): ${runningGaps.join(',')} / 받은 메시지: ${summary}`).toBeGreaterThanOrEqual(1_700);
    test.info().annotations.push({ type: '문서와 다른 점', description: '송출 종료(offline) 알림은 2초 간격 제한 없이 바로 간다(코드 LiveAnalysisBroadcaster.onSessionsEnded 주석: 간격 제한 없이 바로). 문서의 "같은 카메라 최소 2초 간격"은 송출 중 변화에만 해당' });
    // 상태가 바뀔 때만: 연속된 두 메시지가 같은 상태·감지 종류·위험 여부면 안 된다
    for (let i = 1; i < msgs.length; i++) {
      const a = msgs[i - 1].body;
      const b = msgs[i].body;
      expect([a.status, a.detectedType, a.danger], `${i}번째 메시지가 앞 메시지와 같은 상태`).not.toEqual([b.status, b.detectedType, b.danger]);
    }
    expect(msgs[msgs.length - 1].body.status, '마지막 메시지는 최신값(running)').toBe('running');
    // ACTIVE 보호자에게만: 연결 안 된 보호자는 받지 않는다
    expect(await getGb(), '연결 안 된 보호자의 화면에는 오지 않는다').toEqual([]);
    // 푸시·문자·알림 이력 없음
    expect(psqlRows(`SELECT count(*) FROM notification_log WHERE recipient_id IN (${ids});`)[0][0], '알림 이력이 늘지 않는다').toBe(notifBefore);
    // 연결이 끊기면(ACTIVE 가 아니면) 받지 않는다
    const seen = (await getGa()).length;
    let disconnectedCount = -1;
    psqlRows(`UPDATE connection SET status = 'DISCONNECTED' WHERE guardian_id = ${sqlStr(live.ga.id)} AND ward_id = ${sqlStr(live.ward.id)} RETURNING id;`);
    try {
      await live.pause();
      await stopAiSession(live.proxy, sid);
      // 연결이 끊긴 보호자는 상태 API 도 못 쓴다. 앞 단계에서 같은 변화(끝남 -> 다시 시작)가 몇 초 안에 도착하는 것을 확인했으므로 넉넉히(끝남 후 8초, 다시 시작 후 15초) 기다린다
      await sleep(8_000);
      await live.resume();
      await sleep(15_000);
      disconnectedCount = (await getGa()).length;
    } finally {
      psqlRows(`UPDATE connection SET status = 'ACTIVE' WHERE guardian_id = ${sqlStr(live.ga.id)} AND ward_id = ${sqlStr(live.ward.id)} RETURNING id;`);
    }
    expect(disconnectedCount, '연결이 끊긴 보호자는 새 메시지를 받지 않는다').toBe(seen);
    // 대조: 연결을 되살린 뒤 서버는 running 으로 보고 있다(15초 기다린 동안 실제로 송출이 다시 시작됐다는 뜻)
    await expect.poll(async () => (await statusOf(live.gl.api, sid)).data?.status, { timeout: 40_000, intervals: [1_000], message: '연결을 되살린 뒤 BE 가 running 으로 보지 않았다' }).toBe('running');
  });

  test('CAM-N15 같은 카메라를 다시 열면 이전 중계가 닫힌다', TAGS, async ({ openAs }) => {
    test.setTimeout(300_000);
    const live = await getLive();
    const sid = live.camera.sessionId;
    const first = openLongStream(mjpegUrl(sid, await issueTicket(live.gl.api, sid)));
    try {
      await expect.poll(() => first.state.bytes, { timeout: 20_000, intervals: [500], message: '첫 영상이 열리지 않았다' }).toBeGreaterThan(0);
      expect(first.state.status).toBe(200);
      // 같은 카메라를 새 티켓으로 다시 연다
      const second = openLongStream(mjpegUrl(sid, await issueTicket(live.gl.api, sid)));
      try {
        await expect.poll(() => second.state.bytes, { timeout: 20_000, intervals: [500], message: '두 번째 영상이 열리지 않았다' }).toBeGreaterThan(0);
        expect(second.state.status, '두 번째 영상은 429 가 아니다').toBe(200);
        await expect.poll(() => first.state.endedAt > 0, { timeout: 20_000, intervals: [500], message: '같은 카메라를 다시 열었는데 이전 중계가 닫히지 않았다' }).toBe(true);
        // 한 번 더 열어도(세 번째) 429 가 나지 않는다
        const third = openLongStream(mjpegUrl(sid, await issueTicket(live.gl.api, sid)));
        try {
          await expect.poll(() => third.state.bytes, { timeout: 20_000, intervals: [500] }).toBeGreaterThan(0);
          expect(third.state.status).toBe(200);
          await expect.poll(() => second.state.endedAt > 0, { timeout: 20_000, intervals: [500], message: '두 번째 중계가 세 번째가 열릴 때 닫히지 않았다' }).toBe(true);
        } finally {
          third.abort();
          await third.done;
        }
      } finally {
        second.abort();
        await second.done;
      }
    } finally {
      first.abort();
      await first.done;
    }

    // 화면을 닫으면 영상 연결이 끊긴다(img src 를 비운다): 서버에 "영상 중계 종료(CLIENT_GONE)"가 새로 남는다
    const page = await openAs({ label: 'live-ga-screen', login: live.gl.login }, '/guardian/detection');
    await page.getByRole('button', { name: /실시간 카메라 보기/ }).click();
    const dialog = page.getByRole('dialog', { name: '실시간 카메라' });
    await expect(dialog).toBeVisible();
    const img = page.locator('img[src*="/mjpeg"]');
    await expect(img).toHaveCount(1, { timeout: 30_000 });
    const startedBefore = countBackendLog('영상 중계 시작', 90);
    const endedBefore = countBackendLog('영상 중계 종료', 90);
    expect(startedBefore, '화면이 영상을 열었다').toBeGreaterThan(0);
    await dialog.getByRole('button', { name: /닫기/ }).first().click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('img[src*="/mjpeg"]'), '닫은 뒤 영상 img 의 src 가 남지 않는다').toHaveCount(0);
    await expect.poll(() => countBackendLog('영상 중계 종료', 90), { timeout: 30_000, intervals: [3_000], message: '화면을 닫았는데 서버의 영상 중계가 끝나지 않았다' }).toBeGreaterThan(endedBefore);
    test.info().annotations.push({ type: '확인하지 못한 부분', description: '"다른 카메라 중계는 유지"는 카메라가 2대 필요해(서비스 전체 상한 3대, 다른 사용자가 이미 사용 중) 확인하지 못했다' });
  });

  test('CAM-N16 보는 중 60초 점검과 30분 상한', TAGS, async () => {
    test.setTimeout(420_000);
    const live = await getLive();
    const sid = live.camera.sessionId;
    // 연결 해제용·정지용 보호자를 따로 만든다
    const g3 = mkUser('GUARDIAN', 'E2E시청해제');
    const g4 = mkUser('GUARDIAN', 'E2E시청정지');
    connect(g3.id, live.ward.id);
    connect(g4.id, live.ward.id);
    const l3 = await loginUser(g3);
    const l4 = await loginUser(g4);
    const s3 = openLongStream(mjpegUrl(sid, await issueTicket(l3.api, sid)));
    const s4 = openLongStream(mjpegUrl(sid, await issueTicket(l4.api, sid)));
    try {
      await expect.poll(() => Math.min(s3.state.bytes, s4.state.bytes), { timeout: 20_000, intervals: [500], message: '영상 둘이 열리지 않았다' }).toBeGreaterThan(0);
      const t0 = Date.now();
      psqlRows(`UPDATE connection SET status = 'DISCONNECTED' WHERE guardian_id = ${sqlStr(g3.id)} AND ward_id = ${sqlStr(live.ward.id)} RETURNING id;`);
      psqlRows(`UPDATE users SET status = 'RESTRICTED' WHERE id = ${sqlStr(g4.id)} RETURNING id;`);
      await expect.poll(() => s3.state.endedAt > 0 && s4.state.endedAt > 0, { timeout: 90_000, intervals: [2_000], message: '연결 해제·정지 뒤 90초가 지나도 영상이 끊기지 않았다' }).toBe(true);
      const t3 = Math.round((s3.state.endedAt - t0) / 1000);
      const t4 = Math.round((s4.state.endedAt - t0) / 1000);
      test.info().annotations.push({ type: '끊기기까지', description: `연결 해제 ${t3}초, 정지 ${t4}초(문서: 최대 60초)` });
      expect(t3, `연결 해제 뒤 ${t3}초 만에 끊김(최대 60초 + 전송 여유)`).toBeLessThanOrEqual(70);
      expect(t4, `정지 뒤 ${t4}초 만에 끊김(최대 60초 + 전송 여유)`).toBeLessThanOrEqual(70);
      // 끊긴 보호자는 새 티켓도 못 받는다
      expect((await errOf(await l3.api.raw('POST', ticketUrl(sid)))).status, '연결이 끊긴 보호자의 티켓').toBe(403);
    } finally {
      s3.abort();
      s4.abort();
      await Promise.all([s3.done, s4.done]);
    }
    test.info().annotations.push({ type: '확인하지 못한 부분', description: '영상 1건이 30분에 끝나고 FE 가 새 티켓으로 다시 여는 부분은 30분을 기다려야 해서 확인하지 못했다(BE camera.stream.max-stream-duration=30분)' });
  });

  test('CAM-A14 없는·꺼진·미등록 카메라는 404, 송출 없는 세션은 404 CAMERA_NOT_STREAMING', TAGS, async () => {
    test.setTimeout(300_000);
    const live = await getLive();
    const sid = live.camera.sessionId;
    const api = live.gl.api;
    const expectNotFound = async (label: string, sessionId: string) => {
      for (const [what, res] of [
        ['status', await api.raw('GET', statusUrl(sessionId))],
        ['latest-frame', await api.raw('GET', frameUrl(sessionId))],
        ['stream-ticket', await api.raw('POST', ticketUrl(sessionId))],
      ] as const) {
        const err = await errOf(res);
        expect(err.status, `${label} ${what} -> 실제 ${err.status} ${err.code ?? ''}`).toBe(404);
        expect(err.code, `${label} ${what} 에러 코드`).toBe('CAMERA_NOT_FOUND');
      }
    };
    // 1) 존재하지 않는 sessionId
    await expectNotFound('없는 sessionId', `e2e-p1a-none-${Math.random().toString(36).slice(2, 8)}`);

    // 2) 꺼진 카메라(is_active=false)
    expect((await live.wl.api.raw('PATCH', `/api/ward/camera/${live.camera.id}`, { isActive: false })).status()).toBe(200);
    try {
      await expectNotFound('꺼진 카메라', sid);
    } finally {
      await live.wl.api.raw('PATCH', `/api/ward/camera/${live.camera.id}`, { isActive: true });
    }

    // 3) AI 에만 있는 세션(백엔드에 등록되지 않음)
    const aiOnly = `e2e-p1a-ai-${Math.random().toString(36).slice(2, 8)}`;
    expect((await createAiSession(live.proxy, aiOnly, `e2e-p1a-dev-${Math.random().toString(36).slice(2, 8)}`)).status(), 'AI 에만 세션 생성').toBe(200);
    try {
      expect((await postFrame(live.proxy, aiOnly, live.jpeg)).status()).toBe(200);
      await expectNotFound('AI 에만 있는 세션', aiOnly);
    } finally {
      await stopAiSession(live.proxy, aiOnly);
    }

    // 4) 송출 없는 세션: AI 가 모르는 카메라(AI 세션을 만들기 전에 모아 둔 응답)와 프레임 없는 세션(세션만 만들고 프레임 전)
    const p = live.pre;
    expect(p.noSession.statusCode, 'AI 가 모르는 카메라 상태').toBe(200);
    expect(p.noSession.statusValue, 'AI 가 모르면 status=offline').toBe('offline');
    expect(p.noSession.frame, 'AI 가 모르는 카메라 최신 프레임').toEqual({ status: 404, code: 'CAMERA_NOT_STREAMING' });
    expect(p.noSession.ticketStatus, '티켓은 발급된다(영상은 열 때 막힌다)').toBe(200);
    expect(p.noSession.stream, 'AI 가 모르는 카메라 영상 열기').toEqual({ status: 404, code: 'CAMERA_NOT_STREAMING' });
    expect(p.noFrame.frame, '프레임 없는 세션 최신 프레임').toEqual({ status: 404, code: 'CAMERA_NOT_STREAMING' });
    expect(p.noFrame.statusCode).toBe(200);
    // AI 는 세션을 만들면 프레임이 없어도 status=running 으로 둔다(create_or_restart). 그래서 상태는 running 이고 최신 프레임만 404 다
    expect(p.noFrame.statusValue, '프레임 없는 세션의 status').toBe('running');
    // (CAM-A46 의 "프레임 없음은 detectedType=unknown" 부분) 프레임 없는 세션의 analysis 를 BE 상태 API 로 본다
    const an = p.noFrame.analysis as { detectedType?: string; danger?: boolean } | null | undefined;
    test.info().annotations.push({ type: 'CAM-A46 프레임 없는 세션 analysis', description: JSON.stringify(an ?? null).slice(0, 200) });
    if (an) {
      expect(an.detectedType, '프레임 없는 세션 analysis 의 감지 종류는 unknown').toBe('unknown');
      expect(an.danger, '프레임 없는 세션은 위험으로 보지 않는다').not.toBe(true);
    }
  });

  test('CAM-N57 무프레임 10초면 disconnected, stop은 stopped', TAGS, async () => {
    test.setTimeout(300_000);
    const live = await getLive();
    const sid = live.camera.sessionId;
    await expect.poll(async () => (await statusOf(live.gl.api, sid)).data?.status, { timeout: 30_000, intervals: [1_000] }).toBe('running');
    // 프레임을 끊고 disconnected 가 되기까지 잰다
    await live.pause();
    const tLast = Date.now();
    let seen: string | undefined;
    let elapsed = 0;
    while (Date.now() - tLast < 40_000) {
      seen = (await statusOf(live.gl.api, sid)).data?.status;
      elapsed = (Date.now() - tLast) / 1000;
      if (seen === 'disconnected') break;
      await sleep(1_000);
    }
    expect(seen, `프레임을 끊고 40초 안에 disconnected 가 되어야 한다(마지막 상태 ${seen})`).toBe('disconnected');
    expect(elapsed, `disconnected 까지 ${elapsed.toFixed(1)}초(문서: 10초)`).toBeGreaterThanOrEqual(8);
    expect(elapsed, `disconnected 까지 ${elapsed.toFixed(1)}초(문서: 10초)`).toBeLessThanOrEqual(25);
    const list = await live.gl.api.get<{ sessionId: string; status: string | null }[]>('/api/guardian/camera/live');
    expect(list.find(c => c.sessionId === sid)?.status, '목록에서도 disconnected').toBe('disconnected');

    // stop: AI 응답의 status 가 stopped, BE 에는 offline 으로 보인다
    const stop = await live.proxy.post(`/api/streams/v1/stream-sessions/${sid}/stop`);
    expect(stop.status()).toBe(200);
    const stopBody = (await stop.json()) as { success: boolean; data: { status: string; sessionId: string } };
    expect(stopBody.success).toBe(true);
    expect(stopBody.data.status, 'stop 응답의 status').toBe('stopped');
    await expect.poll(async () => (await statusOf(live.gl.api, sid)).data?.status, { timeout: 20_000, intervals: [1_000], message: 'stop 뒤 BE 에 offline 으로 보이지 않았다' }).toBe('offline');
    test.info().annotations.push({ type: '확인하지 못한 부분', description: 'AI 서버가 live_streams 목록을 broadcast 하는 것은 AI WebSocket(키 필요)이라 직접 확인하지 못했다. BE 가 이를 받아 목록 상태를 갱신하는 것은 확인' });
  });

  test('CAM-N54 직접 끈 정상 종료는 알리지 않고, 알림만 끌 수 있다', TAGS, async ({ openAs }) => {
    test.setTimeout(300_000);
    const live = await getLive();
    const sid = live.camera.sessionId;
    // 직접 끈 정상 종료(앞 테스트의 stop)는 "카메라 연결 확인 필요" 푸시를 만들지 않는다
    await sleep(5_000);
    // 참고 확인일 뿐이다: 이 알림은 BE-AI WebSocket 재접속 뒤에만 시작되므로 stop 만으로는 버그가 있어도 기록이 생기지 않는다(항상 0)
    expect(psqlRows(`SELECT count(*) FROM notification_log WHERE ward_id = ${sqlStr(live.ward.id)} AND type = 'CAMERA_LINK_LOST';`)[0][0], '(참고) 정상 종료 뒤 카메라 끊김 안내 기록').toBe('0');
    test.info().annotations.push({ type: '미확인', description: '"정상 종료는 끊김 알림을 보내지 않음"의 핵심은 확인하지 못했다. 위 기록 0건은 구조상 항상 참이라 통과 근거로 쓰지 않는다(참고). 통과 근거는 설정 끄기와 화면 꺼짐 표시뿐' });
    expect((await statusOf(live.gl.api, sid)).data?.status, '화면 상태는 offline').toBe('offline');

    // 설정: 기본 켜짐 -> 끄면 cameraLinkLost 만 꺼지고 다른 종류는 그대로 -> null 은 변경 없음
    type Setting = { cameraLinkLost: { enabled: boolean; required: boolean }; anomalyReviewReminder: { enabled: boolean }; anomalyDetection: { enabled: boolean; required: boolean } };
    const url = '/api/guardian/notification-type-setting';
    const before = await live.gl.api.get<Setting>(url);
    expect(before.cameraLinkLost, '기본값').toEqual({ enabled: true, required: false });
    const off = await live.gl.api.raw('PUT', url, { cameraLinkLost: false });
    expect(off.status()).toBe(200);
    const after = await live.gl.api.get<Setting>(url);
    expect(after.cameraLinkLost.enabled, '끔').toBe(false);
    expect(after.anomalyReviewReminder.enabled, '다른 종류는 그대로').toBe(before.anomalyReviewReminder.enabled);
    expect(after.anomalyDetection, '이상감지 발생 알림은 필수라 그대로').toEqual({ enabled: true, required: true });
    expect((await live.gl.api.raw('PUT', url, {})).status(), '빈 요청은 변경 없음').toBe(200);
    expect((await live.gl.api.get<Setting>(url)).cameraLinkLost.enabled).toBe(false);

    // 알림을 꺼도 화면의 꺼짐(OFFLINE) 표시는 그대로
    const page = await openAs({ label: 'live-ga-off', login: live.gl.login }, '/guardian/detection');
    await page.getByRole('button', { name: /실시간 카메라 보기/ }).click();
    const dialog = page.getByRole('dialog', { name: '실시간 카메라' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('group', { name: '카메라 전환' }).getByRole('button', { name: new RegExp(live.camera.label) })).toBeVisible({ timeout: 20_000 });
    await expect(dialog, '알림을 꺼도 화면에는 꺼짐 표시가 그대로').toContainText('꺼짐', { timeout: 30_000 });
    test.info().annotations.push({
      type: '확인하지 못한 부분',
      description: '카메라 끊김 푸시가 실제로 가는 경우(AI 서버 재시작 뒤 2분 안에 안 돌아온 카메라)와 환경변수 ANOMALY_LINK_LOST_NOTIFY_ENABLED=false 효과는 AI 서버·BE 설정을 건드려야 해서 확인하지 못했다. 정상 종료 무알림(기록 0건)·설정 끄기·화면 표시만 확인',
    });
  });
});

test.describe('카메라·이상감지 P1a - 카메라 API 속도 제한', () => {
  test('CAM-A18 보호자 카메라 API 속도 제한(분/시간)', TAGS, async () => {
    test.setTimeout(300_000);
    const ward = mkUser('WARD');
    const g = mkUser('GUARDIAN', 'E2E속도제한');
    connect(g.id, ward.id);
    const gl = await loginUser(g);
    for (const [endpoint] of [['camera-live'], ['camera-status'], ['camera-frame'], ['camera-ticket']]) {
      trackOwnRedisKey(`rate:${endpoint}:1m:${g.id}`);
      trackOwnRedisKey(`rate:${endpoint}:1h:${g.id}`);
    }
    const none = 'e2e-p1a-ratelimit-none'; // 없는 카메라: 인가를 통과하지 못해도 속도 제한이 먼저 걸리는지 본다
    const cases: { label: string; limit: number; call: () => Promise<{ status: () => number; headers: () => Record<string, string>; text: () => Promise<string> }>; before: number }[] = [
      { label: '카메라 목록', limit: 30, call: () => gl.api.raw('GET', '/api/guardian/camera/live'), before: 200 },
      { label: '카메라 상태', limit: 30, call: () => gl.api.raw('GET', statusUrl(none)), before: 404 },
      { label: '정지 화면(스냅샷)', limit: 60, call: () => gl.api.raw('GET', frameUrl(none)), before: 404 },
      { label: '영상 티켓', limit: 20, call: () => gl.api.raw('POST', ticketUrl(none)), before: 404 },
    ];
    for (const c of cases) {
      const statuses: number[] = [];
      let last: Awaited<ReturnType<typeof c.call>> | undefined;
      for (let i = 0; i < c.limit + 1; i++) {
        last = await c.call();
        statuses.push(last.status());
      }
      const first = statuses.slice(0, c.limit);
      expect(first.every(s => s === c.before), `${c.label}: 한도(분당 ${c.limit}회)까지는 ${c.before}(실제 ${[...new Set(first)].join(',')})`).toBe(true);
      expect(statuses[c.limit], `${c.label}: ${c.limit + 1}번째 호출`).toBe(429);
      const body = JSON.parse(await last!.text()) as { code?: string };
      expect(body.code, `${c.label} 에러 코드`).toBe('TOO_MANY_REQUESTS');
      const retry = Number(last!.headers()['retry-after']);
      expect(retry, `${c.label} Retry-After(초)`).toBeGreaterThan(0);
      expect(retry, `${c.label} Retry-After 는 분 창(60초) 이하`).toBeLessThanOrEqual(60);
    }
    // 이 보호자의 한도는 다른 API(예: 내 정보·재촉 설정)를 막지 않는다
    expect((await gl.api.raw('GET', '/api/guardian/anomaly/reminder-setting')).status(), '다른 보호자 API 는 정상').toBe(200);
    test.info().annotations.push({ type: '확인하지 못한 부분', description: 'Redis 장애 때 속도 제한이 막지 않는 부분(fail-open)은 Redis 를 멈출 수 없어 확인하지 못했다. 시간당 한도(600·1200·300)는 분 한도 확인으로 대신하고 따로 채우지 않았다' });
  });

});
