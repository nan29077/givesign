import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { generateToken, tokenHash } from '@/lib/crypto';
import { env } from '@/lib/env';
import { addSeconds } from '@/lib/datetime';
import type { SecureLinkPurpose } from '@/generated/prisma/enums';

/**
 * MT 로 발송되는 1회용 보안 링크.
 *  - 토큰 원문은 DB 에 저장하지 않는다(HMAC 해시만 저장)
 *  - 짧은 만료시간, 1회 사용
 *  - 사용 시 IP/UA 를 기록한다
 */

export const LINK_TTL_SEC: Record<SecureLinkPurpose, number> = {
  REGISTER_ACCOUNT: 30 * 60,
  // 헥토 공식 제약(결제인증 후 10분)보다 짧게 운용
  CONFIRM_PAYMENT: env.payment.confirmTtlSec,
  MANAGE_DONOR: 10 * 60,
  // 금액을 고르고 PIN 까지 한 화면에서 끝내야 하므로 결제 확인 링크보다 넉넉하게 잡는다.
  SELECT_AMOUNT: env.payment.selectTtlSec,
};

export interface IssuedLink {
  id: string;
  token: string;
  url: string;
  expiresAt: Date;
}

export async function issueSecureLink(input: {
  purpose: SecureLinkPurpose;
  phoneHash: string;
  merchantId?: string | null;
  chargeId?: string | null;
  payload?: Record<string, unknown>;
  ttlSec?: number;
}): Promise<IssuedLink> {
  const token = generateToken(32);
  const ttl = input.ttlSec ?? LINK_TTL_SEC[input.purpose];
  const expiresAt = addSeconds(new Date(), ttl);

  const row = await prisma.secureLink.create({
    data: {
      id: newId(),
      tokenHash: tokenHash(token),
      purpose: input.purpose,
      phoneHash: input.phoneHash,
      merchantId: input.merchantId ?? null,
      chargeId: input.chargeId ?? null,
      payload: (input.payload ?? {}) as object,
      expiresAt,
    },
  });

  return {
    id: row.id,
    token,
    url: `${env.baseUrl}/r/${token}`,
    expiresAt,
  };
}

export type LinkCheck =
  | { ok: true; link: Awaited<ReturnType<typeof prisma.secureLink.findFirst>> }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'USED' };

export async function resolveSecureLink(token: string): Promise<LinkCheck> {
  const link = await prisma.secureLink.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!link) return { ok: false, reason: 'NOT_FOUND' };
  if (link.usedAt) return { ok: false, reason: 'USED' };
  if (link.expiresAt < new Date()) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, link };
}

export async function consumeSecureLink(id: string, ip?: string, userAgent?: string) {
  // 1회 사용 보장: usedAt 이 아직 null 인 경우에만 갱신
  const r = await prisma.secureLink.updateMany({
    where: { id, usedAt: null },
    data: { usedAt: new Date(), usedIp: ip ?? null, usedAgent: userAgent ?? null },
  });
  return r.count === 1;
}
