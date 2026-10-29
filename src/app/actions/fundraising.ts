'use server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { campaignKey, campaignSchema, donationPageSchema, pageKey } from '@/lib/fundraising';

const text = (f: FormData, k: string) => String(f.get(k) ?? '');
export async function saveDonationPage(f: FormData) {
  const { merchantId } = await requireMerchant();
  const parsed = donationPageSchema.safeParse({ ...Object.fromEntries(f), published: f.get('published') === 'on', showCampaigns: f.get('showCampaigns') === 'on' });
  if (!parsed.success) redirect('/studio/donation-page?error=' + encodeURIComponent(parsed.error.issues[0].message));
  await prisma.systemSetting.upsert({ where: { key: pageKey(merchantId) }, create: { key: pageKey(merchantId), value: parsed.data }, update: { value: parsed.data } });
  revalidatePath('/donate', 'layout');
  redirect('/studio/donation-page?saved=1');
}
export async function saveCampaign(f: FormData) {
  const { merchantId } = await requireMerchant();
  const supplied = text(f, 'id');
  if (supplied && !/^[0-9A-Z]{26}$/.test(supplied)) throw new Error('잘못된 캠페인입니다.');
  const id = supplied || newId();
  const key = campaignKey(merchantId, id);
  const existing = supplied ? await prisma.systemSetting.findUnique({ where: { key } }) : null;
  if (supplied && !existing) throw new Error('캠페인에 접근할 수 없습니다.');
  const p = campaignSchema.safeParse({ ...Object.fromEntries(f), published: f.get('published') === 'on' });
  if (!p.success) redirect(`/studio/campaigns/${supplied || 'new'}?error=${encodeURIComponent(p.error.issues[0].message)}`);
  const value = { ...p.data, id, merchantId, createdAt: (existing?.value as { createdAt?: string } | null)?.createdAt ?? new Date().toISOString() };
  await prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  revalidatePath('/donate', 'layout');
  redirect('/studio/campaigns?saved=1');
}
export async function archiveCampaign(f: FormData) {
  const { merchantId } = await requireMerchant();
  const key = campaignKey(merchantId, text(f, 'id'));
  const row = await prisma.systemSetting.findUnique({ where: { key } });
  if (!row) throw new Error('캠페인을 찾을 수 없습니다.');
  await prisma.systemSetting.update({ where: { key }, data: { value: { ...(row.value as object), published: false } } });
  revalidatePath('/donate', 'layout');
  redirect('/studio/campaigns');
}
