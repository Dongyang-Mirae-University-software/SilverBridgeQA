/**
 * 변수 QA - 사용자 (low)
 *
 * 부작용:
 *  - 임시 사용자만 쓴다 (관리자 시나리오도 임시 ADMIN). 임시 사용자의 phone 은 0100001xxxx 라 실제 발송 대상이 아니다.
 *  - SMS·이메일·알림톡 발송 API 는 부르지 않는다 (SMS 인증은 Redis 키 직접 설정 또는 page.route 모킹).
 *  - USER-G04/G07 은 파일서버에 테스트 PNG 를 올렸다가 지운다.
 *  - USER-G08 은 현재 버그가 있으면 임시 ADMIN 이 실제로 탈퇴 처리된다 (임시 계정이라 무해).
 *  - USER-G13 은 대상 임시 계정의 비밀번호를 반복 변경한다.
 */
import { randomUUID } from 'node:crypto';

import { Page, request } from '@playwright/test';

import { Api } from '../../src/api';
import { env } from '../../src/env';
import { expect, modal, test } from '../../src/fixtures';
import { psql, redis, sqlStr } from '../../src/remote';
import { relaxRateLimits, tempPhone } from '../../src/seed';

/** 1x1 투명 PNG (시그니처 검사를 통과하는 진짜 이미지) */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 조건이 참이 될 때까지 잠깐 기다린다 (참이 안 되면 마지막 값을 돌려준다) */
async function settle<T>(read: () => Promise<T> | T, done: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await sleep(500);
    value = await read();
  }
  return value;
}

/** 본인 토큰으로 프로필 이미지를 서버에 올린다 (파일서버에 실제 파일이 생긴다) */
async function uploadProfileImage(accessToken: string) {
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
  try {
    const res = await ctx.patch('/api/user/me/image', {
      multipart: { file: { name: 'e2e-low.png', mimeType: 'image/png', buffer: TINY_PNG } },
    });
    expect(res.status(), `준비: 이미지 업로드 실패 ${await res.text()}`).toBe(200);
  } finally {
    await ctx.dispose();
  }
}

/** 프로필 수정 요청 본문 (현재 값 그대로 + 덮어쓸 값) */
interface Profile {
  name: string;
  phone: string;
  gender: string;
  birthDate: string;
  postcode: string;
  address: string;
  addressDetail: string;
}

async function currentProfile(api: Api): Promise<Profile> {
  const p = await api.get<Profile>('/api/user/me');
  return {
    name: p.name,
    phone: p.phone,
    gender: p.gender,
    birthDate: p.birthDate,
    postcode: p.postcode,
    address: p.address,
    addressDetail: p.addressDetail,
  };
}

/**
 * 현재 access token 만 무효화한다 (refresh token 은 그대로 유효).
 * 비밀번호 변경 무효화 키(password:invalidate:{userId})를 지금 시각으로 쓴다.
 * 다음 초에 재발급된 토큰은 유효해야 하므로 1.5초 기다린다.
 */
