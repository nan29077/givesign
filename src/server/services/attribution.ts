import { prisma } from '@/server/db';

/**
 * 유입 경로의 콘텐츠 ID(`?cid=` → 쿠키)를 기록하기 전에 이 기관의 콘텐츠인지 확인한다.
 * 쿠키 값은 형식(ULID)만 검사된 외부 입력이다. 존재하지 않거나 다른 기관 콘텐츠면 기록하지 않는다(null).
 * 전환 지표는 원천(결제 건·약정·봉사 신청)의 content_item_id 로 집계하므로, 여기서 걸러야 수치가 부풀지 않는다.
 */
export async function ownedContentItemId(merchantId: string, contentItemId: string | null | undefined): Promise<string | null> {
  if (!contentItemId) return null;
  const hit = await prisma.contentItem.findFirst({ where: { id: contentItemId, merchantId }, select: { id: true } });
  return hit?.id ?? null;
}
