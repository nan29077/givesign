import { prisma } from '@/server/db';
import { newId, newTransactionNo } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { kstDateKey } from '@/lib/datetime';
import { env, isLocal } from '@/lib/env';
import { logger } from '@/lib/logger';
import { payerDisplayName } from '@/lib/payer-name';
import { acquireIdempotency } from './idempotency';
import { executePayment, loadBannedWords, sendMtForPayer, setStatus } from './charge-flow';
import { filterContent } from './content-filter';
import { resolvePolicy } from './limits';
import { campaignOpen } from '@/lib/fundraising';
import { currentTermsDoc } from './terms';
import * as tpl from './mt-templates';
import { PAID_STATUSES } from '@/components/studio/shared';
import type { ChargeStatus, RecurringDonation } from '@/generated/prisma/client';

/**
 * 정기후원.
 *
 *  - 약정: 후원자(결제수단 등록 완료)가 기관·금액·출금일을 정하고 RECURRING_DEBIT 동의를 남긴다.
 *  - 실행: /api/cron/recurring 이 매일 호출 → nextChargeOn 이 지난 ACTIVE 약정을 결제한다.
 *  - 주기: 약정은 지금 처리 중인 출금 주기(`cycleMonth`, yyyy-MM)를 갖는다. 실패 재시도가 다음 달로
 *          넘어가도 그 결제는 원래 주기로 기록하고, 성공하면 주기를 한 달 넘긴다.
 *  - 멱등: `recurring:{id}:{cycleMonth}` 키로 주기마다 결제 건을 하나만 만든다. (절대 규칙 4)
 *          키가 이미 있으면 "이미 처리"로 넘기지 않고, 그 키가 가리키는 결제 건의 실제 상태를 확인한다.
 *  - 결과 미확인: 결제사 타임아웃 등으로 결과를 모르면 실행 기록을 PENDING 으로 남기고 그 약정은
 *          관리자 대사(payment-reconcile)로 결과가 확정될 때까지 새 결제를 만들지 않는다.
 *  - 실패: 3일 뒤 재시도, 한 주기 안 실패 3회면 SUSPENDED. 건너뜀(SKIPPED)은 실패 횟수에 넣지 않는다.
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

/** 정기후원 메시지 최대 길이 (MO·웹과 같다) */
export const RECURRING_MESSAGE_MAX = 80;

const LIVE_STATUSES = ['ACTIVE', 'PAUSED', 'SUSPENDED'] as const;

/**
 * 공개 화면에 나가는 메시지라 MO·웹과 같은 필터를 거친다(개인정보 마스킹 + 기관 금칙어 + 길이).
 * 원문은 약정에 남기지 않는다.
 */
async function cleanMessage(merchantId: string, raw: string | undefined): Promise<string> {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '정기후원';
  const bannedWords = await loadBannedWords(merchantId);
  const filtered = filterContent(trimmed, { bannedWords, maxLength: RECURRING_MESSAGE_MAX });
  return filtered.clean.trim() || '정기후원';
}

/**
 * 약정 금액이 실제 결제 한도 안에 드는지 확인한다.
 * 실행 때 checkLimits 가 같은 기준(기관 최소·최대, 정책 최소·최대, 후원자 일·월 한도)으로 막으므로,
 * 여기서 거르지 않으면 처음부터 성공할 수 없는 약정이 만들어져 매달 실패 문자만 나간다.
 */
export async function recurringAmountRange(merchantId: string, payerId: string): Promise<{ min: bigint; max: bigint }> {
  const [merchant, payer, policy] = await Promise.all([
    prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { minAmount: true, maxAmount: true } }),
    prisma.payerProfile.findUnique({ where: { id: payerId }, select: { dailyLimit: true, monthlyLimit: true } }),
    resolvePolicy(merchantId, payerId),
  ]);
  const max = (...v: Array<bigint | null | undefined>) => v.filter((x): x is bigint => x != null).reduce((a, b) => (a > b ? a : b));
  const min = (...v: Array<bigint | null | undefined>) => v.filter((x): x is bigint => x != null).reduce((a, b) => (a < b ? a : b));
  return {
    min: max(RECURRING_MIN_AMOUNT, merchant?.minAmount, policy.minAmount),
    max: min(
      RECURRING_MAX_AMOUNT,
      merchant?.maxAmount,
      policy.maxAmount,
      policy.payerDailyLimit,
      policy.payerMonthlyLimit,
      payer?.dailyLimit,
      payer?.monthlyLimit,
    ),
  };
}

