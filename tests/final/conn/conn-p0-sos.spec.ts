/**
 * 최종 QA - SOS(CONN) P0: N10 N11 N13 N14 N15 N17 N18 N19 N20 A13 A17 A19 N24 A22.
 *
 * 임시 사용자만 쓴다. 보호자에게 전화번호가 없으면(phone: null) 푸시·문자가 모두 못 가므로 실제 문자는 나가지 않는다.
 * 실제 문자가 필요한 케이스(N14: 알림이 "전달된" 뒤에야 쉬는 시간이 유지됨)만 전화번호가 있는 보호자를 쓴다.
 */
import { Page, request } from '@playwright/test';

import { contextDefaults, installPageStubs, pageStubArg } from '../../../src/browser';
import { env } from '../../../src/env';
import { tokenCookies } from '../../../src/session';
import { expect, test, waitForRealtime } from '../../../src/fixtures';
import { connect, suppressSosNotify } from '../../../src/variables';
import {
  clearCooldown, connectionId, guardianCards, cooldownExists, dialpad, expectError, injectRedisFault, logLineCount, pressSosV13,
  presetSosActionValue, sosEvents, sosHeroButton, sosNotificationCount, sosNotificationLogs, sosNotSent, TAGS, toastArea,
  waitIdorLog, read,
} from './_helpers-conn';
import { psql, sqlStr } from '../../../src/remote';

