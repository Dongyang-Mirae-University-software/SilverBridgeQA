/**
 * 변수 QA - 긴급 SOS (낮은 심각도 발견 항목)
 *
 * SOS-G05, G07, G14, G15, G16, G17, G18, G20.
 * 모든 테스트는 올바른 동작을 단정하므로 버그가 살아 있는 동안에는 실패한다.
 *
 * 부작용 차단: 임시 사용자만 쓰고, SOS 를 보내기 전에 알림 쿨다운 키를 넣어 FCM·SMS 가 나가지 않게 한다.
 */
import { Page } from '@playwright/test';

import { expect, test } from '../../src/fixtures';
import { psql, sqlStr } from '../../src/remote';
import { connect, pressSos, suppressSosNotify, WARD_SETTINGS_KEY } from '../../src/variables';

const WARD_CONNECTION_ACTIVE = '**/api/ward/connection/active';
const GUARDIAN_CONNECTION_SELECT = '**/api/guardian/connection/select*';
const NO_WARD_TEXT = '연결된 피보호자가 없습니다.';

/** POST /api/ward/sos 응답에서 이력 ID 를 꺼낸다 */
async function readSosEventId(res: { json(): Promise<unknown> }): Promise<string> {
  const body = (await res.json()) as { data?: { sosEventId?: number | string } };
  return String(body.data?.sosEventId ?? '');
}

test.describe('피보호자 설정 저장소가 손상돼도 SOS 화면에 들어갈 수 있어야 한다', () => {
  test('[SOS-G05] 설정 localStorage 값이 깨져 있어도 SOS 화면이 크래시하지 않고 기본값으로 복구된다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who } = await loginAs(ward);

    // 깨진 JSON, 문자열 null 두 가지 손상 값
    for (const corrupted of ['{', 'null']) {
      await test.step(`손상 값 ${JSON.stringify(corrupted)}`, async () => {
        const page = await openAs(who, null);
        await page.addInitScript(
          ({ key, value }) => localStorage.setItem(key, value),
          { key: WARD_SETTINGS_KEY, value: corrupted },
        );
        await page.goto('/ward/sos');

        await expect
          .soft(
            page.getByRole('button', { name: /긴급 SOS/ }),
            `설정 값이 ${JSON.stringify(corrupted)} 이면 파싱 예외가 catch 되지 않아 피보호자 화면 전체가 크래시한다 (SOS 버튼이 안 보임)`,
          )
          .toBeVisible({ timeout: 10_000 });
        await expect
          .soft(page.getByText(/Application error|client-side exception/i), '클라이언트 예외 화면이 뜨면 안 된다')
          .toHaveCount(0);
      });
    }
  });
});

test.describe('SOS 동작 설정은 계정(서버)에 저장돼야 한다', () => {
  test('[SOS-G07] 설정 화면에서 SOS 동작을 바꾸면 PUT /api/ward/sos-setting 으로 서버에 저장된다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who, api } = await loginAs(ward);

    const page = await openAs(who, null);
    const puts: string[] = [];
    page.on('request', request => {
      if (request.method() === 'PUT' && /\/api\/ward\/sos-setting$/.test(request.url())) puts.push(request.postData() ?? '');
    });
    await page.goto('/ward/settings');

    await page.getByRole('radiogroup', { name: 'SOS 동작 설정' }).getByText('보호자에게 먼저 알림', { exact: true }).click();
    await expect(page.locator('input[name="ward-sos"][value="notifyGuardianFirst"]')).toBeChecked();

    await expect
      .poll(() => puts.length, { message: 'SOS 동작 설정을 바꾸면 PUT /api/ward/sos-setting 이 나가야 한다 (지금은 localStorage 에만 저장)', timeout: 5_000 })
      .toBeGreaterThan(0);

    const saved = await api.get<{ sosAction: string }>('/api/ward/sos-setting');
    expect(saved.sosAction, '서버에 저장된 설정이 NOTIFY_GUARDIAN_FIRST 로 바뀌어야 한다 (기기를 바꿔도 유지되려면)').toBe('NOTIFY_GUARDIAN_FIRST');
  });
});

