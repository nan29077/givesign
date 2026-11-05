import { prisma } from '@/server/db';

/**
 * 관리자 화면의 기관 선택 상자용 목록.
 *
 * 예전에는 화면마다 기관 전체를 take 없이 읽어 <select> 를 만들었다. 기관이 수천이 되면 모든 관리자
 * 화면이 느려진다. 이름순 상위 MERCHANT_OPTION_LIMIT 곳만 읽고, 지금 선택된 기관(include)은
 * 상한 밖이어도 항상 넣는다. 넘친 경우 truncated=true 로 알려 화면이 안내 문구를 띄운다.
 */
export const MERCHANT_OPTION_LIMIT = 200;

export async function merchantSelectOptions(
  opts: { approvedOnly?: boolean; include?: Array<string | null | undefined> } = {},
): Promise<{ merchants: Array<{ id: string; displayName: string; code: string }>; truncated: boolean }> {
  const where = opts.approvedOnly === false ? {} : { status: 'APPROVED' as const };
  const select = { id: true, displayName: true, code: true } as const;
  const rows = await prisma.merchantProfile.findMany({
    where,
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: MERCHANT_OPTION_LIMIT + 1,
    select,
  });
  const truncated = rows.length > MERCHANT_OPTION_LIMIT;
  const merchants = rows.slice(0, MERCHANT_OPTION_LIMIT);
  const have = new Set(merchants.map((m) => m.id));
  const missing = [...new Set((opts.include ?? []).filter((v): v is string => Boolean(v) && !have.has(v!)))];
  if (missing.length > 0) {
    const extra = await prisma.merchantProfile.findMany({ where: { ...where, id: { in: missing } }, select });
    merchants.push(...extra);
    merchants.sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));
  }
  return { merchants, truncated };
}
