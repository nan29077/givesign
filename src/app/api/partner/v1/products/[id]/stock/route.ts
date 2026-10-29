import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { serializeProduct } from '@/server/services/partner-products';
import { emitMerchantEvent } from '@/server/services/webhooks';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PATCH /api/partner/v1/products/{id}/stock
 *
 * 재고를 맞춘다. 사회복지기관 사이트에서 물건이 나갔을 때 기브싸인 쪽 재고도 함께 줄이는 용도다.
 * 재고 0 이면 문자 안내에서 그 상품이 빠지고 결제도 막힌다.
 *
 * 차감은 결제 승인 시점에 상품 단위 잠금 안에서 별도로 이뤄진다.
 * 여기서는 값을 덮어쓰기만 한다(동시 결제와 경쟁하지 않는다).
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
  let body: { stock?: number | null; stockAlert?: number | null };
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.');
  }

  if (body.stock === undefined) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_STOCK' });
    return jsonError(400, 'INVALID_STOCK', 'stock 이 필요합니다. 재고를 세지 않으려면 null 을 보내세요.');
  }
  if (body.stock !== null && (!Number.isInteger(body.stock) || body.stock < 0)) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_STOCK' });
    return jsonError(400, 'INVALID_STOCK', 'stock 은 0 이상의 정수이거나 null 이어야 합니다.');
  }

  const owned = await prisma.chargeProduct.findFirst({
    where: { id, merchantId: auth.merchantId },
    select: { id: true, name: true, stockAlert: true },
  });
  if (!owned) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 상품을 찾을 수 없습니다.');
  }

  const row = await prisma.chargeProduct.update({
    where: { id },
    data: {
      stock: body.stock,
      ...(body.stockAlert === undefined ? {} : { stockAlert: body.stockAlert }),
    },
  });

  // 기준 아래로 떨어지면 알린다. 사회복지기관이 품절을 뒤늦게 아는 것을 막기 위한 이벤트다.
  const alert = body.stockAlert ?? owned.stockAlert;
  if (row.stock !== null && alert !== null && row.stock <= alert) {
    await emitMerchantEvent(auth.merchantId, 'product.stock_low', {
      productId: row.id,
      name: row.name,
      stock: row.stock,
      stockAlert: alert,
    });
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ product: serializeProduct(row) });
}
