/**
 * Playwright globalSetup: 모든 실행 시작 전에 한 번 돈다(--grep·--project 와 상관없이 항상).
 *
 * 이전 실행이 강제 종료(SIGKILL 등)돼 afterAll 정리가 돌지 않으면 e2e 임시 계정의 카메라가 dev 에 남는다.
 * 서비스 전체 카메라 상한(3대)을 차지해 다른 카메라 테스트가 409 로 실패하므로, 오래된 것만 지운다(2026-11-14 카메라 296 사례).
 *
 * - e2e 계정(이메일 e2e.%@silverbridge.test) 소유 카메라만. 실제 사용자 카메라는 건드리지 않는다.
 * - 만든 지 STALE_MINUTES 넘은 것만. 다른 세션에서 지금 돌고 있는 테스트의 카메라(가장 긴 시나리오도 40분 안팎)는 남긴다.
 * - 정리에 실패해도 실행은 계속한다(경고만).
 */
import { E2E_EMAIL_LIKE } from './accounts';
import { psql, sqlStr } from './remote';

const STALE_MINUTES = 120;

export default async function globalCleanup() {
  try {
    const out = psql(`
      DELETE FROM camera
       WHERE ward_id IN (SELECT id FROM users WHERE email LIKE ${sqlStr(E2E_EMAIL_LIKE)})
         AND created_at < now() - interval '${STALE_MINUTES} minutes'
      RETURNING id;`);
    const ids = out ? out.split('\n').filter(Boolean) : [];
    if (ids.length) console.log(`[global-cleanup] 오래된 e2e 카메라 ${ids.length}대 삭제: ${ids.join(', ')}`);
  } catch (error) {
    console.warn('[global-cleanup] 오래된 e2e 카메라 정리 실패(실행은 계속)', error);
  }
}
