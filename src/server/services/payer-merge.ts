import { normalizePhone, phoneHash } from '@/lib/crypto';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';

/**
 * 후원자 병합 (통합 관리자 전용, 2026-11-06).
 *
 * 같은 사람이 번호를 바꿔 payer_profile 이 둘이 된 경우, 옛 후원자(원본)를 새 후원자(대상)에 "병합" 표시한다.
 *
 * 규칙
 *  - 결제·약정·봉사·영수증 행은 **옮기지 않는다.** 조회·집계(통합 구성원 목록·기관 후원자 누적)에서만 한 사람으로 묶는다.
 *  - 기부금영수증은 각자 명의(각 후원자 행의 영수증 정보) 그대로 발급된다.
 *  - 병합은 1단계만: 대상은 다른 후원자에 병합돼 있지 않아야 하고, 원본에는 병합된 후원자가 없어야 한다(체인·순환 금지).
 *    두 행을 FOR UPDATE 로 잠근 뒤 확인하므로 동시에 반대 방향으로 병합해도 순환이 생기지 않는다.
 *  - 근거 메모 필수, 감사로그 PAYER_MERGE / PAYER_UNMERGE. 화면·감사로그에는 마스킹 번호만 남긴다.
 */

export class PayerMergeError extends Error {}

export const MERGE_NOTE_MIN = 4;

export async function mergePayer(input: { sourceId: string; targetId: string; note: string; adminUserId: string }) {
  const note = input.note.trim().slice(0, 300);
  if (note.length < MERGE_NOTE_MIN) throw new PayerMergeError(`병합 근거를 ${MERGE_NOTE_MIN}자 이상 적어 주세요. (예: 본인 확인 통화 2026-11-06, 번호 변경)`);
  if (!input.sourceId || !input.targetId || input.sourceId === input.targetId) throw new PayerMergeError('자기 자신에게는 병합할 수 없습니다.');

  const result = await prisma.$transaction(async (tx) => {
    const ids = [input.sourceId, input.targetId].sort();
    const locked = await tx.$queryRaw<{ id: string; merged_into_id: string | null; phone_masked: string }[]>`
      SELECT "id", "merged_into_id", "phone_masked" FROM "payer_profile" WHERE "id" IN (${ids[0]}, ${ids[1]}) ORDER BY "id" FOR UPDATE`;
    const source = locked.find((r) => r.id === input.sourceId);
    const target = locked.find((r) => r.id === input.targetId);
    if (!source || !target) throw new PayerMergeError('후원자를 찾을 수 없습니다.');
    if (source.merged_into_id) throw new PayerMergeError('이미 다른 후원자에 병합된 후원자입니다. 먼저 병합을 해제해 주세요.');
    if (target.merged_into_id) throw new PayerMergeError('대상 후원자가 다른 후원자에 병합돼 있습니다. 병합은 한 단계만 허용합니다.');
    const children = await tx.payerProfile.count({ where: { mergedIntoId: input.sourceId } });
    if (children > 0) throw new PayerMergeError('이 후원자에 병합된 다른 후원자가 있어 다시 병합할 수 없습니다. 병합은 한 단계만 허용합니다.');
    const now = new Date();
    await tx.payerProfile.update({
      where: { id: input.sourceId },
      data: { mergedIntoId: input.targetId, mergedAt: now, mergedBy: input.adminUserId, mergeNote: note },
    });
    return { sourceMasked: source.phone_masked, targetMasked: target.phone_masked, mergedAt: now };
  });

  await writeAudit({
    adminUserId: input.adminUserId,
    action: 'PAYER_MERGE',
    targetType: 'PayerProfile',
    targetId: input.sourceId,
    before: { mergedIntoId: null },
    after: { mergedIntoId: input.targetId, sourceMasked: result.sourceMasked, targetMasked: result.targetMasked, note },
  });
  return result;
}

