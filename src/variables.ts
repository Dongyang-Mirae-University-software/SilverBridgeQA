/**
 * 변수 QA 테스트(tests/variables) 공통 도우미.
 *
 * 변수 QA 는 흐름 테스트와 달리 매번 임시 사용자(fixtures 의 tempUser)를 새로 만들어 쓴다.
 * 여기에는 그 임시 사용자들 사이의 상태(연결, 알림 억제 등)를 DB·Redis 로 바로 만드는 함수와
 * 화면 조작 도우미를 모은다. 발견 항목 ID(SOS-G01 등)는 Notion "변수 QA" 페이지와 같다.
 */
import { expect, Page } from '@playwright/test';

import { env } from './env';
import { modal } from './fixtures';
import { psql, redis, sqlStr } from './remote';
import { relaxRateLimits } from './seed';

export type SosAction = 'call119' | 'call119AndNotify' | 'notifyGuardianFirst';

export const WARD_SETTINGS_KEY = 'silverbridge_ward_settings';

/** 보호자-피보호자 ACTIVE 연결을 DB 에 바로 만든다 (연결 요청·수락 화면은 흐름 테스트에서 검증) */
export function connect(guardianId: string, wardId: string) {
  psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
        VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'ACTIVE', ${sqlStr(guardianId)}, now(), '기타');`);
}

/**
 * SOS 알림 쿨다운 키를 미리 넣어, SOS 가 서버에 도착해도 보호자 알림(FCM·SMS 폴백)은 나가지 않게 한다.
 * 이력(sos_event)은 쿨다운과 관계없이 남는다.
 */
export function suppressSosNotify(wardId: string, seconds = 300) {
  redis('SET', `sos:notify:cooldown:${wardId}`, '1', 'EX', String(seconds));
}

export function sosEventCount(wardId: string) {
  return Number(psql(`SELECT count(*) FROM sos_event WHERE ward_id = ${sqlStr(wardId)};`));
}

/** 페이지가 보내는 POST /api/ward/sos 를 모은다 */
export function collectSosPosts(page: Page) {
  const bodies: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/api/ward/sos')) bodies.push(request.postData() ?? '');
  });
  return bodies;
}

/** 페이지가 열리기 전에 피보호자 환경설정(localStorage)의 SOS 동작을 정해 둔다 */
export async function presetSosAction(page: Page, sosAction: SosAction) {
  await page.addInitScript(
    ({ key, value }) => {
      const current = JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, unknown>;
      localStorage.setItem(key, JSON.stringify({ ...current, sosAction: value }));
    },
    { key: WARD_SETTINGS_KEY, value: sosAction },
  );
}

export async function readSosAction(page: Page): Promise<string | undefined> {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}').sosAction, WARD_SETTINGS_KEY);
}

/** 피보호자 SOS 화면에서 긴급 SOS 를 누르고, 확인창이 뜨면 보낸다 */
export async function pressSos(page: Page) {
  await page.getByRole('button', { name: /긴급 SOS/ }).click();
  const confirm = modal(page, '긴급 SOS 전송');
  const dial = page.getByRole('dialog', { name: '119 신고 키패드' });
  await expect(confirm.or(dial).first()).toBeVisible();
  if (await confirm.isVisible()) await confirm.getByRole('button', { name: '보내기' }).click();
}

/** 사이드바의 내 이름 → 프로필 → 로그아웃 (명시적 로그아웃 경로) */
export async function logoutViaProfile(page: Page, name: string) {
  await page.getByRole('complementary', { name: /메뉴$/ }).getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('dialog').getByRole('button', { name: '로그아웃' }).click();
  await modal(page, '로그아웃 확인').getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

/** 같은 브라우저에서 로그인 화면으로 로그인한다 (클라이언트 이동이라 앞 사용자의 화면 상태가 남는지 볼 수 있다) */
export async function loginViaForm(page: Page, email: string, password = env.password) {
  relaxRateLimits();
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

/** FE 가 "이 기기 토큰은 이미 등록됨"으로 기억하는 sessionStorage 값을 페이지 로드 전에 심는다 */
export async function presetFcmRegistered(page: Page, token: string, userId: string) {
  await page.addInitScript(
    ({ token, userId }) => {
      sessionStorage.setItem('careai_fcm_token', token);
      sessionStorage.setItem('careai_fcm_registered_token', token);
      sessionStorage.setItem('careai_fcm_registered_user', userId);
    },
    { token, userId },
  );
}

export function fcmTokenCount(where: { userId?: string; token?: string }) {
  const conditions = [
    where.userId ? `user_id = ${sqlStr(where.userId)}` : null,
    where.token ? `token = ${sqlStr(where.token)}` : null,
  ].filter(Boolean);
  return Number(psql(`SELECT count(*) FROM fcm_token WHERE ${conditions.join(' AND ')};`));
}
