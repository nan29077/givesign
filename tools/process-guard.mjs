/**
 * 서버 프로세스 정리 도우미.
 *
 * 해결하려는 문제
 *  - Windows 에서 Ctrl+C 후 "배치 작업을 끝내시겠습니까(Y/N)" 에 Y 를 누르거나 창을 X 로 닫으면
 *    배치 파일과 npm 만 종료되고, 실제 서버(node) 는 고아 프로세스로 남아 포트를 계속 점유한다.
 *  - 그 상태에서 다시 실행하면 "이미 실행 중" 으로 취급되어 옛 빌드가 계속 보인다.
 *
 * 제공 기능
 *  1) freePort()      : 해당 포트를 점유한 이전 서버(node)를 정리한다.
 *  2) killTree()      : 자식까지 포함해 프로세스를 종료한다.
 *  3) guardOrphan()   : 상위 셸이 사라지면 이 프로세스 트리를 대신 정리해 줄 감시자를 띄운다.
 *  4) onShutdown()    : Ctrl+C / 창 닫힘 / 종료 시 정리 함수를 호출한다.
 *
 * CLI 로도 쓸 수 있다.  node tools/process-guard.mjs free 3060 5463
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
/** 정리 대상으로 삼는 프로세스 이름. 관계없는 프로그램을 실수로 끄지 않기 위한 안전장치 */
const KILLABLE = ['node.exe', 'node'];

