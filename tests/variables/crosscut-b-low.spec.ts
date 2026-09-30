/**
 * 변수 QA - 횡단(입력 검증·응답 형식·연결 요청·WS 접속 표시·인증 쿠키) 낮은 심각도 항목
 *
 * 부작용 차단: 임시 사용자만 쓴다. SMS·메일·알림톡이 나가는 API 는 부르지 않는다.
 * 연결 요청 반복(XCUT-G29)은 임시 피보호자(전화번호 미배정, FCM 토큰 없음)에게만 보낸다.
 */
import { request } from '@playwright/test';

import { env } from '../../src/env';
import { expect, test, waitForRealtime } from '../../src/fixtures';
import { psql, redis, redisDelPattern, sqlStr } from '../../src/remote';
import { relaxRateLimits } from '../../src/seed';
import { loginViaForm } from '../../src/variables';

const ACCESS_COOKIE = 'careai_access_token';
const REFRESH_COOKIE = 'careai_refresh_token';

function b64url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** 서명이 틀리고 exp 가 지난 JWT (만료 토큰 흉내) */
function expiredJwt(sub: string, role: string) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role, typ: 'access', iat: now - 7200, exp: now - 3600 })}.${'x'.repeat(43)}`;
}

/** PUT /api/user/me 본문: 임시 사용자의 현재 값 그대로에 일부만 바꾼다 (전화번호는 그대로라 SMS 인증이 필요 없다) */
function profileBody(phone: string | null, override: Record<string, unknown>) {
  return {
    name: 'E2E임시', phone, gender: 'MALE', birthDate: '1970-01-01',
    postcode: '06236', address: '서울특별시 강남구 테헤란로 123', addressDetail: '101동 202호',
    ...override,
  };
}

test.describe('횡단 - 목록·입력 검증', () => {
  test('[XCUT-G21] 관리자 문의 목록도 다른 목록처럼 page/size 를 보정하고 상한을 둔다', async ({ tempUser, loginAs }) => {
    const admin = await tempUser('ADMIN');
    const { api } = await loginAs(admin);

    async function list(path: string) {
      const res = await api.raw('GET', path);
      const text = await res.text();
      let size: number | undefined;
      try {
        size = (JSON.parse(text) as { data?: { inquiries?: { size?: number } } }).data?.inquiries?.size;
      } catch {
        // 본문이 JSON 이 아니면 size 는 비워 둔다
      }
      return { status: res.status(), size, text: text.slice(0, 120) };
    }

    const negativePage = await list('/api/admin/inquiry?page=-1');
    const zeroSize = await list('/api/admin/inquiry?size=0');
    const hugeSize = await list('/api/admin/inquiry?size=100000');
    // 참고용 대조군: 다른 관리자 목록의 같은 입력 (판정에는 쓰지 않는다)
    const controlDefault = (await api.raw('GET', '/api/admin/user')).status();
    const controlNegative = (await api.raw('GET', '/api/admin/user?page=-1')).status();
    test.info().annotations.push({
      type: 'page/size 처리 표',
      description:
        `문의 page=-1 -> ${negativePage.status} / size=0 -> ${zeroSize.status} / size=100000 -> ${hugeSize.status}(size=${hugeSize.size}) | ` +
        `회원 기본 -> ${controlDefault} / page=-1 -> ${controlNegative}`,
    });
    expect.soft(negativePage.status, `page=-1 이 보정되지 않고 오류가 된다: ${negativePage.text}`).toBe(200);
    expect.soft(zeroSize.status, `size=0 이 보정되지 않고 오류가 된다: ${zeroSize.text}`).toBe(200);
    expect.soft(hugeSize.status, `size=100000 요청이 실패했다: ${hugeSize.text}`).toBe(200);
    expect.soft(hugeSize.size ?? Number.MAX_SAFE_INTEGER, `size=100000 이 상한 없이 그대로 적용된다 (응답 size=${hugeSize.size})`).toBeLessThanOrEqual(50);
  });

  test('[XCUT-G22] 501자 이상의 User-Agent 로도 로그인이 성공한다 (접속로그는 잘라서 저장)', async ({ tempUser }) => {
    const user = await tempUser('GUARDIAN');
    relaxRateLimits();

    async function signinWithUa(length: number) {
      const ctx = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { 'User-Agent': 'E2E-'.padEnd(length, 'x') } });
      const res = await ctx.post('/api/auth/signin', { data: { email: user.email, password: user.password } });
      const out = { status: res.status(), text: (await res.text()).slice(0, 150) };
      await ctx.dispose();
      return out;
    }

    const atLimit = await signinWithUa(500);
    relaxRateLimits();
    const overLimit = await signinWithUa(600);
    test.info().annotations.push({ type: 'UA 길이별 로그인', description: `500자 -> ${atLimit.status}, 600자 -> ${overLimit.status}` });

    expect(atLimit.status, `준비: 500자 UA(컬럼 길이 이내)는 로그인돼야 한다: ${atLimit.text}`).toBe(200);
    expect(overLimit.status, `UA 600자 때문에 접속로그 INSERT(VARCHAR(500))가 실패해 로그인이 통째로 롤백된다: ${overLimit.text}`).toBe(200);
  });

  test('[XCUT-G23] 이름·주소·문의 제목에 NUL(U+0000) 이 들어오면 500 이 아니라 400 으로 거절한다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api } = await loginAs(guardian);

    const put = await api.raw('PUT', '/api/user/me', profileBody(guardian.phone, { name: guardian.name, address: '서울\u0000시' }));
    const putText = await put.text();
    const inquiry = await api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title: 'A\u0000B', content: 'E2E NUL 문자 검증' });
    const inquiryText = await inquiry.text();
    test.info().annotations.push({
      type: 'NUL 입력 결과',
      description: `PUT /api/user/me(address) -> ${put.status()}, POST /api/guardian/inquiry(title) -> ${inquiry.status()}`,
    });

    expect.soft(put.status(), `주소의 NUL 이 검증을 통과해 DB 오류(22021)로 서버 500 이 된다: ${putText.slice(0, 150)}`).toBeLessThan(500);
    expect.soft(inquiry.status(), `문의 제목의 NUL 이 검증을 통과해 DB 오류로 서버 500 이 된다: ${inquiryText.slice(0, 150)}`).toBeLessThan(500);
    // 통과(2xx)시킨다면 NUL 을 제거해 저장해야 한다
    const stored = psql(`SELECT address FROM users WHERE id = ${sqlStr(guardian.id)};`);
    expect.soft(stored, '저장된 주소에 NUL 이 남아 있으면 안 된다').not.toContain('\u0000');
  });

  test('[XCUT-G26] 제로폭·NBSP·전각공백만 있는 이름과 문의 제목은 빈 값으로 보고 거절한다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api } = await loginAs(guardian);
    const blanks: Record<string, string> = {
      '제로폭(U+200B)': '​​​',
      'NBSP(U+00A0)': '  ',
      '전각공백(U+3000)': '　　',
    };

    for (const [label, value] of Object.entries(blanks)) {
      await test.step(`이름 ${label}`, async () => {
        const res = await api.raw('PUT', '/api/user/me', profileBody(guardian.phone, { name: value }));
        expect.soft(res.status(), `${label} 만으로 된 이름이 @NotBlank 를 통과해 저장된다 (응답 ${res.status()})`).toBe(400);
      });
      await test.step(`문의 제목 ${label}`, async () => {
        const res = await api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title: value, content: 'E2E 공백 검증' });
        expect.soft(res.status(), `${label} 만으로 된 문의 제목이 @NotBlank 를 통과해 등록된다 (응답 ${res.status()})`).toBe(400);
      });
    }
    const blankNames = psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(guardian.id)} AND btrim(name, E' \\u00A0\\u200B\\u3000') = '';`);
    expect.soft(blankNames, '이름이 눈에 보이는 글자 없이 저장된 회원이 생겼다').toBe('0');
  });
});

