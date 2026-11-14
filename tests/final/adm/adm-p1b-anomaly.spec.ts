/**
 * 최종 QA - 관리자(ADM) P1b: 이상감지 로그 (ADM-A11, N21, N22, N23, N25, N26, N29)
 *
 * 안전:
 *  - 임시 사용자(Owned)만 쓰고, 이상감지 상황·보호자 응답은 이 테스트의 임시 피보호자·보호자 id 로 DB 에 직접 넣는다
 *    (카메라 등록·화재 신호는 보내지 않는다). 끝나면(실패해도) id 로 걸러 지운다.
 *  - 목록·요약은 이 테스트 전용 검색어(피보호자 이름)나 wardId 로 좁혀서 읽는다. 남의 응답 내용은 어디에도 남기지 않는다.
 *  - 이상감지 로그 화면은 다른 회원 정보가 보일 수 있어 trace·영상·스크린샷을 끈다.
 */
import { psql, sqlStr } from '../../../src/remote';
import { auditCount, bodyOf } from './_helpers-adm';
import {
  AnomalySummary, CAM_SIGNAL_ALLOWED, expect, getIncidents, getSummary, IncidentItem, insertFeedback, insertIncident, q, TAGS, test, uniq,
} from './_helpers-adm-p1b';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const ITEM_KEYS = [
  'cameraLabel', 'detectedType', 'detectedTypeLabel', 'durationMinutes', 'eventCount', 'feedbacks', 'incidentId', 'lastDetectedAt',
  'maxConfidence', 'reviewStatus', 'startedAt', 'wardId', 'wardName',
].sort();

test('ADM-A11 이상감지 로그에는 쓰기 주소가 없음', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const ward = owned.user('WARD', { phone: null });
  const incidentId = insertIncident({ wardId: ward.id, review: 'PENDING' });

  // 문서는 "404 또는 405" 로 적었다. 배포 코드는 주소·방식 조합마다 한 코드로 정해진다: 없는 주소(/{id}/review)는 방식과 상관없이 404, 목록 주소(/anomaly)에 GET 말고 다른 방식은 405.
  const calls: { method: 'PATCH' | 'POST' | 'PUT' | 'DELETE'; path: string; status: number }[] = [
    { method: 'PATCH', path: `/api/admin/anomaly/${incidentId}/review`, status: 404 },
    { method: 'PUT', path: `/api/admin/anomaly/${incidentId}/review`, status: 404 },
    { method: 'POST', path: `/api/admin/anomaly/${incidentId}/review`, status: 404 },
    { method: 'DELETE', path: `/api/admin/anomaly/${incidentId}/review`, status: 404 },
    { method: 'POST', path: '/api/admin/anomaly', status: 405 },
    { method: 'PUT', path: '/api/admin/anomaly', status: 405 },
    { method: 'DELETE', path: '/api/admin/anomaly', status: 405 },
  ];
  const seen: string[] = [];
  for (const call of calls) {
    const res = await a.api.raw(call.method, call.path, call.method === 'DELETE' ? undefined : { verdict: 'REAL', reviewStatus: 'REAL' });
    seen.push(`${call.method} ${call.path.replace(String(incidentId), '{id}')} -> ${res.status()}`);
    expect.soft(res.status(), `${call.method} ${call.path.replace(String(incidentId), '{id}')} 은(는) 쓰기 주소가 없어 ${call.status} 이어야 하는데 ${res.status()}`).toBe(call.status);
  }
  test.info().annotations.push({ type: '실측', description: seen.join(' | ') });

  // 판정 상태가 바뀌지 않고, 관리자 판정 기록(감사 로그)도 없다
  expect(psql(`SELECT review_status FROM anomaly_incident WHERE id = ${incidentId};`), '쓰기 시도 뒤에도 판정 상태는 그대로').toBe('PENDING');
  expect(psql(`SELECT count(*) FROM anomaly_incident WHERE id = ${incidentId};`), '쓰기 시도로 상황이 지워지지 않음').toBe('1');
  expect(auditCount({ adminId: admin.id, action: 'ANOMALY_REVIEW_RESOLVE' }), '관리자 판정 감사 로그가 생기면 안 된다').toBe(0);
  const page = await getIncidents(a.api, `wardId=${ward.id}`);
  expect(page.content.map(i => i.reviewStatus)).toEqual(['PENDING']);
});

