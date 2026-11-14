/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1b: 화면 공통 보안 (FE 응답 헤더, 챗 경로는 FE 프록시 불가)
 * 근거: BE 프로젝트_설명.txt 3-16(챗 중계: "FE 프록시에 챗 경로를 되살리지 마세요"), FE 배포본 a8666240 next.config.ts·src/app/api/[...path]·src/app/api/streams
 */
import { request } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';

const TAGS = { tag: ['@P1', '@CHAT'] };

test.describe('CHAT P1b - 화면 공통 보안', () => {
  test('CHAT-N47 FE 보안 헤더와 X-Powered-By 제거, 챗 경로는 FE 프록시 불가', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await loginAs(await tempUser('GUARDIAN'));
    const fe = await request.newContext({ baseURL: env.baseUrl });
    const feAuthed = await request.newContext({
      baseURL: env.baseUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${guardian.login.accessToken}` },
    });
    try {
      // 1) 화면 응답 헤더
      const page = await fe.get('/login');
      expect(page.status(), '로그인 화면 응답').toBe(200);
      const headers = page.headers();
      expect.soft(headers['strict-transport-security'], 'HSTS').toBe('max-age=31536000');
      expect.soft(headers['content-security-policy'], 'CSP').toBe("frame-ancestors 'self'");
      expect.soft(headers['x-frame-options'], 'X-Frame-Options').toBe('SAMEORIGIN');
      expect.soft(headers['x-powered-by'], 'X-Powered-By 제거 (값이 있으면 실패)').toBeUndefined();

      // 2) 챗 경로는 FE 프록시로 AI 서버에 닿지 않는다: 송출 프록시는 허용 목록 밖이라 인증 전에 404
      for (const path of ['/api/streams/v1/chat', '/api/streams/v1/chat/logs', '/api/streams/v1/chat/ask']) {
        const res = await fe.post(path, { data: {} });
        expect(res.status(), `FE 송출 프록시 ${path}`).toBe(404);
        expect((await res.json()).success).toBe(false);
      }
      // 일반 프록시(/api/*)는 백엔드로만 가고 백엔드에는 AI 챗 경로가 없다
      for (const [method, path] of [['GET', '/api/v1/chat/logs'], ['POST', '/api/v1/chat']] as const) {
        const res = await feAuthed.fetch(path, { method, data: method === 'POST' ? {} : undefined });
        expect(res.status(), `FE 일반 프록시 ${method} ${path} (보호자 토큰)`).toBe(404);
        const body = await res.json().catch(() => null);
        expect(body?.code, `${path} 오류 코드`).toBe('API_NOT_FOUND');
      }
      // 허용된 길은 백엔드 중계뿐이다: FE 프록시로 보호자 챗 기록 조회가 백엔드 중계를 거쳐 200
      const relay = await feAuthed.get('/api/guardian/chat/logs');
      expect(relay.status(), '백엔드 챗 중계(FE 프록시 경유)').toBe(200);
      expect((await relay.json()).success).toBe(true);
    } finally {
      await fe.dispose();
      await feAuthed.dispose();
    }
  });
});
