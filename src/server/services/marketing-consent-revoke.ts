import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { MARKETING_WORDING_VERSION } from './marketing-consent';

/**
 * (선택) 소식 수신 동의 일괄 철회 (2026-11-13 5차 L4).
 *
 *  - WITHDRAW : 후원자 탈퇴 — 그 후원자의 모든 기관 동의를 철회한다(탈퇴 트랜잭션 안에서).
 *  - OPT_OUT  : 관계 안내 문자의 무료 수신 거부 링크 — 그 기관 동의만 철회한다.
 * 이미 철회됐거나 동의가 없는 행은 건드리지 않는다(이력도 쌓지 않음). 이력 문구는 1차 동의 이력과 같은 표(marketing_consent_log).
 */

type Tx = Prisma.TransactionClient;

export async function revokeMarketingConsents(
  tx: Tx | typeof prisma,
  input: { payerId: string; merchantId?: string; source: 'WITHDRAW' | 'OPT_OUT'; ip?: string | null; userAgent?: string | null; now?: Date },
): Promise<number> {
  const now = input.now ?? new Date();
  const links = await tx.payerMerchantLink.findMany({
    where: { payerId: input.payerId, ...(input.merchantId ? { merchantId: input.merchantId } : {}), marketingConsentAt: { not: null }, marketingConsentWithdrawnAt: null },
    select: { id: true, merchantId: true, merchant: { select: { displayName: true } } },
  });
  let n = 0;
  for (const l of links) {
    const r = await tx.payerMerchantLink.updateMany({ where: { id: l.id, marketingConsentWithdrawnAt: null }, data: { marketingConsentWithdrawnAt: now } });
    if (r.count !== 1) continue;
    await tx.marketingConsentLog.create({
      data: {
        id: newId(),
        linkId: l.id,
        payerId: input.payerId,
        merchantId: l.merchantId,
        agreed: false,
        source: input.source,
        wordingVersion: MARKETING_WORDING_VERSION,
        wording: `${l.merchant.displayName} 소식·후원 안내 수신 동의 철회(${input.source === 'WITHDRAW' ? '회원 탈퇴' : '문자 수신 거부'})`,
        ip: input.ip?.slice(0, 64) ?? null,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        createdAt: now,
      },
    });
    n += 1;
  }
  return n;
}
