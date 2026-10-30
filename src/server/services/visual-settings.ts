import { randomInt } from 'node:crypto';
import { prisma } from '@/server/db';
import { DONATION_BANNERS, DONATION_MARGINS, MAIN_MARGINS, MAIN_VISUAL_KEY, mainVisualSchema, orgVisualKey, orgVisualSchema } from '@/lib/visual-presets';

/** Initial assignments are random once, persisted per institution, and stable on reload. */
export async function getOrgVisuals(merchantId: string) {
  const key = orgVisualKey(merchantId);
  const row = await prisma.systemSetting.upsert({
    where: { key }, update: {},
    create: { key, value: { bannerIndex: randomInt(5), marginIndex: randomInt(5), backgroundUrl: '' } },
  });
  const p = orgVisualSchema.safeParse(row.value);
  const value = p.success ? p.data : { bannerIndex: 0, marginIndex: 0, backgroundUrl: '' };
  return { ...value, defaultBanner: DONATION_BANNERS[value.bannerIndex].url, resolvedBackground: value.backgroundUrl || DONATION_MARGINS[value.marginIndex].url };
}
export async function getMainVisuals() {
  const row = await prisma.systemSetting.upsert({
    where: { key: MAIN_VISUAL_KEY }, update: {},
    create: { key: MAIN_VISUAL_KEY, value: { activeIndex: randomInt(5), images: MAIN_MARGINS.map(x => x.url) } },
  });
  const p = mainVisualSchema.safeParse(row.value);
  const value = p.success ? p.data : { activeIndex: 0, images: MAIN_MARGINS.map(x => x.url) };
  return { ...value, activeUrl: value.images[value.activeIndex] };
}
