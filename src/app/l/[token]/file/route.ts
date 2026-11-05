import { loadIssuedByToken, readIssuedPdf } from '@/server/services/issued-documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 열람 문서의 PDF(비공개 저장소). 열람 토큰이 유효할 때만 내보낸다. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const loaded = await loadIssuedByToken(token, { record: false });
  if (!loaded.ok) return new Response('Not Found', { status: 404, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
  const buf = await readIssuedPdf(loaded.row);
  if (!buf) return new Response('Not Found', { status: 404, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${loaded.snapshot.title}.pdf`)}`,
    },
  });
}
