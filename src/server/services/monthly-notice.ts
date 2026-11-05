import { env } from '@/lib/env';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { kstMonthKey } from '@/lib/datetime';
import { prisma } from '@/server/db';
import { PAID_STATUSES } from '@/components/studio/shared';
import { issueReceiptsBulk, issuerReadiness, doneeVerified } from './receipts';
import { sendMtDetailed } from './charge-flow';
import { decrypt } from '@/lib/crypto';
import * as tpl from './mt-templates';

/**
 * 월간 후원 안내 배치 (/api/cron/monthly-notice, 매월 1일).
 *
 *  - 전월에 후원한 분께 "전월 후원 횟수·금액 + 올해 누적 + 내역·영수증 링크" 를 보낸다.
 *    기관 채널이 알림톡 사용 중이면 알림톡, 아니면 문자(발송 계층이 결정·대체).
 *  - 기관별 영수증 주기가 MONTHLY 이면 안내 전에 발급되지 않은 올해 후원 건으로 영수증을 먼저 발급한다.
 *  - 멱등: (기관, 월) 실행 1행 + (실행, 후원자) 발송 1행. 중간에 멈춘 실행을 다시 돌려도 같은 사람에게 두 번 가지 않는다.
 *  - 동시성: 실행은 lockedAt/lockedBy 조건부 갱신으로 한 곳만 선점하고(TTL 10분), 발송 전에 발송 행(SENDING)을
 *    먼저 만들어 유니크 위반이면 건너뛴다. 수동 실행·배치·더블클릭이 겹쳐도 한 사람에 한 번만 나간다.
 *  - 후원자가 이 기관의 월간 안내를 거부(noticeOptOutAt)했으면 보내지 않는다.
 *  - 발송 실패는 다른 후원자·다른 기관 처리를 막지 않는다.
 */

export function previousMonthKey(now = new Date()): string {
  const [y, m] = kstMonthKey(now).split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** KST 월 경계 [start, end) */
export function monthRange(monthKey: string): { start: Date; end: Date } {
  const [y, m] = monthKey.split('-').map(Number) as [number, number];
  const start = new Date(Date.UTC(y, m - 1, 1, -9));
  const end = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1, -9));
  return { start, end };
}

export interface MonthlyNoticeSummary {
  monthKey: string;
  merchants: number;
  sent: number;
  alimtalk: number;
  fallback: number;
  failed: number;
  skipped: number;
  receiptsIssued: number;
}

export async function runMonthlyNotices(now = new Date(), opts: { merchantId?: string; monthKey?: string } = {}): Promise<MonthlyNoticeSummary> {
  const monthKey = opts.monthKey ?? previousMonthKey(now);
  const merchants = await prisma.merchantProfile.findMany({
    where: {
      status: 'APPROVED',
      monthlyNoticeEnabled: true,
      user: { status: 'ACTIVE', deletedAt: null },
      ...(opts.merchantId ? { id: opts.merchantId } : {}),
    },
    select: { id: true },
  });
  const summary: MonthlyNoticeSummary = { monthKey, merchants: 0, sent: 0, alimtalk: 0, fallback: 0, failed: 0, skipped: 0, receiptsIssued: 0 };
  for (const m of merchants) {
    try {
      const r = await runMerchantNotice(m.id, monthKey);
      if (!r) continue;
      summary.merchants += 1;
      summary.sent += r.sentCount;
      summary.alimtalk += r.alimtalkCount;
      summary.fallback += r.fallbackCount;
      summary.failed += r.failedCount;
      summary.skipped += r.skippedCount;
      summary.receiptsIssued += r.receiptsIssued;
    } catch (e) {
      logger.error('월간 안내 기관 처리 실패', { merchantId: m.id, message: (e as Error).message });
    }
  }
  return summary;
}

/** 실행 선점 유지 시간. 이보다 오래 갱신이 없으면 멈춘 실행으로 보고 다른 실행이 이어받는다. */
export const NOTICE_RUN_LOCK_TTL_MS = 10 * 60_000;
/** 이만큼 보낼 때마다 선점 시각을 갱신한다. */
const HEARTBEAT_EVERY = 20;