async function expireAccessToken(userId: string, oldAccessToken: string) {
  redis('SET', `password:invalidate:${userId}`, String(Date.now()), 'EX', '600');
  const ctx = await request.newContext({
    baseURL: env.apiUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${oldAccessToken}` },
  });
  try {
    const res = await ctx.get('/api/user/me');
    expect(res.status(), '준비: 무효화한 access token 은 401 이어야 한다').toBe(401);
  } finally {
    await ctx.dispose();
  }
  await sleep(1_500);
}

/** 설정 화면에서 /api/auth/refresh 호출과 대상 요청의 응답 상태를 모은다 */
function watchRefresh(page: Page, targetPathEnd: string, method: string) {
  const seen = { refresh: 0, targetStatuses: [] as number[] };
  page.on('request', r => {
    if (r.url().includes('/api/auth/refresh')) seen.refresh++;
  });
  page.on('response', r => {
    if (r.request().method() === method && r.url().endsWith(targetPathEnd)) seen.targetStatuses.push(r.status());
  });
  return seen;
}

test.describe('access token 만료 후 사용자 계정 작업', () => {
  test('[USER-G04] access token 이 만료돼도 프로필 이미지 삭제·비밀번호 변경·탈퇴는 refresh 후 재시도돼 성공한다', async ({
    tempUser, loginAs, openAs,
  }) => {
    // 이 테스트는 임시 사용자 3명 + 브라우저 3개를 쓴다
    test.setTimeout(240_000);

    await test.step('프로필 모달의 이미지 삭제(x)', async () => {
      const user = await tempUser('GUARDIAN');
      const { who, login, api } = await loginAs(user);
      await uploadProfileImage(login.accessToken);
      try {
        const page = await openAs(who, '/guardian/settings');
        const sidebar = page.getByRole('complementary', { name: /메뉴$/ });
        await sidebar.getByRole('button', { name: new RegExp(user.name) }).click();
        const dialog = page.getByRole('dialog', { name: user.name });
        const del = dialog.getByRole('button', { name: '프로필 이미지 삭제' });
        await expect(del, '준비: 업로드한 프로필 이미지의 삭제 버튼이 보여야 한다').toBeVisible();

        await expireAccessToken(user.id, login.accessToken);
        const seen = watchRefresh(page, '/api/user/me/image', 'DELETE');

        await del.click();
        await modal(page, '프로필 이미지 삭제').getByRole('button', { name: '삭제' }).click();

        const image = await settle(
          () => psql(`SELECT coalesce(profile_image, '') FROM users WHERE id = ${sqlStr(user.id)};`),
          v => v === '',
          10_000,
        );
        const errorModal = modal(page, '프로필 이미지 처리 실패');
        const errorText = (await errorModal.count()) ? await errorModal.innerText() : '';
        test.info().annotations.push({
          type: '이미지 삭제',
          description: `DELETE 응답 ${seen.targetStatuses.join(',')}, refresh ${seen.refresh}회, 오류 모달: ${errorText.replace(/\s+/g, ' ')}`,
        });
        expect.soft(
          image,
          `만료된 토큰으로 이미지 삭제 시 refresh 없이 401 이 그대로 표시된다 (DELETE ${seen.targetStatuses.join(',')}, refresh ${seen.refresh}회, 모달: ${errorText.replace(/\s+/g, ' ')}). ` +
            "isUserDeleteRequest 가 url.includes('/user/me') 라 비밀번호와 무관한 '/user/me/image' 삭제까지 refresh 제외 대상이다",
        ).toBe('');
        expect.soft(seen.refresh, '이미지 삭제가 401 을 받으면 /api/auth/refresh 로 재발급해야 한다').toBeGreaterThan(0);
      } finally {
        redis('DEL', `password:invalidate:${user.id}`);
        // 파일서버 정리: 남아 있으면 새로 로그인해 삭제
        try {
          if (psql(`SELECT coalesce(profile_image, '') FROM users WHERE id = ${sqlStr(user.id)};`)) {
            const fresh = await Api.fromLogin(await Api.signinWithRetry(user.email, user.password));
            await fresh.raw('DELETE', '/api/user/me/image');
            await fresh.dispose();
          }
        } catch {
          // 정리 실패는 무시
        }
        await api.dispose().catch(() => undefined);
      }
    });

    await test.step('비밀번호 변경', async () => {
      const user = await tempUser('GUARDIAN');
      const { who, login } = await loginAs(user);
      const page = await openAs(who, '/guardian/settings');
      await page.getByRole('tab', { name: '보안' }).click();
      await expect(page.getByRole('button', { name: '변경하기' })).toBeVisible();
      await expireAccessToken(user.id, login.accessToken);
      const seen = watchRefresh(page, '/api/user/me/password', 'PUT');

      await page.getByRole('button', { name: '변경하기' }).click();
      await page.getByLabel('현재 비밀번호', { exact: true }).fill(user.password);
      await page.getByLabel('새 비밀번호', { exact: true }).fill('E2eChanged!2345');
      await page.getByLabel('새 비밀번호 확인', { exact: true }).fill('E2eChanged!2345');
      await page.getByRole('dialog', { name: '비밀번호 변경' }).getByRole('button', { name: '변경', exact: true }).click();

      const success = modal(page, '비밀번호 변경 완료');
      const failure = modal(page, '비밀번호 변경 실패');
      await expect(success.or(failure).first()).toBeVisible({ timeout: 15_000 });
      const failText = (await failure.count()) ? await failure.innerText() : '';
      test.info().annotations.push({
        type: '비밀번호 변경',
        description: `PUT 응답 ${seen.targetStatuses.join(',')}, refresh ${seen.refresh}회, ${failText.replace(/\s+/g, ' ')}`,
      });
      expect.soft(
        await success.count(),
        `만료된 토큰으로 비밀번호를 바꾸면 refresh 없이 실패한다 (PUT ${seen.targetStatuses.join(',')}, refresh ${seen.refresh}회, 모달: ${failText.replace(/\s+/g, ' ')})`,
      ).toBe(1);
    });

    await test.step('회원 탈퇴', async () => {
      const user = await tempUser('GUARDIAN');
      const { who, login } = await loginAs(user);
      const page = await openAs(who, '/guardian/settings');
      await page.getByRole('tab', { name: '보안' }).click();
      await expect(page.getByRole('button', { name: '회원 탈퇴' })).toBeVisible();
      await expireAccessToken(user.id, login.accessToken);
      const seen = watchRefresh(page, '/api/user/me', 'DELETE');

      await page.getByRole('button', { name: '회원 탈퇴' }).click();
      await page.getByRole('button', { name: '계속하기' }).click();
      await page.getByPlaceholder('비밀번호', { exact: true }).fill(user.password);
      await page.getByRole('button', { name: '탈퇴하기' }).click();

      const left = await settle(
        () => psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(user.id)};`),
        v => v === '0',
        12_000,
      );
      const errorText = (await page.locator('p').filter({ hasText: /세션|로그인/ }).allInnerTexts()).join(' / ');
      test.info().annotations.push({
        type: '탈퇴',
        description: `DELETE 응답 ${seen.targetStatuses.join(',')}, refresh ${seen.refresh}회, 화면 문구: ${errorText}`,
      });
      expect.soft(
        left,
        `만료된 토큰으로 탈퇴하면 refresh 없이 실패하고 세션도 그대로다 (DELETE ${seen.targetStatuses.join(',')}, refresh ${seen.refresh}회, 문구: ${errorText})`,
      ).toBe('0');
    });
  });
});

