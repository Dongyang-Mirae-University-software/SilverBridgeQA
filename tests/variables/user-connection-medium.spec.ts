/**
 * 변수 QA - 사용자·연결 (medium)
 *
 * 부작용:
 *  - 임시 사용자만 쓴다 (관리자도 임시 ADMIN). 임시 사용자에게는 FCM 토큰이 없어 실제 푸시는 나가지 않는다.
 *  - CONN-G01/02/07 은 관리자 강제 연결 API 를 임시 사용자 쌍에만 호출한다 (감사 로그 행이 남는다).
 *  - USER-G03 은 파일서버에 테스트 PNG 1개를 올렸다가 지운다.
 *  - SMS·이메일·알림톡 발송 API 는 부르지 않는다.
 */
import { Page, request } from '@playwright/test';

import { Api, LoginResult } from '../../src/api';
import { env } from '../../src/env';
import { expect, test, waitForRealtime } from '../../src/fixtures';
import { psql, sqlStr } from '../../src/remote';
import { TempUser } from '../../src/seed';
import { fcmTokenCount } from '../../src/variables';

/** 1x1 투명 PNG (시그니처 검사를 통과하는 진짜 이미지) */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** 화면의 실시간/푸시 토스트 영역 전체 텍스트 */
async function liveText(page: Page) {
  return (await page.locator('[aria-live="polite"]').allInnerTexts()).join(' | ');
}

/** 연결 카드 (카드 안에도 li 가 있어서 data-role 로 카드만 고른다) */
function card(page: Page, partnerName: string) {
  return page.locator('li[data-role]').filter({ hasText: partnerName });
}

type TempUserFactory = (role: TempUser['role'], options?: { name?: string }) => Promise<TempUser>;
type LoginFn = (user: TempUser) => Promise<{ api: Api; login: LoginResult }>;

/** 관리자 API 클라이언트 (임시 ADMIN 계정) */
async function adminApi(tempUser: TempUserFactory, loginAs: LoginFn) {
  const admin = await tempUser('ADMIN');
  return (await loginAs(admin)).api;
}

/** 잠깐 기다리며 조건이 참이 될 때까지 본다 (참이 안 되면 마지막 값을 돌려준다) */
async function settle<T>(read: () => Promise<T>, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 500));
    value = await read();
  }
  return value;
}

