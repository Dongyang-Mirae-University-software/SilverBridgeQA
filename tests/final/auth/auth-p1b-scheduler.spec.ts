/**
 * 최종 QA - 인증(AUTH) P1b - 탈퇴 중에 멈춘 계정 청소 작업 (N30)
 *
 * 서버를 재시작하지 않는다(컨테이너 변경 금지). 재시작으로 멈춘 계정과 같은 상태를 임시 사용자로 직접 만든다:
 * 탈퇴 1걸음만 끝난 INACTIVE 계정, 그리고 관리자가 정지한 RESTRICTED 계정(삭제되면 안 됨).
 * 둘 다 INACTIVE/RESTRICTED 로 바뀐 지 10분 넘은 것으로 updated_at 을 되돌려 두고, 청소 작업(10분 주기)이 돌 때까지 기다린다.
 * 그래서 이 테스트는 최대 약 11분 걸린다.
 */
import { expect, test } from '../../../src/fixtures';
import { countBackendLog, psql, sqlStr } from '../../../src/remote';
import { createTempUser, deleteTempUser } from '../../../src/seed';
import { userRowCount, userStatus } from './_helpers-auth';
import { TAGS_P1 } from './_helpers-auth-p1b';

test('AUTH-N30 탈퇴 중에 멈춘 계정을 10분 청소 작업이 마저 삭제', TAGS_P1, async () => {
  test.setTimeout(15 * 60_000);
  const stuck = createTempUser('GUARDIAN', { name: 'E2E탈퇴멈춤', status: 'INACTIVE' });
  const restricted = createTempUser('GUARDIAN', { name: 'E2E이용제한', status: 'RESTRICTED' });
  try {
    // 전환된 지 10분이 지난 상태로 만든다 (이 임시 사용자 두 명의 행만)
    psql(
      `UPDATE users SET updated_at = now() - interval '11 minutes' WHERE id IN (${sqlStr(stuck.id)}, ${sqlStr(restricted.id)});`,
    );
    expect(userStatus(stuck.id), '준비: 탈퇴 중(INACTIVE) 계정').toBe('INACTIVE');
    expect(userStatus(restricted.id), '준비: 이용 제한(RESTRICTED) 계정').toBe('RESTRICTED');

    // WithdrawnUserPurgeScheduler: fixedDelay 10분. 한 바퀴 안에 지워져야 한다
    try {
      await expect
        .poll(() => userRowCount(stuck.id), {
          message: '탈퇴 중에 멈춘 계정이 청소 작업으로 완전 삭제된다 (최대 약 11분 대기)',
          timeout: 12 * 60_000,
          intervals: [20_000],
        })
        .toBe(0);
    } finally {
      // 원인 파악용: 최근 15분 BE 로그에 청소 작업 흔적이 몇 줄 있는지(개수만. 내용은 남기지 않는다)
      try {
        test.info().annotations.push({
          type: '청소 작업 로그 줄 수(최근 15분)',
          description: String(countBackendLog('WITHDRAW-SWEEP', 900)),
        });
      } catch {
        // 로그를 못 읽어도 위 단언의 결과가 그대로 남는다
      }
    }

    expect(userRowCount(restricted.id), '이용 제한(정지) 계정은 삭제되지 않는다').toBe(1);
    expect(userStatus(restricted.id), '이용 제한 계정의 상태는 그대로').toBe('RESTRICTED');
  } finally {
    for (const id of [stuck.id, restricted.id]) {
      try {
        deleteTempUser(id);
      } catch (error) {
        console.warn('N30 임시 사용자 정리 실패', error);
      }
    }
  }
});