test.describe('탈퇴한 피보호자의 익명 SOS 이력', () => {
  test('[SOS-G14] 탈퇴한 피보호자의 익명 SOS 이력이 정책대로 보호자 이력에 이름 없이 남고, 이름이 공백인 활성 피보호자는 탈퇴로 표기되지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    const activeWard = await tempUser('WARD');
    connect(guardian.id, ward.id);
    connect(guardian.id, activeWard.id);
    suppressSosNotify(ward.id);
    suppressSosNotify(activeWard.id);
    const wardLogin = await loginAs(ward);
    const activeWardLogin = await loginAs(activeWard);
    const guardianLogin = await loginAs(guardian);

    const createdEventIds: string[] = [];
    try {
      const anonymousEventId = await test.step('탈퇴 예정 피보호자가 SOS 를 보낸다', async () => {
        const res = await wardLogin.api.raw('POST', '/api/ward/sos', {});
        expect(res.status()).toBe(201);
        const id = await readSosEventId(res);
        createdEventIds.push(id);
        return id;
      });

      await test.step('피보호자 탈퇴를 DB 로 재현 (연결 DISCONNECTED + 이력 ward_id NULL 익명화, 알림은 나가지 않는다)', async () => {
        psql(`UPDATE connection SET status = 'DISCONNECTED' WHERE ward_id = ${sqlStr(ward.id)};
              UPDATE sos_event SET ward_id = NULL WHERE id = ${anonymousEventId};`);
      });

      await test.step('활성 피보호자가 SOS 를 보내고 이름을 공백으로 만든다', async () => {
        const res = await activeWardLogin.api.raw('POST', '/api/ward/sos', {});
        expect(res.status()).toBe(201);
        createdEventIds.push(await readSosEventId(res));
        psql(`UPDATE users SET name = '' WHERE id = ${sqlStr(activeWard.id)};`);
      });

      const history = await guardianLogin.api.get<{ content: { sosEventId: number; wardName: string | null }[] }>(
        '/api/guardian/sos/history?page=0&size=50',
      );
      const ids = history.content.map(item => String(item.sosEventId));
      expect
        .soft(ids, '정책(domain-security-policy 37,127행)대로 탈퇴 피보호자의 익명 이력이 이름 없이 목록에 남아야 한다 (지금은 ACTIVE 연결 IN 조회라 절대 나오지 않음)')
        .toContain(anonymousEventId);

      // 이름이 공백인 활성 피보호자가 '탈퇴한 사용자'로 잘못 표기되는지 화면에서 확인
      const page = await openAs(guardianLogin.who, '/guardian/sos');
      await expect(page.getByRole('heading', { name: '전체 호출 기록' })).toBeVisible();
      await expect
        .soft(page.getByText('탈퇴한 사용자'), '이름이 공백일 뿐인 활성 피보호자를 "탈퇴한 사용자"로 표시하면 안 된다 (이름 없음 등으로 분리)')
        .toHaveCount(0);
    } finally {
      // ward_id 가 NULL 이 된 행은 임시 사용자 정리(ward_id 기준)에 안 잡히므로 직접 지운다
      for (const id of createdEventIds.filter(Boolean)) psql(`DELETE FROM sos_event WHERE id = ${id};`);
    }
  });
});

test.describe('SOS 위치 문구 검증', () => {
  test('[SOS-G15] 위치는 trim 후 길이로 검증하고, 보이지 않는 공백만 있는 위치는 저장하지 않는다', async ({ tempUser, loginAs }) => {
    const ward = await tempUser('WARD');
    suppressSosNotify(ward.id);
    const { api } = await loginAs(ward);

    await test.step('앞뒤 공백 포함 101자 (trim 후 98자) 는 허용돼야 한다', async () => {
      const location = `  ${'가'.repeat(97)} `.padEnd(101, ' ');
      expect(location.length).toBe(101);
      expect(location.trim().length).toBeLessThanOrEqual(100);
      const res = await api.raw('POST', '/api/ward/sos', { location });
      expect.soft(res.status(), `trim 하면 ${location.trim().length}자인 위치가 원문 길이(101자) 검증으로 거절된다 (400)`).toBe(201);
    });

    for (const [name, invisible] of [['zero-width space U+200B', '​'], ['no-break space U+00A0', ' ']] as const) {
      await test.step(`${name} 만 있는 위치`, async () => {
        const res = await api.raw('POST', '/api/ward/sos', { location: invisible });
        expect(res.status()).toBe(201);
        const id = await readSosEventId(res);
        const stored = psql(`SELECT CASE WHEN location IS NULL THEN 'NULL' ELSE 'LEN=' || length(btrim(location)) END FROM sos_event WHERE id = ${id};`);
        expect.soft(stored, `${name} 만 있는 위치는 "위치 없음"(NULL)으로 저장돼야 한다 (지금은 보이지 않는 문자가 그대로 저장돼 이력에 빈 위치 표시가 남음)`).toBe('NULL');
      });
    }
  });
});

