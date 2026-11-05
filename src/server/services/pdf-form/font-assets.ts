import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import type { PdfLayout } from '@/lib/pdf-form';
import { deletePrivateObject, getPrivateObject, newObjectName, putPrivateObject } from '@/server/uploads';

/**
 * 기관이 올린 원본 서식용 글꼴(TTF·OTF) 대장.
 *
 *  - 파일은 비공개 저장소(`putPrivateObject`)에만 두고 공개 주소를 만들지 않는다(글꼴 라이선스).
 *  - 행(`document_font_asset`)으로 어느 기관의 파일인지 남겨, 기관별 개수·총량 상한을 걸고
 *    렌더할 때 그 기관이 올린 글꼴만 쓴다(다른 기관의 저장 이름을 넣어도 읽지 않는다).
 *  - 서식 등록 전에 올렸다가 폼을 버리면 어느 서식에도 쓰이지 않는다. 그런 행은 일정 시간이
 *    지나면 전자문서 배치(/api/cron/edoc)가 파일과 함께 지운다(`cleanupUnreferencedFontAssets`).
 */

export const FONT_ASSET_MAX_BYTES = 25 * 1024 * 1024;
/** 기관당 보관 글꼴 수 */
export const FONT_ASSET_MAX_COUNT = 20;
/** 기관당 보관 글꼴 총량 */
export const FONT_ASSET_MAX_TOTAL_BYTES = 150 * 1024 * 1024;
/** 서식에 쓰이지 않은 글꼴을 지우기 전 기다리는 시간(등록 화면에서 오래 작업하는 경우) */
export const FONT_ASSET_ORPHAN_HOURS = 48;

export type FontAssetResult =
  | { ok: true; asset: { name: string; match: string; displayName: string } }
  | { ok: false; message: string; status: number };

/** 한도 안에서 글꼴을 저장하고 대장에 기록한다. 같은 기관의 동시 업로드는 기관 단위 잠금으로 줄을 세운다. */
export async function registerFontAsset(
  merchantId: string,
  buf: Buffer,
  ext: 'ttf' | 'otf',
  match: string,
  displayName: string,
): Promise<FontAssetResult> {
  if (buf.length > FONT_ASSET_MAX_BYTES) return { ok: false, status: 400, message: '글꼴 파일은 25MB 이하만 올릴 수 있습니다.' };
  const name = newObjectName(ext);
  const reserved = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`font-asset:${merchantId}`}))`;
    const agg = await tx.documentFontAsset.aggregate({ where: { merchantId }, _count: { _all: true }, _sum: { bytes: true } });
    if (agg._count._all >= FONT_ASSET_MAX_COUNT) {
      return { ok: false as const, message: `글꼴은 기관당 ${FONT_ASSET_MAX_COUNT}개까지 보관할 수 있습니다. 쓰지 않는 서식의 글꼴을 정리한 뒤 다시 올려 주세요.` };
    }
    if ((agg._sum.bytes ?? 0) + buf.length > FONT_ASSET_MAX_TOTAL_BYTES) {
      return { ok: false as const, message: '기관이 올린 글꼴 총량(150MB)을 넘습니다. 쓰지 않는 서식의 글꼴을 정리한 뒤 다시 올려 주세요.' };
    }
    // 파일보다 행을 먼저 남긴다. 파일 저장이 실패하면 행을 지운다(아래).
    await tx.documentFontAsset.create({ data: { id: newId(), merchantId, name, match, displayName, bytes: buf.length } });
    return { ok: true as const };
  });
  if (!reserved.ok) return { ok: false, status: 400, message: reserved.message };
  try {
    await putPrivateObject(name, buf, 'application/octet-stream');
  } catch (err) {
    await prisma.documentFontAsset.delete({ where: { name } }).catch(() => undefined);
    logger.warn('[pdf-form] 글꼴 저장 실패', { err: err instanceof Error ? err.message : String(err) });
    return { ok: false, status: 500, message: '글꼴을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' };
  }
  return { ok: true, asset: { name, match, displayName } };
}

/** 편집 기록의 글꼴이 모두 이 기관이 올린 것인지. 아니면 안내 문구. */
export async function fontOwnershipProblem(merchantId: string, layout: PdfLayout): Promise<string | null> {
  const names = Array.from(new Set(layout.fonts.map((f) => f.url)));
  if (names.length === 0) return null;
  const owned = await prisma.documentFontAsset.count({ where: { merchantId, name: { in: names } } });
  return owned === names.length ? null : '올린 글꼴을 찾을 수 없습니다. 글꼴 파일을 다시 올려 주세요.';
}

/** 렌더러가 쓰는 글꼴 읽기: 이 기관 소유로 기록된 이름만 비공개 저장소에서 읽는다. */
export function fontLoaderFor(merchantId: string): (name: string) => Promise<Uint8Array | null> {
  return async (name: string) => {
    const row = await prisma.documentFontAsset.findFirst({ where: { merchantId, name }, select: { id: true } });
    if (!row) return null;
    const buf = await getPrivateObject(name);
    return buf ? new Uint8Array(buf) : null;
  };
}

/**
 * 어느 서식 편집 기록에도 쓰이지 않은 채 오래된 글꼴을 파일과 함께 지운다.
 * 결과 PDF 에는 쓰인 글자만 부분집합으로 들어가 있어, 이미 만든 결과·발송된 서명 요청에는 영향이 없다.
 */
export async function cleanupUnreferencedFontAssets(
  now = new Date(),
  opts: { orphanHours?: number; limit?: number } = {},
): Promise<{ checked: number; removed: number }> {
  const cutoff = new Date(now.getTime() - (opts.orphanHours ?? FONT_ASSET_ORPHAN_HOURS) * 3600_000);
  const candidates = await prisma.documentFontAsset.findMany({
    where: { createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 200,
    select: { id: true, merchantId: true, name: true },
  });
  let removed = 0;
  for (const c of candidates) {
    // 보관한 서식의 기록도 참조로 본다(되살릴 수 있어야 한다).
    const used = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM "document_template"
      WHERE "merchant_id" = ${c.merchantId} AND "pdf_layout" IS NOT NULL
        AND "pdf_layout"::text LIKE ${`%${c.name}%`}`;
    if (Number(used[0]?.n ?? 0) > 0) continue;
    try {
      await deletePrivateObject(c.name);
      await prisma.documentFontAsset.delete({ where: { id: c.id } });
      removed++;
    } catch (err) {
      logger.warn('[pdf-form] 쓰이지 않는 글꼴 정리 실패', { name: c.name, err: err instanceof Error ? err.message : String(err) });
    }
  }
  return { checked: candidates.length, removed };
}
