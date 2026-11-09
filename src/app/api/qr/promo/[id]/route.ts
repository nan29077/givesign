import { renderQr } from '@/server/services/qr';
import { promoLandingUrl, promoSmsTarget } from '@/server/services/promo-codes';
import { clientIpFromRequest, consumeRateLimit } from '@/server/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 홍보물 QR — GET /api/qr/promo/[홍보물ID]?format=png|svg&download=1 (2026-11-12 4차 K1).
 * QR 은 중간 페이지 /m/[홍보물ID] 를 가리킨다(찍으면 문자 앱이 열리고, 안 열리면 후원페이지 버튼).
 * 승인된 기관의 공개 캠페인 홍보물만(보관한 홍보물은 404). 범용 QR 생성기가 아니다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const limited = await consumeRateLimit('qr', clientIpFromRequest(req), 60, 60);
  if (!limited.ok) return new Response('요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', { status: 429, headers: { 'retry-after': '60' } });
  const { id } = await ctx.params;
  const target = await promoSmsTarget(id);
  if (!target) return new Response('찾을 수 없는 홍보물입니다.', { status: 404 });
  const url = new URL(req.url);
  const format = url.searchParams.get('format') === 'svg' ? 'svg' : 'png';
  const size = Number(url.searchParams.get('size') ?? '1024') || 1024;
  const body = await renderQr(promoLandingUrl(target.promoId), format, size);
  const safe = target.promoName.replace(/[^0-9A-Za-z가-힣_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const name = encodeURIComponent(`qr-${target.merchantCode}-${safe || 'promo'}.${format}`);
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    headers: {
      'content-type': format === 'svg' ? 'image/svg+xml; charset=utf-8' : 'image/png',
      'content-disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