test.describe('비밀번호 변경·탈퇴 (사용자)', () => {
  test('[USER-G02] 비밀번호를 바꾸면 다른 기기에 등록된 푸시(FCM) 토큰도 함께 지워진다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api } = await loginAs(guardian);
    // 공격자 기기에서 등록된 가짜 토큰 (가짜라 실제 발송 시 지워질 수 있으므로 발송 전에 DB 잔존 여부만 본다)
    const attackerToken = `e2e-fake-fcm-attacker-${guardian.id}-${Date.now().toString(36)}`;
    await api.post('/api/notifications/fcm-token', { token: attackerToken, platform: 'WEB' });
    expect(fcmTokenCount({ token: attackerToken }), '준비: 가짜 기기 토큰이 등록돼야 한다').toBe(1);

    await api.call('PUT', '/api/user/me/password', {
      currentPassword: guardian.password,
      newPassword: 'E2eChanged!2345',
    });

    // 비밀번호 변경 리스너(AFTER_COMMIT)가 끝나면 옛 access token 이 401 이 된다 -> 그때 토큰 잔존을 본다
    const after = await settle(async () => (await api.raw('GET', '/api/user/me')).status(), status => status === 401, 10_000);
    expect(after, '준비: 비밀번호 변경 뒤 옛 access token 은 무효화돼야 한다').toBe(401);

    const remaining = await settle(async () => fcmTokenCount({ token: attackerToken }), count => count === 0, 5_000);
    expect(
      remaining,
      '"전 기기 로그아웃"이라는 비밀번호 변경 뒤에도 다른 기기의 FCM 토큰이 남아, 탈취자가 SOS·이상감지 푸시를 계속 받는다 (PasswordChangedEvent 리스너가 FCM 토큰을 지우지 않음)',
    ).toBe(0);
  });

  test('[USER-G03] 프로필 이미지 삭제는 우리 파일서버 URL 일 때만 파일을 지운다 (다른 사용자의 파일은 지워지지 않는다)', async ({ tempUser, loginAs }) => {
    const owner = await tempUser('WARD');
    const attacker = await tempUser('GUARDIAN');
    const [o, a] = [await loginAs(owner), await loginAs(attacker)];

    const ctx = await request.newContext({
      baseURL: env.apiUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${o.login.accessToken}` },
    });
    try {
      // 피해자(owner)가 프로필 이미지를 올린다
      const upload = await ctx.patch('/api/user/me/image', {
        multipart: { file: { name: 'e2e-victim.png', mimeType: 'image/png', buffer: TINY_PNG } },
      });
      expect(upload.status(), `준비: 이미지 업로드 실패 ${await upload.text()}`).toBe(200);
      const imageUrl = ((await upload.json()) as { data: { profileImage: string } }).data.profileImage;
      expect(imageUrl, '준비: 업로드된 이미지 URL').toBeTruthy();

      const fetcher = await request.newContext();
      try {
        const before = await fetcher.get(imageUrl);
        expect(before.status(), `준비: 업로드한 이미지가 조회돼야 한다 (${imageUrl})`).toBe(200);

        // 공격자: 카카오 가입 profileImageUrl 로 임의 호스트 + 피해자 파일명을 저장한 상태를 DB 로 만든다
        const filename = imageUrl.substring(imageUrl.lastIndexOf('/') + 1);
        psql(`UPDATE users SET profile_image = ${sqlStr(`https://example.invalid/any/${filename}`)} WHERE id = ${sqlStr(attacker.id)};`);

        const del = await a.api.raw('DELETE', '/api/user/me/image');
        expect(del.status(), `공격자 본인 이미지 삭제 요청: ${await del.text()}`).toBe(200);

        // 파일서버 삭제는 커밋 후 동기로 나가지만 여유를 둔다
        const status = await settle(async () => (await fetcher.get(imageUrl)).status(), s => s !== 200, 5_000);
        expect(
          status,
          `외부 호스트 URL 의 마지막 경로명만 떼어 파일서버에 삭제를 보내, 다른 사용자(${owner.id})의 프로필 이미지가 지워졌다 (${imageUrl} -> ${status})`,
        ).toBe(200);
      } finally {
        await fetcher.dispose();
      }
    } finally {
      // 정리: 피해자 이미지 삭제 (이미 지워졌어도 무해)
      await ctx.delete('/api/user/me/image').catch(() => undefined);
      await ctx.dispose();
    }
  });

  test('[USER-G05] 현재 비밀번호를 계속 틀리면 비밀번호 변경·탈퇴 확인이 일정 횟수 뒤 429/잠금으로 막힌다', async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const attempts = 20;

    await test.step('비밀번호 변경: 틀린 현재 비밀번호로 연속 시도', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < attempts; i++) {
        const res = await api.raw('PUT', '/api/user/me/password', {
          currentPassword: `Wrong!Pass${i}xx`,
          newPassword: 'E2eChanged!2345',
        });
        statuses.push(res.status());
      }
      test.info().annotations.push({ type: '비밀번호 변경 응답', description: statuses.join(',') });
      expect(
        statuses.some(s => s === 429 || s === 423),
        `틀린 비밀번호를 ${attempts}회 대입해도 제한 없이 계속 ${[...new Set(statuses)].join('/')} 만 응답한다 (로그인의 5회 잠금을 우회한 대입 가능)`,
      ).toBe(true);
    });

    await test.step('회원 탈퇴 확인: 틀린 비밀번호로만 연속 시도 (성공 호출 없음)', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < attempts; i++) {
        const res = await api.raw('DELETE', '/api/user/me', { password: `Wrong!Pass${i}xx` });
        statuses.push(res.status());
      }
      test.info().annotations.push({ type: '탈퇴 확인 응답', description: statuses.join(',') });
      expect.soft(
        statuses.some(s => s === 429 || s === 423),
        `탈퇴 확인의 비밀번호도 ${attempts}회 대입에 제한이 없다 (${[...new Set(statuses)].join('/')})`,
      ).toBe(true);
    });
  });
});

test.describe('관리자 강제 연결·해제', () => {
  test('[CONN-G01] 강제 연결하면 보호자 화면에 "피보호자가 수락했다"는 거짓 안내 없이 관리자가 연결했다고 한 번만 알린다', async ({
    tempUser, loginAs, openAs,
  }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const admin = await adminApi(tempUser, loginAs);
    const { who } = await loginAs(guardian);

    const page = await openAs(who, '/guardian/wards');
    await waitForRealtime(page);

    await admin.post('/api/admin/connection', { guardianId: guardian.id, wardId: ward.id });

    // 실시간 알림이 도착할 때까지 (제목/본문 어느 쪽이든 연결 관련 문구)
    const text = await settle(() => liveText(page), t => /연결/.test(t), 15_000);
    await page.waitForTimeout(1_500);
    const finalText = await liveText(page);
    test.info().annotations.push({ type: '보호자 토스트', description: finalText || text });

    expect(finalText, '강제 연결 알림이 보호자 화면에 전혀 뜨지 않았다').toMatch(/연결/);
    expect(
      finalText,
      `피보호자가 수락한 적이 없는 강제 연결인데 "수락했습니다" 안내가 뜬다 (WS 가 connection-accepted 를 재사용): ${finalText}`,
    ).not.toMatch(/수락/);
    expect.soft(finalText, `관리자가 연결했다는 안내가 없다: ${finalText}`).toMatch(/관리자/);
  });

  test('[CONN-G02] 강제 연결되면 화면을 보고 있는 피보호자에게 실시간으로 반영·안내된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN', { name: 'E2E강제보호자' });
    const ward = await tempUser('WARD');
    const admin = await adminApi(tempUser, loginAs);
    const { who } = await loginAs(ward);

    const page = await openAs(who, '/ward/guardians');
    await waitForRealtime(page);
    await page.getByRole('tab', { name: '내 보호자 리스트' }).click();
    await expect(page.getByText('연결된 보호자가 없습니다.')).toBeVisible();

    await admin.post('/api/admin/connection', { guardianId: guardian.id, wardId: ward.id });

    // 화면을 새로고침하거나 포커스를 옮기지 않은 채로 반영을 기다린다 (창 포커스 재조회는 헤드리스에서 일어나지 않는다)
    const shown = await settle(async () => await card(page, guardian.name).count(), count => count > 0, 20_000);
    const toastText = await liveText(page);
    test.info().annotations.push({ type: '피보호자 토스트', description: toastText });

    expect(
      shown,
      '피보호자 FE 는 WS connection-accepted 를 구독하지 않아, 강제 연결된 보호자가 목록에 실시간으로 나타나지 않는다',
    ).toBeGreaterThan(0);
    expect.soft(toastText, `피보호자에게 "관리자가 보호자로 연결했다"는 안내가 없다: ${toastText}`).toMatch(/관리자/);
  });

  test('[CONN-G07] 관리자 회원 상세의 연결 항목에 강제 해제에 쓸 connectionId 가 들어 있다', async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const admin = await adminApi(tempUser, loginAs);
    await admin.post('/api/admin/connection', { guardianId: guardian.id, wardId: ward.id });

    const detail = await admin.get<{ connections: Record<string, unknown>[] }>(`/api/admin/user/${guardian.id}`);
    expect(detail.connections, '준비: 강제 연결한 보호자의 연결 목록').toHaveLength(1);
    const item = detail.connections[0];
    test.info().annotations.push({ type: '연결 항목 필드', description: Object.keys(item).join(', ') });

    const id = item.connectionId ?? item.id;
    expect(
      id,
      `연결 항목에 connectionId 가 없어 DELETE /api/admin/connection/{connectionId} 를 쓸 수 없다 (필드: ${Object.keys(item).join(', ')})`,
    ).toBeTruthy();
  });
});

test.describe('연결 요청 알림 (피보호자)', () => {
  test('[CONN-G03] 피보호자에게 뜨는 연결 요청 토스트에 요청한 보호자의 이름이나 관계가 보인다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN', { name: 'E2E요청보호자' });
    const ward = await tempUser('WARD');
    const g = await loginAs(guardian);
    const { who } = await loginAs(ward);

    const page = await openAs(who, '/ward');
    await waitForRealtime(page);

    await g.api.post('/api/guardian/connection/request', { targetId: ward.id, relation: '딸' });

    const text = await settle(() => liveText(page), t => /연결 요청/.test(t), 15_000);
    test.info().annotations.push({ type: '피보호자 토스트', description: text });
    expect(text, '연결 요청 토스트가 뜨지 않았다').toMatch(/연결 요청/);
    // FCM 상세(이름·관계)는 같은 dedupe 키라 WS 토스트에 막혀 뜨지 않는다
    await page.waitForTimeout(1_500);
    const finalText = await liveText(page);
    expect(
      finalText,
      `수락 버튼이 있는 토스트에 누가 보낸 요청인지(${guardian.name} / 딸)가 없다: ${finalText}`,
    ).toMatch(new RegExp(`${guardian.name}|딸`));
  });
});
