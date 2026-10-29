import { requireMerchant, writeAudit } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { buildHometaxExport, ReceiptError } from '@/server/services/receipts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 홈택스 기부금영수증 발급명세 CSV 다운로드 (기관 담당자).
 *
 *   GET /api/studio/receipts/export?year=2026
 *
 * 이 파일에는 **주민등록번호 원문**이 들어간다. 복호화는 buildHometaxExport 안에서만 일어나고,
 * 생성 이력(receipt_export)과 감사로그(RECEIPT_HOMETAX_EXPORT)를 남긴다.
 * 동일 출처 검사가 없으면 로그인한 담당자가 악성 페이지를 여는 것만으로 명세가 생성된다.
 */
export async function GET(req: Request) {
  if (!isSameOrigin(req)) return new Response('허용되지 않은 요청입니다.', { status: 403 });

  let merchantId: string;
  let userId: string;
  try {
    const me = await requireMerchant();
    merchantId = me.merchantId;
    userId = me.id;
  } catch {
    return new Response('로그인이 필요합니다.', { status: 401 });
  }

  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year'));
  const nowYear = new Date().getFullYear();
  if (!Number.isInteger(year) || year < 2020 || year > nowYear) {
    return new Response('귀속 연도가 올바르지 않습니다.', { status: 400 });
  }

  try {
    const out = await buildHometaxExport(merchantId, year, userId);
    await writeAudit({
      action: 'RECEIPT_HOMETAX_EXPORT',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      after: { taxYear: year, rows: out.rows, checksum: out.checksum, by: userId },
    });
    return new Response(out.content, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${out.fileName}"`,
        'Cache-Control': 'no-store',
        'X-Checksum-SHA256': out.checksum,
      },
    });
  } catch (e) {
    if (e instanceof ReceiptError) return new Response(e.message, { status: 400 });
    throw e;
  }
}
