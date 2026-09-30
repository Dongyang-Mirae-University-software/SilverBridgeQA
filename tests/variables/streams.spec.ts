/**
 * 변수 QA - AI 스트림 프록시 인증
 *
 * 부작용 없음: 비로그인 상태로 목록 조회(GET)만 한다. 종료·생성 같은 변경 API 는 부르지 않는다.
 */
import { request } from '@playwright/test';

import { env } from '../../src/env';
import { expect, test } from '../../src/fixtures';

test('[ANOM-G01] 로그인하지 않은 사용자는 FE 의 AI 스트림 프록시로 카메라 목록을 볼 수 없다', async () => {
  const anonymous = await request.newContext({ baseURL: env.baseUrl });
  const res = await anonymous.get('/api/streams/v1/live-streams');
  const status = res.status();
  await anonymous.dispose();
  // 5xx 는 프록시가 AI 서버에 닿지 못한 것(환경 문제)이라 인증 여부를 판정할 수 없다
  expect(status, `판정 불가: FE 프록시가 AI 서버 연결에 실패 (${status}). FE 컨테이너 로그를 확인한다`).toBeLessThan(500);
  expect([401, 403], `비로그인 요청이 ${status} 로 통과 (프록시가 서버 API 키를 붙여 전달)`).toContain(status);
});
