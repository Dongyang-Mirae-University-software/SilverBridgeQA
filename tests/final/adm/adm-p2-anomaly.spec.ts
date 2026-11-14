/**
 * 최종 QA - 관리자(ADM) P2: 안전 대시보드 · 이상감지 로그
 *
 * 안전:
 *  - 임시 사용자(tempUser)만 쓴다. 이상감지 상황은 임시 피보호자 id 로 DB 에 직접 넣고(카메라 신호·AI 호출 없음),
 *    끝나면(실패해도) 그 id 의 행만 지운다. 목록·요약은 임시 피보호자 이름(검색어)으로 좁혀서 본다.
 *  - 감사 로그도 이 임시 관리자 id 것만 지운다.
 *  - 실패 메시지에는 상태 코드·개수만 넣는다.
 */
import {
  auditCountOf, bodyOf, deleteAuditOf, deleteIncidentsOf, enc, expect, expectCode, getBody, insertIncidentsAt, kstBoundaries,
  psqlOne, settle, TAGS, test, uniq, waitOutKstMidnight,
} from './_helpers-adm-p2';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

interface Summary {
  period: string;
  total: number;
  byType: { type: string; label: string; count: number }[];
  review: { pending: number; real: number; falseAlarm: number; conflicted: number };
  responseRate: number | null;
  aiConfidence: { average: number | null; basis: number };
}

const nowIso = (minutesAgo = 1) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

test('ADM-N20 대시보드 열람은 감사 로그를 남기지 않음', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  const auditRowsOfAdmin = () => Number(psqlOne(`SELECT count(*) FROM admin_audit_log WHERE admin_id = '${admin.id}';`));
  const readRound = async (round: string) => {
    for (const path of [
      '/api/admin/dashboard/safety',
      '/api/admin/dashboard/operation',
      '/api/admin/dashboard/ai-status',
      '/api/admin/anomaly?size=5',
      '/api/admin/anomaly/summary?period=TODAY',
      '/api/admin/notification?size=5',
      '/api/admin/notification/summary',
    ]) {
      for (let i = 0; i < 3; i++) {
        const res = await getBody(a.api, path);
        expect(res.status, `${round}: ${path.split('?')[0]} 응답 상태 ${res.status}`).toBe(200);
      }
    }
  };

  // 1) 읽기만 여러 번: 이 관리자 이름으로 남은 기록이 없어야 한다
  await readRound('읽기 1차');
  const afterReads = await settle(auditRowsOfAdmin, count => count > 0, 4_000);
  expect(afterReads, '조회만 했는데 관리자 활동 기록이 생겼다').toBe(0);

  // 2) 대조: 쓰기 조작(공지 작성·삭제)은 기록이 남는다(위 0 이 "기록이 늦게 와서"가 아님을 확인)
  const created = await bodyOf(await a.api.raw('POST', '/api/admin/announcement/create', { title: `QAP2N20${tag} 확인용`, content: '확인용 본문' }));
  expect(created.status, `대조: 공지 작성 응답 상태 ${created.status}`).toBe(200);
  const del = await bodyOf(await a.api.raw('DELETE', `/api/admin/announcement/delete/${created.json.data.id}`));
  expect(del.status, `대조: 공지 삭제 응답 상태 ${del.status}`).toBe(200);
  await expect.poll(auditRowsOfAdmin, { timeout: 20_000, message: '쓰기 조작의 기록 수' }).toBe(2);

  // 3) 다시 읽어도 쓰기 기록 2건 그대로
  await readRound('읽기 2차');
  const finalCount = await settle(auditRowsOfAdmin, count => count !== 2, 4_000);
  expect(finalCount, '읽기를 더 했더니 기록 수가 달라졌다(쓰기 2건만 있어야 한다)').toBe(2);
  expect(auditCountOf(admin.id, 'ANNOUNCEMENT_CREATE') + auditCountOf(admin.id, 'ANNOUNCEMENT_DELETE'), '기록은 공지 작성·삭제 두 건뿐').toBe(2);
});

