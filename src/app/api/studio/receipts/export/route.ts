import { requireMerchant, writeAudit } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { buildHometaxExport, ReceiptError } from '@/server/services/receipts';
import { consumeHometaxExportToken, ExportGateError } from '@/server/services/hometax-export-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 홈택스 기부금영수증 발급명세 CSV 다운로드 (기관 담당자).
 *
 *   GET /api/studio/receipts/export?year=2026&t={1회용 토큰}
 *
 * 토큰은 기관 콘솔에서 비밀번호 재확인과 사유 입력을 거쳐야 나온다(5분, 1회용, 하루 횟수 제한).
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

  let reason: string;
  try {
    ({ reason } = await consumeHometaxExportToken(url.searchParams.get('t') ?? '', { userId, merchantId, taxYear: year }));
  } catch (e) {
    if (e instanceof ExportGateError) return new Response(e.message, { status: 403 });
    throw e;
  }

  try {
    const out = await buildHometaxExport(merchantId, year, userId);
    // 감사로그를 남기지 못하면 파일도 내보내지 않는다(주민번호 원문 반출 기록이 없어지는 것을 막는다).
    await writeAudit({
      action: 'RECEIPT_HOMETAX_EXPORT',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      after: { taxYear: year, rows: out.rows, checksum: out.checksum, by: userId, reason },
    });
    await writeAudit({
      action: 'RECEIPT_RESIDENT_NO_VIEW',
      targetType: 'MerchantProfile',
      targetId: merchantId,
      after: { taxYear: year, rows: out.rows, via: 'HOMETAX_EXPORT', reason },
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
