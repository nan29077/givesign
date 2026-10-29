import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { newId } from '@/lib/id';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import type { PayerProfileModel as PayerProfile } from '@/generated/prisma/models';

/** 전체 합계 행 센티널 */
export const ALL = 'ALL';

/** 트랜잭션 클라이언트 (prisma.$transaction 의 콜백 인자) */
export type LimitsTx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
/** 한도 조회에 쓰는 클라이언트 (전역 prisma 또는 트랜잭션 tx) */
type LimitsClient = typeof prisma | LimitsTx;

/**
 * 한도 / 이상거래 정책 엔진.
 * 정책 우선순위: PAYER > MERCHANT > GLOBAL
 */

export interface EffectivePolicy {
  defaultAmount: bigint;
  minAmount: bigint;
  maxAmount: bigint;
  payerDailyLimit: bigint;
  payerMonthlyLimit: bigint;
  perMerchantDailyLimit: bigint;
  /** 1인(후원자) 1일 최대 결제 건수 */
  payerDailyMaxCount: number;
  velocityWindowSec: number;
  velocityMaxCount: number;
  cooldownAfterCount: number;
  cooldownSec: number;
  failureLockThreshold: number;
  newPayerFirstDayLimit: bigint;
  manualReviewAmount: bigint;
}

export const FALLBACK_POLICY: EffectivePolicy = {
  defaultAmount: 3000n,
  minAmount: 1000n,
  maxAmount: 50000n,
  payerDailyLimit: 100000n,
  payerMonthlyLimit: 1000000n,
  perMerchantDailyLimit: 50000n,
  payerDailyMaxCount: 30,
  velocityWindowSec: 60,
  velocityMaxCount: 3,
  cooldownAfterCount: 5,
  cooldownSec: 300,
  failureLockThreshold: 3,
  newPayerFirstDayLimit: 30000n,
  manualReviewAmount: 200000n,
};

type PolicyRow = {
  defaultAmount: bigint; minAmount: bigint; maxAmount: bigint;
  payerDailyLimit: bigint; payerMonthlyLimit: bigint; perMerchantDailyLimit: bigint;
  payerDailyMaxCount: number; velocityWindowSec: number; velocityMaxCount: number; cooldownAfterCount: number; cooldownSec: number;
  failureLockThreshold: number; newPayerFirstDayLimit: bigint; manualReviewAmount: bigint;
};

function pick(row: PolicyRow): EffectivePolicy {
  return {
    defaultAmount: row.defaultAmount,
    minAmount: row.minAmount,
    maxAmount: row.maxAmount,
    payerDailyLimit: row.payerDailyLimit,
    payerMonthlyLimit: row.payerMonthlyLimit,
    perMerchantDailyLimit: row.perMerchantDailyLimit,
    payerDailyMaxCount: row.payerDailyMaxCount,
    velocityWindowSec: row.velocityWindowSec,
    velocityMaxCount: row.velocityMaxCount,
    cooldownAfterCount: row.cooldownAfterCount,
    cooldownSec: row.cooldownSec,
    failureLockThreshold: row.failureLockThreshold,
    newPayerFirstDayLimit: row.newPayerFirstDayLimit,
    manualReviewAmount: row.manualReviewAmount,
  };
}