test('ADM-N21 이상감지 목록 기본과 한 건의 구성', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  // 연결된 보호자가 한 명도 없는 피보호자: 관리자는 연결 여부와 상관없이 본다
  const ward = owned.user('WARD', { phone: null, name: `QA21${tag}` });
  const full = insertIncident({ wardId: ward.id, type: 'FIRE', review: 'PENDING', confidence: 0.87, minutesAgo: 10, spanMinutes: 3, eventCount: 4 });
  const single = insertIncident({ wardId: ward.id, type: 'FALL', review: 'REAL', confidence: 0.7, minutesAgo: 20, spanMinutes: 0, eventCount: 1 });

  // 기본 호출: 필터 없음, page 0, size 20, 최신순
  const list = await getIncidents(a.api, '');
  expect(list.page, '기본 page 는 0').toBe(0);
  expect(list.size, '기본 size 는 20').toBe(20);
  expect(list.content.length, '한 페이지는 20건 이하').toBeLessThanOrEqual(20);
  expect(Object.keys(list).sort(), '페이지 응답의 칸').toEqual(['content', 'last', 'page', 'size', 'totalElements', 'totalPages']);
  const times = list.content.map(i => new Date(i.startedAt).getTime());
  expect(times, '첫 감지 시각이 최신순(내림차순)').toEqual([...times].sort((x, y) => y - x));
  expect(list.totalElements, '전체 건수는 내가 넣은 2건 이상').toBeGreaterThanOrEqual(2);
  // (다른 영역이 같은 시간에 상황을 20건 넘게 만들면 첫 페이지에서 밀릴 수 있어, 첫 페이지 포함 여부는 보지 않고 wardId 필터로 확인한다)

  // 한 건의 구성: 내 피보호자로 좁혀서 칸 이름과 값을 본다 (연결된 보호자가 없어도 관리자 목록에 보임)
  const mine = await getIncidents(a.api, `wardId=${ward.id}`);
  expect(mine.totalElements, '연결 여부와 상관없이 내 상황 2건이 보인다').toBe(2);
  expect(mine.content.map(i => i.incidentId), '최신순').toEqual([full, single]);
  const item = mine.content[0];
  expect(Object.keys(item).sort(), '항목의 칸 이름').toEqual(ITEM_KEYS);
  expect(item.wardId).toBe(ward.id);
  expect(item.wardName).toBe(ward.name);
  expect(item.cameraLabel, '카메라가 없는 상황의 위치는 null').toBeNull();
  expect(item.detectedType).toBe('FIRE');
  expect(item.detectedTypeLabel).toBe('화재');
  expect(item.durationMinutes, '지속 = 마지막 감지 - 첫 감지(분)').toBe(3);
  expect(new Date(item.lastDetectedAt).getTime() - new Date(item.startedAt).getTime()).toBe(3 * 60_000);
  expect(item.eventCount).toBe(4);
  expect(item.maxConfidence).toBeCloseTo(0.87, 5);
  expect(item.reviewStatus).toBe('PENDING');
  expect(item.feedbacks).toEqual([]);
  expect(mine.content[1].durationMinutes, '한 번만 잡힌 상황의 지속은 0').toBe(0);
  expect(mine.content[1].detectedTypeLabel).toBe('낙상');

  // 페이지 크기: 기본 20, 최대 50, 0 이하는 20, 음수 page 는 0
  for (const [query, page, size] of [['size=1000', 0, 50], ['size=50', 0, 50], ['size=0', 0, 20], ['size=1', 0, 1], ['page=-1', 0, 20]] as const) {
    const p = await getIncidents(a.api, query);
    expect(`${query} -> page ${p.page}, size ${p.size}`).toBe(`${query} -> page ${page}, size ${size}`);
    expect(p.content.length).toBeLessThanOrEqual(size);
  }
});

