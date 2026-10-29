/**
 * EMMA DB 접근 계층.
 *
 * EMMA 는 자기 테이블(em_mo_log_YYYYMM, em_smt_tran)에 직접 읽고 쓴다. 우리는 그 테이블을
 * 조회·갱신해야 하는데, **EMMA 를 어느 DB 에 붙였는지에 따라 접근 방법이 달라진다.**
 *
 *  1) EMMA_DB_URL 미설정 → EMMA 가 앱과 같은 DB 를 쓰는 구성.
 *     Prisma 의 raw 쿼리를 그대로 재사용한다. 커넥션을 새로 열지 않는다.
 *
 *  2) EMMA_DB_URL 설정 → EMMA 전용 DB 를 따로 둔 구성(**권장**).
 *     전용 pg Pool 을 만든다.
 *
 * 왜 전용 DB 를 권하는가
 * ----------------------
 * EMMA 는 테이블 생성·프로시저 생성·실행 권한을 요구한다(설치 매뉴얼 부록 H). 그런데 우리 DB 에는
 * 수정·삭제가 트리거로 막힌 정산 원장(settlement_ledger)과 암호화된 빌키·계좌가 들어 있다.
 * 여기에 DDL 권한을 가진 외부 데몬을 붙이는 것은 피하는 편이 낫다. 반대로 Prisma 쪽에서도
 * 스키마에 없는 em_* 테이블을 지워 버릴 위험이 있다.
 *
 * 커넥션 정책
 * -----------
 * 같은 DB 구성에서 pg Pool 을 따로 만들지 않는 이유는 테스트 때문이기도 하다. 통합 테스트는
 * PGlite 를 소켓으로 노출해 쓰는데, 단일 세션 위에 연결을 다중화하므로 풀을 하나 더 열면
 * 트랜잭션이 서로 섞인다(tests/setup.ts 주석 참고).
 */

import type { Pool as PgPool } from 'pg';
import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { toKst } from '@/lib/datetime';

/** SELECT/UPDATE 를 같은 모양으로 부르기 위한 얇은 인터페이스. */
export interface EmmaQuerier {
  /** 결과 행을 반환한다. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** 영향받은 행 수를 반환한다. */
  execute(sql: string, params?: unknown[]): Promise<number>;
}

const globalForEmma = globalThis as unknown as { emmaPool?: PgPool };

/** EMMA 전용 DB 를 쓰는 구성인지 여부. */
export function usesDedicatedDb(): boolean {
  const url = env.emma.dbUrl.trim();
  return url !== '' && url !== env.databaseUrl;
}

async function getPool(): Promise<PgPool> {
  if (globalForEmma.emmaPool) return globalForEmma.emmaPool;
  // pg 는 서버 전용 모듈이다. 클라이언트 번들에 섞이지 않도록 실행 시점에 불러온다.
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: env.emma.dbUrl,
    max: env.emma.poolMax,
    connectionTimeoutMillis: 5000,
    // 폴링은 짧게 자주 돈다. 유휴 연결을 오래 붙들지 않는다.
    idleTimeoutMillis: 30_000,
  });
  // 풀 레벨 오류로 프로세스가 죽지 않게 한다(원격 DB 재시작 등).
  pool.on('error', (e) => logger.error('EMMA DB 풀 오류', { message: e.message }));
  globalForEmma.emmaPool = pool;
  return pool;
}

/** 현재 구성에 맞는 조회기를 돌려준다. */
export function getEmmaQuerier(): EmmaQuerier {
  if (!usesDedicatedDb()) {
    return {
      async query<T>(sql: string, params: unknown[] = []) {
        return prisma.$queryRawUnsafe<T[]>(sql, ...params);
      },
      async execute(sql: string, params: unknown[] = []) {
        return prisma.$executeRawUnsafe(sql, ...params);
      },
    };
  }

  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const pool = await getPool();
      const r = await pool.query(sql, params as never[]);
      return r.rows as T[];
    },
    async execute(sql: string, params: unknown[] = []) {
      const pool = await getPool();
      const r = await pool.query(sql, params as never[]);
      return r.rowCount ?? 0;
    },
  };
}

/** 테스트·종료 시 전용 풀을 닫는다. 같은 DB 구성에서는 아무것도 하지 않는다. */
export async function closeEmmaPool(): Promise<void> {
  const pool = globalForEmma.emmaPool;
  if (!pool) return;
  globalForEmma.emmaPool = undefined;
  await pool.end().catch(() => undefined);
}

/**
 * MO 로그 테이블 접미사(YYYYMM).
 *
 * EMMA 는 `TO_CHAR(date_mo, 'yyyymm')` 으로 테이블을 나눈다. date_mo 는 한국 통신망에서 온
 * 시각이고 EMMA 도 국내 서버에서 도므로 KST 기준이 맞다.
 */
export function moTableSuffix(date = new Date()): string {
  const k = toKst(date);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 폴링 대상 접미사 목록(이번 달 + 지난 달).
 *
 * 월이 바뀌는 순간 아직 처리하지 못한 지난달 행이 남아 있을 수 있다. 매달 1일 새벽에 결제 요청이
 * 조용히 유실되는 것을 막기 위해 두 달을 함께 본다.
 */
export function pollingSuffixes(date = new Date()): string[] {
  const k = toKst(date);
  const prev = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() - 1, 1));
  const prevSuffix = `${prev.getUTCFullYear()}${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  const current = moTableSuffix(date);
  return current === prevSuffix ? [current] : [current, prevSuffix];
}

/**
 * 테이블 존재 여부.
 *
 * EMMA 를 아직 설치하지 않았거나 그 달 수신이 한 건도 없으면 테이블 자체가 없다. 이때 조회
 * 예외로 배치가 죽으면 다른 정리 작업까지 멈추므로, 미리 확인하고 조용히 건너뛴다.
 */
export async function moTableExists(suffix: string): Promise<boolean> {
  const q = getEmmaQuerier();
  try {
    const rows = await q.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = $1
       ) AS exists`,
      [`em_mo_log_${suffix}`],
    );
    return Boolean(rows[0]?.exists);
  } catch (e) {
    logger.warn('EMMA MO 테이블 존재 확인 실패', { suffix, message: (e as Error).message });
    return false;
  }
}

/** em_smt_tran(발송 큐) 존재 여부. MT 어댑터가 실연동 가능 여부를 판단할 때 쓴다. */
export async function mtQueueExists(): Promise<boolean> {
  const q = getEmmaQuerier();
  try {
    const rows = await q.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_name = 'em_smt_tran'
       ) AS exists`,
    );
    return Boolean(rows[0]?.exists);
  } catch {
    return false;
  }
}

/**
 * 테이블 이름을 SQL 에 넣기 전 검증한다.
 *
 * 접미사는 우리가 만든 값이지만, 테이블명은 파라미터 바인딩이 안 되고 문자열로 붙일 수밖에 없다.
 * 숫자 6자리가 아니면 아예 거부해 주입 여지를 남기지 않는다.
 */
export function assertSafeSuffix(suffix: string): void {
  if (!/^\d{6}$/.test(suffix)) {
    throw new Error(`EMMA 테이블 접미사가 올바르지 않습니다: ${suffix}`);
  }
}