async function openRun(merchantId: string, monthKey: string) {
  try {
    return await prisma.noticeRun.create({ data: { id: newId(), merchantId, monthKey } });
  } catch (e) {
    if ((e as { code?: string })?.code !== 'P2002') throw e;
    const existing = await prisma.noticeRun.findUniqueOrThrow({ where: { merchantId_monthKey: { merchantId, monthKey } } });
    // 끝난 실행은 다시 돌리지 않는다. 도중에 멈춘 실행(RUNNING)만 이어서 처리한다.
    return existing.status === 'DONE' ? null : existing;
  }
}

/**
 * 실행 선점. RUNNING 이면서 아무도 잡지 않았거나 선점이 TTL 을 넘긴 경우에만 조건부 갱신으로 잡는다.
 * 수동 "지금 보내기"·더블클릭·배치가 겹쳐도 한 실행만 발송 단계로 들어간다.
 */
async function claimRun(runId: string, owner: string, now = new Date()): Promise<boolean> {
  const r = await prisma.noticeRun.updateMany({
    where: {
      id: runId,
      status: 'RUNNING',
      OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now.getTime() - NOTICE_RUN_LOCK_TTL_MS) } }],
    },
    data: { lockedAt: now, lockedBy: owner },
  });
  return r.count === 1;
}

export type MerchantNoticeOutcome =
  | { outcome: 'ALREADY_DONE'; run: null }
  | { outcome: 'BUSY'; run: null }
  | { outcome: 'RAN'; run: Awaited<ReturnType<typeof prisma.noticeRun.update>> };

/** 기관 한 곳의 월간 안내. 이미 끝났으면 null, 다른 실행이 진행 중이어도 null. */
export async function runMerchantNotice(merchantId: string, monthKey: string) {
  return (await runMerchantNoticeDetailed(merchantId, monthKey)).run;
}

export async function runMerchantNoticeDetailed(merchantId: string, monthKey: string): Promise<MerchantNoticeOutcome> {
  const opened = await openRun(merchantId, monthKey);
  if (!opened) return { outcome: 'ALREADY_DONE', run: null };
  const owner = `${process.pid}:${newId()}`;
  if (!(await claimRun(opened.id, owner))) {
    const cur = await prisma.noticeRun.findUnique({ where: { id: opened.id }, select: { status: true } });
    return cur?.status === 'DONE' ? { outcome: 'ALREADY_DONE', run: null } : { outcome: 'BUSY', run: null };
  }
  try {
    const run = await processRun(opened.id, merchantId, monthKey, owner);
    return { outcome: 'RAN', run };
  } finally {
    // 끝났든 실패했든 내 선점일 때만 푼다(다른 실행이 TTL 뒤 이어받았으면 건드리지 않는다).
    await prisma.noticeRun
      .updateMany({ where: { id: opened.id, lockedBy: owner }, data: { lockedAt: null, lockedBy: null } })
      .catch(() => undefined);
  }
}

