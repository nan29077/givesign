import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { getPrivateObject } from '@/server/uploads';
import { isLiveBazaarEnabled } from '@/server/services/bazaar-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 현물 기부 파일(물품 사진·가액 근거·검수 사진) 내려받기.
 * 비공개 저장소에 있고, 권한이 있는 사람만 받는다: 기부자 본인 / 매칭됐거나 매칭 제안을 받은 기관 / 관리자.
 * 스위치가 꺼지면 관리자만 받을 수 있다.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser().catch(() => null);
  const notFound = () => new Response('Not Found', { status: 404 });
  if (!user) return notFound();
  const enabled = await isLiveBazaarEnabled();
  if (!enabled && user.role !== 'ADMIN') return notFound();
  const file = await prisma.inKindFile.findUnique({ where: { id }, include: { donation: { include: { donor: { select: { userId: true } } } } } });
  if (!file) return notFound();
  let allowed = user.role === 'ADMIN';
  if (!allowed && user.role === 'GIVER') allowed = file.donation.donor.userId === user.id;
  if (!allowed && user.merchantId) {
    allowed =
      file.donation.merchantId === user.merchantId ||
      // 응답 기한이 지난 제안으로는 열지 않는다(점검 낮음).
      (await prisma.inKindMatch.count({ where: { donationId: file.donationId, merchantId: user.merchantId, status: 'PROPOSED', deadline: { gte: new Date() } } })) > 0;
  }
  if (!allowed) return notFound();
  const body = await getPrivateObject(file.objectName);
  if (!body) return notFound();
  return new Response(new Uint8Array(body), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
