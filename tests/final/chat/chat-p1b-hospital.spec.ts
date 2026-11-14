/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P1b: 제휴 병원 예약 (보호자 화면 /guardian/hospital → FE BFF → 예약 서비스)
 * 근거: BE 프로젝트_설명.txt 2282-2284, AI 설명서 252-256(예약 흐름 3줄뿐), FE 배포본 a8666240 GuardianHospitalContent·BFF src/app/api/reservation
 * 예약은 임시 보호자·임시 피보호자로 만들고 바로 취소한다. 실패해도 finally 에서 남은 예약을 취소한다.
 */
import type { Page } from '@playwright/test';
import { request } from '@playwright/test';

import { env } from '../../../src/env';
import { expect, expectPageTitle, test } from '../../../src/fixtures';
import { connect } from '../../../src/variables';
import { withdrawQuietly } from './_helpers-chat-p1b';

const TAGS = { tag: ['@P1', '@CHAT'] };

interface ReservationItem {
  reservationId: number;
  status: string;
  hospitalName?: string;
  reservationDate?: string;
  reservationTime?: string;
  patientName?: string;
}

/** FE BFF 로 이 임시 피보호자의 예약 내역을 읽는다 (보호자 토큰 + 피보호자 헤더). 상태 코드와 목록만 돌려준다 */
async function bffReservations(accessToken: string, wardId: string) {
  const ctx = await request.newContext({
    baseURL: env.baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'x-sb-ward-id': wardId },
  });
  try {
    const res = await ctx.get('/api/reservation/reservations/my');
    const body = res.status() === 200 ? await res.json() : null;
    const data = body?.data?.data ?? body?.data ?? body;
    return { status: res.status(), items: (Array.isArray(data) ? data : []) as ReservationItem[] };
  } finally {
    await ctx.dispose();
  }
}

