/**
 * 최종 QA - 관리자(ADM) P1b 묶음 전용 도우미.
 * 공용 src/ 와 P0 도우미(_helpers-adm.ts)는 고치지 않고 가져다만 쓴다.
 *
 * 안전:
 *  - 임시 사용자만 만든다(createTempUser). 고정 계정·setup 프로젝트는 쓰지 않는다.
 *  - DB 는 임시 사용자 id 로 거른 행만 읽고 쓴다. 정리(purge)도 이 id 들의 행만 지운다.
 *  - Redis 는 로그인 속도 제한이 걸렸을 때 relaxAuthRates(이 PC IP 키만)로만 건드린다.
 *  - 토큰·비밀번호·전화번호·응답 본문은 어디에도 찍지 않는다(상태 코드와 개수만).
 */
import { Page, request } from '@playwright/test';

import { Api, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { expect, test as base } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { createTempUser, deleteTempUser, TempUser, TempUserOptions } from '../../../src/seed';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { Body, bodyOf, sleep } from './_helpers-adm';

export const TAGS = { tag: ['@P1', '@ADM'] };

/** 카메라 등록·이상감지 신호는 이 환경변수가 1 일 때만 돌린다 */
export const CAM_SIGNAL_ALLOWED = process.env.CAM_SIGNAL_ALLOWED === '1';

/** 이 테스트 실행 안에서 유일한 짧은 문자열 (이름·검색어에 넣는다) */
export const uniq = () => `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 5)}`;

// ─── 로그인 ─────────────────────────────────────────────────────────────────

export interface Session {
  user: TempUser;
  api: Api;
  login: LoginResult;
  /** openAs 에 그대로 넘기는 브라우저 로그인 정보 */
  who: { label: string; login: LoginResult };
}

export interface SigninResult extends Body {
  login: LoginResult | null;
}

/** 로그인. 429(속도 제한)가 나오면 이 PC IP 키만 지우고 다시 시도한다(최대 attempts 번). 실패 응답도 그대로 돌려준다 */
export async function signin(email: string, password: string, attempts = 8): Promise<SigninResult> {
  for (let i = 1; ; i++) {
    const ctx = await request.newContext({ baseURL: env.apiUrl });
    let body: Body;
    try {
      body = await bodyOf(await ctx.post('/api/auth/signin', { data: { email, password } }));
    } finally {
      await ctx.dispose();
    }
    if (body.status === 429 && i < attempts) {
      await relaxAuthRates();
      await sleep(500 * i);
      continue;
    }
    return { ...body, login: body.status === 200 ? (body.json.data as LoginResult) : null };
  }
}

// ─── 임시 사용자와 정리 ───────────────────────────────────────────────────────

/**
 * 이 테스트가 만든 임시 사용자와, 그 id 로 걸러지는 행을 모아 두었다가 끝날 때(실패해도) 지운다.
 * 감사 로그·알림 이력·상황 기록처럼 FK 가 없거나 cascade 가 불확실한 행도 id 로 걸러 지운다.
 */
export class Owned {
  private ids: string[] = [];
  private apis: Api[] = [];

  user(role: TempUser['role'], options?: TempUserOptions): TempUser {
    const user = createTempUser(role, options);
    this.ids.push(user.id);
    return user;
  }

  async login(user: TempUser): Promise<Session> {
    const res = await signin(user.email, user.password);
    expect(res.login, `준비: 임시 사용자 로그인 (상태 ${res.status})`).not.toBeNull();
    const login = { ...res.login!, refreshToken: res.login!.refreshToken ?? '' };
    const api = await Api.fromLogin(login);
    this.apis.push(api);
    return { user, api, login, who: { label: user.id, login } };
  }

  async dispose() {
    for (const api of this.apis) await api.dispose().catch(() => undefined);
    if (!this.ids.length) return;
    const list = this.ids.map(sqlStr).join(', ');
    const statements = [
      `DELETE FROM anomaly_incident_feedback WHERE guardian_id IN (${list}) OR incident_id IN (SELECT id FROM anomaly_incident WHERE ward_id IN (${list}));`,
      `DELETE FROM anomaly_incident WHERE ward_id IN (${list});`,
      `DELETE FROM inquiry WHERE user_id IN (${list});`,
      `DELETE FROM admin_audit_log WHERE admin_id IN (${list}) OR target_id IN (${list});`,
      `DELETE FROM notification_log WHERE recipient_id IN (${list});`,
      `DELETE FROM medication_reminder_log WHERE medication_id IN (SELECT id FROM medication WHERE ward_id IN (${list}) OR created_by IN (${list}));`,
      `DELETE FROM medication WHERE ward_id IN (${list}) OR created_by IN (${list});`,
      `DELETE FROM camera WHERE ward_id IN (${list});`,
      `DELETE FROM connection WHERE guardian_id IN (${list}) OR ward_id IN (${list});`,
    ];
    for (const sql of statements) {
      try {
        psql(sql);
      } catch (error) {
        console.warn('[ADM-P1b] 정리 SQL 실패(다음 단계는 계속):', String((error as Error).message).split('\n')[0].slice(0, 120));
      }
    }
    for (const id of [...this.ids].reverse()) {
      try {
        deleteTempUser(id);
      } catch (error) {
        console.warn(`[ADM-P1b] 임시 사용자 ${id} 정리 실패:`, String((error as Error).message).split('\n')[0].slice(0, 120));
      }
    }
  }
}

export const test = base.extend<{ owned: Owned }>({
  // eslint-disable-next-line no-empty-pattern
  owned: async ({}, use) => {
    const owned = new Owned();
    try {
      await use(owned);
    } finally {
      await owned.dispose();
    }
  },
});
export { expect };

// ─── DB 읽기·쓰기 (임시 사용자 행만) ─────────────────────────────────────────

export const count = (sql: string) => Number(psql(sql).split('\n')[0]);

/** 두 임시 사용자 사이의 연결 행을 직접 만든다 (relation 은 보호자가 입력하는 관계) */
export function insertConnection(guardianId: string, wardId: string, status: 'ACTIVE' | 'PENDING', relation: string | null = '기타') {
  psql(
    `INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
     VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, ${sqlStr(status)}, ${sqlStr(guardianId)}, ${status === 'ACTIVE' ? 'now()' : 'NULL'}, ${sqlStr(relation)});`,
  );
}

export const connectionStatus = (guardianId: string, wardId: string) =>
  psql(`SELECT status FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} ORDER BY id DESC LIMIT 1;`).split('\n')[0];

export function setUserFields(userId: string, set: string) {
  psql(`UPDATE users SET ${set} WHERE id = ${sqlStr(userId)};`);
}

/** 오늘 한국 시간 00:00 (timestamptz) 를 돌려주는 SQL 조각 */
export const KST_TODAY_START = `(date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;

export const kstDate = (offsetDays = 0) =>
  psql(`SELECT to_char((now() AT TIME ZONE 'Asia/Seoul')::date + ${offsetDays}, 'YYYY-MM-DD');`).split('\n')[0];

/** 한국 시간 자정 앞뒤(직전 2분, 직후 30초)에는 "오늘" 경계가 흔들리므로 지나갈 때까지 기다린다 */
export async function avoidKstMidnight() {
  for (let i = 0; i < 40; i++) {
    const [untilNext, sinceStart] = psql(
      `SELECT extract(epoch FROM (${KST_TODAY_START} + interval '1 day' - now()))::int, extract(epoch FROM (now() - ${KST_TODAY_START}))::int;`,
    )
      .split('|')
      .map(Number);
    if (untilNext > 120 && sinceStart > 30) return;
    await sleep(5_000);
  }
}

export interface AuditRow {
  action: string;
  detail: string;
}

/** 이 관리자가 이 대상에 남긴 감사 로그 (오래된 순) */
export function auditRows(targetId: string, action?: string): AuditRow[] {
  const out = psql(
    `SELECT action || '#' || coalesce(detail, '') FROM admin_audit_log WHERE target_id = ${sqlStr(targetId)}
     ${action ? `AND action = ${sqlStr(action)}` : ''} ORDER BY id;`,
  );
  return out
    ? out.split('\n').map(line => {
        const i = line.indexOf('#');
        return { action: line.slice(0, i), detail: line.slice(i + 1) };
      })
    : [];
}


/** 알림 이력 행: 받는 사람 + 종류 (본문에 줄바꿈이 있어도 한 행으로 읽는다) */
export function notifRows(recipientId: string, type: string): { result: string; reason: string; body: string }[] {
  const out = psql(
    `SELECT result || '|' || coalesce(not_sent_reason, '') || '|' || replace(coalesce(body, ''), E'\n', ' ') FROM notification_log
     WHERE recipient_id = ${sqlStr(recipientId)} AND type = ${sqlStr(type)} ORDER BY id;`,
  );
  return out
    ? out.split('\n').map(line => {
        const [result, reason, ...body] = line.split('|');
        return { result, reason, body: body.join('|') };
      })
    : [];
}
// ─── 이상감지 상황 (DB 직접 입력: 카메라 신호 없이 관리자 로그 화면·API 만 본다) ─────────────

export type DType = 'FIRE' | 'FALL' | 'WEAPON';
export type Review = 'PENDING' | 'REAL' | 'FALSE_ALARM' | 'CONFLICTED';

export interface IncidentInput {
  wardId: string;
  type?: DType;
  review?: Review;
  confidence?: number;
  /** 첫 감지 시각 = 지금부터 몇 분 전 */
  minutesAgo?: number;
  /** 마지막 감지 - 첫 감지 (분) */
  spanMinutes?: number;
  eventCount?: number;
  sessionId?: string;
}

export function insertIncident(i: IncidentInput): number {
  const span = i.spanMinutes ?? 0;
  const ago = i.minutesAgo ?? 0;
  const out = psql(
    `INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status)
     VALUES (${sqlStr(i.wardId)}, ${sqlStr(i.sessionId ?? `qa_p1b_${uniq()}`)}, ${sqlStr(i.type ?? 'FIRE')},
             now() - (${ago} * interval '1 minute'), now() - (${ago} * interval '1 minute') + (${span} * interval '1 minute'),
             ${i.eventCount ?? 1}, ${i.confidence ?? 0.9}, ${sqlStr(i.review ?? 'PENDING')})
     RETURNING id;`,
  );
  return Number(out.split('\n')[0]);
}

export function insertFeedback(incidentId: number, guardianId: string, verdict: 'REAL' | 'FALSE_ALARM') {
  psql(`INSERT INTO anomaly_incident_feedback (incident_id, guardian_id, verdict) VALUES (${incidentId}, ${sqlStr(guardianId)}, ${sqlStr(verdict)});`);
}

// ─── 관리자 API 읽기 ────────────────────────────────────────────────────────

export interface Operation {
  totalUsers: number;
  newUsersToday: number;
  memberComposition: { wards: number; guardians: number };
  cameras: { registered: number; wards: number; maxTotal: number | null };
  pendingConnections: number;
  unansweredInquiries: { count: number; longestWaitingHours: number | null };
  signupTrend: { date: string; count: number }[];
  pendingItems: { connectionRequests: number; todayInquiries: number; announcementDrafts: number };
  generatedAt: string;
}

export async function readOperation(api: Api): Promise<Operation> {
  const res = await bodyOf(await api.raw('GET', '/api/admin/dashboard/operation'));
  expect(res.status, `운영 현황 응답 상태 ${res.status}`).toBe(200);
  return res.json.data as Operation;
}

export interface IncidentItem {
  incidentId: number;
  wardId: string;
  wardName: string | null;
  cameraLabel: string | null;
  detectedType: DType;
  detectedTypeLabel: string;
  startedAt: string;
  lastDetectedAt: string;
  durationMinutes: number;
  eventCount: number;
  maxConfidence: number;
  reviewStatus: Review;
  feedbacks: { guardianId: string; guardianName: string | null; verdict: string; respondedAt: string }[];
}

export interface IncidentPage {
  content: IncidentItem[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
}

export interface AnomalySummary {
  period: string;
  total: number;
  byType: { type: DType; label: string; count: number }[];
  review: { pending: number; real: number; falseAlarm: number; conflicted: number };
  responseRate: number | null;
  aiConfidence: { average: number | null; basis: number };
}

export async function getIncidents(api: Api, query: string): Promise<IncidentPage> {
  const res = await bodyOf(await api.raw('GET', `/api/admin/anomaly?${query}`));
  expect(res.status, `이상감지 목록(${query.replace(/keyword=[^&]*/, 'keyword=...')}) 응답 상태 ${res.status}`).toBe(200);
  return res.json.data as IncidentPage;
}

export async function getSummary(api: Api, query: string): Promise<AnomalySummary> {
  const res = await bodyOf(await api.raw('GET', `/api/admin/anomaly/summary?${query}`));
  expect(res.status, `이상감지 요약 응답 상태 ${res.status}`).toBe(200);
  return res.json.data as AnomalySummary;
}

export const q = (v: string) => encodeURIComponent(v);

// ─── 실시간(STOMP): 받은 메시지 본문까지 모아 둔다 ──────────────────────────────

export interface StompCapture {
  connected: boolean;
  closed: boolean;
  code: number;
  reason: string;
  frames: { destination: string; body: string }[];
}

/**
 * FE 오리진 페이지(예: /login)에서 STOMP 연결을 직접 연다. topics 는 /topic/... 전체 주소.
 * 받은 MESSAGE 의 목적지와 본문을 frames 에 쌓는다. 토큰은 어디에도 남기지 않는다.
 */
export async function openStompCapture(page: Page, key: string, accessToken: string, topics: string[]): Promise<boolean> {
  const wsUrl = `${env.apiUrl.replace(/^http/, 'ws')}/ws?token=${accessToken}`;
  return page.evaluate(
    ({ url, key, topics }) =>
      new Promise<boolean>(resolve => {
        const w = window as unknown as { __admStompP1b?: Record<string, { ws: WebSocket; state: StompCapture }> };
        w.__admStompP1b ??= {};
        const state: StompCapture = { connected: false, closed: false, code: 0, reason: '', frames: [] };
        const ws = new WebSocket(url);
        w.__admStompP1b[key] = { ws, state };
        const timer = setTimeout(() => resolve(false), 15_000);
        ws.onopen = () => ws.send('CONNECT\naccept-version:1.2\nheart-beat:0,0\n\n\0');
        ws.onmessage = event => {
          const data = String(event.data);
          if (data.startsWith('CONNECTED')) {
            state.connected = true;
            topics.forEach((topic, i) => ws.send(`SUBSCRIBE\nid:p1b-${i}\ndestination:${topic}\n\n\0`));
            clearTimeout(timer);
            resolve(true);
          } else if (data.startsWith('MESSAGE')) {
            const destination = /destination:([^\n]+)/.exec(data)?.[1] ?? '';
            const body = data.includes('\n\n') ? data.slice(data.indexOf('\n\n') + 2).replace(/\0+$/, '') : '';
            state.frames.push({ destination, body });
          }
        };
        ws.onerror = () => {
          clearTimeout(timer);
          resolve(false);
        };
        ws.onclose = event => {
          state.closed = true;
          state.code = event.code;
          state.reason = event.reason;
          clearTimeout(timer);
          resolve(false);
        };
      }),
    { url: wsUrl, key, topics },
  );
}

export function readStompCapture(page: Page, key: string): Promise<StompCapture> {
  return page.evaluate(k => (window as unknown as { __admStompP1b: Record<string, { state: StompCapture }> }).__admStompP1b[k].state, key);
}

export function closeStompCapture(page: Page, key: string) {
  return page
    .evaluate(k => (window as unknown as { __admStompP1b?: Record<string, { ws: WebSocket }> }).__admStompP1b?.[k]?.ws.close(), key)
    .catch(() => undefined);
}

/** 지금부터 offsetMs 뒤의 KST 복용 시각 (HH:MM:00) */
export function doseTimeAfter(offsetMs: number) {
  const t = new Date(Date.now() + offsetMs + 9 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}