test('ADM-N24 period 4종과 한국 시간 경계', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(240_000);
  await waitOutKstMidnight();
  const tag = uniq();
  const name = `QA기간${tag}`;
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { name, phone: null });
  const a = await signIn(admin);
  later(() => deleteIncidentsOf([ward.id]));
  later(() => deleteAuditOf([admin.id]));

  // 오늘·이번 주(월요일)·이번 달(1일) 시작 시각 정각과, 그 1분 전(일요일 23:59 · 말일 23:59 등)에 상황을 하나씩 둔다
  const b = kstBoundaries();
  const spec = [
    { key: 'todayAt', ms: b.today },
    { key: 'todayBefore', ms: b.today - 60_000 },
    { key: 'weekAt', ms: b.week },
    { key: 'weekBefore', ms: b.week - 60_000 },
    { key: 'monthAt', ms: b.month },
    { key: 'monthBefore', ms: b.month - 60_000 },
  ];
  const ids = insertIncidentsAt(
    ward.id,
    spec.map(s => ({ session: `qa-p2n24-${tag}-${s.key}`, startedAt: new Date(s.ms).toISOString() })),
  );
  const idOf = (key: string) => ids[`qa-p2n24-${tag}-${key}`];
  const expected = (from: number) => spec.filter(s => s.ms >= from).map(s => idOf(s.key)).sort((x, y) => x - y);
  const cases: { period: string | null; apiPeriod: string; from: number }[] = [
    { period: 'TODAY', apiPeriod: 'TODAY', from: b.today },
    { period: 'THIS_WEEK', apiPeriod: 'THIS_WEEK', from: b.week },
    { period: 'THIS_MONTH', apiPeriod: 'THIS_MONTH', from: b.month },
    { period: 'ALL', apiPeriod: 'ALL', from: -Infinity },
    { period: null, apiPeriod: 'ALL', from: -Infinity }, // 생략하면 전체
  ];

  for (const c of cases) {
    const query = `keyword=${enc(name)}&size=50${c.period ? `&period=${c.period}` : ''}`;
    const label = c.period ?? '(생략)';
    const list = await getBody(a.api, `/api/admin/anomaly?${query}`);
    expect(list.status, `${label} 목록 응답 상태 ${list.status}`).toBe(200);
    const got = (list.json.data.content as { incidentId: number }[]).map(item => item.incidentId).sort((x, y) => x - y);
    expect(got, `${label}: 기간에 들어와야 할 상황(경계 시각 포함)`).toEqual(expected(c.from));

    const sum = await getBody(a.api, `/api/admin/anomaly/summary?keyword=${enc(name)}${c.period ? `&period=${c.period}` : ''}`);
    expect(sum.status, `${label} 요약 응답 상태 ${sum.status}`).toBe(200);
    const s = sum.json.data as Summary;
    expect(s.period, `${label}: 요약이 돌려주는 기간 값`).toBe(c.apiPeriod);
    expect(s.total, `${label}: 요약 total 은 목록과 같은 건수`).toBe(expected(c.from).length);
  }
});

