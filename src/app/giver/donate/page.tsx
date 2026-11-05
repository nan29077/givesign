import { PageHeader } from '@/components/layout/console-shell';
import { DonationForm } from '@/components/bazaar/donation-form';
import { giverPageContext } from '@/server/giver-context';
import { eligibleMerchants } from '@/server/services/bazaar';
import { getBazaarConfig } from '@/server/services/bazaar-settings';

export const dynamic = 'force-dynamic';

export default async function GiverDonatePage() {
  await giverPageContext();
  const [merchants, cfg] = await Promise.all([eligibleMerchants(), getBazaarConfig()]);
  return (
    <>
      <PageHeader title="물품 기부하기" description="새 상품·미개봉 물품을 기부해 주세요. 접수 후 기관 매칭 → 가액 협의 → 약정 → 입고·검수 → 기부금영수증 순서로 진행됩니다." />
      <DonationForm merchants={merchants.map((m) => ({ id: m.id, displayName: m.displayName, neededItems: m.neededItems }))} minSalePrice={cfg.minSalePrice} />
    </>
  );
}
