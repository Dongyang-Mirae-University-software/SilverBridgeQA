/**
 * 최종 QA - 카메라·이상감지(CAM) P0 - 상태 표시(N18)
 *
 * N18 은 화면 문구가 문서와 다를 수 있어(배포 FE 는 status null 이면 아무것도 안 보여 줌) 실패할 수 있다.
 * 그래서 화재 묶음(cam-p0-fire.spec.ts)과 분리했다. 실패해도 화재 묶음을 건너뛰게 하지 않는다.
 * 임시 피보호자 1명 + 보호자 1명 + 카메라 1대(끝나면 지움). 화재 사진은 보내지 않는다.
 * 실행 안내: 카메라 상한(서비스 전체 3대)이 공용 값이므로 다른 영역과 동시에 돌리지 않는다.
 */
import { suppressAnomalySmsFallback } from '../../../src/fire';
import { expect, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import { disposeFireRun, errOf, expectErr, freeRoom, loginApi, newTempUser, setupSubscribedCamera, sleep, stopAiSession, wardProxy } from './_helpers-cam';

const TAGS = { tag: ['@P0', '@CAM'] };

test.describe.configure({ mode: 'serial' });

test.afterAll(async () => {
  await disposeFireRun();
});

test.describe('카메라·이상감지 P0 - 상태 표시', () => {
  test('CAM-N18 AI 끊김·세션 종료·전원 끔을 정상으로 보이지 않고 "확인 불가"로 보인다', TAGS, async ({ openAs }) => {
    test.setTimeout(420_000);
    const ward = newTempUser('WARD', { name: 'E2E상태본인' });
    const guardian = newTempUser('GUARDIAN', { name: 'E2E상태보호자' });
    connect(guardian.id, ward.id);
    suppressAnomalySmsFallback(ward.id);
    const w = await loginApi(ward);
    const g = await loginApi(guardian);
    const proxy = await wardProxy(w.login);
    const label = await freeRoom(w.api);
    const { camera } = await setupSubscribedCamera(w.api, proxy, label);
    const sid = camera.sessionId;

    await test.step('세션 종료 -> offline, 분석 null', async () => {
      await stopAiSession(proxy, sid);
      await expect
        .poll(async () => ((await (await g.api.raw('GET', `/api/guardian/camera/${sid}/status`)).json()) as { data: { status: string } }).data.status, {
          timeout: 30_000,
          intervals: [1_000],
          message: '세션을 끝냈는데 30초 안에 offline 이 되지 않았다',
        })
        .toBe('offline');
      const status = ((await (await g.api.raw('GET', `/api/guardian/camera/${sid}/status`)).json()) as { data: { status: string; analysis: unknown } }).data;
      expect(status.analysis, '종료된 세션의 분석은 null').toBeNull();
      const live = (await g.api.get<{ sessionId: string; status: string | null }[]>('/api/guardian/camera/live')).find(c => c.sessionId === sid);
      expect(live?.status).toBe('offline');
    });

    await test.step('꺼진 카메라(is_active=false)에는 상태를 보내지 않는다', async () => {
      expect((await w.api.raw('PATCH', `/api/ward/camera/${camera.id}`, { isActive: false })).status()).toBe(200);
      try {
        expectErr(await errOf(await g.api.raw('GET', `/api/guardian/camera/${sid}/status`)), 404, 'CAMERA_NOT_FOUND', '꺼진 카메라 상태');
        expect((await g.api.get<unknown[]>('/api/guardian/camera/live')).filter(c => (c as { sessionId: string }).sessionId === sid)).toEqual([]);
      } finally {
        await w.api.raw('PATCH', `/api/ward/camera/${camera.id}`, { isActive: true });
      }
    });

    await test.step('화면: AI 상태를 못 받으면(status null) 켜짐·꺼짐·이상 없음을 지어내지 않고 "확인 불가"로 보인다', async () => {
      const page = await openAs({ label: 'status-guardian', login: g.login }, null);
      // BE 의 live 목록 status 를 null(확인 불가), 상태 조회는 연결 끊김으로 바꿔 AI 장애 상황을 흉내 낸다
      await page.route('**/api/guardian/camera/live', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const res = await route.fetch();
        const json = (await res.json()) as { data: Record<string, unknown>[] };
        json.data = json.data.map(c => ({ ...c, status: null, lastFrameAt: null }));
        return route.fulfill({ response: res, json });
      });
      await page.route(/\/api\/guardian\/camera\/[^/]+\/status$/, async route => {
        if (route.request().method() !== 'GET') return route.continue();
        // 5xx 로 만들면 화면 감시기가 서버 오류로 세므로 연결 자체를 끊는다
        return route.abort('failed');
      });
      await page.goto('/guardian/detection');
      await page.getByRole('button', { name: /실시간 카메라 보기/ }).click();
      const dialog = page.getByRole('dialog', { name: '실시간 카메라' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('group', { name: '카메라 전환' }).getByRole('button', { name: new RegExp(label) })).toBeVisible({ timeout: 20_000 });
      await sleep(2_000);
      const text = (await dialog.textContent()) ?? '';
      expect(text, 'AI 상태를 모르는데 "켜짐"으로 보인다').not.toContain('켜짐');
      expect(text, 'AI 상태를 모르는데 "꺼짐"으로 보인다').not.toContain('꺼짐');
      expect(text, 'AI 상태를 모르는데 "이상 없음"으로 보인다').not.toContain('이상 없음');
      test.info().annotations.push({
        type: '화면 문구',
        description: '배포 FE(LiveCameraModal getCameraStatusMeta)는 status null 이면 표시를 생략한다(v12 checking 제거). 문서의 "확인 불가"는 FE 팀이 문서와 맞출지 판단해야 한다',
      });
      // 문서 기대값: 확인 불가 문구. 배포본이 문서와 다르면 여기서 실패한다(약하게 바꾸지 않는다)
      expect(text, 'AI 상태를 모르면 화면에 "확인 불가"가 보여야 한다(문서 기대값)').toContain('확인 불가');
    });
    // AI 서버 연결 자체가 끊기는 장애(status null 을 BE 가 직접 내는 경우)는 서버를 내릴 수 없어 흉내 낸 응답으로만 확인했다(CAM-A19 fixme 와 같은 한계)
    await proxy.dispose();
  });
});
