import { prisma } from '@/server/db';

/**
 * 1:1 문의 공통 로직.
 *
 * 서버 액션 파일('use server')에 두면 인증 없이 호출 가능한 RPC 엔드후원금가 되므로,
 * 관리자 전용/내부 전용 헬퍼는 반드시 이 모듈에 둔다.
 */

/** 게스트 문의 스레드를 식별하는 httpOnly 쿠키 이름. */
export const INQUIRY_GUEST_COOKIE = 'givesign_inquiry';

/** 문의를 읽음 처리한다 (관리자 상세 화면 진입 시 사용). 호출부에서 관리자 인증을 보장해야 한다. */
export async function markInquiryRead(inquiryId: string): Promise<void> {
  await prisma.supportMessage.updateMany({
    where: { inquiryId, sender: 'USER', readByAdminAt: null },
    data: { readByAdminAt: new Date() },
  });
}

/**
 * 게스트로 접수한 문의 스레드를 로그인 계정으로 승계한다.
 *
 * 비로그인 상태에서 문의 → 로그인 시, 기존 스레드를 이어받지 못하면
 * 관리자가 남긴 답변을 사용자가 영영 볼 수 없게 되는 문제를 막는다.
 *
 * @returns 승계된 스레드 id (승계 대상이 없으면 null)
 */
export async function claimGuestInquiry(userId: string, guestToken: string | null): Promise<string | null> {
  if (!guestToken) return null;

  const guestThread = await prisma.supportInquiry.findUnique({
    where: { guestToken },
    select: { id: true, userId: true },
  });
  // 이미 다른 계정이 가져갔거나 존재하지 않으면 승계하지 않는다.
  if (!guestThread || guestThread.userId) return null;

  const mine = await prisma.supportInquiry.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });

  if (mine) {
    // 이미 회원 스레드가 있으면 게스트 메시지를 회원 스레드로 옮기고 빈 게스트 스레드는 삭제한다.
    // (메시지를 모두 옮긴 뒤 남는 껍데기 스레드는 정보가 없으면서 관리자 목록에 빈 줄로 쌓인다)
    await prisma.$transaction([
      prisma.supportMessage.updateMany({
        where: { inquiryId: guestThread.id },
        data: { inquiryId: mine.id },
      }),
      prisma.supportInquiry.delete({ where: { id: guestThread.id } }),
      prisma.supportInquiry.update({
        where: { id: mine.id },
        data: { status: 'OPEN', lastMessageAt: new Date() },
      }),
    ]);
    return mine.id;
  }

  await prisma.supportInquiry.update({
    where: { id: guestThread.id },
    data: { userId, guestToken: null, guestName: null },
  });
  return guestThread.id;
}
