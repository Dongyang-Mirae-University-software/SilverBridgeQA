/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P2 전용 도우미.
 * 임시 사용자만 쓴다. DB 는 이 임시 사용자(관리자 포함) 자신의 행만 다룬다(관리자 감사 로그는 admin_id 로 거른다).
 * 제휴 병원은 예약 서비스에 만들어지므로 이름에 표식을 붙이고, 끝날 때 관리자 API 로 삭제한다(소프트 삭제 - 행은 예약 서비스에 남는다).
 */
import type { Page } from '@playwright/test';

import type { Api } from '../../../src/api';
import { psql, sqlStr } from '../../../src/remote';
import type { LoggedIn } from '../../../src/fixtures';
import { aiPsql } from './_helpers-chat';
import { callFull, loginSafe, marker, sleep, track, trackKey, cleanupChat, chatSend, padTo, dashboardPath, insertMedication, quietMedication, connectOld, setConnectionStatus } from './_helpers-chat-p1a';
import type { FullRes, Role } from './_helpers-chat-p1a';

export const TAGS = { tag: ['@P2', '@CHAT'] };

export {
  callFull, loginSafe, marker, sleep, track, trackKey, cleanupChat, chatSend, padTo, dashboardPath, insertMedication, quietMedication,
  connectOld, setConnectionStatus,
};
export type { FullRes, Role, LoggedIn };

