/**
 * E2E 전용 계정. 매 실행 전 global.setup 이 dev DB 에서 지우고 다시 만든다.
 *
 * - 이메일은 예약 TLD(.test) 라 메일이 실제로 나가지 않는다.
 * - 전화번호는 010-0000-9xxx 대역: 가입자에게 배정되지 않는 국번이라, SOS 의 SMS 폴백이
 *   실행돼도 모르는 사람에게 문자가 가지 않는다.
 * - 역할별로 계정을 나눈 이유: BE 가 로그인할 때마다 그 사용자의 refresh token 을 전부 지우고,
 *   비밀번호 변경·탈퇴는 토큰을 무효화하므로 테스트끼리 계정을 공유하면 서로를 로그아웃시킨다.
 */
export type Role = 'GUARDIAN' | 'WARD' | 'ADMIN';

export interface Account {
  id: string; // users.id (6자)
  email: string;
  name: string;
  phone: string;
  role: Role;
  gender: 'MALE' | 'FEMALE';
  birthDate: string; // YYYY-MM-DD
  /** 이 계정을 쓰는 곳 */
  purpose: string;
}

const domain = 'silverbridge.test';

export const ACCOUNTS = {
  admin: {
    id: 'e2ea01', email: `e2e.admin@${domain}`, name: 'E2E관리자', phone: '01000009000',
    role: 'ADMIN', gender: 'MALE', birthDate: '1980-01-01',
    purpose: '관리자 API 로 셋업·검증 (FE 에 관리자 화면 없음)',
  },
  guardian1: {
    id: 'e2eg01', email: `e2e.guardian1@${domain}`, name: 'E2E보호자1', phone: '01000009101',
    role: 'GUARDIAN', gender: 'FEMALE', birthDate: '1978-03-03',
    purpose: 'ward1 과 연결된 기본 보호자 (복약·SOS)',
  },
  guardian2: {
    id: 'e2eg02', email: `e2e.guardian2@${domain}`, name: 'E2E보호자2', phone: '01000009102',
    role: 'GUARDIAN', gender: 'MALE', birthDate: '1975-07-07',
    purpose: '연결 요청·수락·거절·해제 흐름',
  },
  guardian3: {
    id: 'e2eg03', email: `e2e.guardian3@${domain}`, name: 'E2E보호자3', phone: '01000009103',
    role: 'GUARDIAN', gender: 'FEMALE', birthDate: '1982-09-09',
    purpose: '비밀번호 변경 (토큰 전부 무효화되므로 전용)',
  },
  ward1: {
    id: 'e2ew01', email: `e2e.ward1@${domain}`, name: 'E2E피보호자1', phone: '01000009201',
    role: 'WARD', gender: 'MALE', birthDate: '1948-05-05',
    purpose: 'guardian1 과 연결된 기본 피보호자 (복약·SOS)',
  },
  ward2: {
    id: 'e2ew02', email: `e2e.ward2@${domain}`, name: 'E2E피보호자2', phone: '01000009202',
    role: 'WARD', gender: 'FEMALE', birthDate: '1950-06-06',
    purpose: '연결 요청을 받아 수락하는 피보호자',
  },
  ward3: {
    id: 'e2ew03', email: `e2e.ward3@${domain}`, name: 'E2E피보호자3', phone: '01000009203',
    role: 'WARD', gender: 'FEMALE', birthDate: '1945-08-08',
    purpose: '보호자 없는 피보호자 (거절 흐름, 보호자 없을 때 SOS)',
  },
  ward4: {
    id: 'e2ew04', email: `e2e.ward4@${domain}`, name: 'E2E피보호자4', phone: '01000009204',
    role: 'WARD', gender: 'MALE', birthDate: '1947-04-04',
    purpose: '회원 탈퇴 (영구 삭제되므로 전용)',
  },
} as const satisfies Record<string, Account>;

export type AccountKey = keyof typeof ACCOUNTS;

/** 가입 테스트가 만드는 계정도 이 패턴을 따르게 해서 정리 대상에 포함시킨다 */
export const E2E_EMAIL_LIKE = `e2e.%@${domain}`;

export function signupEmail(tag: string) {
  return `e2e.signup.${tag}@${domain}`;
}

export const ADDRESS = {
  postcode: '06236',
  address: '서울 강남구 테헤란로 152',
  addressDetail: 'E2E 테스트동 101호',
};
