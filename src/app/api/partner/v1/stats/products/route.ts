import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { PAID_STATUSES } from '@/components/studio/shared';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DAYS = 366;

/**
 * GET /api/partner/v1/stats/products
 * 상품별 판매 집계. 무엇이 팔리는지 사회복지기관 대시보드에서 함께 보기 위한 값이다.
 */
export async function GET(req: Request) {
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

  const days = Number(new URL(req.url).searchParams.get('days') ?? 30);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return jsonError(400, 'INVALID_DAYS', `days 는 1~${MAX_DAYS} 사이 정수여야 합니다.`);
  }

  const since = new Date(Date.now() - days * 86400 * 1000);
  const rows = await prisma.charge.findMany({
    where: {
      merchantId: auth.merchantId,
      status: { in: PAID_STATUSES },
      refundedAt: null,
      paidAt: { gte: since },
    },
    select: { amount: true, quantity: true, productId: true, product: { select: { name: true, kind: true, sku: true } } },
  });

  const map = new Map<string, { productId: string | null; name: string; kind: string | null; sku: string | null; count: number; quantity: number; amount: number }>();
  for (const r of rows) {
    // 상품 없이 금액만 입력한 결제는 하나로 묶는다.
    const key = r.productId ?? '(직접 입력)';
    const entry = map.get(key) ?? {
      productId: r.productId,
      name: r.product?.name ?? '직접 입력',
      kind: r.product?.kind ?? null,
      sku: r.product?.sku ?? null,
      count: 0,
      quantity: 0,
      amount: 0,
    };
    entry.count += 1;
    entry.quantity += r.quantity;
    entry.amount += Number(r.amount);
    map.set(key, entry);
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ days, items: [...map.values()].sort((a, b) => b.amount - a.amount) });
}
