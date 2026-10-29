import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { ConsoleShell, type NavGroup } from '@/components/layout/console-shell';
import { requireAdmin, type SessionUser } from '@/server/auth';
import { AdminPermissionBanner } from '@/components/admin/permission-banner';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '통합 관리자',
  robots: { index: false, follow: false },
};

const groups: NavGroup[] = [
  {
    title: '운영현황',
    items: [
      { href: '/admin', label: '대시보드', icon: 'dashboard' },
      { href: '/admin/system', label: '시스템 상태', icon: 'system' },
    ],
  },
  {
    title: '회원·사회복지기관',
    items: [
      { href: '/admin/users', label: '회원관리', icon: 'users' },
      { href: '/admin/payers', label: '후원자', icon: 'payers' },
      { href: '/admin/merchants', label: '사회복지기관 심사', icon: 'merchants' },
      { href: '/admin/codes', label: '사회복지기관 코드', icon: 'codes' },
      { href: '/admin/mo-numbers', label: 'MO 번호', icon: 'numbers' },
    ],
  },
  {
    title: '후원·결제',
    items: [
      { href: '/admin/mo-messages', label: '수신 문자', icon: 'messages' },
      { href: '/admin/mt-messages', label: 'MT 발송', icon: 'send' },
      { href: '/admin/mt-templates', label: 'MT 메시지 관리', icon: 'templates' },
      { href: '/admin/merchant-mt-templates', label: '사회복지기관 발송 템플릿', icon: 'moderation' },
      { href: '/admin/payments', label: '결제', icon: 'payments' },
      { href: '/admin/products', label: '후원 항목·처리', icon: 'products' },
      { href: '/admin/refunds', label: '환불', icon: 'refunds' },
      { href: '/admin/risk', label: '한도·이상거래', icon: 'risk' },
    ],
  },
  {
    title: '정산·수수료',
    items: [
      { href: '/admin/settlements', label: '정산', icon: 'settlement' },
      { href: '/admin/fees', label: '수수료 정책', icon: 'fees' },
      { href: '/admin/policies', label: '한도 정책', icon: 'policies' },
      { href: '/admin/holidays', label: '공휴일 관리', icon: 'holidays' },
    ],
  },
  {
    title: '콘텐츠·운영',
    items: [
      { href: '/admin/fundraising', label: '기관 후원페이지·캠페인', icon: 'contents' },
      { href: '/admin/banners', label: '배너', icon: 'banners' },
      { href: '/admin/contents', label: '공지·FAQ', icon: 'contents' },
      { href: '/admin/moderation', label: '신고·금칙어', icon: 'moderation' },
      { href: '/admin/inquiries', label: '문의 관리', icon: 'inquiries' },
      { href: '/admin/terms', label: '약관 버전', icon: 'terms' },
    ],
  },
  {
    title: '시스템·보안',
    items: [
      { href: '/admin/admins', label: '관리자 권한', icon: 'admins' },
      { href: '/admin/audit', label: '감사로그', icon: 'audit' },
      { href: '/admin/simulator', label: 'MO 시뮬레이터', icon: 'simulator' },
    ],
  },
];

const permissionLabel: Record<string, string> = {
  SUPER_ADMIN: '최고 관리자',
  OPERATION: '운영',
  FINANCE: '재무',
  SUPPORT: '고객지원',
  READ_ONLY: '읽기 전용',
};

/**
 * 로그인 후 되돌아갈 관리자 경로를 구한다.
 *
 * 레이아웃은 pathname 을 prop 으로 받지 못한다(Next 16: "Layouts do not re-render on
 * navigation, so they do not access pathname"). 화면 안에서 이동하다 세션이 끊긴 경우는
 * RSC 요청의 `next-url` 헤더로 알 수 있으므로 그 값을 쓰고, 헤더가 없는 최초 문서 요청은
 * `/admin` 으로 떨어뜨린다. 열린 리다이렉트가 되지 않도록 `/admin` 하위 경로만 통과시킨다.
 */
async function resolveAdminNextPath(): Promise<string> {
  const h = await headers();
  const raw = h.get('next-url');
  if (!raw) return '/admin';
  // `//evil.com` 같은 스킴 상대 URL 과 역슬래시 우회를 함께 막는다.
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/admin';
  if (raw !== '/admin' && !raw.startsWith('/admin/')) return '/admin';
  return raw;
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  let admin: SessionUser | null = null;
  try {
    admin = await requireAdmin();
  } catch {
    admin = null;
  }
  if (!admin) redirect(`/login?next=${encodeURIComponent(await resolveAdminNextPath())}`);

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.href !== '/admin/inquiries' || admin?.adminPermission === 'SUPER_ADMIN'),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <ConsoleShell
      title="기브싸인 통합 관리자"
      groups={visibleGroups}
      user={{
        id: admin.id,
        name: admin.name ?? admin.email ?? '관리자',
        role: permissionLabel[admin.adminPermission ?? ''] ?? '권한 미지정',
        avatarIndex: admin.avatarIndex,
      }}
    >
      <AdminPermissionBanner />
      {children}
    </ConsoleShell>
  );
}
