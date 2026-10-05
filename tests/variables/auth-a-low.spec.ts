/**
 * 변수 QA - 인증 (low 등급, 묶음 A)
 *
 * AUTH-G05, G06, G07, G08, G10, G11, G13, G15, G18, G19.
 * 모든 테스트는 "올바른 동작"을 단언하므로 결함이 있는 동안에는 실패한다.
 *
 * 부작용 원칙:
 * - 임시 사용자(tempUser)와 이 파일이 직접 만든 행(정확한 이메일로만 지운다)만 다룬다.
 * - SMS·메일은 보내지 않는다: 인증코드·nonce 는 Redis 에 직접 넣는다.
 *   발송 API 는 "발송 전에 반드시 429 로 막히는 상태"(발송 상한 키를 10 으로 미리 채움)에서만, 그것도 키 값을 확인한 뒤 호출한다.
 *   가입 SMS 발송 API(signup/sms/send)는 호출하지 않는다.
 * - 레이트리밋은 지우기만 하고 조이지 않는다.
 */
import { randomUUID } from 'node:crypto';

import { Browser, Page, request } from '@playwright/test';

import { ADDRESS } from '../../src/accounts';
import { contextDefaults, installPageStubs, pageStubArg } from '../../src/browser';
import { env } from '../../src/env';
import { expect, test } from '../../src/fixtures';
import { psql, redis, redisDelPattern, sqlStr } from '../../src/remote';
import { relaxRateLimits, TempUser, uniqueTestPhone } from '../../src/seed';
import { tokenCookies } from '../../src/session';

interface Raw {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** BE 를 직접 호출한다 (FE 프록시·쿠키 없이) */
async function post(path: string, data: unknown, token?: string): Promise<Raw> {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  try {
    const res = await ctx.post(path, { data });
    return { status: res.status(), body: await res.text(), headers: res.headers() };
  } finally {
    await ctx.dispose();
  }
}

async function getMe(token: string): Promise<Raw> {
  const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
  try {
    const res = await ctx.get('/api/user/me');
    return { status: res.status(), body: await res.text(), headers: res.headers() };
  } finally {
    await ctx.dispose();
  }
}

function messageOf(raw: Raw) {
  try {
    return (JSON.parse(raw.body) as { message?: string }).message ?? raw.body.slice(0, 200);
  } catch {
    return raw.body.slice(0, 200);
  }
}

function tokensOf(raw: Raw) {
  const data = (JSON.parse(raw.body) as { data: { accessToken: string; refreshToken: string } }).data;
  return { access: data.accessToken, refresh: data.refreshToken };
}

function jwtPayload(token: string) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as { sub: string; iat: number };
}

/** 이 테스트가 만든 사용자(정확한 이메일)만 지운다 */
function deleteUserByEmail(email: string) {
  const ids = `(SELECT id FROM users WHERE email = ${sqlStr(email)})`;
  psql(`DELETE FROM sos_event WHERE ward_id IN ${ids};
        DELETE FROM access_log WHERE user_id IN ${ids};
        DELETE FROM users WHERE email = ${sqlStr(email)};`);
}

function signupBody(over: { email: string; name: string; phone: string; nonce: string }) {
  return {
    name: over.name,
    email: over.email,
    password: env.password,
    phone: over.phone,
    verificationNonce: over.nonce,
    role: 'GUARDIAN',
    address: ADDRESS.address,
    addressDetail: ADDRESS.addressDetail,
    gender: 'MALE',
    birthDate: '1985-04-15',
    postcode: ADDRESS.postcode,
  };
}

const suffix = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

test.beforeEach(() => relaxRateLimits());
test.afterEach(() => {
  redisDelPattern('rate:signup:*');
  redisDelPattern('rate:kakao-signup:*');
  relaxRateLimits();
});

