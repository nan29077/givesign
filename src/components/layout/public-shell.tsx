import { cookies } from 'next/headers';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { INQUIRY_GUEST_COOKIE } from '@/server/services/inquiry';
import { PublicShellClient, type ShellViewer } from './public-shell-client';
import { SupportWidget } from '@/components/public/support-widget';
import { isLegacyDonationContent } from '@/lib/public-content';

/**
 * 공개 영역 레이아웃 (서버 래퍼).
 * 세션 사용자를 조회해 클라이언트 셸에 전달한다.
 * - 마이페이지 탭은 역할에 따라 통합 관리자(/admin), 사회복지기관 스튜디오(/studio),
 *   후원자 마이페이지(/my)로 이동한다. 비로그인 시 /my 접근은 로그인으로 유도된다.
 */
export async function PublicShell({
  children,
  aside,
}: {
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  const user = await getSessionUser().catch(() => null);

  // 사회복지기관은 프로필 캐릭터(아바타)를 우측 메뉴 프로필에도 그대로 보여준다.
  const merchantAvatar =
    user?.role === 'MERCHANT' && user.merchantId
      ? (
          await prisma.merchantProfile.findUnique({
            where: { id: user.merchantId },
            select: { avatarUrl: true, code: true },
          })
        )
      : null;

  const viewer: ShellViewer | null = user
    ? {
        id: user.id,
        name: user.name,
        email: user.email,
        myHref: user.role === 'ADMIN' ? '/admin' : user.role === 'MERCHANT' ? '/studio' : '/my',
        roleLabel: user.role === 'ADMIN' ? '관리자' : user.role === 'MERCHANT' ? '사회복지기관' : '후원자',
        avatarUrl: merchantAvatar?.avatarUrl ?? null,
        avatarSeed: merchantAvatar?.code ?? user.id,
        avatarIndex: user.avatarIndex,
      }
    : null;

  // 문의 위젯의 FAQ 탭에 보여줄 상위 FAQ (고정글 우선)
  const faqCandidates = await prisma.contentPost.findMany({
    where: { type: 'FAQ', published: true },
    orderBy: [{ pinned: 'desc' }, { sortOrder: 'asc' }],
    take: 30,
    select: { id: true, title: true, body: true },
  });
  const faqs = faqCandidates.filter((faq) => !isLegacyDonationContent(faq)).slice(0, 6);

  // 문의 이력이 있을 때만 배경 폴링을 돌린다.
  // (모든 방문자가 15초/5분마다 /api/inquiry 를 두드리면 공개 페이지 전체가 불필요한 DB 부하를 진다)
  const jar = await cookies();
  const hasThread = Boolean(user) || Boolean(jar.get(INQUIRY_GUEST_COOKIE)?.value);

  return (
    <>
      <PublicShellClient aside={aside} viewer={viewer}>
        {children}
      </PublicShellClient>
      <SupportWidget faqs={faqs} loggedIn={Boolean(user)} hasThread={hasThread} />
    </>
  );
}
