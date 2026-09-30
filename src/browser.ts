import { BrowserContextOptions, Page, TestInfo } from '@playwright/test';

import { ADDRESS } from './accounts';
import { env } from './env';

/** 모든 브라우저 컨텍스트 공통 옵션 (playwright.config 와 openAs 가 같이 쓴다) */
export const contextDefaults: BrowserContextOptions = {
  baseURL: env.baseUrl,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  // 900px 이하에서는 사이드바가 숨는다
  viewport: { width: 1440, height: 900 },
  // FCM 서비스워커 등록·웹푸시 구독을 막는다 (헤드리스에서는 어차피 토큰을 못 받는다)
  serviceWorkers: 'block',
};

/**
 * 페이지가 열리기 전에 심는 스크립트.
 * - tel: 링크는 외부 앱으로 나가므로 기본 동작만 막는다 (React onClick 의 SOS API 호출은 그대로 실행됨)
 * - 카카오 우편번호 팝업은 외부 사이트라, 누르면 고정 주소를 돌려주는 가짜로 바꾼다
 */
export function installPageStubs() {
  const address = ADDRESS;
  return (arg: typeof address) => {
    document.addEventListener(
      'click',
      event => {
        const anchor = (event.target as Element | null)?.closest?.('a[href^="tel:"]');
        if (anchor) event.preventDefault();
      },
      true,
    );

    const w = window as unknown as { kakao?: unknown; daum?: unknown };
    class FakePostcode {
      constructor(private readonly options: { oncomplete?: (data: unknown) => void }) {}
      open() {
        this.options.oncomplete?.({
          zonecode: arg.postcode,
          roadAddress: arg.address,
          jibunAddress: arg.address,
          address: arg.address,
          userSelectedType: 'R',
          buildingName: '',
          apartment: 'N',
        });
      }
      embed() {
        this.open();
      }
    }
    w.kakao = { Postcode: FakePostcode };
    w.daum = { Postcode: FakePostcode };
  };
}

export const pageStubArg = ADDRESS;

/**
 * 알려진 환경 장애로 5xx 가 나는 경로를 잠시 제외할 때 쓴다 (정규식). 예: AI 서버 연결 장애 중
 * E2E_IGNORE_5XX='/api/streams/'. 제외한 요청은 리포트의 console.error 에는 그대로 남는다.
 */
const IGNORE_5XX = process.env.E2E_IGNORE_5XX ? new RegExp(process.env.E2E_IGNORE_5XX) : null;

/**
 * 페이지에서 일어난 문제를 모은다.
 * - pageerror(잡히지 않은 JS 예외)와 /api 의 5xx 는 버그로 보고 테스트를 실패시킨다
 * - console.error 는 참고용으로 리포트에만 첨부한다
 */
export class PageWatcher {
  readonly pageErrors: string[] = [];
  readonly serverErrors: string[] = [];
  readonly consoleErrors: string[] = [];

  constructor(readonly label: string) {}

  attach(page: Page) {
    page.on('pageerror', error => this.pageErrors.push(`${error.name}: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') this.consoleErrors.push(message.text().slice(0, 500));
    });
    page.on('response', response => {
      const url = response.url();
      if (response.status() >= 500 && url.includes('/api/') && !(IGNORE_5XX && IGNORE_5XX.test(url))) {
        this.serverErrors.push(`${response.status()} ${response.request().method()} ${url}`);
      }
    });
  }

  async report(testInfo: TestInfo) {
    const sections = [
      ['JS 예외(pageerror)', this.pageErrors],
      ['API 5xx', this.serverErrors],
      ['console.error', this.consoleErrors],
    ] as const;
    const body = sections
      .filter(([, items]) => items.length > 0)
      .map(([title, items]) => `## ${title} (${items.length})\n${[...new Set(items)].join('\n')}`)
      .join('\n\n');
    if (body) {
      await testInfo.attach(`브라우저 로그 - ${this.label}`, { body, contentType: 'text/plain' });
    }
  }
}
