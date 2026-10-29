import { authenticatePartner } from '@/server/services/partner-auth';
import { merchantMtQuota } from '@/server/services/merchant-mt';
import { authError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/partner/v1/mt/quota
 * 오늘 남은 발송 한도. 대량 안내를 돌리기 전에 확인한다.
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

  // 테스트 키 발송은 한도를 쓰지 않는다(실제로 나가지 않기 때문이다).
  if (auth.mode === 'TEST') {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
    return jsonOk({ limit: null, used: 0, remaining: null, sandbox: true });
  }

  const quota = await merchantMtQuota(auth.merchantId);
  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ ...quota, sandbox: false });
}
