/**
 * 미리보기(PGlite) 데이터베이스 준비.
 *
 * PGlite 는 PostgreSQL 을 WASM 으로 빌드한 임베디드 DB 로, Docker 나 별도 설치 없이
 * 실제 PostgreSQL 과 동일한 통신 규약(wire protocol)으로 동작한다.
 * 이 스크립트는 스키마가 비어 있을 때만 마이그레이션과 시드를 수행한다.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { SEED_VERSION, SEED_VERSION_KEY } from '../prisma/seed-version.mjs';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[중단] DATABASE_URL 이 없습니다.');
  process.exit(1);
}

const require = createRequire(import.meta.url);

/**
 * 셸과 npx 를 거치지 않고 로컬 실행 파일을 node 로 직접 실행한다.
 * (Windows 에서 경로에 공백이 있으면 셸이 명령을 잘라먹는 문제 회피)
 */
const runNode = (scriptPath, args) =>
  execFileSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit', shell: false });

/** 로컬 node_modules 안의 실행 스크립트 경로를 얻는다.
 *  패키지의 exports 제한을 우회하기 위해 실제 파일 경로를 우선 사용한다. */
function localScript(relPath, specifier) {
  const direct = path.resolve(process.cwd(), 'node_modules', relPath);
  if (fs.existsSync(direct)) return direct;
  return require.resolve(specifier);
}

const prismaCli = localScript('prisma/build/index.js', 'prisma/build/index.js');
const tsxCli = localScript('tsx/dist/cli.mjs', 'tsx/dist/cli.mjs');

async function connectWithRetry(attempts = 30) {
  for (let i = 0; i < attempts; i += 1) {
    const client = new Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
      await client.connect();
      return client;
    } catch {
      await client.end().catch(() => {});
      if (i === 0) console.log('[대기] 미리보기 데이터베이스가 준비될 때까지 기다립니다.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

const client = await connectWithRetry();
if (!client) {
  console.error('[중단] 미리보기 데이터베이스에 연결하지 못했습니다.');
  process.exit(1);
}

const { rows } = await client.query(
  "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
);
let merchants = 0;
let seedVersion = 0;
if (rows[0].n > 0) {
  try {
    const r = await client.query('SELECT count(*)::int AS n FROM merchant_profile');
    merchants = r.rows[0].n;
  } catch {
    merchants = 0;
  }
  try {
    const r = await client.query('SELECT value FROM system_setting WHERE key = $1', [SEED_VERSION_KEY]);
    seedVersion = Number(r.rows[0]?.value ?? 0) || 0;
  } catch {
    seedVersion = 0;
  }
}
await client.end();

// 기존 미리보기 DB도 새 마이그레이션을 빠짐없이 적용한다.
// migrate deploy는 이미 적용된 항목을 건너뛰므로 기존 데이터는 유지된다.
console.log('[준비] 데이터베이스 마이그레이션을 확인합니다.');
runNode(prismaCli, ['migrate', 'deploy']);

if (rows[0].n === 0) {
  console.log('[준비] 처음 실행입니다.');
  console.log('[준비] 시드 데이터를 생성합니다.');
  runNode(tsxCli, ['prisma/seed.ts']);
} else if (merchants === 0) {
  console.log('[준비] 시드 데이터가 없어 다시 생성합니다.');
  runNode(tsxCli, ['prisma/seed.ts']);
} else if (seedVersion < SEED_VERSION) {
  // 시드 내용이 추가된 경우(예: 후원자 테스트 계정).
  // 기존 데이터는 지우지 않고 부족한 것만 채운다 (시드는 전부 upsert).
  console.log(`[준비] 시드 데이터를 최신으로 보충합니다. (버전 ${seedVersion} → ${SEED_VERSION})`);
  runNode(tsxCli, ['prisma/seed.ts']);
} else {
  console.log(`[준비] 기존 미리보기 데이터를 사용합니다. (사회복지기관 ${merchants}명)`);
}
