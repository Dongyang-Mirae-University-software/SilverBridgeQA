/**
 * 최종 QA - 관리자(ADM) P1a 묶음 전용 도우미.
 * 공용 src/ 와 P0 도우미(_helpers-adm.ts)는 고치지 않고 가져다 쓴다.
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 로그인은 속도 제한(429)이 나면 기다리다가, 그래도 나면 "이 PC IP 키만" 지운다(relaxAuthRates).
 *  - DB·Redis 는 임시 사용자 자신의 행·키만 만지고 지운다. 공용 키를 패턴으로 지우지 않는다.
 *  - 실패 메시지에는 상태 코드·개수만 넣는다(토큰·전화번호·남의 응답 본문 금지).
 */
import { Page, Route } from '@playwright/test';

import { Api, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { AdHocUser, expect, test as base } from '../../../src/fixtures';
import { psql, redis, remoteBash, sqlStr } from '../../../src/remote';
import { TempUser } from '../../../src/seed';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { auditCount, Body, signinWaiting } from './_helpers-adm';

export { expect };

/** 이 관리자가 남긴 해당 종류의 감사 로그 행 수 (조회만) */
export const auditCountOf = (adminId: string, action: string) => auditCount({ adminId, action });
export { allKeys, bodyOf, notificationRows, psqlOne, settle, sleep } from './_helpers-adm';
export type { Body } from './_helpers-adm';

export const TAGS = { tag: ['@P1', '@ADM'] };

/** 카메라 등록 행·이상감지 신호를 만드는 케이스는 CAM_SIGNAL_ALLOWED=1 일 때만 돌린다 */
export const CAM_SIGNAL_ALLOWED = process.env.CAM_SIGNAL_ALLOWED === '1';
export const CAM_SKIP_REASON = 'CAM_SIGNAL_ALLOWED=1 일 때만 실행한다(카메라 등록 행을 만드는 케이스라 CAM 영역 규칙을 따른다)';

/** 이 테스트 전용 이름·제목에 붙이는 짧은 꼬리표(소문자·숫자) */
export const uniq = () => Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 4);

