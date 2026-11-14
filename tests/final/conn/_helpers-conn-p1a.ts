/**
 * 최종 QA - 연결·SOS·복약(CONN) P1a 묶음 전용 도우미.
 *
 * P0 도우미(_helpers-conn.ts)는 고치지 않고 가져다 쓴다. 임시 사용자 자신의 행·키만 만지고,
 * 비밀번호·토큰·전화번호는 메시지에 넣지 않는다(상태 코드·개수만).
 */
import { Page, request } from '@playwright/test';

import { env } from '../../../src/env';
import { psql, psqlRows, remoteBash, sqlStr } from '../../../src/remote';
import { ErrBody, read } from './_helpers-conn';

export const TAGS = { tag: ['@P1', '@CONN'] };

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** 토큰 없이(또는 주어진 토큰으로) 한 번 부르고 상태 코드와 본문을 돌려준다 */
export async function rawCall(
  method: Method,
  path: string,
  data?: unknown,
  token?: string,
): Promise<{ status: number; body: ErrBody; text: string }> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
  });
  try {
    return await read(await ctx.fetch(path, { method, data }));
  } finally {
    await ctx.dispose();
  }
}

const SAFE_NEEDLE = /^[\w가-힣 ():=,.\-[\]]+$/;

/** BE 컨테이너 로그(최근 N초)에서 모든 검색어가 한 줄에 든 줄들을 돌려준다 (읽기 전용, 최대 limit 줄) */
export function beLogLines(needles: string[], sinceSeconds = 300, limit = 40): string[] {
  if (needles.length === 0 || needles.some(n => !SAFE_NEEDLE.test(n))) throw new Error('허용되지 않는 검색어');
  if (!/^[\w\-]+$/.test(env.apiContainer)) throw new Error('허용되지 않는 컨테이너');
  const greps = needles.map(n => `grep -F '${n}'`).join(' | ');
  const out = remoteBash(`docker logs --since ${sinceSeconds}s ${env.apiContainer} 2>&1 | ${greps} | tail -n ${limit} || true\n`);
  return out.split('\n').filter(line => line.trim() !== '');
}

/** 페이지가 받는 실시간(STOMP) 프레임 글자를 모은다. goto 전에 불러야 한다 */
export function captureFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', ws =>
    ws.on('framereceived', f => frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString())),
  );
  return frames;
}

