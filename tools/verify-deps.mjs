/**
 * 설치된 패키지의 무결성 검사.
 *
 * npm install 이 중간에 끊기면 폴더는 있지만 내부 파일이 빠진 패키지가 생긴다.
 * (예: retry 패키지에 lib/ 폴더가 없어 'Cannot find module ./lib/retry' 발생)
 * 이 스크립트는 각 패키지의 진입 파일이 실제로 존재하는지 확인하고,
 * 핵심 패키지는 직접 resolve 해 본다.
 *
 * 종료 코드: 0 = 정상, 1 = 손상 발견
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(process.cwd(), 'node_modules');

if (!fs.existsSync(root)) {
  console.error('[손상] node_modules 폴더가 없습니다.');
  process.exit(1);
}

const problems = [];

/** npm 이 설치 도중 만드는 임시 폴더 이름 (.패키지명-8자리무작위) */
function isNpmTempDir(name) {
  return /^\.[A-Za-z0-9@._-]+-[A-Za-z0-9_-]{8}$/.test(name);
}

/** package.json 의 main 진입 파일이 실제로 존재하는지 확인 */
function checkPackage(dir, name) {
  const pkgPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    problems.push(`${name}: package.json 없음`);
    return;
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    problems.push(`${name}: package.json 손상`);
    return;
  }
  // exports 필드를 쓰는 패키지는 main 이 실제 경로가 아닐 수 있으므로 건너뛴다
  if (pkg.exports) return;
  const main = typeof pkg.main === 'string' ? pkg.main : null;
  if (!main) return;
  const candidates = [
    path.join(dir, main),
    path.join(dir, `${main}.js`),
    path.join(dir, main, 'index.js'),
  ];
  if (!candidates.some((c) => fs.existsSync(c))) {
    problems.push(`${name}: 진입 파일(${main}) 없음`);
  }
}

function scan() {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) {
      // npm 이 설치 중 만드는 임시 폴더(.이름-XXXXXXXX)가 남아 있으면 설치가 깨진 것이다
      if (isNpmTempDir(entry.name)) problems.push(`설치 임시 폴더 잔존: ${entry.name}`);
      continue;
    }
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(root, entry.name);
      for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        if (sub.name.startsWith('.')) {
          if (isNpmTempDir(sub.name)) problems.push(`설치 임시 폴더 잔존: ${entry.name}/${sub.name}`);
          continue;
        }
        checkPackage(path.join(scopeDir, sub.name), `${entry.name}/${sub.name}`);
      }
    } else {
      checkPackage(path.join(root, entry.name), entry.name);
    }
  }
}

/** 앱 구동에 반드시 필요한 모듈은 직접 resolve 로 확인 */
const CRITICAL = [
  'next',
  'react',
  'react-dom',
  '@prisma/client',
  '@prisma/adapter-pg',
  'pg',
  'dotenv',
  'zod',
  'ioredis',
  'bcryptjs',
  'jose',
  'ulid',
  'lucide-react',
  'retry/lib/retry.js',
  'proper-lockfile',
];

function checkCritical() {
  for (const m of CRITICAL) {
    try {
      require.resolve(m, { paths: [process.cwd()] });
    } catch (e) {
      problems.push(`${m}: 불러올 수 없음 (${e.code ?? 'ERROR'})`);
    }
  }
}

scan();
checkCritical();

if (problems.length === 0) {
  console.log('[정상] 패키지 무결성 확인 완료');
  process.exit(0);
}

console.error(`[손상] 문제가 있는 패키지 ${problems.length}건`);
for (const p of problems.slice(0, 20)) console.error(`  - ${p}`);
if (problems.length > 20) console.error(`  ... 외 ${problems.length - 20}건`);
process.exit(1);