/** KST 날짜(YYYY-MM-DD). offsetDays 만큼 이동 */
export function kstDate(offsetDays = 0) {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export interface Me {
  user: TempUser;
  api: Api;
  login: LoginResult;
  who: AdHocUser;
}

type Cleanup = () => void | Promise<void>;

export const test = base.extend<{
  /** 임시 사용자로 로그인한다. 429 가 나면 기다리고, 그래도 나면 이 PC IP 키만 지우고 다시 한다 */
  signIn: (user: TempUser) => Promise<Me>;
  /** 테스트가 끝나면(실패해도) 거꾸로 실행할 정리 작업을 등록한다. 임시 사용자 삭제보다 먼저 돈다 */
  later: (fn: Cleanup) => void;
}>({
  later: async ({ tempUser }, use) => {
    void tempUser;
    const fns: Cleanup[] = [];
    await use(fn => {
      fns.push(fn);
    });
    for (const fn of fns.reverse()) {
      try {
        await fn();
      } catch (error) {
        console.warn('정리 작업 실패(상태 코드·메시지만):', error instanceof Error ? error.message.slice(0, 120) : 'unknown');
      }
    }
  },

  signIn: async ({ later }, use) => {
    void later;
    const apis: Api[] = [];
    await use(async user => {
      let last = 0;
      for (let round = 1; round <= 4; round++) {
        const res = await signinWaiting(user.email, user.password, 3);
        last = res.status;
        if (res.login) {
          const login: LoginResult = { ...res.login, refreshToken: res.login.refreshToken ?? '' };
          const api = await Api.fromLogin(login);
          apis.push(api);
          return { user, api, login, who: { label: user.id, login } };
        }
        if (res.status !== 429) break;
        await relaxAuthRates();
      }
      throw new Error(`임시 사용자 로그인 실패 (상태 ${last})`);
    });
    for (const api of apis) await api.dispose();
  },
});

/** 상태 코드와 에러 code 를 함께 확인한다 (본문은 찍지 않는다) */
export function expectError(res: Body, status: number, code: string, label: string) {
  expect(res.status, `${label}: 응답 상태 ${res.status} (기대 ${status})`).toBe(status);
  expect(res.json.code ?? '', `${label}: 에러 code`).toBe(code);
}

// ─── 공지 ─────────────────────────────────────────────────────────────────

/**
 * 공지를 한꺼번에 만든다(내 관리자 id 로, 제목은 `${prefix}-01`(가장 새것) ... `${prefix}-NN`(가장 오래된 것)).
 * 본문은 150자: 앞 99자 '가' + '나' + 50자 '다' (목록은 앞 100자만 와야 한다).
 * 정리는 이 접두사 제목만 지운다(접두사는 이 테스트 전용 꼬리표라 남의 행과 겹치지 않는다).
 */
export const NOTICE_CONTENT = '가'.repeat(99) + '나' + '다'.repeat(50);
export const NOTICE_PREVIEW = '가'.repeat(99) + '나';

export function insertNotices(adminId: string, prefix: string, count: number) {
  psql(`INSERT INTO announcement (author_id, title, content, view_count, created_at, updated_at)
        SELECT ${sqlStr(adminId)}, ${sqlStr(prefix)} || '-' || lpad(g::text, 2, '0'), ${sqlStr(NOTICE_CONTENT)}, 0,
               now() - (g * interval '1 second'), now() - (g * interval '1 second')
        FROM generate_series(1, ${count}) g;`);
}

/** 접두사로 시작하는 이 테스트 전용 공지·임시저장을 지운다 */
export function deleteNoticesByPrefix(prefix: string) {
  if (!/^[A-Za-z0-9가-힣]{6,40}$/.test(prefix)) throw new Error('허용되지 않는 공지 접두사');
  psql(`DELETE FROM announcement WHERE title LIKE ${sqlStr(prefix + '%')};
        DELETE FROM announcement_draft WHERE title LIKE ${sqlStr(prefix + '%')};`);
}

export function deleteNoticeIds(ids: number[], drafts: number[] = []) {
  const list = (values: number[]) => values.filter(Number.isInteger).join(', ');
  if (ids.length) psql(`DELETE FROM announcement WHERE id IN (${list(ids)});`);
  if (drafts.length) psql(`DELETE FROM announcement_draft WHERE id IN (${list(drafts)});`);
}

/** 이 관리자가 남긴 감사 로그(admin_audit_log)를 지운다 - 감사 로그에는 사용자 FK 가 없어 이 테스트의 행만 골라 지운다 */
export function deleteAuditOf(adminIds: string[]) {
  const ids = adminIds.filter(id => /^[a-z0-9]{6}$/.test(id));
  if (ids.length) psql(`DELETE FROM admin_audit_log WHERE admin_id IN (${ids.map(sqlStr).join(', ')});`);
}

export const noticeCount = (prefix: string) => Number(psql(`SELECT count(*) FROM announcement WHERE title LIKE ${sqlStr(prefix + '%')};`));

/** 응답 목록(공지)이 작성일시 내림차순(같으면 id 내림차순)인지 */
export function isNewestFirst(items: { id: number; createdAt: string }[]) {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1];
    const cur = items[i];
    const diff = new Date(prev.createdAt).getTime() - new Date(cur.createdAt).getTime();
    if (diff < 0 || (diff === 0 && prev.id < cur.id)) return false;
  }
  return true;
}

/** 코드 포인트(이모지 1개 = 1자) 기준 글자 수 */
export const codePoints = (text: string) => Array.from(text).length;

// ─── Redis(이 임시 관리자 키만) · 로그 ────────────────────────────────────────

export const aiStatsKeys = (adminId: string) => [`rate:admin-ai-chat-stats:1m:${adminId}`, `rate:admin-ai-chat-stats:1h:${adminId}`];

export function redisCounter(key: string): number {
  const value = redis('GET', key);
  return /^\d+$/.test(value) ? Number(value) : 0;
}

export function deleteOwnKeys(keys: string[]) {
  redis('DEL', ...keys);
}

/** BE 컨테이너 로그에서 이 관리자 id 가 찍힌 줄 중 needle 을 포함한 줄 수 (최근 sinceSeconds 초) */
export function adminLogCount(adminId: string, needle: string, sinceSeconds = 300): number {
  if (!/^[a-z0-9]{6}$/.test(adminId)) throw new Error('허용되지 않는 관리자 id');
  if (!/^[\w가-힣:=\-. ,\[\]]+$/.test(needle)) throw new Error('허용되지 않는 검색어');
  const out = remoteBash(`docker logs --since ${sinceSeconds}s ${env.apiContainer} 2>&1 | grep -F 'adminId=${adminId}' | grep -cF '${needle}' || true\n`);
  return Number(out.trim()) || 0;
}