async function processRun(runId: string, merchantId: string, monthKey: string, owner: string) {
  const run = await prisma.noticeRun.findUniqueOrThrow({ where: { id: runId } });
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId } });
  const { start, end } = monthRange(monthKey);
  const taxYear = Number(monthKey.slice(0, 4));

  // 월별 영수증 옵션: 안내 전에 미발급 건을 발급한다. 발급 조건(공익법인 확인 등)이 안 되면 건너뛴다.
  let receiptsIssued = run.receiptsIssued;
  if (merchant.receiptCycle === 'MONTHLY' && receiptsIssued === 0) {
    const ready = doneeVerified(merchant) && issuerReadiness(merchant).ok;
    if (ready) {
      try {
        const r = await issueReceiptsBulk(merchantId, taxYear, 'SYSTEM');
        receiptsIssued = r.issued;
      } catch (e) {
        logger.error('월별 영수증 일괄 발급 실패 — 안내는 계속합니다', { merchantId, message: (e as Error).message });
      }
    }
  }

  const monthly = await prisma.charge.groupBy({
    by: ['payerId'],
    where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { not: null }, paidAt: { gte: start, lt: end } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  const payerIds = monthly.map((r) => r.payerId!);
  const yearStart = monthRange(`${taxYear}-01`).start;
  const [yearly, optOuts, done, payers] = await Promise.all([
    prisma.charge.groupBy({
      by: ['payerId'],
      where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { in: payerIds }, paidAt: { gte: yearStart, lt: end } },
      _sum: { amount: true },
    }),
    prisma.payerMerchantLink.findMany({ where: { merchantId, payerId: { in: payerIds }, noticeOptOutAt: { not: null } }, select: { payerId: true } }),
    prisma.noticeDelivery.findMany({ where: { noticeRunId: run.id }, select: { payerId: true } }),
    prisma.payerProfile.findMany({ where: { id: { in: payerIds } }, select: { id: true, phoneEnc: true, blockedAt: true } }),
  ]);
  const yearM = new Map(yearly.map((y) => [y.payerId!, y._sum.amount ?? 0n]));
  const optSet = new Set(optOuts.map((o) => o.payerId));
  const doneSet = new Set(done.map((d) => d.payerId));
  const payerM = new Map(payers.map((p) => [p.id, p]));
  const link = `${env.baseUrl}/my/receipts`;

  const counts = { recipients: 0, sent: 0, alimtalk: 0, fallback: 0, failed: 0, skipped: 0 };
  let handled = 0;
  for (const row of monthly) {
    const payerId = row.payerId!;
    if (doneSet.has(payerId)) continue;
    const payer = payerM.get(payerId);
    const amount = row._sum.amount ?? 0n;
    const skipReason = !payer ? '후원자 없음' : payer.blockedAt ? '이용 제한' : optSet.has(payerId) ? '월간 안내 수신 거부' : null;

    // 발송 전에 (실행, 후원자) 기록을 먼저 만든다. 유니크 위반이면 다른 실행이 이미 맡은 사람이라 건너뛴다.
    // 이 행이 SENDING 으로 남으면(발송 중 프로세스 종료) 다시 보내지 않는다 — 두 번 보내는 것보다 안전하다.
    const deliveryId = newId();
    try {
      await prisma.noticeDelivery.create({
        data: { id: deliveryId, noticeRunId: run.id, payerId, status: skipReason ? 'SKIPPED' : 'SENDING', amount, reason: skipReason },
      });
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') continue;
      logger.warn('월간 안내 발송 기록 실패 — 이 후원자는 건너뜁니다', { message: (e as Error).message });
      continue;
    }
    counts.recipients += 1;
    if (skipReason) {
      counts.skipped += 1;
      continue;
    }

    let status: 'SENT' | 'FAILED' = 'FAILED';
    let channel: string | null = null;
    let mtId: string | null = null;
    try {
      const res = await sendMtDetailed({
        phone: decrypt(payer!.phoneEnc),
        template: tpl.tplMonthlyNotice({
          merchantName: merchant.displayName,
          month: monthKey,
          amount,
          count: row._count._all,
          yearTotal: yearM.get(payerId) ?? amount,
          link,
        }),
        merchantId,
      });
      status = res.ok ? 'SENT' : 'FAILED';
      channel = res.channel;
      mtId = res.id;
      if (res.ok) {
        counts.sent += 1;
        if (res.channel === 'ALIMTALK') counts.alimtalk += 1;
      } else counts.failed += 1;
      if (res.fallback) counts.fallback += 1;
    } catch (e) {
      counts.failed += 1;
      logger.warn('월간 안내 발송 예외', { message: (e as Error).message });
    }
    await prisma.noticeDelivery
      .update({ where: { id: deliveryId }, data: { status, channel, mtMessageId: mtId } })
      .catch((e) => logger.warn('월간 안내 발송 결과 기록 실패', { message: (e as Error).message }));

    handled += 1;
    if (handled % HEARTBEAT_EVERY === 0) {
      await prisma.noticeRun.updateMany({ where: { id: run.id, lockedBy: owner }, data: { lockedAt: new Date() } }).catch(() => undefined);
    }
  }

  return prisma.noticeRun.update({
    where: { id: run.id },
    data: {
      status: 'DONE',
      finishedAt: new Date(),
      recipientCount: { increment: counts.recipients },
      sentCount: { increment: counts.sent },
      alimtalkCount: { increment: counts.alimtalk },
      fallbackCount: { increment: counts.fallback },
      failedCount: { increment: counts.failed },
      skippedCount: { increment: counts.skipped },
      receiptsIssued,
    },
  });
}
