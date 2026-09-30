/**
 * 모든 테스트 전에 한 번 실행된다.
 * 1) 서버 상태 확인  2) E2E 계정 재생성  3) 역할별 로그인 상태 저장  4) 기본 연결(보호자1-피보호자1)  5) 라우트 예열
 */
import { expect, request, test as setup } from '@playwright/test';

import { ACCOUNTS, AccountKey } from '../src/accounts';
import { Api } from '../src/api';
import { env } from '../src/env';
import { relaxRateLimits, resetE2eAccounts } from '../src/seed';
import { freshLogin, loginAndSave } from '../src/session';

const WARM_UP_ROUTES = [
  '/login', '/signup', '/find-email', '/find-password',
  '/guardian', '/guardian/sos', '/guardian/detection', '/guardian/emotion', '/guardian/chatbot',
  '/guardian/wards', '/guardian/medication', '/guardian/hospital', '/guardian/stream',
  '/guardian/notices', '/guardian/inquiries', '/guardian/settings', '/guardian/game',
  '/ward', '/ward/sos', '/ward/medication', '/ward/guardians', '/ward/notices', '/ward/settings', '/ward/game',
];

setup('dev 환경 준비', async () => {
  setup.setTimeout(300_000);

  await setup.step('서버 상태 확인', async () => {
    const ctx = await request.newContext();
    const health = await ctx.get(`${env.apiUrl}/actuator/health`);
    expect(health.status(), 'BE /actuator/health').toBe(200);
    const fe = await ctx.get(`${env.baseUrl}/login`);
    expect(fe.status(), 'FE /login').toBe(200);
    await ctx.dispose();
  });

  if (!env.skipReset) {
    await setup.step('E2E 계정 재생성 (dev DB)', async () => {
      const count = resetE2eAccounts();
      expect(count).toBe(Object.keys(ACCOUNTS).length);
    });
  }

  await setup.step('역할별 로그인 상태 저장', async () => {
    relaxRateLimits();
    for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
      await loginAndSave(key);
    }
    relaxRateLimits();
  });

  if (!env.skipReset) {
    await setup.step('기본 연결: 보호자1 - 피보호자1 (관리자 강제 연결)', async () => {
      const admin = await Api.fromLogin(await freshLogin('admin'));
      await admin.post('/api/admin/connection', {
        guardianId: ACCOUNTS.guardian1.id,
        wardId: ACCOUNTS.ward1.id,
      });
      await admin.dispose();
    });
  }

  await setup.step('라우트 예열 (next dev 첫 컴파일)', async () => {
    const ctx = await request.newContext({ baseURL: env.baseUrl, timeout: 120_000 });
    for (const route of WARM_UP_ROUTES) {
      await ctx.get(route).catch(() => undefined);
    }
    await ctx.dispose();
  });
});
