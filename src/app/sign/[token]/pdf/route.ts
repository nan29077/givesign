import { cookies } from 'next/headers';
import { accessCookieName, checkAccessProof, loadSigner, readSnapshotPdfBytes } from '@/server/services/edoc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 서명 화면의 서식 PDF (본인확인을 마친 서명자만).
 *
 * 머지 필드(이름 등)를 채운 서명용 PDF 는 공개 저장소에 두지 않는다(2026-11-06 점검 A-M2).
 * 서명 링크 토큰 + 본인확인 쿠키(/sign 경로, 서명자·현재 토큰에 묶임)가 맞을 때만 내려준다. 공유 캐시 금지.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadSigner(token);
  if (!loaded.ok) return new Response('Not found', { status: 404 });
  const s = loaded.signer;
  const proof = (await cookies()).get(accessCookieName(s.id))?.value;
  if (!checkAccessProof(s.id, s.tokenHash, proof)) return new Response('본인확인이 필요합니다.', { status: 403 });
  const bytes = await readSnapshotPdfBytes(loaded.snapshot);
  if (!bytes) return new Response('Not found', { status: 404 });
  return pdfResponse(bytes);
}

function pdfResponse(bytes: Buffer) {
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
