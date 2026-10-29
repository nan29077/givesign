import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/generated/prisma/client';
import { env } from '@/lib/env';

/**
 * Prisma 싱글턴 (Prisma 7 driver adapter 방식).
 * 운영(AWS)에서는 RDS Proxy 또는 PgBouncer 를 경유하고,
 * 마이그레이션은 DIRECT_DATABASE_URL 로 수행한다.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({
    connectionString: env.databaseUrl,
    // 서버리스/다중 인스턴스 환경에서는 RDS Proxy 를 함께 사용한다.
    max: Number(process.env.DB_POOL_MAX ?? 10),
    // DB 가 떠 있지 않을 때 요청이 무한 대기하지 않도록 짧게 끊는다.
    // (연결 실패는 화면에 안내로 표시된다)
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5000),
  });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/**
 * 후원자 단위 직렬화용 advisory lock.
 * 동일 후원자의 동시 결제 요청을 트랜잭션 내에서 직렬화한다.
 */
export async function withAdvisoryLock<T>(
  tx: { $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<unknown> },
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', key);
  return fn();
}
