import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { addDays } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { notifyUser } from '@/server/services/notifications';
import {
  EDOC_MONTHLY_DAYS,
  EDOC_PENDING_MAX,
  EDOC_PLAN_DEFAULT,
  EDOC_TOPUP_MAX,
  EDOC_TOPUP_MIN,
  parseTopupBonus,
  pickUseSource,
  splitVat,
  topupBonusFor,
  type TopupBonusRule,
} from '@/lib/edoc-billing';
import type { Prisma } from '@/generated/prisma/client';
import type { EDocLedgerKind, EDocUseSource } from '@/generated/prisma/enums';

/**
 * 전자문서 이용요금 (충전형 · 30일 정액형).
 *
 * 원칙
 *  - 근거는 원장(edoc_ledger, append-only)이다. 지갑(edoc_wallet)은 현재값 캐시이고, 원장 합계와 항상 같아야 한다.
 *    `verifyWallet` 이 이를 확인한다.
 *  - 차감·환원·승인은 지갑 행을 FOR UPDATE 로 잠근 트랜잭션 안에서만 한다. 원장 멱등키(use:{봉투}, refund:{봉투},
 *    topup:{신청}, …)가 같은 처리가 두 번 기록되는 것을 DB 수준에서 막는다.
 *  - 실결제 연동 전이다. 충전·정액은 기관 신청 → 관리자가 실제 입금·계약을 확인 → 승인 순서이며, 화면에도 그렇게 적는다.
 *  - 이용 잔액은 서비스 이용료다. 후원금·정산과 섞지 않는다.
 *
 * 원장 칸의 뜻
 *  - amount: 충전 잔액(원)의 변화. 정액·시범처럼 건수로 주는 항목은 0.
 *  - units: 건수 변화(시범 제공량·정액 제공량).
 *  - supplyAmount / vatAmount: 이 항목이 나타내는 금액(받은 돈 또는 차감된 이용료)의 공급가액·부가세.
 *    정액 제공(PLAN_GRANT)은 잔액 변화가 0이어도 받은 요금을 여기에 나눠 적는다.
 */

export class EDocBillingError extends Error {}

type Tx = Prisma.TransactionClient;

export interface EDocPlanView {
  id: string | null;
  perDocument: number;
  monthlyPrice: number;
  monthlyQuota: number;
  trialQuota: number;
  lowBalance: number;
  topupBonus: TopupBonusRule[];
  effectiveFrom: Date | null;
}

/** 지금(또는 at) 적용되는 요금제. effectiveFrom 이 지난 것 중 가장 최근 것. */
export async function currentEDocPlan(at = new Date(), db: Tx | typeof prisma = prisma): Promise<EDocPlanView> {
  const row = await db.eDocPlan.findFirst({ where: { effectiveFrom: { lte: at } }, orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }] });
  if (!row) return { id: null, ...EDOC_PLAN_DEFAULT, effectiveFrom: null };
  return {
    id: row.id,
    perDocument: row.perDocument,
    monthlyPrice: row.monthlyPrice,
    monthlyQuota: row.monthlyQuota,
    trialQuota: row.trialQuota,
    lowBalance: row.lowBalance,
    topupBonus: parseTopupBonus(row.topupBonus),
    effectiveFrom: row.effectiveFrom,
  };
}

/** 예약된(아직 시행 전) 요금제 */
export async function upcomingEDocPlans(at = new Date()) {
  return prisma.eDocPlan.findMany({ where: { effectiveFrom: { gt: at } }, orderBy: { effectiveFrom: 'asc' } });
}

export async function createEDocPlan(input: {
  perDocument: number;
  monthlyPrice: number;
  monthlyQuota: number;
  trialQuota: number;
  lowBalance: number;
  topupBonus: TopupBonusRule[];
  effectiveFrom: Date;
  note: string | null;
  actorId: string;
}) {
  if (input.effectiveFrom.getTime() < Date.now() - 60_000) throw new EDocBillingError('시행일은 지금 이후로 정해 주세요. 지난 요금제는 고치지 않고 새 버전으로 바꿉니다.');
  return prisma.eDocPlan.create({
    data: {
      id: newId(),
      perDocument: input.perDocument,
      monthlyPrice: input.monthlyPrice,
      monthlyQuota: input.monthlyQuota,
      trialQuota: input.trialQuota,
      lowBalance: input.lowBalance,
      topupBonus: input.topupBonus as unknown as Prisma.InputJsonValue,
      effectiveFrom: input.effectiveFrom,
      note: input.note,
      createdBy: input.actorId,
    },
  });
}

