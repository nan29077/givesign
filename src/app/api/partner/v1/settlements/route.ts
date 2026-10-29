import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 100;

/**
 * GET /api/partner/v1/settlements
 * 정산 회차 목록. 사회복지기관 회계 시스템에 그대로 넣기 위한 값이다.
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

  const limitRaw = Number(new URL(req.url).searchParams.get('limit') ?? 50);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return jsonError(400, 'INVALID_LIMIT', `limit 은 1~${MAX_LIMIT} 사이 정수여야 합니다.`);
  }

  const rows = await prisma.settlementRequest.findMany({
    where: { merchantId: auth.merchantId },
    orderBy: { requestedAt: 'desc' },
    take: limitRaw,
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `items=${rows.length}` });
  return jsonOk({
    items: rows.map((r) => ({
      id: r.id,
      status: r.status,
      amount: Number(r.amount),
      withholding: Number(r.withholding),
      incomeTax: Number(r.incomeTax),
      localTax: Number(r.localTax),
      payoutAmount: Number(r.payoutAmount),
      auto: r.auto,
      requestedAt: r.requestedAt.toISOString(),
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      rejectedAt: r.rejectedAt ? r.rejectedAt.toISOString() : null,
      // 반려 사유는 사회복지기관이 봐야 다음 요청을 고칠 수 있다.
      adminMemo: r.adminMemo,
    })),
  });
}
