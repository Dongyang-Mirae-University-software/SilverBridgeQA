/**
 * 최종 QA - 연결·SOS·복약(CONN) P1 묶음 b 전용 도우미.
 *
 * 원칙: 임시 사용자와 그 사용자의 행·키만 다룬다. DB·Redis 는 src/remote.ts 의 기존 함수로만 쓰고,
 * 키는 임시 사용자 id 가 들어간 것만 지운다(패턴 삭제 금지). 비밀번호·토큰·전화번호·응답 본문은 실패 문구에 넣지 않는다.
 */
import { spawn } from 'node:child_process';

import { APIRequestContext, APIResponse, expect, Page, request } from '@playwright/test';

import { Api, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { psql, psqlRows, redis, sqlStr } from '../../../src/remote';

export const TAGS = { tag: ['@P1', '@CONN'] };

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 일정 시간 동안 값을 여러 번 읽어 가장 큰 값을 돌려준다 ("늦게 생기면 안 되는 것"이 정말 안 생기는지 볼 때) */
export async function maxOver(read: () => number, durationMs: number, everyMs = 500): Promise<number> {
  let max = read();
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    await sleep(everyMs);
    max = Math.max(max, read());
  }
  return max;
}

// ── 응답 읽기 (상태 코드·오류 코드·개수만 문구에 쓴다) ──

export interface Res {
  status: number;
  code?: string;
  message?: string;
  data?: unknown;
  headers: Record<string, string>;
  text: string;
}

export async function toRes(res: APIResponse): Promise<Res> {
  const text = await res.text();
  let json: { code?: string; message?: string; data?: unknown } = {};
  try {
    json = text ? (JSON.parse(text) as typeof json) : {};
  } catch {
    json = {};
  }
  return { status: res.status(), code: json.code, message: json.message, data: json.data, headers: res.headers(), text };
}

export async function call(api: Api, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, data?: unknown): Promise<Res> {
  return toRes(await api.raw(method, path, data));
}

/** 상태 코드(와 오류 코드)가 기대와 같아야 한다. 실패 문구에는 이 둘만 찍는다 */
export function expectRes(r: Res, status: number, code?: string, label = '') {
  const where = label ? `[${label}] ` : '';
  expect(r.status, `${where}상태 코드 (오류 코드 ${r.code ?? '없음'})`).toBe(status);
  if (code) expect(r.code, `${where}오류 코드`).toBe(code);
}

// ── 연결 도우미 ──

export const REQUEST_API = '/api/guardian/connection/request';

export function connRows(guardianId: string, wardId: string): { id: number; status: string }[] {
  return psqlRows(
    `SELECT id, status FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} ORDER BY id;`,
  ).map(([id, status]) => ({ id: Number(id), status }));
}

export function liveConnCount(guardianId: string, wardId: string): number {
  return Number(
    psql(`SELECT count(*) FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} AND status IN ('PENDING','ACTIVE');`),
  );
}

export function connStatus(id: number): string {
  return psql(`SELECT status FROM connection WHERE id = ${id};`);
}

/** 24시간 요청 횟수 키 (임시 보호자·임시 피보호자 쌍의 것만) */
export function counterKey(guardianId: string, wardId: string) {
  return `connection:request:count:${guardianId}:${wardId}`;
}
export function counterValue(guardianId: string, wardId: string): string {
  return redis('GET', counterKey(guardianId, wardId));
}
export function counterTtl(guardianId: string, wardId: string): number {
  return Number(redis('TTL', counterKey(guardianId, wardId)));
}
export function clearCounter(guardianId: string, wardId: string) {
  redis('DEL', counterKey(guardianId, wardId));
}

/** 이 임시 보호자의 연결 요청·미리보기 분당 제한 키 (임시 사용자 키만) */
export function clearConnRateKeys(guardianId: string) {
  redis('DEL', `rate:connection-request:${guardianId}`, `rate:connection-preview:1m:${guardianId}`, `rate:connection-preview:1h:${guardianId}`);
}

/** 알림 이력 (수신자 기준, 조회만) */
export function notiRows(recipientId: string, type?: string): { type: string; title: string; body: string; result: string }[] {
  return psqlRows(
    `SELECT type, coalesce(title,''), replace(coalesce(body,''), chr(10), ' / '), coalesce(result,'')
     FROM notification_log WHERE recipient_id = ${sqlStr(recipientId)} ${type ? `AND type = ${sqlStr(type)}` : ''} ORDER BY id;`,
  ).map(([t, title, body, result]) => ({ type: t, title, body, result }));
}

/** 화면의 실시간/푸시 토스트 영역 전체 글자 */
export async function liveText(page: Page) {
  return (await page.locator('[aria-live="polite"]').allInnerTexts()).join(' | ');
}

/** 연결 카드 (카드 안에도 li 가 있어서 data-role 로 카드만 고른다) */
export function connCard(page: Page, partnerName: string) {
  return page.locator('li[data-role]').filter({ hasText: partnerName });
}

// ── 실시간(WebSocket) ──