test('ADM-N27 summary: 0건일 때 null, 탭 숫자는 type 조건 무시', TAGS, async ({ tempUser, signIn, later }) => {
  test.setTimeout(180_000);
  const tag = uniq();
  const name = `QA요약${tag}`;
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { name, phone: null });
  const a = await signIn(admin);
  later(() => deleteIncidentsOf([ward.id]));
  later(() => deleteAuditOf([admin.id]));
  insertIncidentsAt(ward.id, [
    { session: `qa-p2n27-${tag}-1`, type: 'FIRE', review: 'REAL', confidence: 0.8, startedAt: nowIso(2) },
    { session: `qa-p2n27-${tag}-2`, type: 'FIRE', review: 'FALSE_ALARM', confidence: 0.6, startedAt: nowIso(3) },
    { session: `qa-p2n27-${tag}-3`, type: 'FALL', review: 'PENDING', confidence: 0.5, startedAt: nowIso(4) },
  ]);
  const summary = async (query: string) => {
    const res = await getBody(a.api, `/api/admin/anomaly/summary?keyword=${enc(name)}${query}`);
    expect(res.status, `요약(${query || '조건 없음'}) 응답 상태 ${res.status}`).toBe(200);
    return res.json.data as Summary;
  };
  const tabs = (s: Summary) => s.byType.map(t => `${t.type}:${t.count}`);

  await test.step('조건에 맞는 상황이 0건: 비율·평균은 0 이 아니라 null', async () => {
    const none = await getBody(a.api, `/api/admin/anomaly/summary?keyword=${enc(`QA없는이름${tag}`)}`);
    expect(none.status, `0건 요약 응답 상태 ${none.status}`).toBe(200);
    const s = none.json.data as Summary;
    expect(s.total).toBe(0);
    expect(s.byType, '0건 종류는 항목 자체가 없다').toEqual([]);
    expect(s.review).toEqual({ pending: 0, real: 0, falseAlarm: 0, conflicted: 0 });
    expect(s.responseRate, '0건이면 응답률은 null').toBeNull();
    expect(s.aiConfidence, '0건이면 AI 신뢰도 평균은 null, 기준 0건').toEqual({ average: null, basis: 0 });
  });

  await test.step('type 없이: 전체 숫자', async () => {
    const s = await summary('');
    expect(s.total).toBe(3);
    expect(tabs(s), '탭 숫자(많은 순)').toEqual(['FIRE:2', 'FALL:1']);
    expect(s.review).toEqual({ pending: 1, real: 1, falseAlarm: 1, conflicted: 0 });
    expect(s.responseRate, '응답률 = (3-1)/3').toBeCloseTo(0.6667, 4);
    expect(s.aiConfidence.basis, '판정 난 2건').toBe(2);
    expect(s.aiConfidence.average, '판정 난 두 건의 평균 신뢰도').toBeCloseTo(0.7, 4);
  });

  await test.step('type=FIRE: 숫자는 화재로 좁히되 탭 숫자는 그대로', async () => {
    const s = await summary('&type=FIRE');
    expect(s.total, '화재만 센다').toBe(2);
    expect(tabs(s), '다른 탭(낙상)이 0 이 되거나 빠지면 안 된다').toEqual(['FIRE:2', 'FALL:1']);
    expect(s.review).toEqual({ pending: 0, real: 1, falseAlarm: 1, conflicted: 0 });
    expect(s.responseRate).toBe(1);
    expect(s.aiConfidence.basis).toBe(2);
  });

  await test.step('type=WEAPON(0건): 비율·평균 null, 탭 숫자는 그대로, 흉기 항목은 없다', async () => {
    const s = await summary('&type=WEAPON');
    expect(s.total).toBe(0);
    expect(tabs(s), '탭 숫자는 type 조건을 무시하고 센다').toEqual(['FIRE:2', 'FALL:1']);
    expect(s.byType.some(t => t.type === 'WEAPON'), '0건 종류는 항목이 없다').toBe(false);
    expect(s.review).toEqual({ pending: 0, real: 0, falseAlarm: 0, conflicted: 0 });
    expect(s.responseRate).toBeNull();
    expect(s.aiConfidence).toEqual({ average: null, basis: 0 });
  });

  await test.step('type=FALL(미판정 1건뿐): 응답률은 0, 평균은 null', async () => {
    const s = await summary('&type=FALL');
    expect(s.total).toBe(1);
    expect(s.responseRate, '응답이 한 건도 없으면 null 이 아니라 0').toBe(0);
    expect(s.aiConfidence).toEqual({ average: null, basis: 0 });
    expect(tabs(s)).toEqual(['FIRE:2', 'FALL:1']);
  });
});

