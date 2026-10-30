import { renderQr, qrFileName, resolveQrTarget, type QrFormat } from '@/server/services/qr';

/** QR 응답 공용 — ?format=png|svg, ?size=256~2048, ?download=1 */
export async function respondQr(req: Request, code: string, campaignId: string | null) {
  const target = await resolveQrTarget(code, campaignId);
  if (!target) return new Response('찾을 수 없는 후원페이지입니다.', { status: 404 });
  const url = new URL(req.url);
  const format: QrFormat = url.searchParams.get('format') === 'svg' ? 'svg' : 'png';
  const size = Number(url.searchParams.get('size') ?? '1024') || 1024;
  const body = await renderQr(target.url, format, size);
  const name = encodeURIComponent(qrFileName(target, format));
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), {
    headers: {
      'content-type': format === 'svg' ? 'image/svg+xml; charset=utf-8' : 'image/png',
      'content-disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}