/**
 * 페이지가 열리기 전에 호출한다. 서버가 보낸 STOMP 프레임을 모으고, drop 에 맞는 프레임은 화면에 전달하지 않는다.
 * 모은 프레임은 frames 배열에 쌓인다.
 */
export async function watchWs(page: Page, opts: { drop?: RegExp } = {}) {
  const frames: string[] = [];
  await page.routeWebSocket(/\/ws(\?|$)/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => server.send(message));
    server.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString();
      frames.push(frame);
      if (opts.drop?.test(frame)) return;
      ws.send(message);
    });
  });
  return frames;
}

/** 토픽(끝 이름)이 맞는 프레임의 본문(JSON)들 */
export function frameBodies(frames: string[], topic: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const frame of frames) {
    const destination = /^destination:(.*)$/m.exec(frame)?.[1]?.trim() ?? '';
    if (!destination.endsWith(`/${topic}`)) continue;
    const body = frame.split(/\r?\n\r?\n/).slice(1).join('\n\n').replace(/\0$/, '');
    try {
      out.push(JSON.parse(body) as Record<string, unknown>);
    } catch {
      out.push({});
    }
  }
  return out;
}

/**
 * watchWs 와 같지만 화면으로 가는 STOMP 프레임을 직접 넣을 수 있다 (늦게 도착한 지난 날짜 신호 같은 상황 재현용).
 * 페이지가 열리기 전에 호출한다. 구독 id 는 화면이 해당 토픽을 구독할 때 알아낸다.
 */
export async function watchWsInjectable(page: Page) {
  const frames: string[] = [];
  const subscriptions = new Map<string, string>();
  let sender: ((frame: string) => void) | undefined;
  await page.routeWebSocket(/\/ws(\?|$)/, ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString();
      if (frame.startsWith('SUBSCRIBE')) {
        const id = /^id:(.*)$/m.exec(frame)?.[1]?.trim();
        const destination = /^destination:(.*)$/m.exec(frame)?.[1]?.trim();
        if (id && destination) subscriptions.set(destination.split('/').pop() ?? destination, id);
      }
      server.send(message);
    });
    server.onMessage(message => {
      frames.push(typeof message === 'string' ? message : message.toString());
      ws.send(message);
    });
    sender = frame => ws.send(frame);
  });
  return {
    frames,
    subscriptionId: (topic: string) => subscriptions.get(topic),
    /** 서버가 보낸 것처럼 토픽 메시지 한 건을 화면에 넣는다 */
    inject(userId: string, topic: string, payload: Record<string, string>) {
      const id = subscriptions.get(topic);
      if (!id || !sender) throw new Error(`구독 id 가 없다: ${topic}`);
      sender(
        ['MESSAGE', `destination:/topic/${userId}/${topic}`, `subscription:${id}`, `message-id:e2e-p1b-${Date.now()}`, 'content-type:application/json', '', `${JSON.stringify(payload)}\0`].join('\n'),
      );
    },
  };
}
// ── DB 트랜잭션을 잠시 붙잡기 (경합 재현용, 임시 행만) ──

export function holdTransaction(sql: string, holdSeconds: number, end: 'COMMIT' | 'ROLLBACK' = 'COMMIT') {
  const script = [
    `docker exec -i ${env.dbContainer} sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -q' <<'__E2E_SQL__'`,
    'BEGIN;',
    sql,
    `SELECT pg_sleep(${holdSeconds});`,
    `${end};`,
    '__E2E_SQL__',
    '',
  ].join('\n');
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', env.sshHost, 'bash -s']);
    let stderr = '';
    child.stderr.on('data', chunk => (stderr += String(chunk)));
    child.on('error', reject);
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`트랜잭션 유지 실패 (exit ${code}): ${stderr.slice(0, 200)}`))));
    child.stdin.end(script);
  });
}

// ── 복약 도우미 ──

/** 한국 시간 기준으로 지금부터 hours 시간 뒤의 복용 시각("HH:MM:00") */
export function kstAfter(hours: number): string {
  const later = new Date(Date.now() + hours * 3600_000);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(later);
  if (hours <= 0) return `${time}:00`; // 지금 이전·지금은 그대로
  const [h, m] = time.split(':').map(Number);
  // 밤에 돌리면 "지금부터 N시간 뒤"가 다음 날로 넘어가 오늘 약의 시각 순서가 뒤바뀐다. 하루 안에 머물게 자정 앞에서 시간 차이만큼 간격을 두고 자른다.
  const nowMin = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', hourCycle: 'h23' }).format(new Date())) * 60
    + Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', minute: '2-digit' }).format(new Date()));
  let target = h * 60 + m;
  if (target <= nowMin) target = Math.max(nowMin + 1, 1439 - 10 * Math.max(1, 12 - hours)); // 다음 날로 넘어감
  target = Math.min(target, 1439 - 10 * Math.max(1, 12 - hours));
  target = Math.max(target, Math.min(nowMin + 1, 1439));
  return `${String(Math.floor(target / 60)).padStart(2, '0')}:${String(target % 60).padStart(2, '0')}:00`;
}

/** 한국 시간 기준 지금의 자정 이후 분 */
export function kstMinutesNow(): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

