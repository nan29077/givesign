import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { createPartnerProduct, serializeProduct } from '@/server/services/partner-products';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET  /api/partner/v1/products — 상품 목록
 * POST /api/partner/v1/products — 상품 등록
 *
 * 사회복지기관 사이트에 이미 있는 상품을 기브싸인에 한 번 더 손으로 넣지 않아도 되게 한다.
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

  const url = new URL(req.url);
  const includeArchived = url.searchParams.get('includeArchived') === 'true';
  const rows = await prisma.chargeProduct.findMany({
    where: { merchantId: auth.merchantId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    take: 500,
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: `items=${rows.length}` });
  return jsonOk({ items: rows.map(serializeProduct) });
}

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

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return logPartnerCall({
      req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_JSON',
    }).then(() => jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.'));
  }

  const result = await createPartnerProduct(auth.merchantId, body);
  if (!result.ok) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_PRODUCT' });
    return jsonError(400, 'INVALID_PRODUCT', result.message);
  }

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200, message: 'product created' });
  return jsonOk({ product: serializeProduct(result.product) });
}
