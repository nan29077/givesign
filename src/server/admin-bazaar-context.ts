import { redirect } from 'next/navigation';
import { requireAdmin } from '@/server/auth';
import { bazaarPageGuard } from '@/server/services/bazaar-settings';

export async function adminBazaarContext() {
  await bazaarPageGuard();
  const admin = await requireAdmin().catch(() => null);
  if (!admin) redirect('/login?next=/admin/bazaar');
  return admin;
}

export const ADMIN_BAZAAR_TABS = [
  { href: '/admin/bazaar', label: '현황' },
  { href: '/admin/bazaar/donations', label: '현물 기부' },
  { href: '/admin/bazaar/givers', label: '기부자 대장' },
  { href: '/admin/bazaar/merchants', label: '참여 기관' },
  { href: '/admin/bazaar/products', label: '판매 상품' },
  { href: '/admin/bazaar/lives', label: '편성·셀러' },
  { href: '/admin/bazaar/sales', label: '판매 결과' },
  { href: '/admin/in-kind-settlements', label: '정산·대사' },
  { href: '/admin/bazaar/settings', label: '설정' },
];
