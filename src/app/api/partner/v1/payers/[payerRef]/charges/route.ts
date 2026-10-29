import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { backfillPayerRefs } from '@/server/services/merchant-mt';
import { PAID_STATUSES } from '@/components/studio/shared';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;

/**
 * GET /api/partner/v1/payers/{payerRef}/charges
 * 그 후원자의 결제 이력. 사회복지기관 회원 상세 화면에 붙이는 용도다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ payerRef: string }> }) {
  const auth = await authenticatePartner(req, '');
  if (!auth.ok) {
    await logPartnerCall({
      req, merchantId: auth.merchantId ?? null, keyId: auth.keyId,
      status: auth.status, errorCode: auth.code, message: auth.message,
    });
    return authError(auth);
  }

  // 테스트 키는 운영 데이터에 닿지 않는다. (_shared.liveOnly 주석 참고)
  const testDenied = await denyTestKey(req, auth);
  if (testDenied) return testDenied;

  const { payerRef } = await ctx.params;
  const limitRaw = Number(new URL(req.url).searchParams.get('limit') ?? 50);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return jsonError(400, 'INVALID_LIMIT', `limit 은 1~${MAX_LIMIT} 사이 정수여야 합니다.`);
  }

  let link = await prisma.payerMerchantLink.findFirst({
    where: { merchantId: auth.merchantId, payerRef },
    select: { payerId: true },
  });
  if (!link) {
    await backfillPayerRefs(auth.merchantId);
    link = await prisma.payerMerchantLink.findFirst({
      where: { merchantId: auth.merchantId, payerRef },
      select: { payerId: true },
    });
  }
  if (!link) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '이 사회복지기관에 거래 이력이 있는 후원자가 아닙니다.');
  }

  const rows = await prisma.charge.findMany({
    where: { merchantId: auth.merchantId, payerId: link.payerId, status: { in: PAID_STATUSES } },
    orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
    take: limitRaw,
    select: {
      transactionNo: true, amount: true, message: true, status: true,
      pointStatus: true, paidAt: true, refundedAt: true,
      product: { select: { name: true, kind: true } },
    },
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `items=${rows.length}` });
  return jsonOk({
    payerRef,
    items: rows.map((r) => ({
      transactionNo: r.transactionNo,
      amount: Number(r.amount),
      message: r.message,
      chargeStatus: r.status,
      pointStatus: r.pointStatus,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      refunded: r.refundedAt !== null,
      product: r.product ? { name: r.product.name, kind: r.product.kind } : null,
    })),
  });
}
