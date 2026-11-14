/**
 * 챗봇·대시보드·말벗(CHAT) 최종 QA P1b 전용 도우미.
 * 임시 사용자만 쓴다. DB 쓰기는 이 임시 사용자 자신의 행(말벗 기록 심기, 연결 시각)과 임시 사용자 id 가 붙은 Redis 키뿐이다.
 * P0 도우미(_helpers-chat.ts)는 가져다 쓰기만 하고 고치지 않는다.
 */
import type { Browser } from '@playwright/test';
import { request } from '@playwright/test';

import { Api } from '../../../src/api';
import { env } from '../../../src/env';
import { psql, redis, sqlStr } from '../../../src/remote';
import type { Res } from './_helpers-chat';
import { call, callLong, sleep, toRes, withdrawForAiPurge } from './_helpers-chat';

export type { Res };
export { call, callLong, sleep, toRes };

export const SLOTS = ['09:00', '12:00', '15:00', '18:00', '21:00'] as const;
export type SlotCode = (typeof SLOTS)[number];

export async function callPatch(api: Api, path: string, data?: unknown): Promise<Res> {
  return toRes(await api.raw('PATCH', path, data));
}

// ───────────── 시각 (서버와 같은 KST) ─────────────

export function kstDate(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function kstMinutes(): number {
  const d = new Date(Date.now() + 9 * 3600_000);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/** 지금 시각(KST)이 들어 있는 60분 창의 시간대. 창 밖이면 null (BE: 시작 시각 이상, 시작+60분 미만) */
export function slotInWindowNow(): SlotCode | null {
  const m = kstMinutes();
  return SLOTS.find(slot => {
    const start = Number(slot.slice(0, 2)) * 60;
    return m >= start && m < start + 60;
  }) ?? null;
}

// ───────────── 질문 번호 (companion_question 은 설정 표라 사용자 행이 아니다) ─────────────

/** BE pickQuestion 과 같은 규칙: 그 시간대 활성 질문을 id 순으로 두고 epochDay mod 개수 */
export function expectedQuestion(slot: string, date: string): { id: number; text: string } {
  const out = psql(`SELECT id, text FROM companion_question WHERE slot = ${sqlStr(slot)} AND active = true ORDER BY id;`);
  const rows = out.split('\n').filter(Boolean).map(line => {
    const at = line.indexOf('|');
    return { id: Number(line.slice(0, at)), text: line.slice(at + 1) };
  });
  if (!rows.length) throw new Error(`활성 질문이 없습니다: ${slot}`);
  const [y, m, d] = date.split('-').map(Number);
  const epochDay = Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
  return rows[((epochDay % rows.length) + rows.length) % rows.length];
}

// ───────────── 말벗 기록 심기·읽기 (이 임시 사용자의 행만) ─────────────

export interface SeedSession {
  date: string;
  slot: SlotCode;
  mood: 'JOY' | 'CALM' | 'WORRY' | 'DEPRESSED' | null;
  /** 심을 턴 글 (동의한 대화 상세 확인용). 없으면 턴 1개를 글 없이 만든다 */
  text?: { bot: string; answer: string };
  riskProb?: number;
}

/** 이 피보호자의 마친 말벗 대화 1건을 직접 넣는다 (AI·알림을 거치지 않는다). 대화 id 를 돌려준다 */
export function seedFinishedSession(wardId: string, s: SeedSession): number {
  if (!/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  const qid = psql(`SELECT id FROM companion_question WHERE slot = ${sqlStr(s.slot)} AND active = true ORDER BY id LIMIT 1;`);
  const hh = s.slot.slice(0, 2);
  const out = psql(
    `INSERT INTO companion_session (ward_id, session_date, slot, question_id, status, end_reason, mood, turn_count, answered_count,
        no_response_count, risk_flag, alert_level, started_at, last_activity_at, ended_at, is_test, max_risk_prob)
     VALUES (${sqlStr(wardId)}, ${sqlStr(s.date)}, ${sqlStr(s.slot)}, ${Number(qid)}, 'FINISHED', 'MAX_TURNS', ${sqlStr(s.mood)}, 1, 1, 0, false, 'INFO',
        (${sqlStr(s.date + ' ' + hh + ':05:00+09')})::timestamptz, (${sqlStr(s.date + ' ' + hh + ':08:00+09')})::timestamptz,
        (${sqlStr(s.date + ' ' + hh + ':09:00+09')})::timestamptz, false, ${s.riskProb ?? 'NULL'})
     RETURNING id;`,
  );
  const id = Number(out.split('\n')[0]);
  if (!Number.isInteger(id)) throw new Error('대화 심기 실패');
  psql(
    `INSERT INTO companion_turn (session_id, turn_no, mood, bot_text, answer_text, created_at)
     VALUES (${id}, 1, ${sqlStr(s.mood)}, ${sqlStr(s.text?.bot ?? null)}, ${sqlStr(s.text?.answer ?? null)}, (${sqlStr(s.date + ' ' + hh + ':06:00+09')})::timestamptz);`,
  );
  return id;
}

/** 보호자-피보호자 연결 시각을 과거로 돌린다 (보호자는 연결 이후 대화만 보므로, 지난 날 기록을 보이게 하려는 것) */
export function backdateConnection(guardianId: string, wardId: string, days: number) {
  if (!/^\w+$/.test(guardianId) || !/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  psql(
    `UPDATE connection SET connected_at = now() - interval '${Math.floor(days)} days'
     WHERE guardian_id = ${sqlStr(guardianId)} AND ward_id = ${sqlStr(wardId)} AND status = 'ACTIVE';`,
  );
}

export function sessionRow(sessionId: number) {
  const out = psql(
    `SELECT status, coalesce(mood,''), turn_count, coalesce(answered_count,-1), risk_flag, coalesce(max_risk_prob::text,''), is_test
     FROM companion_session WHERE id = ${Number(sessionId)};`,
  );
  if (!out) return null;
  const [status, mood, turnCount, answeredCount, riskFlag, maxRiskProb, isTest] = out.split('|');
  return {
    status, mood, turnCount: Number(turnCount), answeredCount: Number(answeredCount),
    riskFlag: riskFlag === 't', maxRiskProb: maxRiskProb === '' ? null : Number(maxRiskProb), isTest: isTest === 't',
  };
}

export function wardSessionCount(wardId: string): number {
  if (!/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  return Number(psql(`SELECT count(*) FROM companion_session WHERE ward_id = ${sqlStr(wardId)};`));
}

export function wardSessionIds(wardId: string): number[] {
  if (!/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  const out = psql(`SELECT id FROM companion_session WHERE ward_id = ${sqlStr(wardId)} ORDER BY id;`);
  return out ? out.split('\n').map(Number) : [];
}

export function consentRowCount(wardId: string): number {
  if (!/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  return Number(psql(`SELECT count(*) FROM companion_transcript_consent WHERE ward_id = ${sqlStr(wardId)};`));
}

export function userRowCount(userId: string): number {
  if (!/^\w+$/.test(userId)) throw new Error('허용되지 않는 id');
  return Number(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(userId)};`));
}

export function wardTurnCount(sessionId: number): number {
  return Number(psql(`SELECT count(*) FROM companion_turn WHERE session_id = ${Number(sessionId)};`));
}

export function purgeQueued(wardId: string): boolean {
  if (!/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  return psql(`SELECT count(*) FROM companion_purge_request WHERE ward_id = ${sqlStr(wardId)};`) !== '0';
}

/** 말벗 관련 표 중 사진·음성 같은 이진 열이 있는지 (음성·사진은 저장하지 않는다는 약속 확인) */
export function binaryColumnsInCompanionTables(): string[] {
  const out = psql(
    `SELECT table_name || '.' || column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name LIKE 'companion\\_%' AND data_type IN ('bytea', 'oid') ORDER BY 1;`,
  );
  return out ? out.split('\n') : [];
}

/** 이 임시 피보호자가 마지막으로 받은 알림 이력 수 (종류별, 받는 사람 기준) */
export function noticeLogRows(wardId: string): Array<{ date: string; mood: string; days: number }> {
  if (!/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  const out = psql(`SELECT notice_date, mood, days FROM companion_notice_log WHERE ward_id = ${sqlStr(wardId)} ORDER BY id;`);
  return out ? out.split('\n').map(l => {
    const [date, mood, days] = l.split('|');
    return { date, mood, days: Number(days) };
  }) : [];
}

export function riskPatternNoticeCount(wardId: string): number {
  if (!/^\w+$/.test(wardId)) throw new Error('허용되지 않는 id');
  return Number(psql(`SELECT count(*) FROM companion_risk_pattern_notice WHERE ward_id = ${sqlStr(wardId)};`));
}

// ───────────── 문자 대체 발송 막기 (알림 종류를 넘겨 받는다) ─────────────

const smsKeyOwners = new Map<string, Set<string>>();

/** 이 임시 보호자의 해당 알림 종류 문자 대체 상한 키를 가득 채워 실제 문자가 나가지 않게 한다 (TTL 1시간) */
export function suppressSmsFor(type: string, ...recipientIds: string[]) {
  if (!/^[A-Z_]+$/.test(type)) throw new Error('허용되지 않는 알림 종류');
  const owners = smsKeyOwners.get(type) ?? new Set<string>();
  for (const id of recipientIds) {
    owners.add(id);
    redis('SET', `notify:sms-fallback:${type}:${id}`, '1000000', 'EX', '3600');
  }
  smsKeyOwners.set(type, owners);
}

export function clearSuppressedSmsKeys() {
  for (const [type, owners] of smsKeyOwners) {
    for (const id of owners) {
      try {
        redis('DEL', `notify:sms-fallback:${type}:${id}`);
      } catch {
        // TTL 1시간이라 저절로 사라진다
      }
    }
  }
  smsKeyOwners.clear();
}

// ───────────── 정리 ─────────────

/**
 * 말벗·챗을 쓴 임시 피보호자를 제품 탈퇴 API 로 지운다. 탈퇴 경로(CompanionWithdrawalListener)를 타야 AI 서버 쪽 말벗 기록도
 * 삭제 대기열로 지워진다. 실패해도 테스트 결과를 바꾸지 않는다 (임시 사용자 행은 fixture 가 SQL 로 지운다).
 */
export async function withdrawQuietly(api: Api, password: string) {
  try {
    const res = await withdrawForAiPurge(api, password);
    if (res.status !== 200) console.warn(`임시 사용자 탈퇴 정리 실패 (상태 ${res.status})`);
  } catch (error) {
    console.warn('임시 사용자 탈퇴 정리 실패', (error as Error).name);
  }
}

// ───────────── 말벗 호출 ─────────────

export interface OpenedSession {
  status: number;
  sessionId: number;
  question: string | null;
  maxTurns: number | null;
  audioIndex: number | null;
  raw: Res;
}

export async function openSessionRaw(ward: Api, path: '/api/ward/companion/sessions' | '/api/ward/companion/test/sessions', slot?: string): Promise<OpenedSession> {
  const res = await callLong(ward, 'POST', path, slot ? { slot } : undefined);
  const data = res.json?.data;
  return {
    status: res.status,
    sessionId: data?.sessionId ?? 0,
    question: data?.question ?? null,
    maxTurns: data?.maxTurns ?? null,
    audioIndex: typeof data?.audio?.index === 'number' ? data.audio.index : null,
    raw: res,
  };
}

/** 음성 대답(multipart) 호출. 파트를 직접 넘겨서 크기·장수·형식 오류를 만든다 */
export interface Part {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export async function replyAudioRaw(ward: Api, sessionId: number, audio: Part | null, frames: Part[] = []): Promise<Res> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${ward.login.accessToken}` },
  });
  try {
    // 같은 이름 파트(frame) 를 여러 개 보내려면 FormData 를 쓴다
    const form = new FormData();
    if (audio) form.append('audio', new Blob([new Uint8Array(audio.buffer)], { type: audio.mimeType }), audio.name);
    for (const f of frames) form.append('frame', new Blob([new Uint8Array(f.buffer)], { type: f.mimeType }), f.name);
    const response = await ctx.fetch(`/api/ward/companion/sessions/${sessionId}/reply/audio`, {
      method: 'POST',
      multipart: form,
      timeout: 150_000,
    });
    return await toRes(response);
  } finally {
    await ctx.dispose();
  }
}

/** 말벗이 한 말의 목소리(mp3 등)를 받는다. 못 받으면 null */
export async function fetchBotAudio(ward: Api, sessionId: number, index: number): Promise<{ buffer: Buffer; contentType: string } | null> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${ward.login.accessToken}` },
  });
  try {
    const response = await ctx.get(`/api/ward/companion/sessions/${sessionId}/audio/${index}`, { timeout: 30_000 });
    if (response.status() !== 200) return null;
    return { buffer: await response.body(), contentType: response.headers()['content-type'] ?? '' };
  } finally {
    await ctx.dispose();
  }
}

// ───────────── 시험용 파일 만들기 ─────────────

/** 앞에서부터 유효한 MP3 뒤에 맞지 않는 크기를 채워 목표 크기로 만든다: ID3v2 태그의 빈 칸(padding)을 키워 앞에 둔다 */
export function padMp3(mp3: Buffer, targetBytes: number): Buffer {
  if (mp3.length >= targetBytes) return mp3;
  const stripped = mp3.subarray(0, 3).toString('latin1') === 'ID3' ? mp3.subarray(10 + id3Size(mp3)) : mp3;
  const tagSize = targetBytes - stripped.length - 10; // 헤더 10바이트
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 4; // v2.4
  header[4] = 0;
  header[5] = 0;
  // synchsafe 정수 (7비트씩)
  header[6] = (tagSize >> 21) & 0x7f;
  header[7] = (tagSize >> 14) & 0x7f;
  header[8] = (tagSize >> 7) & 0x7f;
  header[9] = tagSize & 0x7f;
  return Buffer.concat([header, Buffer.alloc(tagSize), stripped]);
}

function id3Size(buf: Buffer): number {
  return ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
}

/** JPEG 의 SOI 바로 뒤에 주석(COM) 조각을 넣어 목표 크기로 만든다. 그림은 그대로 유효하다 */
export function padJpeg(jpeg: Buffer, targetBytes: number): Buffer {
  if (jpeg.length > targetBytes) throw new Error('이미 목표 크기보다 큽니다');
  const chunks: Buffer[] = [];
  let remain = targetBytes - jpeg.length;
  while (remain > 0) {
    // 조각 하나: FF FE + 길이(2바이트, 길이 자신 포함) + 내용. 길이 최대 65535
    const body = Math.min(remain - 4, 65533);
    if (body < 0) {
      // 4바이트 미만 남으면 마지막 조각을 줄여 맞춘다
      chunks[chunks.length - 1] = chunks[chunks.length - 1].subarray(0, chunks[chunks.length - 1].length - (4 - remain));
      remain = 0;
      break;
    }
    const seg = Buffer.alloc(4 + body);
    seg[0] = 0xff;
    seg[1] = 0xfe;
    seg.writeUInt16BE(body + 2, 2);
    chunks.push(seg);
    remain -= seg.length;
  }
  return Buffer.concat([jpeg.subarray(0, 2), ...chunks, jpeg.subarray(2)]);
}

/** 실제 Chromium 으로 작은 JPEG 를 만든다 */
export async function makeJpeg(browser: Browser): Promise<Buffer> {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  try {
    await page.setContent('<body style="margin:0;background:#c96"><div style="width:64px;height:64px;background:linear-gradient(#fc9,#963)"></div></body>');
    return await page.screenshot({ type: 'jpeg', quality: 60 });
  } finally {
    await page.close();
  }
}

/** 문서 안 질문 문장으로 말한 뒤 곧바로 쓸 수 있는 가짜 WAV 머리글 (형식 판별만 통과, 소리는 아님) */
export function fakeWavHeader(): Buffer {
  return Buffer.from('RIFF0000WAVEfmt ');
}

export function repeatText(ch: string, n: number): string {
  return ch.repeat(n);
}

export const waitUntil = async (fn: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(stepMs);
  }
  return fn();
};
