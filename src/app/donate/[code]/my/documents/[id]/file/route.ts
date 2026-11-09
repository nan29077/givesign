import { findDonationOrg, getDonorMember } from '@/server/services/donor-members';
import { memberScope } from '@/server/services/donor-self-service';
import { loadIssuedForPayer, readIssuedPdf } from '@/server/services/issued-documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const notFound = () => new Response('Not Found', { status: 404, headers: { 'X-Robots-Tag': 'noindex, nofollow' } });

/** 기관 후원 회원 — 받은 문서 PDF(이 기관 문서·본인 문서만) */
export async function GET(_req: Request, ctx: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await ctx.params;
  const org = await findDonationOrg(code);
  const member = org ? await getDonorMember(org) : null;
  if (!org || !member) return notFound();
  const scope = await memberScope(member);
  if (!scope || scope.via !== 'MEMBER') return notFound();
  const loaded = await loadIssuedForPayer(scope.payerId, id);
  if (!loaded.ok || loaded.row.merchantId !== scope.merchantId) return notFound();
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
