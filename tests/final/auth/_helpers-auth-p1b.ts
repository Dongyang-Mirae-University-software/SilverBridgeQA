/**
 * 최종 QA - 인증(AUTH) P1b 묶음 전용 도우미.
 *
 * P0 도우미(_helpers-auth.ts)는 import 해서만 쓰고 고치지 않는다.
 * 원칙: 임시 사용자와 이 묶음이 직접 만든 행·키만 다룬다. 공용 키를 패턴으로 지우지 않는다.
 */
import { Page, request } from '@playwright/test';

import { ADDRESS } from '../../../src/accounts';
import { env } from '../../../src/env';
import { expect } from '../../../src/fixtures';
import { psql, redis, remoteBash, sqlStr } from '../../../src/remote';
import { Raw, sha256Hex, signinRaw } from './_helpers-auth';

export const TAGS_P1 = { tag: ['@P1', '@AUTH'] };

/** 이 묶음이 속도 제한을 풀 때 쓰는 "내 IP 키" 이름들 (rate:이름:내IP 만 지운다. 공용 패턴 삭제 아님) */
export const P1B_RATE_NAMES = [
  'signin',
  'token-refresh',
  'find-email',
  'email-check',
  'signup',
  'signup-sms',
  'kakao-login',
  'kakao-signup',
  'pw-reset-confirm',
];

/**
 * rate:signin:* 키 이름을 읽는다. withValues 가 true 일 때만 "횟수"(TTL 제외)도 읽는다. 읽기 전용, 고정 패턴.
 * 키 이름에는 다른 접속자의 IP 가 들어 있으므로 메모리에서 "바뀐 키" 를 찾는 데만 쓰고 로그·결과·오류 문구에 남기지 않는다.
 * 값(횟수)은 이름만으로 찾지 못했을 때(내 키가 이미 있던 경우)에만 읽는다.
 */
function scanSigninCounts(withValues: boolean): Map<string, string> {
  const out = remoteBash(
    [
      `docker exec -i ${env.redisContainer} sh -s <<'__E2E_SCAN__'`,
      withValues
        ? `redis-cli --scan --pattern 'rate:signin:*' | while read k; do echo "$k $(redis-cli GET "$k")"; done`
        : `redis-cli --scan --pattern 'rate:signin:*' | while read k; do echo "$k -"; done`,
      '__E2E_SCAN__',
      '',
    ].join('\n'),
  );
  const map = new Map<string, string>();
  for (const line of out.split('\n').filter(Boolean)) {
    const i = line.lastIndexOf(' ');
    map.set(line.slice(0, i), line.slice(i + 1));
  }
  return map;
}

let ipSuffix: string | undefined;

/**
 * 이 PC 가 BE 에서 보이는 IP 키 끝부분. 미가입 임시 이메일로 로그인을 불러 보고 새로 생겼거나 횟수가 바뀐 rate:signin:* 키를 찾는다.
 * 같은 PC 에서 다른 영역이 같은 키를 수시로 지우므로(그러면 "바뀐 키 없음"으로 보인다) P0 도우미보다 여러 번(최대 10판) 시도한다.
 */
export async function myIpSuffixP1b(): Promise<string> {
  if (ipSuffix) return ipSuffix;
  let candidates: Set<string> | undefined;
  for (let round = 0; round < 10; round++) {
    const ghost = `e2e.ipprobe.${uniqueTag()}@silverbridge.test`;
    // 앞 4판은 키 이름만 비교(새로 생긴 키 찾기), 못 찾으면 그다음 판부터 횟수도 읽어 비교한다
    const withValues = round >= 4;
    const before = scanSigninCounts(withValues);
    await signinRaw(ghost, 'Wrong1!pass');
    const after = scanSigninCounts(withValues);
    redis('DEL', `login:fail:${sha256Hex(ghost)}`);
    const changed = [...after.keys()].filter(key => before.get(key) !== after.get(key));
    if (!changed.length) continue;
    candidates = candidates ? new Set(changed.filter(key => candidates!.has(key))) : new Set(changed);
    if (candidates.size === 1) break;
    if (candidates.size === 0) candidates = undefined;
  }
  if (!candidates || candidates.size !== 1) {
    throw new Error(`내 IP 의 속도 제한 키를 하나로 찾지 못했다 (후보 ${candidates?.size ?? 0}개)`);
  }
  ipSuffix = [...candidates][0].slice('rate:signin:'.length);
  return ipSuffix;
}

/** 이 PC IP 의 rate:이름:내IP 키만 지운다 (제한이 풀리는 방향이고, 다른 IP·다른 사용자의 카운터는 건드리지 않는다) */
export async function relaxP1bRates(names: string[] = P1B_RATE_NAMES) {
  const suffix = await myIpSuffixP1b();
  redis('DEL', ...names.map(name => `rate:${name}:${suffix}`));
}