/** 시행 전 요금제만 취소(삭제)할 수 있다. 이미 시행된 요금제는 이력이다. */
export async function cancelUpcomingEDocPlan(id: string) {
  const row = await prisma.eDocPlan.findUnique({ where: { id } });
  if (!row) throw new EDocBillingError('요금제를 찾을 수 없습니다.');
  if (row.effectiveFrom <= new Date()) throw new EDocBillingError('이미 시행된 요금제는 지울 수 없습니다. 새 요금제를 등록해 주세요.');
  await prisma.eDocPlan.delete({ where: { id } });
  return row;
}

// ---------------------------------------------------------------- 지갑

/**
 * 지갑이 없으면 만들고 시범 제공량을 준다(기관당 1회, 멱등키 trial:{기관}).
 * 트랜잭션 안에서 부르면 같은 트랜잭션에 묶인다.
 */
export async function ensureWallet(merchantId: string, db: Tx | typeof prisma = prisma) {
  const existing = await db.eDocWallet.findUnique({ where: { merchantId } });
  if (existing) return existing;
  const plan = await currentEDocPlan(new Date(), db);
  const inserted = await db.$executeRaw`
    INSERT INTO edoc_wallet (merchant_id, balance, trial_remaining, total_used, created_at, updated_at)
    VALUES (${merchantId}, 0, ${plan.trialQuota}, 0, now(), now())
    ON CONFLICT (merchant_id) DO NOTHING`;
  if (inserted === 1 && plan.trialQuota > 0) {
    await db.$executeRaw`
      INSERT INTO edoc_ledger (id, merchant_id, kind, amount, units, supply_amount, vat_amount, balance_after, trial_after, idempotency_key, memo, created_at)
      VALUES (${newId()}, ${merchantId}, 'TRIAL_GRANT', 0, ${plan.trialQuota}, 0, 0, 0, ${plan.trialQuota}, ${`trial:${merchantId}`}, '신규 기관 시범 제공', now())
      ON CONFLICT (idempotency_key) DO NOTHING`;
  }
  return db.eDocWallet.findUniqueOrThrow({ where: { merchantId } });
}

async function lockWallet(tx: Tx, merchantId: string) {
  await ensureWallet(merchantId, tx);
  const rows = await tx.$queryRaw<Array<{ balance: number; trial_remaining: number }>>`
    SELECT balance, trial_remaining FROM edoc_wallet WHERE merchant_id = ${merchantId} FOR UPDATE`;
  return { balance: rows[0]!.balance, trial: rows[0]!.trial_remaining };
}

async function activeSubscription(db: Tx | typeof prisma, merchantId: string, now = new Date()) {
  return db.eDocSubscription.findFirst({ where: { merchantId, status: 'ACTIVE', endsAt: { gt: now } }, orderBy: { endsAt: 'desc' } });
}

async function writeLedger(
  tx: Tx,
  row: {
    merchantId: string;
    kind: EDocLedgerKind;
    amount?: number;
    units?: number;
    source?: EDocUseSource | null;
    vatBase?: number;
    balanceAfter: number;
    trialAfter: number;
    idempotencyKey: string;
    envelopeId?: string | null;
    billingRequestId?: string | null;
    subscriptionId?: string | null;
    memo?: string | null;
    actorId?: string | null;
  },
) {
  const { supply, vat } = splitVat(row.vatBase ?? row.amount ?? 0);
  return tx.eDocLedger.create({
    data: {
      id: newId(),
      merchantId: row.merchantId,
      kind: row.kind,
      amount: row.amount ?? 0,
      units: row.units ?? 0,
      source: row.source ?? null,
      supplyAmount: supply,
      vatAmount: vat,
      balanceAfter: row.balanceAfter,
      trialAfter: row.trialAfter,
      envelopeId: row.envelopeId ?? null,
      billingRequestId: row.billingRequestId ?? null,
      subscriptionId: row.subscriptionId ?? null,
      idempotencyKey: row.idempotencyKey,
      memo: row.memo ?? null,
      actorId: row.actorId ?? null,
    },
  });
}