test('ADM-N22 status·wardId·keyword 필터', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const wardA = owned.user('WARD', { phone: null, name: `QA22가${tag}` });
  const wardB = owned.user('WARD', { phone: null, name: `QA22나${tag}` });
  const sessionA = `qa_p1b_${tag}_a`;
  const inc = {
    pendingA: insertIncident({ wardId: wardA.id, review: 'PENDING', sessionId: sessionA }),
    real: insertIncident({ wardId: wardA.id, review: 'REAL', minutesAgo: 1 }),
    fake: insertIncident({ wardId: wardA.id, review: 'FALSE_ALARM', minutesAgo: 2 }),
    conflicted: insertIncident({ wardId: wardA.id, review: 'CONFLICTED', minutesAgo: 3 }),
    pendingB: insertIncident({ wardId: wardB.id, review: 'PENDING', minutesAgo: 4 }),
  };
  const ids = (p: { content: IncidentItem[] }) => p.content.map(i => i.incidentId).sort((x, y) => x - y);
  const sorted = (...n: number[]) => [...n].sort((x, y) => x - y);

  // keyword 로 이 테스트의 두 피보호자(이름에 같은 꼬리표)만 남긴 상태에서 status 4가지
  const scope = `keyword=${q(tag)}`;
  expect(ids(await getIncidents(a.api, `${scope}&status=PENDING`)), 'PENDING').toEqual(sorted(inc.pendingA, inc.pendingB));
  expect(ids(await getIncidents(a.api, `${scope}&status=REAL`)), 'REAL').toEqual(sorted(inc.real));
  expect(ids(await getIncidents(a.api, `${scope}&status=FALSE_ALARM`)), 'FALSE_ALARM').toEqual(sorted(inc.fake));
  expect(ids(await getIncidents(a.api, `${scope}&status=CONFLICTED`)), 'CONFLICTED').toEqual(sorted(inc.conflicted));
  expect(ids(await getIncidents(a.api, scope)), '조건이 이름 검색뿐이면 이름이 맞는 전체').toEqual(sorted(...Object.values(inc)));

  // wardId
  expect(ids(await getIncidents(a.api, `wardId=${wardA.id}`)), 'wardId A').toEqual(sorted(inc.pendingA, inc.real, inc.fake, inc.conflicted));
  expect(ids(await getIncidents(a.api, `wardId=${wardB.id}`)), 'wardId B').toEqual(sorted(inc.pendingB));
  expect(ids(await getIncidents(a.api, `wardId=${wardA.id}&status=PENDING`)), 'wardId A + PENDING').toEqual(sorted(inc.pendingA));

  // keyword: 이름 일부(앞부분·가운데), 대소문자, 맞는 게 없는 검색어
  expect(ids(await getIncidents(a.api, `keyword=${q(`QA22가${tag}`)}`)), '이름 전체로 검색: A 만').toEqual(sorted(inc.pendingA, inc.real, inc.fake, inc.conflicted));
  expect(ids(await getIncidents(a.api, `keyword=${q(`22나${tag}`)}`)), '이름 가운데 일부: B 만').toEqual(sorted(inc.pendingB));
  expect(ids(await getIncidents(a.api, `keyword=${q(`qa22나${tag.toUpperCase()}`)}`)), '대소문자를 가리지 않는다').toEqual(sorted(inc.pendingB));
  const none = await getIncidents(a.api, `keyword=${q(`없는이름${tag}`)}`);
  expect(none.totalElements, '맞는 게 없으면 0건').toBe(0);
  expect(none.content).toEqual([]);

  // 조건 없음 = 전체(내 5건 포함)
  const all = await getIncidents(a.api, 'size=1');
  expect(all.totalElements, '필터가 없으면 전체(내 5건 이상)').toBeGreaterThanOrEqual(5);

  // 잘못된 status 값은 400
  const bad = await bodyOf(await a.api.raw('GET', '/api/admin/anomaly?status=NOPE'));
  expect(bad.status, '알 수 없는 status 값').toBe(400);

  // 카메라 위치(예: 거실) 부분 일치는 카메라 행이 있어야 한다. 카메라 등록은 CAM_SIGNAL_ALLOWED=1 일 때만 만든다.
  if (CAM_SIGNAL_ALLOWED) {
    await test.step('카메라 위치 검색(카메라 행을 직접 넣음)', async () => {
      const label = `거실${tag}`;
      psql(
        `INSERT INTO camera (ward_id, session_id, device_id, label, registered_by, is_active)
         VALUES (${sqlStr(wardA.id)}, ${sqlStr(sessionA)}, ${sqlStr(`qa-p1b-dev-${tag}`)}, ${sqlStr(label)}, ${sqlStr(wardA.id)}, true);`,
      );
      const found = await getIncidents(a.api, `keyword=${q(`거실${tag}`)}`);
      expect(ids(found), '카메라 위치 부분 일치로 그 카메라의 상황만').toEqual(sorted(inc.pendingA));
      expect(found.content[0].cameraLabel).toBe(label);
    });
  } else {
    test.info().annotations.push({ type: '확인 안 함', description: '카메라 위치(거실) 검색은 카메라 등록이 필요해 CAM_SIGNAL_ALLOWED=1 일 때만 확인한다' });
  }
});

