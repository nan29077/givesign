/**
 * 개발용 데이터베이스 초기화.
 *
 * `prisma migrate reset` 대신 public 스키마를 직접 재생성한 뒤 마이그레이션을 적용한다.
 * (실행 환경에 따라 프롬프트가 뜨는 것을 피하고, 동작을 예측 가능하게 만들기 위함)
 *
 * 안전장치
 *  - APP_ENV 가 prod 이면 즉시 중단한다.
 *  - 원격 호스트(로컬 주소가 아닌 곳)를 대상으로 하면 --allow-remote 없이는 중단한다.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
/** 로컬 node_modules 안의 실행 스크립트 경로를 얻는다.
 *  패키지의 exports 제한을 우회하기 위해 실제 파일 경로를 우선 사용한다. */
function localScript(relPath, specifier) {
  const direct = path.resolve(process.cwd(), 'node_modules', relPath);
  if (fs.existsSync(direct)) return direct;
  return require.resolve(specifier);
}

/** 셸/npx 를 거치지 않고 로컬 실행 파일을 직접 실행한다 (경로 공백 문제 회피) */
const runNode = (scriptPath, args) =>
  execFileSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit', shell: false });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[중단] DATABASE_URL 이 설정되지 않았습니다.');
  process.exit(1);
}

if ((process.env.APP_ENV ?? 'local') === 'prod') {
  console.error('[중단] APP_ENV=prod 에서는 초기화할 수 없습니다.');
  process.exit(1);
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);
let host = '';
try {
  host = new URL(url).hostname;
} catch {
  console.error('[중단] DATABASE_URL 형식이 올바르지 않습니다.');
  process.exit(1);
}

if (!LOCAL_HOSTS.has(host) && !process.argv.includes('--allow-remote')) {
  console.error(`[중단] 로컬이 아닌 데이터베이스(${host}) 입니다.`);
  console.error('       의도한 것이라면 --allow-remote 옵션을 붙여 다시 실행하세요.');
  process.exit(1);
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });

try {
  await client.connect();
} catch (e) {
  console.error(`[중단] 데이터베이스에 연결할 수 없습니다: ${e?.message ?? e}`);
  console.error('       도구_DB시작.bat 으로 컨테이너를 먼저 띄우거나 .env 의 DATABASE_URL 을 확인하세요.');
  process.exit(1);
}

console.log(`[1/3] public 스키마 재생성 (${host})`);
// 정산 원장 트리거가 DELETE 를 막으므로 스키마를 통째로 재생성한다.
await client.query('DROP SCHEMA IF EXISTS public CASCADE');
await client.query('CREATE SCHEMA public');
await client.end();

console.log('[2/3] 마이그레이션 적용');
runNode(localScript('prisma/build/index.js', 'prisma/build/index.js'), ['migrate', 'deploy']);

console.log('[3/3] 시드 데이터 생성');
runNode(localScript('tsx/dist/cli.mjs', 'tsx/dist/cli.mjs'), ['prisma/seed.ts']);

console.log('[완료] 초기화되었습니다.');