test.describe('보호자 SOS 이력 화면의 연결 목록 로딩/오류', () => {
  test('[SOS-G16] 연결 목록을 불러오는 중이거나 실패했을 때 "연결된 피보호자가 없습니다."를 보여주지 않는다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const { who } = await loginAs(guardian);

    /** 문구가 잠깐이라도 보이는지 (자동 대기: 보이면 true, 시간 안에 안 보이면 false) */
    const appearsWithin = (page: Page, ms: number) =>
      page.getByText(NO_WARD_TEXT).waitFor({ state: 'visible', timeout: ms }).then(() => true, () => false);

    await test.step('연결 목록 응답이 5초 늦을 때 (로딩 중)', async () => {
      const page = await openAs(who, null);
      await page.route(GUARDIAN_CONNECTION_SELECT, async route => {
        await new Promise(resolve => setTimeout(resolve, 5_000));
        await route.continue();
      });
      await page.goto('/guardian/sos');
      const shown = await appearsWithin(page, 4_000);
      expect.soft(shown, '연결 목록을 불러오는 중에는 로딩 표시여야 하고 "연결된 피보호자가 없습니다."가 보이면 안 된다').toBe(false);
    });

    await test.step('연결 목록 조회가 실패할 때 (오류)', async () => {
      const page = await openAs(who, null);
      // 5xx 대신 abort 를 써서 PageWatcher 의 5xx 검사와 섞이지 않게 한다
      await page.route(GUARDIAN_CONNECTION_SELECT, route => route.abort('failed'));
      await page.goto('/guardian/sos');
      const shown = await appearsWithin(page, 4_000);
      expect.soft(shown, '연결 목록 조회에 실패하면 오류를 알려야 하고 "연결된 피보호자가 없습니다."로 보이면 안 된다').toBe(false);
    });
  });
});

test.describe('SOS 동작 설정 최초 저장 경합', () => {
  test('[SOS-G17] 설정 행이 없을 때 PUT /api/ward/sos-setting 을 동시에 두 번 보내도 둘 다 200 이다', async ({ tempUser, loginAs }) => {
    const ward = await tempUser('WARD');
    const { api } = await loginAs(ward);

    const outcomes: string[] = [];
    try {
      // 레이스라서 매번 설정 행을 지우고 여러 번 반복한다
      for (let attempt = 1; attempt <= 10; attempt++) {
        psql(`DELETE FROM sos_setting WHERE user_id = ${sqlStr(ward.id)};`);
        const responses = await Promise.all([
          api.raw('PUT', '/api/ward/sos-setting', { sosAction: 'CALL_119' }),
          api.raw('PUT', '/api/ward/sos-setting', { sosAction: 'CALL_119' }),
        ]);
        const statuses = responses.map(res => res.status()).sort();
        outcomes.push(statuses.join('+'));
        if (statuses.some(status => status !== 200)) break;
      }
    } finally {
      psql(`DELETE FROM sos_setting WHERE user_id = ${sqlStr(ward.id)};`);
    }

    expect(
      outcomes.filter(outcome => outcome !== '200+200'),
      `최초 저장 경합에서 unique 위반이 409 로 새면 안 된다 (시도별 상태: ${outcomes.join(', ')})`,
    ).toEqual([]);
  });
});

test.describe('설정 화면 안내 문구', () => {
  test('[SOS-G18] "119에 바로 연결" 안내는 실제 발신이 없고 보호자에게도 알림이 간다고 정확히 알려준다', async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who } = await loginAs(ward);
    const page = await openAs(who, '/ward/settings');

    const option = page
      .getByRole('radiogroup', { name: 'SOS 동작 설정' })
      .locator('label')
      .filter({ hasText: '119에 바로 연결' });
    await expect(option).toBeVisible();
    const text = (await option.innerText()).replace(/\s+/g, ' ');

    expect.soft(text, '실제로는 119 가 입력된 키패드만 뜨고 전화를 걸지 않는데 "즉시 119에 전화를 겁니다"라고 안내한다').not.toMatch(/전화를 겁니다/);
    expect.soft(text, '실제 발신이 없다는 점(예: "실제 발신 없음")을 안내해야 한다').toMatch(/발신/);
    expect.soft(text, '이 설정이어도 보호자에게 알림이 간다는 점을 안내해야 한다').toMatch(/보호자/);
  });
});

test.describe('SOS 성공 후 보호자 목록 갱신', () => {
  test('[SOS-G20] SOS 전송에 성공하면 화면이 쓰는 보호자 연결 목록 쿼리가 무효화되어 다시 조회된다', async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who } = await loginAs(ward);

    const page = await openAs(who, null);
    let activeRequests = 0;
    page.on('request', request => {
      if (request.method() === 'GET' && /\/api\/ward\/connection\/active$/.test(request.url())) activeRequests += 1;
    });
    await page.route(WARD_CONNECTION_ACTIVE, route => route.continue());
    await page.goto('/ward/sos');
    await expect(page.getByRole('link', { name: `${guardian.name}에게 전화하기` })).toBeVisible();
    // 첫 진입 조회가 잦아들 때까지 기다린다
    await page.waitForTimeout(1_500);

    const sosResponse = page.waitForResponse(res => res.request().method() === 'POST' && res.url().endsWith('/api/ward/sos'));
    await pressSos(page);
    expect((await sosResponse).status()).toBe(201);
    const before = activeRequests;

    await expect
      .poll(() => activeRequests - before, {
        message: 'SOS 성공 직후 보호자 연결 목록(GET /api/ward/connection/active)이 다시 조회돼야 한다 (지금은 화면이 안 쓰는 ward-active-connections 키를 무효화해 no-op)',
        timeout: 5_000,
      })
      .toBeGreaterThan(0);
  });
});
