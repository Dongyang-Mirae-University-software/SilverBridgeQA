/**
 * 최종 QA - 인증(AUTH) P1b - 프로필 이미지 (A42 A44)
 *
 * 임시 사용자만 쓴다. 파일 서버에는 아주 작은 PNG 를 최대 2~3개 올리고, 끝나면 그 사용자가 자기 사진을 지워 정리한다.
 * A44 는 A 가 올린 진짜 파일을 두고, B(외부 주소)와 C(A 의 진짜 파일 주소)가 삭제·교체·탈퇴해도 A 의 파일이 남는지 본다.
 */
import { env } from '../../../src/env';
import { expect, test } from '../../../src/fixtures';
import { psql, sqlStr } from '../../../src/remote';
import { callBe, expectFail, signinRaw, tokensOf } from './_helpers-auth';
import { httpStatusOf, patchImage, pngLike, relaxP1bRates, TAGS_P1, TINY_PNG } from './_helpers-auth-p1b';

test.beforeEach(() => relaxP1bRates());

const MB = 1024 * 1024;

const profileImageOf = (userId: string) => psql(`SELECT coalesce(profile_image, '') FROM users WHERE id = ${sqlStr(userId)};`);

async function accessTokenOf(email: string, password: string) {
  await relaxP1bRates();
  const res = await signinRaw(email, password);
  expect(res.status, `준비 로그인 ${res.status} ${res.code}`).toBe(200);
  return tokensOf(res).access;
}

test('AUTH-A42 사진 업로드 검증: 5MB 초과, 10MB 초과, 허용 외 형식, 파일 없음', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(180_000);
  const user = await tempUser('GUARDIAN');
  const token = await accessTokenOf(user.email, user.password);

  await test.step('5MB + 1바이트: 400 FILE_TOO_LARGE', async () => {
    const res = await patchImage(token, { name: 'big.png', mimeType: 'image/png', buffer: pngLike(5 * MB + 1) });
    expectFail(res, 400, 'FILE_TOO_LARGE', '5MB+1B');
  });

  await test.step('11MB: 서버 전체 상한(10MB) 초과도 400 FILE_TOO_LARGE (413 은 약 봉투 OCR 경로만)', async () => {
    const res = await patchImage(token, { name: 'huge.png', mimeType: 'image/png', buffer: pngLike(11 * MB) });
    // 뒤 단계(형식·파일 없음)도 계속 보도록 이 단계는 soft 로 단언한다
    expect.soft(res.status, `11MB 상태 ${res.status} (${res.code ?? (res.body.includes('<html') ? '앞단 서버의 HTML 413 페이지' : '코드 없음')})`).toBe(400);
    expect.soft(res.code, '11MB 에러 코드 (BE 코드가 아니라 앞단 서버가 먼저 막으면 코드가 없다)').toBe('FILE_TOO_LARGE');
  });

  await test.step('허용 외 형식(BMP, PDF)은 400 INVALID_FILE_TYPE', async () => {
    const bmp = Buffer.concat([Buffer.from('BM'), Buffer.alloc(64)]);
    expectFail(await patchImage(token, { name: 'a.bmp', mimeType: 'image/bmp', buffer: bmp }), 400, 'INVALID_FILE_TYPE', 'BMP');
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
    expectFail(await patchImage(token, { name: 'a.pdf', mimeType: 'application/pdf', buffer: pdf }), 400, 'INVALID_FILE_TYPE', 'PDF');
    test.info().annotations.push({
      type: '문서와 다른 점',
      description: '문서는 형식 오류를 400/415 로 적었지만 배포 BE(UserService.validateImage)는 INVALID_FILE_TYPE 400 하나다. 코드 값으로 고정했다',
    });
  });

  await test.step('겉은 PNG 인데 내용이 PDF 면(내용 시그니처 불일치) 400 INVALID_FILE_TYPE', async () => {
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
    expectFail(await patchImage(token, { name: 'fake.png', mimeType: 'image/png', buffer: pdf }), 400, 'INVALID_FILE_TYPE', '위조 PNG');
  });

  await test.step('파일 없이 PATCH 는 500 이 아니라 400 FILE_REQUIRED', async () => {
    const res = await patchImage(token, null);
    expectFail(res, 400, 'FILE_REQUIRED', '파일 없음');
  });

  expect(profileImageOf(user.id), '거절된 요청으로 사진이 저장되지 않았다').toBe('');
});

