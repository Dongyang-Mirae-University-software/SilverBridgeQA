/**
 * 최종 QA - 관리자(ADM) P1b: 운영 대시보드 (ADM-N17, ADM-N18)
 *
 * 안전: 임시 사용자만 쓴다. 운영 현황 숫자는 서비스 전체 값이라 다른 영역이 동시에 가입을 만들면 흔들리므로,
 * "내 임시 사용자 행 하나를 바꾸고 바로 다시 읽어" 그 차이(delta)만 비교하고, 어긋나면 처음부터 3번까지 다시 잰다.
 * 문의·가입 시각·연결 요청은 이 테스트의 임시 사용자 행만 만들고 끝나면(실패해도) 지운다.
 */
import { psql, sqlStr } from '../../../src/remote';
import { bodyOf } from './_helpers-adm';
import {
  avoidKstMidnight, count, expect, insertConnection, KST_TODAY_START, kstDate, Operation, readOperation, setUserFields, TAGS, test, uniq,
} from './_helpers-adm-p1b';

test.use({ trace: 'off', video: 'off', screenshot: 'off' });

const byDate = (trend: Operation['signupTrend']) => new Map(trend.map(p => [p.date, p.count]));

test('ADM-N17 운영 현황 숫자와 날짜 경계(한국 시간)', TAGS, async ({ owned }) => {
  test.setTimeout(420_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  await avoidKstMidnight();

  const tag = uniq();
  const guardian = owned.user('GUARDIAN', { phone: null, name: `QA17보호자${tag}` });
  const ward = owned.user('WARD', { phone: null, name: `QA17피보호자${tag}` });
  const restricted = owned.user('GUARDIAN', { phone: null, status: 'RESTRICTED', name: `QA17정지${tag}` });
  const admin2 = owned.user('ADMIN', { phone: null, name: `QA17관리자${tag}` });
  const mine = [guardian, ward, restricted, admin2].map(u => sqlStr(u.id)).join(', ');
  const today = kstDate(0);
  const yesterday = kstDate(-1);

  /** 한 번의 측정 순서. 어긋난 항목 설명을 모아 돌려준다(없으면 통과) */
  const sequence = async (): Promise<string[]> => {
    const bad: string[] = [];
    const diff = (label: string, actual: number, expected: number) => {
      if (actual !== expected) bad.push(`${label}: 변화 ${actual} (기대 ${expected})`);
    };
    // 처음 상태: 네 명 모두 30일 전에 가입한 것으로 두고, 보호자는 이용 중, 대기 중 연결 없음
    psql(
      `UPDATE users SET created_at = now() - interval '30 days' WHERE id IN (${mine});
       UPDATE users SET status = 'ACTIVE' WHERE id = ${sqlStr(guardian.id)};
       DELETE FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`,
    );
    const r0 = await readOperation(a.api);

    // 1) 네 명이 오늘 가입: 관리자와 정지 계정은 빠지고 이용 중인 보호자·피보호자만 센다
    psql(`UPDATE users SET created_at = now() WHERE id IN (${mine});`);
    const r1 = await readOperation(a.api);
    diff('오늘 가입 4명(관리자 1·정지 1 포함) 중 센 수', r1.newUsersToday - r0.newUsersToday, 2);
    diff('전체 회원 수 변화(가입 시각만 바꿨으므로 0)', r1.totalUsers - r0.totalUsers, 0);
    diff('가입 추이 오늘 칸', (byDate(r1.signupTrend).get(today) ?? NaN) - (byDate(r0.signupTrend).get(today) ?? NaN), 2);

    // 2) 피보호자 가입 시각을 한국 시간 어제 23:59:59 로: 오늘 신규에서 빠지고 어제 칸으로 간다
    setUserFields(ward.id, `created_at = ${KST_TODAY_START} - interval '1 second'`);
    const r2 = await readOperation(a.api);
    diff('어제 23:59:59 가입: 오늘 신규 변화', r2.newUsersToday - r1.newUsersToday, -1);
    diff('어제 23:59:59 가입: 어제 칸 변화', (byDate(r2.signupTrend).get(yesterday) ?? NaN) - (byDate(r1.signupTrend).get(yesterday) ?? NaN), 1);
    diff('어제 23:59:59 가입: 오늘 칸 변화', (byDate(r2.signupTrend).get(today) ?? NaN) - (byDate(r1.signupTrend).get(today) ?? NaN), -1);
    diff('어제 23:59:59 가입: 전체 회원 수 변화', r2.totalUsers - r1.totalUsers, 0);

    // 3) 한국 시간 오늘 00:00:00 정각: 오늘 신규에 들어온다
    setUserFields(ward.id, `created_at = ${KST_TODAY_START}`);
    const r3 = await readOperation(a.api);
    diff('오늘 00:00:00 가입: 오늘 신규 변화', r3.newUsersToday - r2.newUsersToday, 1);
    diff('오늘 00:00:00 가입: 오늘 칸 변화', (byDate(r3.signupTrend).get(today) ?? NaN) - (byDate(r2.signupTrend).get(today) ?? NaN), 1);

    // 4) 보호자 한 명을 정지: 전체 회원 수와 보호자 수가 1씩 줄고, 다시 풀면 돌아온다 (정지 계정은 전체에서 빠짐)
    setUserFields(guardian.id, `status = 'RESTRICTED'`);
    const r4 = await readOperation(a.api);
    diff('정지: 전체 회원 수 변화', r4.totalUsers - r3.totalUsers, -1);
    diff('정지: 보호자 수 변화', r4.memberComposition.guardians - r3.memberComposition.guardians, -1);
    diff('정지: 피보호자 수 변화', r4.memberComposition.wards - r3.memberComposition.wards, 0);
    diff('정지: 오늘 신규 변화', r4.newUsersToday - r3.newUsersToday, -1);
    setUserFields(guardian.id, `status = 'ACTIVE'`);
    const r5 = await readOperation(a.api);
    diff('정지 해제: 전체 회원 수 변화', r5.totalUsers - r4.totalUsers, 1);
    diff('정지 해제: 보호자 수 변화', r5.memberComposition.guardians - r4.memberComposition.guardians, 1);

    // 5) 수락 대기 연결 1건: 대기 연결 수와 처리 대기 항목이 함께 1 늘고, 지우면 돌아온다
    insertConnection(guardian.id, ward.id, 'PENDING', '아들');
    const r6 = await readOperation(a.api);
    diff('대기 연결 수 변화', r6.pendingConnections - r5.pendingConnections, 1);
    diff('처리 대기 항목의 연결 요청 변화', r6.pendingItems.connectionRequests - r5.pendingItems.connectionRequests, 1);
    psql(`DELETE FROM connection WHERE guardian_id = ${sqlStr(guardian.id)} AND ward_id = ${sqlStr(ward.id)};`);
    const r7 = await readOperation(a.api);
    diff('대기 연결 삭제 뒤 변화', r7.pendingConnections - r6.pendingConnections, -1);
    return bad;
  };

  let bad: string[] = [];
  let attempts = 0;
  for (; attempts < 3; attempts++) {
    bad = await sequence();
    if (!bad.length) break;
  }
  test.info().annotations.push({ type: '실측', description: `시도 ${Math.min(attempts + 1, 3)}번, 어긋난 항목 ${bad.length}개${bad.length ? ': ' + bad.join(' | ') : ''}` });
  expect(bad, `운영 현황 숫자가 기대와 다르다(마지막 시도): ${bad.join(' | ')}`).toEqual([]);

  // 응답 모양: 필드 전체, 상한 3(끄면 null 은 서버 설정이라 직접 바꾸지 못함), 생성 시각은 한국 시간 오프셋
  const op = await readOperation(a.api);
  expect(Object.keys(op).sort(), '운영 현황 응답의 최상위 칸').toEqual(
    ['cameras', 'generatedAt', 'memberComposition', 'newUsersToday', 'pendingConnections', 'pendingItems', 'signupTrend', 'totalUsers', 'unansweredInquiries'].sort(),
  );
  expect(Object.keys(op.memberComposition).sort()).toEqual(['guardians', 'wards']);
  expect(Object.keys(op.cameras).sort()).toEqual(['maxTotal', 'registered', 'wards']);
  expect(op.cameras.maxTotal, '카메라 등록 상한(camera.max-total 기본 3)').toBe(3);
  expect(op.cameras.registered, '카메라 대수는 0 이상 정수').toBeGreaterThanOrEqual(0);
  expect(op.cameras.wards, '카메라를 단 피보호자 수는 카메라 대수 이하').toBeLessThanOrEqual(op.cameras.registered);
  expect(Object.keys(op.pendingItems).sort()).toEqual(['announcementDrafts', 'connectionRequests', 'todayInquiries']);
  expect(op.pendingItems.connectionRequests, '처리 대기의 연결 요청은 대기 연결 수와 같다').toBe(op.pendingConnections);
  expect(op.generatedAt, '생성 시각은 한국 시간(+09:00) 오프셋').toMatch(/\+09:00$/);
  expect(Math.abs(Date.now() - new Date(op.generatedAt).getTime()), '생성 시각은 지금과 2분 안').toBeLessThan(120_000);
  test.info().annotations.push({
    type: '문서와 차이',
    description: '문서는 전체 회원 수가 관리자만 제외한다고도, 정지 계정도 빠진다고도 적어 서로 다르다. 배포 코드는 이용 중(ACTIVE)이면서 관리자가 아닌 회원만 센다(정지 계정 제외)로 고정했다. 상한을 끄면 null 인 경우는 서버 설정이라 직접 못 바꿔 확인하지 않음.',
  });
});

test('ADM-N18 기다리는 문의 없으면 대기시간 null, 가입 추이는 0으로 채움', TAGS, async ({ owned }) => {
  test.setTimeout(300_000);
  const admin = owned.user('ADMIN', { phone: null });
  const a = await owned.login(admin);
  const guardian = owned.user('GUARDIAN', { phone: null });
  const g = await owned.login(guardian);
  await avoidKstMidnight();
  const todayStart = KST_TODAY_START;

  // 1) 모양 규칙: 대기 문의가 없을 때만 대기 시간이 null (0 이 아님), 가입 추이는 7일 모두 있음
  const first = await readOperation(a.api);
  expect(first.unansweredInquiries.count, '미답변 건수는 0 이상').toBeGreaterThanOrEqual(0);
  if (first.unansweredInquiries.count === 0) {
    expect(first.unansweredInquiries.longestWaitingHours, '미답변이 0건이면 대기 시간은 null (0 이 아님)').toBeNull();
  } else {
    expect(first.unansweredInquiries.longestWaitingHours, '미답변이 있으면 대기 시간은 숫자').not.toBeNull();
    expect(first.unansweredInquiries.longestWaitingHours!).toBeGreaterThanOrEqual(0);
  }
  test.info().annotations.push({
    type: first.unansweredInquiries.count === 0 ? '확인 범위' : '확인 안 함',
    description: first.unansweredInquiries.count === 0
      ? '미답변 0건이라 대기 시간 null 을 값으로 직접 확인함'
      : `미확인: 미답변 null 단언(핵심 기대값)은 이번 실행에서 검사되지 않음. dev 에 미답변 ${first.unansweredInquiries.count}건이 이미 있어(다른 사람 문의라 답변·삭제 못 함) 대기 시간 null 은 값으로 직접 못 봄. 숫자인지만 확인함`,
  });

  // 2) 가입 추이: 7칸, 날짜는 한국 시간 오늘까지 이어지는 7일, 칸마다 DB 집계와 같음(가입 없는 날은 0)
  const days = [-6, -5, -4, -3, -2, -1, 0].map(kstDate);
  const dbCounts = () => {
    const rows = psql(
      `SELECT to_char(created_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD'), count(*) FROM users
       WHERE status = 'ACTIVE' AND role <> 'ADMIN' AND created_at >= ${todayStart} - interval '6 days' GROUP BY 1;`,
    );
    const map = new Map<string, number>();
    for (const line of rows ? rows.split('\n') : []) {
      const [date, n] = line.split('|');
      map.set(date, Number(n));
    }
    return map;
  };
  // 이 임시 보호자를 3일 전 가입으로 옮겨, 그 날 칸에 반영되는지도 본다
  setUserFields(guardian.id, `created_at = ${todayStart} - interval '3 days' + interval '12 hours'`);
  let mismatch: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const op = await readOperation(a.api);
    const db = dbCounts();
    mismatch = [];
    if (op.signupTrend.length !== 7) mismatch.push(`칸 수 ${op.signupTrend.length}`);
    op.signupTrend.forEach((p, i) => {
      if (p.date !== days[i]) mismatch.push(`${i + 1}번째 날짜 어긋남`);
      if (!Number.isInteger(p.count) || p.count < 0) mismatch.push(`${p.date} 값이 정수 아님`);
      if (p.count !== (db.get(p.date) ?? 0)) mismatch.push(`${p.date}: API ${p.count} / DB ${db.get(p.date) ?? 0}`);
    });
    if (!mismatch.length) break;
  }
  expect(mismatch, `가입 추이가 7일 모두 있고 DB 집계와 같아야 한다: ${mismatch.join(' | ')}`).toEqual([]);
  {
    const zeroDays = (await readOperation(a.api)).signupTrend.filter(p => p.count === 0).map(p => p.date);
    test.info().annotations.push({
      type: zeroDays.length ? '확인 범위' : '확인 안 함',
      description: zeroDays.length
        ? `가입 0인 날 ${zeroDays.length}일이 실제로 있어 '0으로 채움'을 값으로 확인함`
        : `미확인: 7일 모두 가입이 1건 이상이라 '가입 없는 날 0 채움'은 이번 실행에서 검사되지 않음`,
    });
  }
  const threeDaysAgo = kstDate(-3);
  const trend = byDate((await readOperation(a.api)).signupTrend);
  expect(trend.get(threeDaysAgo), '3일 전으로 옮긴 임시 보호자가 그 날 칸에 센다(1 이상)').toBeGreaterThanOrEqual(1);

  // 3) 문의를 바로 늘리면 값이 바로 반영 (저장해 둔 값이 아님): 5시간 전에 접수된 문의 한 건 -> 새 문의 한 건(API)
  const sequence = async (): Promise<string[]> => {
    const bad: string[] = [];
    psql(`DELETE FROM inquiry WHERE user_id = ${sqlStr(guardian.id)};`);
    const r0 = await readOperation(a.api);
    psql(
      `INSERT INTO inquiry (user_id, category, title, content, status, created_at, updated_at)
       VALUES (${sqlStr(guardian.id)}, 'ETC', '[QA-ADMIN] N18 오래된 문의', '임시', 'WAITING', now() - interval '5 hours', now() - interval '5 hours');`,
    );
    const r1 = await readOperation(a.api);
    if (r1.unansweredInquiries.count - r0.unansweredInquiries.count !== 1) {
      bad.push(`오래된 문의 추가 후 미답변 변화 ${r1.unansweredInquiries.count - r0.unansweredInquiries.count} (기대 1)`);
    }
    if (r1.unansweredInquiries.longestWaitingHours === null) bad.push('문의가 있는데 대기 시간이 null');
    else if (r1.unansweredInquiries.longestWaitingHours < 5) bad.push(`대기 시간 ${r1.unansweredInquiries.longestWaitingHours}시간 (5시간 전 문의가 있으니 5 이상이어야 함)`);
    const created = await bodyOf(
      await g.api.raw('POST', '/api/guardian/inquiry', { category: 'ETC', title: '[QA-ADMIN] N18 새 문의', content: '임시 문의입니다.' }),
    );
    if (created.status !== 200) bad.push(`문의 작성 응답 ${created.status} (기대 200)`);
    const r2 = await readOperation(a.api);
    if (r2.unansweredInquiries.count - r1.unansweredInquiries.count !== 1) {
      bad.push(`새 문의 작성 후 미답변 변화 ${r2.unansweredInquiries.count - r1.unansweredInquiries.count} (기대 1, 값이 바로 반영돼야 함)`);
    }
    if (r2.pendingItems.todayInquiries - r1.pendingItems.todayInquiries !== 1) {
      bad.push(`새 문의 작성 후 오늘 접수 문의 변화 ${r2.pendingItems.todayInquiries - r1.pendingItems.todayInquiries} (기대 1)`);
    }
    return bad;
  };
  let bad: string[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    bad = await sequence();
    if (!bad.length) break;
  }
  expect(bad, `문의가 늘면 운영 현황이 바로 따라가야 한다: ${bad.join(' | ')}`).toEqual([]);
  expect(count(`SELECT count(*) FROM inquiry WHERE user_id = ${sqlStr(guardian.id)} AND status = 'WAITING';`), '준비: 내 임시 문의 2건').toBe(2);
});
