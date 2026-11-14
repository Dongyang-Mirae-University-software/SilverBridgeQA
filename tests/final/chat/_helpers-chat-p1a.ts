/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1a 전용 도우미.
 * 임시 사용자만 쓴다. DB 는 이 임시 사용자들의 행만 다루고(약·카메라·상황·연결 시드), Redis 는 이 사용자 id 가 들어간 키만 만든다/지운다.
 * 로그인 속도 제한은 이 PC IP 키만 푼다(relaxAuthRates). 모든 IP 를 지우는 loginAs·loginViaForm 은 쓰지 않는다.
 */
import { APIResponse, expect, request, TestInfo } from '@playwright/test';

import { Api, ApiError, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { psql, redis, remoteBash, sqlStr } from '../../../src/remote';
import type { LoggedIn } from '../../../src/fixtures';
import type { TempUser } from '../../../src/seed';
import { suppressSosNotify } from '../../../src/variables';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { aiChatLogCount, marker, sleep, withdrawForAiPurge } from './_helpers-chat';

export { marker, sleep };

export const TAGS = { tag: ['@P1', '@CHAT'] };

/** 1 이면 카메라 행·이상감지 상황을 만드는 케이스를 돌린다 (그 밖에는 건너뛴다) */
export const CAM_SIGNAL_ALLOWED = process.env.CAM_SIGNAL_ALLOWED === '1';

export type Role = 'guardian' | 'ward';

// ───────────── 응답 ─────────────

export interface FullRes {
  status: number;
  json: any;
  text: string;
  headers: Record<string, string>;
  ms: number;
}

async function toFull(response: APIResponse, startedAt: number): Promise<FullRes> {
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status(), json, text, headers: response.headers(), ms: Date.now() - startedAt };
}

/** 헤더까지 돌려주는 호출. AI 를 부르는 전송은 최대 150초 기다린다 */
export async function callFull(
  api: Api,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  data?: unknown,
  timeoutMs = 150_000,
): Promise<FullRes> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${api.login.accessToken}` },
  });
  const startedAt = Date.now();
  try {
    return await toFull(await ctx.fetch(path, { method, data, timeout: timeoutMs }), startedAt);
  } finally {
    await ctx.dispose();
  }
}

/** 챗 전송. sessionId 를 안 주면 새로 만든다 */
export function chatSend(api: Api, role: Role, message: string | undefined, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = { sessionId: marker('qa'), context: {}, ...extra };
  if (message !== undefined) body.message = message;
  return callFull(api, 'POST', `/api/${role}/chat`, body);
}

export async function chatLogs(api: Api, role: Role) {
  const res = await callFull(api, 'GET', `/api/${role}/chat/logs`, undefined, 30_000);
  expect(res.status, `GET /api/${role}/chat/logs`).toBe(200);
  return res.json.data as Array<Record<string, any>>;
}

/** 길이가 정확히 n 인 문자열 (앞에 표식, 나머지는 한글 한 글자 반복 - UTF-16 한 칸짜리) */
export function padTo(prefix: string, n: number) {
  expect(prefix.length).toBeLessThanOrEqual(n);
  return prefix + '가'.repeat(n - prefix.length);
}

// ───────────── 로그인·정리 ─────────────

const tracked: LoggedIn[] = [];
const apis: Api[] = [];
const ownKeys: string[] = [];

/** 이 PC IP 의 속도 제한만 풀면서 로그인한다 (429 면 풀고 다시) */
export async function loginSafe(user: TempUser): Promise<LoggedIn> {
  let login: LoginResult | undefined;
  for (let i = 1; !login; i++) {
    try {
      login = await Api.signin(user.email, user.password);
    } catch (error) {
      const limited = error instanceof ApiError && error.status === 429;
      if (!limited || i >= 6) throw new Error(`로그인 실패 (상태 ${error instanceof ApiError ? error.status : '알 수 없음'})`);
      await relaxAuthRates();
      await sleep(500 * i);
    }
  }
  const api = await Api.fromLogin(login);
  apis.push(api);
  return { user, api, login, who: { label: user.id, login } };
}

/** 챗을 쓰는 사용자: 끝날 때 제품 탈퇴 API 로 지워 AI 서버 기록 삭제 경로를 탄다 */
export function track(login: LoggedIn) {
  tracked.push(login);
  return login;
}

export function untrack(login: LoggedIn) {
  const i = tracked.indexOf(login);
  if (i >= 0) tracked.splice(i, 1);
}

/** 이 사용자 id 가 들어간 Redis 키를 기록해 두었다가 끝날 때 지운다 */
export function trackKey(key: string) {
  ownKeys.push(key);
}

export async function cleanupChat(info: TestInfo) {
  const users = tracked.splice(0);
  for (const { user, api } of users) {
    try {
      const res = await withdrawForAiPurge(api, user.password);
      let left = aiChatLogCount(user.id);
      for (let i = 0; i < 6 && left > 0; i++) {
        await sleep(2_500);
        left = aiChatLogCount(user.id);
      }
      info.annotations.push({ type: '정리', description: `탈퇴 ${res.status}, AI 서버 챗 기록 남은 수 ${left}` });
      expect.soft(left, `탈퇴 뒤 AI 서버에 남은 ${user.id} 의 챗 기록`).toBe(0);
    } catch (error) {
      const why = String(error).slice(0, 200);
      info.annotations.push({ type: '정리 실패', description: why });
      // 정리가 실패하면 AI 서버에 기록이 남을 수 있으니 테스트도 실패로 표시한다
      expect.soft(false, `정리 실패(AI 서버에 ${user.id} 의 기록이 남을 수 있음): ${why}`).toBe(true);
    }
  }
  for (const key of ownKeys.splice(0)) {
    try {
      redis('DEL', key);
    } catch {
      // TTL 이 있어 저절로 사라진다
    }
  }
  for (const api of apis.splice(0)) {
    await api.dispose().catch(() => undefined);
  }
}

// ───────────── 읽기 전용 확인 ─────────────

/** BE 컨테이너 로그에서 최근 N초 안에 이 문자열(고정 문자열)이 몇 줄에 나왔는지 - 읽기만 */
export function beLogCount(needle: string, sinceSeconds = 300): number {
  if (!/^[\w가-힣:=\-. \[\]/,]+$/.test(needle)) throw new Error(`허용되지 않는 검색어: ${needle}`);
  const out = remoteBash(`docker logs --since ${sinceSeconds}s ${env.apiContainer} 2>&1 | grep -cF -- '${needle}' || true\n`);
  return Number(out.trim()) || 0;
}

export async function waitBeLog(needle: string, timeoutMs = 20_000, sinceSeconds = 300) {
  const deadline = Date.now() + timeoutMs;
  let n = beLogCount(needle, sinceSeconds);
  while (n === 0 && Date.now() < deadline) {
    await sleep(2_000);
    n = beLogCount(needle, sinceSeconds);
  }
  return n;
}

// ───────────── 대시보드용 시드 (임시 사용자 자신의 행만) ─────────────

/** 보호자-피보호자 ACTIVE 연결. 연결 시각을 3일 앞으로 당겨 시드한 상황이 "연결 이전 상황"으로 숨겨지지 않게 한다 */
export function connectOld(guardianId: string, wardId: string) {
  psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
        VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'ACTIVE', ${sqlStr(guardianId)}, now() - interval '3 days', '기타');`);
}