test('ADM-A09 동수(conflicted)는 위험 목록에서 빼고 판정 완료는 total-pending', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(300_000);
  await waitOutKstMidnight();
  const tag = uniq();
  const name = `QA동수${tag}`;
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { name, phone: null });
  const a = await signIn(admin);
  later(() => deleteIncidentsOf([ward.id]));
  later(() => deleteAuditOf([admin.id]));

  const rowsFor = (n: string) => [
    { session: `qa-p2a09-${tag}-${n}-c`, type: 'FIRE' as const, review: 'CONFLICTED' as const, confidence: 0.7, startedAt: nowIso(2) },
    { session: `qa-p2a09-${tag}-${n}-r`, type: 'FIRE' as const, review: 'REAL' as const, confidence: 0.9, startedAt: nowIso(3) },
    { session: `qa-p2a09-${tag}-${n}-p`, type: 'FIRE' as const, review: 'PENDING' as const, confidence: 0.5, startedAt: nowIso(4) },
  ];

  // 1) 대시보드 "오늘 이상감지": 이 3건을 더하면 전체 3, 동수 +1, 위험 +1, 미판정 +1 (공용 집계라 다른 곳이 동시에 바꾸면 3번까지 다시 잰다)
  const today = async () => {
    const res = await getBody(a.api, '/api/admin/dashboard/safety');
    expect(res.status, `안전 현황 응답 상태 ${res.status}`).toBe(200);
    return res.json.data.todayAnomaly as { total: number; review: Summary['review'] };
  };
  let note = '';
  let dashboardOk = false;
  for (let attempt = 1; attempt <= 3 && !dashboardOk; attempt++) {
    const before = await today();
    insertIncidentsAt(ward.id, rowsFor(`d${attempt}`));
    const after = await today();
    deleteIncidentsOf([ward.id]);
    const delta = {
      total: after.total - before.total,
      conflicted: after.review.conflicted - before.review.conflicted,
      real: after.review.real - before.review.real,
      pending: after.review.pending - before.review.pending,
      falseAlarm: after.review.falseAlarm - before.review.falseAlarm,
    };
    note = `시도 ${attempt}: 대시보드 증가분 ${JSON.stringify(delta)} (기대 total 3, conflicted 1, real 1, pending 1, falseAlarm 0)`;
    dashboardOk = delta.total === 3 && delta.conflicted === 1 && delta.real === 1 && delta.pending === 1 && delta.falseAlarm === 0;
  }
  test.info().annotations.push({ type: '실측', description: note });
  expect(dashboardOk, `대시보드 숫자가 기대와 다르다. ${note}`).toBe(true);

  // 2) 이상감지 로그 API: 동수는 '위험' 목록(REAL)에 없고, 판정 결과 숫자에만 보인다
  const ids = insertIncidentsAt(ward.id, rowsFor('s'));
  const conflictedId = ids[`qa-p2a09-${tag}-s-c`];
  const realId = ids[`qa-p2a09-${tag}-s-r`];
  const listOf = async (status: string) => {
    const res = await getBody(a.api, `/api/admin/anomaly?keyword=${enc(name)}&period=TODAY&status=${status}&size=50`);
    expect(res.status, `status=${status} 목록 응답 상태 ${res.status}`).toBe(200);
    return (res.json.data.content as { incidentId: number }[]).map(item => item.incidentId);
  };
  expect(await listOf('REAL'), "'위험' 목록에는 진짜 위험 1건만").toEqual([realId]);
  expect(await listOf('CONFLICTED'), '동수는 동수 목록에서만').toEqual([conflictedId]);

  const sum = await getBody(a.api, `/api/admin/anomaly/summary?keyword=${enc(name)}&period=TODAY`);
  expect(sum.status).toBe(200);
  const s = sum.json.data as Summary;
  expect(s.review, '판정 결과 숫자').toEqual({ pending: 1, real: 1, falseAlarm: 0, conflicted: 1 });
  const answered = s.total - s.review.pending;
  expect(answered, "'판정 완료' = total - pending (동수 포함)").toBe(2);
  expect(answered, '판정 완료는 real + falseAlarm + conflicted').toBe(s.review.real + s.review.falseAlarm + s.review.conflicted);
  expect(s.responseRate, '응답률 바 = 판정 완료 / total').toBeCloseTo(answered / s.total, 4);

  // 3) 화면: 같은 숫자가 보인다
  const page = await openAs(a.who, null);
  await page.goto('/admin/ai-stats');
  await expect(page.getByRole('heading', { level: 1, name: 'AI 통계', exact: true })).toBeVisible();
  await page.getByPlaceholder('이름·방 검색').fill(name);
  await expect(page.getByText('응답 2건 · 미판정 1건'), "화면의 '응답 N건' 은 total - pending").toBeVisible();
  await expect(page.getByRole('region', { name: '이상감지 집계' }).getByText('67%'), '응답률(AI 오탐률 칸이 아니라 응답률 칸)').toHaveCount(0);
  await expect(page.getByText('67%').first(), '응답률 67%').toBeVisible();
  const rows = page.locator('tbody tr');
  await expect(rows, '내 상황 3건').toHaveCount(3);
  await expect(rows.filter({ hasText: '의견 충돌' }), '동수는 판정 열에 의견 충돌로').toHaveCount(1);
  await expect(rows.filter({ hasText: '위험' }).filter({ hasNotText: '의견 충돌' }), "'위험' 행은 진짜 위험 1건").toHaveCount(1);
});

