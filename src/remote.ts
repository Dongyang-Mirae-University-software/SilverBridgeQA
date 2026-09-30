/**
 * gosky 서버의 dev DB(Postgres)·Redis 를 SSH 로 직접 조작한다.
 * 테스트 계정 재생성, 레이트리밋 해제, 결과 확인처럼 화면만으로는 못 하는 준비·검증에만 쓴다.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { env } from './env';

export function remoteBash(script: string): string {
  const result = spawnSync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', env.sshHost, 'bash -s'],
    { input: script, encoding: 'utf8', timeout: 90_000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`원격 명령 실패 (exit ${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** SQL 을 실행하고 결과를 `|` 구분 행 문자열로 돌려준다 (psql -At) */
export function psql(sql: string): string {
  const script = [
    `docker exec -i ${env.dbContainer} sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -At -q' <<'__E2E_SQL__'`,
    sql,
    '__E2E_SQL__',
    '',
  ].join('\n');
  return remoteBash(script).trim();
}

export function psqlRows(sql: string): string[][] {
  const out = psql(sql);
  return out ? out.split('\n').map(line => line.split('|')) : [];
}

export function sqlStr(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

const SAFE_REDIS_TOKEN = /^[A-Za-z0-9:_.@*\-]+$/;

function assertSafe(token: string) {
  if (!SAFE_REDIS_TOKEN.test(token)) throw new Error(`허용되지 않는 Redis 인자: ${token}`);
}

export function redis(...args: string[]): string {
  args.forEach(assertSafe);
  return remoteBash(`docker exec ${env.redisContainer} redis-cli ${args.join(' ')}\n`).trim();
}

/** gosky 의 파일을 로컬 캐시로 받아 로컬 경로를 돌려준다 (이미 있으면 재사용) */
export function fetchRemoteFile(remotePath: string, localName: string): string {
  const dir = path.resolve('.cache');
  const local = path.join(dir, localName);
  if (!existsSync(local)) {
    if (!/^[\w./\-]+$/.test(remotePath)) throw new Error(`허용되지 않는 경로: ${remotePath}`);
    const b64 = remoteBash(`base64 -w0 '${remotePath}'\n`).trim();
    mkdirSync(dir, { recursive: true });
    writeFileSync(local, Buffer.from(b64, 'base64'));
  }
  return local;
}

/** BE 컨테이너 로그에서 최근 N초 안에 문자열이 몇 번 나왔는지 (화면·API 로 관찰할 수 없는 내부 동작 확인용) */
export function countBackendLog(needle: string, sinceSeconds = 180): number {
  if (!/^[\w가-힣:=\-. \[\]]+$/.test(needle)) throw new Error(`허용되지 않는 검색어: ${needle}`);
  const out = remoteBash(`docker logs --since ${sinceSeconds}s ${env.apiContainer} 2>&1 | grep -cF '${needle}' || true\n`);
  return Number(out.trim()) || 0;
}

/** 패턴에 맞는 키를 모두 지우고 지운 개수를 돌려준다 */
export function redisDelPattern(pattern: string): number {
  assertSafe(pattern);
  const out = remoteBash(
    `docker exec ${env.redisContainer} sh -c "redis-cli --scan --pattern '${pattern}' | xargs -r redis-cli DEL" | awk '{s+=$1} END {print s+0}'\n`,
  );
  return Number(out.trim()) || 0;
}