function quiet(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** 지정한 포트를 LISTEN 중인 프로세스 목록 → [{ pid, name }] */
export function listPortListeners(port) {
  const pids = new Set();

  if (IS_WIN) {
    for (const line of quiet('netstat', ['-ano']).split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      // 예: TCP    0.0.0.0:3060    0.0.0.0:0    LISTENING    12345
      if (parts.length < 5 || parts[0] !== 'TCP') continue;
      if (parts[3] !== 'LISTENING') continue;
      if (!parts[1].endsWith(`:${port}`)) continue;
      const pid = Number(parts[4]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  } else {
    const out =
      quiet('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']) ||
      quiet('fuser', [`${port}/tcp`]);
    for (const token of out.split(/\s+/)) {
      const pid = Number(token.trim());
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
  }

  return [...pids].map((pid) => ({ pid, name: processName(pid) }));
}

/** PID 의 실행 파일 이름 (알 수 없으면 빈 문자열) */
export function processName(pid) {
  if (IS_WIN) {
    const out = quiet('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return out.split(',')[0]?.replace(/"/g, '').trim() ?? '';
  }
  return quiet('ps', ['-p', String(pid), '-o', 'comm=']).trim();
}

/** 프로세스가 살아 있는지 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * 자손 프로세스 PID 목록 (깊은 것부터).
 * next 서버가 워커를 띄우는 경우처럼 손자 프로세스까지 훑는다.
 */
export function listDescendants(pid) {
  if (IS_WIN) return [];
  const out = quiet('ps', ['-eo', 'pid=,ppid=']);
  const children = new Map();
  for (const line of out.split(/\r?\n/)) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(c) || !Number.isInteger(p)) continue;
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(c);
  }
  const result = [];
  const visit = (target) => {
    for (const c of children.get(target) ?? []) {
      visit(c);
      result.push(c); // 자식을 먼저 넣어 깊은 것부터 종료되게 한다
    }
  };
  visit(pid);
  return result;
}

/** 자식·손자 프로세스까지 함께 종료한다 (동기). */
export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return;
  if (IS_WIN) {
    // /T 가 자식 트리까지, /F 가 강제 종료를 담당한다.
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  for (const child of listDescendants(pid)) {
    try {
      process.kill(child, signal);
    } catch {
      /* 이미 종료됨 */
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* 이미 종료됨 */
  }
}

/** 종료를 확실히 한다. 먼저 정상 종료를 요청하고, 남으면 강제 종료한다. */
export async function killTreeHard(pid, graceMs = 2000) {
  if (!pid) return;
  const doomed = IS_WIN ? [] : [...listDescendants(pid), pid];
  killTree(pid, 'SIGTERM');
  if (IS_WIN) return;

  await new Promise((r) => setTimeout(r, graceMs));
  for (const p of doomed) {
    if (!isAlive(p)) continue;
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* 이미 종료됨 */
    }
  }
}

async function waitPortFree(port, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!(await portInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return !(await portInUse(port));
}

/** 포트에 연결이 되는지 (LISTEN 여부 확인용) */
export function portInUse(port) {
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

/**
 * 포트를 점유한 이전 서버를 정리한다.
 * - node 프로세스만 정리한다. 다른 프로그램이 쓰고 있으면 정리하지 않고 false 를 돌려준다.
 * @returns {Promise<{ ok: boolean, killed: number[], blockedBy?: {pid:number,name:string}[] }>}
 */
export async function freePort(port, { label = `포트 ${port}`, log = console.log } = {}) {
  if (!(await portInUse(port))) return { ok: true, killed: [] };

  const listeners = listPortListeners(port);
  if (listeners.length === 0) {
    // 포트는 열려 있는데 소유자를 못 찾은 경우(권한 등). 잠시 기다렸다가 상태만 다시 확인한다.
    const freed = await waitPortFree(port, 3000);
    return freed ? { ok: true, killed: [] } : { ok: false, killed: [], blockedBy: [] };
  }

  const mine = listeners.filter((p) => KILLABLE.includes(p.name.toLowerCase()));
  const others = listeners.filter((p) => !KILLABLE.includes(p.name.toLowerCase()));

  if (mine.length === 0) {
    return { ok: false, killed: [], blockedBy: others };
  }

  log(`[정리] ${label} 를 쓰고 있던 이전 서버를 종료합니다 (PID ${mine.map((p) => p.pid).join(', ')})`);
  for (const p of mine) killTree(p.pid);

  const freed = await waitPortFree(port);
  return freed
    ? { ok: true, killed: mine.map((p) => p.pid) }
    : { ok: false, killed: mine.map((p) => p.pid), blockedBy: others };
}

/**
 * 서버가 고아로 남지 않도록 감시자를 띄운다.
 *
 * 창을 X 로 닫거나 "배치 작업을 끝내시겠습니까(Y/N)" 에서 Y 를 누르면 종료 신호가
 * 제대로 전달되지 않는 경우가 있어, 신호 처리만으로는 고아 프로세스를 막을 수 없다.
 * 콘솔에 붙지 않은 별도 프로세스가 지켜보다가 대신 정리한다.
 *
 * @param serverPid 정리 대상(실제 서버 프로세스)
 * @returns 감시자 프로세스 또는 null
 */
export function guardOrphan(serverPid) {
  if (process.env.BASIC_NO_GUARD === '1') return null;
  if (!serverPid) return null;

  // 상위 셸(배치 파일 / npm)과 이 실행기 자신을 함께 지켜본다.
  // 둘 중 하나라도 사라지면 서버만 남는 상황이므로 정리한다.
  const watched = [process.pid];
  if (process.ppid && process.ppid !== 1) watched.push(process.ppid);

  const watchdog = path.join(path.dirname(fileURLToPath(import.meta.url)), 'orphan-watchdog.mjs');
  try {
    const proc = spawn(
      process.execPath,
      [watchdog, String(serverPid), ...watched.map(String)],
      { stdio: 'ignore', detached: true, windowsHide: true },
    );
    proc.unref();
    return proc;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- 실행 잠금

/**
 * 실행 잠금 파일.
 *
 * 화면 빌드에는 1~3분이 걸리는데, 그동안에는 포트가 아직 열리지 않는다.
 * 이때 배치 파일을 다시 더블클릭하면 "포트 정리" 로직이 빌드 중이던 앞선 실행을
 * 종료시켜 버려서, 빌드가 영영 끝나지 않는 상황이 생긴다.
 * 살아 있는 실행이 있으면 새 실행을 막기 위해 잠금 파일을 쓴다.
 */
function lockPath() {
  return path.resolve(process.cwd(), '.givesign-server.lock');
}

export function readLock() {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    return Number.isInteger(raw?.pid) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 잠금을 얻는다.
 * - 살아 있는 다른 실행이 있으면 { ok: false, pid, startedAt } 을 돌려준다.
 * - 주인이 이미 사라진 잠금(고아)은 오래된 것으로 보고 덮어쓴다.
 */
export function acquireLock(label = 'server') {
  const existing = readLock();
  if (existing && existing.pid !== process.pid && isAlive(existing.pid)) {
    return { ok: false, ...existing };
  }
  try {
    fs.writeFileSync(
      lockPath(),
      JSON.stringify({ pid: process.pid, label, startedAt: new Date().toISOString() }),
    );
  } catch {
    /* 잠금 파일을 못 써도 실행 자체는 막지 않는다 */
  }
  return { ok: true };
}

/** 내가 가진 잠금만 해제한다. */
export function releaseLock() {
  const existing = readLock();
  if (existing && existing.pid !== process.pid) return;
  try {
    fs.unlinkSync(lockPath());
  } catch {
    /* 이미 없음 */
  }
}

/** 잠금 파일을 무조건 지운다 (stop 처리용). */
export function clearLock() {
  try {
    fs.unlinkSync(lockPath());
  } catch {
    /* 이미 없음 */
  }
}

// --------------------------------------------------------------------------- CLI

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const [action, ...rest] = process.argv.slice(2);
  if (action === 'free') {
    let allOk = true;
    for (const raw of rest) {
      const port = Number(raw);
      if (!Number.isInteger(port)) continue;
      const res = await freePort(port);
      if (!res.ok) {
        allOk = false;
        const who = (res.blockedBy ?? []).map((p) => `${p.name}(${p.pid})`).join(', ');
        console.error(`[경고] 포트 ${port} 를 정리하지 못했습니다.${who ? ` 사용 중: ${who}` : ''}`);
      }
    }
    process.exit(allOk ? 0 : 1);
  } else {
    console.error('사용법: node tools/process-guard.mjs free <port> [port...]');
    process.exit(2);
  }
}
