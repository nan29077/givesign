import { authenticatePartner } from '@/server/services/partner-auth';
import { syncPartnerProducts } from '@/server/services/partner-products';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ITEMS = 200;

/**
 * POST /api/partner/v1/products/bulk
 *
 * 사회복지기관 사이트의 상품 목록을 통째로 보내 맞춘다. sku 를 열쇠로 삼는다.
 * `archiveMissing: true` 를 주면 목록에 없는 상품을 판매 중지한다 —
 * 사회복지기관 사이트에서 내린 상품이 기브싸인에서는 계속 팔리는 것을 막기 위한 것이다.
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

  let body: { items?: unknown[]; archiveMissing?: boolean };
  try {
    body = JSON.parse(rawBody || '{}');
  } catch {
    return jsonError(400, 'INVALID_JSON', '본문이 올바른 JSON 이 아닙니다.');
  }

  if (!Array.isArray(body.items) || body.items.length === 0) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_ITEMS' });
    return jsonError(400, 'INVALID_ITEMS', 'items 배열이 필요합니다.');
  }
  if (body.items.length > MAX_ITEMS) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'TOO_MANY_ITEMS' });
    return jsonError(400, 'TOO_MANY_ITEMS', `한 번에 최대 ${MAX_ITEMS}건까지 보낼 수 있습니다.`);
  }

  const result = await syncPartnerProducts(
    auth.merchantId,
    body.items as never[],
    Boolean(body.archiveMissing),
  );
  if (!result.ok) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 400, errorCode: 'INVALID_PRODUCT' });
    return jsonError(400, 'INVALID_PRODUCT', result.message);
  }

  await logPartnerCall({
    req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200,
    message: `sync created=${result.created} updated=${result.updated} archived=${result.archived}`,
  });
  return jsonOk({ created: result.created, updated: result.updated, archived: result.archived });
}