test('ADM-N23 흉기·낙상 종류 필터와 표시', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const ward = owned.user('WARD', { phone: null, name: `QA23${tag}` });
  const scope = `keyword=${q(`QA23${tag}`)}`;
  const fire = insertIncident({ wardId: ward.id, type: 'FIRE', review: 'PENDING', confidence: 0.5 });
  const fall = insertIncident({ wardId: ward.id, type: 'FALL', review: 'REAL', confidence: 0.8, minutesAgo: 1 });
  const weapon = insertIncident({ wardId: ward.id, type: 'WEAPON', review: 'FALSE_ALARM', confidence: 0.6, minutesAgo: 2 });

  for (const [type, id, label] of [['WEAPON', weapon, '흉기'], ['FALL', fall, '낙상'], ['FIRE', fire, '화재']] as const) {
    const p = await getIncidents(a.api, `${scope}&type=${type}`);
    expect(p.content.map(i => i.incidentId), `type=${type} 은 그 종류만`).toEqual([id]);
    expect(p.content[0].detectedType).toBe(type);
    expect(p.content[0].detectedTypeLabel, `${type} 표시 문구`).toBe(label);
  }

  // summary byType 에 흉기·낙상도 잡힌다. 유형 탭 건수는 type 조건을 무시하고, 나머지는 고른 type 으로 좁힌다.
  const all: AnomalySummary = await getSummary(a.api, scope);
  expect(all.total).toBe(3);
  const byType = Object.fromEntries(all.byType.map(t => [t.type, { count: t.count, label: t.label }]));
  expect(byType, '종류별 건수와 표시 문구').toEqual({ FIRE: { count: 1, label: '화재' }, FALL: { count: 1, label: '낙상' }, WEAPON: { count: 1, label: '흉기' } });
  const weaponOnly = await getSummary(a.api, `${scope}&type=WEAPON`);
  expect(weaponOnly.total, 'type=WEAPON 으로 좁힌 합계').toBe(1);
  expect(weaponOnly.byType.map(t => t.type).sort(), '유형 탭 건수는 type 조건을 무시').toEqual(['FALL', 'FIRE', 'WEAPON']);
  expect(weaponOnly.review).toEqual({ pending: 0, real: 0, falseAlarm: 1, conflicted: 0 });

  // 잘못된 type 값은 400 (빈 목록으로 오독되지 않게)
  expect((await bodyOf(await a.api.raw('GET', '/api/admin/anomaly?type=NOPE'))).status, '알 수 없는 type 값').toBe(400);

  test.info().annotations.push({
    type: '확인 범위',
    description: '카메라 신호로 흉기·낙상 감지를 만드는 단계는 카메라 등록·신호가 필요해 돌리지 않았다(CAM 영역 전용). 같은 모양의 상황을 DB 에 직접 넣어 목록·종류 필터·표시 문구·요약 집계를 확인했다.',
  });
});

