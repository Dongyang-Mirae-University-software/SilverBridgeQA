/**
 * 최종 QA - 인증(AUTH) P2 - 공통 보안 (N32 N33 A55)
 *
 * 응답 헤더·CORS·오류 형식만 본다. 임시 사용자(관리자 1명)만 쓰고, 목록 조회는 그 사용자 이메일로 거른다.
 */
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { countBackendLog } from '../../../src/remote';
import { callBe, expectFail, signinRaw, tokensOf, uniqueSuffix } from './_helpers-auth';
import { callBeAny, relaxMine } from './_helpers-auth-p1a';
import { relaxP2, TAGS_P2 } from './_helpers-auth-p2';

test.beforeEach(() => relaxP2());

test('AUTH-N32 응답 보안 헤더', TAGS_P2, async () => {
  const targets = [
    { label: '200 응답(actuator health)', call: () => callBe('GET', '/actuator/health') },
    { label: '401 응답(로그인 없이 /api/user/me)', call: () => callBe('GET', '/api/user/me') },
    { label: '401 응답(틀린 로그인)', call: () => signinRaw('e2e.nobody.p2@silverbridge.test', 'Wrong1!pass') },
  ];
  for (const { label, call } of targets) {
    await test.step(label, async () => {
      const res = await call();
      expect(res.status, `${label} 상태`).toBeLessThan(500);
      const h = res.headers;
      expect(h['strict-transport-security'], 'HSTS').toContain('max-age=31536000');
      expect(h['strict-transport-security'], 'HSTS 하위 도메인 포함').toContain('includeSubDomains');
      expect(h['x-frame-options'], 'X-Frame-Options').toBe('DENY');
      expect(h['x-content-type-options'], 'X-Content-Type-Options').toBe('nosniff');
      expect(h['referrer-policy'], 'Referrer-Policy').toBe('same-origin');
      expect(h['content-security-policy'], 'CSP default-src').toContain("default-src 'self'");
      expect(h['permissions-policy'], 'Permissions-Policy 로 카메라·마이크·위치·결제 차단').toBe('camera=(), microphone=(), geolocation=(), payment=()');
    });
  }
});

