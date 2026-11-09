import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { getPrivateObject } from '@/server/uploads';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 콘텐츠 소재 파일(그 기관 담당자만, 2026-11-11 G). 소재는 비공개 저장소에만 있고 공개 주소가 없다.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  let merchantId: string;
  try {
    merchantId = (await requireMerchant()).merchantId;
  } catch {
    return new Response('권한이 없습니다.', { status: 403 });
  }
  const { id } = await params;
  const a = await prisma.contentAsset.findFirst({ where: { id, merchantId }, select: { objectName: true, mime: true } });
  if (!a) return new Response('Not found', { status: 404 });
  const bytes = await getPrivateObject(a.objectName);
  if (!bytes) return new Response('Not found', { status: 404 });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': a.mime,
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    },
  });
}
