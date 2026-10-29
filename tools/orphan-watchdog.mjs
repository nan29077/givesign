/**
 * 고아 프로세스 감시자.
 *
 * 콘솔에 붙지 않은 독립 프로세스로 실행되며, 서버를 띄운 쪽(배치 파일 / npm / 실행기)이
 * 사라지면 남아 있는 서버 프로세스 트리를 대신 정리한다.
 *
 *   node tools/orphan-watchdog.mjs <정리할 서버 PID> <지켜볼 PID> [지켜볼 PID ...]
 *
 * 동작
 *  - 서버가 이미 끝났으면: 할 일이 없으므로 종료
 *  - 지켜보던 PID 중 하나라도 사라지면: 잠시 기다린 뒤(정상 종료 경로 존중) 서버를 정리하고 종료
 */
import { isAlive, killTreeHard } from './process-guard.mjs';

const serverPid = Number(process.argv[2]);
const watchedPids = process.argv.slice(3).map(Number).filter(Number.isInteger);

if (!Number.isInteger(serverPid) || watchedPids.length === 0) {
  process.exit(2);
}

const POLL_MS = 1000;
/** 지켜보던 프로세스가 사라진 뒤, 정상 종료 경로가 스스로 정리할 시간을 준다 */
const GRACE_MS = 2000;

let ownerGoneAt = null;

const timer = setInterval(() => {
  if (!isAlive(serverPid)) {
    clearInterval(timer);
    process.exit(0);
  }

  const ownerAlive = watchedPids.every((pid) => isAlive(pid));
  if (ownerAlive) {
    ownerGoneAt = null;
    return;
  }

  if (ownerGoneAt === null) {
    ownerGoneAt = Date.now();
    return;
  }

  if (Date.now() - ownerGoneAt >= GRACE_MS) {
    clearInterval(timer);
    killTreeHard(serverPid).finally(() => process.exit(0));
  }
}, POLL_MS);
