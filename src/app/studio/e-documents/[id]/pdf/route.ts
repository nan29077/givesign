import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { readSnapshot, readSnapshotPdfBytes } from '@/server/services/edoc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 기관 콘솔의 서명 요청 서식 PDF (그 기관 담당자만). 비공개 저장소의 서명용 PDF 를 내려준다(2026-11-06 점검 A-M2).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let merchantId: string;
  try {
    merchantId = (await requireMerchant()).merchantId;
  } catch {
    return new Response('권한이 없습니다.', { status: 403 });
  }
  const { id } = await params;
  const e = await prisma.eDocEnvelope.findFirst({ where: { id, merchantId }, select: { snapshotEnc: true } });
  if (!e) return new Response('Not found', { status: 404 });
  const bytes = await readSnapshotPdfBytes(readSnapshot(e.snapshotEnc));
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline; filename="document.pdf"',
    },
  });
}