async function assertAmountInRange(merchantId: string, payerId: string, amount: bigint): Promise<string | null> {
  const range = await recurringAmountRange(merchantId, payerId);
  if (range.max < range.min) return '현재 이용 한도로는 정기후원을 등록할 수 없습니다. 마이페이지 한도 설정을 확인해 주세요.';
  if (amount < range.min || amount > range.max) {
    return `정기후원 금액은 ${range.min.toLocaleString('ko-KR')}원 이상 ${range.max.toLocaleString('ko-KR')}원 이하여야 합니다. (기관 설정과 이용 한도 기준)`;
  }
  return null;
}

function isValidDay(day: unknown): day is number {
  return typeof day === 'number' && Number.isInteger(day) && day >= RECURRING_DAY_MIN && day <= RECURRING_DAY_MAX;
}

function isUniqueViolation(e: unknown) {
  return (e as { code?: string })?.code === 'P2002' || /unique constraint|recurring_donation_live_uniq/i.test((e as Error)?.message ?? '');
}

/** 이 약정이 해당 주기에 이미 출금(성공)했는가 */
async function cycleSucceeded(recurringId: string, cycleMonth: string) {
  const n = await prisma.recurringRun.count({ where: { recurringId, monthKey: cycleMonth, status: 'SUCCESS' } });
  return n > 0;
}

/** 지금 기준 첫 출금일. 이미 성공한 주기면 그다음 달로 넘긴다. */
async function nextScheduleFor(recurringId: string | null, day: number, now = new Date()): Promise<string> {
  let next = firstChargeDate(day, now);
  if (recurringId && (await cycleSucceeded(recurringId, next.slice(0, 7)))) next = nextMonthDate(day, next);
  return next;
}

