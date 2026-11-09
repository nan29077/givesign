import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt } from '@/lib/crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { cardPaymentEnabled, getCardAdapter } from '@/server/adapters/payment/card';
import { executePayment, sendMt, setStatus, type PaymentOutcome } from './charge-flow';
import { cardFeeReady } from './card-fees';
import * as tpl from './mt-templates';
import type { ChargeStatus } from '@/generated/prisma/enums';

/**
 * 카드 일시후원(2026-11-13 5차 L2, `CARD_PAYMENT_ENABLED` 꺼짐 기본).
 *
 * 멱등 4중 방어는 계좌 결제와 같다:
 *  (1) MO 사업자 메시지 ID 중복 차단 · (2) 결제 건 생성 멱등키(기존 경로 그대로)
 *  (3) 결제 건당 결제창 세션 1건(card_checkout_session.charge_id 유니크) + 완료는 PENDING→COMPLETED 조건부 선점
 *  (4) executePayment 의 진행 중 거래 판정(REQUESTED·TIMEOUT·UNKNOWN 이면 다시 승인하지 않고 대사 큐) + 주문번호 유니크
 * 결과 미확인·정산 원장·charge.paid·단계 측정은 executePayment 를 그대로 탄다(카드 승인만 카드 어댑터).
 * 정기후원 카드 빌링은 만들지 않는다 — 카드는 일시후원만.
 */

export class CardPaymentError extends Error {}

export interface CardStartOutcome {
  ok: boolean;
  status: ChargeStatus;
  message: string;
  /** notify:false 일 때만 — 화면이 이 주소로 바로 이동한다 */
  checkoutUrl?: string;
  expiresAt?: Date;
  mock?: boolean;
}

