/**
 * 접근성 QA: 주요 화면을 axe-core 로 WCAG 2.1 A/AA 기준 자동 점검한다.
 *
 * - 대비비율, 스크린리더용 이름(라벨·대체 텍스트), 문서 언어·제목, 키보드 포커스 관련 규칙을 본다.
 * - 화면마다 위반 규칙을 soft 단언으로 모아 한 번에 보여준다(위반이 있으면 실패).
 * - 읽기만 한다. 버튼을 누르거나 값을 저장하지 않는다.
 * - 브라우저별 실행: npm run test:flow:chrome / test:flow:edge 에 함께 포함된다.
 */
import AxeBuilder from '@axe-core/playwright';
import { Page } from '@playwright/test';

import { expect, test } from '../../src/fixtures';

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

const PUBLIC_PAGES: [name: string, path: string][] = [
  ['로그인', '/login'],
  ['회원가입', '/signup'],
  ['아이디 찾기', '/find-email'],
  ['비밀번호 찾기', '/find-password'],
];

const GUARDIAN_PAGES: [name: string, path: string][] = [
  ['대시보드', '/guardian'],
  ['SOS 이력', '/guardian/sos'],
  ['이상감지', '/guardian/detection'],
  ['정서 상태 체크', '/guardian/emotion'],
  ['AI 의료 챗봇', '/guardian/chatbot'],
  ['피보호자 관리', '/guardian/wards'],
  ['복약 관리', '/guardian/medication'],
  ['병원 예약', '/guardian/hospital'],
  ['화면 송출', '/guardian/stream'],
  ['공지사항', '/guardian/notices'],
  ['문의하기', '/guardian/inquiries'],
  ['환경설정', '/guardian/settings'],
];

const WARD_PAGES: [name: string, path: string][] = [
  ['홈', '/ward'],
  ['긴급 전화', '/ward/sos'],
  ['복약 알림', '/ward/medication'],
  ['내 보호자', '/ward/guardians'],
  ['공지사항', '/ward/notices'],
  ['환경설정', '/ward/settings'],
];

interface PageResult {
  page: string;
  violations: { rule: string; impact: string | null; nodes: number; help: string; sample: string }[];
}

async function audit(page: Page, pages: [string, string][], role: string): Promise<PageResult[]> {
  const results: PageResult[] = [];
  for (const [name, path] of pages) {
    await test.step(`${role} ${name}`, async () => {
      await page.goto(path);
      // 역할 가드와 데이터 로딩이 끝날 때까지 잠깐 기다린다
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
      const axe = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze();
      const violations = axe.violations.map(v => ({
        rule: v.id,
        impact: v.impact ?? null,
        nodes: v.nodes.length,
        help: v.help,
        sample: (v.nodes[0]?.target ?? []).join(' ').slice(0, 120),
      }));
      results.push({ page: `${role} ${name} (${path})`, violations });
      expect
        .soft(
          violations.map(v => `${v.impact} ${v.rule} x${v.nodes}`),
          `${role} ${name}: WCAG 2.1 A/AA 위반 ${violations.length}종`,
        )
        .toEqual([]);
    });
  }
  return results;
}

async function report(results: PageResult[], label: string) {
  const body = JSON.stringify(results, null, 1);
  await test.info().attach(`axe 결과 - ${label}`, { body, contentType: 'application/json' });
  console.log(`A11Y_JSON ${label} ${JSON.stringify(results)}`);
}

test.describe('접근성(WCAG 2.1 A/AA)', () => {
  test('로그인 전 화면', async ({ openAs }) => {
    const page = await openAs('anonymous', null);
    await report(await audit(page, PUBLIC_PAGES, '공개'), '공개');
  });

  test('보호자 화면', async ({ openAs }) => {
    test.setTimeout(240_000);
    const page = await openAs('guardian1', null);
    await report(await audit(page, GUARDIAN_PAGES, '보호자'), '보호자');
  });

  test('피보호자 화면', async ({ openAs }) => {
    test.setTimeout(180_000);
    const page = await openAs('ward1', null);
    await report(await audit(page, WARD_PAGES, '피보호자'), '피보호자');
  });
});
