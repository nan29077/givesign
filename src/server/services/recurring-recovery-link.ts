import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { generateToken, tokenHash } from '@/lib/crypto';
import { env } from '@/lib/env';

/**
 * 정기후원 실패 안내 문자에 넣는 후원자 개인 복구 링크 (/r/recover/[토큰]) — 2026-11-09.
 *
 *  - 토큰 원문은 저장하지 않는다(HMAC 해시만, secure-link.ts 와 같은 tokenHash).
 *  - 유효 기간(RECOVERY_LINK_TTL_DAYS) 안에서는 여러 번 열 수 있다. 조치 필요 기한(최대 14일)을 덮는다.
 *  - 같은 약정에 새 링크를 만들면 이전 링크는 무효(revoked_at). 한 약정에 살아 있는 링크는 하나다.
 *  - 링크는 그 약정 1건(그 후원자 본인)만 다룬다. 다른 약정·다른 후원자로 넘어갈 수 없다.
 *
 * recurring.ts 가 import 하므로 이 파일은 recurring.ts 를 import 하지 않는다(순환 방지).
 */

export const RECOVERY_LINK_TTL_DAYS = 15;

export async function issueRecoveryLink(recurringId: string, payerId: string, now = new Date()) {
  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + RECOVERY_LINK_TTL_DAYS * 86_400_000);
  await prisma.$transaction([
    prisma.recurringRecoveryLink.updateMany({ where: { recurringId, revokedAt: null }, data: { revokedAt: now } }),
    prisma.recurringRecoveryLink.create({
      data: { id: newId(), recurringId, payerId, tokenHash: tokenHash(token), expiresAt },
    }),
  ]);
  return { token, url: `${env.baseUrl}/r/recover/${token}`, expiresAt };
}

export type RecoveryLinkCheck =
  | { ok: true; link: { id: string; recurringId: string; payerId: string; expiresAt: Date } }
  | { ok: false; reason: 'NOT_FOUND' | 'EXPIRED' | 'REVOKED' };

export async function resolveRecoveryLink(token: string, now = new Date()): Promise<RecoveryLinkCheck> {
  if (!token || token.length > 200) return { ok: false, reason: 'NOT_FOUND' };
  const link = await prisma.recurringRecoveryLink.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!link) return { ok: false, reason: 'NOT_FOUND' };
  if (link.revokedAt) return { ok: false, reason: 'REVOKED' };
  if (link.expiresAt <= now) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, link: { id: link.id, recurringId: link.recurringId, payerId: link.payerId, expiresAt: link.expiresAt } };
}
