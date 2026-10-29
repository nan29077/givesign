import { prisma } from '@/server/db';
import { newId, newTransactionNo } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { payerDisplayName } from '@/lib/payer-name';
import { acquireIdempotency } from './idempotency';
import { executePayment, sendMtForPayer } from './charge-flow';
import { campaignOpen } from '@/lib/fundraising';
import { currentTermsDoc } from './terms';
import * as tpl from './mt-templates';
import type { RecurringDonation } from '@/generated/prisma/client';

/**
 * 정기후원.
 *
 *  - 약정: 후원자(결제수단 등록 완료)가 기관·금액·출금일을 정하고 RECURRING_DEBIT 동의를 남긴다.
 *  - 실행: /api/cron/recurring 이 매일 호출 → nextChargeOn 이 지난 ACTIVE 약정을 결제한다.
 *  - 멱등: `recurring:{id}:{yyyy-MM}` 키로 한 달에 한 번만 결제 건을 만든다. (절대 규칙 4)
 *  - 실패: 3일 뒤 재시도, 한 달 안 3회 실패하면 SUSPENDED. 후원자가 결제수단을 확인하고 재개한다.
 *  - 실결제사(헥토)에서 PIN 없는 빌키 출금은 금융사 승인이 필요하다. ALLOW_RECURRING_DEBIT 가
 *    켜지지 않으면 mock 결제사가 아닌 한 실행하지 않고 SKIPPED 로 남긴다. (절대 규칙 2·7)
 */

export const RECURRING_MIN_AMOUNT = 1000n;
export const RECURRING_MAX_AMOUNT = 2_000_000n;
export const RECURRING_DAY_MIN = 1;
export const RECURRING_DAY_MAX = 28;
/** 한 달 안 최대 시도 횟수 */
export const RECURRING_MAX_ATTEMPTS = 3;
/** 실패 후 재시도 간격(일) */
export const RECURRING_RETRY_DAYS = 3;

/** 실결제사에서 빌키 자동 출금을 허용하는가. mock 결제사는 항상 허용(화면에 mock 표기). */
export function recurringDebitAllowed(): boolean {
  if (env.payment.provider === 'mock') return true;
  return process.env.ALLOW_RECURRING_DEBIT === 'true';
}

/** KST 날짜 문자열(YYYY-MM-DD) → DATE 컬럼 값(UTC 자정) */
function dateCol(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

/** 다음 출금일. 이번 달 출금일이 아직 안 지났으면 이번 달, 지났으면 다음 달. */
export function firstChargeDate(dayOfMonth: number, now = new Date()): string {
  const today = kstDateKey(now);
  const [y, m] = today.split('-').map(Number);
  const thisMonth = `${y}-${String(m).padStart(2, '0')}-${String(dayOfMonth).padStart(2, '0')}`;
  if (thisMonth > today) return thisMonth;
  return nextMonthDate(dayOfMonth, today);
}

/** base(YYYY-MM-DD)가 속한 달의 다음 달 dayOfMonth */
export function nextMonthDate(dayOfMonth: number, base: string): string {
  const [y, m] = base.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + 1, dayOfMonth));
  return d.toISOString().slice(0, 10);
}

