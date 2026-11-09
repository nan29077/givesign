import { prisma } from '@/server/db';
import { contractIntegrations } from '@/lib/env';
import { formatWon } from '@/lib/money';
import type { SelectAmountContext } from './charge-select';

/**
 * MO 두 번째 후원부터 간편하게 — "지난번 방법으로 후원" (2026-11-13 5차 L2-4, `MO_QUICK_REPEAT_ENABLED` 꺼짐 기본).
 *
 * 화면 단계만 줄인다: 지난번 후원의 금액(후원 항목)을 미리 골라 버튼 하나로 금액 확정 → **PIN 입력은 그대로**.
 * 무PIN 결제(금융사 승인 전)는 만들지 않는다. 결제 건·멱등·한도 규칙은 confirmChargeAmount 가 그대로 본다.
 * 지난번 항목이 보관됐거나 지금 범위를 벗어나면 보여 주지 않는다(예전 화면 그대로).
 */
export interface QuickRepeat {
  productId: string | null;
  amount: string;
  label: string;
}

const PAID = ['PAYMENT_SUCCESS', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'SETTLEMENT_PENDING', 'SETTLED'] as const;

export async function quickRepeatFor(ctx: SelectAmountContext): Promise<QuickRepeat | null> {
  if (!contractIntegrations().moQuickRepeat) return null;
  const charge = await prisma.charge.findUnique({ where: { id: ctx.chargeId }, select: { payerId: true, merchantId: true } });
  if (!charge?.payerId) return null;
  const token = await prisma.paymentMethodToken.findFirst({ where: { payerId: charge.payerId, status: 'ACTIVE' }, select: { id: true } });
  if (!token) return null;
  const last = await prisma.charge.findFirst({
    where: {
      payerId: charge.payerId,
      merchantId: charge.merchantId,
      status: { in: [...PAID] },
      channel: { not: 'RECURRING' },
      paymentMethod: null,
      id: { not: ctx.chargeId },
    },
    orderBy: { paidAt: 'desc' },
    select: { amount: true, productId: true },
  });
  if (!last) return null;
  const product = last.productId ? ctx.products.find((p) => p.id === last.productId && p.payable && !p.soldOut && p.kind !== 'PHYSICAL') : undefined;
  if (product) return { productId: product.id, amount: product.amount.toString(), label: `지난번: ${product.name} ${formatWon(product.amount)}` };
  if (!ctx.allowCustomAmount) return null;
  if (last.amount < ctx.customMin || last.amount > ctx.customMax) return null;
  if (ctx.customStep !== null && last.amount % BigInt(ctx.customStep) !== 0n) return null;
  return { productId: null, amount: last.amount.toString(), label: `지난번: ${formatWon(last.amount)}` };
}
