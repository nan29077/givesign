import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { PAID_STATUSES } from '@/components/studio/shared';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_DAYS = 92;

/** KST 기준 YYYY-MM-DD. 집계 기준일이 시간대 때문에 하루씩 밀리지 않게 고정한다. */
function kstDateKey(d: Date): string {
  return new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * GET /api/partner/v1/stats/daily
 * 일별 결제 집계. 사회복지기관 자체 대시보드에 기브싸인 지표를 함께 띄우는 용도다.
 * 집계된 값만 내려가므로 개인정보가 포함되지 않는다.
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
    where: { merchantId: auth.merchantId, createdAt: { gte: since } },
    select: { amount: true, status: true, paidAt: true, createdAt: true, refundedAt: true },
  });

  type Bucket = {
    paidCount: number;
    paidAmount: number;
    failedCount: number;
    refundedCount: number;
    refundedAmount: number;
  };
  const empty = (): Bucket => ({
    paidCount: 0, paidAmount: 0, failedCount: 0, refundedCount: 0, refundedAmount: 0,
  });

  const buckets = new Map<string, Bucket>();
  for (const r of rows) {
    const key = kstDateKey(r.paidAt ?? r.createdAt);
    const bucket = buckets.get(key) ?? empty();
    if (PAID_STATUSES.includes(r.status)) {
      bucket.paidCount += 1;
      bucket.paidAmount += Number(r.amount);
    } else if (r.status === 'PAYMENT_FAILED') {
      bucket.failedCount += 1;
    }
    // 환불은 상태와 무관하게 refundedAt 으로 센다.
    // 예전에는 PAID_STATUSES 안에서만 셌는데, 환불이 끝난 건의 상태는 REFUNDED 라
    // 그 집합에 들어가지 않는다. 그래서 이 값이 **항상 0** 이었다.
    if (r.refundedAt) {
      bucket.refundedCount += 1;
      bucket.refundedAmount += Number(r.amount);
    }
    buckets.set(key, bucket);
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    days,
    items: [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, v]) => ({ date, ...v })),
  });
}