export async function walletOverview(merchantId: string) {
  const [wallet, plan, subscription] = await Promise.all([ensureWallet(merchantId), currentEDocPlan(), activeSubscription(prisma, merchantId)]);
  const prepaidDocs = Math.floor(wallet.balance / Math.max(1, plan.perDocument));
  const monthlyLeft = subscription ? subscription.quota - subscription.used : 0;
  return {
    wallet,
    plan,
    subscription,
    monthlyLeft,
    prepaidDocs,
    /** 지금 보낼 수 있는 건수(정액 + 시범 + 충전 잔액 환산) */
    sendable: monthlyLeft + wallet.trialRemaining + prepaidDocs,
    lowBalance: wallet.balance < plan.lowBalance && monthlyLeft + wallet.trialRemaining === 0,
  };
}

// ---------------------------------------------------------------- 발송 차감 · 환원

/**
 * 발송 1건 차감. 서명 요청 봉투를 만드는 트랜잭션 안에서 부른다.
 * 순서: 정액 제공량 → 시범 제공량 → 충전 잔액. 모두 없으면 EDocBillingError.
 */
export async function debitForEnvelope(tx: Tx, input: { merchantId: string; envelopeId: string; actorId: string | null }) {
  const { balance, trial } = await lockWallet(tx, input.merchantId);
  const plan = await currentEDocPlan(new Date(), tx);
  const sub = await activeSubscription(tx, input.merchantId);
  const source = pickUseSource({ subscription: sub, trialRemaining: trial, balance, perDocument: plan.perDocument });
  if (!source) {
    throw new EDocBillingError(
      `전자문서 이용 잔액이 부족합니다. 1건에 ${plan.perDocument.toLocaleString('ko-KR')}원이 필요합니다. 충전 또는 정액 이용을 신청해 주세요.`,
    );
  }
  const key = `use:${input.envelopeId}`;
  if (source === 'MONTHLY') {
    const claimed = await tx.eDocSubscription.updateMany({ where: { id: sub!.id, used: { lt: sub!.quota } }, data: { used: { increment: 1 } } });
    if (claimed.count !== 1) throw new EDocBillingError('정액 제공량을 확인하지 못했습니다. 다시 시도해 주세요.');
    await tx.eDocWallet.update({ where: { merchantId: input.merchantId }, data: { totalUsed: { increment: 1 } } });
    await writeLedger(tx, { merchantId: input.merchantId, kind: 'USE', units: -1, source, balanceAfter: balance, trialAfter: trial, idempotencyKey: key, envelopeId: input.envelopeId, subscriptionId: sub!.id, actorId: input.actorId, memo: '정액 제공량 1건' });
    return { source, amount: 0, balanceAfter: balance };
  }
  if (source === 'TRIAL') {
    await tx.eDocWallet.update({ where: { merchantId: input.merchantId }, data: { trialRemaining: { decrement: 1 }, totalUsed: { increment: 1 } } });
    await writeLedger(tx, { merchantId: input.merchantId, kind: 'USE', units: -1, source, balanceAfter: balance, trialAfter: trial - 1, idempotencyKey: key, envelopeId: input.envelopeId, actorId: input.actorId, memo: '시범 제공 1건' });
    return { source, amount: 0, balanceAfter: balance };
  }
  const after = balance - plan.perDocument;
  await tx.eDocWallet.update({ where: { merchantId: input.merchantId }, data: { balance: after, totalUsed: { increment: 1 } } });
  await writeLedger(tx, { merchantId: input.merchantId, kind: 'USE', amount: -plan.perDocument, source, balanceAfter: after, trialAfter: trial, idempotencyKey: key, envelopeId: input.envelopeId, actorId: input.actorId, memo: `충전 잔액 ${plan.perDocument.toLocaleString('ko-KR')}원` });
  return { source, amount: plan.perDocument, balanceAfter: after };
}