export async function createRecurringDonation(input: CreateRecurringInput): Promise<CreateRecurringResult> {
  if (!isValidDay(input.dayOfMonth)) {
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

  const rangeError = await assertAmountInRange(merchant.id, payer.id, input.amount);
  if (rangeError) return { ok: false, message: rangeError };

  if (input.campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: input.campaignId, merchantId: merchant.id } });
    if (!c || !campaignOpen(c)) return { ok: false, message: '모금이 끝났거나 고를 수 없는 캠페인입니다.' };
  }

  const DUP_MESSAGE = '이 기관에 이미 등록된 정기후원이 있습니다. 마이페이지에서 금액이나 출금일을 바꿔 주세요.';
  // 같은 기관에 살아 있는 약정이 있으면 새로 만들지 않는다. 동시 요청은 DB 부분 유니크 인덱스
  // (recurring_donation_live_uniq)가 최종적으로 막는다.
  const dup = await prisma.recurringDonation.findFirst({
    where: { payerId: payer.id, merchantId: merchant.id, status: { in: [...LIVE_STATUSES] } },
    select: { id: true },
  });
  if (dup) return { ok: false, message: DUP_MESSAGE };

  // 자동 출금 동의. 약관이 시드되지 않았으면 동의 자체를 받을 수 없으므로 중단한다.
  const terms = await currentTermsDoc('RECURRING_DEBIT');
  if (!terms) return { ok: false, message: '정기후원 동의 약관이 준비되지 않았습니다. 관리자에게 문의해 주세요.' };

  const message = await cleanMessage(merchant.id, input.message);
  const firstDate = firstChargeDate(input.dayOfMonth);
  let recurring: RecurringDonation;
  try {
    recurring = await prisma.$transaction(async (tx) => {
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
          message,
          anonymous: Boolean(input.anonymous),
          status: 'ACTIVE',
          nextChargeOn: dateCol(firstDate),
          cycleMonth: firstDate.slice(0, 7),
          consentId: consent.id,
        },
      });
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, message: DUP_MESSAGE };
    throw e;
  }

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
  if (patch.amount !== undefined) {
    const err = await assertAmountInRange(row.merchantId, payerId, patch.amount);
    if (err) throw new Error(err);
  }
  if (patch.dayOfMonth !== undefined && !isValidDay(patch.dayOfMonth)) {
    throw new Error(`출금일은 ${RECURRING_DAY_MIN}~${RECURRING_DAY_MAX}일 사이여야 합니다.`);
  }
  if (patch.campaignId) {
    const c = await prisma.campaign.findFirst({ where: { id: patch.campaignId, merchantId: row.merchantId } });
    if (!c || !campaignOpen(c)) throw new Error('모금이 끝났거나 고를 수 없는 캠페인입니다.');
  }
  const message = patch.message !== undefined ? await cleanMessage(row.merchantId, patch.message) : undefined;
  const dayChanged = patch.dayOfMonth !== undefined && patch.dayOfMonth !== row.dayOfMonth;
  // 출금일을 바꾸면 지금 기준으로 다시 잡는다. 이미 성공한 주기로는 되돌아가지 않는다.
  const next = dayChanged ? await nextScheduleFor(row.id, patch.dayOfMonth!) : null;
  return prisma.recurringDonation.update({
    where: { id },
    data: {
      ...(patch.amount !== undefined ? { amount: patch.amount } : {}),
      ...(patch.dayOfMonth !== undefined ? { dayOfMonth: patch.dayOfMonth } : {}),
      ...(message !== undefined ? { message } : {}),
      ...(patch.anonymous !== undefined ? { anonymous: patch.anonymous } : {}),
      ...(patch.campaignId !== undefined ? { campaignId: patch.campaignId } : {}),
      ...(next ? { nextChargeOn: dateCol(next), cycleMonth: next.slice(0, 7), failCount: 0 } : {}),
    },
  });
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
    // 재개 시점에 이달 출금일이 지났거나 이미 출금한 주기면 그다음 달부터.
    const next = await nextScheduleFor(row.id, row.dayOfMonth, now);
    return prisma.recurringDonation.update({
      where: { id },
      data: {
        status: 'ACTIVE', pausedAt: null, suspendedAt: null, failCount: 0, lastFailure: null,
        nextChargeOn: dateCol(next), cycleMonth: next.slice(0, 7),
      },
    });
  }
  return prisma.recurringDonation.update({
    where: { id },
    data: { status: 'CANCELED', canceledAt: now, cancelReason: (reason ?? '').trim().slice(0, 200) || null },
  });
}

/** 결제수단이 해지되면 그 후원자의 정기후원을 모두 정지시킨다(결제수단 해지 경로에서 호출). */
export async function suspendRecurringForPayer(payerId: string, reason: string) {
  const r = await prisma.recurringDonation.updateMany({
    where: { payerId, status: { in: ['ACTIVE', 'PAUSED'] } },
    data: { status: 'SUSPENDED', suspendedAt: new Date(), lastFailure: reason },
  });
  return r.count;
}

/** 정기후원 결제 건이 환불되면 약정의 누적(화면 표시용 캐시)을 되돌린다. */
export async function revertRecurringTotals(chargeId: string) {
  const c = await prisma.charge.findUnique({ where: { id: chargeId }, select: { recurringId: true, amount: true } });
  if (!c?.recurringId) return;
  await prisma.recurringDonation.updateMany({
    where: { id: c.recurringId, successCount: { gt: 0 } },
    data: { successCount: { decrement: 1 }, totalAmount: { decrement: c.amount } },
  });
}

// ---------------------------------------------------------------------------
// 실행 배치
// ---------------------------------------------------------------------------

export type RecurringOutcome = 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'PENDING';

export interface RecurringRunSummary {
  dateKey: string;
  checked: number;
  succeeded: number;
  failed: number;
  skipped: number;
  pending: number;
  suspended: number;
  /** 시간 예산을 넘겨 다음 실행으로 넘긴 건이 있는가 */
  truncated: boolean;
  details: Array<{ id: string; status: RecurringOutcome; reason?: string; chargeId?: string }>;
}