/** 남아 있는 활성 예약을 BFF 로 모두 취소한다 (정리용). 취소한 개수를 돌려준다 */
async function cancelActiveReservations(accessToken: string, wardId: string): Promise<number> {
  const { items } = await bffReservations(accessToken, wardId);
  const ctx = await request.newContext({
    baseURL: env.baseUrl,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}`, 'x-sb-ward-id': wardId },
  });
  let cancelled = 0;
  try {
    for (const item of items.filter(i => i.status === 'BOOKED' || i.status === 'CONFIRMED')) {
      const res = await ctx.patch(`/api/reservation/reservations/${item.reservationId}/cancel`);
      if (res.status() === 200) cancelled++;
    }
  } finally {
    await ctx.dispose();
  }
  return cancelled;
}

/** 날짜 칸에서 오늘이 아니고 휴진도 아닌 날을 차례로 눌러 보며, 빈 시간이 있는 날의 시간을 하나 고른다 */
async function pickDayAndTime(page: Page) {
  const days = page.getByRole('region', { name: '날짜' }).getByRole('button', { name: /^(?!.*(오늘|휴진)).+/ });
  const total = await days.count();
  for (let i = 0; i < total; i++) {
    const day = days.nth(i);
    if (!(await day.isEnabled())) continue;
    await day.click();
    const timeRegion = page.getByRole('region', { name: '시간' });
    await expect(timeRegion).toBeVisible();
    // 시간 칸이 불러오기를 마칠 때까지: 불러오는 중 문구가 사라지고 버튼이나 "없어요" 안내가 나온다
    await expect(timeRegion.getByText('예약할 수 있는 시간을 확인하는 중이에요.')).toHaveCount(0, { timeout: 30_000 });
    const free = timeRegion.locator('button:not([disabled])');
    if ((await free.count()) > 0) {
      await free.first().click();
      return;
    }
  }
  throw new Error('예약할 수 있는 날·시간을 찾지 못했습니다 (병원 진료 시간 밖이거나 모두 마감).');
}

test.describe('CHAT P1b - 제휴 병원 예약', () => {
  test('CHAT-N23 [부분 확인 - 화면 예약만, 챗 경로·환자 정보 정리는 수동 확인] 실제 병원 예약 후 즉시 취소', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(240_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);
    try {
      const page = await openAs(guardian.who, '/guardian/hospital');
      await expectPageTitle(page, '병원 예약');
      await expect(page.getByText('예약 현황')).toBeVisible();
      await expect(page.getByText('잡혀 있는 예약이 없어요')).toBeVisible();

      await page.getByRole('button', { name: '새 진료 예약하기' }).click();
      const hospital = page.locator('button[class*="hospitalRow"]:not([disabled])').first();
      await expect(hospital, '지금 예약을 받는 병원').toBeVisible({ timeout: 30_000 });
      const hospitalName = (await hospital.locator('[class*="hospitalName"]').innerText()).trim();
      await hospital.click();

      // 진료과가 여럿이면 첫 진료과를 고른다
      const dept = page.getByRole('region', { name: '진료과' });
      if (await dept.count()) await dept.getByRole('button').first().click();
      await pickDayAndTime(page);
      await page.getByRole('button', { name: '다음' }).click();

      await expect(page.getByText('이대로 예약할까요?')).toBeVisible();
      await expect(page.getByRole('group', { name: '진료받으실 분과 연락처' })).toContainText(`${wardUser.name} 님`);
      await page.getByRole('button', { name: '예약하기' }).click();
      await expect(page.getByText('예약했어요')).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: '확인' }).click();

      // 예약 내역에 보이고, 서버(예약 서비스)에도 BOOKED 로 한 건 있다
      const next = page.getByRole('group', { name: '다음 진료' });
      await expect(next).toBeVisible();
      await expect(next).toContainText(hospitalName);
      await expect(page.getByRole('heading', { name: /예약 현황/ })).toContainText('1건');
      const booked = await bffReservations(guardian.login.accessToken, wardUser.id);
      expect(booked.status).toBe(200);
      const active = booked.items.filter(i => i.status === 'BOOKED' || i.status === 'CONFIRMED');
      expect(active, '활성 예약').toHaveLength(1);
      expect(active[0].hospitalName).toBe(hospitalName);
      const reservationId = active[0].reservationId;

      // 바로 취소
      await next.getByRole('button', { name: /예약 취소$/ }).click();
      const dialog = page.getByRole('dialog', { name: '이 예약을 취소할까요?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(hospitalName);
      await dialog.getByRole('button', { name: '예약 취소' }).click();
      await expect(page.getByText('예약을 취소했어요.')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('잡혀 있는 예약이 없어요')).toBeVisible();
      await expect(page.getByRole('heading', { name: /예약 현황/ })).toContainText('0건');

      const after = await bffReservations(guardian.login.accessToken, wardUser.id);
      const cancelled = after.items.find(i => i.reservationId === reservationId);
      expect(cancelled?.status, '취소한 예약 상태').toBe('CANCELED');
      expect(after.items.filter(i => i.status === 'BOOKED' || i.status === 'CONFIRMED'), '남은 활성 예약').toEqual([]);
      test.info().annotations.push({
        type: '부분 확인 - 수동 확인 필요',
        description: '이 테스트가 통과해도 케이스 N23 은 완전 통과가 아니다. (1) 케이스는 "챗으로 예약을 끝까지 진행"인데 챗 대화 경로는 실제 예약·Claude 호출이 얽혀 자동화하지 않고 보호자 병원 예약 화면의 예약과 취소만 확인했다(챗 경로는 수동 확인). ' +
          '(2) "환자 정보 정리"는 기준이 문서에 없어 단언하지 않았다(확인 필요). (3) 예약 서비스에 남는 임시 계정과 취소된 예약 행은 정리 목록에 올린다.',
      });
      test.info().annotations.push({
        type: '확인 범위',
        description: '문서에 예약 흐름이 3줄뿐(AI 설명서 252-256)이라 챗 대화가 아니라 보호자 병원 예약 화면(FE 배포본)의 예약→취소로 확인했다. ' +
          '환자 정보 정리: 예약 서비스의 취소(ReservationService.cancel)는 상태만 CANCELED 로 바꾸고 환자 이름·번호 행은 지우지 않는다' +
          `(취소 뒤 예약 목록 응답에 환자 이름 필드가 ${cancelled?.patientName ? '그대로 남아 있다' : '없어 지워졌는지는 이 경로로 알 수 없다'}). ` +
          '이 테스트가 만든 예약 서비스 계정·취소된 예약 행은 예약 서비스 안에 남는다(임시 이름·임시 번호 대역 값). 문서에 "환자 정보 정리"의 구체적 기준이 없어 확인 필요.',
      });
    } finally {
      const left = await cancelActiveReservations(guardian.login.accessToken, wardUser.id);
      if (left > 0) console.warn(`정리: 남은 예약 ${left}건을 취소했습니다.`);
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });

  test('CHAT-N24 처음 쓰는 보호자도 병원 예약 첫 화면이 열린다', TAGS, async ({ tempUser, loginAs, openAs }) => {
    test.setTimeout(180_000);
    const guardianUser = await tempUser('GUARDIAN');
    const wardUser = await tempUser('WARD');
    connect(guardianUser.id, wardUser.id);
    const guardian = await loginAs(guardianUser);
    const ward = await loginAs(wardUser);
    try {
      // 예약 서비스에 이 피보호자 계정이 아직 없다. 화면이 병원 목록과 예약 내역을 동시에 부른다
      const page = await openAs(guardian.who, null);
      const reservationCalls: Array<{ path: string; status: number }> = [];
      page.on('response', response => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/reservation/')) reservationCalls.push({ path: url.pathname, status: response.status() });
      });
      await page.goto('/guardian/hospital');
      await expectPageTitle(page, '병원 예약');
      await expect(page.getByRole('button', { name: '새 진료 예약하기' })).toBeVisible();
      await expect(page.getByText('잡혀 있는 예약이 없어요')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('지난 진료가 없어요')).toBeVisible();
      // 오류 안내가 없다 (Next 의 경로 안내 영역도 role=alert 라서 오류 문구와 다시 불러오기 버튼으로 본다)
      await expect(page.getByRole('button', { name: '다시 불러오기' }), '다시 불러오기 버튼(오류 화면)').toHaveCount(0);
      const bodyText = await page.locator('body').innerText();
      expect(bodyText, '예약 서비스 오류 문구').not.toMatch(/연결하지 못했어요|요청을 처리하지 못했어요|쓸 수 없어요|로그인이 끝났어요/);

      expect(reservationCalls.length, '예약 서비스 호출').toBeGreaterThanOrEqual(2);
      expect(reservationCalls.map(c => c.status), `예약 서비스 호출 상태 (${reservationCalls.map(c => c.path.replace('/api/reservation', '')).join(', ')})`)
        .toEqual(reservationCalls.map(() => 200));
      expect(reservationCalls.some(c => c.path.endsWith('/hospitals')), '병원 목록 호출').toBe(true);
      expect(reservationCalls.some(c => c.path.endsWith('/reservations/my')), '예약 내역 호출').toBe(true);
      // 계정 준비 호출이 화면 응답에 보이면 첫 화면을 여는 동안 1번만이어야 한다 (보이지 않으면 아래 annotation 에 부분 확인으로 적는다)
      const prepCalls = reservationCalls.filter(c => /credential|account|register|ensure|signup|sign-up/i.test(c.path));
      if (prepCalls.length > 0) expect(prepCalls.length, `계정 준비 호출 횟수 (${prepCalls.map(c => c.path).join(', ')})`).toBe(1);

      // 다시 열어도(이미 만들어진 계정) 같다
      await page.reload();
      await expect(page.getByText('잡혀 있는 예약이 없어요')).toBeVisible({ timeout: 30_000 });
      expect(reservationCalls.every(c => c.status === 200), '다시 열었을 때도 모두 200').toBe(true);
      test.info().annotations.push({
        type: '부분 확인',
        description: `"계정 준비가 1회로 끝난다"는 ${prepCalls.length > 0 ? `화면 응답에서 계정 준비 호출 ${prepCalls.length}번을 세어 확인했다` : '화면 응답에 계정 준비 호출이 보이지 않아(서버 안 BFF 에서만 일어남) 횟수를 세지 못했다. 부분 확인으로 센다'}. 본 호출 경로: ${[...new Set(reservationCalls.map(c => c.path.replace('/api/reservation', '')))].join(', ')}.`,
      });
      test.info().annotations.push({
        type: '확인 범위',
        description: '예약 서비스 계정을 몇 번 만드는지는 서버 안(BFF)에서만 보일 수 있다. 화면이 동시에 부르는 두 요청이 모두 200 이고 오류 안내가 없는 것으로 "1회로 끝나 첫 화면이 열린다"를 본다.',
      });
    } finally {
      await withdrawQuietly(ward.api, wardUser.password);
    }
  });
});
