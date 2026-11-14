/**
 * 최종 QA - 챗봇·대시보드·말벗(CHAT) P2: 관리자 제휴 병원 관리 (/api/admin/hospital, BE -> 예약 서비스 중계)
 * 근거: BE 프로젝트_설명.txt 2358-2394, AdminHospitalController·AdminHospitalService·AdminHospital*Request(작업 트리 = dev 배포본)
 * 임시 관리자로만 부른다. 만든 병원은 끝날 때 관리자 API 로 지운다(소프트 삭제 - 지운 행은 예약 서비스에 남는다).
 * 이 관리자의 감사 로그(admin_audit_log)는 admin_id 로 거른 행만 읽고, 끝날 때 그 행만 지운다.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { expect, test } from '../../../src/fixtures';
import {
  auditCount, auditRows, callFull, cleanupChat, HOSPITAL_API, HospitalScope, hospitalBody, listByQuery, loginSafe, marker, TAGS,
} from './_helpers-chat-p2';
import type { LoggedIn } from './_helpers-chat-p2';

const MISSING_ID = 2_000_000_000; // 정수 범위 안이지만 있을 수 없는 번호

interface Ctx {
  admin: LoggedIn;
  scope: HospitalScope;
  /** 이 테스트의 표식 */
  s: string;
  call: (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) => ReturnType<typeof callFull>;
}

async function withAdmin(tempUser: (role: 'ADMIN') => Promise<any>, body: (ctx: Ctx) => Promise<void>) {
  const admin = await loginSafe(await tempUser('ADMIN'));
  const scope = new HospitalScope(admin);
  const s = marker('');
  try {
    await body({ admin, scope, s, call: (method, path, data) => callFull(admin.api, method, path, data, 60_000) });
  } finally {
    const warnings = await scope.cleanup();
    expect.soft(warnings, '병원 정리 중 문제').toEqual([]);
    test.info().annotations.push({
      type: '정리 목록',
      description: `예약 서비스에 소프트 삭제 행으로 남은 병원 id: ${scope.softDeletedIds.length ? scope.softDeletedIds.join(', ') : '(없음)'}. 지운 병원·진료과는 예약 서비스에서 행이 지워지지 않는다(BE 로는 되살릴 수 없고 예약 서비스 담당이 정리한다).`,
    });
  }
}

const names = (res: { json: any }) => (res.json?.data?.content ?? []).map((h: { name: string }) => h.name) as string[];