/** 로그인 화면으로 로그인한다. 속도 제한은 이 PC IP 키만 푼다 (src/variables.ts 의 loginViaForm 은 모든 IP 를 지우므로 쓰지 않는다) */
export async function loginViaFormSafe(page: Page, email: string, password = env.password) {
  await relaxP1bRates();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

export const uniqueTag = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 이 묶음이 만드는 가입용 이메일 (cleanupUserByEmail 이 허용하는 형식) */
export const p1bEmail = (label: string) => `e2e.p1b.${label}.${uniqueTag()}@silverbridge.test`;

export const userCountByEmail = (email: string) =>
  Number(psql(`SELECT count(*) FROM users WHERE lower(email) = lower(${sqlStr(email)});`));

export const userFieldsByEmail = (email: string) =>
  psql(`SELECT id, email, provider, role FROM users WHERE lower(email) = lower(${sqlStr(email)});`);

// ---------------------------------------------------------------------------------------------
// 파일 올리기 (multipart)
// ---------------------------------------------------------------------------------------------

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG 머리말(시그니처)로 시작하는 지정 크기 바이트 (내용은 0). 크기·형식 검사용 */
export function pngLike(size: number) {
  const buf = Buffer.alloc(size);
  PNG_HEAD.copy(buf);
  return buf;
}

/** 실제로 열리는 아주 작은 1x1 PNG (파일 서버에 올려도 되는 진짜 이미지) */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export async function patchImage(
  token: string,
  file: { name: string; mimeType: string; buffer: Buffer } | null,
  fieldName = 'file',
): Promise<Raw> {
  const ctx = await request.newContext({ baseURL: env.apiUrl });
  try {
    const res = await ctx.fetch('/api/user/me/image', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` },
      multipart: file ? { [fieldName]: file } : { note: 'no-file' },
      timeout: 60_000,
    });
    const body = await res.text();
    let json: Raw['json'] = null;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return {
      status: res.status(),
      body,
      json,
      code: json?.code,
      message: json?.message,
      headers: res.headers(),
      setCookies: res.headersArray().filter(h => h.name.toLowerCase() === 'set-cookie').map(h => h.value),
    };
  } finally {
    await ctx.dispose();
  }
}

/** 주소를 GET 해서 최종 상태만 돌려준다 (리다이렉트는 따라가고, 본문은 읽지 않는다) */
export async function httpStatusOf(url: string): Promise<number> {
  const ctx = await request.newContext();
  try {
    const res = await ctx.get(url, { timeout: 30_000 });
    return res.status();
  } finally {
    await ctx.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// 가입 화면 (FE a8666240: 계정 -> 내 정보 -> 전화번호 인증 3단계)
// ---------------------------------------------------------------------------------------------

/**
 * 가입 1단계(계정)를 채운다. 이메일 칸을 벗어나는 순간 화면이 보내는 중복 확인 요청의 응답을 돌려준다
 * (형식이 맞아 요청이 나가는 값만 쓴다. 응답을 놓치지 않게 칸을 벗어나기 전에 기다릴 준비를 한다).
 */
export async function fillSignupAccount(
  page: Page,
  input: { email: string; password?: string; passwordCheck?: string; role?: 'GUARDIAN' | 'WARD' },
) {
  await page.locator(`label[for="${input.role ?? 'GUARDIAN'}"]`).click();
  const emailInput = page.getByPlaceholder('example@email.com');
  await emailInput.fill(input.email);
  const checked = page.waitForResponse(
    r => r.url().endsWith('/api/auth/signup/email/check') && r.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await emailInput.blur();
  const response = await checked;
  await page.getByPlaceholder('8자 이상').fill(input.password ?? env.password);
  await page.getByPlaceholder('비밀번호 다시 입력').fill(input.passwordCheck ?? input.password ?? env.password);
  return response;
}

export async function fillSignupProfile(page: Page, name: string) {
  await page.getByPlaceholder('홍길동').fill(name);
  await page.getByLabel('성별').selectOption('FEMALE');
  const birth = page.getByRole('group', { name: /생년월일/ }).locator('select');
  await birth.nth(0).selectOption('1985');
  await birth.nth(1).selectOption('04');
  await expect(birth.nth(2).locator('option[value="15"]')).toHaveCount(1);
  await birth.nth(2).selectOption('15');
  await page.getByRole('button', { name: '주소 검색' }).click();
  await expect(page.getByPlaceholder('주소 검색을 눌러 주세요')).toHaveValue(ADDRESS.address);
  await page.getByPlaceholder('동·호수 등').fill('E2E 가입동 202호');
}