/** 배치 한 번의 시간 예산. 잠금 TTL(15분)보다 충분히 짧게 둔다. */
const BATCH_BUDGET_MS = 8 * 60 * 1000;
const PAGE_SIZE = 200;

type DueRow = RecurringDonation & {
  merchant: { id: string; displayName: string; status: string };
  payer: { displayName: string | null; phoneMasked: string };
};

export async function runRecurringDonations(now = new Date(), budgetMs = BATCH_BUDGET_MS): Promise<RecurringRunSummary> {
  const today = kstDateKey(now);
  const started = Date.now();
  const summary: RecurringRunSummary = {
    dateKey: today, checked: 0, succeeded: 0, failed: 0, skipped: 0, pending: 0, suspended: 0, truncated: false, details: [],
  };
  const allowed = recurringDebitAllowed();

  // id 순 커서로 끝까지 훑는다. 건너뛴 약정(날짜를 그대로 두는 경우)이 같은 페이지를 다시 채워
  // 무한 반복하지 않도록 오프셋이 아니라 커서를 쓴다.
  let cursor: string | null = null;
  for (;;) {
    if (Date.now() - started > budgetMs) {
      summary.truncated = true;
      break;
    }
    const page: DueRow[] = await prisma.recurringDonation.findMany({
      where: { status: 'ACTIVE', nextChargeOn: { lte: dateCol(today) }, ...(cursor ? { id: { gt: cursor } } : {}) },
      include: { merchant: { select: { id: true, displayName: true, status: true } }, payer: { select: { displayName: true, phoneMasked: true } } },
      orderBy: { id: 'asc' },
      take: PAGE_SIZE,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;

    for (const r of page) {
      summary.checked += 1;
      try {
        const outcome = await runOne(r, { today, allowed });
        summary.details.push({ id: r.id, ...outcome });
        if (outcome.status === 'SUCCESS') summary.succeeded += 1;
        else if (outcome.status === 'FAILED') summary.failed += 1;
        else if (outcome.status === 'PENDING') summary.pending += 1;
        else summary.skipped += 1;
        if (outcome.suspended) summary.suspended += 1;
      } catch (e) {
        // 한 건의 예외가 다른 약정 실행을 막지 않는다. 결제를 만들기 전 단계의 예외라 돈은 움직이지 않았다.
        logger.error('정기후원 실행 중 예외', { recurringId: r.id, message: (e as Error).message });
        summary.skipped += 1;
        summary.details.push({ id: r.id, status: 'SKIPPED', reason: '실행 오류(다음 실행에서 다시 확인)' });
      }
    }
  }
  return summary;
}

type ChargeResolution = 'PAID' | 'FAILED' | 'PENDING';

/** 결제가 끝난(돈이 움직인) 것으로 볼 상태. 환불은 출금이 있었던 것이므로 같은 주기에 다시 출금하지 않는다. */
const SETTLED_LIKE: ChargeStatus[] = [...PAID_STATUSES, 'REFUND_REQUESTED', 'REFUNDED'];

/**
 * 정기후원 결제 건의 최종 상태를 판단한다.
 *  - PAID    : 출금됨(성공·정산·환불 포함)
 *  - FAILED  : 출금되지 않았음이 확실함
 *  - PENDING : 결과를 아직 모름(결제사 응답 미확인, 승인 기록과 거래 상태 불일치 등) → 사람이 확인
 */
async function resolveCharge(chargeId: string): Promise<ChargeResolution> {
  const charge = await prisma.charge.findUnique({
    where: { id: chargeId },
    select: { status: true, transactions: { select: { status: true } } },
  });
  if (!charge) return 'FAILED';
  if (SETTLED_LIKE.includes(charge.status)) return 'PAID';
  if (charge.status === 'PAYMENT_FAILED' || charge.status === 'LIMIT_BLOCKED' || charge.status === 'UNREGISTERED' || charge.status === 'CONTENT_BLOCKED') {
    return 'FAILED';
  }
  const txns = charge.transactions;
  if (txns.some((t) => t.status === 'APPROVED' || t.status === 'REQUESTED' || t.status === 'TIMEOUT' || t.status === 'UNKNOWN')) {
    return 'PENDING';
  }
  // 결제사에 요청이 한 번도 나가지 않았거나 모두 실패·취소로 끝났다 → 돈은 움직이지 않았다.
  await setStatus(chargeId, 'PAYMENT_FAILED', txns.length ? '정기후원 결제 실패 확정' : '정기후원 실행 중단(결제 요청 전)');
  return 'FAILED';
}

function nextCycleOf(cycleMonth: string): string {
  const [y, m] = cycleMonth.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return d.toISOString().slice(0, 7);
}

function cycleDate(cycleMonth: string, day: number): string {
  return `${cycleMonth}-${String(day).padStart(2, '0')}`;
}

/** 성공 처리: 주기를 한 달 넘기고 누적을 올린다. 같은 주기를 두 번 넘기지 않도록 현재 주기일 때만 갱신한다. */
async function markCycleSucceeded(r: RecurringDonation, cycleMonth: string, amount: bigint) {
  const nextCycle = nextCycleOf(cycleMonth);
  await prisma.recurringDonation.updateMany({
    where: { id: r.id, cycleMonth },
    data: {
      lastChargedAt: new Date(),
      failCount: 0,
      lastFailure: null,
      successCount: { increment: 1 },
      totalAmount: { increment: amount },
      cycleMonth: nextCycle,
      nextChargeOn: dateCol(cycleDate(nextCycle, r.dayOfMonth)),
    },
  });
}

async function postponeOneDay(r: RecurringDonation, today: string, note: string) {
  await prisma.recurringDonation.update({
    where: { id: r.id },
    data: { nextChargeOn: dateCol(addDaysKey(today, 1)), lastFailure: note },
  });
}

async function runOne(
  r: DueRow,
  ctx: { today: string; allowed: boolean },
): Promise<{ status: RecurringOutcome; reason?: string; chargeId?: string; suspended?: boolean }> {
  const cycle = r.cycleMonth;
  const idemKey = `recurring:${r.id}:${cycle}`;

  const runCount = () => prisma.recurringRun.count({ where: { recurringId: r.id, monthKey: cycle } });
  const recordRun = async (status: RecurringOutcome, reason?: string, chargeId?: string) =>
    prisma.recurringRun.create({
      data: { id: newId(), recurringId: r.id, monthKey: cycle, attempt: (await runCount()) + 1, status, chargeId: chargeId ?? null, reason: reason ?? null },
    });

  // (0) 출금 주기가 아직 오지 않았다(다음 달 주기인데 날짜만 앞당겨진 경우). 일찍 출금하지 않는다.
  if (cycle > ctx.today.slice(0, 7)) {
    await prisma.recurringDonation.update({ where: { id: r.id }, data: { nextChargeOn: dateCol(cycleDate(cycle, r.dayOfMonth)) } });
    return { status: 'SKIPPED', reason: '출금 주기 전' };
  }

  // (1) 기관이 승인 상태가 아니면 이 주기는 출금하지 않고 다음 주기로 넘긴다.
  if (r.merchant.status !== 'APPROVED') {
    await recordRun('SKIPPED', '기관 비활성');
    const nextCycle = nextCycleOf(cycle);
    await prisma.recurringDonation.update({
      where: { id: r.id },
      data: { cycleMonth: nextCycle, nextChargeOn: dateCol(cycleDate(nextCycle, r.dayOfMonth)) },
    });
    return { status: 'SKIPPED', reason: '기관 비활성' };
  }

  // (2) 실결제사 자동 출금 미승인. 날짜는 그대로 두어 승인 뒤 곧바로 실행되게 한다.
  //     실행 기록은 하루 한 번만 남긴다(매 실행마다 쌓이지 않게).
  if (!ctx.allowed) {
    const already = await prisma.recurringRun.findFirst({
      where: { recurringId: r.id, monthKey: cycle, status: 'SKIPPED', reason: { startsWith: '자동 출금 미승인' }, ranAt: { gte: new Date(`${ctx.today}T00:00:00+09:00`) } },
      select: { id: true },
    });
    if (!already) await recordRun('SKIPPED', '자동 출금 미승인(ALLOW_RECURRING_DEBIT)');
    return { status: 'SKIPPED', reason: '자동 출금 미승인' };
  }

  // (3) 결과를 아직 모르는 이전 결제가 있으면 먼저 정리한다. 확인되기 전에는 새 결제를 만들지 않는다.
  const pendingRuns = await prisma.recurringRun.findMany({
    where: { recurringId: r.id, status: 'PENDING' },
    orderBy: { ranAt: 'asc' },
  });
  for (const run of pendingRuns) {
    const res = run.chargeId ? await resolveCharge(run.chargeId) : 'FAILED';
    if (res === 'PENDING') {
      await postponeOneDay(r, ctx.today, '이전 결제 결과 확인 대기');
      return { status: 'PENDING', reason: '이전 결제 결과 확인 대기', chargeId: run.chargeId ?? undefined };
    }
    if (res === 'PAID') {
      await prisma.recurringRun.update({ where: { id: run.id }, data: { status: 'SUCCESS', reason: '결과 확인 후 성공 확정' } });
      if (run.monthKey === cycle) {
        await markCycleSucceeded(r, cycle, r.amount);
        return { status: 'SUCCESS', reason: '이전 결제 성공 확정', chargeId: run.chargeId ?? undefined };
      }
      continue;
    }
    // 실패 확정: 실패 기록으로 바꾸고 그 주기의 멱등키를 풀어 재시도를 허용한다.
    await prisma.recurringRun.update({ where: { id: run.id }, data: { status: 'FAILED', reason: run.reason ?? '결제 실패 확정' } });
    await prisma.idempotencyKey.deleteMany({ where: { scope: 'charge', key: `recurring:${r.id}:${run.monthKey}` } });
  }

  // (4) 이 주기의 실패 횟수(건너뜀은 세지 않는다). 이미 한도에 닿았으면 정지.
  const failures = await prisma.recurringRun.count({ where: { recurringId: r.id, monthKey: cycle, status: 'FAILED' } });
  if (failures >= RECURRING_MAX_ATTEMPTS) {
    await prisma.recurringDonation.update({ where: { id: r.id }, data: { status: 'SUSPENDED', suspendedAt: new Date(), failCount: failures } });
    return { status: 'FAILED', reason: '실패 한도 초과', suspended: true };
  }

  // (5) 주기 멱등키. 이미 있으면 그 키가 가리키는 결제 건의 실제 상태로 판단한다.
  let idem = await acquireIdempotency('charge', idemKey, 62);
  if (idem.status === 'DUPLICATE') {
    if (!idem.resourceId) {
      // 키는 있는데 결제 건이 연결되지 않았다: 다른 실행이 지금 만들고 있거나, 만들기 직전에 죽었다.
      const row = await prisma.idempotencyKey.findUnique({ where: { scope_key: { scope: 'charge', key: idemKey } } });
      const stale = row && Date.now() - row.createdAt.getTime() > 30 * 60 * 1000;
      if (!row || !stale) {
        await postponeOneDay(r, ctx.today, '다른 실행이 처리 중');
        return { status: 'SKIPPED', reason: '다른 실행이 처리 중' };
      }
      await prisma.idempotencyKey.delete({ where: { id: row.id } }).catch(() => undefined);
    } else {
      const res = await resolveCharge(idem.resourceId);
      if (res === 'PAID') {
        if (await cycleSucceeded(r.id, cycle)) {
          // 이미 성공으로 기록된 주기다. 누적을 다시 올리지 않고 다음 주기로만 맞춘다.
          const nextCycle = nextCycleOf(cycle);
          await prisma.recurringDonation.updateMany({
            where: { id: r.id, cycleMonth: cycle },
            data: { cycleMonth: nextCycle, nextChargeOn: dateCol(cycleDate(nextCycle, r.dayOfMonth)) },
          });
          return { status: 'SKIPPED', reason: '이 주기는 이미 출금됨', chargeId: idem.resourceId };
        }
        await recordRun('SUCCESS', '기존 결제 성공 확인', idem.resourceId);
        await markCycleSucceeded(r, cycle, r.amount);
        return { status: 'SUCCESS', reason: '기존 결제 성공 확인', chargeId: idem.resourceId };
      }
      if (res === 'PENDING') {
        const hasPending = await prisma.recurringRun.count({ where: { recurringId: r.id, chargeId: idem.resourceId, status: 'PENDING' } });
        if (!hasPending) await recordRun('PENDING', '결제 결과 미확인', idem.resourceId);
        await postponeOneDay(r, ctx.today, '결제 결과 확인 대기');
        return { status: 'PENDING', reason: '결제 결과 확인 대기', chargeId: idem.resourceId };
      }
      // 실패 확정된 건을 가리키는 키: 풀고 새로 잡는다.
      await prisma.idempotencyKey.deleteMany({ where: { scope: 'charge', key: idemKey } });
    }
    idem = await acquireIdempotency('charge', idemKey, 62);
    if (idem.status === 'DUPLICATE') {
      await postponeOneDay(r, ctx.today, '다른 실행이 처리 중');
      return { status: 'SKIPPED', reason: '다른 실행이 처리 중' };
    }
  }

  const campaignOk = r.campaignId
    ? await prisma.campaign.findFirst({ where: { id: r.campaignId } }).then((c) => (c ? campaignOpen(c) : false))
    : false;
  // 약정 이후 기관이 금칙어를 추가했을 수 있으므로 결제 건을 만들 때 다시 거른다.
  const message = await cleanMessage(r.merchantId, r.message);

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
        message,
        messageRawEnc: encrypt(message),
        status: 'PENDING_PAYMENT',
        statusReason: `정기후원 ${cycle} ${failures + 1}회차`,
        // 후원자가 약정 때 자동 출금(RECURRING_DEBIT)에 동의했다. MO 즉시결제(DIRECT_TRIGGER)와 구분한다.
        paymentMode: 'RECURRING',
        anonymous: r.anonymous,
        recurringId: r.id,
        // 후원 처리(포인트 지급) 대상이 아니다.
        pointStatus: 'SKIPPED',
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

  // 결제 전에 실행 기록을 "확인 대기"로 먼저 남긴다. 아래에서 예외가 나도 다음 실행이 이 건을 찾아 정리한다.
  const run = await recordRun('PENDING', '결제 진행 중', chargeId);

  let paid: Awaited<ReturnType<typeof executePayment>>;
  try {
    paid = await executePayment(chargeId);
  } catch (e) {
    logger.error('정기후원 결제 중 예외 — 다음 실행에서 결과를 확인합니다', { recurringId: r.id, chargeId, message: (e as Error).message });
    await postponeOneDay(r, ctx.today, '결제 결과 확인 대기');
    return { status: 'PENDING', reason: '결제 중 오류(결과 확인 대기)', chargeId };
  }

  if (paid.ok) {
    await prisma.recurringRun.update({ where: { id: run.id }, data: { status: 'SUCCESS', reason: null } });
    await markCycleSucceeded(r, cycle, r.amount);
    return { status: 'SUCCESS', chargeId };
  }

  if (paid.status === 'PENDING_PAYMENT') {
    // 결과 미확인. 출금됐을 수 있으므로 실패로 보지 않고 키도 지우지 않는다. 관리자 대사를 기다린다.
    await prisma.recurringRun.update({ where: { id: run.id }, data: { reason: '결제 결과 미확인 — 관리자 확인 대기' } });
    await postponeOneDay(r, ctx.today, '결제 결과 확인 대기');
    return { status: 'PENDING', reason: '결제 결과 미확인', chargeId };
  }

  // 실패 확정: 멱등키를 지워 재시도가 새 결제 건을 만들 수 있게 한다. 실패한 결제 건은 이력으로 남긴다.
  await prisma.recurringRun.update({ where: { id: run.id }, data: { status: 'FAILED', reason: paid.message } });
  await prisma.idempotencyKey.deleteMany({ where: { scope: 'charge', key: idemKey } });

  const failCount = failures + 1;
  if (failCount >= RECURRING_MAX_ATTEMPTS) {
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