function addDaysKey(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface CreateRecurringInput {
  payerId: string;
  merchantId: string;
  campaignId?: string | null;
  amount: bigint;
  dayOfMonth: number;
  message?: string;
  anonymous?: boolean;
  ip?: string;
  userAgent?: string;
}

export type CreateRecurringResult =
  | { ok: true; recurring: RecurringDonation; firstDate: string }
  | { ok: false; message: string };

export async function createRecurringDonation(input: CreateRecurringInput): Promise<CreateRecurringResult> {
  if (input.amount < RECURRING_MIN_AMOUNT || input.amount > RECURRING_MAX_AMOUNT) {
    return { ok: false, message: `정기후원 금액은 ${RECURRING_MIN_AMOUNT.toLocaleString()}원 이상 ${RECURRING_MAX_AMOUNT.toLocaleString()}원 이하여야 합니다.` };
  }
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < RECURRING_DAY_MIN || input.dayOfMonth > RECURRING_DAY_MAX) {
    return { ok: false, message: `출금일은 ${RECURRING_DAY_MIN}~${RECURRING_DAY_MAX}일 사이로 정해 주세요.` };
  }

  const merchant = await prisma.merchantProfile.findFirst({
    where: { id: input.merchantId, status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
  });
  if (!merchant) return { ok: false, message: '정기후원을 받을 수 없는 기관입니다.' };

  const payer = await prisma.payerProfile.findUnique({ where: { id: input.payerId } });
  if (!payer || payer.onboardingStatus !== 'REGISTERED') {
    return { ok: false, message: '결제수단 등록을 먼저 완료해 주세요.' };
  }
  if (payer.blockedAt) return { ok: false, message: '이용이 제한된 계정입니다.' };
  const token = await prisma.paymentMethodToken.findFirst({ where: { payerId: payer.id, status: 'ACTIVE' }, select: { id: true } });
  if (!token) return { ok: false, message: '등록된 결제수단이 없습니다. 결제수단을 먼저 등록해 주세요.' };

  if (input.campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: input.campaignId, merchantId: merchant.id } });
    if (!c || !campaignOpen(c)) return { ok: false, message: '모금이 끝났거나 고를 수 없는 캠페인입니다.' };
  }

  // 같은 기관에 활성 약정이 이미 있으면 새로 만들지 않는다(금액 변경은 수정 흐름으로).
  const dup = await prisma.recurringDonation.findFirst({
    where: { payerId: payer.id, merchantId: merchant.id, status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } },
    select: { id: true },
  });
  if (dup) return { ok: false, message: '이 기관에 이미 등록된 정기후원이 있습니다. 마이페이지에서 금액이나 출금일을 바꿔 주세요.' };

  // 자동 출금 동의. 약관이 시드되지 않았으면 동의 자체를 받을 수 없으므로 중단한다.
  const terms = await currentTermsDoc('RECURRING_DEBIT');
  if (!terms) return { ok: false, message: '정기후원 동의 약관이 준비되지 않았습니다. 관리자에게 문의해 주세요.' };

  const firstDate = firstChargeDate(input.dayOfMonth);
  const recurring = await prisma.$transaction(async (tx) => {
    const consent = await tx.consentRecord.create({
      data: {
        id: newId(),
        userId: payer.userId,
        phoneHash: payer.phoneHash,
        termsId: terms.id,
        type: 'RECURRING_DEBIT',
        agreed: true,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null,
      },
    });
    return tx.recurringDonation.create({
      data: {
        id: newId(),
        merchantId: merchant.id,
        payerId: payer.id,
        campaignId: input.campaignId ?? null,
        amount: input.amount,
        dayOfMonth: input.dayOfMonth,
        message: (input.message ?? '').trim() || '정기후원',
        anonymous: Boolean(input.anonymous),
        status: 'ACTIVE',
        nextChargeOn: dateCol(firstDate),
        consentId: consent.id,
      },
    });
  });

  await sendMtForPayer(
    payer.id,
    tpl.tplRecurringStarted({ merchantName: merchant.displayName, amount: input.amount, dayOfMonth: input.dayOfMonth, nextDate: firstDate }),
    null,
    merchant.id,
  ).catch((e) => logger.warn('정기후원 등록 안내 문자 실패', { message: (e as Error).message }));

  return { ok: true, recurring, firstDate };
}

