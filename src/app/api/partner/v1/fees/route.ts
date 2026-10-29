import { authenticatePartner } from '@/server/services/partner-auth';
import { resolveFeePolicy } from '@/server/services/settlement';
import { authError, denyTestKey, jsonOk, logPartnerCall } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/partner/v1/fees
 * 지금 적용되는 수수료율과 정산 주기. 사회복지기관이 판매가를 정할 때 필요한 값이다.
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

  const policy = await resolveFeePolicy(auth.merchantId);
  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({
    // 정책 행이 없으면 코드 기본값으로 계산된다. 그 사실을 감추지 않는다.
    configured: policy !== null,
    pgFeeRate: policy ? Number(policy.pgFeeRate) : null,
    pgFixedFee: policy ? Number(policy.pgFixedFee) : null,
    platformFeeRate: policy ? Number(policy.platformFeeRate) : null,
    vatIncluded: policy ? policy.vatIncluded : null,
    settlementDays: policy ? policy.settlementDays : null,
    scope: policy ? policy.scope : null,
    effectiveFrom: policy ? policy.effectiveFrom.toISOString() : null,
  });
}
