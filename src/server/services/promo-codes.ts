import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { PAID_STATUSES } from '@/components/studio/shared';
import { CAMPAIGN_CODE_RE, campaignOpen, dateKey, kstToday, normalizeCampaignCode } from '@/lib/fundraising';
import { isMoReservedWord } from '@/lib/mo-commands';
import type { Campaign, CampaignPromo, Prisma } from '@/generated/prisma/client';

/**
 * 캠페인 홍보물 코드 (2026-11-12 4차 K1).
 *
 * 현수막·소식지·행사장 QR 처럼 홍보물마다 문자 키워드(선택)·QR 을 따로 두고, 어느 홍보물로 후원이 들어왔는지 나눠 본다.
 *  - 캠페인당 보관 전 홍보물 `PROMO_LIMIT_PER_CAMPAIGN`(20)개. 지우지 않고 보관한다(되살릴 수 있음).
 *  - 키워드는 기관 안에서 유일(DB 유니크) + 캠페인 키워드·별칭·예약어·명령어와 겹치지 않는다.
 *  - 문자에서 인식하는 조건: 보관 전 + 만료일(KST) 전 + 캠페인 모금 중. 아니면 예전처럼 기관 일반 후원이다.
 *  - 원천은 결제 건(`charge.promo_id`)과 단계 기록(`funnel_step.promo_id`)이다. 별도 누적 컬럼을 두지 않는다.
 */

export const PROMO_LIMIT_PER_CAMPAIGN = 20;
export const CAMPAIGN_ALIAS_LIMIT = 10;

export class PromoError extends Error {}

/** 키워드 정규화 + 형식 검사. 비면 null(QR·링크 전용 홍보물). */
export function normalizePromoKeyword(raw: string | null | undefined): string | null {
  const v = normalizeCampaignCode(raw ?? '');
  if (!v) return null;
  if (!CAMPAIGN_CODE_RE.test(v)) throw new PromoError('홍보물 키워드는 한글·영문·숫자 2~10자로 입력해 주세요.');
  if (isMoReservedWord(v)) throw new PromoError('정기·봉사·영수증·내역·변경·해지·문의 같은 문자 예약어는 키워드로 쓸 수 없습니다.');
  return v;
}

/** 기관 안의 다른 캠페인 키워드·별칭·홍보물 키워드와 겹치는지 */
async function assertKeywordFree(merchantId: string, keyword: string, opts: { exceptPromoId?: string; exceptCampaignAliasOf?: string } = {}) {
  const campaigns = await prisma.campaign.findMany({ where: { merchantId }, select: { id: true, code: true, aliases: true } });
  for (const c of campaigns) {
    if (normalizeCampaignCode(c.code) === keyword) throw new PromoError(`캠페인 키워드 "${c.code}" 와 겹칩니다. 다른 키워드를 써 주세요.`);
    if (c.id !== opts.exceptCampaignAliasOf && c.aliases.some((a) => normalizeCampaignCode(a) === keyword)) {
      throw new PromoError(`다른 캠페인의 별칭 "${keyword}" 와 겹칩니다.`);
    }
  }
  const promo = await prisma.campaignPromo.findFirst({ where: { merchantId, keyword, ...(opts.exceptPromoId ? { id: { not: opts.exceptPromoId } } : {}) }, select: { id: true } });
  if (promo) throw new PromoError('이미 같은 키워드를 쓰는 홍보물이 있습니다(보관한 홍보물 포함).');
}

function parseExpiresOn(raw: string | null | undefined): Date | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw new PromoError('만료일 형식은 YYYY-MM-DD 입니다.');
  return new Date(`${v}T00:00:00Z`);
}

async function ownedCampaign(merchantId: string, campaignId: string) {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, merchantId } });
  if (!c) throw new PromoError('캠페인을 찾을 수 없습니다.');
  if (c.status === 'ARCHIVED') throw new PromoError('보관한 캠페인에는 홍보물을 만들 수 없습니다.');
  return c;
}

export interface PromoInput {
  name: string;
  keyword?: string | null;
  expiresOn?: string | null;
}