function absolute(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  return `${env.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
}

function maskUrl(url: string): string {
  const cut = url.indexOf('?');
  return cut < 0 ? url : `${url.slice(0, cut)}?[마스킹]`;
}

/** 지금 이 기관에 카드 선택지를 보여도 되는가(스위치 + 카드 수수료 정책) */
export async function cardOptionAvailable(merchantId: string): Promise<boolean> {
  if (!cardPaymentEnabled()) return false;
  return cardFeeReady(merchantId);
}

/**
 * 금액이 확정된(RECEIVED) 결제 건의 카드 결제창을 연다. 출금은 일어나지 않는다.
 * notify=true 면 결제창 주소를 문자로 보낸다(웹 후원 — 번호 주인만 결제창을 연다).
 */
export async function startCardCheckout(chargeId: string, options: { notify?: boolean } = {}): Promise<CardStartOutcome> {
  const notify = options.notify !== false;
  if (!cardPaymentEnabled()) return { ok: false, status: 'RECEIVED', message: '카드 결제를 사용할 수 없습니다.' };
  const charge = await prisma.charge.findUnique({ where: { id: chargeId }, include: { merchant: true, payer: true } });
  if (!charge || !charge.payer) return { ok: false, status: 'PAYMENT_FAILED', message: '결제 거래를 찾을 수 없습니다.' };
  if (charge.paymentMethod !== 'CARD') return { ok: false, status: charge.status, message: '카드 결제로 고른 후원이 아닙니다.' };
  if (charge.channel === 'RECURRING') return { ok: false, status: charge.status, message: '카드는 일시후원만 받습니다.' };

  const existing = await prisma.cardCheckoutSession.findUnique({ where: { chargeId } });
  if (existing) {
    return {
      ok: existing.status === 'PENDING' && existing.expiresAt.getTime() > Date.now(),
      status: charge.status,
      message: existing.status === 'PENDING' ? '이미 열린 카드 결제창이 있습니다.' : '이미 처리된 결제입니다.',
      expiresAt: existing.expiresAt,
      mock: existing.mock,
    };
  }
  if (charge.status !== 'RECEIVED') return { ok: false, status: charge.status, message: '결제를 시작할 수 없는 상태입니다.' };

  await setStatus(chargeId, 'PENDING_PIN', '카드 결제창 인증 대기'); // 단계 측정: 인증 시작(AUTH_STARTED)
  const adapter = getCardAdapter();
  let created: Awaited<ReturnType<typeof adapter.createCheckout>>;
  try {
    created = await adapter.createCheckout({ chargeId, amount: charge.amount, productName: `${charge.merchant.displayName} 후원` });
  } catch (e) {
    created = { ok: false, code: 'ERROR', message: (e as Error).message };
  }
  if (!created.ok || !created.data) {
    const reason = created.message ?? '카드 결제창을 만들지 못했습니다.';
    await setStatus(chargeId, 'PAYMENT_FAILED', `카드 결제창 생성 실패: ${reason}`);
    return { ok: false, status: 'PAYMENT_FAILED', message: `${reason} 결제는 진행되지 않았습니다.` };
  }

  const url = absolute(created.data.checkoutUrl);
  try {
    await prisma.cardCheckoutSession.create({
      data: {
        id: newId(),
        chargeId,
        provider: adapter.info().provider,
        sessionId: created.data.sessionId,
        amount: charge.amount,
        mock: created.data.mock,
        checkoutUrlMasked: maskUrl(url),
        expiresAt: created.data.expiresAt,
      },
    });
  } catch (error) {
    const now = await prisma.cardCheckoutSession.findUnique({ where: { chargeId } }).catch(() => null);
    if (!now && (error as { code?: string }).code !== 'P2002') {
      await setStatus(chargeId, 'PAYMENT_FAILED', '카드 결제창 세션 저장 실패(출금 없음)').catch(() => undefined);
      return { ok: false, status: 'PAYMENT_FAILED', message: '카드 결제를 준비하지 못했습니다. 결제는 진행되지 않았습니다.' };
    }
    return { ok: Boolean(now), status: 'PENDING_PIN', message: '이미 열린 카드 결제창이 있습니다.', expiresAt: now?.expiresAt, mock: now?.mock };
  }

  if (notify) {
    const ttlMin = Math.max(1, Math.floor((created.data.expiresAt.getTime() - Date.now()) / 60_000));
    const sent = await sendMt({
      phone: decrypt(charge.payer.phoneEnc),
      template: tpl.tplCardPaymentLink({ merchantName: charge.merchant.displayName, amount: charge.amount, link: url, ttlMin, mock: created.data.mock }),
      chargeId,
      merchantId: charge.merchantId,
    });
    if (!sent) {
      await prisma.cardCheckoutSession.updateMany({ where: { chargeId, status: 'PENDING' }, data: { status: 'FAILED', resultNote: '결제창 안내 문자 발송 실패' } });
      await setStatus(chargeId, 'PAYMENT_FAILED', '카드 결제창 안내 문자 발송 실패(출금 없음)');
      return { ok: false, status: 'PAYMENT_FAILED', message: '카드 결제 안내 문자를 보내지 못했습니다.' };
    }
  }
  if (created.data.mock) logger.warn('[MOCK] 카드 결제창 — 실제 카드사 연동이 아닙니다.', { chargeId });
  return {
    ok: true,
    status: 'PENDING_PIN',
    message: created.data.mock ? '[MOCK] 카드 결제창을 열었습니다. 실제 승인은 일어나지 않습니다.' : '카드 결제창을 열었습니다.',
    checkoutUrl: notify ? undefined : url,
    expiresAt: created.data.expiresAt,
    mock: created.data.mock,
  };
}

export type CardCompleteCode = 'OK' | 'DUPLICATE' | 'NOT_FOUND' | 'EXPIRED' | 'INVALID_STATE' | 'CANCELED' | 'PAYMENT_FAILED';

export interface CardCompleteResult {
  ok: boolean;
  code: CardCompleteCode;
  chargeId?: string;
  status?: ChargeStatus;
  message: string;
}

/**
 * 결제창 인증 완료 → 승인. 같은 세션으로 여러 번 들어와도(새로고침·공급자 재통지) 승인은 한 번이다.
 * `cancel` 이면 후원자가 결제창에서 취소한 것 — 출금 없는 실패로 닫는다.
 */
export async function completeCardCheckout(input: { sessionId: string; authToken?: string | null; cancel?: boolean }): Promise<CardCompleteResult> {
  const session = await prisma.cardCheckoutSession.findUnique({ where: { sessionId: input.sessionId } });
  if (!session) return { ok: false, code: 'NOT_FOUND', message: '카드 결제 세션을 찾을 수 없습니다.' };
  const charge = await prisma.charge.findUnique({ where: { id: session.chargeId }, select: { id: true, status: true } });
  if (!charge) return { ok: false, code: 'NOT_FOUND', message: '결제 거래를 찾을 수 없습니다.' };
  const touch = () =>
    prisma.cardCheckoutSession.update({ where: { id: session.id }, data: { callbackCount: { increment: 1 } } }).catch(() => undefined);

  if (session.status !== 'PENDING') {
    await touch();
    if (session.status === 'COMPLETED') return { ok: true, code: 'DUPLICATE', chargeId: charge.id, status: charge.status, message: '이미 처리된 결제입니다. 결제는 한 번만 이루어집니다.' };
    return { ok: false, code: session.status === 'EXPIRED' ? 'EXPIRED' : 'INVALID_STATE', chargeId: charge.id, status: charge.status, message: '진행할 수 없는 결제창입니다. 결제는 진행되지 않았습니다.' };
  }
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.cardCheckoutSession.updateMany({ where: { id: session.id, status: 'PENDING' }, data: { status: 'EXPIRED', resultNote: '유효시간 경과 후 완료 시도' } });
    if (charge.status === 'PENDING_PIN') await setStatus(charge.id, 'PAYMENT_FAILED', '카드 결제창 시간 초과로 자동 취소');
    return { ok: false, code: 'EXPIRED', chargeId: charge.id, status: 'PAYMENT_FAILED', message: '결제 시간이 지나 취소되었습니다. 결제는 진행되지 않았습니다.' };
  }
  if (charge.status !== 'PENDING_PIN') {
    await touch();
    return { ok: false, code: 'INVALID_STATE', chargeId: charge.id, status: charge.status, message: '결제를 진행할 수 없는 상태입니다.' };
  }
  if (input.cancel) {
    const c = await prisma.cardCheckoutSession.updateMany({ where: { id: session.id, status: 'PENDING' }, data: { status: 'FAILED', resultNote: '후원자가 결제창에서 취소' } });
    if (c.count === 1) await setStatus(charge.id, 'PAYMENT_FAILED', '후원자가 카드 결제창에서 취소(출금 없음)');
    return { ok: false, code: 'CANCELED', chargeId: charge.id, status: 'PAYMENT_FAILED', message: '카드 결제를 취소했습니다. 결제는 진행되지 않았습니다.' };
  }

  const claimed = await prisma.cardCheckoutSession.updateMany({
    where: { id: session.id, status: 'PENDING' },
    data: { status: 'COMPLETED', completedAt: new Date(), callbackCount: { increment: 1 } },
  });
  if (claimed.count !== 1) return { ok: true, code: 'DUPLICATE', chargeId: charge.id, status: charge.status, message: '이미 처리된 결제입니다. 결제는 한 번만 이루어집니다.' };

  let paid: PaymentOutcome;
  try {
    paid = await executePayment(charge.id, { card: { adapter: getCardAdapter(), authToken: input.authToken ?? session.sessionId } });
  } catch (e) {
    // 승인 단계 이후 예외는 결과 미확인 경로(정리 배치)가 맡는다. 승인 전(거래 없음)이면 출금 없는 실패.
    logger.error('카드 승인 처리 중 예외', { chargeId: charge.id, message: (e as Error).message });
    const after = await prisma.charge.findUnique({ where: { id: charge.id }, select: { status: true } }).catch(() => null);
    return { ok: false, code: 'PAYMENT_FAILED', chargeId: charge.id, status: after?.status ?? 'PENDING_PIN', message: '결제 결과를 확인하는 중입니다.' };
  }
  return { ok: paid.ok, code: paid.ok ? 'OK' : 'PAYMENT_FAILED', chargeId: charge.id, status: paid.status, message: paid.message };
}

/** 정리 배치: 유효시간이 지난 PENDING 결제창을 닫고, 아직 인증 대기인 결제 건은 출금 없는 실패로 닫는다. */
export async function expireStaleCardSessions(now = new Date()): Promise<number> {
  const stale = await prisma.cardCheckoutSession.findMany({ where: { status: 'PENDING', expiresAt: { lt: now } }, select: { id: true, chargeId: true }, take: 200 });
  let n = 0;
  for (const s of stale) {
    const r = await prisma.cardCheckoutSession.updateMany({ where: { id: s.id, status: 'PENDING' }, data: { status: 'EXPIRED', resultNote: '유효시간 경과' } });
    if (r.count !== 1) continue;
    const c = await prisma.charge.findUnique({ where: { id: s.chargeId }, select: { status: true, transactions: { select: { id: true }, take: 1 } } });
    if (c?.status === 'PENDING_PIN' && c.transactions.length === 0) await setStatus(s.chargeId, 'PAYMENT_FAILED', '카드 결제창 시간 초과로 자동 취소(출금 없음)').catch(() => undefined);
    n += 1;
  }
  return n;
}
