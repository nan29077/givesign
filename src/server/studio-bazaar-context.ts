import { redirect } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { bazaarPageGuard } from '@/server/services/bazaar-settings';

export async function studioBazaarContext() {
  await bazaarPageGuard();
  const m = await requireMerchant().catch(() => null);
  if (!m) redirect('/login?next=/studio/bazaar');
  const participation = await prisma.merchantBazaar.findUnique({ where: { merchantId: m.merchantId } });
  return { merchant: m, participation };
}

export function studioTabs(counts: { inbox?: number; lives?: number } = {}) {
  return [
    { href: '/studio/bazaar', label: '홈·참여' },
    { href: '/studio/bazaar/donations', label: '기부 접수함', badge: counts.inbox },
    { href: '/studio/bazaar/lives', label: '방송 편성', badge: counts.lives },
    { href: '/studio/bazaar/sales', label: '판매·정산' },
  ];
}
