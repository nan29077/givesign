import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { decrypt } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { toDateKey, settlementDateFor } from '@/lib/business-day';
import { loadHolidaysAround } from './settlement-schedule';
import { resolveFeePolicy, getSettlementSummary, createSettlementRequest, markSettlementPaid } from './settlement';
import { getPayoutAdapter } from '@/server/adapters/payout';
import { notifySuperAdmins } from './notifications';
import { PAID_STATUSES } from '@/components/studio/shared';

/**
 * 자동 정산.
 *
 * 사회복지기관이 정산을 요청하지 않는다. 관리자가 정한 지급일(결제일 + N영업일)이 되면
 * 배치가 그날 지급할 금액을 모아 지급대행으로 이체한다.
 *
 * ── 돈이 나가는 코드이므로 지키는 것 ────────────────────────────
 *  1) 같은 결제 건은 한 번만 정산된다. 지급에 포함된 건은 charge.settledAt 을 채워 다시 잡히지 않게 한다.
 *  2) 같은 사회복지기관·같은 날 회차는 하나만 만든다(멱등키 + 사회복지기관 advisory lock).
 *  3) 지급 금액은 원장 가용 잔액을 절대 넘지 않는다. 환불로 잔액이 줄었으면 그만큼 덜 지급한다.
 *  4) 대행사 응답을 못 받으면 재이체하지 않는다. 조회로 확정하거나 실패로 남긴다.
 *  5) 어떤 단계에서 예외가 나도 다른 사회복지기관 처리를 막지 않는다.
 */

export interface PayoutRunResult {
  dateKey: string;
  /** 지급 대상으로 검토한 사회복지기관 수 */
  checked: number;
  paid: number;
  failed: number;
  skipped: number;
  totalPaid: bigint;
  details: Array<{
    merchantId: string;
    merchantName: string;
    status: 'PAID' | 'FAILED' | 'SKIPPED';
    amount: bigint;
    reason?: string;
    requestId?: string;
  }>;
}

/** 지급 대상 결제 한 건 */
interface DueCharge {
  id: string;
  netAmount: bigint;
  paidAt: Date;
}

/**
 * 지급일이 도래한(아직 정산되지 않은) 결제 건을 오래된 순으로 모은다.
 * 지급일은 결제일 + 사회복지기관에 적용되는 영업일 수로 계산한다.
 */
export async function findDueCharges(
  merchantId: string,
  now: Date = new Date(),
): Promise<{ charges: DueCharge[]; settlementDays: number }> {
  const policy = await resolveFeePolicy(merchantId, now);
  const settlementDays = policy?.settlementDays ?? 5;

  const rows = await prisma.charge.findMany({
    where: {
      merchantId,
      status: { in: PAID_STATUSES },
      settledAt: null,
      // 이미 어떤 회차에 묶인 건은 그 회차가 책임진다. 실패한 회차라도 풀어 주면
      // 배치가 같은 건을 새 회차로 다시 잡아 같은 돈이 두 번 나간다.
      settlementRequestId: null,
      paidAt: { not: null },
    },
    orderBy: { paidAt: 'asc' },
    select: { id: true, netAmount: true, paidAt: true },
  });
  if (rows.length === 0) return { charges: [], settlementDays };

  const first = toDateKey(rows[0].paidAt!);
  const last = toDateKey(now);
  const holidays = await loadHolidaysAround(first, last);
  const todayKey = toDateKey(now);

  const due = rows.filter((r) => settlementDateFor(toDateKey(r.paidAt!), holidays, settlementDays) <= todayKey);

  return {
    charges: due.map((r) => ({ id: r.id, netAmount: r.netAmount ?? 0n, paidAt: r.paidAt! })),
    settlementDays,
  };
}

/**
 * 회차에 담을 결제 건을 고른다.
 *
 * 잔액을 넘는 건은 건너뛰고 다음 건을 본다(큰 건 하나가 뒤의 작은 건 전부를 무기한 막지 않게).
 * **화면의 "오늘 지급 예정" 과 실제 배치가 반드시 같은 규칙을 써야 한다.**
 * 예전에는 화면이 netAmount 를 단순 합산해, 잔액이 줄었거나 최소 지급액 미만인 사회복지기관까지
 * 예정 금액에 넣어 실제 이체액과 어긋났다.
 */
