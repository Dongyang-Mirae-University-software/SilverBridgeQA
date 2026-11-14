/**
 * 최종 QA - 카메라·이상감지(CAM) P0 - 화재 신호 1회를 나눠 쓰는 묶음
 *
 * 처음 CAM-N20 이 돌 때 화재 신호를 한 번 만든다(임시 피보호자 1명 + 보호자 2명 + 관리자, 카메라 1대, 화재 사진 연속 전송).
 * 나머지 케이스는 그 결과(이력·알림·카메라)를 같이 쓰고, 연결을 바꾸는 케이스(A16·A30)와 탈퇴(X01)는 맨 뒤에 둔다.
 * 이 묶음은 serial 이다: 한 테스트가 실패하면 나머지는 건너뛴다(실패 뒤 워커가 새로 떠서 화재 묶음과 외부 발송이 다시 생기는 것을 막는다).
 * 끝나면 카메라·AI 세션·임시 사용자를 모두 정리한다.
 * 보호자 A 는 문자·알림톡을 켜 둔다(임시 번호 010-0001-xxxx 로 최대 문자 2건·알림톡 1건이 나갈 수 있다).
 * 실행 안내: 카메라 상한(서비스 전체 3대)이 공용 값이므로 다른 영역·사람의 카메라 등록과 동시에 돌리지 않는다.
 * CAM-N35 는 X02 판정에 기대지 않고 스스로 동수 상태를 만들어, --grep 으로 따로 돌려도 된다(그래도 화재 묶음은 첫 테스트가 만든다).
 */
import { request } from '@playwright/test';

import { Api } from '../../../src/api';
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { countBackendLog, psqlRows, remoteBash, sqlStr } from '../../../src/remote';
import { connect } from '../../../src/variables';
import {
  Camera,
  disposeFireRun,
  errOf,
  expectErr,
  FireRun,
  getFireRun,
  Incident,
  mjpegUrl,
  openStreamOnce,
  plainJpeg,
  postFrame,
  releaseFireCamera,
  sleep,
  trackCamera,
} from './_helpers-cam';

const TAGS = { tag: ['@P0', '@CAM'] };

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await disposeFireRun();
});

/** 영상 전송을 이어서 보낸다(AI 서버의 영상 보기는 프레임이 올 때 열린다). 화재 사진이 아닌 평범한 사진이라 재감지 알림이 더 가지 않는다 */
async function startPump(run: FireRun) {
  let stop = false;
  const jpeg = await plainJpeg();
  const task = (async () => {
    while (!stop) {
      await postFrame(run.proxy, run.camera.sessionId, jpeg).catch(() => undefined);
      await sleep(400);
    }
  })();
  return async () => {
    stop = true;
    await task;
  };
}

const who = (run: FireRun, key: 'ga' | 'ward') => ({ label: key, login: key === 'ga' ? run.gaLogin : run.wardLogin });

function notificationRows(run: FireRun) {
  return psqlRows(`SELECT recipient_id, type, result, replace(title, E'\\n', ' '), replace(body, E'\\n', ' '), channel_results::text FROM notification_log
                   WHERE ward_id = ${sqlStr(run.ward.id)} AND type LIKE 'ANOMALY_DETECTED%'
                     AND created_at >= ${sqlStr(run.startedAt)}::timestamptz ORDER BY id;`);
}

type Attempt = { channel: string; status: string; reason?: string | null };
const attemptsOf = (row: string[]) => JSON.parse(row[5] || '[]') as Attempt[];

/**
 * 받는 사람마다 알림 기록이 남는다(보호자 = ANOMALY_DETECTED, 본인 = ANOMALY_DETECTED_SELF).
 * 어느 채널로도 전달되지 않은 수신자는 쿨다운을 풀어 재감지 때 다시 알리므로(AnomalyNotificationListener) 줄이 더 생길 수 있다.
 * 그래서 "전달된 줄(DELIVERED·SMS_FALLBACK)이 있으면 그 수신자는 정확히 1줄"을 본다. 임시 계정은 푸시 기기가 없어 전달 결과는 채널 설정에 따른다.
 */
function expectOneRowPerRecipient(run: FireRun, rows: string[][]) {
  const expected: [string, string][] = [[run.ga.id, 'ANOMALY_DETECTED'], [run.gb.id, 'ANOMALY_DETECTED'], [run.ward.id, 'ANOMALY_DETECTED_SELF']];
  for (const [id, type] of expected) {
    const mine = rows.filter(r => r[0] === id);
    expect(mine.length, `${type} 수신자 ${id} 알림 기록`).toBeGreaterThanOrEqual(1);
    expect([...new Set(mine.map(r => r[1]))], `${id} 알림 종류`).toEqual([type]);
    const deliveredBeforeLast = mine.slice(0, -1).filter(r => r[2] === 'DELIVERED' || r[2] === 'SMS_FALLBACK');
    expect(deliveredBeforeLast, `${id}: 이미 전달된 뒤에 같은 알림이 또 기록됐다`).toEqual([]);
  }
  expect(rows.filter(r => ![run.ga.id, run.gb.id, run.ward.id].includes(r[0])), '받을 사람이 아닌데 기록이 있다').toEqual([]);
  test.info().annotations.push({ type: '알림 기록 줄 수', description: expected.map(([id]) => `${id}:${rows.filter(r => r[0] === id).length}줄(${rows.filter(r => r[0] === id).map(r => r[2]).join('/')})`).join(' ') });
}

function eucKrBytes(text: string) {
  return [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 2 : 1), 0);
}