test.describe('횡단 - 응답 형식', () => {
  test('[XCUT-G27] 401 오류 응답에는 원인을 구분하는 안정적인 code 필드가 있다', async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    relaxRateLimits();
    const { api } = await loginAs(user);
    const bodies: Record<string, { status: number; json: Record<string, unknown> }> = {};

    async function capture(label: string, res: { status(): number; text(): Promise<string> }) {
      const text = await res.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text.slice(0, 100) };
      }
      bodies[label] = { status: res.status(), json };
    }

    try {
      // (1) 잘못된 비밀번호 로그인
      const ctx = await request.newContext({ baseURL: env.apiUrl });
      await capture('로그인 비밀번호 불일치', await ctx.post('/api/auth/signin', { data: { email: user.email, password: `${user.password}x` } }));
      // (2) 비밀번호 변경 시 현재 비밀번호 불일치
      await capture(
        '현재 비밀번호 불일치',
        await api.raw('PUT', '/api/user/me/password', { currentPassword: `${user.password}x`, newPassword: 'E2eNewPass!2345' }),
      );
      // (3) 만료된 access 토큰
      const expired = await request.newContext({ baseURL: env.apiUrl, extraHTTPHeaders: { Authorization: `Bearer ${expiredJwt(user.id, 'GUARDIAN')}` } });
      await capture('만료 토큰', await expired.get('/api/user/me'));
      // (4) 토큰 없음
      await capture('토큰 없음', await ctx.get('/api/user/me'));
      await ctx.dispose();
      await expired.dispose();
    } finally {
      redisDelPattern(`login:*:${user.id}`);
    }

    test.info().annotations.push({
      type: '401 응답 본문',
      description: Object.entries(bodies).map(([k, v]) => `${k}: ${v.status} ${JSON.stringify(v.json)}`).join(' | '),
    });

    const rows = Object.entries(bodies);
    for (const [label, { status, json }] of rows) {
      expect.soft(status, `준비: ${label} 는 401 이어야 한다`).toBe(401);
      expect.soft(typeof json.code, `${label} 401 응답에 문자열 code 필드가 없다 (message 문구로만 구분해야 함): ${JSON.stringify(json)}`).toBe('string');
    }
    // 만료 토큰(세션 만료)과 비밀번호 불일치는 FE 가 전혀 다르게 처리해야 하므로 code 가 달라야 한다
    expect.soft(
      bodies['만료 토큰'].json.code !== undefined && bodies['만료 토큰'].json.code !== bodies['현재 비밀번호 불일치'].json.code,
      '세션 만료 401 과 비밀번호 불일치 401 을 code 로 구분할 수 없다',
    ).toBe(true);
  });
});

