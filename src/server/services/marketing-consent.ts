import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { registerConsumer, type StoredDomainEvent } from './events';

/**
 * (선택) 기관 소식·후원 안내 수신 동의 — 2026-11-09 1차 과제 A2.
 *
 *  - 대표 결정: **아직 이 동의로 아무것도 보내지 않는다.** 저장·철회·표시만 한다(동의자만 먼저 쌓는다).
 *  - 단위는 (후원자, 기관). 상태는 payer_merchant_link 의 marketing_consent_at / _withdrawn_at / _source,
 *    이력은 marketing_consent_log(바꾸지 않고 쌓기만, 화면에 보인 문구와 판을 함께 남긴다).
 *  - 월간 후원 안내 수신 거부(notice_opt_out_at)와 다른 동의다. 서로 바꾸지 않는다.
 *  - 기브싸인 전체의 마케팅 수신 동의(consent_record type=MARKETING, /my/consents)와도 다르다.
 *  - 체크하지 않으면 아무것도 바꾸지 않는다(기존 동의를 철회하지 않는다). 철회는 마이페이지에서만 한다.
 *  - 웹 후원은 번호 본인 확인 전이라 체크를 결제 건에 의사(marketing_consent_intent)로만 남기고,
 *    결제가 성공(charge.paid)하면 소비자가 동의로 반영한다(남의 번호로 동의를 만들 수 없게).
 */

export const MARKETING_CONSENT_SOURCES = ['DONATE', 'SIGNUP', 'VOLUNTEER', 'MY'] as const;
export type MarketingConsentSource = (typeof MARKETING_CONSENT_SOURCES)[number];

export const MARKETING_SOURCE_LABEL: Record<MarketingConsentSource, string> = {
  DONATE: '후원할 때',
  SIGNUP: '후원 회원 가입',
  VOLUNTEER: '봉사 신청',
  MY: '마이페이지',
};

/** 화면 문구 판. 문구를 바꾸면 올린다(이력에 남는다). */
export const MARKETING_WORDING_VERSION = '2026-11-09';

/** 동의 문구(필수 동의와 떨어진 곳에, 기본 체크 해제로 보여 준다). tail 은 그 화면의 할 일(후원·신청·가입). */
export function marketingConsentWording(merchantName: string, tail = '후원할 수 있습니다'): string {
  return `(선택) ${merchantName}의 소식과 후원 안내를 문자·알림톡으로 받겠습니다. 동의하지 않아도 ${tail}.`;
}

export function isMarketingConsented(link: { marketingConsentAt: Date | null; marketingConsentWithdrawnAt: Date | null } | null | undefined): boolean {
  return Boolean(link?.marketingConsentAt && !link.marketingConsentWithdrawnAt);
}

/** 폼 값 → 체크 여부. 체크박스가 없거나 꺼져 있으면 false(= 아무것도 바꾸지 않음). */
export function marketingChecked(v: FormDataEntryValue | null | undefined): boolean {
  return v === 'on' || v === '1' || v === 'true';
}

export interface SetMarketingConsentInput {
  payerId: string;
  merchantId: string;
  agree: boolean;
  source: MarketingConsentSource;
  ip?: string | null;
  userAgent?: string | null;
  /** 이력에 남길 문구의 끝말(화면과 같게) */
  wordingTail?: string;
  now?: Date;
}

function isUniqueViolation(e: unknown) {
  return (e as { code?: string })?.code === 'P2002';
}

/**
 * 동의·철회. 이미 그 상태면 아무것도 바꾸지 않는다(이력도 쌓지 않음).
 * 같은 (후원자, 기관) 행을 FOR UPDATE 로 잡고 바꾸므로 동시 요청이 겹쳐도 이력이 한 번만 쌓인다.
 */
