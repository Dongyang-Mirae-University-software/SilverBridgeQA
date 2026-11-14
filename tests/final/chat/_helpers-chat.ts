/**
 * 챗봇·대시보드·말벗(CHAT) 최종 QA 공용 도우미 (이 영역 전용).
 * 임시 사용자만 쓴다. DB 는 조회(SELECT)만 하고, 쓰기는 기존 src/ 헬퍼(connect)와 Redis 문자 대체 상한 키(이상감지 헬퍼와 같은 종류)뿐이다.
 */
import { spawnSync } from 'node:child_process';
import net from 'node:net';

import { APIResponse, request } from '@playwright/test';

import { Api } from '../../../src/api';
import { env } from '../../../src/env';
import { psql, redis, remoteBash, sqlStr } from '../../../src/remote';

export interface Res {
  status: number;
  /** JSON 이 아니면 null */
  json: any;
  text: string;
}

export async function toRes(response: APIResponse): Promise<Res> {
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status(), json, text };
}

export async function call(api: Api, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<Res> {
  return toRes(await api.raw(method, path, data));
}

/** AI 를 부르는 호출용: 응답을 최대 150초 기다린다 (기본 15초 제한은 AI 답변에 짧다) */
export async function callLong(api: Api, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<Res> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${api.login.accessToken}` },
  });
  try {
    return await toRes(await ctx.fetch(path, { method, data, timeout: 150_000 }));
  } finally {
    await ctx.dispose();
  }
}

/** 토큰 없이 호출 */
export async function callAnonymous(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<Res> {
  const ctx = await request.newContext({ baseURL: env.apiUrl });
  try {
    return await toRes(await ctx.fetch(path, { method, data }));
  } finally {
    await ctx.dispose();
  }
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 테스트마다 다른 짧은 영숫자 표식 (로그·DB 에서 이 테스트의 흔적만 찾는 데 쓴다) */
export function marker(prefix: string) {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** 위험 신호를 만드는 대답 (AI 가 riskFlag=true 로 판단하는 것을 dev 에서 확인함) */
export const RISK_TEXT = '요즘 너무 힘들어서 그냥 죽고 싶어요';
export const NORMAL_TEXT = '오늘 친구와 산책하고 와서 기분이 좋아요';

// ───────────── 말벗 ─────────────

export async function openTestSession(ward: Api, slot = '09:00') {
  const res = await callLong(ward, 'POST', '/api/ward/companion/test/sessions', { slot });
  if (res.status !== 200) throw new Error(`테스트 대화 열기 실패 ${res.status}: ${res.text.slice(0, 200)}`);
  return res.json.data.sessionId as number;
}

export async function replyText(ward: Api, sessionId: number, text: string) {
  return callLong(ward, 'POST', `/api/ward/companion/sessions/${sessionId}/reply`, { text });
}

export async function finishSession(ward: Api, sessionId: number) {
  return callLong(ward, 'POST', `/api/ward/companion/sessions/${sessionId}/finish`);
}

/**
 * 말벗 위험 알림(COMPANION_RISK)의 문자 대체 발송을 막는다. 푸시 토큰이 없는 임시 보호자는 문자 대체 대상이라,
 * 막지 않으면 Solapi 로 실제 문자 접수가 생긴다. 이상감지 헬퍼(suppressAnomalySmsFallback)와 같은 상한 카운터 키다.
 * 알림 자체와 이력은 그대로 남고, 문자 채널만 RATE_LIMITED 로 건너뛴다.
 */
const suppressedSmsOwners = new Set<string>();

export function suppressCompanionRiskSms(...recipientIds: string[]) {
  for (const id of recipientIds) {
    suppressedSmsOwners.add(id);
    for (const type of ['COMPANION_RISK', 'COMPANION_RISK_PATTERN']) {
      redis('SET', `notify:sms-fallback:${type}:${id}`, '1000000', 'EX', '3600');
    }
  }
}

/** suppressCompanionRiskSms 로 넣은 이 임시 사용자들의 키만 지운다 (afterEach 에서 부른다) */
export function clearCompanionRiskSmsKeys() {
  for (const id of suppressedSmsOwners) {
    for (const type of ['COMPANION_RISK', 'COMPANION_RISK_PATTERN']) {
      try {
        redis('DEL', `notify:sms-fallback:${type}:${id}`);
      } catch {
        // TTL 1시간이라 저절로 사라진다
      }
    }
  }
  suppressedSmsOwners.clear();
}

/** BE 로그에서 이 대화의 위험 알림 발송 줄 수 (최근 10분) - 읽기만 */
export function riskDispatchLogCount(wardId: string, sessionId: number): number {
  if (!/^\w+$/.test(wardId) || !Number.isInteger(sessionId)) throw new Error('허용되지 않는 값');
  const out = remoteBash(
    `docker logs --since 600s ${env.apiContainer} 2>&1 | grep -F '[COMPANION-RISK] 위험 알림 발송: wardId=${wardId}, sessionId=${sessionId},' | grep -c . || true\n`,
  );
  return Number(out.trim()) || 0;
}

/** 위험 알림 발송 처리가 끝났다는 BE 로그 줄이 나올 때까지 기다린다 (발송 반복이 끝난 뒤에 이력을 세려는 것) */
export async function waitForRiskDispatchLog(wardId: string, sessionId: number, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const n = riskDispatchLogCount(wardId, sessionId);
    if (n > 0) return n;
    await sleep(2_000);
  }
  return 0;
}
export interface LogRow {
  type: string;
  result: string;
  reason: string;
  channels: string;
  title: string;
  body: string;
}

/** 받는 사람의 알림 이력(notification_log) 조회 - SELECT 만 */
export function notificationRows(recipientId: string, type = 'COMPANION_RISK'): LogRow[] {
  const out = psql(
    `SELECT type, result, coalesce(not_sent_reason,''), replace(channel_results::text,'|','/'), replace(title,'|','/'), replace(body,'|','/')
     FROM notification_log WHERE recipient_id = ${sqlStr(recipientId)} AND type = ${sqlStr(type)} ORDER BY id;`,
  );
  if (!out) return [];
  return out.split('\n').map(line => {
    const [t, result, reason, channels, title, body] = line.split('|');
    return { type: t, result, reason, channels, title, body };
  });
}

/** 위험 알림이 이력에 쌓일 때까지 기다린다 (커밋 뒤 비동기 발송). 기대 개수가 0이면 잠시 기다린 뒤 센다 */
export async function waitForNotificationRows(recipientId: string, expected: number, type = 'COMPANION_RISK', timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let rows = notificationRows(recipientId, type);
  while (Date.now() < deadline) {
    rows = notificationRows(recipientId, type);
    if (expected > 0 && rows.length >= expected) break;
    await sleep(2_000);
  }
  return rows;
}

export function companionTurnTexts(sessionId: number) {
  const out = psql(
    `SELECT turn_no, (answer_text IS NOT NULL), (bot_text IS NOT NULL), coalesce(mood,'') FROM companion_turn WHERE session_id = ${sessionId} ORDER BY turn_no;`,
  );
  return out
    ? out.split('\n').map(line => {
        const [turnNo, answer, bot, mood] = line.split('|');
        return { turnNo: Number(turnNo), hasAnswer: answer === 't', hasBot: bot === 't', mood };
      })
    : [];
}

/** 연결 id (DB 조회) */
export function activeConnectionId(guardianId: string, wardId: string): number {
  const out = psql(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1;`);
  if (!out) throw new Error('ACTIVE 연결을 찾지 못했습니다.');
  return Number(out);
}