test.describe('CHAT P2 - 관리자 제휴 병원 관리', () => {
  test.afterEach(async () => {
    await cleanupChat(test.info());
  });

  test('CHAT-N28 병원 목록 검색·필터·페이징', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    await withAdmin(tempUser, async ({ admin, scope, s, call }) => {
      const region = `QA구${s}`;
      const otherRegion = `QA타구${s}`;
      const dOrtho = `QA정형${s}`;
      const dInternal = `QA내과${s}`;
      const dEye = `QA안과${s}`;
      const a = await scope.create(hospitalBody(`${s}a`, { region, departments: [dOrtho, dInternal] }));
      const b = await scope.create(hospitalBody(`${s}b`, { region, departments: [dInternal] }));
      const c = await scope.create(hospitalBody(`${s}c`, { region: otherRegion, departments: [dEye] }));
      for (const [label, res] of [['a', a], ['b', b], ['c', c]] as const) expect(res.status, `병원 ${label} 등록`).toBe(201);
      const nameA = a.json.data.name as string;
      const nameB = b.json.data.name as string;
      const nameC = c.json.data.name as string;

      // 이름 검색: 세 곳이 등록 최신순
      const all = await listByQuery(admin.api, s);
      expect(all.status).toBe(200);
      expect(names(all), 'q=표식 (등록 최신순)').toEqual([nameC, nameB, nameA]);
      expect(all.json.data.totalElements).toBe(3);
      // 지역·주소에도 맞는다 (대소문자·공백 무시)
      expect(names(await listByQuery(admin.api, ` qa구${s.toUpperCase()} `)), 'q=지역(공백·대소문자 무시)').toEqual([nameB, nameA]);
      // 지역 필터
      expect(names(await listByQuery(admin.api, s, `&region=${encodeURIComponent(region)}`)), 'region 필터').toEqual([nameB, nameA]);
      // 진료과 필터: 이름이 같아야 한다
      expect(names(await listByQuery(admin.api, s, `&department=${encodeURIComponent(dOrtho)}`)), 'department=정형').toEqual([nameA]);
      expect(names(await listByQuery(admin.api, s, `&department=${encodeURIComponent(dInternal)}`)), 'department=내과').toEqual([nameB, nameA]);
      expect(names(await listByQuery(admin.api, s, `&department=${encodeURIComponent(dInternal.slice(0, -2))}`)), '진료과 이름 일부는 맞지 않는다').toEqual([]);
      // 조합
      expect(
        names(await listByQuery(admin.api, s, `&region=${encodeURIComponent(otherRegion)}&department=${encodeURIComponent(dEye)}`)),
        'q+region+department',
      ).toEqual([nameC]);
      expect(names(await listByQuery(admin.api, s, `&region=${encodeURIComponent(otherRegion)}&department=${encodeURIComponent(dOrtho)}`)), '조합이 맞지 않으면 비어 있다').toEqual([]);

      // 페이징: size=1 로 한 곳씩
      const one = async (page: number) => callFull(admin.api, 'GET', `${HOSPITAL_API}?q=${encodeURIComponent(s)}&size=1&page=${page}`, undefined, 60_000);
      const p0 = await one(0);
      expect(names(p0), 'size=1 page=0').toEqual([nameC]);
      expect(p0.json.data.totalElements).toBe(3);
      expect(p0.json.data.totalPages).toBe(3);
      expect(names(await one(1)), 'size=1 page=1').toEqual([nameB]);
      expect(names(await one(2)), 'size=1 page=2').toEqual([nameA]);
      expect(names(await one(3)), 'size=1 page=3 (마지막 뒤)').toEqual([]);
      // 크기 상한 50, 0 이하는 기본 20
      const big = await callFull(admin.api, 'GET', `${HOSPITAL_API}?q=${encodeURIComponent(s)}&size=500`, undefined, 60_000);
      expect(big.json.data.size, 'size=500 -> 상한').toBe(50);
      const zero = await callFull(admin.api, 'GET', `${HOSPITAL_API}?q=${encodeURIComponent(s)}&size=0`, undefined, 60_000);
      expect(zero.json.data.size, 'size=0 -> 기본').toBe(20);

      // 사용 중지한 진료과·삭제한 병원은 목록에 없다
      const hospitalA = all.json.data.content[2];
      const orthoId = hospitalA.departments.find((d: { name: string }) => d.name === dOrtho).id as number;
      const delDept = await call('DELETE', `${HOSPITAL_API}/${hospitalA.id}/department/${orthoId}`);
      expect(delDept.status, '진료과 삭제').toBe(200);
      expect(names(await listByQuery(admin.api, s, `&department=${encodeURIComponent(dOrtho)}`)), '삭제한 진료과로는 더 못 찾는다').toEqual([]);
      const afterDept = await listByQuery(admin.api, s);
      expect(afterDept.json.data.content[2].departments.map((d: { name: string }) => d.name), '남은 진료과').toEqual([dInternal]);
      const delHospital = await call('DELETE', `${HOSPITAL_API}/${b.json.data.id}`);
      expect(delHospital.status, '병원 삭제').toBe(200);
      scope.forget(b.json.data.id);
      expect(names(await listByQuery(admin.api, s)), '삭제한 병원은 목록에 없다').toEqual([nameC, nameA]);

      // 요약
      const summary = await call('GET', `${HOSPITAL_API}/summary`);
      expect(summary.status).toBe(200);
      expect(Object.keys(summary.json.data).sort(), '요약 칸').toEqual(['bookingAvailable', 'latestRegisteredAt', 'total']);
      expect(summary.json.data.total, '전체 병원 수는 우리가 만든 2곳 이상').toBeGreaterThanOrEqual(2);
      expect(summary.json.data.bookingAvailable).toBeLessThanOrEqual(summary.json.data.total);
      expect(typeof summary.json.data.latestRegisteredAt, '가장 최근 등록 시각').toBe('string');

      // 조회는 감사 로그를 남기지 않는다 (위의 쓰기만 남는다)
      const before = auditCount(admin.user.id);
      await listByQuery(admin.api, s);
      await call('GET', `${HOSPITAL_API}/summary`);
      expect(auditCount(admin.user.id), '조회 뒤 감사 로그 수').toBe(before);
      expect(auditRows(admin.user.id).map(r => r.action), '이 관리자의 감사 로그(쓰기만)').toEqual([
        'HOSPITAL_CREATE', 'HOSPITAL_CREATE', 'HOSPITAL_CREATE', 'HOSPITAL_DEPARTMENT_DELETE', 'HOSPITAL_DELETE',
      ]);
      test.info().annotations.push({
        type: '확인 범위',
        description: '예약 서비스에는 이 테스트 말고도 다른 병원이 있어, 이 테스트가 만든 병원의 표식(q)으로 좁혀 보았다. summary 의 숫자는 전체 값이라 형식과 하한만 확인했다.',
      });
    });
  });

  test('CHAT-N29 병원 등록·수정·삭제와 감사 로그', TAGS, async ({ tempUser }) => {
    test.setTimeout(240_000);
    await withAdmin(tempUser, async ({ admin, scope, s, call }) => {
      // 등록: 점심시간·휴진 요일·요일별 진료 시간 포함. 소개가 길어 감사 로그 detail 이 500자에서 잘린다
      const body = hospitalBody(s, {
        description: '설명'.repeat(450),
        breakStart: '12:00',
        breakEnd: '13:00',
        closedWeekdays: [0],
        weekdayHours: [{ weekday: 6, openTime: '09:00', closeTime: '13:00' }],
      });
      const created = await scope.create(body);
      expect(created.status, '등록').toBe(201);
      const hospital = created.json.data;
      expect(hospital).toEqual(expect.objectContaining({
        name: body.name, region: body.region, address: body.address, phone: body.phone, openTime: '09:00', closeTime: '18:00',
        breakStart: '12:00', breakEnd: '13:00', closedWeekdays: [0], bookingAvailable: false,
      }));
      expect(hospital.weekdayHours).toEqual([{ weekday: 6, openTime: '09:00', closeTime: '13:00' }]);
      expect(hospital.departments.map((d: { name: string }) => d.name)).toEqual(body.departments);

      const afterCreate = auditRows(admin.user.id);
      expect(afterCreate.map(r => r.action), '등록 뒤 감사 로그').toEqual(['HOSPITAL_CREATE']);
      expect(afterCreate[0].target).toBe('hospital:new');
      expect(afterCreate[0].detail.length, 'detail 은 500자까지').toBe(500);
      expect(afterCreate[0].detail.startsWith(`name=${body.name}, region=${body.region}`), 'detail 앞부분').toBe(true);
      // 감사 로그가 예약 서비스 호출보다 먼저 남는다는 순서는 코드 근거로 적는다(서로 다른 두 서버의 시계를 밀리초로 비교하면 흔들린다).
      // 시각 비교는 참고용 annotation 으로만 남긴다
      test.info().annotations.push({
        type: '참고(시각 비교)',
        description: `BE 감사 로그 시각과 예약 서비스 등록 시각의 차이 ${Date.parse(hospital.registeredAt) - afterCreate[0].createdMs}ms (양수면 감사 로그가 먼저). 서버 시계 차이·초 단위 자름이 있을 수 있어 통과 조건으로 쓰지 않는다.`,
      });
      test.info().annotations.push({
        type: '확인 범위',
        description: '순서 근거는 코드다: AdminHospitalService.java 140-141행에서 audit(HOSPITAL_CREATE) 다음에 client.createHospital 을 부른다. 그래서 예약 서비스가 실패해도 감사 로그는 남는다.',
      });

      // 수정
      const update = {
        name: `${body.name}수정`, phone: '1588-1234', description: '수정한 소개', openTime: '08:30', closeTime: '17:30',
        breakStart: '12:30', breakEnd: '13:30', closedWeekdays: [0, 6],
        weekdayHours: [{ weekday: 3, openTime: '09:00', closeTime: '12:00' }], bookingAvailable: true,
      };
      const updated = await call('PUT', `${HOSPITAL_API}/${hospital.id}`, update);
      expect(updated.status, '수정').toBe(200);
      expect(updated.json.data).toEqual(expect.objectContaining({
        id: hospital.id, name: update.name, phone: update.phone, description: update.description, openTime: '08:30', closeTime: '17:30',
        breakStart: '12:30', breakEnd: '13:30', closedWeekdays: [0, 6], bookingAvailable: true,
        // 바꾸지 않은 칸은 그대로
        region: body.region, address: body.address,
      }));
      expect(updated.json.data.weekdayHours).toEqual(update.weekdayHours);
      const afterUpdate = auditRows(admin.user.id);
      expect(afterUpdate.map(r => r.action)).toEqual(['HOSPITAL_CREATE', 'HOSPITAL_UPDATE']);
      expect(afterUpdate[1].target).toBe(`hospital:${hospital.id}`);
      expect(afterUpdate[1].detail, '수정 detail 에 바뀐 칸').toContain('phone=1588-1234');

      // 삭제: 목록에서 빠진다
      const countBeforeReads = auditCount(admin.user.id);
      expect(names(await listByQuery(admin.api, s)), '삭제 전 목록').toEqual([update.name]);
      const deleted = await call('DELETE', `${HOSPITAL_API}/${hospital.id}`);
      expect(deleted.status, '삭제').toBe(200);
      expect(deleted.json.success, '삭제 응답 성공 표시').toBe(true);
      expect(deleted.json.data ?? null, '삭제 응답에는 병원 본문이 없다').toBeNull();
      scope.forget(hospital.id);
      expect(names(await listByQuery(admin.api, s)), '삭제 뒤 목록').toEqual([]);
      const after = auditRows(admin.user.id);
      expect(after.map(r => r.action), '최종 감사 로그').toEqual(['HOSPITAL_CREATE', 'HOSPITAL_UPDATE', 'HOSPITAL_DELETE']);
      expect(after[2].target).toBe(`hospital:${hospital.id}`);
      // 조회(목록 두 번)는 로그를 남기지 않는다: 읽기 전 로그 수 + 삭제 1건
      expect(after.length, '조회는 감사 로그를 남기지 않는다').toBe(countBeforeReads + 1);
      test.info().annotations.push({
        type: '문서 고칠 곳',
        description: 'BE 프로젝트_설명.txt 2360행 근처(등록 응답 코드·삭제 응답). 문서는 "200"과 "삭제는 deleted=true"라고 적었지만, 코드(AdminHospitalController)는 등록을 201 로 돌려주고 삭제 응답은 본문 없이 메시지만 준다. 코드 값으로 고정했다.',
      });
    });
  });

  test('CHAT-N30 운영 상태와 진료과 추가·이름 변경·삭제', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    await withAdmin(tempUser, async ({ admin, scope, s, call }) => {
      const created = await scope.create(hospitalBody(s, {
        breakStart: '12:00', breakEnd: '13:00', closedWeekdays: [0],
        weekdayHours: [{ weekday: 6, openTime: '09:00', closeTime: '13:00' }],
      }));
      expect(created.status).toBe(201);
      const id = created.json.data.id as number;
      const read = async () => {
        const res = await listByQuery(admin.api, s);
        expect(res.status).toBe(200);
        return res.json.data.content[0];
      };

      // 운영 상태
      const set = await call('PUT', `${HOSPITAL_API}/${id}/status`, {
        operationStatus: 'OPEN', congestionLevel: 'BUSY', waitingCount: 5, averageWaitingMinutes: 20, acceptingPatients: true, notice: 'QA공지',
      });
      expect(set.status, '상태 수정').toBe(200);
      expect(set.json.data).toEqual(expect.objectContaining({
        operationStatus: 'OPEN', congestionLevel: 'BUSY', waitingCount: 5, averageWaitingMinutes: 20, acceptingPatients: true, notice: 'QA공지',
      }));
      const partial = await call('PUT', `${HOSPITAL_API}/${id}/status`, { waitingCount: 7 });
      expect(partial.status).toBe(200);
      expect(partial.json.data, 'null 은 유지').toEqual(expect.objectContaining({
        operationStatus: 'OPEN', congestionLevel: 'BUSY', waitingCount: 7, averageWaitingMinutes: 20, acceptingPatients: true, notice: 'QA공지',
      }));
      const cleared = await call('PUT', `${HOSPITAL_API}/${id}/status`, { notice: '' });
      expect(cleared.status).toBe(200);
      expect(cleared.json.data.notice, '빈 문자열은 공지를 지운다').toBe('');
      expect(cleared.json.data.waitingCount, '다른 칸은 그대로').toBe(7);

      // 진료과 추가·이름 변경·삭제
      const added = await call('POST', `${HOSPITAL_API}/${id}/department`, { name: `QA추가과${s}` });
      expect(added.status, '진료과 추가').toBe(201);
      const deptId = added.json.data.id as number;
      expect(added.json.data.name).toBe(`QA추가과${s}`);
      expect((await read()).departments.map((d: { name: string }) => d.name)).toEqual([`QA내과${s}`, `QA추가과${s}`]);
      const renamed = await call('PUT', `${HOSPITAL_API}/${id}/department/${deptId}`, { name: `QA바뀐과${s}` });
      expect(renamed.status, '진료과 이름 변경').toBe(200);
      expect(renamed.json.data).toEqual({ id: deptId, name: `QA바뀐과${s}` });
      expect((await read()).departments.map((d: { name: string }) => d.name)).toEqual([`QA내과${s}`, `QA바뀐과${s}`]);
      const removed = await call('DELETE', `${HOSPITAL_API}/${id}/department/${deptId}`);
      expect(removed.status, '진료과 삭제').toBe(200);
      expect((await read()).departments.map((d: { name: string }) => d.name), '삭제한 진료과는 목록에서 빠진다').toEqual([`QA내과${s}`]);
      expect(names(await listByQuery(admin.api, s, `&department=${encodeURIComponent(`QA바뀐과${s}`)}`)), '삭제한 진료과로는 더 못 찾는다').toEqual([]);

      // 병원 수정의 비움 규칙: null=유지, 점심시간 빈 문자열 두 개=지우기, []=없앰
      const keep = await call('PUT', `${HOSPITAL_API}/${id}`, { description: '소개만 바꿈' });
      expect(keep.status).toBe(200);
      expect(keep.json.data).toEqual(expect.objectContaining({ breakStart: '12:00', breakEnd: '13:00', closedWeekdays: [0], description: '소개만 바꿈' }));
      expect(keep.json.data.weekdayHours, '다른 칸은 null 이라 유지').toHaveLength(1);
      const noBreak = await call('PUT', `${HOSPITAL_API}/${id}`, { breakStart: '', breakEnd: '' });
      expect(noBreak.status).toBe(200);
      expect(noBreak.json.data.breakStart, '점심시간 시작 지움').toBeNull();
      expect(noBreak.json.data.breakEnd, '점심시간 끝 지움').toBeNull();
      expect(noBreak.json.data.closedWeekdays, '휴진 요일은 유지').toEqual([0]);
      const noClosed = await call('PUT', `${HOSPITAL_API}/${id}`, { closedWeekdays: [] });
      expect(noClosed.status).toBe(200);
      expect(noClosed.json.data.closedWeekdays, '[]=휴진 없음').toEqual([]);
      expect(noClosed.json.data.weekdayHours, '요일별 시간은 유지').toHaveLength(1);
      const noHours = await call('PUT', `${HOSPITAL_API}/${id}`, { weekdayHours: [] });
      expect(noHours.status).toBe(200);
      expect(noHours.json.data.weekdayHours, '[]=요일별 시간 없음').toEqual([]);

      expect(auditRows(admin.user.id).map(r => r.action), '쓰기마다 감사 로그').toEqual([
        'HOSPITAL_CREATE', 'HOSPITAL_STATUS_CHANGE', 'HOSPITAL_STATUS_CHANGE', 'HOSPITAL_STATUS_CHANGE',
        'HOSPITAL_DEPARTMENT_ADD', 'HOSPITAL_DEPARTMENT_UPDATE', 'HOSPITAL_DEPARTMENT_DELETE',
        'HOSPITAL_UPDATE', 'HOSPITAL_UPDATE', 'HOSPITAL_UPDATE', 'HOSPITAL_UPDATE',
      ]);
      test.info().annotations.push({
        type: '문서와 차이',
        description: '진료과 추가·이름 변경·삭제 경로는 /department (단수)다. 진료과 추가는 201, 나머지는 200 이다. active=false 는 응답에 보이지 않고 목록에서 빠지는 것으로 확인했다.',
      });
    });
  });

  test('CHAT-A27 없는 병원·진료과 / 중복 등록', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    await withAdmin(tempUser, async ({ admin, scope, s, call }) => {
      const h1 = await scope.create(hospitalBody(`${s}1`, { departments: [`QA내과${s}`, `QA외과${s}`] }));
      const h2 = await scope.create(hospitalBody(`${s}2`, { departments: [`QA안과${s}`] }));
      expect(h1.status).toBe(201);
      expect(h2.status).toBe(201);
      const id1 = h1.json.data.id as number;
      const id2 = h2.json.data.id as number;
      const dept1 = h1.json.data.departments as Array<{ id: number; name: string }>;
      const dept2 = h2.json.data.departments as Array<{ id: number; name: string }>;
      const base = auditCount(admin.user.id);

      const cases: Array<[string, 'PUT' | 'POST' | 'DELETE', string, unknown, number, string]> = [
        ['없는 병원 수정(이름)', 'PUT', `${HOSPITAL_API}/${MISSING_ID}`, { name: 'QA없음' }, 404, 'HOSPITAL_NOT_FOUND'],
        ['없는 병원 수정(전화)', 'PUT', `${HOSPITAL_API}/${MISSING_ID}`, { phone: '1588-1234' }, 404, 'HOSPITAL_NOT_FOUND'],
        ['없는 병원 삭제', 'DELETE', `${HOSPITAL_API}/${MISSING_ID}`, undefined, 404, 'HOSPITAL_NOT_FOUND'],
        ['없는 병원 상태 수정', 'PUT', `${HOSPITAL_API}/${MISSING_ID}/status`, { waitingCount: 1 }, 404, 'HOSPITAL_NOT_FOUND'],
        ['없는 병원에 진료과 추가', 'POST', `${HOSPITAL_API}/${MISSING_ID}/department`, { name: 'QA과' }, 404, 'HOSPITAL_NOT_FOUND'],
        ['없는 진료과 이름 변경', 'PUT', `${HOSPITAL_API}/${id1}/department/${MISSING_ID}`, { name: 'QA과' }, 404, 'HOSPITAL_DEPARTMENT_NOT_FOUND'],
        ['없는 진료과 삭제', 'DELETE', `${HOSPITAL_API}/${id1}/department/${MISSING_ID}`, undefined, 404, 'HOSPITAL_DEPARTMENT_NOT_FOUND'],
        ['다른 병원의 진료과 이름 변경', 'PUT', `${HOSPITAL_API}/${id1}/department/${dept2[0].id}`, { name: 'QA과' }, 404, 'HOSPITAL_DEPARTMENT_NOT_FOUND'],
        ['같은 이름+주소 병원 등록', 'POST', HOSPITAL_API, hospitalBody(`${s}1`, { departments: [`QA치과${s}`] }), 409, 'HOSPITAL_DUPLICATED'],
        [
          '이름에 공백을 넣어도 같은 병원', 'POST', HOSPITAL_API,
          hospitalBody(`${s}1`, { name: `QA점검 병원${s}1`, departments: [`QA치과${s}`] }), 409, 'HOSPITAL_DUPLICATED',
        ],
        ['다른 병원과 같은 이름+주소로 수정', 'PUT', `${HOSPITAL_API}/${id2}`, { name: h1.json.data.name, address: h1.json.data.address }, 409, 'HOSPITAL_DUPLICATED'],
        ['같은 진료과 추가', 'POST', `${HOSPITAL_API}/${id1}/department`, { name: dept1[0].name }, 409, 'HOSPITAL_DEPARTMENT_DUPLICATED'],
        [
          '같은 병원의 다른 진료과 이름으로 변경', 'PUT', `${HOSPITAL_API}/${id1}/department/${dept1[1].id}`, { name: dept1[0].name }, 409,
          'HOSPITAL_DEPARTMENT_DUPLICATED',
        ],
        [
          '등록 요청 안에 같은 진료과 두 번', 'POST', HOSPITAL_API,
          hospitalBody(`${s}3`, { departments: [`QA치과${s}`, `QA치과${s}`] }), 400, 'HOSPITAL_DEPARTMENT_DUPLICATED_IN_REQUEST',
        ],
      ];
      const failures: string[] = [];
      const loggedDespiteReject: string[] = [];
      for (const [label, method, path, data, status, code] of cases) {
        const before = auditCount(admin.user.id);
        const res = await call(method, path, data);
        if (res.status !== status || res.json?.code !== code) failures.push(`${label}: 기대 ${status} ${code}, 실제 ${res.status} ${res.json?.code}`);
        // 실패한 요청이 병원을 만들지 않았다는 것은 아래 목록 확인으로 본다
        if (auditCount(admin.user.id) !== before) loggedDespiteReject.push(label);
      }
      expect(failures, '오류 응답').toEqual([]);
      // 제품이 틀리면 약하게 만들지 않고 실패로 남긴다(soft: 아래 나머지 확인도 이어서 한다)
      expect.soft(loggedDespiteReject, '거절된 요청인데 감사 로그가 남은 요청 (문서: 감사 로그 안 남음). 고칠 곳: AdminHospitalService.update·delete 는 존재 확인 전에 audit() 를 부른다').toEqual([]);
      expect(base, '준비: 등록 2건의 감사 로그').toBe(2);
      expect(names(await listByQuery(admin.api, s)).sort(), '거절된 등록은 병원을 만들지 않았다').toEqual([h1.json.data.name, h2.json.data.name].sort());

      // 삭제된 병원에는 쓸 수 없다
      expect((await call('DELETE', `${HOSPITAL_API}/${id2}`)).status).toBe(200);
      scope.forget(id2);
      const writeAfterDelete: string[] = [];
      const loggedAfterDelete: string[] = [];
      for (const [label, method, path, data] of [
        ['수정', 'PUT', `${HOSPITAL_API}/${id2}`, { name: 'QA다시' }],
        ['상태', 'PUT', `${HOSPITAL_API}/${id2}/status`, { waitingCount: 1 }],
        ['진료과 추가', 'POST', `${HOSPITAL_API}/${id2}/department`, { name: 'QA과' }],
        ['진료과 이름 변경', 'PUT', `${HOSPITAL_API}/${id2}/department/${dept2[0].id}`, { name: 'QA과' }],
        ['진료과 삭제', 'DELETE', `${HOSPITAL_API}/${id2}/department/${dept2[0].id}`, undefined],
      ] as const) {
        const before = auditCount(admin.user.id);
        const res = await call(method, path, data);
        if (res.status !== 404 || res.json?.code !== 'HOSPITAL_NOT_FOUND') writeAfterDelete.push(`${label}: 실제 ${res.status} ${res.json?.code}`);
        if (auditCount(admin.user.id) !== before) loggedAfterDelete.push(label);
      }
      expect(writeAfterDelete, '삭제된 병원에 쓰기는 404 HOSPITAL_NOT_FOUND').toEqual([]);
      expect.soft(loggedAfterDelete, '삭제된 병원에 대한 거절 요청인데 감사 로그가 남은 요청').toEqual([]);
    });
  });

  test('CHAT-A28 입력 검증 경계 (이름 100·지역 30·주소 200, 전화, 진료과 1~20개)', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    await withAdmin(tempUser, async ({ admin, scope, s, call }) => {
      const pad = (prefix: string, n: number) => prefix + '가'.repeat(n - prefix.length);
      const eachDept = Array.from({ length: 20 }, (_, i) => `QA과${String(i + 1).padStart(2, '0')}`);

      // 상한 이내는 통과: 이름 100·지역 30·주소 200·진료과 20개·대표번호형 전화
      const limit = await scope.create(hospitalBody(s, {
        name: pad(`QA경계${s}`, 100), region: pad(`QA${s}`, 30), address: pad(`QA주소${s}`, 200), phone: '1588-1234', departments: eachDept,
      }));
      expect(limit.status, '상한 이내 등록').toBe(201);
      expect(limit.json.data.name.length).toBe(100);
      expect(limit.json.data.region.length).toBe(30);
      expect(limit.json.data.address.length).toBe(200);
      expect(limit.json.data.departments).toHaveLength(20);
      const base = auditCount(admin.user.id);

      const over: Array<[string, Record<string, unknown>]> = [
        ['이름 101자', { name: pad(`QA경계${s}`, 101) }],
        ['지역 31자', { region: pad(`QA${s}`, 31) }],
        ['주소 201자', { address: pad(`QA주소${s}`, 201) }],
        ['소개 1001자', { description: '가'.repeat(1001) }],
        ['빈 이름', { name: '   ' }],
        ['전화 형식 틀림(짧음)', { phone: '12-34' }],
        ['전화 형식 틀림(글자)', { phone: '02-abcd-1234' }],
        ['전화 형식 틀림(자리 넘침)', { phone: '02-1234-56789' }],
        ['전화 빈 값', { phone: '' }],
        ['진료과 0개', { departments: [] }],
        ['진료과 21개', { departments: [...eachDept, 'QA과21'] }],
        ['진료과 이름 31자', { departments: [pad('QA과', 31)] }],
      ];
      const failures: string[] = [];
      for (const [label, patch] of over) {
        const res = await call('POST', HOSPITAL_API, { ...hospitalBody(`${s}x`), ...patch });
        // 서비스에 닿기 전에 입력 검증(@Valid)에서 거절되므로 코드는 INVALID_INPUT 이다
        if (res.status !== 400 || res.json?.code !== 'INVALID_INPUT') failures.push(`${label}: 실제 ${res.status} ${res.json?.code}`);
      }
      expect(failures, '상한을 넘기면 400 INVALID_INPUT').toEqual([]);
      expect(auditCount(admin.user.id), '검증에서 거절된 요청은 감사 로그를 남기지 않는다').toBe(base);
      expect(names(await listByQuery(admin.api, s)), '거절된 등록은 병원을 만들지 않았다').toEqual([limit.json.data.name]);

      // 수정도 같은 상한 (이름 101자)
      const upd = await call('PUT', `${HOSPITAL_API}/${limit.json.data.id}`, { name: pad(`QA경계${s}`, 101) });
      expect(upd.status).toBe(400);
      expect(upd.json?.code).toBe('INVALID_INPUT');
      const emptyUpd = await call('PUT', `${HOSPITAL_API}/${limit.json.data.id}`, {});
      expect(emptyUpd.status, '바꿀 칸이 하나도 없으면 400').toBe(400);
      expect(emptyUpd.json?.code).toBe('INVALID_INPUT');
      expect(auditCount(admin.user.id), '수정 거절도 로그 없음').toBe(base);

      // 전화 형식 두 가지는 통과 (지역번호형 하이픈 없음 / 서울형)
      for (const phone of ['0212345678', '02-123-4567']) {
        const ok = await call('PUT', `${HOSPITAL_API}/${limit.json.data.id}`, { phone });
        expect(ok.status, `전화 ${phone.length}자 형식 통과`).toBe(200);
      }
      test.info().annotations.push({
        type: '문서 고칠 곳',
        description: 'BE 프로젝트_설명.txt 2379행. 문서는 입력 검증 실패를 "400 HOSPITAL_REQUEST_REJECTED"라고 적었다. 코드에서 이 코드는 예약 서비스가 요청을 거절했을 때(ReservationAdminClient)만 쓰이고, 이 칸들의 길이·형식 위반은 서비스에 닿기 전 @Valid 에서 400 INVALID_INPUT 으로 거절된다. 코드 값으로 고정했다.',
      });
    });
  });

  test('CHAT-A29 진료·점심·휴진 시간 규칙 위반', TAGS, async ({ tempUser }) => {
    test.setTimeout(300_000);
    await withAdmin(tempUser, async ({ admin, scope, s, call }) => {
      const base = auditCount(admin.user.id);
      const bad = (label: string, patch: Record<string, unknown>, code: string): [string, Record<string, unknown>, string] => [label, patch, code];
      const createCases: Array<[string, Record<string, unknown>, string]> = [
        bad('시작과 종료가 같음', { openTime: '09:00', closeTime: '09:00' }, 'HOSPITAL_INVALID_HOURS'),
        bad('시작이 종료보다 늦음', { openTime: '18:00', closeTime: '09:00' }, 'HOSPITAL_INVALID_HOURS'),
        bad('자정을 넘김(22시~02시)', { openTime: '22:00', closeTime: '02:00' }, 'HOSPITAL_INVALID_HOURS'),
        bad('24:00 은 시각 형식이 아니다', { openTime: '09:00', closeTime: '24:00' }, 'INVALID_INPUT'),
        bad('점심시간이 진료 시작 전', { breakStart: '08:00', breakEnd: '09:00' }, 'HOSPITAL_INVALID_BREAK'),
        bad('점심시간이 진료 종료 뒤', { breakStart: '17:00', breakEnd: '19:00' }, 'HOSPITAL_INVALID_BREAK'),
        bad('점심 시작이 끝보다 늦음', { breakStart: '13:00', breakEnd: '12:00' }, 'HOSPITAL_INVALID_BREAK'),
        bad('점심 시작과 끝이 같음', { breakStart: '12:00', breakEnd: '12:00' }, 'HOSPITAL_INVALID_BREAK'),
        bad('점심 시작만 있음', { breakStart: '12:00', breakEnd: '' }, 'HOSPITAL_INVALID_BREAK'),
        bad('휴진 요일 중복', { closedWeekdays: [0, 0] }, 'INVALID_INPUT'),
        bad('요일별 시간의 요일 중복', {
          weekdayHours: [{ weekday: 6, openTime: '09:00', closeTime: '13:00' }, { weekday: 6, openTime: '10:00', closeTime: '12:00' }],
        }, 'HOSPITAL_INVALID_HOURS'),
        bad('요일별 시간의 시작이 종료보다 늦음', { weekdayHours: [{ weekday: 6, openTime: '13:00', closeTime: '09:00' }] }, 'HOSPITAL_INVALID_HOURS'),
      ];
      const failures: string[] = [];
      for (const [label, patch, code] of createCases) {
        const res = await call('POST', HOSPITAL_API, { ...hospitalBody(`${s}x`), ...patch });
        if (res.status !== 400 || res.json?.code !== code) failures.push(`${label}: 기대 400 ${code}, 실제 ${res.status} ${res.json?.code}`);
      }
      expect(failures, '등록 시 시간 규칙 위반').toEqual([]);
      expect(auditCount(admin.user.id), '거절된 등록은 감사 로그를 남기지 않는다').toBe(base);
      expect(names(await listByQuery(admin.api, s)), '거절된 등록은 병원을 만들지 않았다').toEqual([]);

      // 수정: 진료 시간만 줄여 기존 점심시간이 밖으로 밀리는 경우
      const created = await scope.create(hospitalBody(s, { breakStart: '12:00', breakEnd: '13:00' }));
      expect(created.status).toBe(201);
      const id = created.json.data.id as number;
      const afterCreate = auditCount(admin.user.id);
      const updateCases: Array<[string, Record<string, unknown>, string]> = [
        ['시작을 점심 뒤로 미룸', { openTime: '13:30' }, 'HOSPITAL_INVALID_BREAK'],
        ['종료를 점심 안으로 당김', { closeTime: '12:30' }, 'HOSPITAL_INVALID_BREAK'],
        ['시작이 종료보다 늦어짐', { openTime: '18:30' }, 'HOSPITAL_INVALID_HOURS'],
        ['점심만 진료 밖으로 바꿈', { breakStart: '18:00', breakEnd: '19:00' }, 'HOSPITAL_INVALID_BREAK'],
        ['휴진 요일 중복', { closedWeekdays: [1, 1] }, 'INVALID_INPUT'],
        ['요일별 시간 요일 중복', { weekdayHours: [{ weekday: 2, openTime: '09:00', closeTime: '12:00' }, { weekday: 2, openTime: '13:00', closeTime: '15:00' }] }, 'HOSPITAL_INVALID_HOURS'],
      ];
      const updateFailures: string[] = [];
      for (const [label, patch, code] of updateCases) {
        const res = await call('PUT', `${HOSPITAL_API}/${id}`, patch);
        if (res.status !== 400 || res.json?.code !== code) updateFailures.push(`${label}: 기대 400 ${code}, 실제 ${res.status} ${res.json?.code}`);
      }
      expect(updateFailures, '수정 시 시간 규칙 위반').toEqual([]);
      expect(auditCount(admin.user.id), '거절된 수정은 감사 로그를 남기지 않는다').toBe(afterCreate);
      const stored = (await listByQuery(admin.api, s)).json.data.content[0];
      expect(stored, '거절된 수정은 값을 바꾸지 않았다').toEqual(expect.objectContaining({ openTime: '09:00', closeTime: '18:00', breakStart: '12:00', breakEnd: '13:00' }));
      test.info().annotations.push({
        type: '문서 고칠 곳',
        description: 'BE 프로젝트_설명.txt 2387행. 문서는 "24:00"을 HOSPITAL_INVALID_HOURS 로 적었지만 코드는 시각 형식(HH:mm, 00~23시) 검사에서 먼저 400 INVALID_INPUT 으로 거절한다. 요일별 시간의 요일 중복은 INVALID_INPUT 이 아니라 HOSPITAL_INVALID_HOURS 이고, INVALID_INPUT 은 휴진 요일 중복에만 쓴다. 코드 값으로 고정했다.',
      });
    });
  });

  test('CHAT-A30 (부분 확인) 시간 초과 처리 코드 읽기: 8초 제한, 읽기 504·쓰기 결과 불명', TAGS, async () => {
    // 실제 지연은 만들지 않는다(아래 fixme). 배포 코드를 읽어 시간 초과 처리의 구조만 확인한다.
    const base = path.join(homedir(), 'SilverBridgeBe/src/main');
    const client = readFileSync(path.join(base, 'java/kr/silverbridge/main/domain/hospital/client/ReservationAdminClient.java'), 'utf8');
    const service = readFileSync(path.join(base, 'java/kr/silverbridge/main/domain/admin/service/AdminHospitalService.java'), 'utf8');
    const yaml = readFileSync(path.join(base, 'resources/application.yaml'), 'utf8');
    expect(yaml, '한 번의 요청 전체 제한 기본값 8초').toContain('call-timeout: ${RESERVATION_ADMIN_CALL_TIMEOUT:8s}');
    expect(client, '읽기 제한 시간에 여유(READ_TIMEOUT_SLACK_MS)를 더한다').toMatch(/setReadTimeout\(\(int\) \(remainingMs \+ READ_TIMEOUT_SLACK_MS\)\)/);
    expect(client, '시간 초과는 HOSPITAL_SERVICE_TIMEOUT 으로 바꾼다').toContain('throw new CustomException(ErrorCode.HOSPITAL_SERVICE_TIMEOUT)');
    expect(client, '쓰기가 닿은 뒤 끊기면 HOSPITAL_RESULT_UNKNOWN').toMatch(/if \(write && connected\) \{[\s\S]*?ErrorCode\.HOSPITAL_RESULT_UNKNOWN/);
    expect(service, '쓰기 뒤 응답 변환 실패도 결과 불명으로 바꾼다(afterWrite)').toMatch(/private static <T> T afterWrite[\s\S]*?HOSPITAL_SERVICE_UNAVAILABLE[\s\S]*?HOSPITAL_RESULT_UNKNOWN/);
    test.info().annotations.push({
      type: '부분 확인',
      description: '코드를 읽어 8초 제한(application.yaml)·읽기 시간 초과 HOSPITAL_SERVICE_TIMEOUT·쓰기 결과 불명 HOSPITAL_RESULT_UNKNOWN·afterWrite 를 확인했다(통과와 따로 센다). 실제로 8초 넘게 늦췄을 때의 응답은 확인하지 않았다.',
    });
  });

  test.fixme('CHAT-A30 예약 서비스 시간 초과 (8초) 실제 지연 확인', TAGS, async () => {
    // 예약 서비스를 8초 넘게 느리게 만들려면 예약 서비스·BE 설정이나 컨테이너를 바꾸거나 네트워크를 막아야 한다.
    // 이 QA 는 서버 설정·컨테이너 변경이 금지라 자동화할 수 없다. 코드 읽기 부분은 위 test 로 자동화했다.
    // 수동 확인: 스테이징에서 예약 서비스에 지연을 주고 확인.
  });
});
