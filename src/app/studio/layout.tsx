import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ConsoleShell, type NavGroup } from '@/components/layout/console-shell';
import { getSessionUser, requireMerchant } from '@/server/auth';
import { getStudioPendingCounts } from '@/server/services/studio-pending';
import { featureGoodsEnabled } from '@/lib/env';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '사회복지기관 관리자',
  robots: { index: false, follow: false },
};

/**
 * 사회복지기관 메뉴.
 *
 * 후원 업무를 흐름대로 묶는다: 현황(후원·후원자·정기후원) → 모금(캠페인·후원페이지·항목)
 * → 정산·영수증 → 기관 정보. 실물 상품·배송·문서는 FEATURE_GOODS 일 때만 보인다.
 *
 * 처리 대기 건수는 매 요청마다 세어 뱃지로 붙인다.
 */
function buildGroups(pending: {
  orders: number;
  points: number;
  reports: number;
  documents: number;
}): NavGroup[] {
  const goods = featureGoodsEnabled();
  return [
    {
      title: '현황',
      items: [
        { href: '/studio', label: '대시보드', icon: 'dashboard' },
        { href: '/studio/charges', label: '후원 내역', icon: 'charges' },
        { href: '/studio/donors', label: '후원자 관리', icon: 'donors' },
        { href: '/studio/recurring', label: '정기후원', icon: 'recurring' },
        { href: '/studio/messages', label: '문자 관리', icon: 'messages' },
      ],
    },
    {
      title: '모금',
      items: [
        { href: '/studio/campaigns', label: '캠페인', icon: 'campaigns' },
        { href: '/studio/donation-page', label: '후원페이지', icon: 'settings' },
        { href: '/studio/products', label: '후원 항목', icon: 'products' },
        // 실물 상품·배송·문서 상품은 사회복지기관 기본 업무가 아니라 숨긴다 (FEATURE_GOODS=true 로 노출).
        ...(goods
          ? [
              { href: '/studio/orders', label: '주문·배송 처리', icon: 'orders' as const, badge: pending.orders + pending.points },
              { href: '/studio/documents', label: '문서 관리', icon: 'documents' as const, badge: pending.documents },
            ]
          : []),
        { href: '/studio/settings', label: '후원 설정', icon: 'settings' },
        { href: '/studio/moderation', label: '금칙어·차단', icon: 'moderation' },
        { href: '/studio/reports', label: '신고', icon: 'reports', badge: pending.reports },
      ],
    },
    {
      title: '전자문서',
      items: [
        { href: '/studio/e-documents', label: '전자문서 센터', icon: 'documents', badge: pending.documents },
        { href: '/studio/documents', label: '서식·제출 문서', icon: 'documents' },
        { href: '/studio/document-billing', label: '충전·정액 이용', icon: 'settlement' },
      ],
    },
    {
      title: '정산·영수증',
      items: [
        { href: '/studio/settlement', label: '정산 관리', icon: 'settlement' },
        { href: '/studio/receipts', label: '기부금영수증', icon: 'receipts' },
      ],
    },
    {
      title: '계정',
      items: [{ href: '/studio/profile', label: '기관 정보', icon: 'building' }],
    },
    // 메뉴 맨 아래에 둔다. 매일 쓰는 업무 메뉴가 아니라 연동할 때만 찾는 자료라서.
    {
      title: '개발자',
      items: [
        { href: '/studio/docs', label: 'API 문서', icon: 'apidocs' },
        { href: '/studio/settings?tab=api', label: 'API 키', icon: 'codes' },
      ],
    },
  ];
}

const STATUS_NOTICE: Record<string, { title: string; body: string }> = {
  PENDING: {
    title: '기관 등록 심사가 진행 중입니다',
    body: '신청해 주셔서 감사합니다. 담당자가 기관 정보를 확인하고 있으며, 승인이 완료되면 등록하신 연락처로 안내드립니다. 승인 후 기관 콘솔의 모든 기능을 사용하실 수 있습니다.',
  },
  REJECTED: {
    title: '기관 등록 심사가 반려되었습니다',
    body: '제출하신 기관 정보로는 승인이 어려웠습니다. 사유 확인과 재심사 요청은 고객센터 문의로 접수해 주세요.',
  },
  SUSPENDED: {
    title: '기관 이용이 정지되었습니다',
    body: '운영정책 위반 또는 관리자 조치로 기관 이용이 정지된 상태입니다. 정지 사유와 해제 절차는 고객센터로 문의해 주세요.',
  },
};

export default async function StudioLayout({ children }: { children: React.ReactNode }) {
  const session = await getSessionUser().catch(() => null);
  if (!session?.merchantId) redirect('/login?next=/studio');

  // 미승인·반려·정지 채널은 스튜디오 기능 대신 상태 안내만 노출한다.
  if (session.merchantStatus !== 'APPROVED') {
    const notice = STATUS_NOTICE[session.merchantStatus ?? 'PENDING'] ?? STATUS_NOTICE.PENDING;
    return (
      <div className="console-canvas mx-auto flex min-h-screen max-w-[560px] flex-col justify-center px-5 py-16">
        <div className="card p-7">
          <h1 className="text-[19px] font-bold text-ink-900">{notice.title}</h1>
          <p className="mt-3 text-[14px] leading-relaxed text-ink-500">{notice.body}</p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Link href="/" className="rounded-xl bg-ink-900 px-4 py-2.5 text-[13px] font-semibold text-white">
              메인으로
            </Link>
            <Link href="/support" className="rounded-xl border border-ink-200 px-4 py-2.5 text-[13px] font-semibold text-ink-700">
              고객센터 문의
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const user = await requireMerchant().catch(() => null);
  if (!user) redirect('/login?next=/studio');

  // 밀린 일을 메뉴에서 바로 보이게 한다.
  // 대시보드도 같은 집계를 쓰므로 요청 단위 캐시로 묶어 한 번만 실행한다.
  const pending = await getStudioPendingCounts(user.merchantId);

  return (
    <ConsoleShell
      title="사회복지기관 관리자"
      groups={buildGroups({
        orders: pending.orders,
        points: pending.points,
        reports: pending.reports,
        documents: pending.documents,
      })}
      user={{
        id: user.id,
        name: user.name ?? '사회복지기관',
        role: '사회복지기관',
        avatarUrl: user.merchantAvatarUrl,
        avatarSeed: user.merchantCode ?? user.id,
        avatarIndex: user.avatarIndex,
      }}
    >
      {children}
    </ConsoleShell>
  );
}