test.describe('로그인 잠금·토큰 무효화', () => {
  test('[AUTH-G05] 동시에 오답을 보내도 로그인 5회 제한을 넘겨 비밀번호를 시도할 수 없다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const failKey = `login:fail:${user.id}`;
    const lockKey = `login:lock:${user.id}`;
    const LOCKED = '비밀번호를 5회 이상 틀렸습니다';
    const RATE = '요청이 너무 많습니다';

    /** 오답 n 건(+정답 선택)을 동시에 보내고 상태·메시지·소요시간을 모은다 */
    async function burst(wrong: number, withCorrect = false) {
      const t0 = Date.now();
      // Node fetch(undici) 로 보낸다: 요청마다 컨텍스트를 새로 만드는 방식보다 서버 도착 시각이 덜 벌어진다
      const one = async (password: string, kind: string) => {
        const start = Date.now() - t0;
        const res = await fetch(`${env.apiUrl}/api/auth/signin`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: user.email, password }),
        });
        const raw: Raw = { status: res.status, body: await res.text(), headers: {} };
        return { kind, status: raw.status, message: messageOf(raw), start, end: Date.now() - t0 };
      };
      return Promise.all([
        ...Array.from({ length: wrong }, () => one('Wrong1!pass', '오답')),
        ...(withCorrect ? [one(user.password, '정답')] : []),
      ]);
    }
    const describe = (rows: Awaited<ReturnType<typeof burst>>) =>
      rows.map(row => `${row.kind}:${row.status}(${row.start}-${row.end}ms,${row.message.slice(0, 12)})`).join(' | ');

    try {
      // 1) 경쟁 창을 결정적으로 만든다: 이미 4회 실패한 상태(다음 1회 실패면 잠금)로 두고
      //    오답 8건을 동시에 보낸다. 올바르면 비교까지 가는 것은 1건(401)뿐이고 나머지 7건은 잠금(429)이어야 한다.
      //    IP 한도(10회/분)에 걸리지 않도록 8건만 보내고, 429 는 잠금 메시지로만 센다.
      // 연결을 미리 열어 둔다(keep-alive): TLS 핸드셰이크 차이로 서버 도착 시각이 벌어지지 않게 한다.
      // 로그인 API 가 아닌 GET 이라 로그인 실패 횟수·IP 한도에는 영향이 없다
      await Promise.all(Array.from({ length: 8 }, () => fetch(`${env.apiUrl}/`).then(res => res.text()).catch(() => '')));
      redis('SET', failKey, '4', 'EX', '1800');
      const rows = await burst(8);
      const invalid = rows.filter(row => row.status === 401).length;
      const locked = rows.filter(row => row.status === 429 && row.message.includes(LOCKED)).length;
      const rate = rows.filter(row => row.status === 429 && row.message.includes(RATE)).length;
      const summary = `401=${invalid}, 잠금429=${locked}, IP한도429=${rate}, 기타=${rows.length - invalid - locked - rate}`;
      test.info().annotations.push({ type: '4회 실패 상태에서 동시 오답 8건', description: `${summary} :: ${describe(rows)}` });
      expect(rate, `준비: IP 레이트리밋이 섞이면 판정이 불가하다 (${summary})`).toBe(0);

      // 2) 관찰용: 4회 실패 상태에서 오답 5 + 정답 1 동시 전송 (정답이 잠금 이후에도 200 이 되는지)
      redisDelPattern(`login:*:${user.id}`);
      relaxRateLimits();
      redis('SET', failKey, '4', 'EX', '1800');
      const mixed = await burst(5, true);
      const lockedAfter = redis('EXISTS', lockKey);
      test.info().annotations.push({
        type: '4회 실패 상태에서 오답 5 + 정답 1 동시',
        description: `${describe(mixed)} :: 잠금키 존재=${lockedAfter}`,
      });

      expect(
        invalid,
        `이미 4회 실패한 계정에 동시 오답 8건을 보내면 5번째 실패로 잠겨 비교는 1건만 되어야 하는데, 잠금 확인이 비교 전에만 있어 ${invalid}건이 비밀번호 비교까지 진행됐다 (${summary}). 시도 횟수를 비교 전에 원자적으로 예약해야 한다`,
      ).toBeLessThanOrEqual(1);
    } finally {
      redisDelPattern(`login:*:${user.id}`);
    }
  });

  test('[AUTH-G06] 무효화(비밀번호 재설정 등) 시각과 같은 초에 발급된 새 access 토큰도 유효하다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const login = await post('/api/auth/signin', { email: user.email, password: user.password });
    expect(login.status, `준비: 로그인이 성공해야 한다 (${messageOf(login)})`).toBe(200);
    const { access } = tokensOf(login);
    const { sub, iat } = jwtPayload(access);
    const key = `password:invalidate:${sub}`;

    try {
      const before = await getMe(access);
      expect(before.status, '준비: 무효화 기준이 없을 때 /api/user/me 는 200 이어야 한다').toBe(200);

      // 토큰이 발급된 바로 그 초의 시작(ms)에 "비밀번호 재설정으로 무효화"가 있었던 상황을 만든다.
      // 재설정이 먼저 일어나고 곧바로 로그인해 받은 새 토큰은 iat 가 초 단위로 절삭되어 이 값과 같아진다
      redis('SET', key, String(iat * 1000), 'EX', '300');
      const after = await getMe(access);
      test.info().annotations.push({ type: '같은 초 무효화 후 /me', description: `${after.status} ${messageOf(after)}` });

      expect(
        after.status,
        `무효화 이후에 발급된 새 토큰(iat=${iat}초)인데 무효화 시각(${iat * 1000}ms)과 같은 초라는 이유로 ${after.status} "${messageOf(after)}" 로 거절된다`,
      ).toBe(200);
    } finally {
      redis('DEL', key);
    }
  });
});

