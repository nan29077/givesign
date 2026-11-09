import { prisma } from '@/server/db';
import { computeFees, feeRatesOf, type FeeBreakdown } from './settlement';

/**
 * 카드 결제 수수료(2026-11-13 5차 L2). 계좌 결제(fee_policy)와 따로 둔 정책 표(card_fee_policy)를 쓴다.
 * 계산식은 계좌 결제와 같은 computeFees(부가세 포함 요율, 공급가액·부가세 분리)이고,
 * 적용 여부는 effectiveFrom / effectiveTo 로만 판단한다(절대 규칙 8).
 *
 * 카드 정책이 하나도 없으면 결제를 진행하지 않는다 — 계좌 요율을 카드에 몰래 쓰면 정산이 틀린다.
 */

export class CardFeePolicyMissingError extends Error {
  constructor() {
    super('카드 결제 수수료 정책이 등록되지 않았습니다. 관리자가 카드 요율을 먼저 등록해야 합니다.');
  }
}

export async function resolveCardFeePolicy(merchantId: string, now: Date = new Date()) {
  const rows = await prisma.cardFeePolicy.findMany({
    where: {
      effectiveFrom: { lte: now },
      OR: [{ scope: 'GLOBAL' }, { scope: 'MERCHANT', merchantId }],
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
  return rows.find((r) => r.scope === 'MERCHANT') ?? rows.find((r) => r.scope === 'GLOBAL') ?? null;
}

export async function calculateCardFees(merchantId: string, amount: bigint, now: Date = new Date()): Promise<FeeBreakdown> {
  const policy = await resolveCardFeePolicy(merchantId, now);
  if (!policy) throw new CardFeePolicyMissingError();
  return computeFees(
    amount,
    feeRatesOf({
      pgFeeRate: policy.pgFeeRate.toString(),
      pgFixedFee: policy.pgFixedFee,
      platformFeeRate: policy.platformFeeRate.toString(),
      vatIncluded: policy.vatIncluded,
    }),
  );
}

/** 카드 결제를 받을 준비가 됐는지(정책 있음). 화면에서 선택지를 보여 줄지 판단할 때 쓴다. */
export async function cardFeeReady(merchantId: string): Promise<boolean> {
  return Boolean(await resolveCardFeePolicy(merchantId).catch(() => null));
}