function b64url(value: object) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** 서명이 틀린 가짜 JWT (만료 여부는 exp 로 조절) */
function fakeJwt(sub: string, role: string, expired: boolean) {
  const now = Math.floor(Date.now() / 1000);
  const exp = expired ? now - 3600 : now + 3600;
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub, role, typ: 'access', iat: now - 7200, exp })}.${'x'.repeat(43)}`;
}

/** 페이지가 받는 실시간(STOMP) 프레임 글자를 모은다. goto 전에 불러야 한다 */
function captureFrames(page: Page): string[] {
  const frames: string[] = [];
  page.on('websocket', ws =>
    ws.on('framereceived', f => frames.push(typeof f.payload === 'string' ? f.payload : f.payload.toString())),
  );
  return frames;
}

async function postSos(api: { raw: (m: 'POST', p: string, d?: unknown) => Promise<import('@playwright/test').APIResponse> }, data: unknown = {}) {
  const res = await api.raw('POST', '/api/ward/sos', data);
  const r = await read(res);
  expect(r.status, `SOS 전송 (본문: ${r.text.slice(0, 160)})`).toBe(201);
  return r.body.data as { sosEventId: number; triggeredAt: string };
}

type Hist = { content: Record<string, unknown>[] };

test.describe('CONN SOS P0', () => {
  test('CONN-N10 피보호자 SOS 기본 전송', TAGS, async ({ tempUser, loginAs, openAs }) => {
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const { who, api } = await loginAs(ward);
    // SOS 동작 설정은 서버 값이 기기 값을 덮어쓴다 - 서버에 먼저 저장해 둔다
    expect((await api.raw('PUT', '/api/ward/sos-setting', { sosAction: 'NOTIFY_GUARDIAN_FIRST' })).status()).toBe(200);

    const page = await openAs(who, null);
    await presetSosActionValue(page, 'NOTIFY_GUARDIAN_FIRST');
    await page.goto('/ward/sos');
    await expect(guardianCards(page)).toHaveCount(2);

    const posted = await pressSosV13(page);
    expect(posted, 'POST /api/ward/sos 가 나가야 한다').not.toBeNull();
    expect(posted!.status()).toBe(201);
    expect(posted!.request().postData(), '화면은 빈 body 로 보낸다').toBeNull();
    const body = (await posted!.json()) as { data: { sosEventId: number; triggeredAt: string } };
    expect(typeof body.data.sosEventId).toBe('number');
    expect(Number.isNaN(Date.parse(body.data.triggeredAt))).toBe(false);
    await expect(page.getByRole('alertdialog', { name: '보호자에게 알렸어요' })).toBeVisible();

    expect(sosEvents(ward.id), '기록 1건').toBe(1);
    expect(psql(`SELECT (location IS NULL)::text || '|' || trigger_type FROM sos_event WHERE id = ${body.data.sosEventId};`),
      '위치를 안 보내면 NULL(문서의 "위치 모름"은 표시용), 경로는 SOS_BUTTON').toBe('true|SOS_BUTTON');

    await expect
      .poll(() => sosNotificationCount(ward.id), { message: '연결된 보호자 전원(2명)에게 WARD_SOS 발송 기록', timeout: 25_000 })
      .toBe(2);
    const logs = sosNotificationLogs(ward.id);
    expect(logs.map(l => l.recipient).sort()).toEqual([g1.id, g2.id].sort());
    for (const log of logs) {
      expect(log.channels, '푸시(FCM) 발송을 시도했다').toContain('FCM');
      expect(log.title).toBe(`[긴급] ${ward.name}님 SOS`);
      expect(log.body).toBe(`${ward.name}님이 긴급 도움을 요청했습니다.`);
    }
  });

  test('CONN-N11 보호자가 알림을 꺼도 SOS 푸시는 간다', TAGS, async ({ tempUser, loginAs, openAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);

    await test.step('보호자가 모든 채널과 알림 종류를 끈다', async () => {
      const channels = ['FCM', 'SMS', 'KAKAO_ALIMTALK', 'EMAIL'].map(channelType => ({ channelType, enabled: false }));
      const put = await g.api.raw('PUT', '/api/user/me/notification-settings', { settings: channels });
      expect(put.status()).toBe(200);
      const types = await g.api.raw('PUT', '/api/guardian/notification-type-setting', {
        anomalyReviewReminder: false, medication: false, cameraLinkLost: false, companionNotice: false,
      });
      expect(types.status()).toBe(200);
      const saved = await g.api.get<{ settings: { channelType: string; enabled: boolean }[] }>('/api/user/me/notification-settings');
      expect(saved.settings.every(s => s.enabled === false), '채널이 전부 꺼져 저장됐다').toBe(true);
    });

    const page = await openAs(g.who, null);
    const frames = captureFrames(page);
    await page.goto('/guardian');
    await waitForRealtime(page);

    await postSos(w.api);

    await expect
      .poll(() => sosNotificationLogs(ward.id, guardian.id), { message: 'WARD_SOS 발송 기록이 남는다', timeout: 25_000 })
      .toHaveLength(1);
    const [log] = sosNotificationLogs(ward.id, guardian.id);
    test.info().annotations.push({ type: 'WARD_SOS 발송 결과', description: `${log.result} ${log.channels.slice(0, 300)}` });
    expect(log.channels, '채널을 다 꺼도 푸시(FCM) 발송을 시도한다').toContain('FCM');
    // 배포본은 "꺼 둠"을 result=NOT_SENT, not_sent_reason=NO_ENABLED_CHANNEL 로 기록한다 - 그 값이 아니어야 한다
    const [sent] = sosNotSent(ward.id, guardian.id);
    expect(sent.result, '"꺼 둠"으로 안 보냄(NOT_SENT) 처리하면 안 된다').not.toBe('NOT_SENT');
    expect(sent.reason, '건너뛴 이유가 NO_ENABLED_CHANNEL(채널을 꺼 둠)이면 안 된다').not.toBe('NO_ENABLED_CHANNEL');
    await expect
      .poll(() => frames.some(f => f.includes('sos-triggered')), { message: '화면 실시간 신호(sos-triggered)도 온다', timeout: 15_000 })
      .toBe(true);
  });

  test('CONN-N13 보호자 여러 명이면 전원에게 알림', TAGS, async ({ tempUser, loginAs }) => {
    // 푸시 토큰은 셋 다 없어 푸시는 전부 실패한다. 전화번호는 첫 번째 보호자만 있다(임시 010-0001 대역, 문자 1건) -
    // 그 한 명은 문자 대체로 전달되고, 나머지 둘은 실패여도 막히지 않아야 한다.
    const guardians = [
      await tempUser('GUARDIAN'),
      await tempUser('GUARDIAN', { phone: null }),
      await tempUser('GUARDIAN', { phone: null }),
    ];
    const ward = await tempUser('WARD');
    for (const g of guardians) connect(g.id, ward.id);
    const w = await loginAs(ward);

    await postSos(w.api);

    await expect
      .poll(() => sosNotificationCount(ward.id), { message: '3명 모두에게 발송을 시도한 기록', timeout: 30_000 })
      .toBe(3);
    const logs = sosNotificationLogs(ward.id);
    expect(logs.map(l => l.recipient).sort()).toEqual(guardians.map(g => g.id).sort());
    for (const log of logs) expect(log.channels, `${log.recipient} 푸시 시도`).toContain('FCM');
    // 1명(전화번호 있음)은 문자 대체로 전달, 나머지 2명은 실패 - 한 명의 실패가 다른 사람의 전달을 막지 않았다
    const byId = new Map(logs.map(l => [l.recipient, l.result]));
    expect(byId.get(guardians[0].id), '전화번호 있는 보호자는 문자 대체로 전달').toMatch(/DELIVERED|SMS_FALLBACK/);
    expect(byId.get(guardians[1].id), '연락 수단 없는 보호자는 전달 실패').not.toMatch(/DELIVERED|SMS_FALLBACK/);
    expect(byId.get(guardians[2].id), '연락 수단 없는 보호자는 전달 실패').not.toMatch(/DELIVERED|SMS_FALLBACK/);
    expect(sosEvents(ward.id)).toBe(1);
  });

  test('CONN-N14 10초 안 연타하면 알림 1번, 기록은 매번', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(150_000);
    // 알림이 "전달"돼야 쉬는 시간이 유지된다 - 전화번호가 있는 보호자(문자 대체 발송 접수 1건씩, 총 2건)
    const guardian = await tempUser('GUARDIAN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const w = await loginAs(ward);

    await test.step('10초 안에 3번', async () => {
      await postSos(w.api);
      await postSos(w.api);
      await postSos(w.api);
      expect(sosEvents(ward.id), '기록은 누를 때마다').toBe(3);
      await expect
        .poll(() => sosNotificationCount(ward.id, guardian.id), { message: '첫 묶음 알림', timeout: 30_000 })
        .toBeGreaterThanOrEqual(1);
      // 고정 대기 대신 서버가 2·3번째 SOS 를 "쿨다운 - 알림 생략"으로 처리했다고 로그에 남길 때까지 기다린다
      await expect
        .poll(() => logLineCount(env.apiContainer, ['알림 생략(이력은 보존): wardId=' + ward.id + ',']), { message: '2·3번째 SOS 가 알림 생략으로 처리됐다', timeout: 30_000, intervals: [1000] })
        .toBe(2);
      expect(sosNotificationCount(ward.id, guardian.id), '3번 눌렀어도 알림은 1번').toBe(1);
      const [first] = sosNotificationLogs(ward.id, guardian.id);
      test.info().annotations.push({ type: '첫 알림 결과', description: first.result });
    });

    await test.step('쉬는 시간(10초)이 지난 뒤 1번 더', async () => {
      await expect
        .poll(() => cooldownExists(ward.id), { message: '쉬는 시간 키가 만료될 때까지', timeout: 30_000, intervals: [1000] })
        .toBe(false);
      await postSos(w.api);
      expect(sosEvents(ward.id), '기록 4건').toBe(4);
      await expect
        .poll(() => sosNotificationCount(ward.id, guardian.id), { message: '쉬는 시간 뒤 알림이 다시 간다', timeout: 30_000 })
        .toBe(2);
    });
  });

  test('CONN-N15 반복 SOS에 N번째 문구와 repeatCount', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(150_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);

    const page = await openAs(g.who, null);
    const frames = captureFrames(page);
    await page.goto('/guardian');
    await waitForRealtime(page);

    await test.step('첫 SOS: 예전 문구', async () => {
      await postSos(w.api);
      await expect.poll(() => sosNotificationCount(ward.id, guardian.id), { timeout: 25_000 }).toBe(1);
      const [first] = sosNotificationLogs(ward.id, guardian.id);
      expect(first.body).toBe(`${ward.name}님이 긴급 도움을 요청했습니다.`);
      expect(first.body).not.toContain('번째');
    });

    await test.step('쉬는 시간이 풀린 뒤 두 번째 SOS: 반복 문구', async () => {
      // 전달된 곳이 없어서 서버가 쉬는 시간을 바로 푼다. 풀릴 때까지 기다린다
      await expect.poll(() => cooldownExists(ward.id), { timeout: 20_000, intervals: [500] }).toBe(false);
      await postSos(w.api);
      await expect.poll(() => sosNotificationCount(ward.id, guardian.id), { timeout: 25_000 }).toBe(2);
      const logs = sosNotificationLogs(ward.id, guardian.id);
      expect(logs[1].body).toContain(`${ward.name}님이 계속 도움을 요청하고 있습니다.`);
      expect(logs[1].body).toContain('최근 10분 내 2번째');
    });

    await test.step('실시간 신호 sos-triggered 에 repeatCount 문자열', async () => {
      await expect
        .poll(() => frames.filter(f => f.includes('sos-triggered') && f.includes('"repeatCount":"2"')).length, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      expect(frames.some(f => f.includes('sos-triggered') && f.includes('"repeatCount":"1"')), '첫 신호는 repeatCount "1"').toBe(true);
    });

    await test.step('보호자 화면 알림에 N번째 문구가 보인다', async () => {
      await expect(toastArea(page).getByText(/최근 10분 내 2번째/), '웹 알림에도 반복 횟수 문구').toBeVisible({ timeout: 10_000 });
    });
  });

  test('CONN-N17 보호자 웹 화면에 SOS 팝업 즉시 표시·유지', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(150_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    const otherWard = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const w = await loginAs(ward);
    const o = await loginAs(otherWard);

    const page = await openAs(g.who, '/guardian');
    await waitForRealtime(page);
    const sosToast = toastArea(page).getByRole('alert').filter({ hasText: ward.name });

    await postSos(w.api);
    await expect(sosToast, 'SOS 팝업이 새로고침 없이 바로 뜬다').toBeVisible({ timeout: 15_000 });

    await test.step('7초가 지나도 사라지지 않는다', async () => {
      await page.waitForTimeout(7_000);
      await expect(sosToast).toBeVisible();
    });

    await test.step('다른 알림(연결 수락)이 와도 SOS 팝업은 그대로', async () => {
      expect((await g.api.raw('POST', '/api/guardian/connection/request', { targetId: otherWard.id, relation: '아들' })).status()).toBe(200);
      const pending = await o.api.get<{ connectionId: number }[]>('/api/ward/connection/pending');
      expect((await o.api.raw('POST', `/api/ward/connection/${pending[0].connectionId}/accept`)).status()).toBe(200);
      await expect(toastArea(page).getByText('연결 수락', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(sosToast, '다른 알림에 밀려 사라지면 안 된다').toBeVisible();
    });

    await test.step('확인(닫기)을 눌러야 사라진다', async () => {
      await sosToast.getByRole('button', { name: /알림 닫기/ }).click();
      await expect(sosToast).toHaveCount(0);
    });
  });

  test('CONN-N18 119 동작 설정 3값 모두 보호자에게 알림 간다', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const actions = ['CALL_119', 'CALL_119_AND_NOTIFY', 'NOTIFY_GUARDIAN_FIRST'] as const;

    for (const action of actions) {
      await test.step(`설정 ${action}`, async () => {
        const ward = await tempUser('WARD');
        connect(guardian.id, ward.id);
        const { who, api } = await loginAs(ward);
        const put = await api.raw('PUT', '/api/ward/sos-setting', { sosAction: action });
        expect(put.status(), `설정 저장 (${await put.text()})`).toBe(200);
        expect((await api.get<{ sosAction: string }>('/api/ward/sos-setting')).sosAction).toBe(action);

        const page = await openAs(who, null);
        // CALL_119 는 화면에서 고르지 않는 값이라 FE 가 기본값으로 바꿔 쓴다 - 기기 저장소는 화면에서 고를 수 있는 값만 미리 넣는다
        if (action !== 'CALL_119') await presetSosActionValue(page, action);
        await page.goto('/ward/sos');
        await expect(guardianCards(page)).toHaveCount(1);
        await expect(sosHeroButton(page)).toBeVisible();

        const posted = await pressSosV13(page);
        expect(posted, `${action}: 서버에 SOS 요청이 도착해야 한다`).not.toBeNull();
        expect(posted!.status()).toBe(201);

        if (action === 'NOTIFY_GUARDIAN_FIRST') {
          const done = page.getByRole('alertdialog', { name: '보호자에게 알렸어요' });
          await expect(done).toBeVisible();
          await done.getByRole('button', { name: '119 화면 열기' }).click();
        }
        await expect(dialpad(page), '119 는 키패드 화면만').toBeVisible();
        await expect(dialpad(page)).toContainText('실제로 신고 전화가 발신되지 않습니다');
        await expect(page.locator('a[href^="tel:119"]'), '119 로 거는 tel 링크가 없다').toHaveCount(0);

        if (action === 'CALL_119') {
          // 화면은 CALL_119 를 기본값으로 바꿔 쓴다 - 서버 값만 CALL_119 이고 화면 동작은 기본값 동작이다 (CALL_119 자체의 화면 동작은 확인되지 않음)
          const saved = await page.evaluate(
            key => (JSON.parse(localStorage.getItem(key) ?? '{}') as { sosAction?: string }).sosAction ?? '(없음)',
            'silverbridge_ward_settings',
          );
          test.info().annotations.push({
            type: 'CALL_119 화면 동작',
            description: `서버 값 CALL_119, 화면이 쓴 값(localStorage sosAction) ${saved}. 화면은 기본값으로 동작함 - CALL_119 자체의 화면 동작은 확인되지 않았다`,
          });
        }

        expect(sosEvents(ward.id)).toBe(1);
        await expect
          .poll(() => sosNotificationCount(ward.id, guardian.id), { message: `${action}: 보호자 알림 발송 기록`, timeout: 25_000 })
          .toBe(1);
      });
    }
  });

  test('CONN-N19 보호자가 0명이어도 SOS 기록 남음', TAGS, async ({ tempUser, loginAs, openAs }) => {
    const ward = await tempUser('WARD');
    const { who } = await loginAs(ward);
    const page = await openAs(who, '/ward/sos');
    await expect(page.getByText('현재 연결된 보호자가 없습니다.')).toBeVisible();

    const posted = await pressSosV13(page);
    expect(posted, '보호자가 없어도 요청이 나가야 한다').not.toBeNull();
    expect(posted!.status(), '요청 성공').toBe(201);
    await expect(dialpad(page)).toBeVisible();

    await expect.poll(() => sosEvents(ward.id), { message: 'sos_event 기록', timeout: 10_000 }).toBe(1);
    // 고정 대기 대신 서버가 "대상 보호자 없음"으로 끝냈다고 로그에 남길 때까지 기다린다
    await expect
      .poll(() => logLineCount(env.apiContainer, ['알림 대상 보호자 없음(이력은 보존): wardId=' + ward.id + ',']), { message: '서버가 대상 없음으로 처리', timeout: 20_000, intervals: [1000] })
      .toBe(1);
    expect(sosNotificationCount(ward.id), '알림 대상이 없으니 발송 기록도 없다').toBe(0);
  });

  test('CONN-N20 Redis 장애에서도 SOS만은 통과', TAGS, async ({ tempUser, loginAs }) => {
    // 공유 dev 의 Redis 를 멈출 수 없어, 이 임시 피보호자의 인증 확인 키 하나만 못 읽게 만들어 장애를 흉내 낸다
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const w = await loginAs(ward);

    expect((await w.api.raw('GET', '/api/ward/connection/active')).status(), '장애 전에는 정상').toBe(200);
    const clear = injectRedisFault(ward.id);
    try {
      await test.step('SOS 는 통과하고 기록·알림이 남는다', async () => {
        const data = await postSos(w.api);
        expect(data.sosEventId).toBeGreaterThan(0);
        expect(sosEvents(ward.id)).toBe(1);
        await expect.poll(() => sosNotificationCount(ward.id, guardian.id), { timeout: 25_000 }).toBe(1);
      });
      await test.step('다른 API 는 503 SERVICE_UNAVAILABLE', async () => {
        await expectError(await w.api.raw('GET', '/api/ward/connection/active'), 503, 'SERVICE_UNAVAILABLE', '연결 목록');
        await expectError(await w.api.raw('GET', '/api/ward/medication/today'), 503, 'SERVICE_UNAVAILABLE', '복약 오늘');
      });
    } finally {
      clear();
    }
    test.info().annotations.push({
      type: '자동화 한계',
      description: '"쉬는 시간 장치(Redis)만 장애일 때 억제를 포기하고 알림 발송"은 SET NX 라 키 타입 오염으로 재현되지 않아 수동 확인(Redis 중단은 금지)',
    });
    await expect(async () => {
      expect((await w.api.raw('GET', '/api/ward/connection/active')).status(), '장애가 풀리면 다시 정상').toBe(200);
    }).toPass({ timeout: 10_000 });
  });

  test('CONN-A13 로그인 없음·역할 다름·무효 토큰으로 SOS', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const admin = await tempUser('ADMIN');
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    const g = await loginAs(guardian);
    const a = await loginAs(admin);
    const w = await loginAs(ward);

    async function sosWith(token: string | null) {
      const ctx = await request.newContext({
        baseURL: env.apiUrl,
        extraHTTPHeaders: token ? { Authorization: `Bearer ${token}` } : {},
      });
      try {
        return (await ctx.post('/api/ward/sos', { data: {} })).status();
      } finally {
        await ctx.dispose();
      }
    }
    // 진짜 토큰의 서명 한가운데 글자 하나를 바꾼다 (마지막 글자는 여분 비트라 바꿔도 서명이 같을 수 있다)
    const [head, payload, signature] = w.login.accessToken.split('.');
    const pos = 10;
    const tampered = [head, payload, signature.slice(0, pos) + (signature[pos] === 'A' ? 'B' : 'A') + signature.slice(pos + 1)].join('.');

    const normal = {
      '토큰 없음': await sosWith(null),
      '보호자 토큰': await sosWith(g.login.accessToken),
      '관리자 토큰': await sosWith(a.login.accessToken),
      '서명 틀린 토큰': await sosWith(fakeJwt(ward.id, 'WARD', false)),
      '만료된 토큰': await sosWith(fakeJwt(ward.id, 'WARD', true)),
      '서명을 바꾼 진짜 토큰': await sosWith(tampered),
    };
    for (const [label, status] of Object.entries(normal)) {
      expect([401, 403], `${label} -> ${status}`).toContain(status);
    }
    expect(normal['토큰 없음'], '토큰 없음은 401').toBe(401);

    await test.step('Redis 장애 중에도 서명·만료 불량은 거절', async () => {
      const clear = injectRedisFault(ward.id);
      try {
        const faulty = {
          '서명 틀린 토큰': await sosWith(fakeJwt(ward.id, 'WARD', false)),
          '만료된 토큰': await sosWith(fakeJwt(ward.id, 'WARD', true)),
          '서명을 바꾼 진짜 토큰': await sosWith(tampered),
        };
        for (const [label, status] of Object.entries(faulty)) {
          expect([401, 403], `장애 중 ${label} -> ${status}`).toContain(status);
        }
      } finally {
        clear();
      }
    });

    await new Promise(resolve => setTimeout(resolve, 2_000));
    expect(sosEvents(ward.id), '기록 없음').toBe(0);
    expect(sosNotificationCount(ward.id), '알림 없음').toBe(0);
  });

  test('CONN-A17 아무에게도 못 간 SOS는 쉬기 풀림', TAGS, async ({ tempUser, loginAs }) => {
    test.setTimeout(120_000);
    // 전화번호도 푸시 토큰도 없는 보호자 2명 = 푸시·문자 전원 실패
    const g1 = await tempUser('GUARDIAN', { phone: null });
    const g2 = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(g1.id, ward.id);
    connect(g2.id, ward.id);
    const w = await loginAs(ward);

    // 쉬는 시간 키는 원래 10초 뒤 저절로 사라진다. 그래서 "서버가 풀어서" 사라진 것인지 구별하려고
    // 첫 SOS 시각을 적어 두고, 키가 10초보다 확실히 빨리 사라지는지·두 번째 SOS 가 10초 안인지·[SOS-NO-DELIVERY] 로그가 찍혔는지를 함께 본다.
    const noDelivery = () => logLineCount(env.apiContainer, ['[SOS-NO-DELIVERY]', `wardId=${ward.id},`]);
    const firstAt = Date.now();
    await postSos(w.api);
    await expect.poll(() => sosNotificationCount(ward.id), { message: '첫 SOS: 2명 발송 시도', timeout: 30_000 }).toBe(2);
    for (const log of sosNotificationLogs(ward.id)) {
      expect(log.result, '전달 실패로 기록').not.toMatch(/DELIVERED|SMS_FALLBACK/);
    }
    await expect
      .poll(noDelivery, { message: '서버가 "아무에게도 못 갔다"([SOS-NO-DELIVERY])로 쉬는 시간을 풀었다고 남긴다', timeout: 5_000, intervals: [500] })
      .toBe(1);
    // 발송 기록이 남은 뒤 3초 안에 키가 없어야 한다 (저절로 만료되려면 첫 SOS 뒤 10초가 필요하다)
    await expect
      .poll(() => cooldownExists(ward.id), { message: '아무에게도 못 갔으니 쉬는 시간 키가 3초 안에 풀린다', timeout: 3_000, intervals: [300] })
      .toBe(false);
    const releasedAfter = Date.now() - firstAt;
    expect(releasedAfter, `키가 풀린 시각(첫 SOS 뒤 ${releasedAfter}ms)이 쉬는 시간(10초)보다 확실히 빨라야 한다`).toBeLessThan(8_000);

    await postSos(w.api);
    const secondAt = Date.now() - firstAt;
    expect(secondAt, `두 번째 SOS 는 첫 SOS 뒤 10초 안이어야 한다(실제 ${secondAt}ms)`).toBeLessThan(9_500);
    await expect
      .poll(() => sosNotificationCount(ward.id), { message: '쉬는 시간(10초) 안의 재전송인데 알림이 다시 발송된다', timeout: 30_000 })
      .toBe(4);
    await expect
      .poll(noDelivery, { message: '두 번째도 [SOS-NO-DELIVERY] 로 쉬는 시간을 풀었다', timeout: 10_000, intervals: [1000] })
      .toBe(2);
    clearCooldown(ward.id);
  });

  test('CONN-A19 SOS 전송 실패·오프라인 화면 처리', TAGS, async ({ tempUser, loginAs, openAs, browser }) => {
    test.setTimeout(150_000);
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(guardian.id, ward.id);
    suppressSosNotify(ward.id);
    const { who, api, login } = await loginAs(ward);
    expect((await api.raw('PUT', '/api/ward/sos-setting', { sosAction: 'NOTIFY_GUARDIAN_FIRST' })).status()).toBe(200);

    const page = await openAs(who, null);
    await presetSosActionValue(page, 'NOTIFY_GUARDIAN_FIRST');
    await page.route('**/api/ward/sos', route => route.abort('failed'));
    await page.goto('/ward/sos');
    await expect(guardianCards(page)).toHaveCount(1);

    async function failureScreen(label: string, p: Page = page) {
      await pressSosV13(p, 4_000);
      const errorModal = p.getByRole('alertdialog', { name: 'SOS 전송 실패' });
      await expect(errorModal, `${label}: 실패 창이 떠야 한다`).toBeVisible({ timeout: 20_000 });
      await expect(sosHeroButton(p), `${label}: "보내는 중"에 갇히면 안 된다`).toContainText('도움이 필요하면 누르세요');
      const text = (await errorModal.innerText()) ?? '';
      expect(text, `${label}: 가짜 번호를 보여 주면 안 된다`).not.toMatch(/번호\s*[:：]?\s*\d|#\s?\d+/);
      await expect.soft(errorModal.getByRole('button', { name: /119 화면 열기/ }), `${label}: "119 화면 열기" 버튼`).toBeVisible();
      await expect.soft(errorModal.getByRole('button', { name: /다시 보내기/ }), `${label}: "다시 보내기" 버튼`).toBeVisible();
      await errorModal.getByRole('button').first().click();
      await expect(errorModal).toHaveCount(0);
    }

    try {
      await test.step('서버에 닿지 못할 때(요청 실패)', async () => {
        await failureScreen('연결 실패');
      });
      await test.step('서버가 오류 응답(500)을 줄 때', async () => {
        // 일부러 낸 500 이 공용 감시(API 5xx = 버그)에 걸리지 않게, 감시 없는 별도 화면(같은 임시 피보호자)으로 본다
        const ctx = await browser.newContext({ ...contextDefaults, storageState: { cookies: tokenCookies(login), origins: [] } });
        try {
          await ctx.addInitScript(installPageStubs(), pageStubArg);
          const page500 = await ctx.newPage();
          await presetSosActionValue(page500, 'NOTIFY_GUARDIAN_FIRST');
          await page500.route('**/api/ward/sos', route =>
            route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, code: 'INTERNAL_SERVER_ERROR', message: '서버 오류' }) }),
          );
          await page500.goto('/ward/sos');
          await expect(guardianCards(page500)).toHaveCount(1);
          await failureScreen('서버 오류 500', page500);
        } finally {
          await ctx.close();
        }
      });
      await test.step('오프라인일 때', async () => {
        await page.unroute('**/api/ward/sos');
        await page.context().setOffline(true);
        try {
          await failureScreen('오프라인');
        } finally {
          await page.context().setOffline(false);
        }
      });
      expect(sosEvents(ward.id), '실패한 전송은 기록되지 않는다').toBe(0);
    } finally {
      try {
        clearCooldown(ward.id);
      } catch {
        // 정리 실패는 무시한다 (임시 사용자 키라 300초 뒤 저절로 사라진다)
      }
    }
  });

  test('CONN-N24 calledGuardianName 표시 조건과 ID 비노출', TAGS, async ({ tempUser, loginAs }) => {
    const called = await tempUser('GUARDIAN', { phone: null });
    const viewer = await tempUser('GUARDIAN', { phone: null });
    const leaving = await tempUser('GUARDIAN', { phone: null });
    const ward = await tempUser('WARD');
    connect(called.id, ward.id);
    connect(viewer.id, ward.id);
    connect(leaving.id, ward.id);
    suppressSosNotify(ward.id);
    const c = await loginAs(called);
    const v = await loginAs(viewer);
    const w = await loginAs(ward);

    const ev1 = await postSos(w.api, { triggerType: 'GUARDIAN_CALL', calledGuardianId: called.id });
    const ev2 = await postSos(w.api, { triggerType: 'GUARDIAN_CALL', calledGuardianId: leaving.id });
    const find = (h: Hist, id: number) => h.content.find(i => i.sosEventId === id);

    await test.step('ACTIVE 일 때만 이름 포함, 사용자 ID 는 응답 어디에도 없음', async () => {
      const res = await read(await v.api.raw('GET', '/api/guardian/sos/history?page=0&size=50'));
      expect(res.status).toBe(200);
      const history = res.body.data as Hist;
      expect(find(history, ev1.sosEventId)?.calledGuardianName).toBe(called.name);
      expect(find(history, ev2.sosEventId)?.calledGuardianName).toBe(leaving.name);
      expect(res.text, '전화받은 보호자의 ID 가 없다').not.toContain(called.id);
      expect(res.text).not.toContain(leaving.id);
      expect(res.text).not.toMatch(/calledGuardianId/);
      const mine = await read(await c.api.raw('GET', '/api/guardian/sos/history?page=0&size=50'));
      expect(mine.text, '본인 화면에도 ID 칸이 없다').not.toMatch(/calledGuardianId/);
    });

    await test.step('연결을 끊으면 이름이 JSON 에서 빠진다', async () => {
      const id = connectionId(called.id, ward.id);
      expect((await c.api.raw('DELETE', `/api/guardian/connection/disconnection/${id}`)).status()).toBe(200);
      const history = await v.api.get<Hist>('/api/guardian/sos/history?page=0&size=50');
      const item = find(history, ev1.sosEventId);
      expect(item, '이력 자체는 남아 있다').toBeTruthy();
      expect('calledGuardianName' in item!, '키 자체가 빠져야 한다').toBe(false);
      expect(find(history, ev2.sosEventId)?.calledGuardianName, '아직 연결된 사람은 이름이 그대로').toBe(leaving.name);
    });

    await test.step('실제 탈퇴(DELETE /api/user/me) 뒤에도 이름이 빠진다', async () => {
      // 임시 보호자(leaving)가 직접 로그인해 실제 탈퇴 API 를 부른다 (행 직접 삭제로 흉내 내지 않는다)
      const l = await loginAs(leaving);
      const out = await l.api.raw('DELETE', '/api/user/me', { password: leaving.password });
      expect(out.status(), '탈퇴 요청 성공').toBe(200);
      const history = await v.api.get<Hist>('/api/guardian/sos/history?page=0&size=50');
      const item = find(history, ev2.sosEventId);
      expect(item, '이력은 남는다').toBeTruthy();
      expect('calledGuardianName' in item!).toBe(false);
      expect(JSON.stringify(history)).not.toContain(leaving.id);
    });
    clearCooldown(ward.id);
  });

  test('CONN-A22 이력 조회 권한 - 로그인 없음·피보호자·연결 안 됨', TAGS, async ({ tempUser, loginAs }) => {
    const guardian = await tempUser('GUARDIAN', { phone: null });
    const active = await tempUser('WARD');
    const pending = await tempUser('WARD');
    const dropped = await tempUser('WARD');
    const stranger = await tempUser('WARD');
    connect(guardian.id, active.id);
    connect(guardian.id, dropped.id);
    suppressSosNotify(active.id);
    const g = await loginAs(guardian);
    const w = await loginAs(active);
    await postSos(w.api);

    expect((await g.api.raw('POST', '/api/guardian/connection/request', { targetId: pending.id, relation: '딸' })).status()).toBe(200);
    expect((await g.api.raw('DELETE', `/api/guardian/connection/disconnection/${connectionId(guardian.id, dropped.id)}`)).status()).toBe(200);

    const anon = await request.newContext({ baseURL: env.apiUrl });
    try {
      expect((await anon.get('/api/guardian/sos/history')).status(), '토큰 없음').toBe(401);
    } finally {
      await anon.dispose();
    }
    expect((await w.api.raw('GET', '/api/guardian/sos/history')).status(), '피보호자 토큰').toBe(403);

    for (const [label, wardId] of [['대기 중(PENDING)', pending.id], ['해제됨', dropped.id], ['연결 안 된', stranger.id]] as const) {
      const r = await expectError(await g.api.raw('GET', `/api/guardian/sos/history?wardId=${wardId}`), 403, 'SOS_NOT_AUTHORIZED', label);
      expect(r.body.data ?? null, `${label}: 내용 없음`).toBeNull();
    }
    await expectError(await g.api.raw('GET', '/api/guardian/sos/history?wardId=zz!zz'), 403, 'SOS_NOT_AUTHORIZED', '형식이 틀린 wardId');
    await waitIdorLog('guardianId', guardian.id, 4);

    const ok = await read(await g.api.raw('GET', `/api/guardian/sos/history?wardId=${active.id}`));
    expect(ok.status, '연결된 피보호자는 정상 조회').toBe(200);
    expect((ok.body.data as Hist).content).toHaveLength(1);
    // 다른 사람 기록은 섞이지 않는다
    expect(psql(`SELECT count(*) FROM sos_event WHERE ward_id = ${sqlStr(stranger.id)};`)).toBe('0');
    clearCooldown(active.id);
  });
});