test('ADM-A12 이상감지 필터 값 오류와 상한', TAGS, async ({ tempUser, signIn, later }) => {
  const tag = uniq();
  const admin = await tempUser('ADMIN');
  const a = await signIn(admin);
  later(() => deleteAuditOf([admin.id]));

  // 문서에 코드명이 없어 배포 코드로 고정: enum 값이 아니면 400 INVALID_INPUT, 보정하지 않는다
  for (const query of ['status=XYZ', 'type=GUN', 'period=YEAR', 'status=', 'type=fire']) {
    const list = await getBody(a.api, `/api/admin/anomaly?${query}`);
    if (query === 'status=') {
      // 빈 값은 "조건 없음"으로 읽는다
      expect(list.status, `${query} 응답 상태 ${list.status}`).toBe(200);
    } else {
      expectCode(list, 400, 'INVALID_INPUT', `목록 ${query}`);
    }
  }
  for (const query of ['type=GUN', 'period=YEAR']) {
    expectCode(await getBody(a.api, `/api/admin/anomaly/summary?${query}`), 400, 'INVALID_INPUT', `요약 ${query}`);
  }
  expectCode(await getBody(a.api, '/api/admin/anomaly?page=abc'), 400, 'INVALID_INPUT', '목록 page=abc');

  // wardId 는 형식 검사가 없다: 없는 id 는 오류가 아니라 빈 결과
  const ward = await getBody(a.api, `/api/admin/anomaly?wardId=abc`);
  expect(ward.status, `wardId=abc 응답 상태 ${ward.status}`).toBe(200);
  expect(ward.json.data.totalElements, '없는 wardId 는 0건').toBe(0);
  expect(ward.json.data.content).toEqual([]);

  // 크기·쪽 보정 (size 최대 50, 0 이하는 20, 음수 page 는 0)
  const size = async (query: string) => {
    const res = await getBody(a.api, `/api/admin/anomaly?${query}`);
    expect(res.status, `${query} 응답 상태 ${res.status}`).toBe(200);
    return res.json.data as { size: number; page: number; content: unknown[] };
  };
  expect((await size('size=0')).size, 'size=0').toBe(20);
  expect((await size('size=1000')).size, 'size=1000 은 50').toBe(50);
  expect((await size('size=1000')).content.length, '한 쪽 50건 이하').toBeLessThanOrEqual(50);
  const neg = await size('page=-1');
  expect(neg.page, 'page=-1 은 0 쪽').toBe(0);
  expect(neg.size, 'size 생략은 20').toBe(20);
  expect((await size(`keyword=${enc(`QA없는이름${tag}`)}&size=-5`)).size, 'size=-5 는 20').toBe(20);
});

