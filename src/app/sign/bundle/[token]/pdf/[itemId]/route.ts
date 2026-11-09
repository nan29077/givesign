import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { readSnapshot, readSnapshotPdfBytes } from '@/server/services/edoc';
import { bundleCookieName, checkBundleProof, loadBundleSession } from '@/server/services/document-bundles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 묶음 서명 화면의 문서 PDF(본인확인을 마친 서명자만) — 2026-11-12 4차 J2.
 * 묶음 토큰 + 묶음 증표 쿠키가 맞고, 그 묶음에 든 문서일 때만 내려준다. 공유 캐시 금지.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string; itemId: string }> }) {
  const { token, itemId } = await params;
  const s = await loadBundleSession(token);
  if (!s.ok) return new Response('Not found', { status: 404 });
  if (!checkBundleProof(s.sendId, s.tokenHash, (await cookies()).get(bundleCookieName(s.sendId))?.value)) {
    return new Response('본인확인이 필요합니다.', { status: 403 });
  }
  const item = s.items.find((i) => i.id === itemId);
  if (!item) return new Response('Not found', { status: 404 });
  const env_ = await prisma.eDocEnvelope.findFirst({ where: { id: item.envelopeId, merchantId: s.merchantId }, select: { snapshotEnc: true } });
  if (!env_) return new Response('Not found', { status: 404 });
  const bytes = await readSnapshotPdfBytes(readSnapshot(env_.snapshotEnc));
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline; filename="document.pdf"',
    },
  });
}