test('ADM-N25 보호자별 응답(feedbacks)과 빈 응답', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const ward = owned.user('WARD', { phone: null, name: `QA25${tag}` });
  const guardians = ['가', '나', '다'].map(s => owned.user('GUARDIAN', { phone: null, name: `QA25보호자${s}${tag}` }));
  const split = insertIncident({ wardId: ward.id, review: 'REAL', minutesAgo: 1 });
  const silent = insertIncident({ wardId: ward.id, review: 'PENDING', minutesAgo: 2 });
  insertFeedback(split, guardians[0].id, 'REAL');
  insertFeedback(split, guardians[1].id, 'REAL');
  insertFeedback(split, guardians[2].id, 'FALSE_ALARM');

  const page = await getIncidents(a.api, `wardId=${ward.id}`);
  const bySplit = page.content.find(i => i.incidentId === split)!;
  const bySilent = page.content.find(i => i.incidentId === silent)!;
  expect(bySplit.reviewStatus, '2:1 은 다수결로 위험').toBe('REAL');
  expect(bySplit.feedbacks.length, '소수 의견까지 응답 3건 전부').toBe(3);
  for (const f of bySplit.feedbacks) {
    expect(Object.keys(f).sort(), '응답 한 건의 칸').toEqual(['guardianId', 'guardianName', 'respondedAt', 'verdict']);
    expect(Number.isNaN(new Date(f.respondedAt).getTime()), '응답 시각은 날짜 형식').toBe(false);
  }
  const byGuardian = Object.fromEntries(bySplit.feedbacks.map(f => [f.guardianId, { name: f.guardianName, verdict: f.verdict }]));
  expect(byGuardian).toEqual({
    [guardians[0].id]: { name: guardians[0].name, verdict: 'REAL' },
    [guardians[1].id]: { name: guardians[1].name, verdict: 'REAL' },
    [guardians[2].id]: { name: guardians[2].name, verdict: 'FALSE_ALARM' },
  });
  expect(bySilent.feedbacks, '아무도 안 답한 건은 null 이 아닌 빈 목록').toEqual([]);
  expect(Array.isArray(bySilent.feedbacks)).toBe(true);
});