export async function resolvePolicy(
  merchantId?: string | null,
  payerId?: string | null,
  now: Date = new Date(),
  client: LimitsClient = prisma,
): Promise<EffectivePolicy> {
  const rows = await client.chargeLimitPolicy.findMany({
    where: {
      active: true,
      // 시행일이 아직 오지 않았거나 이미 종료된 정책은 적용하지 않는다.
      // (예약 등록한 미래 정책이 곧바로 적용돼 한도가 바뀌는 사고를 막는다)
      effectiveFrom: { lte: now },
      OR: [
        { scope: 'GLOBAL' },
        ...(merchantId ? [{ scope: 'MERCHANT' as const, merchantId }] : []),
        ...(payerId ? [{ scope: 'PAYER' as const, payerId }] : []),
      ],
      AND: [{ OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });

  const byScope = (s: 'GLOBAL' | 'MERCHANT' | 'PAYER') => rows.find((r) => r.scope === s);
  const chosen = byScope('PAYER') ?? byScope('MERCHANT') ?? byScope('GLOBAL');
  return chosen ? pick(chosen as unknown as PolicyRow) : FALLBACK_POLICY;
}

export type LimitDenyCode =
  | 'AMOUNT_RANGE'
  | 'PAYER_DAILY'
  | 'PAYER_DAILY_COUNT'
  | 'PAYER_MONTHLY'
  | 'MERCHANT_DAILY'
  | 'VELOCITY'
  | 'COOLDOWN'
  | 'LOCKED'
  | 'BLOCKED'
  | 'ACCOUNT_SUSPENDED'
  | 'NEW_DONOR_FIRST_DAY';

export interface LimitCheckResult {
  ok: boolean;
  code?: LimitDenyCode;
  message?: string;
  requiresManualReview: boolean;
  policy: EffectivePolicy;
}

export interface LimitCheckInput {
  payer: Pick<PayerProfile, 'id' | 'userId' | 'dailyLimit' | 'monthlyLimit' | 'lockedUntil' | 'blockedAt' | 'firstSeenAt'>;
  merchantId: string;
  amount: bigint;
  now?: Date;
  /** 사회복지기관이 이 후원자를 차단했는지 */
  blockedByMerchant?: boolean;
  /**
   * 속도 제한(velocity/streak) 카운터를 이번 호출에서 소진할지 여부. 기본 true.
   *
   * 같은 결제 1건에 대해 checkLimits 를 두 번 호출하는 경로(접수 시 + 결제 직전 재검사)에서는
   * 두 번째 호출을 false 로 둬야 한다. 그렇지 않으면 1건이 2건으로 계산돼
   * 설정한 속도 제한의 절반에서 정상 후원자가 차단되고 쿨다운도 두 배 빨리 걸린다.
   */
  consumeVelocity?: boolean;
  /**
   * 결제 판정 트랜잭션. 넘기면 모든 조회를 이 트랜잭션 안에서 수행하고,
   * 한도 집계를 읽기 직전에 후원자 행을 `FOR UPDATE` 로 잠근다.
   * 같은 후원자의 동시 요청은 앞선 트랜잭션이 끝날 때까지 여기서 대기하므로,
   * 두 요청이 같은 집계를 읽고 나란히 통과하는 일이 생기지 않는다.
   */
  tx?: LimitsTx;
}

/**
 * 후원자 행 잠금 (`SELECT ... FOR UPDATE`).
 * payer_profile 행은 항상 존재하므로 집계 행이 아직 없어도 직렬화 지점이 된다.
 * (charge_counter 를 잠그면 첫 결제처럼 행이 없을 때 아무것도 잠기지 않는다)
 */
async function lockPayerRow(tx: LimitsTx, payerId: string) {
  await tx.$queryRawUnsafe('SELECT id FROM payer_profile WHERE id = $1 FOR UPDATE', payerId);
}

async function readCounter(
  client: LimitsClient,
  payerId: string,
  merchantId: string,
  periodType: string,
  periodKey: string,
) {
  const row = await client.chargeCounter.findUnique({
    where: {
      payerId_merchantId_periodType_periodKey: { payerId, merchantId, periodType, periodKey },
    },
  });
  return { count: row?.count ?? 0, amount: row?.amount ?? 0n };
}

export async function checkLimits(input: LimitCheckInput): Promise<LimitCheckResult> {
  const now = input.now ?? new Date();
  const db: LimitsClient = input.tx ?? prisma;
  const policy = await resolvePolicy(input.merchantId, input.payer.id, now, db);

  // 개인 한도는 정책 한도를 넘지 못한다.
  //
  // 저장 시점에만 검사하면, 후원자가 한도를 올려 둔 뒤 관리자가 전역 정책을 낮췄을 때
  // 그 후원자에게는 낮춘 한도가 적용되지 않는다(리스크 대응으로 한도를 내려도 무력화된다).
  const clamp = (mine: bigint | null, cap: bigint) => (mine !== null && mine < cap ? mine : cap);
  const payerDaily = clamp(input.payer.dailyLimit, policy.payerDailyLimit);
  const payerMonthly = clamp(input.payer.monthlyLimit, policy.payerMonthlyLimit);

  const deny = (code: LimitDenyCode, message: string): LimitCheckResult => ({
    ok: false, code, message, requiresManualReview: false, policy,
  });

  if (input.blockedByMerchant) return deny('BLOCKED', '사회복지기관이 차단한 후원자입니다.');
  if (input.payer.blockedAt) return deny('BLOCKED', '이용이 제한된 후원자입니다.');
  // 회원 계정 제재(User.status)는 웹 로그인만 막을 뿐 문자후원을 막지 못했다.
  // 관리자가 /admin/users 에서 정지시킨 계정이 문자로는 계속 결제할 수 있으면 제재가 아니다.
  if (input.payer.userId) {
    const linkedUser = await db.user.findUnique({
      where: { id: input.payer.userId },
      select: { status: true, deletedAt: true },
    });
    if (linkedUser && (linkedUser.deletedAt || linkedUser.status !== 'ACTIVE')) {
      return deny('ACCOUNT_SUSPENDED', '이용이 제한된 계정입니다. 고객센터로 문의해 주세요.');
    }
  }
  // 후원자가 /my/blocks 에서 직접 건 차단(payerMerchantLink.payerBlockedAt). 결제 경로 전부에서 막아야 한다.
  // 사회복지기관이 건 차단은 blockedByMerchant(blocked_payer) 로 따로 들어온다.
  const link = await db.payerMerchantLink.findUnique({
    where: { payerId_merchantId: { payerId: input.payer.id, merchantId: input.merchantId } },
    select: { payerBlockedAt: true },
  });
  if (link?.payerBlockedAt) return deny('BLOCKED', '후원자가 차단한 사회복지기관입니다. 내 정보 > 차단 관리에서 해제할 수 있습니다.');
  if (input.payer.lockedUntil && input.payer.lockedUntil > now) {
    return deny('LOCKED', '결제 실패가 반복되어 일시적으로 잠겼습니다. 관리자 해제가 필요합니다.');
  }
  // 허용 범위 = 플랫폼 한도 정책 ∩ 사회복지기관이 결제 페이지 설정에서 정한 범위.
  // 사회복지기관 설정을 보지 않으면, 후원자가 문자로 금액을 지정했을 때
  // 사회복지기관이 정한 상·하한을 그냥 넘어가 버린다.
  const merchantRange = await db.merchantProfile.findUnique({
    where: { id: input.merchantId },
    select: { minAmount: true, maxAmount: true },
  });
  const effMin =
    merchantRange && merchantRange.minAmount > policy.minAmount ? merchantRange.minAmount : policy.minAmount;
  const effMax =
    merchantRange && merchantRange.maxAmount < policy.maxAmount ? merchantRange.maxAmount : policy.maxAmount;

  if (input.amount < effMin || input.amount > effMax) {
    return deny('AMOUNT_RANGE', `결제 금액은 ${effMin}원 ~ ${effMax}원 사이여야 합니다.`);
  }

  const dayKey = kstDateKey(now);
  const monthKey = kstMonthKey(now);

  // 한도 집계를 읽기 직전에 후원자 행을 잠근다.
  // 잠금을 잡은 트랜잭션이 커밋될 때까지 같은 후원자의 다음 요청은 여기서 멈춘다.
  if (input.tx) await lockPayerRow(input.tx, input.payer.id);

  const payerDay = await readCounter(db, input.payer.id, ALL, 'DAY', dayKey);
  if (payerDay.amount + input.amount > payerDaily) {
    return deny('PAYER_DAILY', '일일 결제 한도를 초과했습니다.');
  }

  // 1인 1일 최대 건수 (금액과 별개로 건수 자체를 제한)
  if (payerDay.count + 1 > policy.payerDailyMaxCount) {
    return deny('PAYER_DAILY_COUNT', `하루 최대 ${policy.payerDailyMaxCount}건까지 결제할 수 있습니다.`);
  }

  const payerMonth = await readCounter(db, input.payer.id, ALL, 'MONTH', monthKey);
  if (payerMonth.amount + input.amount > payerMonthly) {
    return deny('PAYER_MONTHLY', '월간 결제 한도를 초과했습니다.');
  }

  const merchantDay = await readCounter(db, input.payer.id, input.merchantId, 'DAY', dayKey);
  if (merchantDay.amount + input.amount > policy.perMerchantDailyLimit) {
    return deny('MERCHANT_DAILY', '해당 사회복지기관에 대한 일일 한도를 초과했습니다.');
  }

  // 신규 후원자 첫날 한도
  if (kstDateKey(input.payer.firstSeenAt) === dayKey && payerDay.amount + input.amount > policy.newPayerFirstDayLimit) {
    return deny('NEW_DONOR_FIRST_DAY', '신규 후원자 첫날 한도를 초과했습니다.');
  }

  // ------------------------------------------------------------------
  // 여기부터는 Redis 를 쓰는 판정(연속 결제 대기·속도 제한)이다.
  //
  // 트랜잭션 안에서는 하지 않는다.
  // 결제 판정(executePayment)은 후원자 행을 FOR UPDATE 로 잠근 채 이 함수를 부르는데,
  // 그 상태로 Redis 응답을 기다리면 DB 잠금과 커넥션을 쥔 채 외부 네트워크에 매달리게 된다.
  // Redis 가 죽지 않고 느려지기만 해도(페일오버, 순단) 인터랙티브 트랜잭션 제한 시간을 넘겨
  // 결제 승인이 통째로 실패하고, 같은 후원자의 다른 요청까지 줄줄이 막힌다. DB 는 멀쩡한데도.
  //
  // 이 두 판정은 접수 시점(트랜잭션 밖)에서 이미 한 번 거친다.
  // 결제 직전 재검사가 반드시 확인해야 하는 것은 DB 집계 기반 한도이고, 그건 위에서 끝냈다.
  // ------------------------------------------------------------------
  if (!input.tx) {
    const cooldownKey = `cooldown:${input.payer.id}`;
    if (await kv.get(cooldownKey)) {
      return deny('COOLDOWN', '연속 결제로 대기 중입니다. 잠시 후 다시 시도해 주세요.');
    }

    if (input.consumeVelocity !== false) {
      // 속도 제한: window 내 최대 건수
      const velocityKey = `velocity:${input.payer.id}:${Math.floor(now.getTime() / (policy.velocityWindowSec * 1000))}`;
      const vCount = await kv.incr(velocityKey, policy.velocityWindowSec);
      if (vCount > policy.velocityMaxCount) {
        return deny('VELOCITY', `${policy.velocityWindowSec}초 내 최대 ${policy.velocityMaxCount}건까지 결제할 수 있습니다.`);
      }

      // 연속 N건 이후 쿨다운 부여
      const streakKey = `streak:${input.payer.id}`;
      const streak = await kv.incr(streakKey, policy.cooldownSec);
      if (streak >= policy.cooldownAfterCount) {
        await kv.set(cooldownKey, '1', policy.cooldownSec);
        await kv.del(streakKey);
      }
    }
  }

  return {
    ok: true,
    requiresManualReview: input.amount >= policy.manualReviewAmount,
    policy,
  };
}

/**
 * 집계 반영.
 * 결제 판정 트랜잭션 안에서 호출하면(client=tx) 잠금이 풀리기 전에 집계가 확정되므로,
 * 뒤이어 대기하던 동시 요청은 갱신된 집계를 보고 한도 초과로 막힌다.
 */
export async function commitCounters(
  payerId: string,
  merchantId: string,
  amount: bigint,
  now = new Date(),
  client: LimitsClient = prisma,
) {
  const dayKey = kstDateKey(now);
  const monthKey = kstMonthKey(now);
  const targets: Array<{ merchantId: string; periodType: string; periodKey: string }> = [
    { merchantId: ALL, periodType: 'DAY', periodKey: dayKey },
    { merchantId: ALL, periodType: 'MONTH', periodKey: monthKey },
    { merchantId, periodType: 'DAY', periodKey: dayKey },
    { merchantId, periodType: 'MONTH', periodKey: monthKey },
  ];

  for (const t of targets) {
    await client.chargeCounter.upsert({
      where: {
        payerId_merchantId_periodType_periodKey: {
          payerId, merchantId: t.merchantId, periodType: t.periodType, periodKey: t.periodKey,
        },
      },
      create: {
        id: newId(), payerId, merchantId: t.merchantId,
        periodType: t.periodType, periodKey: t.periodKey, count: 1, amount,
      },
      update: { count: { increment: 1 }, amount: { increment: amount } },
    });
  }
}

/** 환불 시 집계 되돌림 */
export async function rollbackCounters(
  payerId: string,
  merchantId: string,
  amount: bigint,
  at: Date,
  client: LimitsClient = prisma,
) {
  const dayKey = kstDateKey(at);
  const monthKey = kstMonthKey(at);
  const targets: Array<{ merchantId: string; periodType: string; periodKey: string }> = [
    { merchantId: ALL, periodType: 'DAY', periodKey: dayKey },
    { merchantId: ALL, periodType: 'MONTH', periodKey: monthKey },
    { merchantId, periodType: 'DAY', periodKey: dayKey },
    { merchantId, periodType: 'MONTH', periodKey: monthKey },
  ];
  for (const t of targets) {
    // decrement 만 쓰면 하한이 없어 카운터가 음수까지 내려간다.
    // (한 결제를 두 번 되돌리거나, 예약과 다른 기간 키로 되돌리면 바로 그렇게 된다)
    // 음수 카운터는 그 후원자의 한도를 사실상 늘려 주므로 0 에서 막는다.
    await client.$executeRaw`
      UPDATE "charge_counter"
         SET "count" = GREATEST("count" - 1, 0),
             "amount" = GREATEST("amount" - ${amount}, 0)
       WHERE "payer_id" = ${payerId}
         AND "merchant_id" = ${t.merchantId}
         AND "period_type" = ${t.periodType}
         AND "period_key" = ${t.periodKey}
    `;
  }
}

/**
 * 실패 카운터가 살아 있는 기간. 이 시간이 지난 뒤의 첫 실패는 1 부터 다시 센다.
 *
 * 감쇠가 없으면 몇 달 간격으로 난 잔액부족 3건이 합산되어 1년 잠금이 걸린다.
 * "연속 실패" 를 잡는 장치이므로 시간이 지나면 풀려야 한다.
 */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;

export async function registerFailure(payerId: string, threshold: number) {
  const before = await prisma.payerProfile.findUnique({
    where: { id: payerId },
    select: { failCount: true, lastFailedAt: true },
  });
  const stale =
    !before?.lastFailedAt || Date.now() - before.lastFailedAt.getTime() > FAILURE_WINDOW_MS;

  const payer = await prisma.payerProfile.update({
    where: { id: payerId },
    // 마지막 실패로부터 창(window)이 지났으면 누적을 버리고 1 부터 다시 센다.
    data: stale
      ? { failCount: 1, lastFailedAt: new Date() }
      : { failCount: { increment: 1 }, lastFailedAt: new Date() },
  });
  if (payer.failCount >= threshold) {
    await prisma.payerProfile.update({
      where: { id: payerId },
      // 관리자 해제 전까지 잠금 (충분히 먼 미래)
      data: { lockedUntil: new Date(Date.now() + 365 * 86_400_000) },
    });
    return true;
  }
  return false;
}

export async function clearFailures(payerId: string) {
  await prisma.payerProfile.update({ where: { id: payerId }, data: { failCount: 0, lastFailedAt: null } });
}
