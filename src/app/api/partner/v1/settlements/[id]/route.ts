import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/partner/v1/settlements/{id}
 * 회차 상세. 건별 원장 항목까지 내려준다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const { id } = await ctx.params;
  const row = await prisma.settlementRequest.findFirst({
    where: { id, merchantId: auth.merchantId },
    include: {
      entries: {
        orderBy: { occurredAt: 'asc' },
        select: {
          id: true, entryType: true, amount: true, memo: true, occurredAt: true,
          charge: { select: { transactionNo: true } },
        },
      },
    },
  });
  if (!row) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 정산 회차를 찾을 수 없습니다.');
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    id: row.id,
    status: row.status,
    amount: Number(row.amount),
    withholding: Number(row.withholding),
    payoutAmount: Number(row.payoutAmount),
    requestedAt: row.requestedAt.toISOString(),
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
    entries: row.entries.map((e) => ({
      id: e.id,
      type: e.entryType,
      amount: Number(e.amount),
      transactionNo: e.charge?.transactionNo ?? null,
      memo: e.memo,
      occurredAt: e.occurredAt.toISOString(),
    })),
  });
}
