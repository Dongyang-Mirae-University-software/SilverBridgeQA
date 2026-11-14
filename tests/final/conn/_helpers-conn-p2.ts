/**
 * 최종 QA - 연결·SOS·복약(CONN) P2 묶음 전용 도우미.
 *
 * 원칙: 임시 사용자와 그 사용자의 행·키만 다룬다(키에는 임시 사용자 id 가 들어간 것만 지운다, 패턴 삭제 금지).
 * 기존 P0·P1 도우미는 고치지 않고 가져다 쓴다. 비밀번호·토큰·전화번호·응답 본문은 실패 문구에 넣지 않는다(상태 코드·오류 코드·개수만).
 */
import { Page } from '@playwright/test';

import { psql, redis, sqlStr } from '../../../src/remote';

export const TAGS = { tag: ['@P2', '@CONN'] };

/** 요청 한 건: 보호자가 피보호자에게 연결 요청 */
export const REQUEST_API = '/api/guardian/connection/request';

/** 두 임시 사용자 사이에 수락 대기(PENDING) 행을 직접 만든다. createdAt 을 주면 그 시각(예: '2026-09-30 00:30:00+09')으로 만든다 */
export function insertPending(guardianId: string, wardId: string, relation = '딸', createdAt?: string): number {
  const cols = createdAt ? ', created_at' : '';
  const vals = createdAt ? `, ${sqlStr(createdAt)}` : '';
  const out = psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, relation${cols})
                    VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'PENDING', ${sqlStr(guardianId)}, ${sqlStr(relation)}${vals})
                    RETURNING id;`);
  return Number(out.split('\n')[0].trim());
}

/** 두 임시 사용자 사이에 연결됨(ACTIVE) 행을 직접 만든다 */
export function insertActive(guardianId: string, wardId: string, relation = '기타'): number {
  const out = psql(`INSERT INTO connection (guardian_id, ward_id, status, initiated_by, connected_at, relation)
                    VALUES (${sqlStr(guardianId)}, ${sqlStr(wardId)}, 'ACTIVE', ${sqlStr(guardianId)}, now(), ${sqlStr(relation)})
                    RETURNING id;`);
  return Number(out.split('\n')[0].trim());
}

/** 이 임시 사용자 한 명의 키를 "다른 종류"로 만들어 그 키를 읽는 순간 Redis 오류가 나게 한다 (장애 대역, 다른 사용자에게는 영향 없음) */
export function poisonKey(key: string): () => void {
  redis('DEL', key);
  redis('RPUSH', key, 'qa-redis-failure');
  redis('EXPIRE', key, '300');
  return () => {
    redis('DEL', key);
  };
}

/** 임시 피보호자 SOS 이력 한 건의 저장된 위치("<null>" 이면 위치 모름)와 글자 수 */
export function savedLocation(sosEventId: number): { location: string; length: number } {
  const out = psql(`SELECT coalesce(location, '<null>') || '|' || coalesce(char_length(location), 0) FROM sos_event WHERE id = ${sosEventId};`);
  const cut = out.lastIndexOf('|');
  return { location: out.slice(0, cut), length: Number(out.slice(cut + 1)) };
}

/** 임시 사용자가 쓴 문의 수 (조회만) */
export function inquiryCountOf(userId: string): number {
  return Number(psql(`SELECT count(*) FROM inquiry WHERE user_id = ${sqlStr(userId)};`));
}

/** 보호자 화면의 연결 요청 카드 영역 이름들 */
export function pendingSection(page: Page) {
  return page.getByRole('region', { name: '수락을 기다리는 중' });
}