test('AUTH-A44 외부 URL 은 삭제하지 않음 (남의 파일 주인 확인은 BE 백로그)', TAGS_P1, async ({ tempUser }) => {
  test.setTimeout(360_000);
  const owner = await tempUser('GUARDIAN', { name: 'E2E파일주인' });
  const other = await tempUser('GUARDIAN', { name: 'E2E외부주소' });
  const third = await tempUser('GUARDIAN', { name: 'E2E타인파일' });
  const ownerToken = await accessTokenOf(owner.email, owner.password);
  let canaryUrl = '';
  let foreignUrl = '';
  const withdrawn = new Set<string>();
  const protectedUrls: string[] = [];

  /** A 가 진짜 사진을 새로 올린다 (A 의 이전 파일은 A 자신의 교체로 지워진다). 이 파일이 지워지면 안 된다 */
  const renewCanary = async () => {
    const res = await patchImage(ownerToken, { name: 'p1b.png', mimeType: 'image/png', buffer: TINY_PNG });
    expect(res.status, `A 사진 올리기 ${res.status} ${res.code}`).toBe(200);
    canaryUrl = profileImageOf(owner.id);
    protectedUrls.push(canaryUrl);
    expect(canaryUrl, 'A 의 사진 주소가 저장됨').toMatch(/^https?:\/\//);
    expect(await httpStatusOf(canaryUrl), '준비: A 사진은 지금 열린다').toBe(200);
  };

  try {
    await test.step('준비: A 가 진짜 사진을 올린다', async () => {
      await renewCanary();
      const filename = new URL(canaryUrl).pathname.split('/').pop()!;
      // 카카오 CDN 주소(우리 파일 서버가 아님)인데 마지막 조각이 A 의 파일명이다
      foreignUrl = `https://k.kakaocdn.net/dn/e2e/${filename}`;
      protectedUrls.push(foreignUrl);
    });

    await test.step('B 의 사진이 외부 주소일 때 삭제: 200, DB 는 NULL, A 의 파일은 그대로', async () => {
      psql(`UPDATE users SET profile_image = ${sqlStr(foreignUrl)} WHERE id = ${sqlStr(other.id)};`);
      const token = await accessTokenOf(other.email, other.password);
      const res = await callBe('DELETE', '/api/user/me/image', { token });
      expect(res.status, `외부 주소 사진 삭제 ${res.status} ${res.code}`).toBe(200);
      expect(profileImageOf(other.id), 'DB 의 사진 주소는 NULL 처리').toBe('');
      expect(await httpStatusOf(canaryUrl), 'A 의 파일이 삭제되지 않았다').toBe(200);
    });

    await test.step('B 가 새 사진으로 교체(옛 주소는 외부 주소): A 의 파일은 그대로', async () => {
      psql(`UPDATE users SET profile_image = ${sqlStr(foreignUrl)} WHERE id = ${sqlStr(other.id)};`);
      const token = await accessTokenOf(other.email, other.password);
      const res = await patchImage(token, { name: 'p1b-b.png', mimeType: 'image/png', buffer: TINY_PNG });
      expect(res.status, `사진 교체 ${res.status} ${res.code}`).toBe(200);
      const now = profileImageOf(other.id);
      expect(now, '새 사진 주소로 바뀐다').not.toBe(foreignUrl);
      expect(now, '새 사진 주소는 우리 파일 서버 것').toMatch(/^https?:\/\//);
      expect(await httpStatusOf(canaryUrl), 'A 의 파일이 삭제되지 않았다').toBe(200);
      // 방금 B 가 올린 자기 파일은 자기가 지워 정리한다 (실패해도 아래 finally 가 한 번 더 시도한다)
      const del = await callBe('DELETE', '/api/user/me/image', { token });
      expect(del.status, `B 자기 사진 정리 ${del.status}`).toBe(200);
    });

    await test.step('B 가 외부 주소 사진을 단 채 탈퇴: A 의 파일은 그대로', async () => {
      psql(`UPDATE users SET profile_image = ${sqlStr(foreignUrl)} WHERE id = ${sqlStr(other.id)};`);
      const token = await accessTokenOf(other.email, other.password);
      const res = await callBe('DELETE', '/api/user/me', { token, data: { password: env.password } });
      expect(res.status, `탈퇴 ${res.status} ${res.code}`).toBe(200);
      withdrawn.add(other.id);
      expect(Number(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(other.id)};`)), 'B 계정이 삭제됨').toBe(0);
      expect(await httpStatusOf(canaryUrl), 'A 의 파일이 삭제되지 않았다').toBe(200);
    });

    // 타인 파일(USER-G03): C 의 사진 주소가 A 의 진짜 파일 주소(우리 파일 서버)일 때. 앱으로는 만들 수 없는 상태라 C 의 행만 DB 로 맞춘다.
    // 2026-11-16 결정: 문서 범위를 "외부 주소는 지우지 않는다"로 좁히고, 파일 주인 확인은 BE 백로그(audit-index AUTH-A44)로 뺐다.
    // 주인 확인이 들어가면 OWNER_CHECK_IMPLEMENTED 를 true 로 바꿔 아래 단계를 다시 켠다.
    const OWNER_CHECK_IMPLEMENTED = false;
    if (!OWNER_CHECK_IMPLEMENTED) {
      test.info().annotations.push({
        type: 'BE 백로그 (2026-11-16 결정)',
        description: '남의 진짜 파일 주소를 단 상태(DB 로만 만들 수 있음)의 삭제·교체·탈퇴는 확인하지 않는다. 배포 BE(FileServerClient.delete)는 우리 파일 서버 주소면 주인 확인 없이 파일명으로 지운다 - 주인 확인은 BE 백로그',
      });
    } else {
    await test.step('C 의 사진 주소가 A 의 파일 주소일 때 삭제: 200, C 의 DB 는 NULL, A 의 파일은 그대로', async () => {
      await renewCanary();
      psql(`UPDATE users SET profile_image = ${sqlStr(canaryUrl)} WHERE id = ${sqlStr(third.id)};`);
      const token = await accessTokenOf(third.email, third.password);
      const res = await callBe('DELETE', '/api/user/me/image', { token });
      expect.soft(res.status, `타인 파일 사진 삭제 ${res.status} ${res.code}`).toBe(200);
      expect.soft(profileImageOf(third.id), 'C 의 DB 사진 주소는 NULL 처리').toBe('');
      expect.soft(await httpStatusOf(canaryUrl), 'A 의 파일이 삭제되지 않았다 (C 가 남의 파일 주소를 달고 있었을 뿐이다)').toBe(200);
    });

    await test.step('C 의 사진 주소가 A 의 파일 주소일 때 교체: A 의 파일은 그대로', async () => {
      await renewCanary();
      psql(`UPDATE users SET profile_image = ${sqlStr(canaryUrl)} WHERE id = ${sqlStr(third.id)};`);
      const token = await accessTokenOf(third.email, third.password);
      const res = await patchImage(token, { name: 'p1b-c.png', mimeType: 'image/png', buffer: TINY_PNG });
      expect.soft(res.status, `타인 파일 사진 교체 ${res.status} ${res.code}`).toBe(200);
      expect.soft(profileImageOf(third.id), 'C 의 사진 주소는 A 의 주소가 아니다').not.toBe(canaryUrl);
      expect.soft(await httpStatusOf(canaryUrl), 'A 의 파일이 삭제되지 않았다').toBe(200);
      const del = await callBe('DELETE', '/api/user/me/image', { token });
      expect(del.status, `C 자기 사진 정리 ${del.status}`).toBe(200);
    });

    await test.step('C 의 사진 주소가 A 의 파일 주소인 채 탈퇴: A 의 파일은 그대로', async () => {
      await renewCanary();
      psql(`UPDATE users SET profile_image = ${sqlStr(canaryUrl)} WHERE id = ${sqlStr(third.id)};`);
      const token = await accessTokenOf(third.email, third.password);
      const res = await callBe('DELETE', '/api/user/me', { token, data: { password: env.password } });
      expect.soft(res.status, `탈퇴 ${res.status} ${res.code}`).toBe(200);
      withdrawn.add(third.id);
      expect.soft(Number(psql(`SELECT count(*) FROM users WHERE id = ${sqlStr(third.id)};`)), 'C 계정이 삭제됨').toBe(0);
      expect.soft(await httpStatusOf(canaryUrl), 'A 의 파일이 삭제되지 않았다').toBe(200);
    });
    }
  } finally {
    // B·C 가 올린 자기 파일이 남았으면 자기가 지운다 (이미 탈퇴했거나, 사진이 A 의 주소·외부 주소이면 건드리지 않는다)
    for (const u of [other, third]) {
      if (withdrawn.has(u.id)) continue;
      try {
        const current = profileImageOf(u.id);
        if (current && !protectedUrls.includes(current)) {
          await callBe('DELETE', '/api/user/me/image', { token: await accessTokenOf(u.email, u.password) });
        } else if (current) {
          psql(`UPDATE users SET profile_image = NULL WHERE id = ${sqlStr(u.id)};`); // 임시 사용자 자신의 행만
        }
      } catch (error) {
        console.warn('임시 사용자 사진 정리 실패', error);
      }
    }
    // A 가 자기 사진을 지워 파일 서버를 정리한다
    try {
      await callBe('DELETE', '/api/user/me/image', { token: ownerToken });
    } catch (error) {
      console.warn('A 사진 정리 실패', error);
    }
  }
});