test.describe('카카오·이메일 가입 선점', () => {
  test('[AUTH-G07] 카카오 가입 완료는 세션을 시작한 요청자가 아니면 kakaoId 만 알아도 거절된다', async () => {
    const tag = suffix();
    const kakaoId = `e2e${tag}`.slice(0, 20);
    const email = `e2e.kakaopending.${tag}@silverbridge.test`;
    const phone = uniqueTestPhone();
    const nonce = randomUUID();

    try {
      // 피해자가 카카오 로그인만 하고 가입은 아직 끝내지 않은 상태(BE 가 남긴 세션)를 그대로 만든다
      redis('SET', `kakao:pending:${kakaoId}`, email, 'EX', '1800');
      // 공격자는 자기 번호로 SMS 인증을 마친 상태
      redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');

      const res = await post('/api/auth/signup/kakao', {
        kakaoId,
        name: 'E2E선점자',
        phone,
        verificationNonce: nonce,
        role: 'GUARDIAN',
        address: ADDRESS.address,
        addressDetail: ADDRESS.addressDetail,
        gender: 'MALE',
        birthDate: '1985-04-15',
        postcode: ADDRESS.postcode,
      });
      const rows = psql(`SELECT count(*) FROM users WHERE provider_id = ${sqlStr(kakaoId)};`);
      test.info().annotations.push({ type: '가입 응답', description: `${res.status} (provider_id 로 생성된 행 ${rows}건)` });

      expect(
        res.status,
        `세션을 시작하지 않은 제3자가 kakaoId 만으로 피해자의 카카오 신원으로 가입을 완료했다 (응답 ${res.status}, 생성된 행 ${rows}건). 일회용 세션 토큰 검증이 필요하다`,
      ).toBeGreaterThanOrEqual(400);
    } finally {
      redis('DEL', `kakao:pending:${kakaoId}`);
      redis('DEL', `sms:verified:${phone}`);
      deleteUserByEmail(email);
    }
  });

  test('[AUTH-G08] 일반 가입으로 카카오 대체 이메일(kakao_{id}@kakao.com)을 선점할 수 없다', async () => {
    // 카카오가 이메일을 주지 않을 때 쓰는 실제 형식은 kakao_{숫자 회원번호}@kakao.com 이다(BE 는 이 형식만 예약).
    // 실제 회원번호와 겹치지 않게 9 로 시작하는 13자리 이상 숫자를 쓰고, 끝나면 지운다
    const email = `kakao_9${Date.now()}@kakao.com`;
    const phone = uniqueTestPhone();
    const nonce = randomUUID();

    try {
      redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');
      const res = await post('/api/auth/signup', signupBody({ email, name: 'E2E선점', phone, nonce }));
      const exists = psql(`SELECT count(*) FROM users WHERE email = ${sqlStr(email)};`);
      test.info().annotations.push({ type: '가입 응답', description: `${res.status} (행 ${exists}건)` });

      expect(
        res.status,
        `이메일 소유 확인 없이 카카오 대체 이메일 형식(${email})으로 가입이 통과했다 (응답 ${res.status}). 이후 실제 카카오 사용자는 409 로 가입할 수 없다. 예약 도메인 거부 또는 메일 인증이 필요하다`,
      ).toBeGreaterThanOrEqual(400);
    } finally {
      redis('DEL', `sms:verified:${phone}`);
      deleteUserByEmail(email);
    }
  });
});