export function selectPayoutCharges(
  charges: DueCharge[],
  available: bigint,
): { amount: bigint; ids: string[] } {
  let amount = 0n;
  const ids: string[] = [];
  for (const c of charges) {
    if (c.netAmount <= 0n) continue;
    if (amount + c.netAmount > available) continue;
    amount += c.netAmount;
    ids.push(c.id);
  }
  return { amount, ids };
}

/**
 * 사회복지기관 한 곳의 자동 지급.
 * 예외를 밖으로 던지지 않는다(배치 전체가 멈추면 안 된다).
 */
export async function runMerchantPayout(
  merchantId: string,
  now: Date = new Date(),
): Promise<{ status: 'PAID' | 'FAILED' | 'SKIPPED'; amount: bigint; reason?: string; requestId?: string }> {
  const dateKey = toDateKey(now);
  // 지급대행 transfer() 를 호출했는지. 호출 이후의 실패는 "결과 미확인" 이므로
  // 멱등키를 풀면 안 된다(다음 배치가 같은 돈을 다시 보낸다).
  let transferAttempted = false;

  try {
    const merchant = await prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { id: true, displayName: true, status: true },
    });
    if (!merchant) return { status: 'SKIPPED', amount: 0n, reason: '사회복지기관을 찾을 수 없습니다.' };
    if (merchant.status !== 'APPROVED') {
      return { status: 'SKIPPED', amount: 0n, reason: `사회복지기관 상태 ${merchant.status}` };
    }

    const account = await prisma.settlementAccount.findUnique({ where: { merchantId } });
    if (!account || !account.verified) {
      return { status: 'SKIPPED', amount: 0n, reason: '정산 계좌 인증 미완료' };
    }

    const { charges } = await findDueCharges(merchantId, now);
    if (charges.length === 0) return { status: 'SKIPPED', amount: 0n, reason: '지급일이 도래한 결제 없음' };

    // 환불 등으로 잔액이 줄었으면 그 범위 안에서만 지급한다.
    const summary = await getSettlementSummary(merchantId);
    const { amount, ids: included } = selectPayoutCharges(charges, summary.available);

    if (included.length === 0 || amount < BigInt(env.payout.minAmount)) {
      return {
        status: 'SKIPPED',
        amount,
        reason:
          amount === 0n
            ? '지급 가능 잔액 없음'
            : `최소 지급 금액(${env.payout.minAmount}원) 미만 — 다음 회차로 이월`,
      };
    }

    // 같은 사회복지기관·같은 날 회차는 하나만 만든다.
    const idem = await prisma.idempotencyKey
      .create({
        data: {
          id: newId(),
          scope: 'payout',
          key: `${merchantId}:${dateKey}`,
          status: 'IN_PROGRESS',
          // 같은 날 재실행을 막는 것이 목적이라 짧게 잡는다.
          expiresAt: new Date(now.getTime() + 30 * 86_400_000),
        },
      })
      .catch(() => null);
    if (!idem) {
      return { status: 'SKIPPED', amount: 0n, reason: '오늘 이미 처리된 사회복지기관' };
    }

    // 회차 생성 → 즉시 승인(자동 정산은 사람 승인 단계가 없다)
    const request = await createSettlementRequest(merchantId, amount, { memo: `자동 정산 ${dateKey}` });
    await prisma.settlementRequest.update({
      where: { id: request.id },
      data: { status: 'APPROVED', auto: true, adminMemo: '자동 정산 배치' },
    });

    // 이 회차가 어떤 결제 건을 지급하는지 못박는다. 나중에 목록을 다시 유도하면
    // 그 사이 환불·신규 결제로 구성이 바뀌어 지급액과 정산 완료 건이 어긋난다.
    await prisma.charge.updateMany({
      where: { id: { in: included }, settlementRequestId: null },
      data: { settlementRequestId: request.id },
    });

    const adapter = getPayoutAdapter();
    // 이체를 시도했다는 사실을 호출 **전에** 남긴다. 여기서 프로세스가 죽어도
    // 회차가 "이체 시도함" 으로 남아야 다음 배치가 같은 돈을 다시 보내지 않는다.
    await prisma.settlementRequest.update({
      where: { id: request.id },
      data: { payoutIssuedAt: new Date() },
    });
    transferAttempted = true;
    let result = await adapter.transfer({
      requestId: request.id,
      merchantName: merchant.displayName,
      bankCode: account.bankCode,
      accountNo: decrypt(account.accountEnc),
      holderName: account.holderMasked ?? merchant.displayName,
      amount: request.payoutAmount,
      memo: `기브싸인 정산 ${dateKey}`,
    });

    // 결과 미확인은 재이체하지 않고 조회로 확정한다.
    if (result.unknown) {
      result = await adapter.inquire(request.id);
    }

    if (!result.ok) {
      await prisma.settlementRequest.update({
        where: { id: request.id },
        data: {
          status: 'PAYOUT_FAILED',
          payoutFailReason: `${result.code ?? 'ERROR'}: ${result.message}`,
        },
      });
      // 멱등키를 지우지 않는다. 지우면 다음 실행이 같은 결제 건으로 **새 회차**를 만들고,
      // 지급대행의 멱등키는 requestId 라 새 회차 = 새 이체가 되어 같은 돈이 두 번 나간다.
      // 재시도는 retryPayout(이 회차 그대로 조회 → 필요할 때만 재이체)으로만 한다.
      await prisma.idempotencyKey
        .update({
          where: { scope_key: { scope: 'payout', key: `${merchantId}:${dateKey}` } },
          data: { status: 'FAILED', resourceId: request.id },
        })
        .catch(() => undefined);
      await notifySuperAdmins({
        title: '자동 정산 지급 실패',
        body: `${merchant.displayName} 사회복지기관의 ${dateKey} 지급이 실패했습니다. 관리자 화면에서 재시도해 주세요. (${result.message})`,
        linkUrl: '/admin/settlements',
      });
      return { status: 'FAILED', amount, reason: result.message, requestId: request.id };
    }

    // 지급 완료: 원장 분개 + 회차 확정 + 포함된 결제 건에 정산 시각 기록(한 트랜잭션)
    await markSettlementPaid(request.id, undefined, result.referenceNo);
    await prisma.idempotencyKey
      .update({
        where: { scope_key: { scope: 'payout', key: `${merchantId}:${dateKey}` } },
        data: { status: 'DONE', resourceId: request.id },
      })
      .catch(() => undefined);

    return { status: 'PAID', amount, requestId: request.id };
  } catch (error) {
    logger.error('자동 정산 실패', { merchantId, transferAttempted, message: (error as Error).message });
    if (transferAttempted) {
      // 이체를 이미 호출했다. 결과를 모르므로 멱등키를 남겨 다음 배치가 다시 보내지 못하게 한다.
      // 사람이 대행사 원장과 대조한 뒤 관리자 화면에서 재시도한다.
      await prisma.idempotencyKey
        .update({
          where: { scope_key: { scope: 'payout', key: `${merchantId}:${dateKey}` } },
          data: { status: 'FAILED' },
        })
        .catch(() => undefined);
      await notifySuperAdmins({
        title: '자동 정산 중단 — 이체 결과 확인 필요',
        body: `${merchantId} 사회복지기관의 ${dateKey} 지급이 이체 호출 이후에 중단되었습니다. 대행사 원장과 대조해 주세요.`,
        linkUrl: '/admin/settlements',
      });
    } else {
      // 이체 전에 끝났다. 아무 것도 나가지 않았으므로 키를 풀어 다음 실행이 정상 처리하게 한다.
      await prisma.idempotencyKey
        .delete({ where: { scope_key: { scope: 'payout', key: `${merchantId}:${dateKey}` } } })
        .catch(() => undefined);
    }
    return { status: 'FAILED', amount: 0n, reason: (error as Error).message };
  }
}