test('ADM-A13 감지 낙상 0건이 안전으로 보이지 않음', TAGS, async ({ tempUser, signIn, openAs, later }) => {
  test.setTimeout(240_000);
  await waitOutKstMidnight();
  const tag = uniq();
  const name = `QA낙상${tag}`;
  const admin = await tempUser('ADMIN');
  const ward = await tempUser('WARD', { name, phone: null });
  const a = await signIn(admin);
  later(() => deleteIncidentsOf([ward.id]));
  later(() => deleteAuditOf([admin.id]));
  insertIncidentsAt(ward.id, [{ session: `qa-p2a13-${tag}`, type: 'FIRE', review: 'REAL', confidence: 0.9, startedAt: nowIso(2) }]);

  // API: 낙상을 한 번도 감지하지 못한 기간의 byType 에는 FALL 항목 자체가 없다(0 으로 채우지 않는다)
  const sum = await getBody(a.api, `/api/admin/anomaly/summary?keyword=${enc(name)}&period=TODAY`);
  expect(sum.status, `요약 응답 상태 ${sum.status}`).toBe(200);
  const s = sum.json.data as Summary;
  expect(s.byType.map(t => `${t.type}:${t.count}`), '낙상이 없는 기간의 byType').toEqual(['FIRE:1']);
  expect(JSON.stringify(s.byType), 'FALL 이라는 글자가 응답에 있으면 안 된다').not.toContain('FALL');

  // 화면: '낙상' 탭 옆 숫자는 0 이 아니라 '-', 유형별 오탐률 카드도 '판정된 상황 없음'
  const page = await openAs(a.who, null);
  await page.goto('/admin/ai-stats');
  await expect(page.getByRole('heading', { level: 1, name: 'AI 통계', exact: true })).toBeVisible();
  await page.getByPlaceholder('이름·방 검색').fill(name);
  const typeTabs = page.getByRole('tablist', { name: '감지 유형 필터' });
  await expect(typeTabs.getByRole('button', { name: /^전체/ }).locator('b'), '전체 탭은 내 1건').toHaveText('1');
  // 아래 한 줄이 실패하면 제품 결함: 응답의 종류별 칸 이름은 type 인데 화면(AdminAiStatsContent.tsx 71행)은 detectedType 으로 찾아
  // 있는 종류도 '-' 로 그린다. 그러면 '낙상 -' 가 "없음"인지 "못 읽음"인지 구분이 안 된다. 나머지 단언은 계속 확인한다.
  await expect.soft(typeTabs.getByRole('button', { name: /^화재/ }).locator('b'), '감지된 화재 1건이 탭 숫자 1 로 보여야 한다').toHaveText('1');
  test.info().annotations.push({
    type: '재확인 필요',
    description: "낙상·흉기 '-' 단언은 지금 화면 결함(모든 종류가 '-')에서도 통과한다. FE 수정 뒤 화재 탭이 1 로 보이는 상태에서 낙상·흉기 '-' 를 다시 확인해야 '안전으로 안 보임' 을 확인한 것이 된다.",
  });
  await expect(typeTabs.getByRole('button', { name: /^낙상/ }).locator('b'), "낙상 탭 숫자는 0 이 아니라 '-'").toHaveText('-');
  await expect(typeTabs.getByRole('button', { name: /^흉기/ }).locator('b'), "흉기 탭 숫자도 '-'").toHaveText('-');

  const rates = page.getByRole('heading', { name: '유형별 오탐률' }).locator('xpath=..');
  await expect(rates.getByText('판정된 상황 없음'), '낙상·흉기 카드는 판정된 상황 없음').toHaveCount(2);
  await expect(rates.getByText('판정 1건 중 오탐 0건'), '화재 카드만 판정 기준이 있다').toHaveCount(1);
  // 판정이 없는 두 카드(낙상·흉기)의 오탐률 칸은 0% 가 아니라 '-' (화재 카드만 실제 값 0% 를 가진다)
  await expect(rates.locator('strong').filter({ hasText: /^-$/ }), "판정 없는 카드의 오탐률은 '-'").toHaveCount(2);
  await expect(rates.locator('strong').filter({ hasText: /^0%$/ }), "'0%' 는 판정이 있는 화재 카드 하나뿐").toHaveCount(1);
});