test.describe('인증코드 확인 API', () => {
  test('[AUTH-G10] 인증코드 확인은 병렬 요청에도 5회를 넘겨 비교하지 않고, 과도한 연속 호출은 IP 제한(429)을 받는다', async ({ tempUser }) => {
    const user: TempUser = await tempUser('GUARDIAN');
    const phone = user.phone as string;
    const verifyKey = `password:sms:verify:${phone}`;
    const attemptKey = `password:sms:attempt:${phone}`;
    const SMS_VERIFY = '/api/auth/find-password/sms/verify';

    const reset = () => {
      redis('SET', verifyKey, '654321', 'EX', '300');
      redis('DEL', attemptKey);
    };

    try {
      await test.step('병렬 오답 30건: 코드가 삭제되기 전에 비교되는 시도가 5건을 넘지 않는다', async () => {
        reset();
        const results = await Promise.all(
          Array.from({ length: 30 }, (_, i) => post(SMS_VERIFY, { phone, code: String(100000 + i) })),
        );
        const compared = results.filter(result => {
          const message = messageOf(result);
          return message.includes('인증번호가 올바르지 않습니다') || message.includes('5회 이상');
        }).length;
        const expired = results.filter(result => messageOf(result).includes('만료')).length;
        const limited = results.filter(result => result.status === 429).length;
        const summary = `비교됨=${compared}, 만료=${expired}, 429=${limited}, 전체=${results.length}`;
        test.info().annotations.push({ type: '병렬 오답 30건', description: summary });
        expect
          .soft(
            compared,
            `코드 조회 - 비교 - 실패 시 증가 순서가 비원자적이라 5회 제한을 넘어 ${compared}건이 비교됐다 (${summary})`,
          )
          .toBeLessThanOrEqual(5);
      });

      await test.step('연속 호출: 확인 API 3종 모두 IP 요청 제한(429)이 있어야 한다', async () => {
        const targets = [
          { label: '비밀번호 찾기 SMS 확인', path: SMS_VERIFY, body: { phone, code: '111111' } },
          { label: '비밀번호 찾기 이메일 확인', path: '/api/auth/find-password/email/verify', body: { email: user.email, code: '111111' } },
          { label: '가입 SMS 확인', path: '/api/auth/signup/sms/verify', body: { phone, code: '111111' } },
        ];
        for (const target of targets) {
          const ctx = await request.newContext({ baseURL: env.apiUrl });
          let limited = 0;
          try {
            for (let i = 0; i < 30; i++) {
              const res = await ctx.post(target.path, { data: target.body });
              if (res.status() === 429) limited += 1;
            }
          } finally {
            await ctx.dispose();
          }
          test.info().annotations.push({ type: `${target.label} 연속 30회`, description: `429 ${limited}건` });
          expect.soft(limited, `${target.label} 을 30회 연속 호출해도 429 가 한 번도 없다 (IP 제한 부재)`).toBeGreaterThan(0);
        }
      });
    } finally {
      redis('DEL', verifyKey);
      redis('DEL', attemptKey);
      redis('DEL', `password:email:verify:${user.email}`);
      redis('DEL', `password:email:attempt:${user.email}`);
      redis('DEL', `sms:verify:${phone}`);
      redis('DEL', `sms:attempt:${phone}`);
    }
  });
});