/**
 * 자동 정산 배치.
 * 하루 한 번 도는 것을 전제로 하며, 같은 날 두 번 돌아도 이미 처리된 사회복지기관은 건너뛴다.
 */
export async function runScheduledPayouts(now: Date = new Date()): Promise<PayoutRunResult> {
  const dateKey = toDateKey(now);

  const merchants = await prisma.merchantProfile.findMany({
    where: { status: 'APPROVED', settlementAccount: { verified: true } },
    select: { id: true, displayName: true },
    orderBy: { createdAt: 'asc' },
  });

  const result: PayoutRunResult = {
    dateKey,
    checked: merchants.length,
    paid: 0,
    failed: 0,
    skipped: 0,
    totalPaid: 0n,
    details: [],
  };

  for (const m of merchants) {
    const r = await runMerchantPayout(m.id, now);
    if (r.status === 'PAID') {
      result.paid += 1;
      result.totalPaid += r.amount;
    } else if (r.status === 'FAILED') {
      result.failed += 1;
    } else {
      result.skipped += 1;
    }
    // 건너뛴 건은 로그만 남기고 결과에 담지 않는다(대부분 "지급일 아님"이라 목록이 무의미해진다).
    if (r.status !== 'SKIPPED') {
      result.details.push({
        merchantId: m.id,
        merchantName: m.displayName,
        status: r.status,
        amount: r.amount,
        reason: r.reason,
        requestId: r.requestId,
      });
    }
  }

  if (result.failed > 0) {
    await notifySuperAdmins({
      title: '자동 정산 지급 실패',
      body: `${dateKey} 자동 정산에서 ${result.failed}건이 실패했습니다. 정산 관리에서 확인해 주세요.`,
      linkUrl: '/admin/settlements',
    }).catch(() => undefined);
  }

  logger.info('자동 정산 배치 완료', {
    dateKey,
    checked: result.checked,
    paid: result.paid,
    failed: result.failed,
    totalPaid: result.totalPaid.toString(),
  });

  return result;
}

