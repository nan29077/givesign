/**
 * 서버를 띄우기 전에 코드와 DB 를 맞춘다 (개발 서버·HMR 실행기 공용).
 *
 *   1) Prisma 클라이언트(src/generated) 재생성
 *   2) 밀린 마이그레이션 적용 (migrate deploy — 이미 적용된 것은 건너뛰고 데이터는 유지)
 *   3) 시드 버전이 낮으면 부족한 시드만 보충 (시드는 전부 upsert)
 *
 * 왜 필요한가
 *   예전 실행기는 src/generated 폴더가 "없을 때만" 클라이언트를 만들고 마이그레이션은 하지 않았다.
 *   git pull 로 스키마가 바뀌어도 오래된 클라이언트와 DB 로 서버가 떠서 새 모델(캠페인·정기후원·영수증 등)을
 *   쓰는 화면이 깨졌다. 생성·확인은 몇 초면 끝나므로 실행할 때마다 한다.
 *
 * 내장 DB(PGlite) 미리보기는 tools/pglite-init.mjs 가 같은 일을 한다.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SEED_VERSION, SEED_VERSION_KEY } from '../prisma/seed-version.mjs';

const require = createRequire(import.meta.url);

function localScript(relPath, specifier) {
  const direct = path.resolve(process.cwd(), 'node_modules', relPath);
  if (fs.existsSync(direct)) return direct;
  return require.resolve(specifier);
}

const runNode = (scriptPath, args) =>
  execFileSync(process.execPath, [scriptPath, ...args], { stdio: 'inherit', shell: false });

const prismaCli = localScript('prisma/build/index.js', 'prisma/build/index.js');
const tsxCli = localScript('tsx/dist/cli.mjs', 'tsx/dist/cli.mjs');

export async function prepareDb({ seed = true } = {}) {
  console.log('[준비] Prisma 클라이언트를 생성합니다.');
  runNode(prismaCli, ['generate']);

  if (!process.env.DATABASE_URL) {
    console.warn('[안내] DATABASE_URL 이 없어 마이그레이션 확인을 건너뜁니다.');
    return;
  }

  console.log('[준비] 데이터베이스 마이그레이션을 확인합니다.');
  runNode(prismaCli, ['migrate', 'deploy']);

  if (!seed) return;
  let merchants = 0;
  let seedVersion = 0;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    try {
      merchants = (await client.query('SELECT count(*)::int AS n FROM merchant_profile')).rows[0].n;
    } catch {
      merchants = 0;
    }
    try {
      const r = await client.query('SELECT value FROM system_setting WHERE key = $1', [SEED_VERSION_KEY]);
      seedVersion = Number(r.rows[0]?.value ?? 0) || 0;
    } catch {
      seedVersion = 0;
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  if (merchants === 0) {
    console.log('[준비] 시드 데이터가 없어 생성합니다.');
    runNode(tsxCli, ['prisma/seed.ts']);
  } else if (seedVersion < SEED_VERSION) {
    console.log(`[준비] 시드 데이터를 최신으로 보충합니다. (버전 ${seedVersion} → ${SEED_VERSION})`);
    runNode(tsxCli, ['prisma/seed.ts']);
  }
}

// 단독 실행: node tools/prepare-db.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDb().catch((e) => {
    console.error(`[중단] 데이터베이스 준비에 실패했습니다: ${e.message}`);
    process.exit(1);
  });
}