test.describe('프로필 이미지 업로드', () => {
  test('[USER-G07] 업로드가 10초 넘게 걸려도 성공을 성공으로 보여 준다 (알 수 없는 오류 모달이 뜨지 않는다)', async ({
    tempUser, loginAs, openAs,
  }) => {
    test.setTimeout(120_000);
    const user = await tempUser('GUARDIAN');
    const { who, api } = await loginAs(user);
    const page = await openAs(who, null);

    // BE 는 곧바로 처리하되 응답만 11초 늦게 돌려준다 (느린 망/파일서버 지연). 브라우저 axios 는 10초에 끊는다
    await page.route('**/api/user/me/image', async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      try {
        const response = await route.fetch();
        await sleep(11_000);
        await route.fulfill({ response });
      } catch {
        // 브라우저가 먼저 요청을 끊은 경우
      }
    });

    try {
      await page.goto('/guardian/settings');
      const sidebar = page.getByRole('complementary', { name: /메뉴$/ });
      await sidebar.getByRole('button', { name: new RegExp(user.name) }).click();
      const dialog = page.getByRole('dialog', { name: user.name });
      await expect(dialog).toBeVisible();

      await dialog.locator('input[type="file"]').setInputFiles({ name: 'e2e-slow.png', mimeType: 'image/png', buffer: TINY_PNG });

      const failed = modal(page, '프로필 이미지 처리 실패');
      const deleteButton = dialog.getByRole('button', { name: '프로필 이미지 삭제' });
      await expect(failed.or(deleteButton).first()).toBeVisible({ timeout: 40_000 });

      const message = (await failed.count()) ? (await failed.innerText()).replace(/\s+/g, ' ') : '';
      const stored = psql(`SELECT coalesce(profile_image, '') FROM users WHERE id = ${sqlStr(user.id)};`);
      test.info().annotations.push({ type: '업로드 결과', description: `오류 모달: ${message || '없음'} / DB 이미지: ${stored ? '변경됨' : '없음'}` });
      expect(
        message,
        `10초를 넘긴 업로드에서 FE axios 타임아웃(10s)이 먼저 끊어 실패 모달이 뜬다 - 그런데 BE 는 이미 프로필 이미지를 바꿨다 (DB 이미지 ${stored ? '변경됨' : '없음'}). ` +
          '업로드에는 더 긴 타임아웃을 쓰거나 타임아웃 시 프로필을 재조회해야 한다',
      ).toBe('');
    } finally {
      await api.raw('DELETE', '/api/user/me/image').catch(() => undefined);
    }
  });
});