// ─── 임시 사용자 자신의 행을 DB 로 만든다 ────────────────────────────────────────

export function pendingConnection(guardianId: string, wardId: string, daysAgo = 0): number {
  const out = psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, relation, created_at)
          VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'PENDING', ${sqlStr(guardianId)}, '기타', now() - (${daysAgo} * interval '1 day'))
          RETURNING id;`);
  return Number(out.split('\n')[0]);
}

export const connectionRows = (guardianId: string, wardId: string) =>
  psql(`SELECT id || '|' || status || '|' || (connected_at IS NOT NULL) FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} ORDER BY id;`)
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [id, status, connected] = line.split('|');
      return { id: Number(id), status, connected: connected === 'true' };
    });

export function insertIncident(wardId: string, tag: string, type: 'FIRE' | 'WEAPON' | 'FALL', review: 'PENDING' | 'REAL' | 'FALSE_ALARM' | 'CONFLICTED', confidence: number, n = 1) {
  psql(`INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status)
        VALUES (${sqlStr(wardId)}, ${sqlStr(`qa-p1a-${tag}-${type}-${review}-${n}`)}, ${sqlStr(type)}, now(), now(), 1, ${confidence}, ${sqlStr(review)});`);
}

export function insertNotificationLog(recipientId: string, wardId: string, result: 'FAILED' | 'NOT_SENT', reason: string | null) {
  psql(`INSERT INTO notification_log (created_at, type, recipient_id, ward_id, title, body, result, not_sent_reason)
        VALUES (now(), 'WARD_SOS', ${sqlStr(recipientId)}, ${sqlStr(wardId)}, 'QA 시험', 'QA 시험 알림', ${sqlStr(result)}, ${sqlStr(reason)});`);
}

export function insertCamera(wardId: string, sessionId: string, room: string, active: boolean) {
  psql(`INSERT INTO camera (ward_id, session_id, device_id, label, is_active)
        VALUES (${sqlStr(wardId)}, ${sqlStr(sessionId)}, ${sqlStr('qa-dev-' + sessionId)}, ${sqlStr(room)}, ${active});`);
}

// ─── 관리자 대시보드 화면: 응답을 고쳐서 화면 표시 규칙만 본다 ──────────────────────────

type Json = Record<string, any>;
export interface DashboardPatches {
  safety?: (data: Json) => Json;
  operation?: (data: Json) => Json;
  aiStatus?: (data: Json) => Json;
}

/**
 * 진짜 응답을 받아 data 만 바꿔서 화면에 돌려준다(CORS 헤더 등 나머지는 진짜 응답 그대로).
 * AI 를 끊거나 서버 설정을 바꿀 수 없으니, "이런 값이 오면 화면이 어떻게 그리는가"만 이렇게 본다.
 */
export async function patchDashboard(page: Page, patches: DashboardPatches) {
  const wire = async (pattern: RegExp, patch?: (data: Json) => Json) => {
    if (!patch) return;
    await page.route(pattern, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = (await response.json()) as Json;
      body.data = patch(body.data ?? {});
      await route.fulfill({ response, json: body });
    });
  };
  await wire(/\/api\/admin\/dashboard\/safety(\?|$)/, patches.safety);
  await wire(/\/api\/admin\/dashboard\/operation(\?|$)/, patches.operation);
  await wire(/\/api\/admin\/dashboard\/ai-status(\?|$)/, patches.aiStatus);
}

/**
 * 서버를 건드리지 않고 "이런 오류 응답이 오면 화면이 어떻게 그리는가"만 보려고, 브라우저에서 오류 응답을 대신 돌려준다.
 * 다른 출처 호출이라 CORS 헤더(사전 확인 OPTIONS 포함)를 같이 준다. 서버로는 아무것도 보내지 않는다.
 */
export async function fulfillJsonError(route: Route, status: number, json: Json) {
  const request = route.request();
  const headers = request.headers();
  const cors: Record<string, string> = {
    'access-control-allow-origin': headers['origin'] ?? '*',
    'access-control-allow-credentials': 'true',
    vary: 'Origin',
  };
  if (request.method() === 'OPTIONS') {
    return route.fulfill({
      status: 204,
      headers: {
        ...cors,
        'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        'access-control-allow-headers': headers['access-control-request-headers'] ?? '*',
      },
    });
  }
  return route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(json) });
}

export const aiItem =(status: string | null) => ({ status, checkedAt: new Date().toISOString().replace('Z', '+00:00') });