/** 보호자가 제품 API 로 연결을 해제한다 */
export async function disconnectAsGuardian(guardian: Api, guardianId: string, wardId: string) {
  const res = await call(guardian, 'DELETE', `/api/guardian/connection/disconnection/${activeConnectionId(guardianId, wardId)}`);
  if (res.status !== 200) throw new Error(`연결 해제 실패 ${res.status}: ${res.text.slice(0, 200)}`);
}

/**
 * 이 임시 사용자와 관계된 행 중 해당 문자열을 포함한 행 수 (SELECT 만, 범위는 이 사용자 id 로 좁힌다).
 * notification_log 는 받는 사람·피보호자, access_log 는 사용자, admin_audit_log 는 행위자·대상이 이 사용자인 행만 본다.
 */
export function rowsContaining(table: 'notification_log' | 'access_log' | 'admin_audit_log', needle: string, userId: string): number {
  if (!/^[\w가-힣 ]+$/.test(needle)) throw new Error(`허용되지 않는 검색어: ${needle}`);
  const scope = {
    notification_log: `(t.recipient_id = ${sqlStr(userId)} OR t.ward_id = ${sqlStr(userId)})`,
    access_log: `t.user_id = ${sqlStr(userId)}`,
    admin_audit_log: `(t.admin_id = ${sqlStr(userId)} OR t.target_id = ${sqlStr(userId)})`,
  }[table];
  return Number(psql(`SELECT count(*) FROM ${table} t WHERE ${scope} AND t::text LIKE '%${needle}%';`));
}
/** AI 서버 DB(챗 기록) 조회 - SELECT 만, 이 임시 사용자 id 로 범위를 좁힌 질의만 허용 */
export function aiPsql(sql: string): string {
  if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql.trim()) || /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(sql)) {
    throw new Error('AI DB 는 SELECT 한 문장만 허용');
  }
  const script = [
    `docker exec -i silverbridge-ai-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -q' <<'__E2E_SQL__'`,
    sql,
    '__E2E_SQL__',
    '',
  ].join('\n');
  return remoteBash(script).trim();
}

/** 이 임시 사용자의 AI 서버 챗 기록 수 */
export function aiChatLogCount(userId: string): number {
  if (!/^\w+$/.test(userId)) throw new Error('허용되지 않는 id');
  return Number(aiPsql(`SELECT count(*) FROM chat_logs WHERE user_id = '${userId}';`));
}

/** 제품 탈퇴 API 로 임시 사용자를 탈퇴시켜 AI 서버 챗 기록 삭제 경로(AiMemberDataPurgeListener)를 탄다 */
export async function withdrawForAiPurge(api: Api, password: string) {
  return call(api, 'DELETE', '/api/user/me', { password });
}
// ───────────── 서버 밖 접속 확인 ─────────────

/** TCP 접속을 시도해 'connected' | 'refused' | 'timeout' | 'error' 를 돌려준다 */
export function tcpProbe(host: string, port: number, timeoutMs = 6_000): Promise<'connected' | 'refused' | 'timeout' | 'error'> {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const done = (result: 'connected' | 'refused' | 'timeout' | 'error') => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done('timeout'));
    socket.once('connect', () => done('connected'));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED' ? 'refused' : 'error'));
  });
}

/** ssh 설정에서 서버 주소를 읽는다 (접속은 하지 않는다) */
export function sshHostName(): string {
  const out = spawnSync('ssh', ['-G', env.sshHost], { encoding: 'utf8' }).stdout ?? '';
  const line = out.split('\n').find(l => l.startsWith('hostname '));
  if (!line) throw new Error('ssh 설정에서 hostname 을 찾지 못했습니다.');
  return line.slice('hostname '.length).trim();
}