/** 연결 행 상태를 바꾼다 (이 보호자-피보호자 쌍의 행만) */
export function setConnectionStatus(guardianId: string, wardId: string, status: 'ACTIVE' | 'DISCONNECTED' | 'PENDING') {
  psql(`UPDATE connection SET status = ${sqlStr(status)}, updated_at = now()
        WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)};`);
}

/** 복용 시각이 하루 중 가장 이른 약(00:00)이라 오늘 어느 때든 "지난 시각"이다. createdYesterday 면 어제 등록한 약으로 센다 */
export function insertMedication(o: { wardId: string; createdBy: string; name: string; createdYesterday?: boolean }): number {
  const id = Number(
    psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time, dose_amount)
          VALUES (${sqlStr(o.wardId)}, ${sqlStr(o.createdBy)}, ${sqlStr(o.name)}, 'MORNING', '00:00:00', 1) RETURNING id;`),
  );
  if (o.createdYesterday) {
    psql(`UPDATE medication SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day' WHERE id = ${id};`);
  }
  return id;
}

/** 피보호자 복약 알림을 끄고, 오늘 미복용 요약이 이미 나간 것으로 기록해 보호자에게 알림·문자가 나가지 않게 한다 */
export function quietMedication(guardianId: string, wardId: string) {
  psql(`INSERT INTO medication_setting (user_id, alarm_enabled, remind_again_enabled)
        VALUES (${sqlStr(wardId)}, false, false)
        ON CONFLICT (user_id) DO UPDATE SET alarm_enabled = false, remind_again_enabled = false;`);
  psql(`INSERT INTO medication_missed_alert_log (guardian_id, ward_id, dose_date, missed_count, total_count, sent_at)
        VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, (now() AT TIME ZONE 'Asia/Seoul')::date, 1, 1, now())
        ON CONFLICT DO NOTHING;`);
}

/** 피보호자 SOS 를 제품 API 로 1건 보낸다. 보호자 알림(푸시·문자)은 쿨다운 키로 막는다 */
export async function sendSos(ward: LoggedIn) {
  suppressSosNotify(ward.user.id, 600);
  trackKey(`sos:notify:cooldown:${ward.user.id}`);
  const res = await callFull(ward.api, 'POST', '/api/ward/sos', {}, 30_000);
  expect(res.status, 'POST /api/ward/sos (생성 201)').toBe(201);
}

export function insertCamera(wardId: string, sessionId: string, active = true) {
  psql(`INSERT INTO camera (ward_id, session_id, device_id, label, registered_by, is_active)
        VALUES (${sqlStr(wardId)}, ${sqlStr(sessionId)}, ${sqlStr('qa-p1a-dev-' + sessionId)}, ${sqlStr('거실')}, ${sqlStr(wardId)}, ${active});`);
}

export function insertIncident(wardId: string, sessionId: string, review: 'PENDING' | 'CONFLICTED' | 'REAL' | 'FALSE_ALARM') {
  psql(`INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status, created_at, updated_at)
        VALUES (${sqlStr(wardId)}, ${sqlStr(sessionId)}, 'FIRE', now(), now(), 1, 0.9, ${sqlStr(review)}, now(), now());`);
}

export const dashboardPath = (query = '') => `/api/guardian/dashboard${query}`;