export function kstToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}

/** 보호자 API 로 약 한 개를 등록한다 */
export async function addMed(api: Api, wardId: string, name: string, doseTime: string, doseAmount = 1): Promise<number> {
  const created = await api.post<{ medicationId: number }>(`/api/guardian/ward/${wardId}/medication`, {
    name, timeSlot: 'MORNING', doseTime, doseAmount,
  });
  return created.medicationId;
}

export function intakeRows(medicationId: number): number {
  return Number(psql(`SELECT count(*) FROM medication_intake WHERE medication_id = ${medicationId};`));
}

export function medDeleted(medicationId: number): boolean | null {
  const out = psql(`SELECT (deleted_at IS NOT NULL)::text FROM medication WHERE id = ${medicationId};`);
  return out === '' ? null : out === 'true';
}

// ── OCR 사진 만들기와 올리기 ──

/** 약 봉투 모양 사진(PNG). items 는 [약 이름, 1회 복용량 글자] */
export async function renderBagPng(page: Page, items: { name: string; dose: string }[]): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 200 + items.length * 130 });
  const rows = items
    .map(
      item => `
        <div style="font-size:34px;font-weight:700;margin-top:16px">${item.name}</div>
        <div style="font-size:28px">1회 ${item.dose} &nbsp; 1일 3회 &nbsp; 3일분 &nbsp; (식후 30분)</div>`,
    )
    .join('');
  await page.setContent(`
    <body style="margin:0;background:#fff;font-family:'Noto Sans CJK KR','Noto Sans KR',sans-serif;color:#000">
      <div style="padding:28px 36px;border:4px solid #000;margin:20px">
        <div style="font-size:30px;font-weight:700">약 봉 투 (조제약)</div>
        <div style="font-size:26px;margin-top:10px">조제일: 2026-11-13</div>
        <div style="font-size:26px">복용시간: 아침 &nbsp; 점심 &nbsp; 저녁</div>
        <hr style="border:2px solid #000">${rows}
      </div>
    </body>`);
  return page.screenshot({ type: 'png' });
}

/** 글자가 없는 풍경 그림(PNG) */
export async function renderLandscapePng(page: Page): Promise<Buffer> {
  await page.setViewportSize({ width: 800, height: 500 });
  await page.setContent(`
    <body style="margin:0;width:800px;height:500px;overflow:hidden;background:linear-gradient(#7ec8ff 0%,#d8f0ff 60%,#fff 60%)">
      <div style="position:absolute;left:560px;top:50px;width:90px;height:90px;border-radius:50%;background:#ffd84d"></div>
      <div style="position:absolute;left:-80px;top:280px;width:520px;height:420px;border-radius:50%;background:#3e9b4f"></div>
      <div style="position:absolute;left:300px;top:320px;width:640px;height:420px;border-radius:50%;background:#2f7d3e"></div>
    </body>`);
  return page.screenshot({ type: 'png' });
}

/** multipart 로 파일(들)을 올린다. field 가 null 이면 image 파트 없이 다른 이름의 파트만 보낸다 */
export async function postImage(
  path: string,
  login: LoginResult,
  file: { buffer: Buffer; name: string; mimeType: string } | null,
): Promise<Res> {
  const ctx: APIRequestContext = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${login.accessToken}` },
  });
  try {
    const res = await ctx.post(path, {
      multipart: file ? { image: file } : { memo: 'image 파트 없음' },
      timeout: 120_000,
    });
    return await toRes(res);
  } finally {
    await ctx.dispose();
  }
}

export function ocrPath(wardId: string) {
  return `/api/guardian/ward/${wardId}/medication/ocr`;
}

/** 구조가 서버 검증만 통과하는 큰 가짜 JPG (헤더 + 0 으로 채움) */
export function fakeJpeg(bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes, 0);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buffer, 0);
  return buffer;
}

export const MB = 1024 * 1024;

/** 이 보호자의 OCR 속도 제한 키 (임시 사용자 키만) */
export function ocrRateKeys(guardianId: string) {
  return [`rate:medication-ocr:1m:${guardianId}`, `rate:medication-ocr:1h:${guardianId}`];
}
export function clearOcrRate(guardianId: string) {
  redis('DEL', ...ocrRateKeys(guardianId));
}

export interface OcrDrug {
  name?: string;
  perDose?: number | null;
  timesPerDay?: number | null;
  days?: number | null;
  slots?: string[];
  timing?: string | null;
  confidence?: string;
  inList?: boolean | null;
  suggestions?: string[] | null;
}
export interface OcrData {
  readable: boolean;
  drugs: OcrDrug[];
}

/** 약 봉투 읽기 응답을 한 번만 받아 이 프로세스 안에서 나눠 쓴다 (Claude 호출을 줄이려고) */
export const BAG_FAKE_PREFIX = '큐에이비정';
export function bagItems(stamp: string) {
  return [
    { name: '타이레놀정500밀리그램', dose: '1정' },
    { name: `${BAG_FAKE_PREFIX}${stamp}`, dose: '0.5정' },
  ];
}