/** 오늘(KST) 날짜 YYYY-MM-DD, offsetDays 만큼 이동 */
export function kstDate(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

// ───────────── 관리자 제휴 병원 ─────────────

export const HOSPITAL_API = '/api/admin/hospital';

export interface HospitalBody {
  name: string;
  region: string;
  address: string;
  phone: string;
  description?: string;
  openTime: string;
  closeTime: string;
  bookingAvailable?: boolean;
  departments: string[];
  breakStart?: string | null;
  breakEnd?: string | null;
  closedWeekdays?: number[] | null;
  weekdayHours?: Array<{ weekday: number; openTime: string; closeTime: string }> | null;
}

/** 표식이 붙은 정상 등록 본문. suffix 로 이름·주소가 겹치지 않게 한다 */
export function hospitalBody(suffix: string, over: Partial<HospitalBody> = {}): HospitalBody {
  return {
    name: `QA점검병원${suffix}`,
    region: `QA구${suffix}`,
    address: `QA시 점검로 ${suffix}`,
    phone: '02-000-0000',
    description: '자동 점검용 병원 - 곧 지워집니다',
    openTime: '09:00',
    closeTime: '18:00',
    bookingAvailable: false,
    departments: [`QA내과${suffix}`],
    ...over,
  };
}

/** 만든 병원을 기억해 두었다가 끝날 때 관리자 API 로 지우고, 이 관리자의 감사 로그 행을 지운다 */
export class HospitalScope {
  private readonly ids: number[] = [];
  /** 등록을 시도한 병원 이름(응답이 없어도 쓰기는 닿았을 수 있어 이름으로 한 번 더 찾는다) */
  private readonly attemptedNames: string[] = [];
  /** 이 범위에서 지운(소프트 삭제) 병원 id - 예약 서비스에 행이 계속 남는다 */
  readonly softDeletedIds: number[] = [];

  constructor(readonly admin: LoggedIn) {}

  /** 병원 등록(201 기대). 만든 id 를 기억한다. 504·시간 초과로 id 를 못 받아도 이름은 기억해 둔다 */
  async create(body: HospitalBody): Promise<FullRes> {
    this.attemptedNames.push(body.name);
    const res = await callFull(this.admin.api, 'POST', HOSPITAL_API, body, 60_000);
    const id = res.json?.data?.id;
    if (typeof id === 'number') this.ids.push(id);
    return res;
  }

  forget(id: number) {
    const i = this.ids.indexOf(id);
    if (i >= 0) this.ids.splice(i, 1);
    if (!this.softDeletedIds.includes(id)) this.softDeletedIds.push(id);
  }

  /**
   * 정리: 기억한 병원 삭제 -> 표식(이름)으로 다시 찾아 남은 병원도 삭제 -> 감사 로그(이 관리자 행) 삭제.
   * 삭제가 200/404 가 아니면 경고에 남긴다. 지운 병원 id 는 softDeletedIds 에 쌓인다(소프트 삭제 행이 예약 서비스에 남는다)
   */
  async cleanup(): Promise<string[]> {
    const warnings: string[] = [];
    const remove = async (id: number) => {
      const res = await callFull(this.admin.api, 'DELETE', `${HOSPITAL_API}/${id}`, undefined, 60_000);
      if (res.status !== 200 && res.status !== 404) warnings.push(`병원 ${id} 삭제 ${res.status}`);
      else if (!this.softDeletedIds.includes(id)) this.softDeletedIds.push(id);
    };
    for (const id of this.ids.splice(0).reverse()) await remove(id);
    // 응답을 못 받은 등록(504 HOSPITAL_RESULT_UNKNOWN·시간 초과)으로 만들어진 병원: 표식(이름)으로 찾아 지운다
    for (const name of [...new Set(this.attemptedNames.splice(0))]) {
      const found = await listByQuery(this.admin.api, name);
      if (found.status !== 200) {
        warnings.push(`표식 '${name}' 재조회 ${found.status}`);
        continue;
      }
      for (const h of (found.json?.data?.content ?? []) as Array<{ id: number; name: string }>) {
        if (typeof h.id === 'number' && h.name.startsWith(name)) await remove(h.id);
      }
    }
    psql(`DELETE FROM admin_audit_log WHERE admin_id = ${sqlStr(this.admin.user.id)};`);
    return warnings;
  }
}

export interface AuditRow {
  action: string;
  target: string;
  /** 남은 시각 (밀리초, epoch) */
  createdMs: number;
  detail: string;
}

/** 이 관리자의 감사 로그 (행위자 id 로 거른다) */
export function auditRows(adminId: string): AuditRow[] {
  const out = psql(
    `SELECT action, coalesce(target_id,''), (extract(epoch from created_at) * 1000)::bigint, coalesce(replace(detail, chr(10), ' '),'')
     FROM admin_audit_log WHERE admin_id = ${sqlStr(adminId)} ORDER BY id;`,
  );
  if (!out) return [];
  return out.split('\n').map(line => {
    const a = line.indexOf('|');
    const b = line.indexOf('|', a + 1);
    const c = line.indexOf('|', b + 1);
    return { action: line.slice(0, a), target: line.slice(a + 1, b), createdMs: Number(line.slice(b + 1, c)), detail: line.slice(c + 1) };
  });
}

export function auditCount(adminId: string): number {
  return Number(psql(`SELECT count(*) FROM admin_audit_log WHERE admin_id = ${sqlStr(adminId)};`));
}

/** 병원 목록에서 이 표식이 들어간 병원 (q 검색). 한 번에 50개까지 */
export async function listByQuery(api: Api, q: string, extra = '') {
  const res = await callFull(api, 'GET', `${HOSPITAL_API}?q=${encodeURIComponent(q)}&size=50${extra}`, undefined, 60_000);
  return res;
}

// ───────────── AI 서버 챗 기록 (이 임시 사용자 id 로만 조회) ─────────────

/** aiContextField 에서 그 칸이 없을 때의 값 */
export const ABSENT = '(없음)';

/** 이 사용자의 챗 기록에 저장된 userContext 의 한 칸 (SELECT, user_id 로 거른다). 칸이 없으면 ABSENT */
export function aiContextField(userId: string, field: string): string[] {
  if (!/^\w+$/.test(userId) || !/^\w+$/.test(field)) throw new Error('허용되지 않는 값');
  const out = aiPsql(
    `SELECT coalesce((context_json::json)->'userContext'->>'${field}', '${ABSENT}') FROM chat_logs WHERE user_id = '${userId}' ORDER BY id;`,
  );
  return out ? out.split('\n') : [];
}

// ───────────── 화면 ─────────────

/** 현재 포커스가 있는 요소가 선택자 안에 있는지 */
export async function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate(sel => {
    const active = document.activeElement;
    return !!active && active !== document.body && !!active.closest(sel);
  }, selector);
}