function cleanName(raw: string) {
  const name = (raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new PromoError('홍보물 이름을 입력해 주세요. (예: 현수막 1, 교회 소식지 11월)');
  if (name.length > 40) throw new PromoError('홍보물 이름은 40자 이내로 입력해 주세요.');
  return name;
}

/** 캠페인당 상한은 캠페인 단위 advisory lock 아래에서 센다(동시 생성에도 20개를 넘지 않음). */
async function withCampaignLock<T>(campaignId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(778301, hashtext(${campaignId}))`;
    return fn(tx);
  });
}

export async function createPromo(merchantId: string, campaignId: string, input: PromoInput, userId: string): Promise<CampaignPromo> {
  await ownedCampaign(merchantId, campaignId);
  const name = cleanName(input.name);
  const keyword = normalizePromoKeyword(input.keyword);
  const expiresOn = parseExpiresOn(input.expiresOn);
  if (keyword) await assertKeywordFree(merchantId, keyword);
  try {
    return await withCampaignLock(campaignId, async (tx) => {
      const live = await tx.campaignPromo.count({ where: { campaignId, archivedAt: null } });
      if (live >= PROMO_LIMIT_PER_CAMPAIGN) throw new PromoError(`홍보물은 캠페인당 ${PROMO_LIMIT_PER_CAMPAIGN}개까지 만들 수 있습니다. 쓰지 않는 홍보물을 보관해 주세요.`);
      return tx.campaignPromo.create({ data: { id: newId(), merchantId, campaignId, name, keyword, expiresOn, createdBy: userId } });
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new PromoError('이미 같은 키워드를 쓰는 홍보물이 있습니다.');
    throw e;
  }
}

export async function updatePromo(merchantId: string, id: string, input: PromoInput): Promise<CampaignPromo> {
  const row = await prisma.campaignPromo.findFirst({ where: { id, merchantId } });
  if (!row) throw new PromoError('홍보물을 찾을 수 없습니다.');
  const name = cleanName(input.name);
  const keyword = normalizePromoKeyword(input.keyword);
  const expiresOn = parseExpiresOn(input.expiresOn);
  if (keyword && keyword !== row.keyword) await assertKeywordFree(merchantId, keyword, { exceptPromoId: id });
  try {
    return await prisma.campaignPromo.update({ where: { id }, data: { name, keyword, expiresOn } });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new PromoError('이미 같은 키워드를 쓰는 홍보물이 있습니다.');
    throw e;
  }
}

export async function archivePromo(merchantId: string, id: string) {
  const r = await prisma.campaignPromo.updateMany({ where: { id, merchantId, archivedAt: null }, data: { archivedAt: new Date() } });
  if (r.count !== 1) throw new PromoError('보관할 홍보물을 찾을 수 없습니다.');
}

export async function restorePromo(merchantId: string, id: string) {
  const row = await prisma.campaignPromo.findFirst({ where: { id, merchantId } });
  if (!row || !row.archivedAt) throw new PromoError('되살릴 홍보물을 찾을 수 없습니다.');
  await withCampaignLock(row.campaignId, async (tx) => {
    const live = await tx.campaignPromo.count({ where: { campaignId: row.campaignId, archivedAt: null } });
    if (live >= PROMO_LIMIT_PER_CAMPAIGN) throw new PromoError(`홍보물은 캠페인당 ${PROMO_LIMIT_PER_CAMPAIGN}개까지입니다.`);
    await tx.campaignPromo.updateMany({ where: { id, archivedAt: { not: null } }, data: { archivedAt: null } });
  });
}

export async function listPromos(merchantId: string, campaignId: string, includeArchived = false) {
  return prisma.campaignPromo.findMany({
    where: { merchantId, campaignId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: [{ archivedAt: 'asc' }, { createdAt: 'asc' }],
  });
}

/** 홍보물이 지금 인식되는가(보관 전 + 만료일 KST 전). 캠페인 모금 여부는 따로 본다. */
export function promoActive(p: Pick<CampaignPromo, 'archivedAt' | 'expiresOn'>, now = new Date()) {
  if (p.archivedAt) return false;
  if (p.expiresOn && dateKey(p.expiresOn) < kstToday(now)) return false;
  return true;
}

/**
 * 문자 맨 앞 낱말(정규화 값)이 모금 중 캠페인의 홍보물 키워드인가. 캠페인 키워드 일치(matchCampaignKeyword)가
 * 먼저이고, 맞지 않았을 때만 부른다 — 기존 키워드 동작을 바꾸지 않는다.
 */
export async function matchPromoKeyword(merchantId: string, token: string, now = new Date()): Promise<{ promo: CampaignPromo; campaign: Campaign } | null> {
  if (!token) return null;
  const promo = await prisma.campaignPromo.findFirst({ where: { merchantId, keyword: token, archivedAt: null } });
  if (!promo || !promoActive(promo, now)) return null;
  const campaign = await prisma.campaign.findFirst({ where: { id: promo.campaignId, merchantId, status: 'ACTIVE' } });
  if (!campaign || !campaignOpen(campaign, now)) return null;
  return { promo, campaign };
}

/** 쿠키·링크로 받은 홍보물 id 가 이 기관 것인지(보관 전). 아니면 null — 임의 값을 결제 건에 쓰지 않는다. */
export async function promoForAttribution(merchantId: string, promoId: string | null | undefined): Promise<string | null> {
  if (!promoId) return null;
  const p = await prisma.campaignPromo.findFirst({ where: { id: promoId, merchantId, archivedAt: null }, select: { id: true } });
  return p?.id ?? null;
}

export interface PromoPerformanceRow {
  promoId: string;
  /** 문자 수신(단계 기록 MO_RECEIVED, 측정 시작 이후) */
  moReceived: number;
  /** 결제 완료 건(문자·웹·QR 모두, 환불 제외 — 결제 건 원천) */
  paidCount: number;
  paidAmount: bigint;
}

/** 홍보물별 성과(캠페인 상세). 원천: funnel_step(수신) · charge(결제 완료·금액). */
export async function promoPerformance(promoIds: string[]): Promise<Map<string, PromoPerformanceRow>> {
  const out = new Map<string, PromoPerformanceRow>();
  for (const id of promoIds) out.set(id, { promoId: id, moReceived: 0, paidCount: 0, paidAmount: 0n });
  if (promoIds.length === 0) return out;
  const [received, paid] = await Promise.all([
    prisma.funnelStep.groupBy({ by: ['promoId'], where: { promoId: { in: promoIds }, step: 'MO_RECEIVED' }, _count: { _all: true } }),
    prisma.charge.groupBy({ by: ['promoId'], where: { promoId: { in: promoIds }, status: { in: PAID_STATUSES }, isTest: false }, _count: { _all: true }, _sum: { amount: true } }),
  ]);
  for (const r of received) if (r.promoId) out.get(r.promoId)!.moReceived = r._count._all;
  for (const r of paid) {
    if (!r.promoId) continue;
    const row = out.get(r.promoId)!;
    row.paidCount = r._count._all;
    row.paidAmount = r._sum.amount ?? 0n;
  }
  return out;
}

/** 홍보물 QR 이 가리키는 중간 페이지 주소 */
export function promoLandingUrl(promoId: string) {
  return `${env.baseUrl}/m/${promoId}`;
}

export interface PromoSmsTarget {
  promoId: string;
  promoName: string;
  merchantCode: string;
  merchantName: string;
  campaignId: string;
  campaignTitle: string;
  /** 문자 받을 번호(숫자). 배정된 번호가 없으면 null */
  number: string | null;
  /** 문자 본문(대표번호 공유면 기관 키워드를 앞에) */
  body: string;
  /** 홍보물 만료·보관 또는 캠페인 모금 끝 */
  inactive: boolean;
  /** 후원페이지 주소(유입 경로 promo) */
  donateUrl: string;
}

/**
 * 중간 페이지(/m/[promoId])가 쓸 값. 승인된 기관의 홍보물만. 홍보물이 만료됐어도 후원페이지 버튼은 준다.
 */
export async function promoSmsTarget(promoId: string, now = new Date()): Promise<PromoSmsTarget | null> {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(promoId ?? '')) return null;
  const promo = await prisma.campaignPromo.findUnique({ where: { id: promoId } });
  if (!promo) return null;
  const merchant = await prisma.merchantProfile.findFirst({
    where: { id: promo.merchantId, status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
    select: { id: true, code: true, displayName: true },
  });
  if (!merchant) return null;
  const campaign = await prisma.campaign.findFirst({ where: { id: promo.campaignId, merchantId: merchant.id, status: { in: ['ACTIVE', 'CLOSED'] } } });
  if (!campaign) return null;
  const numbers = await prisma.merchantMoNumber.findMany({
    where: { merchantId: merchant.id, status: 'ASSIGNED' },
    select: { phoneNumber: true, mode: true, keyword: true },
    orderBy: { assignedAt: 'desc' },
  });
  const dedicated = numbers.find((n) => n.mode === 'DEDICATED');
  const shared = numbers.find((n) => n.mode === 'SHARED_PREFIX' && n.keyword);
  const word = promo.keyword ?? campaign.code;
  const target = dedicated ?? shared ?? null;
  const body = target && target.mode === 'SHARED_PREFIX' && target.keyword ? `${target.keyword} ${word} ` : `${word} `;
  const inactive = !promoActive(promo, now) || !(campaign.status === 'ACTIVE' && campaignOpen(campaign, now));
  return {
    promoId: promo.id,
    promoName: promo.name,
    merchantCode: merchant.code,
    merchantName: merchant.displayName,
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    number: target?.phoneNumber ?? null,
    body,
    inactive,
    donateUrl: `${env.baseUrl}/donate/${merchant.code}/campaigns/${campaign.id}?src=promo:${promo.id}`,
  };
}

// ---------------------------------------------------------------------------
// 캠페인 별칭 (K2 — 보완 해석에만 쓰인다)
// ---------------------------------------------------------------------------

export async function setCampaignAliases(merchantId: string, campaignId: string, raw: string[]): Promise<string[]> {
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, merchantId }, select: { id: true, code: true } });
  if (!c) throw new PromoError('캠페인을 찾을 수 없습니다.');
  const out: string[] = [];
  for (const r of raw) {
    const v = normalizeCampaignCode(r);
    if (!v) continue;
    if (!CAMPAIGN_CODE_RE.test(v)) throw new PromoError(`별칭 "${r}" — 한글·영문·숫자 2~10자로 입력해 주세요.`);
    if (isMoReservedWord(v)) throw new PromoError(`별칭 "${r}" — 문자 예약어는 별칭으로 쓸 수 없습니다.`);
    if (v === normalizeCampaignCode(c.code)) continue;
    if (!out.includes(v)) out.push(v);
  }
  if (out.length > CAMPAIGN_ALIAS_LIMIT) throw new PromoError(`별칭은 ${CAMPAIGN_ALIAS_LIMIT}개까지 등록할 수 있습니다.`);
  for (const v of out) {
    const others = await prisma.campaign.findMany({ where: { merchantId, id: { not: campaignId } }, select: { code: true, aliases: true } });
    if (others.some((o) => normalizeCampaignCode(o.code) === v || o.aliases.some((a) => normalizeCampaignCode(a) === v))) {
      throw new PromoError(`별칭 "${v}" 는 다른 캠페인의 키워드·별칭과 겹칩니다.`);
    }
    const promo = await prisma.campaignPromo.findFirst({ where: { merchantId, keyword: v }, select: { id: true } });
    if (promo) throw new PromoError(`별칭 "${v}" 는 홍보물 키워드와 겹칩니다.`);
  }
  await prisma.campaign.update({ where: { id: campaignId }, data: { aliases: out } });
  return out;
}

/** 새 캠페인 키워드가 홍보물 키워드와 겹치는지(saveCampaign 이 부른다) */
export async function promoKeywordTaken(merchantId: string, code: string): Promise<boolean> {
  return (await prisma.campaignPromo.count({ where: { merchantId, keyword: code } })) > 0;
}

/**
 * MO 흐름(`mo:{수신 id}`)의 단계 기록에 홍보물 id 를 남긴다(결제 건이 생기기 전 단계 — 미등록 후원자 수신도 홍보물별로 센다).
 * 결제 건이 생기면 이후 단계 기록이 결제 건의 promo_id 로 흐름 전체를 다시 맞춘다(funnel.ts). 예외를 던지지 않는다.
 */
export async function tagMoFlowPromo(moMessageId: string, merchantId: string, body: string, now = new Date()): Promise<void> {
  try {
    const first = (body ?? '').normalize('NFKC').trim().split(/\s+/u)[0] ?? '';
    const token = normalizeCampaignCode(first);
    if (!token || !CAMPAIGN_CODE_RE.test(token)) return;
    const hit = await matchPromoKeyword(merchantId, token, now);
    if (!hit) return;
    await prisma.funnelStep.updateMany({ where: { flowKey: `mo:${moMessageId}` }, data: { promoId: hit.promo.id, campaignId: hit.campaign.id } });
  } catch {
    // 집계 보조 기록 — 실패해도 문자 처리는 계속한다
  }
}
