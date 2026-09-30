/**
 * dev DB 의 E2E 계정을 지우고 새로 만든다.
 *
 * users 를 지우면 connection·medication·fcm_token·notification_log 등은 FK CASCADE 로 같이 지워진다.
 * ON DELETE SET NULL 이라 고아 행이 남는 sos_event·access_log 는 먼저 직접 지운다.
 * 팀원 계정은 건드리지 않는다: 모든 삭제는 e2e 이메일 패턴으로 한정한다.
 */
import bcrypt from 'bcryptjs';

import { ACCOUNTS, ADDRESS, E2E_EMAIL_LIKE } from './accounts';
import { env } from './env';
import { psql, redisDelPattern, sqlStr } from './remote';

const e2eUserIds = `(SELECT id FROM users WHERE email LIKE ${sqlStr(E2E_EMAIL_LIKE)})`;

export function deleteE2eUsersSql() {
  return `
    DELETE FROM sos_event   WHERE ward_id IN ${e2eUserIds};
    DELETE FROM access_log  WHERE user_id IN ${e2eUserIds};
    DELETE FROM users       WHERE email LIKE ${sqlStr(E2E_EMAIL_LIKE)};
  `;
}

export function resetE2eAccounts() {
  const hash = bcrypt.hashSync(env.password, 10);

  const values = Object.values(ACCOUNTS)
    .map(a =>
      `(${[
        sqlStr(a.id), sqlStr(a.email), sqlStr(hash), sqlStr(a.name), sqlStr(a.phone), sqlStr(a.role),
        `'ACTIVE'`, `'LOCAL'`, sqlStr(a.gender), sqlStr(a.birthDate),
        sqlStr(ADDRESS.postcode), sqlStr(ADDRESS.address), sqlStr(ADDRESS.addressDetail),
      ].join(', ')})`,
    )
    .join(',\n      ');

  // 팀원 계정과 id·전화번호가 겹치면 조용히 덮어쓰지 않고 실패시킨다
  const ids = Object.values(ACCOUNTS).map(a => sqlStr(a.id)).join(', ');
  const phones = Object.values(ACCOUNTS).map(a => sqlStr(a.phone)).join(', ');

  const out = psql(`
    BEGIN;
    ${deleteE2eUsersSql()}
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM users WHERE id IN (${ids}) OR phone IN (${phones})) THEN
        RAISE EXCEPTION 'E2E 계정 id/전화번호가 다른 계정과 겹칩니다. src/accounts.ts 를 바꾸세요.';
      END IF;
    END $$;
    INSERT INTO users (id, email, password, name, phone, role, status, provider, gender, birth_date,
                       postcode, address, address_detail)
    VALUES
      ${values};
    COMMIT;
    SELECT count(*) FROM users WHERE email LIKE ${sqlStr(E2E_EMAIL_LIKE)};
  `);

  // 이전 실행이 남긴 로그인 실패 카운트·잠금 (키: login:fail|lock:{userId})
  for (const account of Object.values(ACCOUNTS)) {
    redisDelPattern(`login:*:${account.id}`);
  }

  return Number(out.split('\n').pop());
}

/** 비어 있는 010-0000-9xxx 테스트 번호 */
export function uniqueTestPhone(from = 9300, span = 600) {
  for (let i = 0; i < 20; i++) {
    const phone = `0100000${from + Math.floor(Math.random() * span)}`;
    if (psql(`SELECT count(*) FROM users WHERE phone = ${sqlStr(phone)};`) === '0') return phone;
  }
  throw new Error('비어 있는 테스트 전화번호를 찾지 못했습니다.');
}

export interface TempUserOptions {
  name?: string;
  /** 기본 ACTIVE. RESTRICTED(이용 제한)·INACTIVE(탈퇴 진행 중) 상태를 바로 만들 수 있다 */
  status?: 'ACTIVE' | 'RESTRICTED' | 'INACTIVE';
  /** KAKAO 면 비밀번호 없이 만든다 (비밀번호 로그인 불가 - DB·API 레벨 시나리오용) */
  provider?: 'LOCAL' | 'KAKAO';
  /** 기본은 비어 있는 010-0001-xxxx 번호. null 이면 전화번호 없음 */
  phone?: string | null;
  gender?: 'MALE' | 'FEMALE';
  birthDate?: string;
  password?: string;
}