test.describe('관리자 자기 탈퇴', () => {
  test('[USER-G08] 관리자 계정은 DELETE /api/user/me 로 스스로 탈퇴할 수 없다 (403)', async ({ tempUser, loginAs }) => {
    // 주의: 버그가 있으면 이 임시 ADMIN 이 실제로 삭제된다 (테스트 전용 계정)
    const admin = await tempUser('ADMIN');
    const { api } = await loginAs(admin);

    const res = await api.raw('DELETE', '/api/user/me', { password: admin.password });
    const body = await res.text();
    const exists = psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(admin.id)};`);
    test.info().annotations.push({ type: '관리자 탈퇴 응답', description: `${res.status()} ${body.slice(0, 200)} / users 행 ${exists}개` });

    expect(
      res.status(),
      `ADMIN 이 공통 계정 API 로 자기 자신을 탈퇴시킬 수 있다 (응답 ${res.status()}, users 행 ${exists}개 남음). 마지막 관리자가 사라지면 운영이 잠긴다`,
    ).toBe(403);
    expect(exists, '거절됐다면 관리자 계정은 남아 있어야 한다').toBe('1');
  });
});

test.describe('요청 검증 (알림 설정·이미지·이름)', () => {
  test('[USER-G09] 알림 설정 PUT 의 settings 배열에 null 원소가 있으면 500 이 아니라 400 이다', async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const before = JSON.stringify(await api.get('/api/user/me/notification-settings'));

    const onlyNull = await api.raw('PUT', '/api/user/me/notification-settings', { settings: [null] });
    const onlyNullText = await onlyNull.text();
    const mixed = await api.raw('PUT', '/api/user/me/notification-settings', {
      settings: [{ channelType: 'EMAIL', enabled: true }, null],
    });
    const mixedText = await mixed.text();
    test.info().annotations.push({
      type: 'null 원소 응답',
      description: `[null] -> ${onlyNull.status()} ${onlyNullText.slice(0, 120)} / [EMAIL,null] -> ${mixed.status()} ${mixedText.slice(0, 120)}`,
    });

    expect.soft(onlyNull.status(), `settings:[null] 에 NPE 로 ${onlyNull.status()} 응답 (기대 400): ${onlyNullText.slice(0, 150)}`).toBe(400);
    expect.soft(mixed.status(), `settings:[EMAIL, null] 에 ${mixed.status()} 응답 (기대 400): ${mixedText.slice(0, 150)}`).toBe(400);
    expect(JSON.stringify(await api.get('/api/user/me/notification-settings')), '거절된 요청은 설정을 바꾸지 않는다').toBe(before);
  });

  test('[USER-G10] 프로필 이미지 업로드에서 file 파트가 없으면 500 이 아니라 400 이다', async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { login } = await loginAs(user);
    const ctx = await request.newContext({
      baseURL: env.apiUrl,
      extraHTTPHeaders: { Authorization: `Bearer ${login.accessToken}` },
    });
    try {
      // file 이 아닌 다른 이름의 파트만 보낸다 (파일서버 호출 전에 실패해야 한다)
      const wrongName = await ctx.patch('/api/user/me/image', {
        multipart: { photo: { name: 'e2e.png', mimeType: 'image/png', buffer: TINY_PNG } },
      });
      const wrongNameText = await wrongName.text();
      // file 을 파일이 아닌 문자열 필드로 보낸다
      const asString = await ctx.patch('/api/user/me/image', { multipart: { file: 'not-a-file' } });
      const asStringText = await asString.text();
      test.info().annotations.push({
        type: 'file 누락 응답',
        description: `photo 파트 -> ${wrongName.status()} ${wrongNameText.slice(0, 120)} / file 문자열 -> ${asString.status()} ${asStringText.slice(0, 120)}`,
      });

      expect.soft(wrongName.status(), `file 파트 없이 요청하면 ${wrongName.status()} (기대 400): ${wrongNameText.slice(0, 150)}`).toBe(400);
      expect.soft(asString.status(), `file 을 문자열로 보내면 ${asString.status()} (기대 400): ${asStringText.slice(0, 150)}`).toBe(400);
    } finally {
      await ctx.dispose();
    }
  });

  test('[USER-G14] 제로폭 문자·전각 공백만으로 된 이름은 저장되지 않는다 (400)', async ({ tempUser, loginAs }) => {
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);
    const base = await currentProfile(api);

    const cases: { label: string; name: string }[] = [
      { label: '제로폭 공백(U+200B)', name: '​' },
      { label: '전각 공백(U+3000)', name: '　　' },
    ];
    const results: string[] = [];
    for (const c of cases) {
      const res = await api.raw('PUT', '/api/user/me', { ...base, name: c.name });
      const stored = (await currentProfile(api)).name;
      results.push(`${c.label} -> ${res.status()} (저장된 이름 코드포인트: ${[...stored].map(ch => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase()).join(',')})`);
      expect.soft(
        res.status(),
        `${c.label} 만으로 된 이름이 ${res.status()} 로 통과해 보이지 않는 이름이 저장됐다 (저장된 값 길이 ${stored.length})`,
      ).toBe(400);
      // 다음 케이스가 독립적이도록 원래 이름으로 되돌린다
      await api.raw('PUT', '/api/user/me', base);
    }
    test.info().annotations.push({ type: '이름 검증', description: results.join(' / ') });
  });
});

test.describe('전화번호 변경 nonce', () => {
  test('[USER-G11] 이미 사용 중인 번호로 저장이 409 로 막혀도 SMS 인증 nonce 는 소비되지 않고 남는다', async ({ tempUser, loginAs }) => {
    const a = await tempUser('GUARDIAN');
    const b = await tempUser('GUARDIAN');
    const { api } = await loginAs(a);
    const base = await currentProfile(api);
    const nonce = 'nonce-e2e-' + randomUUID().slice(0, 8);
    const key = `sms:verified:${b.phone}`;

    redis('SET', key, nonce, 'EX', '600');
    try {
      const res = await api.raw('PUT', '/api/user/me', { ...base, phone: b.phone, verificationNonce: nonce });
      const body = await res.text();
      expect(res.status(), `준비: 이미 사용 중인 번호로 바꾸면 409 여야 한다: ${body.slice(0, 150)}`).toBe(409);

      const left = redis('GET', key);
      test.info().annotations.push({ type: 'nonce 잔존', description: `409 후 Redis ${key} = ${left || '(nil)'}` });
      expect(
        left,
        '중복 번호 409 응답 전에 nonce 가 이미 소비(삭제)됐다. 가입 경로처럼 검증을 다 마친 뒤 마지막에 소비해야 재시도 때 SMS 를 다시 받지 않는다',
      ).toBe(nonce);
    } finally {
      redis('DEL', key);
    }
  });

  test('[USER-G15] 인증이 만료된 채 저장이 거절되면 화면이 "인증 필요"로 돌아가 재인증을 안내한다', async ({ tempUser, loginAs, openAs }) => {
    const user = await tempUser('GUARDIAN');
    const { who } = await loginAs(user);
    const page = await openAs(who, null);

    const newPhone = tempPhone();
    const nonce = randomUUID();
    redis('SET', `sms:verified:${newPhone}`, nonce, 'EX', '600');
    // 실제 SMS 는 보내지 않고 응답만 가짜로 준다
    await page.route('**/api/auth/signup/sms/send', route =>
      route.fulfill({ json: { success: true, message: '[E2E] 발송 생략', data: { expiresInSeconds: 300 } } }),
    );
    await page.route('**/api/auth/signup/sms/verify', route =>
      route.fulfill({ json: { success: true, data: { verificationNonce: nonce } } }),
    );

    try {
      await page.goto('/guardian/settings');
      const sidebar = page.getByRole('complementary', { name: /메뉴$/ });
      await sidebar.getByRole('button', { name: new RegExp(user.name) }).click();
      const dialog = page.getByRole('dialog', { name: user.name });
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: '정보 수정' }).click();
      await dialog.locator('input[inputmode="numeric"]').first().fill(newPhone);
      await dialog.getByRole('button', { name: '인증번호 발송' }).click();
      await dialog.getByPlaceholder('인증번호').fill('123456');
      await dialog.getByRole('button', { name: '인증 확인' }).click();
      await expect(dialog.getByText('전화번호 인증이 완료되었습니다.')).toBeVisible();
      await expect(dialog.getByText('인증 완료', { exact: true }).first(), '준비: 인증 완료 상태여야 한다').toBeVisible();

      // 10분 만료를 Redis 키 삭제로 모사한다
      redis('DEL', `sms:verified:${newPhone}`);

      await dialog.getByRole('button', { name: '프로필 저장' }).click();
      const banner = dialog.getByText('전화번호 인증을 먼저 완료해주세요.');
      const expiredNotice = dialog.getByText(/인증이 만료되었습니다/);
      await expect(banner.or(expiredNotice).first(), '저장 실패 안내가 어떤 형태로든 떠야 한다').toBeVisible({ timeout: 10_000 });

      const stateLabel = (await dialog.locator('span').filter({ hasText: /^(인증 완료|인증 필요)$/ }).first().innerText()).trim();
      const confirmLabel = (await dialog.getByPlaceholder('인증번호').locator('xpath=following-sibling::button').innerText()).trim();
      test.info().annotations.push({ type: '만료 후 화면', description: `상태 라벨 "${stateLabel}", 확인 버튼 "${confirmLabel}"` });

      expect.soft(stateLabel, `인증이 만료돼 저장이 거절됐는데 인증 패널은 여전히 "${stateLabel}" 상태다 (phoneNonce 가 안 지워짐)`).toBe('인증 필요');
      expect.soft(confirmLabel, `확인 버튼 라벨이 "${confirmLabel}" 로 남아 재인증이 필요하다는 신호가 없다`).toBe('인증 확인');
      await expect
        .soft(dialog.getByText('인증이 만료되었습니다. 인증번호를 다시 받아주세요.'), '만료 안내 문구가 없다')
        .toBeVisible({ timeout: 3_000 });
    } finally {
      redis('DEL', `sms:verified:${newPhone}`);
    }
  });
});

test.describe('알림 설정 동시 저장 · 토큰 무효화 경계', () => {
  test('[USER-G12] 알림 설정 첫 저장이 동시에 여러 번 와도 409 없이 모두 성공한다', async ({ tempUser, loginAs }) => {
    test.setTimeout(240_000);
    const user = await tempUser('GUARDIAN');
    const { api } = await loginAs(user);

    const rounds = 25;
    const parallel = 3;
    const conflicts: string[] = [];
    let ran = 0;
    for (let i = 0; i < rounds && conflicts.length === 0; i++) {
      // 매 회 EMAIL 행이 없는 "첫 저장" 상태로 만든다 (EMAIL 채널은 발송되지 않는다)
      psql(`DELETE FROM user_notification_setting WHERE user_id = ${sqlStr(user.id)} AND channel_type = 'EMAIL';`);
      const results = await Promise.all(
        Array.from({ length: parallel }, () =>
          api.raw('PUT', '/api/user/me/notification-settings', { settings: [{ channelType: 'EMAIL', enabled: true }] }),
        ),
      );
      ran++;
      for (const r of results) {
        if (r.status() >= 400) conflicts.push(`${r.status()} ${(await r.text()).slice(0, 120)}`);
      }
    }
    test.info().annotations.push({ type: '동시 저장', description: `${ran}회 x ${parallel}건 동시 요청, 실패 ${conflicts.length}건: ${conflicts[0] ?? '없음'}` });
    expect(
      conflicts,
      `같은 채널 첫 저장이 동시에 오면 check-then-insert 경합으로 유니크 위반 409 가 나온다 (${ran}회째): ${conflicts[0]}. 업서트/충돌 시 재조회로 멱등 처리해야 한다`,
    ).toEqual([]);
  });

  test('[USER-G13] 비밀번호 변경 직후(같은 초) 새 비밀번호로 받은 토큰도 401 이 아니라 정상이다', async ({ tempUser, loginAs }) => {
    test.setTimeout(300_000);
    const user = await tempUser('GUARDIAN');
    const { api: first } = await loginAs(user);
    const passwords = [user.password, 'E2eChanged!2345', 'E2eChanged!6789'];
    const rounds = 12;

    let token = first.login.accessToken;
    let current = user.password;
    let unauthorized = 0;
    let ok = 0;
    const log: string[] = [];
    await first.dispose();

    for (let i = 0; i < rounds; i++) {
      // 앞 회차에서 방금 받은 토큰이 거부됐다면, 다음 초가 된 뒤 정상 로그인으로 유효한 토큰을 다시 받는다
      if (!token) {
        await sleep(1_300);
        token = (await Api.signinWithRetry(user.email, current)).accessToken;
      }
      const next = passwords[(passwords.indexOf(current) + 1) % passwords.length];
      const changer = await Api.fromLogin({ accessToken: token, refreshToken: '', userId: user.id, role: 'GUARDIAN' });
      const change = await changer.raw('PUT', '/api/user/me/password', { currentPassword: current, newPassword: next });
      await changer.dispose();
      if (change.status() !== 200) {
        log.push(`#${i} 비밀번호 변경 ${change.status()} ${(await change.text()).slice(0, 80)}`);
        token = '';
        continue;
      }
      current = next;

      // 지연 없이 곧바로 새 비밀번호로 로그인하고 받은 토큰으로 내 정보를 조회한다
      const fresh = await Api.signinWithRetry(user.email, current);
      const me = await Api.fromLogin(fresh);
      const status = (await me.raw('GET', '/api/user/me')).status();
      await me.dispose();
      if (status === 401) {
        unauthorized++;
        token = '';
      } else {
        ok++;
        token = fresh.accessToken;
      }
      log.push(`#${i} ${status}`);
    }
    relaxRateLimits();
    test.info().annotations.push({ type: '재로그인 결과', description: `${rounds}회 중 401 ${unauthorized}회, 정상 ${ok}회 (${log.join(', ')})` });
    expect(
      unauthorized,
      `비밀번호 변경 직후 새로 받은 토큰이 ${rounds}회 중 ${unauthorized}회 401 이다. 무효화 시각(ms)과 토큰 iat(초 절삭)를 <= 로 비교해 같은 초에 발급된 새 토큰까지 무효 처리된다`,
    ).toBe(0);
  });
});
