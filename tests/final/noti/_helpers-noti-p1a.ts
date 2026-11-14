/**
 * 최종 QA 알림(NOTI) P1a 묶음 전용 도우미.
 * 임시 사용자만 쓴다. DB·Redis 는 임시 사용자 자신의 행·키만 다룬다(알림 이력 행 넣기·읽기, 임시 사용자 키).
 * P0 도우미(_helpers-noti.ts)는 고치지 않고 가져다 쓴다.
 */
import { randomBytes } from 'node:crypto';

import { Page } from '@playwright/test';

import { expect } from '../../../src/fixtures';
import { psql, psqlRows, redis, sqlStr } from '../../../src/remote';
import { myRateSuffix } from '../auth/_helpers-auth';

export const P1A_TAGS = { tag: ['@P1', '@NOTI'] };

/** 이 PC IP 의 fcm-release 속도 제한 카운터 하나만 지운다(signin·재발급 등 다른 카운터는 건드리지 않는다) */
export async function relaxFcmReleaseRate() {
  const suffix = await myRateSuffix();
  redis('DEL', `rate:fcm-release:${suffix}`);
}

/** 카메라 등록·이상감지 신호가 나가는 테스트를 켜는 환경변수 (CAM 영역 소관) */
export const CAM_SIGNAL_ALLOWED = process.env.CAM_SIGNAL_ALLOWED === '1';
export const CAM_SIGNAL_SKIP_REASON = 'CAM 영역 소관: 카메라 등록·이상감지 신호는 CAM_SIGNAL_ALLOWED=1 일 때만 보낸다';

/** 관리자 알림 이력 검색용 이름 조각. 소문자 영문+숫자라 대소문자·LIKE 문자 문제가 없고 다른 사용자와 겹치지 않는다 */
export function uniqueNameTag() {
  return `qa${randomBytes(5).toString('hex')}`;
}

/** 길이만 흉내 낸 가짜 웹 FCM 토큰(앞 11자 + ':APA91b' + 나머지). 실제로 발급된 적 없는 값이라 푸시는 나가지 않는다 */
export function longFakeToken() {
  const body = randomBytes(110).toString('base64url');
  return `${randomBytes(8).toString('base64url').slice(0, 11)}:APA91b${body}`.slice(0, 163);
}

// ───────────── 알림 이력(notification_log) 직접 넣기·읽기 (임시 사용자 자신의 행만) ─────────────

export interface InsertLog {
  recipientId: string;
  wardId?: string | null;
  type: string;
  result: 'DELIVERED' | 'SMS_FALLBACK' | 'FAILED' | 'NOT_SENT';
  reason?: 'RESTRICTED_ACCOUNT' | 'WITHDRAWING_ACCOUNT' | 'NO_ENABLED_CHANNEL' | null;
  channels?: Array<{ channel: string; status: string; reason: string | null }>;
  title?: string;
  body?: string;
  /** 테스트 코드가 정한 고정 SQL 식. 예: "now() - interval '10 days'" */
  createdAtSql?: string;
}

/** 임시 사용자 둘의 알림 이력 행을 직접 넣고 id 를 돌려준다 (발송 없이 화면·집계 조건을 정확히 만들 때) */
export function insertLogRow(o: InsertLog): number {
  const channels = o.channels ?? [];
  const reason = o.result === 'NOT_SENT' ? (o.reason ?? 'NO_ENABLED_CHANNEL') : null;
  const out = psql(
    `INSERT INTO notification_log (created_at, type, recipient_id, ward_id, title, body, result, not_sent_reason, channel_results)
     VALUES (${o.createdAtSql ?? 'now()'}, ${sqlStr(o.type)}, ${sqlStr(o.recipientId)}, ${sqlStr(o.wardId ?? null)},
             ${sqlStr(o.title ?? 'QA 제목')}, ${sqlStr(o.body ?? 'QA 본문')}, ${sqlStr(o.result)}, ${sqlStr(reason)},
             ${sqlStr(JSON.stringify(channels))}::jsonb)
     RETURNING id;`,
  );
  return Number(out.split('\n')[0]);
}

export function readAtOf(id: number): string {
  return psql(`SELECT coalesce(read_at::text, '') FROM notification_log WHERE id = ${id};`);
}