/**
 * 발송 취소 환원. 아무 서명자도 문서를 열기 전에 취소한 봉투만 부른다(호출부가 판단).
 * 차감했던 곳으로 되돌린다. 정액 기간이 이미 끝났으면 되돌릴 곳이 없으므로 기록만 남긴다.
 */
export async function refundEnvelope(tx: Tx, input: { merchantId: string; envelopeId: string; actorId: string | null }) {
  const use = await tx.eDocLedger.findUnique({ where: { idempotencyKey: `use:${input.envelopeId}` } });
  if (!use) return { refunded: false as const };
  const done = await tx.eDocLedger.findUnique({ where: { idempotencyKey: `refund:${input.envelopeId}` } });
  if (done) return { refunded: false as const };
  const { balance, trial } = await lockWallet(tx, input.merchantId);
  const key = `refund:${input.envelopeId}`;
  if (use.source === 'MONTHLY' && use.subscriptionId) {
    const back = await tx.eDocSubscription.updateMany({ where: { id: use.subscriptionId, status: 'ACTIVE', endsAt: { gt: new Date() }, used: { gt: 0 } }, data: { used: { decrement: 1 } } });
    await writeLedger(tx, { merchantId: input.merchantId, kind: 'REFUND', units: back.count ? 1 : 0, source: 'MONTHLY', balanceAfter: balance, trialAfter: trial, idempotencyKey: key, envelopeId: input.envelopeId, subscriptionId: use.subscriptionId, actorId: input.actorId, memo: back.count ? '정액 제공량 1건 환원' : '정액 기간이 끝나 환원하지 않음' });
    return { refunded: back.count === 1, source: 'MONTHLY' as const };
  }
  if (use.source === 'TRIAL') {
    await tx.eDocWallet.update({ where: { merchantId: input.merchantId }, data: { trialRemaining: { increment: 1 } } });
    await writeLedger(tx, { merchantId: input.merchantId, kind: 'REFUND', units: 1, source: 'TRIAL', balanceAfter: balance, trialAfter: trial + 1, idempotencyKey: key, envelopeId: input.envelopeId, actorId: input.actorId, memo: '시범 제공 1건 환원' });
    return { refunded: true, source: 'TRIAL' as const };
  }
  const amount = -use.amount;
  await tx.eDocWallet.update({ where: { merchantId: input.merchantId }, data: { balance: { increment: amount } } });
  await writeLedger(tx, { merchantId: input.merchantId, kind: 'REFUND', amount, source: 'PREPAID', balanceAfter: balance + amount, trialAfter: trial, idempotencyKey: key, envelopeId: input.envelopeId, actorId: input.actorId, memo: '충전 잔액 환원' });
  return { refunded: true, source: 'PREPAID' as const };
}

/** 충전 잔액이 기준 아래로 내려가면 기관 담당자에게 1주일에 한 번 알린다. 실패해도 발송에 영향 없음(사후 처리). */
export async function maybeNotifyLowBalance(merchantId: string) {
  try {
    const o = await walletOverview(merchantId);
    if (!o.lowBalance) return;
    const last = o.wallet.lowBalanceNotifiedAt;
    if (last && Date.now() - last.getTime() < 7 * 86400_000) return;
    const merchant = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { userId: true } });
    if (!merchant) return;
    await prisma.eDocWallet.update({ where: { merchantId }, data: { lowBalanceNotifiedAt: new Date() } });
    await notifyUser({
      userId: merchant.userId,
      title: '전자문서 이용 잔액이 부족합니다',
      body: `남은 충전 잔액은 ${o.wallet.balance.toLocaleString('ko-KR')}원입니다. 서명 요청을 계속 보내려면 충전 또는 정액 이용을 신청해 주세요.`,
      linkUrl: '/studio/document-billing',
    });
  } catch (e) {
    logger.warn('전자문서 잔액 알림 실패', { message: (e as Error).message });
  }
}

// ---------------------------------------------------------------- 충전 · 정액 신청

