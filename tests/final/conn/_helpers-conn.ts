/**
 * 최종 QA - 연결·SOS·복약(CONN) 영역 전용 도우미.
 *
 * 임시 사용자만 쓴다. DB·Redis 는 src/ 의 기존 도우미(psql 조회, connect, suppressSosNotify 등)로만 만지고,
 * 쓰기는 임시 사용자 자신의 키·행에만 한다. 토큰·비밀번호·전화번호는 로그에 찍지 않는다.
 */
import { APIRequestContext, APIResponse, expect, Page, request } from '@playwright/test';

import { Api, LoginResult } from '../../../src/api';
import { env } from '../../../src/env';
import { modal } from '../../../src/fixtures';
import { psql, psqlRows, redis, remoteBash, sqlStr } from '../../../src/remote';

export const TAGS = { tag: ['@P0', '@CONN'] };

export interface ErrBody {
  success?: boolean;
  message?: string;
  code?: string;
  data?: unknown;
}

/** 응답을 상태 코드와 본문(JSON)으로 나눈다 */
export async function read(res: APIResponse): Promise<{ status: number; body: ErrBody; text: string }> {
  const text = await res.text();
  let body: ErrBody = {};
  try {
    body = text ? (JSON.parse(text) as ErrBody) : {};
  } catch {
    body = {};
  }
  return { status: res.status(), body, text };
}

/** 오류 응답: 상태 코드(와 오류 코드)가 기대와 같아야 한다 */
export async function expectError(res: APIResponse, status: number, code?: string, label = '') {
  const r = await read(res);
  const where = label ? `[${label}] ` : '';
  expect(r.status, `${where}상태 코드 (본문: ${r.text.slice(0, 160)})`).toBe(status);
  if (code) expect(r.body.code, `${where}오류 코드`).toBe(code);
  return r;
}

/** 한국 시간 기준으로 지금부터 6시간 뒤의 복용 시각("HH:MM:00") - 알림 유예 창에 들지 않는다 */
export function farDoseTime(): string {
  const later = new Date(Date.now() + 6 * 3600_000);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(later);
  return `${time}:00`;
}

/** 보호자가 피보호자에게 약을 등록한다 (API). medicationId 를 돌려준다 */
export async function createMedication(api: Api, wardId: string, name = 'E2E최종약'): Promise<number> {
  const created = await api.post<{ medicationId: number }>(`/api/guardian/ward/${wardId}/medication`, {
    name, timeSlot: 'MORNING', doseTime: farDoseTime(), doseAmount: 1,
  });
  return created.medicationId;
}

export function medicationRow(id: number): { wardId: string; deleted: boolean; name: string } | null {
  const out = psql(`SELECT ward_id || '|' || (deleted_at IS NOT NULL)::text || '|' || name FROM medication WHERE id = ${id};`);
  if (!out) return null;
  const [wardId, deleted, ...name] = out.split('|');
  return { wardId, deleted: deleted === 'true', name: name.join('|') };
}

export function intakeCount(medicationId: number): number {
  return Number(psql(`SELECT count(*) FROM medication_intake WHERE medication_id = ${medicationId};`));
}

