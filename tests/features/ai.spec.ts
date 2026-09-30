/**
 * AI 서버 연동 화면: 챗봇, 이상감지 모니터, 화면 송출(미리보기까지), 게임
 * AI 응답은 매번 달라서 내용이 아니라 "응답이 오고 오류 안내가 없는지"를 본다.
 */
import { expect, expectPageTitle, test } from '../../src/fixtures';

test.describe('AI 의료 챗봇', () => {
  test('질문을 보내면 AI 답변이 온다', async ({ openAs }) => {
    test.setTimeout(180_000);
    const page = await openAs('guardian1', '/guardian/chatbot');
    await expect(page.getByRole('heading', { name: 'AI 의료 챗봇', level: 1 })).toBeVisible();

    const question = '혈압약은 식전과 식후 중 언제 먹는 게 좋나요?';
    await page.getByPlaceholder('궁금한 점을 입력하세요...').fill(question);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/streams/v1/chat') && r.request().method() === 'POST', {
        timeout: 150_000,
      }),
      page.getByRole('button', { name: '전송' }).click(),
    ]);
    expect(response.status(), 'AI 챗 API 응답').toBe(200);
    await expect(page.getByText(question)).toBeVisible();
    await expect(page.getByText(/일시적인 오류/)).toHaveCount(0);
    await expect(page.getByText(/AI 서버가 응답하지 않아/)).toHaveCount(0);
  });

  test('다시 들어오면 이전 대화 기록을 불러온다', async ({ openAs }) => {
    test.info().annotations.push({
      type: 'issue',
      description: 'chat/logs?userId=e2eg01 → 422. FE 는 문자열 회원 ID 를 보내는데 AI 서버는 숫자 userId 를 기대, 게다가 전송 시엔 userId: 1 하드코딩 (GuardianChatContent.tsx:244)',
    });
    const page = await openAs('guardian1', null);
    const [logs] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/streams/v1/chat/logs')),
      page.goto('/guardian/chatbot'),
    ]);
    expect(logs.status(), 'GET /api/streams/v1/chat/logs').toBe(200);
  });
});

test.describe('이상감지 모니터', () => {
  test('라이브 세션 목록을 불러온다', async ({ openAs }) => {
    const page = await openAs('guardian1', null);
    const [list] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/streams/v1/live-streams')),
      page.goto('/guardian/detection'),
    ]);
    await expectPageTitle(page, '이상감지');
    expect(list.status()).toBe(200);
  });
});

test.describe('화면 송출', () => {
  test('카메라 미리보기를 켜면 영상이 나온다 (가짜 카메라)', async ({ openAs }) => {
    const page = await openAs('guardian1', '/guardian/stream');
    await expectPageTitle(page, '화면 송출');
    await page.context().grantPermissions(['camera', 'microphone']);

    await page.getByRole('button', { name: /정면 카메라/ }).click();
    await expect(page.getByRole('button', { name: /정면 카메라/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: /카메라 미리보기 켜기/ }).click();

    await expect.poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(2);
    await expect(page.getByText('카메라 켜짐').first()).toBeVisible();
    await page.getByRole('button', { name: '미리보기 끄기' }).click();
    await expect(page.getByText('아직 미리보기가 꺼져 있어요')).toBeVisible();
  });
});

test.describe('치매 예방 게임', () => {
  test('피보호자 게임 화면에서 게임을 바꿔 가며 불러온다', async ({ openAs }) => {
    const page = await openAs('ward1', '/ward/game');
    await expectPageTitle(page, '치매 예방 게임');
    const frame = page.locator('iframe[title="치매 예방 게임"]');
    await expect(frame).toBeVisible();
    const tabs = page.getByRole('tablist', { name: '게임 선택' }).getByRole('tab');
    await expect(tabs).toHaveCount(4);
    const first = await frame.getAttribute('src');
    await tabs.nth(1).click();
    await expect(frame).not.toHaveAttribute('src', first ?? '');
    await expect(frame).toHaveAttribute('src', /gameSlug=/);
  });

  test('보호자 게임 관리 화면이 열린다', async ({ openAs }) => {
    const page = await openAs('guardian1', '/guardian/game');
    await expectPageTitle(page, '게임 관리');
  });
});

test.describe('공지사항', () => {
  for (const [key, path] of [['guardian1', '/guardian/notices'], ['ward1', '/ward/notices']] as const) {
    test(`${key === 'guardian1' ? '보호자' : '피보호자'} 공지사항 화면에 최신 공지 또는 빈 안내가 보인다`, async ({ openAs }) => {
      const page = await openAs(key, path);
      await expectPageTitle(page, '공지사항');
      await expect(page.getByRole('heading', { level: 2 }).or(page.getByText(/공지사항이 없습니다|등록된 공지/)).first())
        .toBeVisible();
    });
  }
});
