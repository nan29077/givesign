/**
 * 데이터베이스 연결 점검.
 * 앱을 띄우기 전에 실행해, 연결이 안 되는데도 서버만 떠서
 * "화면이 계속 로딩만 되는" 상황을 막는다.
 *
 * 종료 코드: 0 = 정상, 1 = 연결 실패
 */
import 'dotenv/config';
import { Client } from 'pg';

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('[실패] DATABASE_URL 이 설정되지 않았습니다. .env 파일을 확인해 주세요.');
  process.exit(1);
}

function describe(target) {
  try {
    const u = new URL(target);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return '(주소 형식 오류)';
  }
}

const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });

try {
  await client.connect();
  const r = await client.query('SELECT current_database() AS db');
  const t = await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'",
  );
  console.log(`[정상] 데이터베이스 연결 성공 (${describe(url)}, 테이블 ${t.rows[0].n}개)`);
  if (t.rows[0].n === 0) {
    console.log('[안내] 테이블이 없습니다. 도구_최초설치.bat 또는 도구_DB초기화.bat 을 실행해 주세요.');
  }
  await client.end();
  process.exit(0);
} catch (e) {
  const msg = String(e?.message ?? e);
  console.error(`[실패] 데이터베이스에 연결할 수 없습니다. (${describe(url)})`);
  console.error(`       원인: ${msg}`);
  console.error('');
  if (/ECONNREFUSED|timeout/i.test(msg)) {
    console.error('  해결 방법');
    console.error('   1) Docker Desktop 을 사용 중이면 도구_DB시작.bat 을 먼저 실행하세요.');
    console.error('   2) 직접 설치한 PostgreSQL 을 쓰신다면 서비스가 실행 중인지 확인하세요.');
    console.error('   3) 포트나 계정이 다르면 .env 의 DATABASE_URL 을 수정하세요.');
  } else if (/password|authentication/i.test(msg)) {
    console.error('  해결 방법: .env 의 DATABASE_URL 계정/비밀번호를 확인하세요.');
  } else if (/does not exist/i.test(msg)) {
    console.error('  해결 방법: 데이터베이스가 없습니다. 도구_DB시작.bat 으로 컨테이너를 띄우거나 DB 를 생성하세요.');
  }
  try {
    await client.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
}
