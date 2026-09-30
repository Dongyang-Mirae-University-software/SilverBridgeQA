/**
 * 변수 QA - FE UX (low, b)
 *
 * 부작용 차단
 * - 모든 사용자는 임시 사용자이고, 임시 sos_event 는 사용자 삭제 때 함께 지워진다 (알림 발송 경로와 무관한 FE 조회만 한다).
 * - SOS 화면은 확인 모달을 열기만 하고 "보내기"는 누르지 않으며, 열기 전에 알림 쿨다운 키를 넣는다.
 * - 병원 예약은 예약 서비스 API 를 전부 page.route 로 가로채고 예약 생성 요청은 브라우저에서 끊는다.
 * - 카카오 가입 API 는 존재하지 않는 인증 nonce 로 호출해 사용자가 만들어지지 않게 한다.
 * - 푸시 토큰은 가짜 값이라 실제 푸시가 나가지 않는다.
 */
import { Page } from '@playwright/test';

import { contextDefaults } from '../../src/browser';
import { env } from '../../src/env';
import { expect, modal, nav, test } from '../../src/fixtures';
import { psql, sqlStr } from '../../src/remote';
import { tokenCookies } from '../../src/session';
import {
  connect,
  fcmTokenCount,
  presetFcmRegistered,
  suppressSosNotify,
  WARD_SETTINGS_KEY,
} from '../../src/variables';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** 화면 우측 사이드바 (역할 가드를 통과해 레이아웃이 그려졌다는 표시) */
function sidebar(page: Page) {
  return page.getByRole('complementary', { name: /메뉴$/ });
}

/** 사이드바의 내 이름 → 프로필 → 로그아웃 → 확인 모달까지 연다 (확인은 누르지 않는다) */
async function openLogoutConfirm(page: Page, name: string) {
  await sidebar(page).getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('dialog').getByRole('button', { name: '로그아웃' }).click();
  const confirm = modal(page, '로그아웃 확인');
  await expect(confirm).toBeVisible();
  return confirm;
}

// ---------------------------------------------------------------------------------------------
// G28 - 로그아웃 실패
// ---------------------------------------------------------------------------------------------