export async function unmergePayer(input: { sourceId: string; adminUserId: string; note?: string }) {
  const before = await prisma.payerProfile.findUnique({
    where: { id: input.sourceId },
    select: { id: true, phoneMasked: true, mergedIntoId: true, mergedAt: true, mergeNote: true },
  });
  if (!before) throw new PayerMergeError('후원자를 찾을 수 없습니다.');
  if (!before.mergedIntoId) throw new PayerMergeError('병합된 후원자가 아닙니다.');
  const r = await prisma.payerProfile.updateMany({
    where: { id: before.id, mergedIntoId: before.mergedIntoId },
    data: { mergedIntoId: null, mergedAt: null, mergedBy: null, mergeNote: null },
  });
  if (r.count === 0) throw new PayerMergeError('병합 상태가 바뀌었습니다. 새로 고친 뒤 다시 시도해 주세요.');
  await writeAudit({
    adminUserId: input.adminUserId,
    action: 'PAYER_UNMERGE',
    targetType: 'PayerProfile',
    targetId: before.id,
    before: { mergedIntoId: before.mergedIntoId, mergedAt: before.mergedAt, note: before.mergeNote },
    after: { mergedIntoId: null, sourceMasked: before.phoneMasked, note: input.note?.trim().slice(0, 300) || null },
  });
}

/**
 * 집계용: 주어진 후원자 중 병합된 행의 (원본 → 대상) 지도. 병합되지 않은 행은 지도에 없다.
 * 병합은 1단계만이라 한 번 따라가면 끝이다.
 */
export async function mergeTargets(payerIds: string[]): Promise<Map<string, string>> {
  if (payerIds.length === 0) return new Map();
  const rows = await prisma.payerProfile.findMany({
    where: { id: { in: payerIds }, mergedIntoId: { not: null } },
    select: { id: true, mergedIntoId: true },
  });
  return new Map(rows.map((r) => [r.id, r.mergedIntoId!]));
}

/** 대상 후원자별로 병합돼 들어온 원본 수 */
export async function mergedChildCounts(targetIds: string[]): Promise<Map<string, number>> {
  if (targetIds.length === 0) return new Map();
  const g = await prisma.payerProfile.groupBy({ by: ['mergedIntoId'], where: { mergedIntoId: { in: targetIds } }, _count: { _all: true } });
  return new Map(g.map((r) => [r.mergedIntoId!, r._count._all]));
}

/** 관리자 병합 대상 검색. 휴대폰 전체 번호(해시로 찾음) · 번호 끝자리 · 표시 이름. 마스킹 값만 돌려준다. */
export async function searchMergeCandidates(q: string, excludeId: string) {
  const query = q.trim();
  if (query.length < 2) return [];
  const digits = normalizePhone(query);
  const where =
    /^01\d{8,9}$/.test(digits)
      ? { phoneHash: phoneHash(digits) }
      : { OR: [{ phoneMasked: { contains: query } }, { displayName: { contains: query } }] };
  return prisma.payerProfile.findMany({
    where: { AND: [where, { id: { not: excludeId } }] },
    select: { id: true, displayName: true, phoneMasked: true, mergedIntoId: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
}

type PayerSum = {
  payerId: string | null;
  _sum: { amount: bigint | null };
  _count: { _all: number };
  _max: { paidAt: Date | null };
  _min: { paidAt: Date | null };
};

/**
 * 기관 후원자 누적(/studio/donors): charge.groupBy(payerId) 결과를 병합 대상 기준으로 다시 합친다.
 * 원본 후원자의 결제 건은 그대로 두고 화면 집계만 한 줄로 묶는다.
 */
export async function foldMergedSums<T extends PayerSum>(rows: T[]): Promise<{ sums: T[]; mergedCount: Map<string, number> }> {
  const merged = await mergeTargets(rows.map((r) => r.payerId!).filter(Boolean));
  const mergedCount = new Map<string, number>();
  for (const [, t] of merged) mergedCount.set(t, (mergedCount.get(t) ?? 0) + 1);
  if (merged.size === 0) return { sums: rows, mergedCount };
  const out = new Map<string, T>();
  for (const r of rows) {
    const key = merged.get(r.payerId!) ?? r.payerId!;
    const cur = out.get(key);
    if (!cur) {
      out.set(key, { ...r, payerId: key, _sum: { ...r._sum }, _count: { ...r._count }, _max: { ...r._max }, _min: { ...r._min } });
      continue;
    }
    cur._sum.amount = (cur._sum.amount ?? 0n) + (r._sum.amount ?? 0n);
    cur._count._all += r._count._all;
    if (r._max.paidAt && (!cur._max.paidAt || r._max.paidAt > cur._max.paidAt)) cur._max.paidAt = r._max.paidAt;
    if (r._min.paidAt && (!cur._min.paidAt || r._min.paidAt < cur._min.paidAt)) cur._min.paidAt = r._min.paidAt;
  }
  return { sums: [...out.values()], mergedCount };
}
