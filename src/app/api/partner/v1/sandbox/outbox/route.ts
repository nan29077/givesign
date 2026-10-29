import { authenticatePartner } from '@/server/services/partner-auth';
import { sandboxOutbox } from '@/server/services/sandbox';
import { authError, jsonError, jsonOk, logPartnerCall, sandboxOnly } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * GET /api/partner/v1/sandbox/outbox
 *
 * 테스트 문자함. 테스트 중 "나갔을" 문자와 "받은 것으로 친" 문자를 최신순으로 돌려준다.
 * 실제로는 아무것도 발송되지 않았다.
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

  const denied = sandboxOnly(auth.mode);
  if (denied) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 403, errorCode: 'TEST_KEY_REQUIRED' });
    return denied;
  }

  const limitRaw = Number(new URL(req.url).searchParams.get('limit') ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > MAX_LIMIT) {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_LIMIT',
    }).then(() => jsonError(400, 'INVALID_LIMIT', `limit 은 1~${MAX_LIMIT} 사이 정수여야 합니다.`));
  }

  const items = await sandboxOutbox(auth.merchantId, limitRaw);
  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `items=${items.length}` });
  return jsonOk({ items });
}