/** 연결을 며칠 전에 맺은 것으로 만든다 (그 뒤에 만든 SOS 이력은 모두 보이게). 임시 사용자 둘의 행만 만든다 */
export function connectDaysAgo(guardianId: string, wardId: string, days = 3) {
  psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
        VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'ACTIVE', ${sqlStr(guardianId)}, now() - interval '${days} days', '기타');`);
}

/** 임시 피보호자의 SOS 이력 행을 직접 만든다. minutesAgo 는 "몇 분 전" (소수 허용), 알림은 나가지 않는다 */
export function insertSosEvent(
  wardId: string,
  o: { triggerType?: 'SOS_BUTTON' | 'GUARDIAN_CALL'; calledGuardianId?: string | null; location?: string | null; secondsAgo: number },
): number {
  const out = psql(`INSERT INTO sos_event (ward_id, trigger_type, called_guardian_id, location, created_at)
                    VALUES (${sqlStr(wardId)}, ${sqlStr(o.triggerType ?? 'SOS_BUTTON')}, ${sqlStr(o.calledGuardianId ?? null)},
                            ${sqlStr(o.location ?? null)}, now() - interval '${o.secondsAgo} seconds') RETURNING id;`);
  return Number(out.split('\n')[0].trim());
}

/**
 * 여러 SOS 이력 행을 한 문장으로 만든다. 한 문장 안에서는 now() 가 같아 "정확히 60초 간격" 같은 경계를 만들 수 있다.
 * 돌려주는 id 는 넣은 순서와 같다.
 */
export function insertSosEvents(
  wardId: string,
  rows: { triggerType?: 'SOS_BUTTON' | 'GUARDIAN_CALL'; calledGuardianId?: string | null; location?: string | null; secondsAgo: number }[],
): number[] {
  const values = rows
    .map(o => `(${sqlStr(wardId)}, ${sqlStr(o.triggerType ?? 'SOS_BUTTON')}, ${sqlStr(o.calledGuardianId ?? null)}, ${sqlStr(o.location ?? null)}, now() - interval '${o.secondsAgo} seconds')`)
    .join(',\n');
  const out = psql(`WITH ins AS (
      INSERT INTO sos_event (ward_id, trigger_type, called_guardian_id, location, created_at)
      VALUES ${values} RETURNING id, created_at
    ) SELECT id FROM ins ORDER BY created_at, id;`);
  return out.split('\n').map(line => Number(line.trim()));
}

/** 알림 이력 한 줄 (조회만). 제목·본문·결과·안 보낸 이유·채널 결과(JSON 글자) */
export interface NotifRow {
  title: string;
  body: string;
  result: string;
  reason: string;
  channels: string;
}
export function notifRows(type: string, recipientId: string, wardId?: string): NotifRow[] {
  return psqlRows(`SELECT coalesce(title,''), replace(coalesce(body,''), chr(10), ' / '), result, coalesce(not_sent_reason,''),
                          coalesce(channel_results::text,'')
                   FROM notification_log
                   WHERE type = ${sqlStr(type)} AND recipient_id = ${sqlStr(recipientId)}
                     ${wardId ? `AND ward_id = ${sqlStr(wardId)}` : ''}
                   ORDER BY id;`).map(([title, body, result, reason, ...rest]) => ({
    title, body, result, reason, channels: rest.join('|'),
  }));
}
export function notifCount(type: string, recipientId: string): number {
  return Number(psql(`SELECT count(*) FROM notification_log WHERE type = ${sqlStr(type)} AND recipient_id = ${sqlStr(recipientId)};`));
}

// ── 시각(KST) 도우미: 서버 시계를 못 바꾸므로 "지금" 기준으로 복용 시각을 잡는다 ──

/** 한국 시간 기준 지금까지 지난 분(0~1439) */
export function kstMinuteOfDay(): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date()).split(':');
  return Number(parts[0]) * 60 + Number(parts[1]);
}

/** KST 지금 + offset 분의 "HH:MM:00" (자정을 넘나들지 않는 시각에만 쓴다) */
export function kstHm(offsetMinutes: number): string {
  const when = new Date(Date.now() + offsetMinutes * 60_000);
  const hm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(when);
  return `${hm}:00`;
}

/** 시각 하나(KST)를 "HH:MM:SS" 글자로 */
export function kstClockOf(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}

/** 시각 하나(KST)의 날짜 "YYYY-MM-DD" */
export function kstDayOf(iso: string | number | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/** 자정 앞뒤 20분은 "시각 창"이 하루를 넘나들어 시나리오가 틀어지므로 피한다 */
export function clockSafe(beforeMinutes = 20, afterMinutes = 25): boolean {
  const m = kstMinuteOfDay();
  return m >= beforeMinutes && m <= 1440 - afterMinutes;
}

/** DB 에서 쓰는 "KST 지금 + offset 분" 시각 식 (time) */
export function kstTime(offsetMinutes: number): string {
  return `((now() AT TIME ZONE 'Asia/Seoul')::time + interval '${offsetMinutes} minutes')::time`;
}

/** 오늘(KST) 그 시각에 만든 것으로 하는 timestamptz 식 */
export function todayAt(timeExpr: string): string {
  return `(((now() AT TIME ZONE 'Asia/Seoul')::date + ${timeExpr}) AT TIME ZONE 'Asia/Seoul')`;
}

/** 복약 행을 직접 만든다 (임시 피보호자의 행). doseExpr 는 kstTime(...) 같은 SQL 식 또는 '08:00:00' 형태의 글자 */
export function insertMedicationRow(o: {
  wardId: string;
  createdBy: string;
  name: string;
  doseExpr: string;
  slot?: 'MORNING' | 'LUNCH' | 'DINNER' | 'BEDTIME';
  createdAtExpr?: string;
}): number {
  const dose = /^\d\d:\d\d(:\d\d)?$/.test(o.doseExpr) ? `${sqlStr(o.doseExpr)}::time` : o.doseExpr;
  const extraCols = o.createdAtExpr ? ', created_at, updated_at' : '';
  const extraVals = o.createdAtExpr ? `, ${o.createdAtExpr}, ${o.createdAtExpr}` : '';
  const out = psql(`INSERT INTO medication (ward_id, created_by, name, time_slot, dose_time${extraCols})
                    VALUES (${sqlStr(o.wardId)}, ${sqlStr(o.createdBy)}, ${sqlStr(o.name)}, ${sqlStr(o.slot ?? 'MORNING')}, ${dose}${extraVals})
                    RETURNING id;`);
  return Number(out.split('\n')[0].trim());
}

export function reminderLogCount(medicationId: number, attempt?: number): number {
  return Number(psql(`SELECT count(*) FROM medication_reminder_log WHERE medication_id = ${medicationId}
                      ${attempt ? `AND attempt = ${attempt}` : ''};`));
}

export function medRow(id: number): { wardId: string; slot: string; dose: string; amount: string; memo: string; name: string; deleted: boolean; createdBy: string } | null {
  const rows = psqlRows(`SELECT ward_id, time_slot, dose_time::text, dose_amount::text, coalesce(memo,'<null>'), name, (deleted_at IS NOT NULL)::text, created_by
                         FROM medication WHERE id = ${id};`);
  if (rows.length === 0) return null;
  const [wardId, slot, dose, amount, memo, name, deleted, createdBy] = rows[0];
  return { wardId, slot, dose, amount, memo, name, deleted: deleted === 'true', createdBy };
}

export function medCountOf(wardId: string, includeDeleted = false): number {
  return Number(psql(`SELECT count(*) FROM medication WHERE ward_id = ${sqlStr(wardId)} ${includeDeleted ? '' : 'AND deleted_at IS NULL'};`));
}

/** 임시 관리자가 남긴 감사 로그를 지운다 (삭제 API 가 없다). 임시 관리자 id 와 그가 만든 대상만 */
export function cleanAdminAudit(adminIds: string[]) {
  if (adminIds.length === 0) return;
  psql(`DELETE FROM admin_audit_log WHERE admin_id IN (${adminIds.map(sqlStr).join(', ')});`);
}
