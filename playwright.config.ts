import { defineConfig, devices } from '@playwright/test';

import { contextDefaults } from './src/browser';

// 브라우저별 실행: 실제 Chrome / Microsoft Edge (설치: npm run install:browsers).
// 장치 기본값(viewport 1280x720 등)이 contextDefaults 를 덮어쓰지 않도록 contextDefaults 를 뒤에 편다.
const chrome = { ...devices['Desktop Chrome'], ...contextDefaults, channel: 'chrome' } as const;
const edge = { ...devices['Desktop Edge'], ...contextDefaults, channel: 'msedge' } as const;
const FLOW_IGNORE = [/global\.setup\.ts/, /variables[\\/]/];
const VARIABLES_MATCH = /variables[\\/].*\.spec\.ts/;

export default defineConfig({
  testDir: './tests',
  // 공유 dev 서버 + 계정 상태를 공유하는 시나리오라 순서대로 한 개씩 돌린다
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // dev 서버는 `next dev` 라 라우트를 처음 열 때 컴파일이 느리다
  timeout: 120_000,
  expect: { timeout: 15_000 },
  outputDir: 'reports/artifacts',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/html', open: 'never' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    ...contextDefaults,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
    launchOptions: {
      args: [
        // 화면 송출 테스트용 가짜 카메라 (권한 팝업 없이 테스트 패턴 영상)
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    },
  },
  projects: [
    // 흐름 QA: 고정 E2E 계정을 매번 재생성하고 시나리오를 순서대로 돈다
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    { name: 'e2e', testIgnore: [/global\.setup\.ts/, /variables[\\/]/], dependencies: ['setup'] },
    // 변수 QA: 테스트마다 임시 사용자를 만들고 지우므로 고정 계정·전체 재생성이 필요 없다
    { name: 'variables', testMatch: /variables[\\/].*\.spec\.ts/ },

    // ── 브라우저별 프로젝트 (Chrome / Edge) ──
    // 흐름 QA 는 고정 E2E 계정의 상태를 바꾼다(비밀번호 변경·탈퇴). 한 명령으로 두 브라우저를 연달아 돌리지 말고
    // 브라우저마다 따로 실행한다(매 실행 시작 때 setup 이 계정을 다시 만든다). 위의 e2e / variables 는 기존 Chromium 그대로다.
    { name: 'e2e-chrome', use: chrome, testIgnore: FLOW_IGNORE, dependencies: ['setup'] },
    { name: 'e2e-edge', use: edge, testIgnore: FLOW_IGNORE, dependencies: ['setup'] },
    { name: 'variables-chrome', use: chrome, testMatch: VARIABLES_MATCH },
    { name: 'variables-edge', use: edge, testMatch: VARIABLES_MATCH },
  ],
});