test.describe('발송 상한', () => {
  test('[AUTH-G11] 발송 상한(시간당 10건)에 걸리면 남은 대기 시간을 알려준다', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    const phone = user.phone as string;
    const smsCount = `sms:sendcount:${phone}`;
    const mailCount = `password:email:sendcount:${user.email}`;

    try {
      await test.step('SMS: 번호당 상한 초과 응답에 남은 시간이 있어야 한다 (상한 키를 미리 채워 발송 전에 막힌다)', async () => {
        redis('SET', smsCount, '10', 'EX', '3600');
        // 안전장치: 키가 실제로 10 이어야만 호출한다 (아니면 실제 SMS 가 나갈 수 있다)
        expect(redis('GET', smsCount), '준비: 발송 상한 키가 10 이어야 한다').toBe('10');
        const res = await post('/api/auth/find-password/sms/send', { name: user.name, phone });
        const ttl = redis('TTL', smsCount);
        test.info().annotations.push({ type: 'SMS 상한 초과 응답', description: `${res.status} "${messageOf(res)}" Retry-After=${res.headers['retry-after'] ?? '없음'} TTL=${ttl}` });
        expect(res.status, `준비: 상한 초과는 429 여야 한다 (${res.body.slice(0, 200)})`).toBe(429);
        const hasWait = Boolean(res.headers['retry-after']) || /\d+\s*(분|초|시간)/.test(messageOf(res));
        expect.soft(hasWait, `429 응답에 남은 대기 시간(Retry-After 또는 메시지)이 없다: "${messageOf(res)}" (실제 남은 TTL ${ttl}초)`).toBe(true);
      });

      await test.step('이메일: 이메일당 상한 초과 응답에 남은 시간이 있어야 한다', async () => {
        redis('SET', mailCount, '10', 'EX', '3600');
        expect(redis('GET', mailCount), '준비: 발송 상한 키가 10 이어야 한다').toBe('10');
        const res = await post('/api/auth/find-password/email/send', { email: user.email });
        const ttl = redis('TTL', mailCount);
        test.info().annotations.push({ type: '이메일 상한 초과 응답', description: `${res.status} "${messageOf(res)}" Retry-After=${res.headers['retry-after'] ?? '없음'} TTL=${ttl}` });
        expect(res.status, `준비: 상한 초과는 429 여야 한다 (${res.body.slice(0, 200)})`).toBe(429);
        const hasWait = Boolean(res.headers['retry-after']) || /\d+\s*(분|초|시간)/.test(messageOf(res));
        expect.soft(hasWait, `429 응답에 남은 대기 시간이 없다: "${messageOf(res)}" (실제 남은 TTL ${ttl}초)`).toBe(true);
      });
    } finally {
      redis('DEL', smsCount);
      redis('DEL', mailCount);
      redis('DEL', `password:sms:verify:${phone}`);
      redis('DEL', `password:email:verify:${user.email}`);
      redisDelPattern('rate:pw-reset-sms:*');
      redisDelPattern('rate:pw-reset-email:*');
    }
  });
});

test.describe('이름 정규화', () => {
  test('[AUTH-G13] 이름 앞뒤 공백은 정규화되어 공백 없이 입력해도 아이디 찾기가 되고, 실질 문자가 없는 이름은 가입할 수 없다', async () => {
    const tag = suffix();

    await test.step('(a) 이름 뒤 공백으로 가입한 계정을 공백 없이 입력해 아이디 찾기', async () => {
      const email = `e2e.name.${tag}@silverbridge.test`;
      const phone = uniqueTestPhone();
      const nonce = randomUUID();
      try {
        redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');
        const signup = await post('/api/auth/signup', signupBody({ email, name: 'E2E검증 ', phone, nonce }));
        expect(signup.status, `준비: 이름 뒤 공백 가입 요청이 처리돼야 한다 (${messageOf(signup)})`).toBeLessThan(500);
        test.info().annotations.push({ type: '뒤 공백 이름 가입', description: String(signup.status) });
        const stored = psql(`SELECT '[' || name || ']' FROM users WHERE email = ${sqlStr(email)};`);
        test.info().annotations.push({ type: '저장된 이름', description: stored || '(없음)' });

        if (signup.status < 300) {
          relaxRateLimits();
          const found = await post('/api/auth/find-email', { name: 'E2E검증', phone });
          expect.soft(found.status, `이름 뒤 공백이 그대로 저장되어 공백 없이 찾으면 ${found.status} "${messageOf(found)}" (저장된 이름 ${stored})`).toBe(200);
        } else {
          // 서버가 공백 이름을 거절했다면 저장 자체가 막힌 것이므로 정규화 이전에 정책상 거부된 경우다
          test.info().annotations.push({ type: '참고', description: '서버가 뒤 공백 이름을 거절했다' });
        }
      } finally {
        redis('DEL', `sms:verified:${phone}`);
        deleteUserByEmail(email);
      }
    });

    await test.step('(b) 보이지 않는 문자(제로폭 공백)만으로 된 이름은 가입이 거절된다', async () => {
      const email = `e2e.zerowidth.${tag}@silverbridge.test`;
      const phone = uniqueTestPhone();
      const nonce = randomUUID();
      try {
        redis('SET', `sms:verified:${phone}`, nonce, 'EX', '600');
        const res = await post('/api/auth/signup', signupBody({ email, name: '​​', phone, nonce }));
        test.info().annotations.push({ type: '제로폭 이름 가입', description: String(res.status) });
        expect.soft(res.status, `제로폭 공백 2자로 된 이름이 @NotBlank 를 통과해 가입됐다 (응답 ${res.status})`).toBeGreaterThanOrEqual(400);
      } finally {
        redis('DEL', `sms:verified:${phone}`);
        deleteUserByEmail(email);
      }
    });
  });
});

