import { authenticatePartner } from '@/server/services/partner-auth';
import { sandboxReset } from '@/server/services/sandbox';
import { authError, jsonOk, logPartnerCall, sandboxOnly } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/partner/v1/sandbox/reset
 *
 * 이 사회복지기관의 테스트 데이터를 모두 지운다.
 * **운영 데이터는 건드리지 않는다.** 지우는 대상은 sandbox_charge / sandbox_message 뿐이다.
 */
export async function POST(req: Request) {
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

  const removed = await sandboxReset(auth.merchantId);
  await logPartnerCall({
    req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200,
    message: `reset charges=${removed.charges} messages=${removed.messages}`,
  });
  return jsonOk({ removed });
}
