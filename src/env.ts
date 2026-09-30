import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`환경변수 ${name} 가 비어 있습니다. 먼저 \`npm run init:env\` 를 실행하세요.`);
  }
  return value;
}

export const env = {
  baseUrl: process.env.E2E_BASE_URL ?? 'https://devdmu.gosky.kr',
  apiUrl: process.env.E2E_API_URL ?? 'https://api.devdmu.gosky.kr',
  get password() {
    return required('E2E_PASSWORD');
  },
  sshHost: process.env.E2E_SSH_HOST ?? 'gosky',
  dbContainer: process.env.E2E_DB_CONTAINER ?? 'dmu-dev-db',
  redisContainer: process.env.E2E_REDIS_CONTAINER ?? 'dmu-dev-redis',
  apiContainer: process.env.E2E_API_CONTAINER ?? 'dmu-dev-api',
  skipReset: process.env.E2E_SKIP_RESET === '1',
  /** 1 이면 실제 SMS 발송 요청이 생기는 테스트(SOS 실시간 알림)를 건너뛴다 */
  skipSms: process.env.E2E_SKIP_SMS === '1',
  /**
   * 이상감지 테스트용 화재 사진 (gosky 서버 경로). AI 신뢰도 0.85 로 danger 기준(0.6)을 여유 있게 넘는 이미지.
   * 2026-09-30 측정: 데이터셋 화재·연기 45장 중 27장만 0.6 이상이라 아무 사진이나 쓰면 안 된다.
   */
  fireImageRemotePath:
    process.env.E2E_FIRE_IMAGE ??
    '/home/apps/SilverBridgeSky/project-check/datasets/fire/test/images/fire1-178-_jpg.rf.99271f6a60a417bc476b7d5b33ec46fc.jpg',
};

/** FE 도메인 (쿠키 domain 으로 쓴다) */
export const feHost = new URL(env.baseUrl).hostname;
