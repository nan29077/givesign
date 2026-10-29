/**
 * 간편 미리보기 실행기.
 *
 * 하나의 Node 프로세스에서
 *   1) 내장 데이터베이스(PGlite) 를 PostgreSQL 통신 규약으로 기동
 *   2) 처음이면 마이그레이션 + 시드
 *   3) Next.js 개발 서버 실행
 * 을 순서대로 수행한다.
 *
 * 셸(cmd/PowerShell/bash)의 따옴표 처리 차이에 영향을 받지 않도록
 * 모든 단계를 이 스크립트 안에서 직접 실행한다.
 */
import 'dotenv/config';

// .env 에 NODE_ENV 가 들어 있으면 빌드/실행 모드가 뒤섞여 React 오류가 난다.
// Next.js 가 스스로 결정하도록 여기서 제거한다.
delete process.env.NODE_ENV;
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { acquireLock, freePort, guardOrphan, killTree, releaseLock } from './process-guard.mjs';

const DB_PORT = Number(process.env.PGLITE_PORT ?? 5463);
const APP_PORT = Number(process.env.PORT ?? 3060);
const DATA_DIR = path.resolve(process.cwd(), '.givesign-pglite');
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;

const require = createRequire(import.meta.url);
/**
 * 기본은 프로덕션 빌드 방식(production).
 * Next 16 의 개발 서버(Turbopack)는 환경에 따라 내부 오류로 중단되는 사례가 있어
 * 미리보기 기본값으로 쓰지 않는다. 코드 수정을 즉시 반영하려면 PREVIEW_MODE=dev.
 */
const MODE = (process.env.PREVIEW_MODE ?? 'production').toLowerCase();
let socketServer = null;
let child = null;
let shuttingDown = false;

function log(msg) {
  console.log(msg);
}

async function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(700);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

/** 자식 프로세스를 실행하고 종료 코드를 기다린다. */
function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    // 셸을 거치지 않는다. Windows 의 "C:\\Program Files\\nodejs\\node.exe" 처럼
    // 경로에 공백이 있으면 셸이 명령을 잘라먹기 때문이다.
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, ...extraEnv },
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`실행 실패 (코드 ${code})`));
    });
  });
}

/** 로컬 node_modules 안의 실행 스크립트 경로를 얻는다.
 *  패키지의 exports 제한을 우회하기 위해 실제 파일 경로를 우선 사용한다. */
function localScript(relPath, specifier) {
  const direct = path.resolve(process.cwd(), 'node_modules', relPath);
  if (fs.existsSync(direct)) return direct;
  return require.resolve(specifier);
}

