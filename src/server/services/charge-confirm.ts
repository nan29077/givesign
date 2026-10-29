import { prisma } from '@/server/db';
import { resolveSecureLink, consumeSecureLink } from './secure-link';
import { tokenHash } from '@/lib/crypto';
import { executePayment, setStatus } from './charge-flow';

/**
 * **deprecated — 구(舊) CONFIRM_LINK 경로.**
 *
 * 후원자가 MT 로 받은 기브싸인 자체 확인 링크에서 버튼을 누르면 빌키로 곧바로 승인한다.
 * 현재 기본 경로는 결제사 PIN 인증(`pin-authorization.ts`)이며, 이 경로는
 * `ALLOW_LEGACY_CONFIRM_LINK=true` 일 때만 새 링크가 발급된다
 * (발급 지점: charge-flow.ts 의 resolveConfirmChannel).
 *
 * 링크 해석·확인 함수 자체는 계속 동작한다. 플래그를 끄는 순간 이미 발송된 링크까지
 * 막아 버리면, 문자를 받아 둔 후원자의 대기 건이 갈 곳 없이 멈추기 때문이다.
 * (미확인 건은 기존대로 expireStaleConfirmations 로 자동 취소된다)
 *
 * PIN 인증 흐름이 안정화되면 이 파일과 /r/[token] 확인 화면을 함께 제거한다.
 */

export interface ConfirmContext {
  linkId: string;
  chargeId: string;
  payerId: string | null;
  merchantName: string;
  amount: bigint;
  message: string;
  expiresAt: Date;
  /** 후원자가 기존에 저장한 닉네임 (없으면 null) */
  payerNickname: string | null;
  /** 후원자가 기존에 저장한 SNS 플랫폼 (없으면 null) */
  payerSnsPlatform: string | null;
}

export async function loadConfirmContext(
  token: string,
): Promise<{ ok: true; ctx: ConfirmContext } | { ok: false; reason: string }> {
  const res = await resolveSecureLink(token);
  if (!res.ok) {
    // 만료된 링크를 열면 그 자리에서 확인 대기 건을 취소한다(배치가 돌기 전에도 화면 안내와 실제 상태가 맞도록).
    if (res.reason === 'EXPIRED') await expireConfirmationByToken(token);
    const reason =
      res.reason === 'EXPIRED'
        ? '확인 시간이 지나 결제가 자동 취소되었습니다. 결제는 진행되지 않았습니다.'
        : res.reason === 'USED'
          ? '이미 처리된 요청입니다.'
          : '유효하지 않은 링크입니다.';
    return { ok: false, reason };
  }
  const link = res.link!;
  if (link.purpose !== 'CONFIRM_PAYMENT' || !link.chargeId) {
    return { ok: false, reason: '용도가 다른 링크입니다.' };
  }

  const charge = await prisma.charge.findUnique({
    where: { id: link.chargeId },
    include: {
      merchant: true,
      payer: { select: { id: true, displayName: true, snsPlatform: true } },
    },
  });
  if (!charge) return { ok: false, reason: '결제 거래를 찾을 수 없습니다.' };
  if (charge.status !== 'PENDING_CONFIRM') {
    return { ok: false, reason: '이미 처리된 결제입니다.' };
  }

  return {
    ok: true,
    ctx: {
      linkId: link.id,
      chargeId: charge.id,
      payerId: charge.payerId ?? null,
      merchantName: charge.merchant.displayName,
      amount: charge.amount,
      message: charge.message,
      expiresAt: link.expiresAt,
      payerNickname: charge.payer?.displayName ?? null,
      payerSnsPlatform: charge.payer?.snsPlatform ?? null,
    },
  };
}

export async function confirmCharge(token: string, ip?: string, userAgent?: string) {
  const loaded = await loadConfirmContext(token);
  if (!loaded.ok) throw new Error(loaded.reason);

  // 링크 1회 사용 선점 (중복 클릭으로 인한 이중 결제 방지)
  const consumed = await consumeSecureLink(loaded.ctx.linkId, ip, userAgent);
  if (!consumed) throw new Error('이미 처리된 요청입니다.');

  return executePayment(loaded.ctx.chargeId);
}

/** 만료된 확인 링크 한 건에 연결된 확인 대기 결제를 취소한다. */
async function expireConfirmationByToken(token: string) {
  const link = await prisma.secureLink.findUnique({
    where: { tokenHash: tokenHash(token) },
    select: { purpose: true, chargeId: true },
  });
  if (!link || link.purpose !== 'CONFIRM_PAYMENT' || !link.chargeId) return;
  const d = await prisma.charge.findUnique({ where: { id: link.chargeId }, select: { status: true } });
  if (d?.status !== 'PENDING_CONFIRM') return;
  await setStatus(link.chargeId, 'PAYMENT_FAILED', '확인 시간 초과로 자동 취소');
}

/**
 * 만료된 금액선택 대기 건 정리 (배치)
 *
 * SELECT_AMOUNT 링크가 만료되면 화면은 "결제는 진행되지 않았습니다" 라고 확정적으로 말하는데,
 * 결제 건은 PENDING_AMOUNT(금액 0원)로 영원히 남아 있었다. 구 확인링크 경로는 같은 상황에서
 * 그 자리에서 PAYMENT_FAILED 로 확정한다 — 두 경로가 같은 사건을 다르게 해석하면 안 된다.
 */
export async function expireStaleAmountSelections(now = new Date()) {
  const stale = await prisma.secureLink.findMany({
    where: { purpose: 'SELECT_AMOUNT', usedAt: null, expiresAt: { lt: now }, chargeId: { not: null } },
    select: { chargeId: true },
    take: 500,
  });
  let count = 0;
  for (const s of stale) {
    if (!s.chargeId) continue;
    const d = await prisma.charge.findUnique({ where: { id: s.chargeId }, select: { status: true } });
    if (d?.status !== 'PENDING_AMOUNT') continue;
    // setStatus 를 거쳐야 ChargeStatusLog 감사 이력이 남는다
    await setStatus(s.chargeId, 'PAYMENT_FAILED', '금액 선택 시간 초과로 자동 취소');
    count += 1;
  }
  return count;
}

/** 만료된 확인 대기 건 정리 (배치) */
export async function expireStaleConfirmations(now = new Date()) {
  const stale = await prisma.secureLink.findMany({
    where: { purpose: 'CONFIRM_PAYMENT', usedAt: null, expiresAt: { lt: now }, chargeId: { not: null } },
    select: { chargeId: true },
  });
  let count = 0;
  for (const s of stale) {
    if (!s.chargeId) continue;
    const d = await prisma.charge.findUnique({ where: { id: s.chargeId }, select: { status: true } });
    if (d?.status !== 'PENDING_CONFIRM') continue;
    // setStatus 를 거쳐야 ChargeStatusLog 감사 이력이 남는다
    await setStatus(s.chargeId, 'PAYMENT_FAILED', '확인 시간 초과로 자동 취소');
    count += 1;
  }
  return count;
}
