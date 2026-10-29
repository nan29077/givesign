import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DELETE /api/partner/v1/payers/link/{payerRef}
 *
 * 회원 연결만 끊는다. 결제 이력과 후원자 자체는 그대로 남는다
 * (지난 거래는 지워질 수 없는 기록이다).
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ payerRef: string }> }) {
  const rawBody = await req.text();
  const auth = await authenticatePartner(req, rawBody);
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
  const result = await prisma.payerMerchantLink.updateMany({
    where: { merchantId: auth.merchantId, payerRef, merchantMemberId: { not: null } },
    data: { merchantMemberId: null },
  });
  if (result.count === 0) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '연결된 회원이 없습니다.');
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ payerRef, unlinked: true });
}
