/**
 * 실행 중인 기브싸인 서버 종료.
 *
 * 3_서버종료.bat 이 호출한다. 창을 닫아도 남아 있는 서버(고아 프로세스)를 정리한다.
 *  - 3060 : 앱 서버 (Next.js)
 *  - 5463 : 내장 데이터베이스 (PGlite, 간편 미리보기에서 사용)
 *
 * 안전장치로 node 프로세스만 정리한다. 다른 프로그램이 그 포트를 쓰고 있으면
 * 종료하지 않고 어떤 프로그램인지 알려 준다.
 */
import { clearLock, freePort, portInUse } from './process-guard.mjs';

const APP_PORT = Number(process.env.PORT ?? 3060);
const DB_PORT = Number(process.env.PGLITE_PORT ?? 5463);

const targets = [
  { port: APP_PORT, label: `앱 서버 (포트 ${APP_PORT})` },
  { port: DB_PORT, label: `내장 데이터베이스 (포트 ${DB_PORT})` },
];

const running = [];
for (const t of targets) {
  if (await portInUse(t.port)) running.push(t);
}

if (running.length === 0) {
  clearLock();
  console.log('[안내] 실행 중인 기브싸인 서버가 없습니다.');
  process.exit(0);
}

let failed = false;
for (const t of running) {
  const res = await freePort(t.port, { label: t.label });
  if (res.ok) {
    console.log(`[완료] ${t.label} 를 종료했습니다.`);
  } else {
    failed = true;
    const who = (res.blockedBy ?? []).map((p) => `${p.name}(PID ${p.pid})`).join(', ');
    console.error(`[경고] ${t.label} 를 종료하지 못했습니다.`);
    if (who) console.error(`       기브싸인가 아닌 다른 프로그램이 사용 중입니다: ${who}`);
    else console.error('       작업 관리자에서 Node.js 프로세스를 직접 종료해 주세요.');
  }
}

if (!failed) {
  clearLock();
  console.log('');
  console.log('이제 1_미리보기실행.bat 으로 최신 코드를 다시 실행할 수 있습니다.');
}

process.exit(failed ? 1 : 0);
