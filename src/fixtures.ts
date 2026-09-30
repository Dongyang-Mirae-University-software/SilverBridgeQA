/**
 * 테스트 공통 픽스처.
 *
 *   const guardian = await openAs('guardian1', '/guardian/wards');
 *   const ward = await openAs('ward2', '/ward/guardians');
 *
 * 역할마다 별도 브라우저 컨텍스트(= 별도 사용자)를 열어서, 보호자와 피보호자가 동시에 화면을
 * 보고 있는 상황(실시간 알림 등)을 그대로 재현한다.
 */
import { BrowserContext, expect, Page, test as base } from '@playwright/test';

import { AccountKey } from './accounts';
import { Api, LoginResult } from './api';
import { contextDefaults, installPageStubs, PageWatcher, pageStubArg } from './browser';
import { createTempUser, deleteTempUser, TempUser, TempUserOptions } from './seed';
import { freshLogin, statePath, tokenCookies } from './session';

/** 고정 계정이 아닌 사용자(테스트 중 만든 일회성 계정 등)로 열 때 */
export interface AdHocUser {
  label: string;
  login: LoginResult;
}

/** path 에 null 을 주면 페이지만 열고 이동하지 않는다 (page.route 를 먼저 걸어야 할 때) */
type OpenAs = (who: AccountKey | 'anonymous' | AdHocUser, path?: string | null) => Promise<Page>;

/** 로그인한 임시 사용자: API 호출용 클라이언트와, openAs 에 그대로 넘길 수 있는 브라우저 로그인 정보 */
export interface LoggedIn {
  user: TempUser;
  api: Api;
  login: LoginResult;
  who: AdHocUser;
}

interface Fixtures {
  openAs: OpenAs;
  /** 계정별 API 클라이언트 (셋업·교차 검증용). 같은 테스트 안에서는 캐시된다 */
  apiAs: (key: AccountKey) => Promise<Api>;
  /**
   * 이 테스트 전용 임시 사용자를 만든다. 테스트가 끝나면 자동으로 지운다.
   *   const ward = await tempUser('WARD');
   *   const restricted = await tempUser('GUARDIAN', { status: 'RESTRICTED' });
   */
  tempUser: (role: TempUser['role'], options?: TempUserOptions) => Promise<TempUser>;
  /** 임시 사용자로 로그인 (레이트리밋은 자동으로 풀고 재시도) */
  loginAs: (user: TempUser) => Promise<LoggedIn>;
}

export const test = base.extend<Fixtures>({
  openAs: async ({ browser }, use, testInfo) => {
    const opened: { context: BrowserContext; watcher: PageWatcher }[] = [];

    await use(async (who, path = '/') => {
      let storageState: string | { cookies: ReturnType<typeof tokenCookies>; origins: [] } | undefined;
      if (typeof who === 'object') {
        storageState = { cookies: tokenCookies(who.login), origins: [] };
      } else if (who !== 'anonymous') {
        await freshLogin(who);
        storageState = statePath(who);
      }
      const context = await browser.newContext({
        ...contextDefaults,
        storageState,
        recordVideo: testInfo.project.use.video !== 'off' ? { dir: testInfo.outputPath('videos') } : undefined,
      });
      await context.addInitScript(installPageStubs(), pageStubArg);

      const watcher = new PageWatcher(typeof who === 'object' ? who.label : who);
      opened.push({ context, watcher });

      const page = await context.newPage();
      watcher.attach(page);
      if (path) await page.goto(path);
      return page;
    });

    for (const { context, watcher } of opened) {
      await watcher.report(testInfo);
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const page of context.pages()) {
          await testInfo.attach(`화면 - ${watcher.label}`, {
            body: await page.screenshot({ fullPage: true }).catch(() => Buffer.alloc(0)),
            contentType: 'image/png',
          });
        }
      }
      await context.close();
    }

    // 잡히지 않은 JS 예외와 서버 5xx 는 화면이 겉보기엔 멀쩡해도 버그로 본다
    for (const { watcher } of opened) {
      expect.soft(watcher.pageErrors, `[${watcher.label}] 화면에서 JS 예외 발생`).toEqual([]);
      expect.soft(watcher.serverErrors, `[${watcher.label}] API 가 5xx 응답`).toEqual([]);
    }
  },

  apiAs: async ({}, use) => {
    const cache = new Map<AccountKey, Api>();
    await use(async key => {
      let api = cache.get(key);
      if (!api) {
        api = await Api.fromLogin(await freshLogin(key));
        cache.set(key, api);
      }
      return api;
    });
    for (const api of cache.values()) await api.dispose();
  },

  tempUser: async ({}, use) => {
    const created: string[] = [];
    await use(async (role, options) => {
      const user = createTempUser(role, options);
      created.push(user.id);
      return user;
    });
    for (const id of created.reverse()) {
      try {
        deleteTempUser(id);
      } catch (error) {
        console.warn(`임시 사용자 ${id} 정리 실패 (다음 전체 실행 때 정리됨):`, error);
      }
    }
  },

  loginAs: async ({}, use) => {
    const apis: Api[] = [];
    await use(async user => {
      const login = await Api.signinWithRetry(user.email, user.password);
      const api = await Api.fromLogin(login);
      apis.push(api);
      return { user, api, login, who: { label: user.id, login } };
    });
    for (const api of apis) await api.dispose();
  },
});

export { expect };

/** 사이드바 메뉴 */
export function nav(page: Page, role: 'GUARDIAN' | 'WARD') {
  return page.getByRole('navigation', { name: role === 'GUARDIAN' ? '보호자 메뉴' : '피보호자 메뉴' });
}

/** 역할 가드를 통과해 페이지 제목(h1)이 보일 때까지 기다린다 (가드는 통과 전까지 빈 화면을 그린다) */
export async function expectPageTitle(page: Page, title: string) {
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
}

/** 실시간/푸시 알림 토스트 */
export function toast(page: Page, title: string) {
  return page.locator('[aria-live="polite"]').getByText(title, { exact: true });
}

/**
 * 실시간 알림(STOMP)이 연결될 때까지 기다린다.
 * 연결 전에 상대가 요청을 보내면 알림을 놓치므로, 실시간 검증 전에 반드시 호출한다.
 */
export async function waitForRealtime(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __connectionStompClient?: { connected: boolean } }).__connectionStompClient?.connected === true,
    null,
    { timeout: 30_000 },
  );
}

/** 열려 있는 확인 모달(CommonModal: role=alertdialog) */
export function modal(page: Page, title: string) {
  return page.getByRole('alertdialog', { name: title });
}

/** window.confirm 을 한 번 수락한다 (Playwright 기본은 취소) */
export function acceptNextConfirm(page: Page, expectedMessage?: RegExp) {
  page.once('dialog', async dialog => {
    if (expectedMessage) expect(dialog.message()).toMatch(expectedMessage);
    await dialog.accept();
  });
}
