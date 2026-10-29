import { cookies } from 'next/headers';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';
import { claimGuestInquiry } from '@/server/services/inquiry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 내 1:1 문의 스레드 조회 (위젯 폴링용).
 * 로그인 사용자는 세션으로, 비로그인 사용자는 httpOnly 게스트 쿠키로 식별한다.
 * 다른 사람의 문의는 어떤 경로로도 조회할 수 없다.
 */

const GUEST_COOKIE = 'givesign_inquiry';

export async function GET(req: Request) {
  // 이 GET 은 조회만 하지 않는다(게스트 스레드 승계 · 쿠키 삭제 · 관리자 답변 읽음 처리).
  // 교차 출처 요청만으로 미읽음 배지가 지워지고 게스트 문의 쿠키가 사라지는 것을 막는다.
  if (!isSameOrigin(req)) {
    return Response.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  }

  const user = await getSessionUser().catch(() => null);
  const jar = await cookies();
  const guestToken = jar.get(GUEST_COOKIE)?.value ?? null;

  // 게스트로 접수한 뒤 로그인한 경우, 기존 스레드를 계정으로 승계해 답변이 유실되지 않게 한다.
  if (user && guestToken) {
    await claimGuestInquiry(user.id, guestToken).catch(() => null);
    jar.delete(GUEST_COOKIE);
  }

  const inquiry = user
    ? await prisma.supportInquiry.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } })
    : guestToken
      ? await prisma.supportInquiry.findUnique({ where: { guestToken } })
      : null;

  if (!inquiry) {
    return Response.json({ exists: false, status: null, messages: [] });
  }

  // 최신 200건을 가져와 화면 표시용으로 다시 오래된 순으로 뒤집는다.
  // asc + take 200 으로 자르면 스레드가 길어질수록 "방금 보낸 메시지와 최신 답변"이 잘려 보이지 않는다.
  const recent = await prisma.supportMessage.findMany({
    where: { inquiryId: inquiry.id },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, sender: true, body: true, createdAt: true, readByUserAt: true },
  });
  const messages = recent.reverse();
  const unread = messages.filter((m) => m.sender === 'ADMIN' && !m.readByUserAt).length;

  // 관리자 답변 읽음 처리
  await prisma.supportMessage.updateMany({
    where: { inquiryId: inquiry.id, sender: 'ADMIN', readByUserAt: null },
    data: { readByUserAt: new Date() },
  });

  return Response.json({
    exists: true,
    status: inquiry.status,
    /** 이번 응답에서 처음 확인한 관리자 답변 수 (문의 버튼 배지용) */
    unread,
    truncated: recent.length === 200,
    messages: messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      body: m.body,
      at: m.createdAt.toISOString(),
    })),
  });
}