export async function requestBilling(input: {
  merchantId: string;
  actorId: string;
  requestId: string;
  kind: 'TOPUP' | 'MONTHLY';
  amount?: number;
  depositorName: string | null;
  wantsTaxInvoice: boolean;
}) {
  if (!/^[0-9A-Z]{26}$/.test(input.requestId)) throw new EDocBillingError('화면을 새로 열고 다시 신청해 주세요.');
  const existing = await prisma.eDocBillingRequest.findUnique({ where: { id: input.requestId } });
  if (existing) {
    if (existing.merchantId !== input.merchantId) throw new EDocBillingError('화면을 새로 열고 다시 신청해 주세요.');
    return { request: existing, duplicated: true };
  }
  const pending = await prisma.eDocBillingRequest.count({ where: { merchantId: input.merchantId, status: 'PENDING' } });
  if (pending >= EDOC_PENDING_MAX) throw new EDocBillingError(`확인 대기 중인 신청이 ${EDOC_PENDING_MAX}건 있습니다. 관리자 확인 뒤 다시 신청하거나 대기 신청을 취소해 주세요.`);
  const plan = await currentEDocPlan();
  let amount: number;
  let quota = 0;
  let bonus = 0;
  if (input.kind === 'MONTHLY') {
    amount = plan.monthlyPrice;
    quota = plan.monthlyQuota;
    const dupMonthly = await prisma.eDocBillingRequest.count({ where: { merchantId: input.merchantId, status: 'PENDING', kind: 'MONTHLY' } });
    if (dupMonthly) throw new EDocBillingError('확인 대기 중인 정액 신청이 이미 있습니다.');
  } else {
    amount = Math.floor(Number(input.amount));
    if (!Number.isSafeInteger(amount) || amount < EDOC_TOPUP_MIN || amount > EDOC_TOPUP_MAX || amount % 1000 !== 0) {
      throw new EDocBillingError(`충전 금액은 ${EDOC_TOPUP_MIN.toLocaleString('ko-KR')}원~${EDOC_TOPUP_MAX.toLocaleString('ko-KR')}원, 1,000원 단위로 입력해 주세요.`);
    }
    bonus = topupBonusFor(amount, plan.topupBonus);
  }
  try {
    const request = await prisma.eDocBillingRequest.create({
      data: {
        id: input.requestId,
        merchantId: input.merchantId,
        kind: input.kind,
        amount,
        quota,
        bonus,
        depositorName: input.depositorName?.slice(0, 30) || null,
        wantsTaxInvoice: input.wantsTaxInvoice,
        requestedBy: input.actorId,
      },
    });
    return { request, duplicated: false };
  } catch (e) {
    if ((e as { code?: string })?.code === 'P2002') {
      return { request: await prisma.eDocBillingRequest.findUniqueOrThrow({ where: { id: input.requestId } }), duplicated: true };
    }
    throw e;
  }
}

export async function cancelBillingRequest(merchantId: string, requestId: string) {
  const r = await prisma.eDocBillingRequest.updateMany({ where: { id: requestId, merchantId, status: 'PENDING' }, data: { status: 'CANCELLED', resolvedAt: new Date() } });
  if (r.count !== 1) throw new EDocBillingError('이미 처리된 신청입니다.');
}

/**
 * 관리자 승인. 실제 입금·계약을 확인했다는 체크(paymentConfirmed)가 있어야 한다.
 * PENDING → APPROVED 를 먼저 선점해 두 관리자가 동시에 눌러도 한 번만 반영된다.
 */
