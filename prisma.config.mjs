import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma CLI 설정.
 *
 * 마이그레이션은 반드시 **풀러를 거치지 않는 직결 URL** 로 수행한다.
 * 운영(AWS)에서 DATABASE_URL 을 RDS Proxy / PgBouncer 로 잡아두면
 * 마이그레이션의 DDL + advisory lock 조합이 트랜잭션 풀링과 충돌해
 * 실패하거나 중간에 멈춘다. DIRECT_DATABASE_URL 이 있으면 그것을 우선 사용한다.
 * (앱 런타임은 src/server/db.ts 에서 DATABASE_URL = 풀러 경유로 접속한다)
 */
const migrationUrl = process.env.DIRECT_DATABASE_URL?.trim() || process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    url: migrationUrl,
    /**
     * 드리프트 탐지(`prisma migrate diff --from-migrations ... --to-schema`)에 필요하다.
     * 지정하지 않으면 "shadowDatabaseUrl 을 설정하라"는 오류로 검사 자체가 불가능해지고,
     * 스키마와 마이그레이션이 어긋난 채 배포되는 사고를 사전에 잡을 수 없다.
     */
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
  },
});