/** 수신자의 알림 이력 전체 행 수 (종류 무관) */
export function logCountOf(recipientId: string): number {
  return Number(psql(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(recipientId)};`));
}

// ───────────── 연결 ─────────────

/** 보호자가 피보호자에게 보낸 대기(PENDING) 연결의 id (임시 사용자 둘 사이의 행만 읽는다) */
export function pendingConnectionId(guardianId: string, wardId: string): number {
  const rows = psqlRows(
    `SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} AND status = 'PENDING' ORDER BY id DESC LIMIT 1;`,
  );
  expect(rows.length, '대기 중인 연결 요청 행이 있어야 한다').toBe(1);
  return Number(rows[0][0]);
}

// ───────────── STOMP 직접 연결 (메시지 목적지·본문을 모은다) ─────────────

export interface P1aFrame {
  destination: string;
  body: string;
}

export interface P1aState {
  connected: boolean;
  close: { code: number; reason: string } | null;
  frames: P1aFrame[];
  /** ERROR 프레임을 받았는가 */
  errored: boolean;
  readyState: number;
}

type ProbeWindow = {
  __p1aProbe?: Record<
    string,
    { ws: WebSocket; connected: boolean; close: { code: number; reason: string } | null; frames: P1aFrame[]; errored: boolean }
  >;
};

/** FE 오리진 페이지 안에서 STOMP 연결을 열고 CONNECTED·닫힘·15초 중 먼저 오는 것까지 기다린다 */
export async function p1aOpen(page: Page, name: string, url: string): Promise<{ connected: boolean; closed: boolean }> {
  return page.evaluate(
    ({ name, url }) =>
      new Promise<{ connected: boolean; closed: boolean }>(resolve => {
        const w = window as unknown as ProbeWindow;
        w.__p1aProbe ??= {};
        const ws = new WebSocket(url);
        const st = { ws, connected: false, close: null as { code: number; reason: string } | null, frames: [] as P1aFrame[], errored: false };
        w.__p1aProbe[name] = st;
        const timer = setTimeout(() => resolve({ connected: st.connected, closed: st.close !== null }), 15_000);
        const done = () => {
          clearTimeout(timer);
          resolve({ connected: st.connected, closed: st.close !== null });
        };
        ws.onopen = () => ws.send('CONNECT\naccept-version:1.2\nheart-beat:0,0\n\n\0');
        ws.onmessage = event => {
          const text = String(event.data);
          const command = text.split('\n')[0].trim();
          if (command === 'CONNECTED') {
            st.connected = true;
            done();
          } else if (command === 'ERROR') {
            st.errored = true;
          } else if (command === 'MESSAGE') {
            const destination = /(?:^|\n)destination:([^\n]*)/.exec(text)?.[1] ?? '';
            const split = text.indexOf('\n\n');
            st.frames.push({ destination, body: split >= 0 ? text.slice(split + 2).replace(/\0$/, '') : '' });
          }
        };
        ws.onclose = event => {
          st.close = { code: event.code, reason: event.reason };
          done();
        };
        ws.onerror = () => undefined;
      }),
    { name, url },
  );
}

export async function p1aSubscribe(page: Page, name: string, destination: string, id: string) {
  await page.evaluate(
    ({ name, destination, id }) => {
      const st = (window as unknown as ProbeWindow).__p1aProbe![name];
      st.ws.send(`SUBSCRIBE\nid:sub-${id}\ndestination:${destination}\n\n\0`);
    },
    { name, destination, id },
  );
}

export async function p1aState(page: Page, name: string): Promise<P1aState> {
  return page.evaluate(name => {
    const st = (window as unknown as ProbeWindow).__p1aProbe![name];
    return { connected: st.connected, close: st.close, frames: st.frames.map(f => ({ ...f })), errored: st.errored, readyState: st.ws.readyState };
  }, name);
}

/** 이 목적지로 받은 MESSAGE 본문(JSON)들 */
export async function p1aBodies(page: Page, name: string, destination: string): Promise<Record<string, unknown>[]> {
  const state = await p1aState(page, name);
  return state.frames
    .filter(f => f.destination === destination)
    .map(f => {
      try {
        return JSON.parse(f.body) as Record<string, unknown>;
      } catch {
        return { raw: f.body.slice(0, 80) };
      }
    });
}

/**
 * SUBSCRIBE 뒤 서버가 구독을 반영할 시간을 준다. 이 서버는 receipt 를 주지 않아 성립 신호가 없다(P0 도우미와 같은 이유).
 * 구독이 안 됐다면 뒤이은 "메시지가 온다" 단언이 실패하므로 헛통과하지 않는다.
 */
export async function p1aSettle(page: Page, name: string) {
  await page.waitForTimeout(1_000);
  const state = await p1aState(page, name);
  expect(state.errored, `${name}: 구독 거부(ERROR) 프레임이 없다`).toBe(false);
  expect(state.close, `${name}: 연결이 닫히지 않았다`).toBeNull();
}

export async function p1aClose(page: Page, name: string) {
  await page
    .evaluate(name => (window as unknown as ProbeWindow).__p1aProbe?.[name]?.ws.close(), name)
    .catch(() => undefined);
}

/** 메시지가 올 때까지 기다린다 */
export async function p1aWaitFor(page: Page, name: string, destination: string, message: string, count = 1) {
  await expect
    .poll(async () => (await p1aBodies(page, name, destination)).length, { timeout: 20_000, intervals: [500, 1_000], message })
    .toBeGreaterThanOrEqual(count);
  return p1aBodies(page, name, destination);
}