/**
 * 지급 실패 건 재시도.
 *
 * 재이체 전에 **반드시 조회로 상태를 확인한다.** 실패로 기록됐더라도 대행사 쪽에서
 * 이미 처리된 건일 수 있고, 그대로 다시 이체하면 이중 지급이 된다.
 */
export async function retryPayout(
  requestId: string,
  now: Date = new Date(),
): Promise<{ ok: boolean; message: string }> {
  const request = await prisma.settlementRequest.findUnique({
    where: { id: requestId },
    select: { id: true, merchantId: true, status: true, amount: true, payoutAmount: true },
  });
  if (!request) return { ok: false, message: '정산 회차를 찾을 수 없습니다.' };
  if (request.status === 'PAID') return { ok: false, message: '이미 지급 완료된 회차입니다.' };
  if (request.status !== 'PAYOUT_FAILED') {
    return { ok: false, message: '지급 실패(PAYOUT_FAILED) 상태에서만 재시도할 수 있습니다.' };
  }

  const [merchant, account] = await Promise.all([
    prisma.merchantProfile.findUnique({
      where: { id: request.merchantId },
      select: { displayName: true, status: true },
    }),
    prisma.settlementAccount.findUnique({ where: { merchantId: request.merchantId } }),
  ]);
  if (!merchant || merchant.status !== 'APPROVED') return { ok: false, message: '지급할 수 없는 사회복지기관 상태입니다.' };
  if (!account || !account.verified) return { ok: false, message: '정산 계좌 인증이 완료되지 않았습니다.' };

  const adapter = getPayoutAdapter();

  // 1) 먼저 조회. 이미 성공한 건이면 재이체하지 않고 결과만 반영한다.
  const prior = await adapter.inquire(requestId);
  let result = prior;
  if (!prior.ok && !prior.unknown) {
    // 대행사에도 성공 기록이 없다 → 다시 이체한다.
    //
    // 다만 그 전에 잔액을 다시 본다. 지급 실패와 재시도 사이에 환불이 승인되면
    // 회차에 적힌 금액이 지금 잔액보다 커지고, 그대로 보내면 없는 돈이 나간다.
    // (돈은 아직 나가지 않았으므로 여기서는 경고가 아니라 거절이 맞다)
    const summary = await getSettlementSummary(request.merchantId);
    if (request.amount > summary.balance) {
      const reason =
        `재시도할 수 없습니다 — 지급 요청액 ${request.amount.toString()}원이 현재 잔액 ${summary.balance.toString()}원을 넘습니다. ` +
        '지급 실패 이후 환불이 있었는지 확인하고, 이 회차를 반려한 뒤 새로 요청해 주세요.';
      await prisma.settlementRequest.update({
        where: { id: requestId },
        data: { payoutFailReason: `BALANCE_SHORT: ${reason}` },
      });
      return { ok: false, message: reason };
    }
    result = await adapter.transfer({
      requestId,
      merchantName: merchant.displayName,
      bankCode: account.bankCode,
      accountNo: decrypt(account.accountEnc),
      holderName: account.holderMasked ?? merchant.displayName,
      amount: request.payoutAmount,
      memo: `기브싸인 정산 재시도 ${toDateKey(now)}`,
    });
    if (result.unknown) result = await adapter.inquire(requestId);
  }

  if (!result.ok) {
    await prisma.settlementRequest.update({
      where: { id: requestId },
      data: { payoutFailReason: `${result.code ?? 'ERROR'}: ${result.message}` },
    });
    return { ok: false, message: `재시도 실패 — ${result.message}` };
  }

  // 이 회차에 묶인 결제 건을 정산 완료로 확정하는 것까지 markSettlementPaid 안에서 한다.
  // (목록을 다시 유도하면 실패~재시도 사이에 구성이 바뀌어 지급액과 어긋난다.
  //  환불된 건은 건드리지 않는다 — settlement.markSettlementPaid 주석 참고)
  await markSettlementPaid(requestId, undefined, result.referenceNo);
  return { ok: true, message: '지급을 완료했습니다.' };
}