/** 서버가 응답할 때까지 기다렸다가 기본 브라우저로 연다. */
async function openBrowserWhenReady(url) {
  if (process.env.PREVIEW_OPEN === '0') return;
  for (let i = 0; i < 180; i += 1) {
    if (shuttingDown) return;
    if (await portInUse(APP_PORT)) {
      try {
        const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
        const body = await health.json();
        if (!health.ok || body?.checks?.database !== 'ok') {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
        } else if (process.platform === 'darwin') {
          spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
        } else {
          spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
        }
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** 소스가 마지막 빌드보다 새로우면 다시 빌드해야 한다. */
function needsBuild() {
  const buildId = path.join(process.cwd(), '.givesign-next', 'BUILD_ID');
  if (!fs.existsSync(buildId)) return true;
  const builtAt = fs.statSync(buildId).mtimeMs;

  const watch = ['src', 'prisma', 'public', 'package.json', 'next.config.ts', 'postcss.config.mjs'];
  let newest = 0;
  const visit = (target) => {
    if (!fs.existsSync(target)) return;
    const st = fs.statSync(target);
    if (st.isDirectory()) {
      if (path.basename(target) === 'generated') return;
      for (const e of fs.readdirSync(target)) visit(path.join(target, e));
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  };
  for (const w of watch) visit(path.resolve(process.cwd(), w));
  return newest > builtAt;
}

async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  // 자식(Next 서버)이 워커를 띄웠을 수 있으므로 트리째 종료한다.
  // 이렇게 하지 않으면 창을 닫아도 서버만 남아 포트를 계속 점유한다.
  if (child?.pid) {
    killTree(child.pid);
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  if (socketServer) {
    try {
      await socketServer.stop();
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

/**
 * Ctrl+C / 창 닫힘(SIGHUP) / 종료 요청 모두에서 서버를 함께 내린다.
 * 신호 처리기를 등록하면 기본 종료 동작이 사라지므로 반드시 직접 종료까지 수행한다.
 */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      void shutdown(0);
    });
  } catch {
    /* 지원하지 않는 신호는 무시 */
  }
}

/** 어떤 경로로 끝나든 자식 서버가 남지 않게 하는 마지막 안전장치 */
process.on('exit', () => {
  if (child?.pid) killTree(child.pid);
  releaseLock();
});

async function main() {
  // 이미 실행 중인 미리보기가 있으면 건드리지 않는다.
  // (화면 빌드 중에는 포트가 아직 열리지 않아, 포트만 보고 판단하면 빌드 중인 실행을 죽이게 된다)
  const lock = acquireLock('preview');
  if (!lock.ok) {
    const since = lock.startedAt ? new Date(lock.startedAt).toLocaleTimeString('ko-KR') : '알 수 없음';
    console.error('[안내] 기브싸인 미리보기가 이미 실행 중입니다.');
    console.error(`       실행 중인 창: PID ${lock.pid} (시작 ${since})`);
    console.error('       화면 빌드 중이면 1~3분 걸립니다. 먼저 실행된 창을 확인해 주세요.');
    console.error('       그 창을 닫았는데도 이 메시지가 보이면 3_서버종료.bat 을 실행한 뒤 다시 시도하세요.');
    process.exit(0);
  }

  // 이전 실행이 창만 닫히고 서버는 남아 있는 경우가 있다.
  // 옛 빌드가 계속 보이는 것을 막기 위해, 남은 서버를 정리하고 새로 시작한다.
  for (const [port, label] of [
    [APP_PORT, `앱 포트 ${APP_PORT}`],
    [DB_PORT, `내장 데이터베이스 포트 ${DB_PORT}`],
  ]) {
    const res = await freePort(port, { label, log });
    if (!res.ok) {
      const who = (res.blockedBy ?? []).map((p) => `${p.name}(PID ${p.pid})`).join(', ');
      console.error(`[중단] ${label} 를 정리하지 못했습니다.`);
      if (who) console.error(`       다른 프로그램이 사용 중입니다: ${who}`);
      console.error('       해당 프로그램을 종료한 뒤 다시 실행해 주세요.');
      process.exit(1);
    }
  }

  const firstRun = !fs.existsSync(DATA_DIR);
  log(`[1/3] 내장 데이터베이스 기동 (${firstRun ? '새로 생성' : '기존 데이터 사용'})`);

  const db = await PGlite.create({ dataDir: DATA_DIR });
  socketServer = new PGLiteSocketServer({
    db,
    port: DB_PORT,
    host: '127.0.0.1',
    // Next 빌드/페이지 수집 워커가 동시에 연결하더라도 새 요청을 거부하지 않게 한다.
    // 실제 앱의 연결 풀은 아래 previewEnv에서 2개로 제한한다.
    maxConnections: 100,
  });
  await socketServer.start();
  log(`      준비 완료 (127.0.0.1:${DB_PORT})`);

  const previewEnv = {
    DATABASE_URL,
    DB_POOL_MAX: '2',
    DB_CONNECT_TIMEOUT_MS: '10000',
    ALLOW_INMEMORY_FALLBACK: 'true',
  };
  Object.assign(process.env, previewEnv);

  log('[2/3] 스키마 및 시드 데이터 확인');
  await run(process.execPath, [path.join('tools', 'pglite-init.mjs')], previewEnv);

  // npx/셸을 거치지 않고 next 실행 파일을 직접 호출한다 (Windows 따옴표 문제 회피)
  const nextBin = localScript('next/dist/bin/next', 'next/dist/bin/next');

  if (MODE === 'dev') {
    log(`[3/3] 개발 서버 시작 (http://localhost:${APP_PORT})`);
    child = spawn(process.execPath, [nextBin, 'dev', '--webpack', '-p', String(APP_PORT)], {
      stdio: 'inherit',
      env: { ...process.env, ...previewEnv, NODE_ENV: 'development' },
    });
  } else {
    if (needsBuild()) {
      log('[3/4] 화면 빌드 (처음에는 1~3분 걸립니다)');
      await run(process.execPath, [nextBin, 'build'], { ...previewEnv, NODE_ENV: 'production' });
    } else {
      log('[3/4] 이전 빌드 결과를 재사용합니다');
    }
    log(`[4/4] 서버 시작 (http://localhost:${APP_PORT})`);
    child = spawn(process.execPath, [nextBin, 'start', '-p', String(APP_PORT)], {
      stdio: 'inherit',
      env: { ...process.env, ...previewEnv, NODE_ENV: 'production' },
    });
  }

  // 창을 닫거나(X) 강제 종료되어도 서버가 고아로 남지 않게 감시자를 붙인다.
  guardOrphan(child.pid);

  openBrowserWhenReady(`http://localhost:${APP_PORT}`);

  child.on('error', async (e) => {
    console.error(`[오류] 개발 서버를 시작하지 못했습니다: ${e.message}`);
    await shutdown(1);
  });
  child.on('exit', async (code) => {
    await shutdown(code ?? 0);
  });
}

main().catch(async (e) => {
  console.error('');
  console.error(`[오류] 미리보기 실행에 실패했습니다: ${e?.message ?? e}`);
  if (e?.stack) console.error(e.stack);
  await shutdown(1);
});
