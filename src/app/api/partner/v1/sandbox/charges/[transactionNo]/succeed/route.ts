import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { sandboxSucceed, serializeSandboxCharge } from '@/server/services/sandbox';
import { authError, jsonError, jsonOk, logPartnerCall, sandboxOnly } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/partner/v1/sandbox/charges/{transactionNo}/succeed
 *
 * 결제사 승인이 난 것처럼 테스트 건을 성공으로 확정한다.
 * 실제 결제사를 호출하지 않고 돈도 움직이지 않는다.
 *
 * 이미 확정된 건은 다시 바뀌지 않는다(실제 흐름과 같다). 여러 번 불러도 결과가 같다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ transactionNo: string }> }) {
  const rawBody = await req.text();
  const auth = await authenticatePartner(req, rawBody);
  if (!auth.ok) {
    await logPartnerCall({
      req, merchantId: auth.merchantId ?? null, keyId: auth.keyId,
      status: auth.status, errorCode: auth.code, message: auth.message,
    });
    return authError(auth);
  }

  const denied = sandboxOnly(auth.mode);
  if (denied) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 403, errorCode: 'TEST_KEY_REQUIRED' });
    return denied;
  }

  const { transactionNo } = await ctx.params;
  const merchant = await prisma.merchantProfile.findUnique({
    where: { id: auth.merchantId },
    select: { displayName: true },
  });

  const row = await sandboxSucceed({
    merchantId: auth.merchantId,
    merchantName: merchant?.displayName ?? '사회복지기관',
    transactionNo,
  });
  if (!row) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 테스트 거래를 찾을 수 없습니다.');
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `sandbox succeed ${transactionNo}` });
  return jsonOk({ charge: serializeSandboxCharge(row) });
}
