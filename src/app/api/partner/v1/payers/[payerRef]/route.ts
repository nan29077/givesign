import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { backfillPayerRefs } from '@/server/services/merchant-mt';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/partner/v1/payers/{payerRef}
 *
 * 후원자 요약. 휴대폰 번호 원문은 내려가지 않는다.
 * payerRef 는 사회복지기관마다 다른 값이라, 사회복지기관끼리 값을 맞춰 봐도 같은 사람인지 알 수 없다.
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
  // 옛 행은 payerRef 캐시가 비어 있다. 못 찾으면 한 번 채우고 다시 본다.
  let link = await prisma.payerMerchantLink.findFirst({
    where: { merchantId: auth.merchantId, payerRef },
    select: {
      totalAmount: true, totalCount: true, lastDonatedAt: true, consentedAt: true,
      payerBlockedAt: true, merchantMemberId: true,
      payer: { select: { phoneMasked: true, displayName: true } },
    },
  });
  if (!link) {
    await backfillPayerRefs(auth.merchantId);
    link = await prisma.payerMerchantLink.findFirst({
      where: { merchantId: auth.merchantId, payerRef },
      select: {
        totalAmount: true, totalCount: true, lastDonatedAt: true, consentedAt: true,
        payerBlockedAt: true, merchantMemberId: true,
        payer: { select: { phoneMasked: true, displayName: true } },
      },
    });
  }
  if (!link) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '이 사회복지기관에 거래 이력이 있는 후원자가 아닙니다.');
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    payerRef,
    phoneMasked: link.payer.phoneMasked,
    displayName: link.payer.displayName,
    merchantMemberId: link.merchantMemberId,
    totalAmount: Number(link.totalAmount),
    totalCount: link.totalCount,
    lastPaidAt: link.lastDonatedAt ? link.lastDonatedAt.toISOString() : null,
    consentedAt: link.consentedAt ? link.consentedAt.toISOString() : null,
    blockedByPayer: link.payerBlockedAt !== null,
  });
}