test.describe('로그아웃 실패', () => {
  test('[FEUX-G28] 서버 로그아웃이 실패하면 안내를 보여 주고, 이 기기의 푸시 토큰은 로그아웃이 성공하기 전에는 지우지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { api, who } = await loginAs(guardian);
    const token = `e2e-fake-fcm-${guardian.id}-${Date.now().toString(36)}`;
    await api.post('/api/notifications/fcm-token', { token, platform: 'WEB' });
    expect(fcmTokenCount({ token }), '준비: 서버에 이 기기 토큰이 있어야 한다').toBe(1);

    const page = await openAs(who, null);
    await presetFcmRegistered(page, token, guardian.id);
    const tokenDeletes: string[] = [];
    page.on('request', request => {
      if (request.method() === 'DELETE' && request.url().includes('/notifications/fcm-token')) tokenDeletes.push(request.url());
    });
    // 오프라인/장애 상황: 서버 로그아웃 호출만 실패시킨다
    await page.route('**/api/auth/logout', route => route.abort('failed'));

    await page.goto('/guardian');
    await expect(sidebar(page)).toBeVisible();
    const confirm = await openLogoutConfirm(page, guardian.name);

    const feedback = /실패|오류|다시 시도|네트워크|연결을 확인/;
    const before = await page.locator('body').innerText();
    await confirm.getByRole('button', { name: '로그아웃', exact: true }).click();
    await sleep(4_000);
    const after = await page.locator('body').innerText();

    const remaining = fcmTokenCount({ token });
    test.info().annotations.push({
      type: '실측',
      description: `로그아웃 실패 뒤 URL ${new URL(page.url()).pathname}, 토큰 삭제 요청 ${tokenDeletes.length}건, 서버 토큰 ${remaining}개, 안내 문구 ${feedback.test(after) ? '있음' : '없음'}`,
    });

    expect.soft(feedback.test(before), '준비: 실패 전에는 오류 문구가 없어야 한다').toBe(false);
    expect.soft(after, '서버 로그아웃이 실패했는데 화면에 아무 안내(실패·다시 시도)도 뜨지 않는다 (mutation 에 onError 없음)').toMatch(feedback);
    expect
      .soft(remaining, '로그아웃이 실패해 아직 로그인 상태인데 이 기기의 푸시 토큰만 먼저 삭제됐다 (FCM 삭제가 서버 로그아웃보다 먼저 수행됨)')
      .toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// G29 - 보호자 SOS 이력 화면
// ---------------------------------------------------------------------------------------------

test.describe('보호자 SOS 이력 화면', () => {
  test('[FEUX-G29] SOS 이력은 50건을 넘어도 카운트가 서로 맞고, 연결 목록을 불러오는 중이거나 실패해도 "연결된 피보호자가 없습니다" 를 띄우지 않는다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    // 60건: 최신 50건(한 페이지)에는 SOS 버튼 42 + 직접 전화 8, 전체로는 SOS 버튼 50 + 직접 전화 10
    psql(`INSERT INTO sos_event (ward_id, location, trigger_type, created_at)
          SELECT ${sqlStr(ward.id)}, NULL, CASE WHEN g % 6 = 0 THEN 'GUARDIAN_CALL' ELSE 'SOS_BUTTON' END, now() - (g || ' minutes')::interval
          FROM generate_series(1, 60) g;`);
    const { who } = await loginAs(guardian);

    const page = await openAs(who, null);
    const noWards = page.getByText('연결된 피보호자가 없습니다.');

    await test.step('연결 목록 조회가 끝나기 전에는 "연결된 피보호자가 없습니다" 를 보이지 않는다', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolve => (release = resolve));
      await page.route('**/api/guardian/connection/select*', async route => {
        await gate;
        await route.continue().catch(() => undefined);
      });
      try {
        await page.goto('/guardian/sos');
        await expect(sidebar(page)).toBeVisible();
        await sleep(1_500);
        const shownWhileLoading = await noWards.isVisible();
        test.info().annotations.push({ type: '실측', description: `연결 조회 대기 중 "연결된 피보호자가 없습니다" 표시: ${shownWhileLoading}` });
        expect
          .soft(shownWhileLoading, '연결 목록을 아직 받는 중인데 "연결된 피보호자가 없습니다." 빈 상태가 보인다 (isLoading 무시)')
          .toBe(false);
      } finally {
        release();
      }
      await page.unroute('**/api/guardian/connection/select*');
    });

    await test.step('연결 목록 조회가 실패해도 "연결된 피보호자가 없습니다" 로 단정하지 않는다', async () => {
      await page.route('**/api/guardian/connection/select*', route => route.abort('failed'));
      await page.goto('/guardian/sos');
      await expect(sidebar(page)).toBeVisible();
      await sleep(2_500);
      const shownOnError = await noWards.isVisible();
      test.info().annotations.push({ type: '실측', description: `연결 조회 실패 시 "연결된 피보호자가 없습니다" 표시: ${shownOnError}` });
      expect.soft(shownOnError, '연결 조회가 실패했는데 "연결된 피보호자가 없습니다." 로 표시해 이력을 볼 수 없는 이유를 오해하게 한다 (isError 무시)').toBe(false);
      await page.unroute('**/api/guardian/connection/select*');
    });

    await test.step('전체 호출 수와 경로별 카운트의 합이 맞는다 (또는 "현재 페이지" 기준임을 표시한다)', async () => {
      await page.goto('/guardian/sos');
      await expect(page.getByText('전체 호출 기록')).toBeVisible();
      await expect.poll(async () => (await page.locator('strong + span', { hasText: '전체 호출' }).first().innerText().catch(() => '')), { timeout: 15_000 }).toBeTruthy();
      await expect
        .poll(
          async () => {
            const stats = await page.evaluate(() =>
              Object.fromEntries([...document.querySelectorAll('strong + span')].map(s => [s.textContent ?? '', s.previousElementSibling?.textContent ?? ''])),
            );
            return stats['전체 호출'] ?? '-';
          },
          { timeout: 15_000 },
        )
        .not.toBe('-');
      const stats = await page.evaluate(() =>
        Object.fromEntries([...document.querySelectorAll('strong + span')].map(s => [s.textContent ?? '', s.previousElementSibling?.textContent ?? ''])),
      );
      const num = (value?: string) => Number((value ?? '').replace(/\D/g, '') || 0);
      const total = num(stats['전체 호출']);
      const call = num(stats['보호자에게 직접 전화']);
      const button = num(stats['긴급 SOS 버튼']);
      const body = await page.locator('body').innerText();
      test.info().annotations.push({ type: '실측', description: `전체 호출 ${total}건, 직접 전화 ${call}건 + SOS 버튼 ${button}건 = ${call + button}건` });
      expect(total, '준비: 서버에는 60건이 있어야 한다').toBe(60);
      if (!/현재 페이지|이 페이지/.test(body)) {
        expect
          .soft(call + button, `전체 호출 ${total}건인데 경로별 카드 합이 ${call + button}건이다 (현재 페이지 50건만 센 값이고 "현재 페이지" 표기도 없음)`)
          .toBe(total);
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// G31 - 접근성 기본 결함
// ---------------------------------------------------------------------------------------------

test.describe('접근성 기본', () => {
  test('[FEUX-G31] 문서 언어(lang=ko)·페이지별 제목·입력 포커스 표시·모달 포커스 관리·닫힌 모바일 메뉴 포커스 차단이 지켜진다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);

    await test.step('html lang 이 한국어이고, 페이지마다 title 이 다르다', async () => {
      const page = await openAs('anonymous', '/login');
      const lang = await page.evaluate(() => document.documentElement.lang);
      const loginTitle = await page.title();
      await page.goto('/signup');
      const signupTitle = await page.title();
      test.info().annotations.push({ type: '실측', description: `html lang "${lang}", title "${loginTitle}" / "${signupTitle}"` });
      expect.soft(lang, '<html> 에 lang 이 없어 화면 낭독기가 한국어로 읽지 못한다').toMatch(/^ko/);
      expect.soft(loginTitle, '로그인과 회원가입 페이지의 title 이 같다 (모든 페이지가 고정 title)').not.toBe(signupTitle);
      expect.soft(loginTitle + signupTitle, '기본 생성 문구 "Generated by create next app" 성격의 기본 metadata 가 남아 있다').not.toMatch(/create next app/i);
    });

    await test.step('입력칸에 키보드 포커스가 오면 눈에 보이는 표시가 생긴다', async () => {
      const page = await openAs('anonymous', '/login');
      const email = page.locator('input[name="email"]');
      await expect(email).toBeVisible();
      const snapshot = () =>
        email.evaluate(el => {
          const parts: string[] = [];
          let node: Element | null = el;
          for (let i = 0; i < 3 && node; i++) {
            const s = getComputedStyle(node);
            parts.push([s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.borderTopColor, s.backgroundColor].join('|'));
            node = node.parentElement;
          }
          return parts.join('||');
        });
      await page.locator('body').click({ position: { x: 5, y: 5 } });
      await sleep(400);
      const before = await snapshot();
      await email.focus();
      await sleep(600);
      const after = await snapshot();
      test.info().annotations.push({ type: '실측', description: `포커스 전후 스타일 동일: ${before === after}` });
      expect.soft(after, '입력칸(outline:none)에 포커스가 와도 테두리·그림자·배경 어느 것도 바뀌지 않아 키보드 사용자가 위치를 볼 수 없다').not.toBe(before);
    });

    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);
    const page = await openAs(who, '/guardian');
    await expect(sidebar(page)).toBeVisible();

    await test.step('모달이 열리면 포커스가 모달 안으로 오고, 트랩되며, ESC 로 닫힌다', async () => {
      const confirm = await openLogoutConfirm(page, guardian.name);
      const insideModal = () => page.evaluate(() => Boolean(document.activeElement?.closest('[role="alertdialog"]')));
      const initiallyInside = await insideModal();
      let escaped = false;
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('Tab');
        if (!(await insideModal())) escaped = true;
      }
      await page.keyboard.press('Escape');
      await sleep(500);
      const closedByEscape = !(await confirm.isVisible());
      test.info().annotations.push({ type: '실측', description: `열린 직후 포커스가 모달 안: ${initiallyInside}, Tab 으로 모달 밖 이탈: ${escaped}, ESC 로 닫힘: ${closedByEscape}` });
      expect.soft(initiallyInside, '모달이 열려도 포커스가 모달 안으로 이동하지 않는다').toBe(true);
      expect.soft(escaped, 'Tab 을 반복하면 포커스가 모달 뒤 요소로 빠져나간다 (포커스 트랩 없음)').toBe(false);
      expect.soft(closedByEscape, 'ESC 키로 모달이 닫히지 않는다').toBe(true);
      await page.reload();
      await expect(sidebar(page)).toBeVisible();
    });

    await test.step('900px 이하에서 닫힌 사이드바의 링크는 키보드 포커스를 받지 않는다', async () => {
      await page.setViewportSize({ width: 700, height: 900 });
      await sleep(600);
      const focusableOffscreen = await page.evaluate(() => {
        const aside = document.querySelector('aside');
        if (!aside) return ['aside 없음'];
        const found: string[] = [];
        for (const el of aside.querySelectorAll<HTMLElement>('a[href], button')) {
          const rect = el.getBoundingClientRect();
          if (rect.right > 0 && rect.left < window.innerWidth) continue;
          el.focus();
          if (document.activeElement === el) found.push((el.textContent ?? '').trim().slice(0, 20));
          el.blur();
        }
        return found;
      });
      test.info().annotations.push({ type: '실측', description: `화면 밖 사이드바에서 포커스를 받은 요소 ${focusableOffscreen.length}개: ${focusableOffscreen.join(', ')}` });
      expect.soft(focusableOffscreen, '닫힌 모바일 메뉴가 translateX 로만 숨겨져 화면 밖 링크가 Tab 으로 포커스된다 (visibility/inert 없음)').toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// G32 - 고대비/큰 글자 모달
// ---------------------------------------------------------------------------------------------

test.describe('고대비·큰 글자 모달', () => {
  test('[FEUX-G32] 피보호자 고대비 설정이 SOS 확인 모달에도 반영되고, 글자 28px 에서 낮은 화면에도 모달 버튼이 화면 안에 있다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const openConfirm = async (highContrast: boolean, viewport: { width: number; height: number }) => {
      const page = await openAs(who, null);
      await page.setViewportSize(viewport);
      await page.addInitScript(
        ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
        { key: WARD_SETTINGS_KEY, value: { fontSize: 28, highContrast, sosAction: 'notifyGuardianFirst' } },
      );
      await page.goto('/ward/sos');
      await expect(page.getByRole('link', { name: `${guardian.name}에게 전화하기` })).toBeVisible();
      await page.getByRole('button', { name: /긴급 SOS/ }).click();
      const confirm = modal(page, '긴급 SOS 전송');
      await expect(confirm).toBeVisible();
      await sleep(500); // 등장 애니메이션 종료
      return { page, confirm };
    };

    const viewport = { width: 640, height: 360 };
    const contrast = await openConfirm(true, viewport);
    const contrastStyle = await contrast.confirm.evaluate(el => {
      const title = el.querySelector('h2');
      return { titleColor: getComputedStyle(title ?? el).color, background: getComputedStyle(el).backgroundColor };
    });
    const boxes = {
      send: await contrast.confirm.getByRole('button', { name: '보내기' }).boundingBox(),
      cancel: await contrast.confirm.getByRole('button', { name: '취소' }).boundingBox(),
    };

    const normal = await openConfirm(false, viewport);
    const normalStyle = await normal.confirm.evaluate(el => {
      const title = el.querySelector('h2');
      return { titleColor: getComputedStyle(title ?? el).color, background: getComputedStyle(el).backgroundColor };
    });

    test.info().annotations.push({
      type: '실측',
      description: `고대비 모달 글자색 ${contrastStyle.titleColor} / 일반 ${normalStyle.titleColor}, 고대비 켠 채 28px 640x360 에서 버튼 위치 보내기 ${JSON.stringify(boxes.send)}, 취소 ${JSON.stringify(boxes.cancel)}`,
    });

    expect
      .soft(contrastStyle, '고대비를 켰는데 모달 색이 일반 모드와 같다 (모달 색을 #fff/#191f28/#6b7684 로 하드코딩해 고대비 변수와 무관)')
      .not.toEqual(normalStyle);

    for (const [label, box] of [['보내기', boxes.send], ['취소', boxes.cancel]] as const) {
      expect(box, `${label} 버튼의 위치를 읽을 수 있어야 한다`).not.toBeNull();
      if (!box) continue;
      expect
        .soft(box.y >= 0 && box.y + box.height <= viewport.height, `글자 28px, ${viewport.width}x${viewport.height} 화면에서 "${label}" 버튼이 화면 밖으로 밀렸다 (y ${Math.round(box.y)}~${Math.round(box.y + box.height)} / 높이 ${viewport.height}, 모달에 max-height·스크롤 없음)`)
        .toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// G33 - 피보호자 SOS 동작 설정 저장 위치
// ---------------------------------------------------------------------------------------------

test.describe('피보호자 SOS 동작 설정', () => {
  test('[FEUX-G33] SOS 동작 설정은 계정(서버)에 저장돼 다른 기기·브라우저에서 로그인해도 같은 값이 보인다', async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(120_000);
    const ward = await tempUser('WARD');
    const { api, who } = await loginAs(ward);

    await test.step('서버에 저장된 값이 새 브라우저의 설정 화면에 반영된다', async () => {
      const saved = await api.call<{ sosAction: string }>('PUT', '/api/ward/sos-setting', { sosAction: 'NOTIFY_GUARDIAN_FIRST' });
      expect(saved.sosAction, '준비: 서버에 NOTIFY_GUARDIAN_FIRST 가 저장돼야 한다').toBe('NOTIFY_GUARDIAN_FIRST');

      // 저장소가 비어 있는 새 브라우저 컨텍스트 (다른 기기 로그인과 같다)
      const page = await openAs(who, '/ward/settings');
      await expect(page.getByRole('radiogroup')).toBeVisible();
      const checked = await page.locator('input[name="ward-sos"]:checked').getAttribute('value');
      test.info().annotations.push({ type: '실측', description: `서버 값 NOTIFY_GUARDIAN_FIRST, 새 브라우저 설정 화면의 선택 "${checked}"` });
      expect.soft(checked, '서버에 저장된 SOS 동작이 있는데 새 브라우저에서는 기본값이 선택돼 있다 (FE 가 /api/ward/sos-setting 을 호출하지 않고 localStorage 만 사용)').toBe('notifyGuardianFirst');
    });

    await test.step('화면에서 바꾼 설정이 서버에도 저장된다', async () => {
      await api.call('PUT', '/api/ward/sos-setting', { sosAction: 'CALL_119_AND_NOTIFY' });
      const page = await openAs(who, '/ward/settings');
      await expect(page.getByRole('radiogroup')).toBeVisible();
      await page.locator('label', { has: page.locator('input[name="ward-sos"][value="call119"]') }).click();
      await expect(page.locator('input[name="ward-sos"][value="call119"]')).toBeChecked();
      await sleep(2_000);
      const server = await api.get<{ sosAction: string }>('/api/ward/sos-setting');
      test.info().annotations.push({ type: '실측', description: `화면에서 "119에 바로 연결" 선택 뒤 서버 값 ${server.sosAction}` });
      expect.soft(server.sosAction, '화면에서 SOS 동작을 바꿨는데 서버 설정은 그대로다 (PUT 미호출, 기기 저장소에만 저장)').toBe('CALL_119');
    });
  });
});

// ---------------------------------------------------------------------------------------------
// G34 - 카카오 로그인 콜백
// ---------------------------------------------------------------------------------------------

test.describe('카카오 로그인 콜백', () => {
  test('[FEUX-G34] 카카오 동의를 취소하면 안내가 뜨고, 인가 요청에 state 가 있으며, 프로필 이미지 URL 은 서버가 검증한다', async ({ openAs, request }) => {
    test.setTimeout(90_000);

    await test.step('동의 취소(error=access_denied)로 돌아오면 이유를 안내한다', async () => {
      const page = await openAs('anonymous', null);
      await page.goto('/oauth?error=access_denied&error_description=User%20denied%20access');
      await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
      await sleep(1_500);
      const body = await page.locator('body').innerText();
      const notice = /취소|동의|거부|access_denied|중단/;
      test.info().annotations.push({ type: '실측', description: `동의 취소 후 최종 경로 ${new URL(page.url()).pathname}, 안내 문구 ${notice.test(body) ? '있음' : '없음'}` });
      expect.soft(body, '카카오 동의를 취소하고 돌아왔는데 아무 안내 없이 로그인 화면으로만 이동한다 (error 파라미터 무시)').toMatch(notice);
    });

    await test.step('카카오 인가 요청에 state 파라미터가 있다', async () => {
      const res = await request.get(`${env.baseUrl}/api/oauth/kakao/authorize`, { maxRedirects: 0 });
      expect([302, 307]).toContain(res.status());
      const location = new URL(res.headers().location);
      test.info().annotations.push({ type: '실측', description: `인가 요청 파라미터: ${[...location.searchParams.keys()].join(', ')}` });
      expect.soft(location.searchParams.get('state'), '인가 요청에 state 가 없어 콜백에서 CSRF 검증을 할 수 없다 (로그인 CSRF)').toBeTruthy();
    });

    await test.step('서버가 너무 긴 프로필 이미지 URL 을 입력 검증에서 거절한다', async () => {
      // 존재하지 않는 인증 nonce 를 써서 검증을 통과하더라도 사용자가 만들어지지 않는다
      const res = await request.post(`${env.apiUrl}/api/auth/signup/kakao`, {
        data: {
          kakaoId: '0',
          name: 'E2E',
          phone: '01000019998',
          verificationNonce: '00000000-0000-0000-0000-000000000000',
          role: 'WARD',
          profileImageUrl: `https://example.com/${'a'.repeat(600)}`,
          address: '서울특별시 강남구 테헤란로 123',
          addressDetail: '101동 202호',
          gender: 'MALE',
          birthDate: '1970-01-01',
          postcode: '06236',
        },
      });
      const text = await res.text();
      test.info().annotations.push({ type: '실측', description: `600자 프로필 이미지 URL 가입 요청 -> ${res.status()} ${text.slice(0, 160)}` });
      expect.soft(text, '프로필 이미지 URL 에 길이·도메인 검증이 없어 입력 검증 단계에서 거절되지 않고 인증 단계까지 넘어간다 (KakaoRegisterRequest.profileImageUrl 무제약)').toMatch(/프로필|이미지|profileImage/);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// G35 - 병원 예약 폼의 날짜
// ---------------------------------------------------------------------------------------------

const RESERVATION_HOSPITAL = {
  id: 1,
  name: 'E2E점검병원',
  region: '서울',
  address: '서울 테스트로 1',
  phone: '02-000-0000',
  departments: ['내과'],
  operationStatus: 'OPEN',
  congestionLevel: 'LOW',
  bookingAvailable: true,
  description: '',
  openTime: '00:00',
  closeTime: '23:59',
};

/** 예약 서비스 API 를 전부 가짜로 대체한다 (예약 생성은 아예 끊는다) */
async function mockReservationApi(page: Page) {
  const json = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });
  await page.route(/\/api\/reservation\/hospitals(\?.*)?$/, route => route.fulfill(json([RESERVATION_HOSPITAL])));
  await page.route(/\/api\/reservation\/hospitals\/1\/available-slots/, route =>
    route.fulfill(json({ hospitalId: 1, date: '', availableSlots: ['00:30', '10:00', '11:00', '23:30'] })),
  );
  await page.route(/\/api\/reservation\/reservations\/my/, route => route.fulfill(json([])));
  await page.route(/\/api\/reservation\/reservations$/, route => route.abort('failed'));
}

test.describe('병원 예약 폼 날짜', () => {
  test('[FEUX-G35] 병원 예약 폼은 화면을 켜 둔 채 자정을 넘기면 날짜를 오늘로 보정하고, 브라우저 시간대와 무관하게 한국 시간의 오늘을 쓴다', async ({ tempUser, loginAs, openAs, browser }) => {
    test.setTimeout(150_000);
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);

    await test.step('한국 시간 23:59 에 열어 둔 채 자정을 넘기면 선택된 날짜가 어제에 머물지 않는다', async () => {
      const { who } = await loginAs(guardian);
      const page = await openAs(who, null);
      await mockReservationApi(page);
      // 토큰 만료 판단이 어긋나지 않게 실제 현재보다 하루 앞선 날짜로 고정한다 (2026-09-29 23:59 KST)
      await page.clock.install({ time: new Date('2026-09-29T14:59:00Z') });
      await page.goto('/guardian/hospital');
      await page.getByRole('button', { name: /E2E점검병원/ }).click();
      const date = page.locator('input[type="date"]');
      await expect(date).toBeVisible();
      await expect(date, '준비: 열었을 때 날짜는 그날(2026-09-29)이어야 한다').toHaveValue('2026-09-29');

      await page.clock.fastForward(120_000);
      // 다시 그려지게 한다 (검색어 입력)
      await page.getByRole('searchbox').fill('E2E');
      await sleep(800);
      const value = await date.inputValue();
      const min = await date.getAttribute('min');
      test.info().annotations.push({ type: '실측', description: `자정 뒤 날짜 입력 value ${value}, min ${min}` });
      expect.soft(min, '준비: 자정이 지나면 min 은 새 날짜가 된다').toBe('2026-09-30');
      expect.soft(value, '자정을 넘겼는데 날짜가 어제에 머물러 있고 min 보다도 이전이다 (date state 가 초기값에 고정, 보정·제출 차단 없음)').toBe('2026-09-30');
    });

    await test.step('브라우저 시간대가 UTC 여도 기본 날짜는 한국 시간의 오늘이다', async () => {
      const { who } = await loginAs(guardian);
      const context = await browser.newContext({
        ...contextDefaults,
        timezoneId: 'UTC',
        storageState: { cookies: tokenCookies(who.login), origins: [] },
      });
      try {
        const page = await context.newPage();
        await mockReservationApi(page);
        // UTC 2026-09-29 16:00 = 한국 2026-09-30 01:00
        await page.clock.install({ time: new Date('2026-09-29T16:00:00Z') });
        await page.goto('/guardian/hospital');
        await page.getByRole('button', { name: /E2E점검병원/ }).click();
        const date = page.locator('input[type="date"]');
        await expect(date).toBeVisible();
        const value = await date.inputValue();
        test.info().annotations.push({ type: '실측', description: `UTC 브라우저(한국 09-30 01:00)에서 기본 날짜 ${value}` });
        expect.soft(value, '한국은 이미 9월 30일인데 UTC 브라우저의 로컬 시간으로 "오늘" 을 계산해 하루 전 날짜가 기본값이 된다').toBe('2026-09-30');
      } finally {
        await context.close();
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// G37 - 알림 설정 조회 실패
// ---------------------------------------------------------------------------------------------

test.describe('알림 설정 조회 실패', () => {
  test('[FEUX-G37] 알림 설정 조회가 실패하면 기본값을 실제 값처럼 보이지 않고 오류 안내와 재시도를 제공하며 토글은 비활성이다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const { who } = await loginAs(guardian);

    const page = await openAs(who, null);
    // 5xx 대신 네트워크 실패로 만들어 PageWatcher 의 5xx 검사와 섞이지 않게 한다 (조회만 실패, 변경 요청은 그대로)
    await page.route('**/api/user/me/notification-settings*', route =>
      route.request().method() === 'GET' ? route.abort('failed') : route.continue(),
    );
    await page.goto('/guardian');
    await expect(sidebar(page)).toBeVisible();
    await nav(page, 'GUARDIAN').getByRole('link', { name: '환경설정' }).click();
    await expect(page.getByText('알림 채널 설정')).toBeVisible();
    await sleep(2_500);

    const body = await page.locator('body').innerText();
    const push = page.locator('label[aria-label="앱 푸시 알림 설정"] input');
    const pushChecked = await push.isChecked().catch(() => null);
    const pushDisabled = await push.isDisabled().catch(() => null);
    const feedback = /불러오지 못|조회.{0,6}실패|오류|다시 시도|재시도/;
    test.info().annotations.push({
      type: '실측',
      description: `조회 실패 뒤 앱 푸시 토글 checked ${pushChecked}, disabled ${pushDisabled}, 오류 안내 ${feedback.test(body) ? '있음' : '없음'}`,
    });
    expect.soft(body, '알림 설정 조회가 실패했는데 오류 배너·재시도 버튼 없이 기본값(FCM 켜짐, 나머지 꺼짐)만 보인다 (isError 무시)').toMatch(feedback);
    expect.soft(pushDisabled, '조회에 실패해 실제 값을 모르는데 토글이 활성이라 눌러서 다른 값을 저장할 수 있다').toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// G38 - 서비스워커 백그라운드 알림 클릭
// ---------------------------------------------------------------------------------------------

/** 서비스워커 파일에서 getNotificationPath 함수만 떼어 내 그대로 실행한다 */
function extractNotificationPathFn(source: string) {
  const start = source.indexOf('function getNotificationPath');
  if (start < 0) throw new Error('firebase-messaging-sw.js 에서 getNotificationPath 를 찾지 못했습니다.');
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) {
      const fn = source.slice(start, i + 1);
      return new Function(`${fn}; return getNotificationPath;`)() as (data?: { type?: string }) => string;
    }
  }
  throw new Error('getNotificationPath 의 끝을 찾지 못했습니다.');
}

test.describe('백그라운드 알림 클릭 경로', () => {
  test('[FEUX-G38] 백그라운드에서 복약 알림을 누르면 루트가 아니라 포그라운드와 같은 복약 화면으로 이동한다', async ({ request }) => {
    const res = await request.get(`${env.baseUrl}/firebase-messaging-sw.js`);
    expect(res.ok(), '서비스워커 파일을 받을 수 있어야 한다').toBe(true);
    const getPath = extractNotificationPathFn(await res.text());

    // 포그라운드(PushNotificationListener)가 쓰는 경로와 같아야 한다
    const expected: Record<string, string> = {
      MEDICATION_REMINDER: '/ward/medication',
      MEDICATION_MISSED: '/guardian/medication',
      MEDICATION_STOPPED: '/guardian/medication',
    };
    const actual = Object.fromEntries(Object.keys(expected).map(type => [type, getPath({ type })]));
    test.info().annotations.push({ type: '실측', description: `서비스워커 이동 경로 ${JSON.stringify(actual)}` });
    expect
      .soft(actual, '서비스워커 getNotificationPath 에 복약 유형(MEDICATION_*)이 없어 default 인 "/" 로 이동한다 (포그라운드는 /ward/medication, /guardian/medication)')
      .toEqual(expected);
  });
});