export interface TempUser {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  role: 'GUARDIAN' | 'WARD' | 'ADMIN';
  status: 'ACTIVE' | 'RESTRICTED' | 'INACTIVE';
  provider: 'LOCAL' | 'KAKAO';
  password: string;
}

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomChars(n: number) {
  return Array.from({ length: n }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join('');
}

/** 비어 있는 010-0001-xxxx 번호 (가입자에게 배정되지 않는 국번. 변수 QA 임시 사용자용) */
export function tempPhone() {
  for (let i = 0; i < 20; i++) {
    const phone = `0100001${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    if (psql(`SELECT count(*) FROM users WHERE phone = ${sqlStr(phone)};`) === '0') return phone;
  }
  throw new Error('비어 있는 임시 전화번호를 찾지 못했습니다.');
}

/**
 * 테스트용 일회성 계정 (매번 새 id). 테스트끼리 상태를 공유하지 않게 할 때 쓴다.
 * 이메일이 e2e 패턴이라 다음 실행의 resetE2eAccounts 가 지운다. 바로 지우려면 deleteTempUser
 * (fixtures 의 tempUser 를 쓰면 테스트가 끝날 때 자동으로 지운다).
 */
export function createTempUser(role: 'GUARDIAN' | 'WARD' | 'ADMIN', nameOrOptions?: string | TempUserOptions): TempUser {
  const o: TempUserOptions = typeof nameOrOptions === 'string' ? { name: nameOrOptions } : nameOrOptions ?? {};
  const provider = o.provider ?? 'LOCAL';
  const status = o.status ?? 'ACTIVE';
  const password = o.password ?? env.password;
  const phone = o.phone === undefined ? tempPhone() : o.phone;
  const hash = provider === 'LOCAL' ? bcrypt.hashSync(password, 10) : null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = `e2${randomChars(4)}`;
    if (psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(id)};`) !== '0') continue;
    const suffix = randomChars(4);
    const email = `e2e.temp.${Date.now().toString(36)}${suffix}@silverbridge.test`;
    const name = o.name ?? `E2E임시${role === 'WARD' ? '피보호자' : role === 'GUARDIAN' ? '보호자' : '관리자'}${suffix.slice(0, 2)}`;
    psql(`INSERT INTO users (id, email, password, name, phone, role, status, provider, provider_id, gender, birth_date,
                             postcode, address, address_detail)
          VALUES (${[id, email, hash, name, phone, role, status, provider,
                     provider === 'KAKAO' ? `e2e-kakao-${id}` : null,
                     o.gender ?? 'MALE', o.birthDate ?? '1970-01-01'].map(sqlStr).join(', ')},
                  ${sqlStr(ADDRESS.postcode)}, ${sqlStr(ADDRESS.address)}, ${sqlStr(ADDRESS.addressDetail)});`);
    return { id, email, name, phone, role, status, provider, password };
  }
  throw new Error('임시 사용자 id 를 만들지 못했습니다.');
}

export function deleteTempUser(id: string) {
  psql(`DELETE FROM sos_event WHERE ward_id = ${sqlStr(id)};
        DELETE FROM access_log WHERE user_id = ${sqlStr(id)};
        DELETE FROM users WHERE id = ${sqlStr(id)} AND email LIKE ${sqlStr(E2E_EMAIL_LIKE)};`);
}

/**
 * 로그인·토큰 재발급 IP 레이트리밋(1분 10회) 카운터를 지운다.
 * 키가 `rate:signin:{IP}` 라 팀원 IP 카운터도 함께 초기화되지만, 제한이 풀리는 방향이라 해가 없다.
 */
export function relaxRateLimits() {
  return (
    redisDelPattern('rate:signin:*') +
    redisDelPattern('rate:token-refresh:*') +
    redisDelPattern('rate:find-email:*')
  );
}
