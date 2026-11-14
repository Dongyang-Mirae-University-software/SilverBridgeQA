/**
 * 최종 QA 알림(NOTI) P2 묶음 전용 도우미.
 * 임시 사용자만 쓴다. DB 는 임시 사용자 자신의 행(알림 이력, 이메일 칸, 관리자 활동 기록)만 읽거나 바꾼다.
 * 앞선 묶음의 도우미(_helpers-noti*.ts)는 고치지 않고 가져다 쓴다.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Api, ApiError, LoginResult } from '../../../src/api';
import { psql, psqlRows, sqlStr } from '../../../src/remote';
import { expect, LoggedIn } from '../../../src/fixtures';
import { TempUser } from '../../../src/seed';
import { relaxAuthRates } from '../auth/_helpers-auth';
import { test as p1bTest } from './_helpers-noti-p1b';

export { expect };

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 임시 사용자 로그인 픽스처(P1b 와 같은 방식). 429(속도 제한)면 이 PC IP 키만 지우고 다시 한다.
 * 다른 영역이 동시에 돌아 내 IP 키가 이미 사라져 relaxAuthRates 가 키를 못 찾으면(예외), 그 429 는 곧 풀리는 것이므로
 * 잠시 기다렸다 다시 한다(최대 6번). 로그인 실패(401 등)와 6번 뒤에도 429 인 경우는 그대로 던진다.
 */
export const test = p1bTest.extend<{ login: (user: TempUser) => Promise<LoggedIn> }>({
  login: async ({}, use) => {
    const apis: Api[] = [];
    await use(async user => {
      let session: LoginResult | undefined;
      for (let attempt = 0; !session; attempt++) {
        try {
          session = await Api.signin(user.email, user.password);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 429 || attempt >= 6) throw error;
          try {
            await relaxAuthRates();
          } catch {
            await wait(5_000); // 내 IP 키가 이미 없다 = 제한이 방금 풀렸다. 잠시 뒤 다시 로그인
          }
          await wait(500 * (attempt + 1));
        }
      }
      const api = await Api.fromLogin(session);
      apis.push(api);
      return { user, api, login: session, who: { label: user.id, login: session } };
    });
    for (const api of apis) await api.dispose();
  },
});

export { channelsOf, logTexts, CAM_SIGNAL_ALLOWED, CAM_SIGNAL_SKIP_REASON, CHANNEL_SETTING, TYPE_SETTING, requestConnection, addMedication, kstDoseTimeAgo, reminderClaimCount } from './_helpers-noti-p1b';
export { bodyOf, logRows, waitForLog, wsUrl } from './_helpers-noti';
export { insertLogRow, logCountOf, p1aBodies, p1aClose, p1aOpen, p1aSettle, p1aSubscribe, p1aWaitFor, p1aState } from './_helpers-noti-p1a';
export type { LogRow } from './_helpers-noti';

export const P2_TAGS = { tag: ['@P2', '@NOTI'] };

/** 이메일을 바꾸는 동안 사용자 id 를 적어 두는 폴더(실행이 강제로 끊겼을 때 다음 실행이 원래 값으로 돌려놓는다) */
const PENDING_DIR = path.join(os.homedir(), 'qa-tmp', 'final-qa', 'noti-p2-pending-email');
const STALE_MS = 10 * 60_000; // 10분 넘은 기록만 되돌린다(지금 돌고 있는 다른 실행의 기록은 건드리지 않는다)

/** 앞선 실행이 끊겨 남은 이메일 변경을 원래 값으로 돌린다. 기록에 적힌 id 의 사용자만, 아직 임시 값일 때만 바꾼다 */
function restoreStaleEmails() {
  if (!fs.existsSync(PENDING_DIR)) return;
  for (const name of fs.readdirSync(PENDING_DIR)) {
    const file = path.join(PENDING_DIR, name);
    try {
      if (Date.now() - fs.statSync(file).mtimeMs < STALE_MS) continue;
      const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; original: string; temporary: string };
      psql(`UPDATE users SET email = ${sqlStr(rec.original)} WHERE id = ${sqlStr(rec.id)} AND email = ${sqlStr(rec.temporary)};`);
      fs.unlinkSync(file);
    } catch {
      // 다음 실행에서 다시 시도한다
    }
  }
}