export async function updateRecurringDonation(
  payerId: string,
  id: string,
  patch: { amount?: bigint; dayOfMonth?: number; message?: string; anonymous?: boolean; campaignId?: string | null },
) {
  const row = await prisma.recurringDonation.findFirst({ where: { id, payerId } });
  if (!row) throw new Error('정기후원을 찾을 수 없습니다.');
  if (row.status === 'CANCELED') throw new Error('해지된 정기후원은 수정할 수 없습니다.');
  if (patch.amount !== undefined && (patch.amount < RECURRING_MIN_AMOUNT || patch.amount > RECURRING_MAX_AMOUNT)) {
    throw new Error('정기후원 금액 범위를 벗어났습니다.');
  }
  if (patch.dayOfMonth !== undefined && (patch.dayOfMonth < RECURRING_DAY_MIN || patch.dayOfMonth > RECURRING_DAY_MAX)) {
    throw new Error('출금일은 1~28일 사이여야 합니다.');
  }
  if (patch.campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: patch.campaignId, merchantId: row.merchantId } });
    if (!c || !campaignOpen(c)) throw new Error('모금이 끝났거나 고를 수 없는 캠페인입니다.');
  }
  const dayChanged = patch.dayOfMonth !== undefined && patch.dayOfMonth !== row.dayOfMonth;
  return prisma.recurringDonation.update({
    where: { id },
    data: {
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.dayOfMonth !== undefined ? { dayOfMonth: patch.dayOfMonth } : {}),
      ...(patch.message !== undefined ? { message: patch.message.trim() || '정기후원' } : {}),
      ...(patch.anonymous !== undefined ? { anonymous: patch.anonymous } : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
      // 출금일을 바꾸면 다음 출금일도 새 출금일 기준으로 다시 잡는다(이미 이달 출금했으면 다음 달).
      ...(dayChanged ? { nextChargeOn: dateCol(nextDateAfterChange(row, patch.dayOfMonth!)) } : {}),
    },
  });
}

function nextDateAfterChange(row: RecurringDonation, day: number, now = new Date()): string {
  const first = firstChargeDate(day, now);
  // 이번 달에 이미 출금했으면 이번 달로 다시 잡지 않는다.
  if (row.lastChargedAt && kstMonthKey(row.lastChargedAt) === first.slice(0, 7)) return nextMonthDate(day, first);
  return first;
}

export async function setRecurringStatus(
  payerId: string,
  id: string,
  action: 'PAUSE' | 'RESUME' | 'CANCEL',
  reason?: string,
) {
  const row = await prisma.recurringDonation.findFirst({ where: { id, payerId } });
  if (!row) throw new Error('정기후원을 찾을 수 없습니다.');
  if (row.status === 'CANCELED') throw new Error('이미 해지된 정기후원입니다.');
  const now = new Date();
  if (action === 'PAUSE') {
    if (row.status !== 'ACTIVE') throw new Error('진행 중인 정기후원만 일시정지할 수 있습니다.');
    return prisma.recurringDonation.update({ where: { id }, data: { status: 'PAUSED', pausedAt: now } });
  }
  if (action === 'RESUME') {
    if (row.status !== 'PAUSED' && row.status !== 'SUSPENDED') throw new Error('일시정지·정지 상태만 재개할 수 있습니다.');
    const token = await prisma.paymentMethodToken.findFirst({ where: { payerId, status: 'ACTIVE' }, select: { id: true } });
    if (!token) throw new Error('등록된 결제수단이 없어 재개할 수 없습니다.');
    // 재개 시점에 이달 출금일이 지났으면 다음 달부터.
    const next = firstChargeDate(row.dayOfMonth, now);
    return prisma.recurringDonation.update({
      where: { id },
      data: { status: 'ACTIVE', pausedAt: null, suspendedAt: null, failCount: 0, lastFailure: null, nextChargeOn: dateCol(next) },
    });
  }
  return prisma.recurringDonation.update({
    where: { id },
    data: { status: 'CANCELED', canceledAt: now, cancelReason: (reason ?? '').trim() || null },
  });
}

/** 결제수단이 해지되면 그 후원자의 정기후원을 모두 정지시킨다(결제수단 해지 액션에서 호출). */
export async function suspendRecurringForPayer(payerId: string, reason: string) {
  const r = await prisma.recurringDonation.updateMany({
    where: { payerId, status: { in: ['ACTIVE', 'PAUSED'] } },
    data: { status: 'SUSPENDED', suspendedAt: new Date(), lastFailure: reason },
  });
  return r.count;
}

// ---------------------------------------------------------------------------
// 실행 배치
// ---------------------------------------------------------------------------