test.describe('횡단 - 연결 요청·접속 상태', () => {
  test('[XCUT-G29] 한 피보호자에게 연결 요청과 취소를 반복하면 대상별 상한이나 쿨다운으로 막힌다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const { api } = await loginAs(guardian);
    const rateKey = `rate:connection-request:${guardian.id}`;
    const wardNotifications = () => Number(psql(`SELECT count(*) FROM notification_log WHERE recipient_id = ${sqlStr(ward.id)};`));

    const CYCLES = 9; // 보호자당 분당 10회 제한 안쪽
    const results: number[] = [];
    try {
      for (let i = 0; i < CYCLES; i++) {
        const res = await api.raw('POST', '/api/guardian/connection/request', { targetId: ward.id, relation: '아들' });
        results.push(res.status());
        if (!res.ok()) break;
        const id = psql(`SELECT id FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)} AND status = 'PENDING';`);
        const cancel = await api.raw('DELETE', `/api/guardian/connection/cancel/${id}`);
        expect(cancel.status(), `준비: 요청 취소가 성공해야 반복할 수 있다 (id=${id})`).toBe(200);
      }
    } finally {
      redis('DEL', rateKey);
    }
    await new Promise(resolve => setTimeout(resolve, 3_000));
    const logged = wardNotifications();
    test.info().annotations.push({
      type: '요청-취소 반복 결과',
      description: `요청 응답 ${results.join(',')} (성공 ${results.filter(s => s === 200).length}회), 피보호자 notification_log ${logged}행`,
    });

    expect(
      results.filter(s => s === 200).length,
      `같은 피보호자에게 요청-취소를 ${CYCLES}번 반복해도 전부 성공해 매번 연결 요청 알림이 전송된다 (응답 ${results.join(',')})`,
    ).toBeLessThan(CYCLES);
  });

  test('[XCUT-G30] 접속 중인 사용자는 ws:connected 키가 있고, 탭 하나를 닫아도 다른 탭이 남아 있으면 유지된다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who } = await loginAs(ward);
    const key = `ws:connected:${ward.id}`;
    const exists = () => redis('EXISTS', key) === '1';

    const tabA = await openAs(who, '/ward');
    await waitForRealtime(tabA);
    await tabA.waitForTimeout(1_500);
    const afterConnect = exists();
    test.info().annotations.push({ type: 'WS 연결 후 ws:connected 키', description: afterConnect ? '있음' : '없음' });
    expect.soft(afterConnect, 'STOMP 연결이 됐는데 ws:connected 키가 생성되지 않는다 (CONNECTED 프레임에는 세션 속성이 없어 userId 가 null)').toBe(true);

    if (afterConnect) {
      const tabB = await tabA.context().newPage();
      await tabB.goto('/ward');
      await waitForRealtime(tabB);
      await tabB.close();
      await tabA.waitForTimeout(2_500);
      expect.soft(exists(), '탭 B 만 닫았는데 탭 A 가 아직 연결 중인데도 키가 삭제된다 (연결 수 카운트 없음)').toBe(true);
    }
  });
});

