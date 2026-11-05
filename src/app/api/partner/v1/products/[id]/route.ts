import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { serializeProduct, updatePartnerProduct } from '@/server/services/partner-products';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/partner/v1/products/{id} — 상품 수정
 * DELETE /api/partner/v1/products/{id} — 판매 중지(보관 처리)
 *
 * 삭제는 하지 않는다. 지난 결제가 이 상품을 참조하므로 지우면 주문 내역이 깨진다.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.');
  }

  // 콘솔과 같은 규칙(종류 변경 금지·보관 상품 수정 금지·금액 범위·FEATURE_GOODS)을 서비스에서 판단한다.
  const result = await updatePartnerProduct(auth.merchantId, id, body);
  if (!result.ok) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: result.status, errorCode: result.code });
    return jsonError(result.status, result.code, result.message);
  }
  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ product: serializeProduct(result.product) });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const { id } = await ctx.params;
  const result = await prisma.chargeProduct.updateMany({
    where: { id, merchantId: auth.merchantId, archivedAt: null },
    data: { archivedAt: new Date(), active: false },
  });
  if (result.count === 0) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '판매 중인 해당 상품을 찾을 수 없습니다.');
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ archived: true });
}