export interface RecurringRunSummary {
  dateKey: string;
  checked: number;
  succeeded: number;
  failed: number;
  skipped: number;
  suspended: number;
  details: Array<{ id: string; status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; reason?: string; chargeId?: string }>;
}

export async function runRecurringDonations(now = new Date()): Promise<RecurringRunSummary> {
  const today = kstDateKey(now);
  const monthKey = kstMonthKey(now);
  const due = await prisma.recurringDonation.findMany({
    where: { status: 'ACTIVE', nextChargeOn: { lte: dateCol(today) } },
    include: { merchant: { select: { id: true, displayName: true, status: true, paymentMode: true } }, payer: true },
    orderBy: { nextChargeOn: 'asc' },
    take: 500,
  });

  const summary: RecurringRunSummary = { dateKey: today, checked: due.length, succeeded: 0, failed: 0, skipped: 0, suspended: 0, details: [] };
  const allowed = recurringDebitAllowed();

  for (const r of due) {
    try {
      const outcome = await runOne(r, { today, monthKey, allowed });
      summary.details.push({ id: r.id, ...outcome });
      if (outcome.status === 'SUCCESS') summary.succeeded += 1;
      else if (outcome.status === 'FAILED') summary.failed += 1;
      else summary.skipped += 1;
      if (outcome.suspended) summary.suspended += 1;
    } catch (e) {
      // 한 건의 예외가 다른 약정 실행을 막지 않는다.
      logger.error('정기후원 실행 중 예외', { recurringId: r.id, message: (e as Error).message });
      summary.failed += 1;
      summary.details.push({ id: r.id, status: 'FAILED', reason: '실행 오류' });
    }
  }
  return summary;
}

type DueRow = Awaited<ReturnType<typeof prisma.recurringDonation.findMany<{ include: { merchant: { select: { id: true; displayName: true; status: true; paymentMode: true } }; payer: true } }>>>[number];

