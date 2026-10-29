import 'server-only';
import { prisma } from '@/server/db';
import { campaignSchema, defaultDonationPage, donationPageSchema, pageKey, type Campaign } from '@/lib/fundraising';

export async function getDonationPage(id: string) {
  const row = await prisma.systemSetting.findUnique({ where: { key: pageKey(id) } });
  const parsed = donationPageSchema.safeParse(row?.value);
  return parsed.success ? parsed.data : { ...defaultDonationPage };
}
export async function getCampaigns(owner: string): Promise<Campaign[]> {
  const rows = await prisma.systemSetting.findMany({ where: { key: { startsWith: `givesign:campaign:${owner}:` } }, orderBy: { updatedAt: 'desc' } });
  return rows.flatMap(row => {
    const v = row.value as unknown as Campaign;
    const p = campaignSchema.safeParse(v);
    return p.success && v.merchantId === owner && typeof v.id === 'string' ? [{ ...p.data, id: v.id, merchantId: owner, createdAt: v.createdAt }] : [];
  });
}
