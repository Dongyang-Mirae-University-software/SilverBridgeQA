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
  skipReset: process.env.E2E_SKIP_RESET === '1',
  /** 1 이면 실제 SMS 발송 요청이 생기는 테스트(SOS 실시간 알림)를 건너뛴다 */
  skipSms: process.env.E2E_SKIP_SMS === '1',
};

/** FE 도메인 (쿠키 domain 으로 쓴다) */
export const feHost = new URL(env.baseUrl).hostname;