async function runOne(
  r: DueRow,
  ctx: { today: string; monthKey: string; allowed: boolean },
): Promise<{ status: 'SUCCESS' | 'FAILED' | 'SKIPPED'; reason?: string; chargeId?: string; suspended?: boolean }> {
  // 이번 달 시도 횟수
  const attempts = await prisma.recurringRun.count({ where: { recurringId: r.id, monthKey: ctx.monthKey } });
  const attempt = attempts + 1;

  const recordRun = (status: 'SUCCESS' | 'FAILED' | 'SKIPPED', reason?: string, chargeId?: string) =>
    prisma.recurringRun.create({ data: { id: newId(), recurringId: r.id, monthKey: ctx.monthKey, attempt, status, chargeId: chargeId ?? null, reason: reason ?? null } });

  // 기관이 승인 상태가 아니면 출금하지 않고 다음 달로 미룬다.
  if (r.merchant.status !== 'APPROVED') {
    await recordRun('SKIPPED', '기관 비활성');
    await prisma.recurringDonation.update({ where: { id: r.id }, data: { nextChargeOn: dateCol(nextMonthDate(r.dayOfMonth, ctx.today)) } });
    return { status: 'SKIPPED', reason: '기관 비활성' };
  }
  if (!ctx.allowed) {
    // 실결제사 자동 출금 미승인. 건너뛰되 날짜는 유지해 승인 뒤 곧바로 실행되게 둔다.
    await recordRun('SKIPPED', '자동 출금 미승인(ALLOW_RECURRING_DEBIT)');
    return { status: 'SKIPPED', reason: '자동 출금 미승인' };
  }

  // 이번 달 이미 성공했으면(멱등키 DUPLICATE) 다음 달로만 옮긴다.
  const idem = await acquireIdempotency('charge', `recurring:${r.id}:${ctx.monthKey}`, 45);
  if (idem.status === 'DUPLICATE') {
    await recordRun('SKIPPED', '이달 이미 처리', idem.resourceId ?? undefined);
    await prisma.recurringDonation.update({ where: { id: r.id }, data: { nextChargeOn: dateCol(nextMonthDate(r.dayOfMonth, ctx.today)) } });
    return { status: 'SKIPPED', reason: '이달 이미 처리', chargeId: idem.resourceId ?? undefined };
  }

  const campaignOk = r.campaignId
    ? await prisma.campaign.findFirst({ where: { id: r.campaignId } }).then((c) => (c ? campaignOpen(c) : false))
    : false;

  let chargeId: string;
  try {
    const charge = await prisma.charge.create({
      data: {
        id: newId(),
        transactionNo: newTransactionNo(),
        merchantId: r.merchantId,
        payerId: r.payerId,
        channel: 'RECURRING',
        amount: r.amount,
        displayName: payerDisplayName(r.payer.displayName, r.payer.phoneMasked),
        message: r.message,
        messageRawEnc: encrypt(r.message),
        status: 'PENDING_PAYMENT',
        statusReason: `정기후원 ${ctx.monthKey} ${attempt}회차`,
        // 후원자가 약정 때 자동 출금에 동의했다. 건별 확인 링크 없이 바로 결제한다.
        paymentMode: 'DIRECT_TRIGGER',
        anonymous: r.anonymous,
        recurringId: r.id,
        // 캠페인이 끝났으면 기관 일반 후원으로 돌린다.
        campaignId: campaignOk ? r.campaignId : null,
      },
    });
    chargeId = charge.id;
  } catch (e) {
    await idem.abort();
    throw e;
  }
  await idem.release(chargeId);

  const paid = await executePayment(chargeId);
  if (paid.ok) {
    await recordRun('SUCCESS', undefined, chargeId);
    await prisma.recurringDonation.update({
      where: { id: r.id },
      data: {
        lastChargedAt: new Date(),
        failCount: 0,
        lastFailure: null,
        successCount: { increment: 1 },
        totalAmount: { increment: r.amount },
        nextChargeOn: dateCol(nextMonthDate(r.dayOfMonth, ctx.today)),
      },
    });
    return { status: 'SUCCESS', chargeId };
  }

  // 실패: 멱등키를 지워 재시도가 새 결제 건을 만들 수 있게 한다. 실패한 결제 건은 이력으로 남긴다.
  await prisma.idempotencyKey.deleteMany({ where: { scope: 'charge', key: `recurring:${r.id}:${ctx.monthKey}` } });
  await recordRun('FAILED', paid.message, chargeId);

  const failCount = r.failCount + 1;
  const exhausted = attempt >= RECURRING_MAX_ATTEMPTS;
  if (exhausted) {
    await prisma.recurringDonation.update({
      where: { id: r.id },
      data: { status: 'SUSPENDED', suspendedAt: new Date(), failCount, lastFailure: paid.message },
    });
    await sendMtForPayer(r.payerId, tpl.tplRecurringSuspended({ merchantName: r.merchant.displayName, amount: r.amount }), chargeId, r.merchantId).catch(() => undefined);
    return { status: 'FAILED', reason: paid.message, chargeId, suspended: true };
  }

  const retry = addDaysKey(ctx.today, RECURRING_RETRY_DAYS);
  await prisma.recurringDonation.update({
    where: { id: r.id },
    data: { failCount, lastFailure: paid.message, nextChargeOn: dateCol(retry) },
  });
  await sendMtForPayer(
    r.payerId,
    tpl.tplRecurringFailed({ merchantName: r.merchant.displayName, amount: r.amount, reason: paid.message, retryDate: retry }),
    chargeId,
    r.merchantId,
  ).catch(() => undefined);
  return { status: 'FAILED', reason: paid.message, chargeId };
}

export const recurringStatusLabel = {
  ACTIVE: { text: '진행 중', tone: 'brand' as const },
  PAUSED: { text: '일시정지', tone: 'warning' as const },
  SUSPENDED: { text: '정지(출금 실패)', tone: 'danger' as const },
  CANCELED: { text: '해지', tone: 'neutral' as const },
};

/** 로컬(mock)인지 화면에 알리기 위한 플래그 */
export const recurringIsMock = () => env.payment.provider === 'mock' || isLocal;