test('AUTH-N33 CORS 허용 origin 목록', TAGS_P2, async () => {
  const preflight = (origin: string) =>
    callBeAny('OPTIONS', '/api/auth/signin', {
      headers: {
        Origin: origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });

  await test.step('허용 origin(FE 주소): preflight 통과, 쿠키 허용', async () => {
    const res = await preflight(env.baseUrl);
    expect(res.status, `허용 origin preflight ${res.status}`).toBe(200);
    expect(res.headers['access-control-allow-origin'], '허용 origin 을 그대로 돌려준다').toBe(env.baseUrl);
    expect(res.headers['access-control-allow-credentials'], '쿠키·Authorization 허용').toBe('true');
    expect(res.headers['access-control-allow-methods'], '허용 메서드에 POST').toContain('POST');
  });

  for (const origin of ['https://evil.example.com', env.baseUrl.replace(/^https:/, 'http:'), `${env.baseUrl}.evil.example.com`]) {
    await test.step(`목록 밖 origin(${origin.replace(/^https?:\/\//, '')}): 브라우저가 막도록 허용 헤더가 없다`, async () => {
      const res = await preflight(origin);
      expect(res.status, `목록 밖 preflight ${res.status}`).toBe(403);
      expect(res.headers['access-control-allow-origin'], '허용 헤더 없음').toBeUndefined();
      expect(res.headers['access-control-allow-credentials'], '쿠키 허용 헤더 없음').toBeUndefined();
    });
  }
});

test('AUTH-A55 오류 응답 형식: code 필드 존재, 비정상 요청에도 같은 형식', TAGS_P2, async ({ tempUser, openAs }) => {
  test.setTimeout(120_000);
  const marker = `E2EMARK${uniqueSuffix()}`;
  const korean = /[가-힣]/;
  // 서버는 깨진 요청마다 예외 "클래스 이름"만 warn 로그로 남긴다(GlobalExceptionHandler, 본문 값은 빼고).
  // 문서가 금지한 것은 요청 원문이므로, 이름이 늘어나는지는 보지 않고 표식(원문)이 없는지만 본다

  await test.step('깨진 JSON: 400 INVALID_INPUT + 한국어 안내', async () => {
    const res = await callBe('POST', '/api/auth/signin', { data: `{"email":"${marker}`, headers: { 'Content-Type': 'application/json' } });
    expectFail(res, 400, 'INVALID_INPUT', '깨진 JSON');
    expect(res.json?.success, 'success=false').toBe(false);
    expect(res.message, '한국어 안내').toMatch(korean);
  });

  await test.step('지원하지 않는 Content-Type: 415 UNSUPPORTED_MEDIA_TYPE + 한국어 안내', async () => {
    const res = await callBe('POST', '/api/auth/signin', { data: 'email=a', headers: { 'Content-Type': 'text/plain' } });
    expectFail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'text/plain');
    expect(res.message, '한국어 안내').toMatch(korean);
  });

  await test.step('잘못된 메서드: 405 METHOD_NOT_ALLOWED + 허용 방식 안내', async () => {
    const res = await callBe('GET', '/api/auth/signin');
    expectFail(res, 405, 'METHOD_NOT_ALLOWED', 'GET signin');
    expect(res.message, '한국어 안내').toMatch(korean);
    expect(res.message, '허용 방식(POST)을 알려 준다').toContain('POST');
  });

  const admin = await tempUser('ADMIN');
  await relaxMine();
  const login = await signinRaw(admin.email, admin.password);
  expect(login.status, `준비: 관리자 로그인 ${login.status}`).toBe(200);
  const token = tokensOf(login).access;
  const list = (page: string) => `/api/admin/user?keyword=${encodeURIComponent(admin.email)}&page=${page}&size=50`;

  await test.step('int 범위를 넘는 page: 400 INVALID_INPUT', async () => {
    const res = await callBe('GET', list('99999999999'), { token });
    expectFail(res, 400, 'INVALID_INPUT', 'page=99999999999');
    expect(res.message, '한국어 안내').toMatch(korean);
  });

  await test.step('아주 큰 page(2147483647): 서버 오류가 아니라 정상 응답(빈 결과)', async () => {
    const res = await callBe('GET', list('2147483647'), { token });
    expect(res.status, `page=2147483647 상태 ${res.status} ${res.code ?? ''}`).toBe(200);
    expect(res.json?.success, 'success=true').toBe(true);
  });

  await test.step('로그에 깨진 요청의 원문이 남지 않는다', async () => {
    expect(countBackendLog(marker, 600), '깨진 JSON 속 표식이 서버 로그에 없다').toBe(0);
  });

  await test.step('화면: 비정상 요청의 서버 안내 문구가 그대로 보이고 "알 수 없는 오류"는 뜨지 않는다', async () => {
    const page = await openAs('anonymous', null);
    let mode: 'broken' | 'media' = 'broken';
    await page.route('**/api/auth/find-email', route => {
      if (mode === 'broken') return route.continue({ postData: '{"name":' });
      return route.continue({ headers: { ...route.request().headers(), 'content-type': 'text/plain' } });
    });
    await page.goto('/find-email');
    for (const [next, expectedStatus, expectedCode] of [['broken', 400, 'INVALID_INPUT'], ['media', 415, 'UNSUPPORTED_MEDIA_TYPE']] as const) {
      mode = next;
      await page.getByLabel('이름').fill('E2E형식');
      await page.getByLabel('전화번호').fill('01000009999');
      const found = page.waitForResponse(r => r.url().endsWith('/api/auth/find-email') && r.request().method() === 'POST', { timeout: 30_000 });
      await page.getByRole('button', { name: '아이디 찾기' }).click();
      const res = await found;
      expect(res.status(), `${next} 상태`).toBe(expectedStatus);
      const body = await res.json();
      expect(body.code, `${next} code`).toBe(expectedCode);
      await expect(page.locator('p[role="alert"]'), `${next}: 서버 안내 문구 표시`).toHaveText(body.message);
      await expect(page.getByText('알 수 없는 오류')).toHaveCount(0);
    }
  });
});
