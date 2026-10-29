import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { backfillPayerRefs } from '@/server/services/merchant-mt';
import { emitMerchantEvent } from '@/server/services/webhooks';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/partner/v1/payers/link
 *
 * 사회복지기관 사이트의 회원 ID 와 기브싸인 후원자를 잇는다.
 * 연결해 두면 사회복지기관은 자기 회원 ID 로 결제 이력을 찾을 수 있고,
 * 결제 건이 어느 회원의 것인지 매번 대조하지 않아도 된다.
 *
 * 휴대폰 번호를 주고받지 않는다. payerRef 로만 연결한다.
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

  // 테스트 키는 운영 데이터에 닿지 않는다. (_shared.liveOnly 주석 참고)
  const testDenied = await denyTestKey(req, auth);
  if (testDenied) return testDenied;

  let body: { payerRef?: string; merchantMemberId?: string };
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.');
  }

  const payerRef = String(body.payerRef ?? '').trim();
  const memberId = String(body.merchantMemberId ?? '').trim();
  if (!payerRef || !memberId) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_ITEMS' });
    return jsonError(400, 'INVALID_ITEMS', 'payerRef 와 merchantMemberId 가 필요합니다.');
  }
  if (memberId.length > 100) {
    return jsonError(400, 'INVALID_ITEMS', 'merchantMemberId 는 100자 이내여야 합니다.');
  }

  let link = await prisma.payerMerchantLink.findFirst({
    where: { merchantId: auth.merchantId, payerRef },
    select: { id: true },
  });
  if (!link) {
    await backfillPayerRefs(auth.merchantId);
    link = await prisma.payerMerchantLink.findFirst({
      where: { merchantId: auth.merchantId, payerRef },
      select: { id: true },
    });
  }
  if (!link) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '이 사회복지기관에 거래 이력이 있는 후원자가 아닙니다.');
  }

  await prisma.payerMerchantLink.update({ where: { id: link.id }, data: { merchantMemberId: memberId } });
  await emitMerchantEvent(auth.merchantId, 'payer.linked', { payerRef, merchantMemberId: memberId });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ payerRef, merchantMemberId: memberId, linked: true });
}
