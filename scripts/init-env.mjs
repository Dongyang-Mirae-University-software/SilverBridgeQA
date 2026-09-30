// .env 가 없으면 .env.example 을 복사하고 테스트 계정용 무작위 비밀번호를 채운다.
// 이미 있으면 건드리지 않는다.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('.env 가 이미 있습니다. 그대로 둡니다.');
  process.exit(0);
}

// BE/FE 비밀번호 규칙: 영문+숫자+특수문자, 공백 없음, 8~64자
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const body = Array.from(randomBytes(14), byte => alphabet[byte % alphabet.length]).join('');
const password = `E2e!${body}9#`;

const template = readFileSync('.env.example', 'utf8');
writeFileSync('.env', template.replace(/^E2E_PASSWORD=.*$/m, `E2E_PASSWORD=${password}`), { mode: 0o600 });
console.log('.env 를 만들었습니다 (E2E_PASSWORD 생성 완료).');