test('ADM-N26 summary: 건수·판정 4가지·응답률·AI 신뢰도', TAGS, async ({ owned }) => {
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const ward = owned.user('WARD', { phone: null, name: `QA26${tag}` });
  // 답 없음 2, 진짜 1, 오탐 1, 동수 1
  insertIncident({ wardId: ward.id, review: 'PENDING', confidence: 0.5 });
  insertIncident({ wardId: ward.id, review: 'PENDING', confidence: 0.6, minutesAgo: 1 });
  insertIncident({ wardId: ward.id, review: 'REAL', confidence: 0.9, minutesAgo: 2 });
  insertIncident({ wardId: ward.id, review: 'FALSE_ALARM', confidence: 0.7, minutesAgo: 3 });
  insertIncident({ wardId: ward.id, review: 'CONFLICTED', confidence: 0.6, minutesAgo: 4 });
  const scope = `keyword=${q(`QA26${tag}`)}`;

  const s = await getSummary(a.api, scope);
  expect(Object.keys(s).sort(), '요약의 칸').toEqual(['aiConfidence', 'byType', 'period', 'responseRate', 'review', 'total']);
  expect(s.period, '기간을 안 주면 ALL').toBe('ALL');
  expect(s.total, '총 건수').toBe(5);
  expect(s.review, '판정 4종 전부').toEqual({ pending: 2, real: 1, falseAlarm: 1, conflicted: 1 });
  expect(s.responseRate, '응답률 = (5 - 2) / 5').toBeCloseTo(0.6, 4);
  expect(s.aiConfidence.basis, '신뢰도 분모 = 판정 난 건(위험 + 오탐)').toBe(2);
  expect(s.aiConfidence.average, '신뢰도 = 판정 난 건 최고 신뢰도의 평균 (0.9 + 0.7) / 2').toBeCloseTo(0.8, 4);
  expect(s.byType).toEqual([{ type: 'FIRE', label: '화재', count: 5 }]);

  // 같은 요약이 오늘 기간으로도 같다
  const today = await getSummary(a.api, `${scope}&period=TODAY`);
  expect(today.period).toBe('TODAY');
  expect({ ...today, period: 'ALL' }).toEqual(s);

  // 맞는 상황이 없으면 0%로 채우지 않고 null
  const empty = await getSummary(a.api, `keyword=${q(`없는이름${tag}`)}`);
  expect(empty.total).toBe(0);
  expect(empty.responseRate, '건수 0 이면 응답률은 null').toBeNull();
  expect(empty.aiConfidence, '판정 0건이면 평균은 null').toEqual({ average: null, basis: 0 });
  expect(empty.review).toEqual({ pending: 0, real: 0, falseAlarm: 0, conflicted: 0 });
  expect(empty.byType, '0건 유형은 항목이 없다').toEqual([]);
});

// ─── 화면 ───────────────────────────────────────────────────────────────────

const percent = (v: number | null) => (v === null ? '-' : `${Math.round(v * 100)}%`);