export interface PayoutDashboard {
  todayKey: string;
  /** 오늘 지급일이 도래한 사회복지기관 수와 금액(수수료 차감 후) */
  scheduled: { merchants: number; amount: bigint };
  /** 오늘 자동 지급이 완료된 회차 */
  paidToday: { count: number; amount: bigint };
  /** 지급 실패로 남아 있는 회차(날짜 무관) */
  failed: Array<{ id: string; merchantId: string; merchantName: string; amount: bigint; reason: string | null; at: Date }>;
  /** 지급 예정 금액이 있는데 계좌 문제로 지급이 보류되는 사회복지기관 */
  blocked: Array<{ merchantId: string; merchantName: string; amount: bigint; reason: string }>;
}

/** 최고관리자 자동 지급 모니터링에 필요한 값을 한 번에 모은다. */
export async function buildPayoutDashboard(now: Date = new Date()): Promise<PayoutDashboard> {
  const todayKey = toDateKey(now);
  const dayStart = new Date(`${todayKey}T00:00:00+09:00`);
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const merchants = await prisma.merchantProfile.findMany({
    where: { status: 'APPROVED' },
    select: {
      id: true,
      displayName: true,
      settlementAccount: { select: { verified: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 200,
  });
  const merchantIds = merchants.map((m) => m.id);

  // 예전에는 사회복지기관마다 findDueCharges 를 불러 200곳이면 600여 쿼리가 나갔다.
  // 이 화면은 force-dynamic 이라 접속할 때마다 반복되고, 배치 시간대와 겹치면 부하가 곱해진다.
  // 필요한 값을 네 번의 집계 쿼리로 한 번에 모은다.
  const [policyRows, chargeRows, ledgerRows, pendingRows] = await Promise.all([
    prisma.feePolicy.findMany({
      where: {
        active: true,
        effectiveFrom: { lte: now },
        OR: [{ scope: 'GLOBAL' }, { scope: 'MERCHANT', merchantId: { in: merchantIds } }],
        AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { scope: true, merchantId: true, settlementDays: true },
    }),
    prisma.charge.findMany({
      where: {
        merchantId: { in: merchantIds },
        status: { in: PAID_STATUSES },
        settledAt: null,
        settlementRequestId: null,
        paidAt: { not: null },
      },
      orderBy: { paidAt: 'asc' },
      select: { id: true, merchantId: true, netAmount: true, paidAt: true },
    }),
    prisma.settlementLedger.groupBy({
      by: ['merchantId'],
      where: { merchantId: { in: merchantIds } },
      _sum: { amount: true },
    }),
    prisma.settlementRequest.groupBy({
      by: ['merchantId'],
      where: {
        merchantId: { in: merchantIds },
        status: { in: ['REQUESTED', 'REVIEWING', 'APPROVED', 'PAYOUT_FAILED'] },
      },
      _sum: { amount: true },
    }),
  ]);

  const globalDays = policyRows.find((p) => p.scope === 'GLOBAL')?.settlementDays ?? 5;
  const daysOf = new Map<string, number>();
  for (const p of policyRows) {
    if (p.scope !== 'MERCHANT' || !p.merchantId) continue;
    if (!daysOf.has(p.merchantId)) daysOf.set(p.merchantId, p.settlementDays);
  }

  const balanceOf = new Map(ledgerRows.map((r) => [r.merchantId, r._sum.amount ?? 0n]));
  const pendingOf = new Map(pendingRows.map((r) => [r.merchantId, r._sum.amount ?? 0n]));

  const chargesOf = new Map<string, DueCharge[]>();
  for (const c of chargeRows) {
    if (!c.paidAt) continue;
    const row: DueCharge = { id: c.id, netAmount: c.netAmount ?? 0n, paidAt: c.paidAt };
    const list = chargesOf.get(c.merchantId);
    if (list) list.push(row);
    else chargesOf.set(c.merchantId, [row]);
  }

  const holidays =
    chargeRows.length > 0 && chargeRows[0].paidAt
      ? await loadHolidaysAround(toDateKey(chargeRows[0].paidAt), todayKey)
      : new Set<string>();

  const minPayout = BigInt(env.payout.minAmount);
  let scheduledMerchants = 0;
  let scheduledAmount = 0n;
  const blocked: PayoutDashboard['blocked'] = [];

  for (const m of merchants) {
    const all = chargesOf.get(m.id);
    if (!all || all.length === 0) continue;

    const days = daysOf.get(m.id) ?? globalDays;
    const due = all.filter((c) => settlementDateFor(toDateKey(c.paidAt), holidays, days) <= todayKey);
    if (due.length === 0) continue;

    // 실제 배치와 같은 규칙으로 담는다(원장 가용 잔액 범위 안에서만).
    const balanceRaw = (balanceOf.get(m.id) ?? 0n) - (pendingOf.get(m.id) ?? 0n);
    const available = balanceRaw < 0n ? 0n : balanceRaw;
    const { amount } = selectPayoutCharges(due, available);
    if (amount <= 0n) continue;

    if (!m.settlementAccount) {
      blocked.push({ merchantId: m.id, merchantName: m.displayName, amount, reason: '정산 계좌 미등록' });
      continue;
    }
    if (!m.settlementAccount.verified) {
      blocked.push({ merchantId: m.id, merchantName: m.displayName, amount, reason: '정산 계좌 인증 대기' });
      continue;
    }
    if (amount < minPayout) {
      blocked.push({
        merchantId: m.id,
        merchantName: m.displayName,
        amount,
        reason: `최소 지급 금액(${env.payout.minAmount}원) 미만 — 다음 회차로 이월`,
      });
      continue;
    }
    scheduledMerchants += 1;
    scheduledAmount += amount;
  }

  const [paidAgg, failedRows] = await Promise.all([
    prisma.settlementRequest.aggregate({
      where: { auto: true, status: 'PAID', paidAt: { gte: dayStart, lt: dayEnd } },
      _count: { _all: true },
      _sum: { payoutAmount: true },
    }),
    prisma.settlementRequest.findMany({
      where: { status: 'PAYOUT_FAILED' },
      orderBy: { requestedAt: 'desc' },
      take: 30,
      select: {
        id: true, merchantId: true, payoutAmount: true, payoutFailReason: true, requestedAt: true,
        merchant: { select: { displayName: true } },
      },
    }),
  ]);

  return {
    todayKey,
    scheduled: { merchants: scheduledMerchants, amount: scheduledAmount },
    paidToday: { count: paidAgg._count._all, amount: paidAgg._sum.payoutAmount ?? 0n },
    failed: failedRows.map((r) => ({
      id: r.id,
      merchantId: r.merchantId,
      merchantName: r.merchant.displayName,
      amount: r.payoutAmount,
      reason: r.payoutFailReason,
      at: r.requestedAt,
    })),
    blocked,
  };
}