/** 실행마다 다른 공백 문자열(빈 이메일과 같게 취급되지만 이메일 유일 제약과 겹치지 않는다) */
export function blankEmail(): string {
  return ' '.repeat(1 + Math.floor(Math.random() * 40) + (Date.now() % 40));
}

/**
 * 임시 사용자의 이메일 칸을 잠시 다른 값으로 바꾸고, 끝나면(실패해도) 원래 값으로 돌려놓는다.
 * 원래 값으로 돌려놓아야 tempUser 정리(e2e 이메일 패턴만 지움)가 이 사용자를 지울 수 있다.
 * 바꾸기 전에 id 를 파일에 적어 두어, 실행이 강제로 끊겨도 다음 실행 시작 때 되돌린다.
 * 빈 값으로 바꿀 때는 blankEmail() 을 넘긴다(같은 시각에 다른 test 가 '' 를 써도 유일 제약에 걸리지 않게).
 */
export async function withEmailChanged<T>(userId: string, originalEmail: string, temporaryEmail: string, run: () => Promise<T>): Promise<T> {
  restoreStaleEmails();
  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const record = path.join(PENDING_DIR, `${userId}.json`);
  fs.writeFileSync(record, JSON.stringify({ id: userId, original: originalEmail, temporary: temporaryEmail }));
  try {
    const changed = psql(`UPDATE users SET email = ${sqlStr(temporaryEmail)} WHERE id = ${sqlStr(userId)} AND email = ${sqlStr(originalEmail)} RETURNING id;`);
    expect(changed.trim(), `준비: 이메일 칸 변경 - 임시 사용자 1명(${userId})이 바뀌어야 한다(0행이면 id 나 원래 이메일이 다르다)`).toBe(userId);
    return await run();
  } finally {
    psql(`UPDATE users SET email = ${sqlStr(originalEmail)} WHERE id = ${sqlStr(userId)};`);
    try {
      fs.unlinkSync(record);
    } catch {
      // 이미 없음
    }
  }
}
/** 이 관리자(임시 사용자)의 활동 기록 수 */
export function auditCountOf(adminId: string): number {
  return Number(psql(`SELECT count(*) FROM admin_audit_log WHERE admin_id = ${sqlStr(adminId)};`));
}

/** 이 관리자(임시 사용자)가 남긴 활동 기록만 지운다 */
export function deleteAuditRowsOf(adminId: string) {
  psql(`DELETE FROM admin_audit_log WHERE admin_id = ${sqlStr(adminId)};`);
}

/** 보호자가 문의를 쓰고 id 를 돌려준다 */
export async function createInquiry(guardian: Api, title: string): Promise<number> {
  const created = await guardian.post<{ id?: number; inquiryId?: number }>('/api/guardian/inquiry', {
    category: 'SERVICE',
    title,
    content: 'QA 알림 확인용 문의입니다.',
  });
  const id = created.id ?? created.inquiryId;
  expect(typeof id, '문의 id 가 응답에 있어야 한다').toBe('number');
  return id as number;
}

/** 한국 시간 오늘 0시(자정) 를 나타내는 SQL 식 */
export const KST_MIDNIGHT_SQL = `(date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;

/** 임시 사용자 id 에 걸린 알림 이력의 종류 목록(오름차순 id) */
export function logTypesOf(recipientId: string): string[] {
  return psqlRows(`SELECT type FROM notification_log WHERE recipient_id = ${sqlStr(recipientId)} ORDER BY id;`).map(r => r[0]);
}

/** 이 토큰의 플랫폼(DB). 없으면 null */
export function platformOfToken(token: string): string | null {
  const rows = psqlRows(`SELECT platform FROM fcm_token WHERE token = ${sqlStr(token)};`);
  return rows.length ? rows[0][0] : null;
}

/** 임시 사용자의 알림 이력 행 하나의 읽음 시각·생성 시각 등을 지우지 않고 보기 위한 행 수 */
export function logRowExists(id: number): boolean {
  return Number(psql(`SELECT count(*) FROM notification_log WHERE id = ${Number(id)};`)) === 1;
}
