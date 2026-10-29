import 'dotenv/config';

// 테스트는 항상 mock 어댑터와 로컬 암호화를 사용한다.
process.env.PAYMENT_PROVIDER = 'mock';
process.env.MO_PROVIDER = 'mock';
process.env.MT_PROVIDER = 'mock';
process.env.YOUTUBE_PROVIDER = 'mock';
process.env.TTS_PROVIDER = 'mock';
process.env.CRYPTO_PROVIDER = 'local';
process.env.SAFE_MODE = 'true';
process.env.ALLOW_DIRECT_TRIGGER = 'true'; // DIRECT_TRIGGER 경로도 테스트한다
process.env.ALLOW_INMEMORY_FALLBACK = 'true';
// 테스트에서는 Redis 대신 인메모리 스토어를 사용해 상태를 격리한다.
process.env.REDIS_URL = '';
process.env.MO_ALLOWED_IPS = '';

// 내장 DB(PGlite)는 단일 세션 위에 여러 연결을 다중화(multiplex)한다.
// 연결 풀이 2개 이상이면 동시 요청의 트랜잭션·prepared statement 가 서로 섞여
// "방금 만든 행을 찾을 수 없음", "bind message supplies N parameters" 같은 오류가 난다.
// PGlite 를 대상으로 할 때는 연결을 1개로 고정해 실제 PostgreSQL 과 같은 결과를 보장한다.
const pglitePort = process.env.PGLITE_PORT ?? '5463';
const isPglite = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${pglitePort}/`);
if (isPglite) process.env.DB_POOL_MAX = '1';

// 테스트가 끝난 뒤 개발 DB 에 테스트 잔여 데이터를 남기지 않는다.
import { afterAll } from 'vitest';

afterAll(async () => {
  const { resetDb } = await import('./helpers');
  const { prisma } = await import('@/server/db');
  await resetDb();
  await prisma.$disconnect();
});