test.describe('카메라·이상감지 P0 - 화재 신호', () => {
  test('CAM-N20 화재 감지 시 이력 1건과 전원 알림', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    test.info().annotations.push({ type: '준비', description: run.setupNotes.join(' | ') });

    expect(run.incident.detectedType).toBe('FIRE');
    expect(run.incident.detectedTypeLabel).toBe('화재');
    expect(run.incident.reviewStatus).toBe('PENDING');
    // 이력: 상황 1건, 감지(anomaly_event) 적재
    expect(Number(psqlRows(`SELECT count(*) FROM anomaly_incident WHERE ward_id = ${sqlStr(run.ward.id)};`)[0][0]), '이상감지 상황은 1건').toBe(1);
    expect(Number(psqlRows(`SELECT count(*) FROM anomaly_event WHERE ward_id = ${sqlStr(run.ward.id)} AND detected_type = 'FIRE';`)[0][0]), 'anomaly_event 적재').toBeGreaterThanOrEqual(1);

    // 보호자 전원 + 피보호자 본인에게 anomaly-detected(실시간)
    expect(run.events.ga.length, '보호자 A 실시간 이벤트').toBeGreaterThan(0);
    expect(run.events.gb.length, '보호자 B 실시간 이벤트').toBeGreaterThan(0);
    expect(run.events.ward.length, '피보호자 본인 실시간 이벤트').toBeGreaterThan(0);
    const guardianEvent = run.events.ga[0];
    expect(guardianEvent.title, '보호자 제목').toContain('화재 감지');
    expect(guardianEvent.body, '보호자 문구').toContain('화재가 감지되었습니다.');
    const selfEvent = run.events.ward[0];
    expect(selfEvent.title, '본인 화면 제목').toBe('화재 감지');
    expect(selfEvent.body, '본인 문구는 대피 안내').toMatch(/밖으로 나가세요/);

    // 푸시(FCM) 시도 기록: 수신자마다 있다. 보호자는 ANOMALY_DETECTED, 본인은 ANOMALY_DETECTED_SELF
    const rows = notificationRows(run);
    expectOneRowPerRecipient(run, rows);
    for (const row of rows) {
      expect(attemptsOf(row).map(a => a.channel), `${row[1]} 에 푸시(FCM) 시도가 있어야 한다`).toContain('FCM');
    }
  });

  test('CAM-N04 스트리밍 먼저, 등록 나중이어도 감시가 살아난다', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    // 카메라가 이미 등록된 상태에서 AI 세션을 만들면 AI 가 보낸 목록으로 BE 가 먼저 구독할 수 있다(재등록 전 로그 수로 따로 센다).
    // 그래서 확인하는 것은 "재등록(등록 이벤트) 뒤에 BE 가 AI 세션 목록을 다시 요청한다"(AiLiveStreamSubscriber.onCameraRegistered)이다.
    expect(run.requeryAfterReregisterMs, '재등록 뒤 70초 안에 새 "AI 세션 목록 재요청" 로그가 없다(등록 이벤트 처리가 안 돈다)').not.toBeNull();
    expect(run.requeryAfterReregisterMs!, `목록 재요청까지 ${run.requeryAfterReregisterMs}ms - 등록 이벤트가 아니라 60초 재동기화로 늦게 돈다`).toBeLessThan(30_000);
    expect(run.incident.detectedType, '구독 뒤 화재 신호가 이상감지 상황이 된다').toBe('FIRE');
    test.info().annotations.push({ type: '목록 재요청까지', description: `${run.requeryAfterReregisterMs}ms` });
    test.info().annotations.push({ type: '재등록 전 세션 구독 로그', description: `${run.subscribedLogsBeforeReregister}건(1 이상이면 AI 의 세션 생성 목록으로 이미 구독돼 있었다)` });
    test.info().annotations.push({
      type: '한계',
      description: '진짜 "스트리밍 먼저, 등록 나중"은 만들 수 없다(sessionId 를 BE 가 등록 때 만든다). 재등록의 등록 이벤트 처리와 이후 감지 연결만 확인했다',
    });
  });

  test('CAM-N29 알림 data에 incidentId와 title·body가 있다', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const event = run.events.ga[0];
    expect(event, '보호자 A 가 받은 실시간 이벤트').toBeTruthy();
    for (const key of ['type', 'wardId', 'wardName', 'location', 'sessionId', 'detectedType', 'detectedTypeLabel', 'detectedAt', 'anomalyEventId', 'incidentId', 'title', 'body']) {
      expect(typeof event[key], `${key} 는 문자열로 있어야 한다`).toBe('string');
      expect(event[key], `${key} 가 비어 있다`).not.toBe('');
    }
    expect(event.type).toBe('ANOMALY_DETECTED');
    expect(event.wardId).toBe(run.ward.id);
    expect(event.wardName).toBe(run.ward.name);
    expect(event.location).toBe(run.camera.label);
    expect(event.sessionId).toBe(run.camera.sessionId);
    expect(event.detectedType).toBe('FIRE');
    expect(event.detectedTypeLabel).toBe('화재');
    expect(event.incidentId, 'incidentId 는 문자열이고 숫자로 바꾸면 상황 ID 와 같다').toMatch(/^\d+$/);
    expect(Number(event.incidentId)).toBe(run.incident.incidentId);
    expect(Number(event.anomalyEventId)).toBeGreaterThan(0);
    expect(event.detectedAt, 'detectedAt 은 KST "yyyy-MM-dd HH:mm"').toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    const detectedMs = Date.parse(`${event.detectedAt.replace(' ', 'T')}:00+09:00`);
    expect(Math.abs(Date.now() - detectedMs), 'detectedAt 이 KST 현재 시각 근처').toBeLessThan(30 * 60_000);

    // 화면: 안전 알림 팝업이 뜨고 확인 전까지 7초 뒤에도 남는다
    expect(run.gaToast, '보호자 화면에 화재 알림 팝업(role=alert)이 뜨지 않았다').not.toBeNull();
    expect(run.gaToast!.text).toContain('화재');
    expect(run.gaToast!.stillVisibleAfter7s, '화재 알림 팝업이 확인 전에 사라졌다').toBe(true);

    // 푸시 클릭: 서비스워커가 이상감지 푸시를 이상감지 화면으로 보낸다
    const ctx = await request.newContext();
    try {
      const logic = await (await ctx.get(`${env.baseUrl}/push-sw-logic.js`)).text();
      expect(logic, '서비스워커 로직에 ANOMALY_DETECTED 분기가 없다').toContain('ANOMALY_DETECTED');
      expect(logic, '이상감지 푸시의 이동 화면이 /guardian/detection 이 아니다').toContain('/guardian/detection');
    } finally {
      await ctx.dispose();
    }
  });

  test('CAM-N27 문자·알림톡은 본인 설정대로, 알림톡은 보호자만', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const rows = notificationRows(run);
    const a = attemptsOf(rows.find(r => r[0] === run.ga.id)!);
    const b = attemptsOf(rows.find(r => r[0] === run.gb.id)!);
    const selfRow = rows.find(r => r[0] === run.ward.id)!;
    const self = attemptsOf(selfRow);
    test.info().annotations.push({ type: '채널 결과', description: JSON.stringify({ A: a, B: b, 본인: self }) });

    // 푸시·화면 알림은 항상
    expect(run.events.ga.length + run.events.gb.length + run.events.ward.length).toBeGreaterThanOrEqual(3);
    for (const list of [a, b, self]) expect(list.map(x => x.channel)).toContain('FCM');
    // 켠 사람만: A 는 문자·알림톡 시도, B 는 알림톡 없음(문자 대체는 상한 키로 막혀 전달되지 않음)
    expect(a.map(x => x.channel), '보호자 A(문자 켬)').toContain('SMS');
    expect(a.map(x => x.channel), '보호자 A(알림톡 켬)').toContain('KAKAO_ALIMTALK');
    expect(b.map(x => x.channel), '보호자 B(알림톡 끔)').not.toContain('KAKAO_ALIMTALK');
    expect(b.filter(x => x.channel === 'SMS' && x.status === 'DELIVERED'), '보호자 B(문자 끔)에게 문자가 전달됐다').toEqual([]);
    // 피보호자에게 알림톡은 가지 않는다
    expect(self.map(x => x.channel), '피보호자 본인은 알림톡 대상이 아니다').not.toContain('KAKAO_ALIMTALK');
    expect(self.map(x => x.channel), '본인 문자(켬)').toContain('SMS');
    // 본인 문자 문구: [실버브릿지] + 본문이 90바이트(EUC-KR) 이내
    const selfBody = selfRow[4];
    expect(eucKrBytes(`[실버브릿지] ${selfBody}`), `본인 문자 "${selfBody}" 길이`).toBeLessThanOrEqual(90);
  });

  test('CAM-N56 세션 생성→프레임→분석 broadcast', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    // 세션 생성·프레임은 FE 프록시로 이미 200 을 확인했다(getFireRun). 여기서는 BE 가 중계하는 상태·분석을 본다
    const stop = await startPump(run);
    try {
      type St = { status: string; isAnalyzing: boolean; fps: number | null; analysis: { detectedType: string; danger: boolean; confidence: number } | null };
      const readStatus = async () => {
        const res = await run.gaApi.raw('GET', `/api/guardian/camera/${run.camera.sessionId}/status`);
        expect(res.status()).toBe(200);
        return ((await res.json()) as { data: St }).data;
      };
      // AI 가 느려도 최대 60초까지 기다린다: running 이고 analysis 가 생길 때까지(상태 조회가 느려 시간 초과가 나는 한 번은 건너뛴다)
      await expect.poll(async () => {
        const s = await readStatus().catch(() => null);
        return !!s && s.status === 'running' && s.analysis !== null;
      }, { timeout: 60_000, intervals: [1_000], message: '송출 중인데 60초 안에 running + 분석이 되지 않았다' }).toBe(true);
      const status = await readStatus();
      expect(status.status, '송출 중이면 running').toBe('running');
      expect(status.analysis, '프레임을 보냈으니 최근 분석이 있어야 한다').not.toBeNull();
      expect(['NORMAL', 'FIRE', 'SMOKE', 'UNKNOWN'], `detectedType=${status.analysis?.detectedType}`).toContain(status.analysis!.detectedType);
      expect(typeof status.analysis!.danger).toBe('boolean');
      expect(status.analysis!.confidence).toBeGreaterThanOrEqual(0);
      expect(status.analysis!.confidence).toBeLessThanOrEqual(1);
      const live = (await run.gaApi.get<{ sessionId: string; status: string; lastFrameAt: string | null }[]>('/api/guardian/camera/live')).find(c => c.sessionId === run.camera.sessionId);
      expect(live?.status).toBe('running');
      expect(live?.lastFrameAt).toBeTruthy();
      test.info().annotations.push({ type: '분석', description: JSON.stringify(status.analysis) });
    } finally {
      await stop();
    }
    // AI 서버가 프레임 5장마다 추론하고 매 프레임 broadcast 하는 것은 AI WebSocket(키 필요)으로만 보여 확인하지 않는다
  });

  test('CAM-N14 1회용 티켓으로 영상 열기', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const stop = await startPump(run);
    try {
      // API: 티켓 발급 -> 로그인 없이 티켓만으로 영상
      const issued = await run.gaApi.raw('POST', `/api/guardian/camera/${run.camera.sessionId}/stream-ticket`);
      expect(issued.status()).toBe(200);
      const ticket = ((await issued.json()) as { data: { ticket: string; expiresInSeconds: number } }).data;
      expect(ticket.expiresInSeconds).toBe(60);
      expect(ticket.ticket).toMatch(/^st_[A-Za-z0-9_-]{43}$/);
      const opened = await openStreamOnce(mjpegUrl(run.camera.sessionId, ticket.ticket));
      expect(opened.status, `영상 열기 ${opened.code ?? ''} ${opened.message ?? ''}`).toBe(200);
      expect(opened.contentType).toContain('multipart/x-mixed-replace');
      expect(opened.firstBytes).toBeGreaterThan(0);

      // 화면: 실시간 카메라 보기 -> 티켓을 받아 BE 주소로 영상을 열고, AI 서버에는 직접 붙지 않는다
      const page = await openAs(who(run, 'ga'), null);
      const hosts = new Set<string>();
      page.on('request', r => hosts.add(new URL(r.url()).host));
      const ticketPosts: string[] = [];
      page.on('request', r => {
        if (r.method() === 'POST' && /\/stream-ticket$/.test(r.url())) ticketPosts.push(r.url());
      });
      await page.goto('/guardian/detection');
      await page.getByRole('button', { name: /실시간 카메라 보기/ }).click();
      const dialog = page.getByRole('dialog', { name: '실시간 카메라' });
      await expect(dialog).toBeVisible();
      const img = dialog.getByRole('img', { name: '실시간 영상' });
      await expect(img).toBeVisible({ timeout: 30_000 });
      const src = (await img.getAttribute('src')) ?? '';
      expect(src.startsWith(`${env.apiUrl}/api/camera/stream/${run.camera.sessionId}/mjpeg?ticket=`), `영상 주소 ${src.split('?')[0]}`).toBe(true);
      expect(ticketPosts.length, '화면이 티켓을 발급받았다').toBeGreaterThan(0);
      const aiHost = new URL(process.env.E2E_AI_URL ?? 'https://testai.gosky.kr').host;
      expect([...hosts].includes(aiHost), `브라우저가 AI 서버(${aiHost})에 직접 요청했다`).toBe(false);
    } finally {
      await stop();
    }
  });

  test('CAM-N11 보호자는 ACTIVE 연결 피보호자 카메라만 목록에 본다', TAGS, async ({ openAs, tempUser, loginAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const list = await run.gaApi.get<{ sessionId: string; wardId: string; wardName: string; label: string; isActive: boolean }[]>('/api/guardian/camera');
    expect(list.map(c => c.sessionId)).toEqual([run.camera.sessionId]);
    expect(list[0]).toMatchObject({ wardId: run.ward.id, wardName: run.ward.name, label: run.camera.label });
    const live = await run.gaApi.get<Record<string, unknown>[]>('/api/guardian/camera/live');
    expect(live).toHaveLength(1);
    expect(Object.keys(live[0]).sort()).toEqual(['label', 'lastFrameAt', 'sessionId', 'status', 'wardId', 'wardName']);
    expect(live[0]).toMatchObject({ sessionId: run.camera.sessionId, wardId: run.ward.id, wardName: run.ward.name, label: run.camera.label });
    expect(['running', 'disconnected', 'offline']).toContain(live[0].status);

    // 수락 대기(PENDING) 보호자는 보지 못한다: 연결 요청만 보낸 보호자
    const pending = await loginAs(await tempUser('GUARDIAN'));
    const request1 = await pending.api.raw('POST', '/api/guardian/connection/request', { targetId: run.ward.id, relation: '기타' });
    expect(request1.status(), '준비: 연결 요청').toBe(200);
    expect(await pending.api.get<unknown[]>('/api/guardian/camera'), '수락 대기 보호자 목록').toEqual([]);
    expect(await pending.api.get<unknown[]>('/api/guardian/camera/live'), '수락 대기 보호자 live 목록').toEqual([]);
    // 연결 없는 보호자도 빈 목록
    const stranger = await loginAs(await tempUser('GUARDIAN'));
    expect(await stranger.api.get<unknown[]>('/api/guardian/camera')).toEqual([]);
    expect(await stranger.api.get<unknown[]>('/api/guardian/camera/live')).toEqual([]);
  });

  test('CAM-A13 연결 안 된 보호자는 403 CAMERA_NOT_CONNECTED', TAGS, async ({ openAs, tempUser, loginAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const sid = run.camera.sessionId;
    const stranger = await loginAs(await tempUser('GUARDIAN'));
    const pending = await loginAs(await tempUser('GUARDIAN'));
    expect((await pending.api.raw('POST', '/api/guardian/connection/request', { targetId: run.ward.id, relation: '기타' })).status(), '준비: 수락 대기').toBe(200);
    const released = await loginAs(await tempUser('GUARDIAN'));
    connect(released.user.id, run.ward.id);
    const connId = psqlRows(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(released.user.id)} AND ward_id = ${sqlStr(run.ward.id)};`)[0][0];
    expect((await released.api.raw('DELETE', `/api/guardian/connection/disconnection/${connId}`)).status(), '준비: 연결 해제').toBe(200);

    for (const [name, g] of [['미연결', stranger], ['수락 대기', pending], ['해제', released]] as const) {
      for (const [method, path] of [
        ['GET', `/api/guardian/camera/${sid}/status`],
        ['GET', `/api/guardian/camera/${sid}/latest-frame`],
        ['POST', `/api/guardian/camera/${sid}/stream-ticket`],
      ] as const) {
        const err = await errOf(await g.api.raw(method, path));
        expectErr(err, 403, 'CAMERA_NOT_CONNECTED', `${name} ${path.split('/').pop()}`);
        expect(err.message).toBe('연결된 피보호자의 카메라만 볼 수 있습니다.');
        expect(err.raw, '응답에 방 이름이 없어야 한다').not.toContain(run.camera.label);
      }
    }
    await expect.poll(() => countBackendLog(`연결되지 않은 피보호자 카메라 접근 시도: guardianId=${stranger.user.id}`), { timeout: 20_000 }).toBeGreaterThan(0);

    // CAM-N11: 해제된 보호자는 카메라 목록에서도 빠진다
    expect(await released.api.get<unknown[]>('/api/guardian/camera'), '해제된 보호자 카메라 목록').toEqual([]);
    expect(await released.api.get<unknown[]>('/api/guardian/camera/live'), '해제된 보호자 live 목록').toEqual([]);
  });

  test('CAM-A15 티켓 없음·만료·재사용·다른 카메라용은 401', TAGS, async ({ openAs, tempUser, loginAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const sid = run.camera.sessionId;
    const stop = await startPump(run);
    try {
      const issue = async () =>
        ((await (await run.gaApi.raw('POST', `/api/guardian/camera/${sid}/stream-ticket`)).json()) as { data: { ticket: string } }).data.ticket;
      const expired = await issue(); // 60초 뒤에 쓴다

      // 티켓 없음
      expectErr(await errOf(await fetchJson(mjpegUrl(sid))), 401, 'CAMERA_STREAM_TICKET_INVALID', '티켓 없음');
      // 형식이 다른 티켓
      expectErr(await errOf(await fetchJson(mjpegUrl(sid, 'st_bad'))), 401, 'CAMERA_STREAM_TICKET_INVALID', '엉터리 티켓');
      // 쿼리 accessToken 은 받지 않는다(토큰 값은 찍지 않는다).
      // URL 에 실리는 토큰이라 서버 접근 로그에 남을 수 있다 -> 이 검사만을 위한 연결된 임시 보호자 토큰을 쓰고, 바로 비밀번호를 바꿔 무효화한다
      const probe = await loginAs(await tempUser('GUARDIAN'));
      connect(probe.user.id, run.ward.id);
      try {
        expectErr(await errOf(await fetchJson(mjpegUrl(sid, undefined, `accessToken=${probe.login.accessToken}`))), 401, 'CAMERA_STREAM_TICKET_INVALID', '쿼리 accessToken');
      } finally {
        await sleep(1_100);
        const changed = await probe.api.raw('PUT', '/api/user/me/password', { currentPassword: probe.user.password, newPassword: `${probe.user.password}9!` });
        test.info().annotations.push({
          type: '토큰 노출',
          description: `검사용 임시 보호자의 액세스 토큰이 URL 쿼리로 dev BE 에 나갔다(접근 로그에 남을 수 있음). 비밀번호 변경(${changed.status()})으로 무효화했다`,
        });
      }
      // 재사용: 첫 번째 200, 두 번째 401
      const once = await issue();
      const first = await openStreamOnce(mjpegUrl(sid, once));
      expect(first.status, `첫 사용 ${first.code ?? ''}`).toBe(200);
      const second = await openStreamOnce(mjpegUrl(sid, once));
      expect(second.status, '두 번째 사용').toBe(401);
      expect(second.code).toBe('CAMERA_STREAM_TICKET_INVALID');
      // 다른 카메라용: 다른 sessionId 로 열기(티켓은 소비된다)
      const other = await issue();
      const wrongSession = await openStreamOnce(mjpegUrl('e2e_other_session', other));
      expect(wrongSession.status, '다른 카메라용').toBe(401);
      expect(wrongSession.code).toBe('CAMERA_STREAM_TICKET_INVALID');
      const afterWrong = await openStreamOnce(mjpegUrl(sid, other));
      expect(afterWrong.status, '다른 카메라용으로 쓴 티켓은 소비돼 원래 카메라에도 못 쓴다').toBe(401);
      // 만료: 60초 뒤
      const waitMs = 62_000 - 0;
      await sleep(waitMs);
      const late = await openStreamOnce(mjpegUrl(sid, expired));
      expect(late.status, '60초 지난 티켓').toBe(401);
      expect(late.code).toBe('CAMERA_STREAM_TICKET_INVALID');
    } finally {
      await stop();
    }
  });

  test('CAM-X02 화재 감지부터 알림, 판정, 대시보드, 관리자 통계까지 숫자가 이어진다', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const wardId = run.ward.id;
    type Dash = { data: { pendingActions: { anomaly: number | null } } };
    const pendingOf = async (api: Api) => ((await (await api.raw('GET', `/api/guardian/dashboard?wardId=${wardId}`)).json()) as Dash).data.pendingActions.anomaly;
    const safety = async () => {
      const json = (await (await run.adminApi.raw('GET', '/api/admin/dashboard/safety')).json()) as { data: { todayAnomaly: { review: { pending: number; real: number } } } };
      return json.data.todayAnomaly.review;
    };

    // 알림 이력: 받는 사람마다 1줄
    const rows = notificationRows(run);
    expectOneRowPerRecipient(run, rows);
    test.info().annotations.push({ type: '알림 이력 결과', description: rows.map(r => `${r[1]}=${r[2]}`).join(', ') });
    for (const row of rows) expect(row[2], `${row[1]} 결과 값`).toBeTruthy();

    // 판정 전: 보호자 홈 pendingActions.anomaly = 1, 이력 화면 '확인 필요' 1
    expect(await pendingOf(run.gaApi), '판정 전 A 홈').toBe(1);
    expect(await pendingOf(run.gbApi), '판정 전 B 홈').toBe(1);
    const before = await safety();
    const page = await openAs(who(run, 'ga'), '/guardian/detection');
    const needs = page.getByRole('status').filter({ hasText: '확인 필요' });
    await expect(needs, '화면 확인 필요 1 (10·20 같은 숫자에는 맞지 않게 자릿수까지 본다)').toContainText(/확인 필요\s*1(?!\d)/);

    // 두 보호자가 REAL, REAL
    expect((await run.gaApi.raw('POST', `/api/guardian/anomaly/${run.incident.incidentId}/feedback`, { verdict: 'REAL' })).status()).toBe(200);
    expect((await run.gbApi.raw('POST', `/api/guardian/anomaly/${run.incident.incidentId}/feedback`, { verdict: 'REAL' })).status()).toBe(200);

    // 판정 뒤: 홈 0, 이력 요약 0, 화면 0
    expect(await pendingOf(run.gaApi), '판정 뒤 A 홈').toBe(0);
    expect(await pendingOf(run.gbApi), '판정 뒤 B 홈').toBe(0);
    const summary = await run.gaApi.get<{ needsReviewCount: number; total: number }>(`/api/guardian/anomaly/history/summary?wardId=${wardId}`);
    expect(summary.needsReviewCount).toBe(0);
    await page.reload();
    await expect(page.getByRole('status').filter({ hasText: '확인 필요' })).toContainText(/확인 필요\s*0(?!\d)/);
    await expect(page.getByText('실제 위험', { exact: true }).first(), '화면 판정 결과').toBeVisible();

    // 관리자 로그
    const admin = await run.adminApi.get<{ content: { incidentId: number; reviewStatus: string; feedbacks: { guardianId: string; verdict: string }[] }[] }>(
      `/api/admin/anomaly?wardId=${wardId}&page=0&size=20`,
    );
    const item = admin.content.find(i => i.incidentId === run.incident.incidentId)!;
    expect(item, '관리자 로그에 상황이 있다').toBeTruthy();
    expect(item.reviewStatus).toBe('REAL');
    expect(item.feedbacks.map(f => f.verdict)).toEqual(['REAL', 'REAL']);
    expect(item.feedbacks.map(f => f.guardianId).sort()).toEqual([run.ga.id, run.gb.id].sort());
    const adminSummary = await run.adminApi.get<{ total: number; responseRate: number | null }>(`/api/admin/anomaly/summary?period=TODAY&keyword=${encodeURIComponent(run.ward.name)}`);
    test.info().annotations.push({ type: '관리자 요약', description: JSON.stringify(adminSummary) });
    expect(adminSummary.total, '요약(피보호자 이름 검색)의 상황 수').toBe(1);
    expect(adminSummary.responseRate, '응답률이 반영된다').toBeGreaterThan(0);

    // 대시보드: real +1, pending -1
    // 주의: 관리자 안전 대시보드 todayAnomaly 는 서비스 전체 숫자라, 판정 전후 사이에 다른 영역·사람이 이상감지·판정을 만들면 깨진다.
    // 이 차이 확인은 "다른 활동이 없을 때만 유효"하다. 깨지면 다른 활동 때문인지 먼저 본다.
    const after = await safety();
    test.info().annotations.push({ type: '관리자 대시보드', description: `전 ${JSON.stringify(before)} -> 후 ${JSON.stringify(after)} (서비스 전체 숫자: 다른 활동이 없을 때만 유효)` });
    expect(after.real - before.real, '오늘 real +1 (서비스 전체 숫자)').toBe(1);
    expect(after.pending - before.pending, '오늘 pending -1 (서비스 전체 숫자)').toBe(-1);
  });

  test('CAM-A10 관리자 이상감지 로그에는 클립 정보가 없다(임시 피보호자 기록만 조회)', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    // 필터 없이 전체를 부르면 남의 기록을 읽게 되므로, 이 실행의 임시 피보호자(wardId)로만 건다
    const res = await run.adminApi.raw('GET', `/api/admin/anomaly?wardId=${run.ward.id}&page=0&size=20`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { data: { content: Record<string, unknown>[] } };
    expect(body.data.content.length, '임시 피보호자의 상황이 1건 이상 있어야 클립 정보 검사가 의미 있다').toBeGreaterThanOrEqual(1);
    for (const item of body.data.content) {
      expect(Object.keys(item).filter(k => /clip/i.test(k)), '관리자 응답에 클립 정보가 없어야 한다').toEqual([]);
    }
  });

  test('CAM-N35 보호자 앱에 감지 이력·판정 화면이 있다', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const page = await openAs(who(run, 'ga'), '/guardian/detection');
    const group = page.getByRole('group', { name: '감지 유형' });
    await expect(group.getByRole('button', { name: /^전체\s*1$/ })).toBeVisible();
    await expect(group.getByRole('button', { name: /^화재\s*1$/ })).toBeVisible();
    await expect(group.getByRole('button', { name: /^흉기\s*0$/ })).toBeVisible();
    await expect(group.getByRole('button', { name: /^낙상\s*0$/ })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '확인 필요' })).toBeVisible();
    // 목록: 상황 카드(종류 배지, 카메라 위치)
    await expect(page.getByText('화재', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(run.camera.label, { exact: true }).first()).toBeVisible();

    // 다른 유형 탭은 빈 안내
    await group.getByRole('button', { name: /^낙상/ }).click();
    await expect(page.getByText('이 유형의 감지 기록이 없어요')).toBeVisible();
    await group.getByRole('button', { name: /^전체/ }).click();

    // 판정이 갈리면(동수) CONFLICTED 안내와 두 판정 버튼. X02 판정에 기대지 않고 여기서 직접 만든다: B=실제 위험, A=괜찮아요
    expect((await run.gbApi.raw('POST', `/api/guardian/anomaly/${run.incident.incidentId}/feedback`, { verdict: 'REAL' })).status(), '준비: B=실제 위험').toBe(200);
    expect((await run.gaApi.raw('POST', `/api/guardian/anomaly/${run.incident.incidentId}/feedback`, { verdict: 'FALSE_ALARM' })).status()).toBe(200);
    const incident = (await run.gaApi.get<{ content: Incident[] }>(`/api/guardian/anomaly/history?wardId=${run.ward.id}&page=0&size=5`)).content[0];
    expect(incident.reviewStatus, 'A=괜찮아요, B=실제 위험 -> 동수').toBe('CONFLICTED');
    await page.reload();
    await expect(page.getByText('다른 보호자와 판정이 달라요. 다시 확인해 주세요.')).toBeVisible();
    await expect(page.getByRole('button', { name: '실제 위험이에요' })).toBeVisible();
    await expect(page.getByRole('button', { name: '괜찮아요' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '확인 필요' })).toContainText(/확인 필요\s*1(?!\d)/);
    test.info().annotations.push({ type: '화면 문구', description: 'v13 문구: "실제 위험이에요"/"괜찮아요", "다른 보호자와 판정이 달라요" (노션 문구와 다름)' });
  });

  test('CAM-A16 정지된 계정·무효화된 토큰·해제된 연결은 티켓을 써도 거절', TAGS, async ({ openAs, tempUser, loginAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const sid = run.camera.sessionId;
    const connected = async () => {
      const g = await loginAs(await tempUser('GUARDIAN'));
      connect(g.user.id, run.ward.id);
      const ticket = ((await (await g.api.raw('POST', `/api/guardian/camera/${sid}/stream-ticket`)).json()) as { data: { ticket: string } }).data.ticket;
      return { g, ticket };
    };

    // 정지: 티켓 발급 뒤 관리자가 이용 제한 -> 403 INACTIVE_USER
    const suspended = await connected();
    expect((await run.adminApi.raw('PATCH', `/api/admin/user/${suspended.g.user.id}`, { status: 'RESTRICTED', statusReason: 'qa' })).status(), '준비: 이용 제한').toBe(200);
    const r1 = await openStreamOnce(mjpegUrl(sid, suspended.ticket));
    expect(r1.status, `정지 계정 ${r1.code ?? ''}`).toBe(403);
    expect(r1.code).toBe('INACTIVE_USER');

    // 연결 해제: 티켓 발급 뒤 해제 -> 403 CAMERA_NOT_CONNECTED
    const released = await connected();
    const connId = psqlRows(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(released.g.user.id)} AND ward_id = ${sqlStr(run.ward.id)};`)[0][0];
    expect((await released.g.api.raw('DELETE', `/api/guardian/connection/disconnection/${connId}`)).status(), '준비: 연결 해제').toBe(200);
    const r2 = await openStreamOnce(mjpegUrl(sid, released.ticket));
    expect(r2.status, `해제된 연결 ${r2.code ?? ''}`).toBe(403);
    expect(r2.code).toBe('CAMERA_NOT_CONNECTED');

    // 토큰 무효화(비밀번호 변경): 티켓 발급 뒤 무효화 -> 401 CAMERA_STREAM_TICKET_INVALID
    const revoked = await connected();
    await sleep(1_100); // 무효화 시각(초 단위)이 티켓 발급 시각보다 뒤가 되게
    const changed = await revoked.g.api.raw('PUT', '/api/user/me/password', { currentPassword: revoked.g.user.password, newPassword: `${revoked.g.user.password}9!` });
    expect(changed.status(), `준비: 비밀번호 변경 ${(await changed.text()).slice(0, 120)}`).toBe(200);
    const r3 = await openStreamOnce(mjpegUrl(sid, revoked.ticket));
    expect(r3.status, `무효화된 토큰 ${r3.code ?? ''}`).toBe(401);
    expect(r3.code).toBe('CAMERA_STREAM_TICKET_INVALID');
  });

  test('CAM-A30 연결되지 않은 피보호자 기록은 403, 없는 상황은 404', TAGS, async ({ openAs, tempUser, loginAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    const wardId = run.ward.id;
    const stranger = await loginAs(await tempUser('GUARDIAN'));
    for (const path of [`/api/guardian/anomaly/history?wardId=${wardId}`, `/api/guardian/anomaly/history/summary?wardId=${wardId}`]) {
      const err = await errOf(await stranger.api.raw('GET', path));
      expectErr(err, 403, 'ANOMALY_NOT_AUTHORIZED', path.split('?')[0].split('/').slice(-2).join('/'));
      expect(err.message ?? '').toMatch(/연결된 피보호자의.*기록만 볼 수 있습니다/);
    }
    await expect.poll(() => countBackendLog(`연결되지 않은 피보호자 이상감지 이력 조회 시도: guardianId=${stranger.user.id}`), { timeout: 20_000 }).toBeGreaterThan(0);

    // 연결 중에는 보이고, 해제하면 예전 기록도 바로 안 보인다
    expect((await run.gaApi.raw('GET', `/api/guardian/anomaly/history?wardId=${wardId}`)).status(), '해제 전').toBe(200);
    const connId = psqlRows(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(run.ga.id)} AND ward_id = ${sqlStr(wardId)} AND status = 'ACTIVE';`)[0][0];
    expect((await run.gaApi.raw('DELETE', `/api/guardian/connection/disconnection/${connId}`)).status(), '준비: 연결 해제').toBe(200);
    expectErr(await errOf(await run.gaApi.raw('GET', `/api/guardian/anomaly/history?wardId=${wardId}`)), 403, 'ANOMALY_NOT_AUTHORIZED', '해제 직후 이력');
    expectErr(await errOf(await run.gaApi.raw('GET', `/api/guardian/anomaly/history/summary?wardId=${wardId}`)), 403, 'ANOMALY_NOT_AUTHORIZED', '해제 직후 요약');

    // 없는 상황 번호는 404 (연결된 보호자 B 로)
    expectErr(await errOf(await run.gbApi.raw('POST', '/api/guardian/anomaly/999999999/feedback', { verdict: 'REAL' })), 404, 'ANOMALY_INCIDENT_NOT_FOUND', '없는 상황 판정');
  });

  test('CAM-X01 피보호자 탈퇴 뒤 카메라·이상감지 이력·클립·말벗 기록이 함께 지워진다', TAGS, async ({ openAs }) => {
    test.setTimeout(480_000);
    const run = await getFireRun(openAs);
    await releaseFireCamera().catch(() => undefined); // 탈퇴로 지워지는지 보려면 카메라는 남겨야 한다 -> 다시 등록
    const label = run.camera.label;
    const camera = await run.wardApi.post<Camera>('/api/ward/camera', { label });
    trackCamera(run.wardApi, camera.id, camera.sessionId, run.proxy); // 탈퇴 확인이 중간에 실패해도 정리 목록에 있게
    const wardId = run.ward.id;
    const count = (table: string) => Number(psqlRows(`SELECT count(*) FROM ${table} WHERE ward_id = ${sqlStr(wardId)};`)[0][0]);

    const before = { camera: count('camera'), event: count('anomaly_event'), incident: count('anomaly_incident'), clip: count('anomaly_clip') };
    expect(before.camera, '준비: 카메라').toBe(1);
    expect(before.event, '준비: 감지 이력').toBeGreaterThanOrEqual(1);
    expect(before.incident, '준비: 상황').toBe(1);
    const clipFiles = psqlRows(`SELECT file_name FROM anomaly_clip WHERE ward_id = ${sqlStr(wardId)};`).map(r => r[0]);
    test.info().annotations.push({ type: '탈퇴 전', description: JSON.stringify({ ...before, 클립파일: clipFiles.length }) });
    // 보호자 B 와 관리자 화면에는 보인다
    expect((await run.gbApi.get<unknown[]>('/api/guardian/camera')).length, '탈퇴 전 B 카메라 목록').toBe(1);
    const adminBefore = await run.adminApi.get<{ content: unknown[] }>(`/api/admin/camera?q=${encodeURIComponent(camera.sessionId)}`);
    expect(adminBefore.content.length, '탈퇴 전 관리자 디바이스 목록').toBe(1);
    const dashBefore = await run.gbApi.raw('GET', `/api/guardian/dashboard?wardId=${wardId}`);
    expect(dashBefore.status(), '탈퇴 전 B 대시보드').toBe(200);

    const res = await run.wardApi.raw('DELETE', '/api/user/me', { password: run.ward.password });
    expect(res.status(), `탈퇴 응답 ${(await res.text()).slice(0, 100)}`).toBe(200);

    // 탈퇴 처리 중(사용자 행이 아직 있을 수 있는 순간)에도 관리자 디바이스 목록에서 빠져야 한다
    const stillThere = Number(psqlRows(`SELECT count(*) FROM users WHERE id = ${sqlStr(wardId)};`)[0][0]) > 0;
    const adminDuring = await run.adminApi.get<{ content: unknown[] }>(`/api/admin/camera?q=${encodeURIComponent(camera.sessionId)}`);
    test.info().annotations.push({ type: '탈퇴 직후', description: `사용자 행 ${stillThere ? '아직 있음(처리 중)' : '이미 없음'}, 관리자 디바이스 목록 ${adminDuring.content.length}건` });
    if (stillThere) expect(adminDuring.content, '탈퇴 처리 중 관리자 디바이스 목록').toEqual([]);

    await expect.poll(() => Number(psqlRows(`SELECT count(*) FROM users WHERE id = ${sqlStr(wardId)};`)[0][0]), { timeout: 30_000, message: '사용자 행이 지워져야 한다' }).toBe(0);
    expect(count('camera'), '카메라 행').toBe(0);
    expect(count('anomaly_event'), '감지 이력 행').toBe(0);
    expect(count('anomaly_clip'), '클립 행').toBe(0);
    expect(Number(psqlRows(`SELECT count(*) FROM anomaly_incident WHERE ward_id = ${sqlStr(wardId)};`)[0][0]), '상황 행').toBe(0);
    // 클립 파일(있었다면)도 지워진다
    if (clipFiles.length === 0) test.info().annotations.push({ type: '클립 삭제 미확인', description: '탈퇴 전 클립이 0건이라 클립 행·파일 삭제는 확인하지 못했다' });
    for (const name of clipFiles) {
      if (!/^[\w.\-]+$/.test(name)) continue;
      const found = await expect
        .poll(() => Number(remoteBash(`docker exec ${env.apiContainer} sh -c "find /data/clips -name '${name}' | wc -l"\n`).trim()), { timeout: 60_000, message: `클립 파일 ${name} 이 남았다` })
        .toBe(0)
        .then(() => true);
      expect(found).toBe(true);
    }
    // 보호자·관리자 화면에서 사라진다
    expect(await run.gbApi.get<unknown[]>('/api/guardian/camera'), '탈퇴 뒤 B 카메라 목록').toEqual([]);
    expect(await run.gbApi.get<unknown[]>('/api/guardian/camera/live'), '탈퇴 뒤 B live 목록').toEqual([]);
    const historyRes = await run.gbApi.raw('GET', '/api/guardian/anomaly/history');
    expect(historyRes.status(), '탈퇴 뒤 B 이력 조회 응답(오류 응답을 빈 목록으로 보지 않는다)').toBe(200);
    const history = (await historyRes.json()) as { data: { content: unknown[] } };
    expect(history.data.content, '탈퇴 뒤 B 이력').toEqual([]);
    const dashAfter = await run.gbApi.raw('GET', `/api/guardian/dashboard?wardId=${wardId}`);
    expect(dashAfter.status(), `탈퇴 뒤 B 대시보드에서 그 피보호자가 사라진다(조회가 ${dashAfter.status()})`).not.toBe(200);
    const adminAfter = await run.adminApi.get<{ content: unknown[] }>(`/api/admin/camera?q=${encodeURIComponent(camera.sessionId)}`);
    expect(adminAfter.content, '탈퇴 뒤 관리자 디바이스 목록').toEqual([]);
    // 말벗 기록 삭제(말벗 AI 쪽 삭제 대기열)는 확인하지 못했다: 말벗 기록 테이블 구조를 이 영역에서 다룰 근거가 없어 임시 사용자 행을 직접 넣지 않았다
    test.info().annotations.push({ type: '말벗 기록 삭제 미확인', description: '탈퇴 시 말벗 기록 삭제·삭제 대기열 적재는 확인하지 못했다' });
  });
});

async function fetchJson(url: string) {
  const res = await fetch(url);
  const raw = await res.text();
  return { status: () => res.status, text: async () => raw };
}
