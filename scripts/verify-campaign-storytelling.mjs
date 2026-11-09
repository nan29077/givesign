// 기존 DB에 접속하지 않고 메모리 DB에서 콘텐츠 회귀 테스트를 실행한다.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const db = new PGlite();
await db.waitReady;
for (const dir of (await readdir('prisma/migrations')).sort()) {
  if (!/^\d/.test(dir)) continue;
  await db.exec(await readFile(path.join('prisma/migrations', dir, 'migration.sql'), 'utf8'));
}
const port = 5471;
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 100 });
await server.start();
try {
  const files = process.argv.slice(2);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...(files.length ? files : ['tests/campaign-storytelling.test.ts', 'tests/campaign-card-news.test.ts', 'tests/ai-content-2026-11-06.test.ts', 'tests/automation.test.ts'])], {
      stdio: 'inherit', env: { ...process.env, DATABASE_URL: `postgresql://postgres:postgres@127.0.0.1:${port}/givesign`, PGLITE: '1', PGLITE_PORT: String(port), DB_POOL_MAX: '1', LLM_PROVIDER: 'mock' },
    });
    child.on('error', reject);
    child.on('exit', resolve);
  });
  process.exitCode = typeof code === 'number' ? code : 1;
} finally {
  await server.stop();
  await db.close();
}