test('ADM-N29 이상감지 로그 화면', TAGS, async ({ owned, openAs }) => {
  test.setTimeout(180_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const tag = uniq();
  const ward = owned.user('WARD', { phone: null, name: `QA29${tag}` });
  const g1 = owned.user('GUARDIAN', { phone: null, name: `QA29보호자가${tag}` });
  const g2 = owned.user('GUARDIAN', { phone: null, name: `QA29보호자나${tag}` });
  // 화재 3건(미판정 2·위험 1), 낙상 1건(오탐), 흉기 1건(의견 충돌)
  insertIncident({ wardId: ward.id, type: 'FIRE', review: 'PENDING', confidence: 0.8 });
  insertIncident({ wardId: ward.id, type: 'FIRE', review: 'REAL', confidence: 0.9, minutesAgo: 1 });
  insertIncident({ wardId: ward.id, type: 'FALL', review: 'FALSE_ALARM', confidence: 0.7, minutesAgo: 2 });
  const conflicted = insertIncident({ wardId: ward.id, type: 'WEAPON', review: 'CONFLICTED', confidence: 0.6, minutesAgo: 3 });
  insertIncident({ wardId: ward.id, type: 'FIRE', review: 'PENDING', confidence: 0.5, minutesAgo: 4 });
  insertFeedback(conflicted, g1.id, 'REAL');
  insertFeedback(conflicted, g2.id, 'FALSE_ALARM');
  const keyword = `QA29${tag}`;

  const apiAll = await getSummary(a.api, `period=TODAY&keyword=${q(keyword)}`);
  expect(apiAll.total, '준비: 오늘 내 상황 5건').toBe(5);

  const page = await openAs(a.who, null);
  await page.goto('/admin/ai-stats');
  await expect(page.getByRole('heading', { level: 1, name: 'AI 통계', exact: true })).toBeVisible();
  await page.getByPlaceholder('이름·방 검색').fill(keyword);

  const cardMap = async () => {
    const texts = await page.getByRole('region', { name: '이상감지 집계' }).locator('> div').allInnerTexts();
    return Object.fromEntries(texts.map(t => t.split('\n').map(x => x.trim()).filter(Boolean)).map(([k, v]) => [k, v]));
  };
  const expectedCards = (s: AnomalySummary) => ({
    감지: `${s.total}건`,
    위험: `${s.review.real}건`,
    오탐: `${s.review.falseAlarm}건`,
    미판정: `${s.review.pending}건`,
    'AI 오탐률': s.aiConfidence.basis > 0 ? percent(s.review.falseAlarm / s.aiConfidence.basis) : '-',
  });
  const tabCounts = async () => {
    const names = await page.getByRole('tablist', { name: '감지 유형 필터' }).getByRole('button').allInnerTexts();
    return names.map(n => n.replace(/\s+/g, ''));
  };

  await test.step('카드 숫자가 summary 와 같다 (직접 세어 둔 값과도 같다)', async () => {
    expect(expectedCards(apiAll), '준비: 직접 센 값').toEqual({ 감지: '5건', 위험: '1건', 오탐: '1건', 미판정: '2건', 'AI 오탐률': '50%' });
    await expect.poll(cardMap, { timeout: 30_000, message: '검색한 뒤 카드 숫자' }).toEqual(expectedCards(apiAll));
    const quality = page.locator('section[class*="responseCard"]');
    await expect(quality).toBeVisible();
    const qualityText = (await quality.innerText()).replace(/\s+/g, '');
    expect(qualityText, '응답률 카드').toContain(`응답률${percent(apiAll.responseRate)}`);
    expect(qualityText, '응답 건수는 전체 - 미판정(동수 포함) 기준, 판정 완료 5-2=3건').toContain('응답3건·미판정2건');
    expect(qualityText, 'AI 신뢰도 카드').toContain(`AI신뢰도${percent(apiAll.aiConfidence.average)}`);
    expect(qualityText, 'AI 신뢰도 기준 건수').toContain('판정2건기준평균');
    expect(percent(apiAll.responseRate)).toBe('60%');
    expect(percent(apiAll.aiConfidence.average)).toBe('80%');
  });

  await test.step('유형 탭 숫자(전체·낙상·화재·흉기)', async () => {
    // 문서: 탭 옆 숫자는 summary 의 유형별 건수와 같아야 한다
    await expect.configure({ soft: true }).poll(tabCounts, { timeout: 15_000, message: '유형 탭 숫자(전체 5, 낙상 1, 화재 3, 흉기 1) - BE 요약의 유형별 항목은 type 칸인데 FE 는 detectedType 칸을 읽는다' }).toEqual(['전체5', '낙상1', '화재3', '흉기1']);
  });

  await test.step('목록과 판정 탭', async () => {
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(5);
    await expect(rows.filter({ hasText: ward.name })).toHaveCount(5);
    await page.getByRole('tablist', { name: '판정 상태 필터' }).getByRole('button', { name: '미판정', exact: true }).click();
    await expect(rows).toHaveCount(2);
    await page.getByRole('tablist', { name: '판정 상태 필터' }).getByRole('button', { name: '의견 충돌', exact: true }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('흉기');
    await page.getByRole('tablist', { name: '판정 상태 필터' }).getByRole('button', { name: '판정 전체', exact: true }).click();
    await expect(rows).toHaveCount(5);
  });

  await test.step('종류를 고르면 카드가 그 종류의 summary 와 같다', async () => {
    const fireSummary = await getSummary(a.api, `period=TODAY&type=FIRE&keyword=${q(keyword)}`);
    await page.getByRole('tablist', { name: '감지 유형 필터' }).getByRole('button', { name: /^화재/ }).click();
    await expect.poll(cardMap, { timeout: 30_000, message: '화재만 고른 뒤 카드 숫자' }).toEqual(expectedCards(fireSummary));
    await expect(page.locator('tbody tr')).toHaveCount(3);
    await expect.configure({ soft: true }).poll(tabCounts, { timeout: 10_000, message: '유형을 골라도 탭 옆 숫자는 그대로' }).toEqual(['전체5', '낙상1', '화재3', '흉기1']);
    await page.getByRole('tablist', { name: '감지 유형 필터' }).getByRole('button', { name: /^전체/ }).click();
    await expect(page.locator('tbody tr')).toHaveCount(5);
  });

  await test.step('이름 검색: 맞는 게 없으면 빈 결과, 다시 지우면 돌아온다', async () => {
    const input = page.getByPlaceholder('이름·방 검색');
    await input.fill(`없는이름${tag}`);
    await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible();
    await input.fill(keyword);
    await expect(page.locator('tbody tr')).toHaveCount(5);
  });

  await test.step('보기 전용: 판정을 바꾸는 버튼이 없다', async () => {
    await page.locator('tbody tr', { hasText: '의견 충돌' }).click();
    const dialog = page.getByRole('dialog', { name: '이상감지 상황 상세' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(g1.name);
    await expect(dialog).toContainText(g2.name);
    await expect(dialog).toContainText('실제 위험');
    await expect(dialog).toContainText('괜찮아요');
    const dialogButtons = (await dialog.getByRole('button').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') ?? e.textContent ?? '').trim())));
    expect(dialogButtons, '상세 창의 버튼은 닫기 하나뿐').toEqual(['닫기']);
    await dialog.getByRole('button', { name: '닫기' }).click();
    await expect(dialog).toBeHidden();
    const allButtons = (await page.getByRole('button').allInnerTexts()).map(t => t.trim());
    expect(allButtons.filter(t => /정정|확정|변경|수정|삭제|판정하기|위험으로|오탐으로/.test(t)), '판정·정정 같은 조작 버튼이 있다(보기 전용이어야 한다)').toEqual([]);
    await expect(page.locator('tbody input, tbody select, tbody textarea')).toHaveCount(0);
  });

  await test.step('기간 버튼(오늘·이번 주·이번 달): 카드 숫자가 같은 기간의 summary 와 같다', async () => {
    // 이틀 전 상황 1건: 기간 없음(전체)에는 들어가고 오늘에서는 빠진다
    insertIncident({ wardId: ward.id, type: 'FIRE', review: 'PENDING', confidence: 0.4, minutesAgo: 2 * 24 * 60 });
    const everything = await getSummary(a.api, `keyword=${q(keyword)}`);
    expect(everything.total, '준비: 기간 없이 보면 이틀 전 상황까지 6건').toBe(6);
    const todayApi = await getSummary(a.api, `period=TODAY&keyword=${q(keyword)}`);
    expect(todayApi.total, '오늘 기간에는 이틀 전 상황이 빠져 5건').toBe(5);
    const periodTabs = page.getByRole('tablist', { name: '이상감지 조회 기간' });
    for (const [label, period] of [['이번 주', 'THIS_WEEK'], ['이번 달', 'THIS_MONTH'], ['오늘', 'TODAY']] as const) {
      const expected = await getSummary(a.api, `period=${period}&keyword=${q(keyword)}`);
      await periodTabs.getByRole('button', { name: label, exact: true }).click();
      await expect.poll(cardMap, { timeout: 30_000, message: `${label} 로 바꾼 뒤 카드 숫자` }).toEqual(expectedCards(expected));
    }
  });

  test.info().annotations.push({
    type: '문서와 차이',
    description: '문서의 "판정 완료"(전체-미판정, 동수 포함)는 화면에서 "응답 N건"으로 보인다. 숫자 기준은 같아 화면 문구를 기준으로 확인했다.',
  });
});
