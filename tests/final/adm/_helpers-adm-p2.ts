/**
 * 최종 QA - 관리자(ADM) P2 묶음 전용 도우미.
 * 공용 src/ 와 P0·P1 도우미는 고치지 않고 가져다 쓴다.
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 고정 계정·setup 프로젝트는 쓰지 않는다.
 *  - DB 는 임시 사용자 id 나 이 테스트 전용 꼬리표가 붙은 행만 넣고 지운다. 남의 행을 훑지 않는다.
 *  - 실패 메시지에는 상태 코드·개수만 넣는다(토큰·전화번호·남의 응답 본문 금지).
 */
import { psql, sqlStr } from '../../../src/remote';
import { Api } from '../../../src/api';
import { Body, bodyOf, expect } from './_helpers-adm-p1a';

export {
  adminLogCount, aiStatsKeys, allKeys, auditCountOf, bodyOf, CAM_SIGNAL_ALLOWED, CAM_SKIP_REASON, deleteAuditOf, deleteNoticeIds,
  deleteNoticesByPrefix, deleteOwnKeys, expect, expectError, insertCamera, insertNotices, kstDate, noticeCount, notificationRows,
  psqlOne, redisCounter, settle, sleep, test, uniq,
} from './_helpers-adm-p1a';
export type { Body, Me } from './_helpers-adm-p1a';
export { auditRows, connectionStatus, insertConnection, notifRows } from './_helpers-adm-p1b';
export { userExists, userStatusRow } from './_helpers-adm';

export const TAGS = { tag: ['@P2', '@ADM'] };

export type DType = 'FIRE' | 'FALL' | 'WEAPON';
export type Review = 'PENDING' | 'REAL' | 'FALSE_ALARM' | 'CONFLICTED';

export const enc = encodeURIComponent;

/** GET 한 번 (본문은 찍지 않는다) */
export async function getBody(api: Api, path: string): Promise<Body> {
  return bodyOf(await api.raw('GET', path));
}

// ─── 공지 ─────────────────────────────────────────────────────────────────

/** 공지 한 건을 DB 로 바로 넣는다(제목·본문을 그대로 저장 - 특수문자 검색 시험용). 정리는 제목 접두사로 한다 */
export function insertNoticeRaw(adminId: string, title: string, content: string): number {
  const out = psql(
    `INSERT INTO announcement (author_id, title, content, view_count, created_at, updated_at)
     VALUES (${sqlStr(adminId)}, ${sqlStr(title)}, ${sqlStr(content)}, 0, now(), now()) RETURNING id;`,
  );
  return Number(out.split('\n')[0]);
}

// ─── 이상감지 상황 ─────────────────────────────────────────────────────────

/** 첫 감지 시각을 ISO 로 직접 지정해 상황을 넣는다. 돌려주는 값은 sessionId -> incidentId */
export function insertIncidentsAt(
  wardId: string,
  rows: { session: string; type?: DType; review?: Review; confidence?: number; startedAt: string }[],
): Record<string, number> {
  const values = rows
    .map(
      r => `(${sqlStr(wardId)}, ${sqlStr(r.session)}, ${sqlStr(r.type ?? 'FIRE')}, ${sqlStr(r.startedAt)}::timestamptz, ${sqlStr(r.startedAt)}::timestamptz,
             1, ${r.confidence ?? 0.9}, ${sqlStr(r.review ?? 'PENDING')})`,
    )
    .join(',\n');
  const out = psql(
    `INSERT INTO anomaly_incident (ward_id, session_id, detected_type, started_at, last_detected_at, event_count, max_confidence, review_status)
     VALUES ${values} RETURNING session_id || '|' || id;`,
  );
  const map: Record<string, number> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [session, id] = line.split('|');
    map[session] = Number(id);
  }
  return map;
}

/** 이 임시 피보호자들의 상황·응답 행만 지운다 */
export function deleteIncidentsOf(wardIds: string[]) {
  const list = wardIds.filter(id => /^[a-z0-9]{6}$/.test(id)).map(sqlStr).join(', ');
  if (!list) return;
  psql(`DELETE FROM anomaly_incident_feedback WHERE incident_id IN (SELECT id FROM anomaly_incident WHERE ward_id IN (${list}));
        DELETE FROM anomaly_incident WHERE ward_id IN (${list});`);
}

/** 한국 시간 기준 오늘·이번 주(월요일 시작)·이번 달 시작 시각(UTC 밀리초) */
export function kstBoundaries(nowMs = Date.now()) {
  const kst = new Date(nowMs + 9 * 3600_000);
  const y = kst.getUTCFullYear();
  const m = kst.getUTCMonth();
  const d = kst.getUTCDate();
  const dow = kst.getUTCDay(); // 0=일
  const today = Date.UTC(y, m, d) - 9 * 3600_000;
  return {
    today,
    week: today - ((dow + 6) % 7) * 86_400_000,
    month: Date.UTC(y, m, 1) - 9 * 3600_000,
  };
}

/** 한국 시간 자정 앞뒤 3분 안이면 "오늘" 경계가 흔들리므로 지나갈 때까지 기다린다(시계는 이 PC) */
export async function waitOutKstMidnight() {
  for (let i = 0; i < 80; i++) {
    const now = Date.now();
    const { today } = kstBoundaries(now);
    const sinceStart = now - today;
    const untilNext = today + 86_400_000 - now;
    if (sinceStart > 180_000 && untilNext > 180_000) return;
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
}

// ─── 연결 ─────────────────────────────────────────────────────────────────

export function connectionIdOf(guardianId: string, wardId: string): number {
  const out = psql(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} ORDER BY id DESC LIMIT 1;`);
  return Number(out.split('\n')[0]);
}

/** 이 임시 사용자들의 연결·알림 이력만 지운다(임시 사용자 삭제 전에 부른다) */
export function deleteLinksOf(userIds: string[]) {
  const list = userIds.filter(id => /^[a-z0-9]{6}$/.test(id)).map(sqlStr).join(', ');
  if (!list) return;
  psql(`DELETE FROM notification_log WHERE recipient_id IN (${list});
        DELETE FROM connection WHERE guardian_id IN (${list}) OR ward_id IN (${list});`);
}

/** 응답 상태와 에러 code 를 한 번에 맞춘다(본문은 찍지 않는다) */
export function expectCode(res: Body, status: number, code: string, label: string) {
  expect(res.status, `${label}: 응답 상태 ${res.status} (기대 ${status})`).toBe(status);
  expect(res.json.code ?? '', `${label}: 에러 code`).toBe(code);
}
