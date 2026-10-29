import { prisma } from '@/server/db';
import { authenticatePartner } from '@/server/services/partner-auth';
import { authError, denyTestKey, jsonError, jsonOk, logPartnerCall } from '../../../_shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/partner/v1/products/{id}/options
 *
 * 옵션과 옵션가. 후원자가 고른 옵션은 결제 건의 optionText 로 내려간다.
 * 구 형식(문자열 배열)으로 저장된 상품도 있어 둘 다 읽어 같은 모양으로 돌려준다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
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

  const { id } = await ctx.params;
  const row = await prisma.chargeProduct.findFirst({
    where: { id, merchantId: auth.merchantId },
    select: { id: true, name: true, options: true },
  });
  if (!row) {
    await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 404, errorCode: 'NOT_FOUND' });
    return jsonError(404, 'NOT_FOUND', '해당 상품을 찾을 수 없습니다.');
  }

  const raw = Array.isArray(row.options) ? row.options : [];
  const groups = raw.map((group) => {
    // 구 형식: ["S", "M", "L"] — 이름 없는 값 목록
    if (typeof group === 'string') return { name: '옵션', values: [{ label: group, addPrice: 0, soldOut: false }] };
    const g = group as { name?: unknown; values?: unknown };
    const values = Array.isArray(g.values) ? g.values : [];
    return {
      name: typeof g.name === 'string' ? g.name : '옵션',
      values: values.map((v) => {
        if (typeof v === 'string') return { label: v, addPrice: 0, soldOut: false };
        const val = v as { label?: unknown; addPrice?: unknown; soldOut?: unknown };
        return {
          label: String(val.label ?? ''),
          addPrice: Number(val.addPrice ?? 0),
          soldOut: Boolean(val.soldOut),
        };
      }),
    };
  });

  await logPartnerCall({ req, merchantId: auth.merchantId, keyId: auth.keyId, status: 200 });
  return jsonOk({ productId: row.id, name: row.name, options: groups });
}
