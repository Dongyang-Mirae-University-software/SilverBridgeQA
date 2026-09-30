/**
 * 계정별 로그인 상태(storageState) 파일.
 *
 * FE 는 토큰을 HttpOnly 가 아닌 쿠키(careai_access_token / careai_refresh_token)에 두므로,
 * API 로 로그인해 받은 토큰을 쿠키로 넣어 두면 화면 로그인 없이 바로 해당 역할로 시작할 수 있다.
 *
 * BE 토큰 정책 때문에 신경 쓸 점:
 * - 로그인할 때마다 그 사용자의 refresh token 이 전부 폐기된다(단일 기기) → 같은 계정으로 API 로그인을
 *   남발하면 열려 있는 브라우저가 나중에 refresh 할 때 로그아웃된다. 그래서 API 호출도 이 파일의 토큰을 재사용한다.
 * - refresh token 은 1회용(rotation)이고 재사용하면 전 토큰이 폐기된다 → access token(30분)이 만료되기 전에
 *   상태 파일을 새로 로그인해 갱신해서, 여러 브라우저가 같은 refresh token 으로 재발급을 시도하지 않게 한다.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ACCOUNTS, AccountKey } from './accounts';
import { Api, LoginResult } from './api';
import { env, feHost } from './env';

const AUTH_DIR = path.resolve('.auth');
/** access token 30분보다 충분히 짧게 */
const MAX_STATE_AGE_MS = 20 * 60 * 1000;

export function statePath(key: AccountKey) {
  return path.join(AUTH_DIR, `${key}.json`);
}

function metaPath(key: AccountKey) {
  return path.join(AUTH_DIR, `${key}.meta.json`);
}

export function tokenCookies(login: Pick<LoginResult, 'accessToken' | 'refreshToken'>) {
  const expires = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  const base = { domain: feHost, path: '/', expires, httpOnly: false, secure: false, sameSite: 'Lax' as const };
  return [
    { ...base, name: 'careai_access_token', value: encodeURIComponent(login.accessToken) },
    { ...base, name: 'careai_refresh_token', value: encodeURIComponent(login.refreshToken) },
  ];
}

export async function loginAndSave(key: AccountKey, password = env.password): Promise<LoginResult> {
  const login = await Api.signin(ACCOUNTS[key].email, password);
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(statePath(key), JSON.stringify({ cookies: tokenCookies(login), origins: [] }, null, 2), { mode: 0o600 });
  writeFileSync(metaPath(key), JSON.stringify({ savedAt: Date.now(), login }), { mode: 0o600 });
  return login;
}

/** 20분이 지났거나 무효 표시된 상태 파일이면 새로 로그인해서 갱신한다 */
export async function freshLogin(key: AccountKey): Promise<LoginResult> {
  if (existsSync(metaPath(key))) {
    const meta = JSON.parse(readFileSync(metaPath(key), 'utf8')) as { savedAt: number; login: LoginResult };
    if (Date.now() - meta.savedAt < MAX_STATE_AGE_MS) return meta.login;
  }
  return loginAndSave(key);
}

/**
 * 테스트가 그 계정으로 화면 로그인·로그아웃·비밀번호 변경을 했다면 저장된 토큰이 무효가 됐을 수 있다.
 * 다음에 쓸 때 새로 로그인하도록 표시한다.
 */
export function markStale(key: AccountKey) {
  rmSync(metaPath(key), { force: true });
}
