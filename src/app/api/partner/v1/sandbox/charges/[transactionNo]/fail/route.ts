import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { sandboxFail, serializeSandboxCharge } from '@/server/services/sandbox';
import { authError, jsonError, jsonOk, logPartnerCall, sandboxOnly } from '../../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/partner/v1/sandbox/charges/{transactionNo}/fail
 *
 * 테스트 건을 실패로 확정한다. 실패 분기(재시도·안내 문구)를 시험하기 위한 것이다.
 * body 로 `{ "reason": "한도 초과" }` 를 주면 사유가 그대로 남는다.
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

  let reason: string | null = null;
  try {
    const body = JSON.parse(rawBody || '{}') as { reason?: string };
    reason = body.reason ? String(body.reason) : null;
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const { transactionNo } = await ctx.params;
  const merchant = await prisma.merchantProfile.findUnique({
    where: { id: auth.merchantId },
    select: { displayName: true },
  });

  const row = await sandboxFail({
    merchantId: auth.merchantId,
    merchantName: merchant?.displayName ?? '사회복지기관',
    transactionNo,
    reason,
  });
  if (!row) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 테스트 거래를 찾을 수 없습니다.');
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `sandbox fail ${transactionNo}` });
  return jsonOk({ charge: serializeSandboxCharge(row) });
}
