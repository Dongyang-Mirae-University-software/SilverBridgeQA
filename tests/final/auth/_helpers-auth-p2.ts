/**
 * 최종 QA - 인증(AUTH) P2 묶음 전용 도우미.
 *
 * 앞선 묶음의 도우미(_helpers-auth*.ts)는 import 해서만 쓰고 고치지 않는다.
 * 원칙: 임시 사용자와 이 묶음이 직접 만든 행·키만 다룬다. 공용 키를 패턴으로 지우지 않는다.
 */
import { Page } from '@playwright/test';

import { ADDRESS } from '../../../src/accounts';
import { env } from '../../../src/env';
import { expect } from '../../../src/fixtures';
import { psql, redis, sqlStr } from '../../../src/remote';
import { relaxMine } from './_helpers-auth-p1a';
import { fillSignupAccount, p1bEmail } from './_helpers-auth-p1b';

export const TAGS_P2 = { tag: ['@P2', '@AUTH'] };

/** 이 묶음이 쓰는 "내 IP" 속도 제한 이름 (rate:이름:내IP 만 지운다) */
export const P2_RATE_PATTERNS = [
  'rate:email-check:*',
  'rate:signup:*',
  'rate:signup-sms:*',
  'rate:kakao-signup:*',
  'rate:kakao-login:*',
  'rate:pw-reset-email:*',
];

export const relaxP2 = () => relaxMine(P2_RATE_PATTERNS);

export const p2Email = (label: string) => p1bEmail(`p2${label}`);

// ---------------------------------------------------------------------------------------------
// 날짜 (BE 는 KST 의 "오늘"로 나이를 센다)
// ---------------------------------------------------------------------------------------------

export function kstToday(): { y: number; m: number; d: number } {
  const iso = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const [y, m, d] = iso.split('-').map(Number);
  return { y, m, d };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** KST 오늘에서 years 년 전(같은 월·일) 생년월일. 2/29 가 해당 해에 없으면 2/28 */
export function birthYearsAgo(years: number, plusDays = 0): string {
  const t = kstToday();
  const y = t.y - years;
  const d = t.m === 2 && t.d === 29 && !isLeap(y) ? 28 : t.d;
  const base = new Date(Date.UTC(y, t.m - 1, d));
  base.setUTCDate(base.getUTCDate() + plusDays);
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

/** KST 오늘에서 days 일 뒤 */
export function kstDayOffset(days: number): string {
  const t = kstToday();
  const base = new Date(Date.UTC(t.y, t.m - 1, t.d));
  base.setUTCDate(base.getUTCDate() + days);
  return `${base.getUTCFullYear()}-${pad(base.getUTCMonth() + 1)}-${pad(base.getUTCDate())}`;
}

// ---------------------------------------------------------------------------------------------
// BE 와 같은 규칙의 기대값
// ---------------------------------------------------------------------------------------------

/** MaskingUtil.maskEmail 과 같은 규칙: 앞부분이 5자 이상이면 앞2+***+뒤2, 3~4자면 앞1+***+뒤1, 그보다 짧으면 앞1+*** */
export function maskEmailLikeBe(email: string) {
  const at = email.indexOf('@');
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length >= 5) return `${local.slice(0, 2)}***${local.slice(-2)}${domain}`;
  if (local.length >= 3) return `${local[0]}***${local.slice(-1)}${domain}`;
  return `${local[0]}***${domain}`;
}

export const userColumn = (userId: string, column: 'profile_image' | 'birth_date' | 'name') =>
  psql(`SELECT coalesce(${column}::text, '') FROM users WHERE id = ${sqlStr(userId)};`);

export const columnByEmail = (email: string, column: 'profile_image' | 'birth_date' | 'name' | 'id') =>
  psql(`SELECT '[' || coalesce(${column}::text, '') || ']' FROM users WHERE lower(email) = lower(${sqlStr(email)});`);

/** 한 임시 사용자의 사진 속도 제한 키(분·시간)만 지운다 */
export function delProfileImageRate(userId: string) {
  redis('DEL', `rate:profile-image:1m:${userId}`, `rate:profile-image:1h:${userId}`);
}

// ---------------------------------------------------------------------------------------------
// 작은 이미지 파일 (BE 는 시그니처만 본다)
// ---------------------------------------------------------------------------------------------

export const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
]);

export const TINY_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** RIFF....WEBP + VP8L 조각. 시그니처만 맞는 아주 작은 파일 */
export const TINY_WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');

// ---------------------------------------------------------------------------------------------
// 가입 화면 (FE a8666240: 계정 -> 내 정보 -> 전화번호 인증)
// ---------------------------------------------------------------------------------------------

/** 가입 2단계(내 정보). 생년월일은 'yyyy-MM-dd' 로 넘긴다. 주소는 주소 검색 창을 대체한 도우미(ADDRESS)로 채워진다 */
export async function fillSignupProfileWithBirth(page: Page, name: string, birth: string) {
  const [y, m, d] = birth.split('-');
  await page.getByPlaceholder('홍길동').fill(name);
  await page.getByLabel('성별').selectOption('FEMALE');
  const birthSelects = page.getByRole('group', { name: /생년월일/ }).locator('select');
  await birthSelects.nth(0).selectOption(y);
  await birthSelects.nth(1).selectOption(m);
  await expect(birthSelects.nth(2).locator(`option[value="${d}"]`)).toHaveCount(1);
  await birthSelects.nth(2).selectOption(d);
}

export async function fillSignupAddress(page: Page) {
  await page.getByRole('button', { name: '주소 검색' }).click();
  await expect(page.getByPlaceholder('주소 검색을 눌러 주세요')).toHaveValue(ADDRESS.address);
  await page.getByPlaceholder('동·호수 등').fill('E2E 가입동 202호');
}

/** 문자 발송·확인 요청을 대체한다(실제 문자는 나가지 않는다). 확인 응답은 미리 넣어 둔 nonce 를 돌려준다 */
export async function stubSignupSms(page: Page, nonce: string) {
  await page.route('**/api/auth/signup/sms/send', route =>
    route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } }),
  );
  await page.route('**/api/auth/signup/sms/verify', route =>
    route.fulfill({ json: { success: true, data: { verificationNonce: nonce } } }),
  );
}

/** 가입 1단계(계정)까지 채우고 2단계로 넘어간다. 이메일 중복 확인 응답 상태를 돌려준다 */
export async function goToSignupProfileStep(page: Page, email: string) {
  await page.goto('/signup');
  const checked = await fillSignupAccount(page, { email });
  await page.getByRole('button', { name: '다음' }).click();
  return checked.status();
}

export const baseHeaders = { origin: env.baseUrl };
