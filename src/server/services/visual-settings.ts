import { randomInt } from 'node:crypto';
import { prisma } from '@/server/db';
import { DONATION_BANNERS, DONATION_MARGINS, MAIN_MARGINS, MAIN_VISUAL_KEY, mainVisualSchema, orgVisualKey, orgVisualSchema } from '@/lib/visual-presets';

/**
 * 읽기 우선 + 없을 때만 1회 생성.
 * 예전에는 읽을 때마다 upsert 해 공개 후원페이지 렌더가 모두 쓰기 트랜잭션이 됐다.
 * 동시에 두 요청이 처음 만들면 한쪽이 P2002 를 받으므로, 그때는 먼저 만든 값을 다시 읽는다.
 */
async function readOrCreateSetting(key: string, initial: () => object) {
  const found = await prisma.systemSetting.findUnique({ where: { key } });
  if (found) return found;
  try {
    return await prisma.systemSetting.create({ data: { key, value: initial() } });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    return prisma.systemSetting.findUniqueOrThrow({ where: { key } });
  }
}

/** Initial assignments are random once, persisted per institution, and stable on reload. */
export async function getOrgVisuals(merchantId: string) {
  const key = orgVisualKey(merchantId);
  const row = await readOrCreateSetting(key, () => ({ bannerIndex: randomInt(5), marginIndex: randomInt(5), backgroundUrl: '' }));
  const p = orgVisualSchema.safeParse(row.value);
  const value = p.success ? p.data : { bannerIndex: 0, marginIndex: 0, backgroundUrl: '' };
  return { ...value, defaultBanner: DONATION_BANNERS[value.bannerIndex].url, resolvedBackground: value.backgroundUrl || DONATION_MARGINS[value.marginIndex].url };
}
export async function getMainVisuals() {
  const row = await readOrCreateSetting(MAIN_VISUAL_KEY, () => ({ activeIndex: randomInt(5), images: MAIN_MARGINS.map(x => x.url) }));
  const p = mainVisualSchema.safeParse(row.value);
  const value = p.success ? p.data : { activeIndex: 0, images: MAIN_MARGINS.map(x => x.url) };
  return { ...value, activeUrl: value.images[value.activeIndex] };
}