export async function approveBillingRequest(input: { requestId: string; actorId: string; paymentConfirmed: boolean; taxInvoiceIssued: boolean }) {
  if (!input.paymentConfirmed) throw new EDocBillingError('실제 입금 또는 계약을 확인했는지 체크해 주세요.');
  return prisma.$transaction(async (tx) => {
    const req = await tx.eDocBillingRequest.findUnique({ where: { id: input.requestId } });
    if (!req) throw new EDocBillingError('신청을 찾을 수 없습니다.');
    const { balance, trial } = await lockWallet(tx, req.merchantId);
    const claimed = await tx.eDocBillingRequest.updateMany({
      where: { id: req.id, status: 'PENDING' },
      data: { status: 'APPROVED', resolvedBy: input.actorId, resolvedAt: new Date(), taxInvoiceIssued: input.taxInvoiceIssued },
    });
    if (claimed.count !== 1) throw new EDocBillingError('이미 처리된 신청입니다.');

    if (req.kind === 'TOPUP') {
      const afterPaid = balance + req.amount;
      await writeLedger(tx, { merchantId: req.merchantId, kind: 'TOPUP', amount: req.amount, source: 'PREPAID', balanceAfter: afterPaid, trialAfter: trial, idempotencyKey: `topup:${req.id}`, billingRequestId: req.id, actorId: input.actorId, memo: '충전 승인(입금 확인)' });
      let after = afterPaid;
      if (req.bonus > 0) {
        after += req.bonus;
        // 보너스는 받은 돈이 아니므로 공급가액·부가세 0 으로 남긴다.
        await writeLedger(tx, { merchantId: req.merchantId, kind: 'TOPUP', amount: req.bonus, vatBase: 0, source: 'PREPAID', balanceAfter: after, trialAfter: trial, idempotencyKey: `bonus:${req.id}`, billingRequestId: req.id, actorId: input.actorId, memo: '충전 보너스' });
      }
      await tx.eDocWallet.update({ where: { merchantId: req.merchantId }, data: { balance: after, lowBalanceNotifiedAt: null } });
      return { kind: 'TOPUP' as const, merchantId: req.merchantId, amount: req.amount, bonus: req.bonus, balanceAfter: after };
    }

    const now = new Date();
    if (await activeSubscription(tx, req.merchantId, now)) throw new EDocBillingError('진행 중인 정액 이용 기간이 있습니다. 기간이 끝난 뒤 승인해 주세요.');
    // 기간이 끝났는데 배치가 아직 안 돈 정액은 여기서 먼저 마감한다(진행 중 1건 유니크).
    await expireSubscriptionsFor(tx, req.merchantId, now, input.actorId);
    const sub = await tx.eDocSubscription.create({
      data: { id: newId(), merchantId: req.merchantId, billingRequestId: req.id, price: req.amount, quota: req.quota, startsAt: now, endsAt: addDays(now, EDOC_MONTHLY_DAYS) },
    });
    await writeLedger(tx, { merchantId: req.merchantId, kind: 'PLAN_GRANT', units: req.quota, vatBase: req.amount, source: 'MONTHLY', balanceAfter: balance, trialAfter: trial, idempotencyKey: `plan:${req.id}`, billingRequestId: req.id, subscriptionId: sub.id, actorId: input.actorId, memo: `30일 정액 ${req.amount.toLocaleString('ko-KR')}원` });
    return { kind: 'MONTHLY' as const, merchantId: req.merchantId, amount: req.amount, subscription: sub };
  });
}

export async function rejectBillingRequest(input: { requestId: string; actorId: string; reason: string }) {
  if (!input.reason.trim()) throw new EDocBillingError('반려 사유를 입력해 주세요.');
  const req = await prisma.eDocBillingRequest.findUnique({ where: { id: input.requestId } });
  if (!req) throw new EDocBillingError('신청을 찾을 수 없습니다.');
  const r = await prisma.eDocBillingRequest.updateMany({
    where: { id: input.requestId, status: 'PENDING' },
    data: { status: 'REJECTED', resolvedBy: input.actorId, resolvedAt: new Date(), rejectReason: input.reason.slice(0, 200) },
  });
  if (r.count !== 1) throw new EDocBillingError('이미 처리된 신청입니다.');
  return req;
}

