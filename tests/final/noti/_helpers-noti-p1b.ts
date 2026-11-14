/**
 * 최종 QA 알림(NOTI) P1b 묶음 전용 도우미.
 * 임시 사용자만 쓴다. DB 는 임시 사용자 자신의 행만 지우거나 조회한다(공용 키·전체 목록 조회 없음).
 * 로그인 속도 제한(429)은 이 PC IP 키만 지우는 relaxAuthRates 로 푼다(src 의 relaxRateLimits 는 모든 IP 를 지우므로 쓰지 않는다).
 */
import { Api, ApiError, LoginResult } from '../../../src/api';
import { expect, LoggedIn, test as base } from '../../../src/fixtures';
import { psql, psqlRows, sqlStr } from '../../../src/remote';
import { TempUser } from '../../../src/seed';
import { relaxAuthRates } from '../auth/_helpers-auth';

export { expect };
export { bodyOf, logRows, sendSos, setChannels, waitForLog } from './_helpers-noti';
export type { LogRow } from './_helpers-noti';

export const NOTI_P1_TAGS = { tag: ['@P1', '@NOTI'] };

/** 카메라 등록·이상감지 신호가 나가는 테스트는 이 환경변수가 1 일 때만 돈다 */
export const CAM_SIGNAL_ALLOWED = process.env.CAM_SIGNAL_ALLOWED === '1';
export const CAM_SIGNAL_SKIP_REASON = 'CAM_SIGNAL_ALLOWED=1 일 때만 실행: 카메라 등록과 이상감지 신호(공유 AI 서버에 화재 사진)가 나간다';

export const TYPE_SETTING = '/api/guardian/notification-type-setting';
export const CHANNEL_SETTING = '/api/user/me/notification-settings';

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * 임시 사용자 로그인 픽스처. 429(속도 제한)면 이 PC 의 IP 키만 지우고 다시 한다.
 * 로그인 실패(401 등)는 그대로 던진다.
 */
export const test = base.extend<{ login: (user: TempUser) => Promise<LoggedIn> }>({
  login: async ({}, use) => {
    const apis: Api[] = [];
    await use(async user => {
      let session: LoginResult | undefined;
      for (let attempt = 0; !session; attempt++) {
        try {
          session = await Api.signin(user.email, user.password);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 429 || attempt >= 4) throw error;
          await relaxAuthRates();
          await sleep(500 * (attempt + 1));
        }
      }
      const api = await Api.fromLogin(session);
      apis.push(api);
      return { user, api, login: session, who: { label: user.id, login: session } };
    });
    for (const api of apis) await api.dispose();
  },
});

// ───────────── 알림 이력 읽기 ─────────────

export interface ChannelAttemptRow {
  channel: string;
  status: string;
  reason: string | null;
}

/** notification_log.channel_results(JSON 문자열) 을 읽는다 */
export function channelsOf(channelResults: string): ChannelAttemptRow[] {
  return JSON.parse(channelResults) as ChannelAttemptRow[];
}

/** 이력 행의 제목·본문(줄바꿈은 " / " 로 바꿔 돌려준다). 임시 사용자 수신분 id 로만 조회한다 */
export function logTexts(logId: number): { title: string; body: string } {
  const [[title, ...body]] = psqlRows(
    `SELECT coalesce(title, ''), replace(coalesce(body, ''), chr(10), ' / ') FROM notification_log WHERE id = ${Number(logId)};`,
  );
  return { title, body: body.join('|') };
}

// ───────────── 임시 사용자 자신의 설정 행 ─────────────

export function channelSettingRows(userId: string): { channel: string; enabled: boolean }[] {
  return psqlRows(
    `SELECT channel_type, enabled::text FROM user_notification_setting WHERE user_id = ${sqlStr(userId)} ORDER BY channel_type;`,
  ).map(([channel, enabled]) => ({ channel, enabled: enabled === 'true' }));
}

/** 동시 첫 저장 경쟁을 만들기 위해 임시 사용자 자신의 채널 설정 행을 지운다 */
export function clearChannelSettingRows(userId: string) {
  psql(`DELETE FROM user_notification_setting WHERE user_id = ${sqlStr(userId)};`);
}

export function typePreferenceRowCount(guardianId: string): number {
  return Number(psql(`SELECT count(*) FROM guardian_notification_preference WHERE guardian_id = ${sqlStr(guardianId)};`));
}

/** 동시 첫 저장 경쟁을 만들기 위해 임시 보호자 자신의 알림 종류 설정 행을 지운다 */
export function clearTypePreferenceRow(guardianId: string) {
  psql(`DELETE FROM guardian_notification_preference WHERE guardian_id = ${sqlStr(guardianId)};`);
}

// ───────────── 연결 요청·복약 ─────────────

/** 보호자가 피보호자에게 연결 요청을 보낸다(피보호자에게 CONNECTION_REQUEST 알림이 간다). 응답 상태 코드를 돌려준다 */
export async function requestConnection(guardian: Api, wardId: string): Promise<number> {
  const res = await guardian.raw('POST', '/api/guardian/connection/request', { targetId: wardId, relation: '딸' });
  return res.status();
}

/** 한국 시간 기준 N분 전의 복용 시각("HH:MM:00"). 자정을 넘겨 어제 시각이 되면 null */
export function kstDoseTimeAgo(minutes: number): string | null {
  const format = (date: Date) =>
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  const now = new Date();
  const earlier = new Date(now.getTime() - minutes * 60_000);
  const [nowDay] = format(now).split(', ');
  const [earlierDay, earlierTime] = format(earlier).split(', ');
  if (nowDay !== earlierDay) return null;
  return `${earlierTime}:00`;
}

/** 보호자가 피보호자에게 약을 등록한다. doseTime 을 지금보다 조금 이전으로 주면 1분 주기 스케줄러가 곧 첫 알림을 선점한다 */
export async function addMedication(guardian: Api, wardId: string, doseTime: string, name = 'E2E최종약'): Promise<number> {
  const created = await guardian.post<{ medicationId: number }>(`/api/guardian/ward/${wardId}/medication`, {
    name,
    timeSlot: 'MORNING',
    doseTime,
    doseAmount: 1,
  });
  return created.medicationId;
}

/** 이 약의 복약 알림 선점 기록 수(medication_reminder_log, 약 id 로만 조회) */
export function reminderClaimCount(medicationId: number): number {
  return Number(psql(`SELECT count(*) FROM medication_reminder_log WHERE medication_id = ${Number(medicationId)};`));
}

/** 응답 본문에서 비밀이 아닌 요약(상태 코드와 success 값)만 뽑는다 */
export async function summarize(res: { status(): number; text(): Promise<string> }): Promise<string> {
  const text = await res.text();
  let success = '?';
  try {
    success = String((JSON.parse(text) as { success?: boolean }).success);
  } catch {
    success = 'json 아님';
  }
  return `${res.status()} success=${success}`;
}