test.describe('비밀번호 찾기 화면', () => {
  test('[AUTH-G15] 새 비밀번호 단계에서 인증코드가 만료돼도 다시 인증받는 길이 화면에 있다', async ({ tempUser, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const verifyKey = `password:email:verify:${user.email}`;
    const attemptKey = `password:email:attempt:${user.email}`;
    const page = await openAs('anonymous', null);

    try {
      // 메일 발송만 가짜로 대체한다 (실제 메일 없음). 코드는 Redis 에 직접 넣는다
      await page.route('**/api/auth/find-password/email/send', route =>
        route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300, codeLength: 6 } } }),
      );
      await page.goto('/find-password');

      await page.getByRole('button', { name: /이메일 인증/ }).click();
      await page.locator('input[name="email"]').fill(user.email);
      await page.getByRole('button', { name: '이메일 발송', exact: true }).click();

      redis('SET', verifyKey, '123456', 'EX', '300');
      redis('DEL', attemptKey);
      await page.locator('input[inputmode="numeric"]').fill('123456');
      await page.getByRole('button', { name: '인증 확인', exact: true }).click();
      await expect(page.getByRole('heading', { name: '새 비밀번호 생성' })).toBeVisible();

      // 4단계에서 새 비밀번호를 고민하는 사이 코드 유효시간(5분)이 지난 상황
      redis('EXPIRE', verifyKey, '1');
      await page.waitForTimeout(2500);
      expect(redis('EXISTS', verifyKey), '준비: 인증코드가 만료돼야 한다').toBe('0');

      await page.getByPlaceholder('8자 이상').fill('NewPass1!x');
      await page.getByPlaceholder('다시 입력').fill('NewPass1!x');
      await page.getByRole('button', { name: '새 비밀번호 생성' }).click();

      const errorText = page.locator('[class*="errorMessage"]').first();
      await expect(errorText).toBeVisible();
      const shown = (await errorText.textContent()) ?? '';
      test.info().annotations.push({ type: '만료 후 화면 문구', description: shown });

      // 되돌아가거나 다시 인증받는 수단 (헤더의 ✕ 는 로그인 화면으로 나가는 버튼이라 제외한다)
      const recovery = page.getByRole('button', { name: /재발송|재전송|다시 인증|다시 받기|이전|처음부터|뒤로/ });
      const count = await recovery.count();
      expect(
        count,
        `인증코드 만료("${shown}") 후 4단계 화면에 재발송·이전 단계 버튼이 없어 새로고침으로 처음부터 다시 해야 한다`,
      ).toBeGreaterThan(0);
    } finally {
      redis('DEL', verifyKey);
      redis('DEL', attemptKey);
      redis('DEL', `password:email:sendcount:${user.email}`);
    }
  });
});