export async function setMarketingConsent(input: SetMarketingConsentInput): Promise<{ changed: boolean; agreed: boolean }> {
  if (!MARKETING_CONSENT_SOURCES.includes(input.source)) throw new Error('알 수 없는 동의 경로입니다.');
  const merchant = await prisma.merchantProfile.findUnique({ where: { id: input.merchantId }, select: { displayName: true } });
  if (!merchant) throw new Error('기관을 찾을 수 없습니다.');
  const payer = await prisma.payerProfile.findUnique({ where: { id: input.payerId }, select: { id: true } });
  if (!payer) throw new Error('후원자 정보를 찾을 수 없습니다.');
  const now = input.now ?? new Date();

  // 연결 행이 없으면 만든다(동시 생성은 유니크 인덱스가 막고, 진 쪽은 있는 행을 쓴다).
  const where = { payerId_merchantId: { payerId: input.payerId, merchantId: input.merchantId } };
  try {
    await prisma.payerMerchantLink.upsert({ where, create: { id: newId(), payerId: input.payerId, merchantId: input.merchantId }, update: {} });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }

  return prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM payer_merchant_link WHERE payer_id = ${input.payerId} AND merchant_id = ${input.merchantId} FOR UPDATE`;
    if (!locked) throw new Error('후원자·기관 연결을 찾을 수 없습니다.');
    const link = await tx.payerMerchantLink.findUniqueOrThrow({
      where: { id: locked.id },
      select: { id: true, marketingConsentAt: true, marketingConsentWithdrawnAt: true },
    });
    const current = isMarketingConsented(link);
    if (current === input.agree) return { changed: false, agreed: current };
    await tx.payerMerchantLink.update({
      where: { id: link.id },
      data: input.agree
        ? { marketingConsentAt: now, marketingConsentWithdrawnAt: null, marketingConsentSource: input.source }
        : { marketingConsentWithdrawnAt: now },
    });
    await tx.marketingConsentLog.create({
      data: {
        id: newId(),
        linkId: link.id,
        payerId: input.payerId,
        merchantId: input.merchantId,
        agreed: input.agree,
        source: input.source,
        wordingVersion: MARKETING_WORDING_VERSION,
        wording: input.agree ? marketingConsentWording(merchant.displayName, input.wordingTail) : `${merchant.displayName} 소식·후원 안내 수신 동의 철회`,
        ip: input.ip?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        createdAt: now,
      },
    });
    return { changed: true, agreed: input.agree };
  });
}

/** 체크했을 때만 동의로 기록한다. 체크하지 않았으면 아무것도 하지 않는다(기존 동의 유지). 실패가 본래 일을 막지 않는다. */
export async function recordMarketingConsentIfChecked(checked: boolean, input: Omit<SetMarketingConsentInput, 'agree'>): Promise<void> {
  if (!checked) return;
  await setMarketingConsent({ ...input, agree: true }).catch((e) =>
    logger.error('(선택) 소식 수신 동의 기록 실패', { merchantId: input.merchantId, source: input.source, message: (e as Error).message }),
  );
}

/** 후원 화면에서 체크 → 결제 건에 의사만 남긴다(결제 성공 시 반영). 체크하지 않았으면 아무것도 하지 않는다. */
export async function recordMarketingIntent(
  checked: boolean,
  input: { chargeId: string; source?: MarketingConsentSource; ip?: string | null; userAgent?: string | null },
): Promise<void> {
  if (!checked) return;
  try {
    const charge = await prisma.charge.findUnique({ where: { id: input.chargeId }, select: { payerId: true, merchantId: true } });
    if (!charge?.payerId) return;
    await prisma.marketingConsentIntent.upsert({
      where: { chargeId: input.chargeId },
      create: {
        chargeId: input.chargeId,
        payerId: charge.payerId,
        merchantId: charge.merchantId,
        source: input.source ?? 'DONATE',
        ip: input.ip?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
      },
      update: {},
    });
  } catch (e) {
    logger.error('(선택) 소식 수신 동의 의사 기록 실패', { chargeId: input.chargeId, message: (e as Error).message });
  }
}

/** 소비자: 결제 성공 → 그 결제 건에 남긴 동의 의사를 반영(1회). */
export async function applyMarketingIntentForCharge(ev: StoredDomainEvent) {
  const intent = await prisma.marketingConsentIntent.findUnique({ where: { chargeId: ev.subjectId } });
  if (!intent || intent.appliedAt) return 'SKIPPED' as const;
  const source = (MARKETING_CONSENT_SOURCES as readonly string[]).includes(intent.source) ? (intent.source as MarketingConsentSource) : 'DONATE';
  await setMarketingConsent({ payerId: intent.payerId, merchantId: intent.merchantId, agree: true, source, ip: intent.ip, userAgent: intent.userAgent });
  await prisma.marketingConsentIntent.updateMany({ where: { chargeId: intent.chargeId, appliedAt: null }, data: { appliedAt: new Date() } });
}

let registered = false;
export function registerMarketingConsentConsumer() {
  if (registered) return;
  registered = true;
  registerConsumer({ name: 'marketing-consent', types: ['charge.paid'], handle: applyMarketingIntentForCharge });
}

/** 기관 콘솔: 이 기관 소식 수신 동의 중인 후원자 id */
export async function marketingConsentPayerIds(merchantId: string): Promise<Set<string>> {
  const rows = await prisma.payerMerchantLink.findMany({
    where: { merchantId, marketingConsentAt: { not: null }, marketingConsentWithdrawnAt: null },
    select: { payerId: true },
  });
  return new Set(rows.map((r) => r.payerId));
}

/** 후원자 화면: 기관별 동의 상태 */
export async function marketingConsentsForPayer(payerId: string) {
  const rows = await prisma.payerMerchantLink.findMany({
    where: { payerId },
    select: {
      merchantId: true,
      marketingConsentAt: true,
      marketingConsentWithdrawnAt: true,
      marketingConsentSource: true,
      merchant: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({
    merchantId: r.merchantId,
    merchantName: r.merchant.displayName,
    agreed: isMarketingConsented(r),
    since: isMarketingConsented(r) ? r.marketingConsentAt : null,
    source: r.marketingConsentSource,
  }));
}

/**
 * 기관 후원 회원(DonorMember)의 가입 때 체크값을 후원자 동의로 옮긴다.
 * 회원은 휴대폰 인증 전에는 후원자와 이어지지 않으므로, 인증으로 번호가 확인되고 그 번호의 후원자가 있을 때만 반영한다.
 * (회원 행의 marketingAgreed 는 이어지기 전의 자리표시 — 회원 화면 토글이 둘을 함께 바꾼다)
 */
export async function syncDonorMemberMarketing(memberId: string, meta?: { ip?: string | null; userAgent?: string | null }) {
  const m = await prisma.donorMember.findUnique({ where: { id: memberId }, select: { merchantId: true, phoneHash: true, phoneVerifiedAt: true, marketingAgreed: true } });
  if (!m?.marketingAgreed || !m.phoneHash || !m.phoneVerifiedAt) return;
  const payer = await prisma.payerProfile.findUnique({ where: { phoneHash: m.phoneHash }, select: { id: true } });
  if (!payer) return;
  // 이미 철회한 적이 있으면(본인이 마이페이지에서 끈 것) 가입 때 체크로 되살리지 않는다.
  const link = await prisma.payerMerchantLink.findUnique({
    where: { payerId_merchantId: { payerId: payer.id, merchantId: m.merchantId } },
    select: { marketingConsentWithdrawnAt: true },
  });
  if (link?.marketingConsentWithdrawnAt) return;
  await recordMarketingConsentIfChecked(true, { payerId: payer.id, merchantId: m.merchantId, source: 'SIGNUP', wordingTail: '가입할 수 있습니다', ...meta });
}

/** 기관 후원 회원 화면용: 동의 상태(후원자와 이어졌으면 후원자 동의, 아니면 회원 행의 값) */
export async function donorMemberMarketingState(memberId: string): Promise<{ agreed: boolean; linkedPayerId: string | null }> {
  const m = await prisma.donorMember.findUnique({ where: { id: memberId }, select: { merchantId: true, phoneHash: true, phoneVerifiedAt: true, marketingAgreed: true } });
  if (!m) return { agreed: false, linkedPayerId: null };
  const payer = m.phoneHash && m.phoneVerifiedAt ? await prisma.payerProfile.findUnique({ where: { phoneHash: m.phoneHash }, select: { id: true } }) : null;
  if (!payer) return { agreed: m.marketingAgreed, linkedPayerId: null };
  const link = await prisma.payerMerchantLink.findUnique({
    where: { payerId_merchantId: { payerId: payer.id, merchantId: m.merchantId } },
    select: { marketingConsentAt: true, marketingConsentWithdrawnAt: true },
  });
  return { agreed: isMarketingConsented(link), linkedPayerId: payer.id };
}

/** 기관 후원 회원 화면 토글 */
export async function setDonorMemberMarketing(memberId: string, agree: boolean, meta?: { ip?: string | null; userAgent?: string | null }) {
  const m = await prisma.donorMember.findUnique({ where: { id: memberId }, select: { id: true, merchantId: true, status: true } });
  if (!m || m.status !== 'ACTIVE') throw new Error('회원 정보를 찾을 수 없습니다.');
  await prisma.donorMember.update({ where: { id: m.id }, data: { marketingAgreed: agree } });
  const state = await donorMemberMarketingState(m.id);
  if (state.linkedPayerId) {
    await setMarketingConsent({ payerId: state.linkedPayerId, merchantId: m.merchantId, agree, source: 'MY', ...meta });
  }
  return agree;
}
