import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { currentTermsDoc, currentTermsList } from '@/server/services/terms';

/**
 * 기준 데이터 점검 — 운영에서 빠지면 조용히 기본값으로 돌아가는 것들.
 *
 *  - 현행 약관: 비어 있으면 후원 확정 화면의 필수 동의 목록이 빈다.
 *  - 전역 수수료 정책: 없으면 resolveFeePolicy 가 null → 코드 기본 요율이 조용히 적용된다.
 *  - 전역 한도 정책: 없으면 resolvePolicy 가 FALLBACK_POLICY 를 쓴다.
 *
 * 부팅을 막지 않는 이유: 이 점검은 DB 조회가 필요하다. instrumentation 에서 DB 장애·마이그레이션 직전
 * 상태로 기동을 거부하면 관리자가 화면에서 정책을 채울 길까지 막힌다. 그래서 부팅 때는 로그 오류로,
 * 운영 중에는 관리자 대시보드 경고로 알린다. 시드(prisma/seed.ts)는 운영에서도 이 기준 데이터를
 * 없을 때만 넣는다.
 */
export async function checkBaseData(now: Date = new Date()): Promise<string[]> {
  const problems: string[] = [];
  const effective = {
    active: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };

  const [terms, requiredTypes, fee, limit] = await Promise.all([
    currentTermsList(now),
    prisma.termsVersion.findMany({ where: { required: true, active: true }, distinct: ['type'], select: { type: true } }),
    prisma.feePolicy.findFirst({ where: { scope: 'GLOBAL', ...effective }, select: { id: true } }),
    prisma.chargeLimitPolicy.findFirst({ where: { scope: 'GLOBAL', ...effective }, select: { id: true } }),
  ]);

  if (terms.length === 0) {
    problems.push('현행(시행일이 지난) 약관이 없습니다. 후원 확정 화면에 필수 동의 목록이 비어 보입니다.');
  } else {
    for (const { type } of requiredTypes) {
      if (!(await currentTermsDoc(type, now))) problems.push(`필수 약관 ${type} 의 현행본이 없습니다.`);
    }
  }
  if (!fee) problems.push('지금 적용 중인 전역 수수료 정책이 없습니다. 정산에 코드 기본 요율이 적용됩니다.');
  if (!limit) problems.push('지금 적용 중인 전역 한도 정책이 없습니다. 결제 한도에 코드 기본값이 적용됩니다.');
  return problems;
}

/** 부팅 때 1회. 실패해도 기동은 계속하고 오류 로그만 남긴다. */
export async function logBaseDataProblems(): Promise<void> {
  try {
    const problems = await checkBaseData();
    for (const p of problems) logger.error(`[base-data] ${p}`);
  } catch (e) {
    logger.error('[base-data] 기준 데이터 점검을 실행하지 못했습니다.', { error: (e as Error).message });
  }
}