test.describe('역할 가드', () => {
  test('[AUTH-G18] 프로필 조회가 일시 오류(5xx, 네트워크 오류)로 실패해도 로그아웃시키지 않는다', async ({ browser, tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { login } = await loginAs(user);

    const openWithMeFailure = async (browserRef: Browser, kind: '500' | 'abort'): Promise<{ page: Page; close: () => Promise<void> }> => {
      // openAs 대신 직접 연다: 일부러 만든 5xx 를 PageWatcher 가 서버 결함으로 세지 않도록
      const context = await browserRef.newContext({ ...contextDefaults, storageState: { cookies: tokenCookies(login), origins: [] } });
      await context.addInitScript(installPageStubs(), pageStubArg);
      const page = await context.newPage();
      await page.route('**/api/user/me', route =>
        kind === '500'
          ? route.fulfill({ status: 500, json: { success: false, message: '서버 오류가 발생했습니다.' } })
          : route.abort('failed'),
      );
      return { page, close: () => context.close() };
    };

    for (const kind of ['500', 'abort'] as const) {
      await test.step(`프로필 조회 ${kind === '500' ? '500 응답' : '네트워크 오류'}`, async () => {
        const { page, close } = await openWithMeFailure(browser, kind);
        try {
          await page.goto('/guardian');
          const wentToLogin = await page.waitForURL(/\/login/, { timeout: 10_000 }).then(
            () => true,
            () => false,
          );
          const refresh = (await page.context().cookies()).find(cookie => cookie.name === 'careai_refresh_token')?.value;
          const access = (await page.context().cookies()).find(cookie => cookie.name === 'careai_access_token')?.value;
          test.info().annotations.push({
            type: `${kind} 결과`,
            description: `/login 이동=${wentToLogin}, access 쿠키=${Boolean(access)}, refresh 쿠키=${Boolean(refresh)}`,
          });
          expect.soft(wentToLogin, `서버 세션은 유효한데 /api/user/me 일시 오류(${kind}) 한 번에 /login 으로 쫓겨났다`).toBe(false);
          expect.soft(Boolean(refresh), `일시 오류(${kind}) 한 번에 유효한 refresh 토큰을 지웠다`).toBe(true);
        } finally {
          await close();
        }
      });
    }
  });
});

test.describe('WebSocket 세션', () => {
  test('[AUTH-G19] 비밀번호 재설정으로 토큰이 무효화되면 이미 열린 WebSocket 연결도 종료된다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { login } = await loginAs(user);
    // FE 오리진(허용된 Origin)에서 STOMP 연결만 직접 열어 둔다. 앱 화면을 열면 API 401 로 앱이 스스로 연결을 닫아 검증이 흐려진다
    const page = await openAs('anonymous', '/login');
    const wsUrl = `${env.apiUrl.replace(/^http/, 'ws')}/ws?token=${login.accessToken}`;

    await test.step('준비: 유효한 토큰으로 STOMP 연결을 연다', async () => {
      const connected = await page.evaluate(
        url =>
          new Promise<boolean>(resolve => {
            const ws = new WebSocket(url);
            (window as unknown as { __e2eWs: WebSocket }).__e2eWs = ws;
            const timer = setTimeout(() => resolve(false), 15000);
            ws.onopen = () => ws.send('CONNECT\naccept-version:1.2\nheart-beat:0,0\n\n\0');
            ws.onmessage = event => {
              if (String(event.data).startsWith('CONNECTED')) {
                clearTimeout(timer);
                resolve(true);
              }
            };
            ws.onerror = () => {
              clearTimeout(timer);
              resolve(false);
            };
          }),
        wsUrl,
      );
      expect(connected, '준비: WebSocket(STOMP) 연결이 성립해야 한다').toBe(true);
    });

    await test.step('비밀번호 재설정 (인증코드는 Redis 에 직접 주입, 메일 발송 없음)', async () => {
      redis('SET', `password:email:verify:${user.email}`, '123456', 'EX', '300');
      const res = await post('/api/auth/password/reset', { email: user.email, code: '123456', newPassword: 'NewPass1!x' });
      expect(res.status, `준비: 재설정이 성공해야 한다 (${messageOf(res)})`).toBe(200);
    });

    await test.step('새 요청/새 연결은 막힌다 (전제 확인)', async () => {
      const me = await getMe(login.accessToken);
      test.info().annotations.push({ type: '재설정 후 옛 토큰 /me', description: String(me.status) });
      expect.soft(me.status, '재설정 후 옛 access 토큰의 HTTP 요청은 401 이어야 한다').toBe(401);
    });

    await test.step('이미 열린 연결은 서버가 종료해야 한다', async () => {
      await page.waitForTimeout(6000);
      const state = await page.evaluate(() => (window as unknown as { __e2eWs: WebSocket }).__e2eWs.readyState);
      test.info().annotations.push({ type: '재설정 6초 후 WebSocket readyState', description: `${state} (1=OPEN, 3=CLOSED)` });
      expect(state, `비밀번호 재설정으로 토큰이 무효화됐는데 기존 WebSocket 연결이 열린 채(readyState ${state}) 남아 알림을 계속 받을 수 있다`).toBe(3);
    });

    await page.evaluate(() => (window as unknown as { __e2eWs?: WebSocket }).__e2eWs?.close()).catch(() => undefined);
  });
});