/** 관리자 정정. 금액·시범 건수를 ± 로 조정하고 사유를 원장에 남긴다. 결과가 음수가 되면 거절한다. */
export async function adjustWallet(input: { merchantId: string; actorId: string; amount: number; units: number; reason: string; nonce: string }) {
  if (!input.reason.trim()) throw new EDocBillingError('조정 사유를 입력해 주세요.');
  if (!Number.isSafeInteger(input.amount) || !Number.isSafeInteger(input.units) || (input.amount === 0 && input.units === 0)) throw new EDocBillingError('조정 금액 또는 건수를 입력해 주세요.');
  if (Math.abs(input.amount) > EDOC_TOPUP_MAX || Math.abs(input.units) > 10000) throw new EDocBillingError('조정 범위를 넘었습니다.');
  return prisma.$transaction(async (tx) => {
    const { balance, trial } = await lockWallet(tx, input.merchantId);
    const nb = balance + input.amount;
    const nt = trial + input.units;
    if (nb < 0 || nt < 0) throw new EDocBillingError('조정 후 잔액이 0보다 작아집니다.');
    await tx.eDocWallet.update({ where: { merchantId: input.merchantId }, data: { balance: nb, trialRemaining: nt } });
    // 관리자 정정은 받은 돈이 아니므로 부가세를 나누지 않는다.
    await writeLedger(tx, { merchantId: input.merchantId, kind: 'ADJUST', amount: input.amount, units: input.units, vatBase: 0, balanceAfter: nb, trialAfter: nt, idempotencyKey: `adjust:${input.nonce}`, actorId: input.actorId, memo: input.reason.slice(0, 200) });
    return { before: { balance, trial }, after: { balance: nb, trial: nt } };
  });
}

// ---------------------------------------------------------------- 배치

async function expireSubscriptionsFor(tx: Tx, merchantId: string, now: Date, actorId: string | null) {
  const due = await tx.eDocSubscription.findMany({ where: { merchantId, status: 'ACTIVE', endsAt: { lte: now } } });
  for (const s of due) {
    const r = await tx.eDocSubscription.updateMany({ where: { id: s.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
    if (r.count !== 1) continue;
    const w = await tx.eDocWallet.findUnique({ where: { merchantId } });
    await writeLedger(tx, { merchantId, kind: 'EXPIRE', units: -(s.quota - s.used), vatBase: 0, source: 'MONTHLY', balanceAfter: w?.balance ?? 0, trialAfter: w?.trialRemaining ?? 0, idempotencyKey: `expire:${s.id}`, subscriptionId: s.id, actorId, memo: `정액 기간 종료(미사용 ${s.quota - s.used}건 소멸)` });
  }
  return due.length;
}

/** 기간이 끝난 정액을 마감한다. 남은 제공량은 소멸 기록(EXPIRE)으로 남긴다. */
export async function expireEDocSubscriptions(now = new Date()) {
  const merchants = await prisma.eDocSubscription.findMany({ where: { status: 'ACTIVE', endsAt: { lte: now } }, select: { merchantId: true }, distinct: ['merchantId'] });
  let expired = 0;
  for (const { merchantId } of merchants) {
    try {
      expired += await prisma.$transaction(async (tx) => {
        await lockWallet(tx, merchantId);
        return expireSubscriptionsFor(tx, merchantId, now, null);
      });
    } catch (e) {
      logger.error('전자문서 정액 마감 실패', { merchantId, message: (e as Error).message });
    }
  }
  return expired;
}

// ---------------------------------------------------------------- 검증

/** 원장 합계와 지갑 현재값이 같은지 확인한다(충전 잔액·시범 건수 모두). */
export async function verifyWallet(merchantId: string) {
  const [wallet, sum, trial] = await Promise.all([
    prisma.eDocWallet.findUnique({ where: { merchantId } }),
    prisma.eDocLedger.aggregate({ where: { merchantId }, _sum: { amount: true } }),
    prisma.eDocLedger.aggregate({
      where: { merchantId, OR: [{ kind: { in: ['TRIAL_GRANT', 'ADJUST'] } }, { source: 'TRIAL' }] },
      _sum: { units: true },
    }),
  ]);
  const ledgerBalance = sum._sum.amount ?? 0;
  const walletBalance = wallet?.balance ?? 0;
  const trialLedger = trial._sum.units ?? 0;
  const trialWallet = wallet?.trialRemaining ?? 0;
  return { ok: ledgerBalance === walletBalance && trialLedger === trialWallet, ledgerBalance, walletBalance, trialWallet, trialLedger };
}
