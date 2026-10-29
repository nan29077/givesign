/**
 * E2E 전체 실행기.
 *
 *   npm run dev            (다른 터미널에서 먼저 실행)
 *   npm run test:e2e       (이 스크립트)
 *
 * 스크립트마다 DB 를 초기화·재시드해서 실행 순서에 따라 결과가 달라지지 않게 한다.
 * 재시드를 건너뛰려면: npm run test:e2e -- --no-reseed
 * 일부만 돌리려면:     npm run test:e2e -- round10 studio
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, assertServerUp } from './_helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 기본 실행 대상.
// round10 / studio 는 삭제된 오버레이·유튜브 화면을 검증하는 구간이 남아 있어 기본에서 뺐다.
// (스크립트는 지우지 않는다. 화면을 띄워 보며 구간별로 다시 쓴 뒤 되돌린다)
const SCRIPTS = [
  ['pg', '문자PG 전환 · 자동 정산 · 포인트 지급 · 연동 API'],
  ['round5', '스튜디오 셸·내비게이션'],
  ['round6', '결제 페이지 · PC PIN 결제 전 구간'],
  ['round7', '문의 채널 · 관리자 문의 · 보안'],
  ['round8', '정산 탭 · 원천징수 · 금칙어'],
  ['round9', '민감자료 권한 · 지급대행 · 관리자 권한'],
  ['gap', '기기별 안내 · 모의 고지 · 공개 페이지'],
  ['admin', '관리자 전 화면 스모크 · 한도 정책'],
];

/** 기본 실행에서 빠졌지만 이름을 직접 주면 돌릴 수 있는 스크립트 */
const LEGACY_SCRIPTS = [
  ['round10', '알림 · 정산주기 · 공휴일 · 오버레이 (재작성 필요)'],
  ['studio', '유튜브 · 오버레이 · 스트림 · 설정 (재작성 필요)'],
];

const argv = process.argv.slice(2);
const reseed = !argv.includes('--no-reseed');
const only = argv.filter((a) => !a.startsWith('--'));
const ALL = [...SCRIPTS, ...LEGACY_SCRIPTS];
const targets = only.length ? ALL.filter(([key]) => only.includes(key)) : SCRIPTS;

if (!targets.length) {
  console.error(`실행할 스크립트가 없습니다. 사용 가능: ${ALL.map(([k]) => k).join(', ')}`);
  process.exit(2);
}

await assertServerUp();
console.log(`대상 서버: ${BASE}`);
console.log(`실행 대상 ${targets.length}종${reseed ? ' (스크립트마다 DB 재시드)' : ' (재시드 없음)'}\n`);

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args) => spawnSync(cmd, args, { cwd: path.join(HERE, '..'), stdio: 'inherit', shell: process.platform === 'win32' });

const summary = [];
for (const [key, title] of targets) {
  if (reseed) {
    console.log(`\n[${key}] DB 초기화·재시드`);
    const reset = run(npmCmd, ['run', 'db:reset']);
    const seed = run(npmCmd, ['run', 'db:seed']);
    if (reset.status !== 0 || seed.status !== 0) {
      console.error(`[${key}] 재시드 실패 — 건너뜁니다.`);
      summary.push({ key, title, status: 'SKIP' });
      continue;
    }
  }
  console.log(`\n════════ ${key} — ${title} ════════`);
  const res = run(process.execPath, [path.join(HERE, `${key}-e2e.mjs`)]);
  summary.push({ key, title, status: res.status === 0 ? 'PASS' : 'FAIL' });
}

console.log('\n════════════════ 전체 결과 ════════════════');
for (const s of summary) console.log(`${s.status.padEnd(4)} | ${s.key.padEnd(8)} | ${s.title}`);
const failed = summary.filter((s) => s.status !== 'PASS');
console.log(`\n${summary.length}종 중 ${summary.length - failed.length}종 통과, ${failed.length}종 실패`);
process.exit(failed.length ? 1 : 0);