test.describe('횡단 - 인증 쿠키', () => {
  test('[XCUT-G31] refresh 토큰 쿠키는 JS 로 읽을 수 없고(HttpOnly) Secure 이다', async ({ tempUser, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    // 쿠키를 심지 않고 실제 로그인 화면으로 로그인해, FE 가 스스로 저장하는 쿠키 속성을 본다
    const page = await openAs('anonymous', '/login');
    await loginViaForm(page, guardian.email, guardian.password);
    await expect(page).toHaveURL(/\/guardian/, { timeout: 20_000 });
    await page.waitForTimeout(1_000);

    const cookies = await page.context().cookies();
    const refresh = cookies.find(c => c.name === REFRESH_COOKIE);
    const access = cookies.find(c => c.name === ACCESS_COOKIE);
    const jsVisible = await page.evaluate(() => document.cookie);
    test.info().annotations.push({
      type: '인증 쿠키 속성',
      description:
        `refresh: httpOnly=${refresh?.httpOnly} secure=${refresh?.secure} sameSite=${refresh?.sameSite}, ` +
        `access: httpOnly=${access?.httpOnly} secure=${access?.secure}, document.cookie 에 refresh 노출=${jsVisible.includes(REFRESH_COOKIE)}`,
    });

    expect(refresh, '준비: 로그인 후 refresh 토큰 쿠키가 있어야 한다').toBeDefined();
    expect.soft(jsVisible.includes(REFRESH_COOKIE), 'document.cookie 로 7일짜리 refresh 토큰을 읽을 수 있어 XSS 한 번에 세션이 탈취된다').toBe(false);
    expect.soft(refresh?.httpOnly, 'refresh 토큰 쿠키에 HttpOnly 가 없다').toBe(true);
    expect.soft(refresh?.secure, 'refresh 토큰 쿠키에 Secure 가 없다').toBe(true);
  });
});
