import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { loadIssuedForPayer, readIssuedPdf } from '@/server/services/issued-documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => new Response('Not Found', { status: 404, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });

/** 받은 문서 PDF(본인 문서만) */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getSessionUser();
  if (!user) return notFound();
  const payer = await prisma.payerProfile.findUnique({ where: { userId: user.id }, select: { id: true } });
  if (!payer) return notFound();
  const loaded = await loadIssuedForPayer(payer.id, id);
  if (!loaded.ok) return notFound();
  const buf = await readIssuedPdf(loaded.row);
  if (!buf) return notFound();
  return new Response(new Uint8Array(buf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${loaded.snapshot.title}.pdf`)}`,
    },
  });
}
