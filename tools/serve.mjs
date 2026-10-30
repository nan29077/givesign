/**
 * 개발 / 프로덕션 서버 실행기 (배치 파일 전용 진입점).
 *
 *   node tools/serve.mjs dev     → next dev
 *   node tools/serve.mjs start   → next start
 *
 * npm run dev / npm run start 를 그대로 두고 이 파일을 거치게 하는 이유
 *  - 이전 실행이 남긴 서버를 먼저 정리한다 (옛 빌드가 계속 보이는 문제 방지)
 *  - 창을 닫거나 Ctrl+C 로 끝냈을 때 서버가 고아 프로세스로 남지 않게 한다
 */
import 'dotenv/config';

// .env 에 NODE_ENV 가 들어 있으면 빌드/실행 모드가 뒤섞여 React 오류가 난다.
delete process.env.NODE_ENV;

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { acquireLock, freePort, guardOrphan, killTree, releaseLock } from './process-guard.mjs';

const require = createRequire(import.meta.url);
const MODE = (process.argv[2] ?? 'dev').toLowerCase();
const APP_PORT = Number(process.env.PORT ?? 3060);

if (!['dev', 'start'].includes(MODE)) {
  console.error('사용법: node tools/serve.mjs <dev|start>');
  process.exit(2);
}

let child = null;
let shuttingDown = false;

function localScript(relPath, specifier) {
  const direct = path.resolve(process.cwd(), 'node_modules', relPath);
  if (fs.existsSync(direct)) return direct;
  return require.resolve(specifier);
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child?.pid) {
    killTree(child.pid);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => shutdown(0));
  } catch {
    /* 지원하지 않는 신호는 무시 */
  }
}
process.on('exit', () => {
  if (child?.pid) killTree(child.pid);
  releaseLock();
});

// 이미 실행 중인 서버가 있으면 건드리지 않는다 (빌드/컴파일 중일 수 있다).
const lock = acquireLock(MODE);
if (!lock.ok) {
  const since = lock.startedAt ? new Date(lock.startedAt).toLocaleTimeString('ko-KR') : '알 수 없음';
  console.error('[안내] 기브싸인 서버가 이미 실행 중입니다.');
  console.error(`       실행 중인 창: PID ${lock.pid} (시작 ${since})`);
  console.error('       먼저 실행된 창을 확인해 주세요.');
  console.error('       그 창을 닫았는데도 이 메시지가 보이면 3_서버종료.bat 을 실행한 뒤 다시 시도하세요.');
  process.exit(0);
}

const res = await freePort(APP_PORT, { label: `앱 포트 ${APP_PORT}` });
if (!res.ok) {
  const who = (res.blockedBy ?? []).map((p) => `${p.name}(PID ${p.pid})`).join(', ');
  console.error(`[중단] 앱 포트 ${APP_PORT} 를 정리하지 못했습니다.`);
  if (who) console.error(`       다른 프로그램이 사용 중입니다: ${who}`);
  console.error('       해당 프로그램을 종료한 뒤 다시 실행해 주세요.');
  process.exit(1);
}

// 코드(스키마)와 DB 를 먼저 맞춘다. git pull 뒤 오래된 Prisma 클라이언트·밀린 마이그레이션으로
// 서버가 떠서 화면이 깨지는 것을 막는다(tools/prepare-db.mjs).
try {
  const { prepareDb } = await import('./prepare-db.mjs');
  await prepareDb();
} catch (e) {
  console.error(`[중단] 데이터베이스 준비에 실패했습니다: ${e.message}`);
  console.error('       도구_DB시작.bat 으로 DB 가 켜져 있는지 확인한 뒤 다시 실행해 주세요.');
  releaseLock();
  process.exit(1);
}

const nextBin = localScript('next/dist/bin/next', 'next/dist/bin/next');
// package.json 의 dev/build 와 같은 번들러(webpack)를 쓴다. 섞어 쓰면 같은 .givesign-next 캐시가 꼬인다.
child = spawn(process.execPath, [nextBin, MODE, ...(MODE === 'dev' ? ['--webpack'] : []), '-p', String(APP_PORT)], {
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: MODE === 'dev' ? 'development' : 'production' },
});

// 창을 닫거나 강제 종료되어도 서버가 남지 않게 감시자를 붙인다.
guardOrphan(child.pid);

child.on('error', (e) => {
  console.error(`[오류] 서버를 시작하지 못했습니다: ${e.message}`);
  shutdown(1);
});
child.on('exit', (code) => shutdown(code ?? 0));