/** 연결 행 ID (조회만) */
export function connectionId(guardianId: string, wardId: string): number {
  return Number(psql(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} ORDER BY id DESC LIMIT 1;`));
}

export function connectionStatus(id: number): string {
  return psql(`SELECT status FROM connection WHERE id = ${id};`);
}

export function sosEvents(wardId: string): number {
  return Number(psql(`SELECT count(*) FROM sos_event WHERE ward_id = ${sqlStr(wardId)};`));
}

/** 한 피보호자의 SOS 알림 발송 기록 (조회만). 보호자별 한 줄. 본문의 줄바꿈은 " / " 로 바꿔 돌려준다 */
export function sosNotificationLogs(wardId: string, guardianId?: string): { recipient: string; result: string; title: string; body: string; channels: string }[] {
  return psqlRows(`SELECT recipient_id, coalesce(result,''), coalesce(title,''), replace(coalesce(body,''), chr(10), ' / '),
                          coalesce(channel_results::text,'')
                   FROM notification_log
                   WHERE ward_id = ${sqlStr(wardId)} AND type = 'WARD_SOS'
                     ${guardianId ? `AND recipient_id = ${sqlStr(guardianId)}` : ''}
                   ORDER BY id;`).map(([recipient, result, title, body, ...rest]) => ({
    recipient, result, title, body, channels: rest.join('|'),
  }));
}
export function sosNotificationCount(wardId: string, guardianId?: string): number {
  return Number(psql(`SELECT count(*) FROM notification_log
                      WHERE ward_id = ${sqlStr(wardId)} AND type = 'WARD_SOS'
                        ${guardianId ? `AND recipient_id = ${sqlStr(guardianId)}` : ''};`));
}

/** 한 보호자 한 줄의 "발송 안 함" 정보: result 와 not_sent_reason (조회만) */
export function sosNotSent(wardId: string, guardianId: string): { result: string; reason: string }[] {
  return psqlRows(`SELECT coalesce(result,''), coalesce(not_sent_reason,'')
                   FROM notification_log
                   WHERE ward_id = ${sqlStr(wardId)} AND type = 'WARD_SOS' AND recipient_id = ${sqlStr(guardianId)}
                   ORDER BY id;`).map(([result, reason]) => ({ result, reason: reason ?? '' }));
}

/**
 * 컨테이너 로그(최근 N초)에서 "모든 검색어가 한 줄에 들어 있는" 줄 수 (읽기 전용).
 * 예: logLineCount(env.apiContainer, ['[SOS-NO-DELIVERY]', `wardId=${ward.id},`])
 */
export function logLineCount(container: string, needles: string[], sinceSeconds = 300): number {
  if (!/^[\w\-]+$/.test(container)) throw new Error('허용되지 않는 컨테이너');
  if (needles.length === 0 || needles.some(n => !/^[\w가-힣 ():=,.\-[\]]+$/.test(n))) throw new Error('허용되지 않는 검색어');
  const greps = needles.map(n => `grep -F '${n}'`).join(' | ');
  const out = remoteBash(`docker logs --since ${sinceSeconds}s ${container} 2>&1 | ${greps} | wc -l || true\n`);
  return Number(out.trim()) || 0;
}

const COOLDOWN_KEY =(wardId: string) => `sos:notify:cooldown:${wardId}`;
export function cooldownExists(wardId: string): boolean {
  return redis('EXISTS', COOLDOWN_KEY(wardId)) === '1';
}
export function clearCooldown(wardId: string) {
  redis('DEL', COOLDOWN_KEY(wardId));
}

/**
 * 최근 N초 BE 로그에서 [IDOR-ATTEMPT] 줄 중 "<필드>=<사용자ID>" 가 들어 있는 줄 수 (읽기 전용).
 * 예: idorLogCount('guardianId', guardian.id)
 */
export function idorLogCount(field: 'guardianId' | 'wardId' | 'userId', userId: string, sinceSeconds = 300): number {
  if (!/^[A-Za-z0-9]{1,6}$/.test(userId)) throw new Error('사용자 ID 형식이 아닙니다.');
  const out = remoteBash(
    `docker logs --since ${sinceSeconds}s ${env.apiContainer} 2>&1 | grep -F 'IDOR-ATTEMPT' | grep -cE '${field}=${userId}([^A-Za-z0-9]|$)' || true\n`,
  );
  return Number(out.trim()) || 0;
}

/** 로그를 몇 번 더 읽어도 느리게 찍히는 경우가 있어 잠시 기다리며 센다 */
export async function waitIdorLog(field: 'guardianId' | 'wardId' | 'userId', userId: string, atLeast: number, timeoutMs = 15_000) {
  await expect
    .poll(() => idorLogCount(field, userId), { message: `[IDOR-ATTEMPT] 로그(${field}=임시사용자)가 ${atLeast}줄 이상`, timeout: timeoutMs, intervals: [1000, 2000] })
    .toBeGreaterThanOrEqual(atLeast);
}

/** 이 임시 사용자 한 명의 인증 저장소 조회만 오류가 나게 만든다 (Redis 장애 대역, 다른 사용자에게는 영향 없음) */
export function injectRedisFault(userId: string) {
  const key = `password:invalidate:${userId}`;
  redis('DEL', key);
  redis('RPUSH', key, 'qa-redis-failure');
  redis('EXPIRE', key, '300');
  return () => {
    redis('DEL', key);
  };
}

/** multipart 로 파일을 올린다 (토큰이 없으면 헤더를 붙이지 않는다) */
export async function postFile(
  path: string,
  login: LoginResult | null,
  file: { buffer: Buffer; name: string; mimeType: string },
): Promise<{ res: APIResponse; ms: number; ctx: APIRequestContext }> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: login ? { Authorization: `Bearer ${login.accessToken}` } : {},
  });
  const started = Date.now();
  const res = await ctx.post(path, { multipart: { image: file }, timeout: 120_000 });
  await res.body().catch(() => undefined);
  return { res, ms: Date.now() - started, ctx };
}

/** 구조가 서버 검증만 통과하는 큰 가짜 JPG (헤더 + 0 으로 채움) */
export function bigFakeJpeg(megabytes: number): Buffer {
  const buffer = Buffer.alloc(Math.round(megabytes * 1024 * 1024), 0);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buffer, 0);
  return buffer;
}

// ── 피보호자 SOS 화면 (FE 배포본 a8666240, v13) ──

export type SosActionValue = 'CALL_119' | 'CALL_119_AND_NOTIFY' | 'NOTIFY_GUARDIAN_FIRST';
const WARD_SETTINGS_KEY = 'silverbridge_ward_settings';

/** 페이지가 열리기 전에 기기 저장소의 SOS 동작을 정한다 (서버 값이 먼저 올 때까지의 임시 값) */
export async function presetSosActionValue(page: Page, value: SosActionValue) {
  await page.addInitScript(
    ({ key, v }) => {
      const current = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...current, sosAction: v }));
    },
    { key: WARD_SETTINGS_KEY, v: value },
  );
}

export function sosHeroButton(page: Page) {
  return page.getByRole('button', { name: /도움이 필요하면 누르세요/ });
}

export function sosConfirmModal(page: Page) {
  return modal(page, '긴급 SOS를 보낼까요?');
}

/** SOS 버튼 → 확인창의 [보내기]. POST /api/ward/sos 응답을 기다려 돌려준다 (요청이 안 나가면 null) */
export async function pressSosV13(page: Page, waitMs = 8_000) {
  const posted = page
    .waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/ward/sos'), { timeout: waitMs })
    .catch(() => null);
  await sosHeroButton(page).click();
  const confirm = sosConfirmModal(page);
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '보내기' }).click();
  return posted;
}

export function dialpad(page: Page) {
  return page.getByRole('dialog', { name: /119 신고 키패드/ });
}

/** 보호자 화면의 새 알림 영역(토스트) */
export function toastArea(page: Page) {
  return page.getByLabel('새 알림');
}

/** 피보호자 SOS 화면의 보호자 카드들 (전화번호가 없는 보호자는 링크 대신 "전화번호가 없어요"가 보인다) */
export function guardianCards(page: Page) {
  return page.getByRole('region', { name: '보호자에게 직접 전화하기' }).getByRole('article');
}