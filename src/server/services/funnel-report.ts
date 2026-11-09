import { prisma } from '@/server/db';
import { Prisma } from '@/generated/prisma/client';
import { FUNNEL_REASONS, FUNNEL_STEPS, type FunnelChannel, type FunnelReason } from './funnel';

/**
 * 문자 후원 단계별 현황 집계 (2026-11-09 B1).
 *
 *  - **측정 시작 이후만** 보여 준다. 이 기능 전의 결제 건은 결제 상태로 거꾸로 추정하지 않는다.
 *  - 묶음(코호트) = 기간 안에 흐름이 시작된 건. 시작 단계는 문자 후원 `MO_RECEIVED`, 웹·QR `AMOUNT_SELECTED`.
 *    시작 단계 기록이 없는 흐름(측정 시작 전에 시작된 건)은 넣지 않는다 — 전환율이 100% 를 넘지 않게.
 *  - 각 단계 수 = 그 단계 **이상** 도달한 흐름 수(흐름별 최고 단계 기준). 끝 상태(FAILED·BLOCKED)는 이유별로 따로 센다.
 *  - 기관·캠페인·채널로 거른다. 기관을 비우면 전 기관 합계(관리자).
 */

export const FUNNEL_STEP_LABEL: Record<(typeof FUNNEL_STEPS)[number], string> = {
  MO_RECEIVED: '문자 수신',
  REPLY_SENT: '안내 문자 발송',
  LINK_OPENED: '링크 열람',
  AMOUNT_SELECTED: '금액·방식 선택',
  AUTH_STARTED: '인증(PIN) 시작',
  PAID: '후원 완료',
};

/** "링크를 연 사람의 42%가 금액 선택 전에 나갔습니다" 문장 재료 */
const WHO: Record<(typeof FUNNEL_STEPS)[number], string> = {
  MO_RECEIVED: '문자를 보낸 사람',
  REPLY_SENT: '안내 문자를 받은 사람',
  LINK_OPENED: '링크를 연 사람',
  AMOUNT_SELECTED: '금액을 고른 사람',
  AUTH_STARTED: '인증을 시작한 사람',
  PAID: '후원을 마친 사람',
};
const BEFORE: Record<(typeof FUNNEL_STEPS)[number], string> = {
  MO_RECEIVED: '',
  REPLY_SENT: '안내 문자를 받기 전에',
  LINK_OPENED: '링크를 열기 전에',
  AMOUNT_SELECTED: '금액 선택 전에',
  AUTH_STARTED: '인증 시작 전에',
  PAID: '후원 완료 전에',
};

export const FUNNEL_REASON_LABEL: Record<FunnelReason, string> = {
  LIMIT: '한도·차단',
  UNREGISTERED: '결제수단 미등록',
  PAYMENT_FAILED: '결제 실패',
  CONTENT_BLOCKED: '내용 차단',
  EXPIRED: '시간 만료',
};

export const FUNNEL_CHANNEL_LABEL: Record<FunnelChannel, string> = { MO: '문자 후원', WEB: '웹 후원', QR: 'QR 후원' };

export interface FunnelReportInput {
  merchantId?: string | null;
  campaignId?: string | null;
  channel?: FunnelChannel;
  since: Date;
  until?: Date;
}

export interface FunnelStepRow {
  step: (typeof FUNNEL_STEPS)[number];
  label: string;
  count: number;
  /** 바로 앞 단계 대비(%). 첫 단계는 null */
  rateFromPrev: number | null;
  /** 첫 단계 대비(%) */
  rateFromStart: number;
}

export interface FunnelReport {
  channel: FunnelChannel;
  since: Date;
  until: Date;
  /** 측정이 처음 시작된 시각(이 범위 전체 기록 중 가장 이른 것). 없으면 아직 기록 없음 */
  measuredSince: Date | null;
  total: number;
  steps: FunnelStepRow[];
  ends: Array<{ step: 'FAILED' | 'BLOCKED'; reason: FunnelReason; label: string; count: number }>;
  /** 끝 상태 없이 멈춘 흐름(진행 중이거나 나간 사람) */
  open: number;
  biggestDrop: { from: string; to: string; lost: number; lostRate: number } | null;
  sentence: string | null;
}

export function stepsFor(channel: FunnelChannel): Array<(typeof FUNNEL_STEPS)[number]> {
  return channel === 'MO' ? [...FUNNEL_STEPS] : ['AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID'];
}

function pct(n: number, d: number) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : 0;
}

export async function funnelReport(input: FunnelReportInput): Promise<FunnelReport> {
  const channel = input.channel ?? 'MO';
  const until = input.until ?? new Date();
  const order = stepsFor(channel);
  const entry = order[0]!;
  const merchantCond = input.merchantId ? Prisma.sql`AND s.merchant_id = ${input.merchantId}` : Prisma.empty;
  const campaignCond = input.campaignId ? Prisma.sql`AND s.campaign_id = ${input.campaignId}` : Prisma.empty;
  const idxCase = Prisma.sql`CASE f.step ${Prisma.join(
    order.map((st, i) => Prisma.sql`WHEN ${st} THEN ${Prisma.raw(String(i))}`),
    ' ',
  )} ELSE -1 END`;

  // 코호트: 기간 안에 시작 단계를 기록한 흐름. 흐름별 최고 단계(정상 단계만)를 센다.
  const reached = await prisma.$queryRaw<Array<{ idx: number; n: bigint }>>`
    WITH cohort AS (
      SELECT s.flow_key FROM funnel_step s
      WHERE s.step = ${entry} AND s.channel = ${channel}
        AND s.occurred_at >= ${input.since} AND s.occurred_at < ${until}
        ${merchantCond} ${campaignCond}
    ), best AS (
      SELECT f.flow_key, MAX(${idxCase}) AS idx
      FROM funnel_step f JOIN cohort c ON c.flow_key = f.flow_key
      GROUP BY f.flow_key
    )
    SELECT idx::int AS idx, COUNT(*)::bigint AS n FROM best GROUP BY idx`;
  const ends = await prisma.$queryRaw<Array<{ step: string; reason: string | null; n: bigint }>>`
    WITH cohort AS (
      SELECT s.flow_key FROM funnel_step s
      WHERE s.step = ${entry} AND s.channel = ${channel}
        AND s.occurred_at >= ${input.since} AND s.occurred_at < ${until}
        ${merchantCond} ${campaignCond}
    )
    SELECT f.step, f.reason, COUNT(DISTINCT f.flow_key)::bigint AS n
    FROM funnel_step f JOIN cohort c ON c.flow_key = f.flow_key
    WHERE f.step IN ('FAILED', 'BLOCKED')
    GROUP BY f.step, f.reason`;
  const first = await prisma.funnelStep.findFirst({
    where: { ...(input.merchantId ? { merchantId: input.merchantId } : {}), channel },
    orderBy: { occurredAt: 'asc' },
    select: { occurredAt: true },
  });

  const byIdx = new Map(reached.map((r) => [Number(r.idx), Number(r.n)]));
  const counts = order.map((_, i) => [...byIdx.entries()].filter(([k]) => k >= i).reduce((a, [, n]) => a + n, 0));
  const total = counts[0] ?? 0;
  const steps: FunnelStepRow[] = order.map((step, i) => ({
    step,
    label: FUNNEL_STEP_LABEL[step],
    count: counts[i]!,
    rateFromPrev: i === 0 ? null : pct(counts[i]!, counts[i - 1]!),
    rateFromStart: pct(counts[i]!, total),
  }));

  let biggestDrop: FunnelReport['biggestDrop'] = null;
  for (let i = 0; i < order.length - 1; i++) {
    const lost = counts[i]! - counts[i + 1]!;
    if (counts[i]! > 0 && lost > 0 && (!biggestDrop || lost > biggestDrop.lost)) {
      biggestDrop = { from: order[i]!, to: order[i + 1]!, lost, lostRate: pct(lost, counts[i]!) };
    }
  }
  const sentence = biggestDrop
    ? `${WHO[biggestDrop.from as (typeof FUNNEL_STEPS)[number]]}의 ${Math.round(biggestDrop.lostRate)}%가 ${BEFORE[biggestDrop.to as (typeof FUNNEL_STEPS)[number]]} 나갔습니다.`
    : null;

  const endRows = ends
    .filter((e): e is { step: 'FAILED' | 'BLOCKED'; reason: FunnelReason; n: bigint } => (e.step === 'FAILED' || e.step === 'BLOCKED') && FUNNEL_REASONS.includes(e.reason as FunnelReason))
    .map((e) => ({ step: e.step, reason: e.reason, label: FUNNEL_REASON_LABEL[e.reason], count: Number(e.n) }))
    .sort((a, b) => b.count - a.count);
  const paid = counts[counts.length - 1] ?? 0;
  const endedFlows = ends.reduce((a, e) => a + Number(e.n), 0);

  return {
    channel,
    since: input.since,
    until,
    measuredSince: first?.occurredAt ?? null,
    total,
    steps,
    ends: endRows,
    open: Math.max(0, total - paid - endedFlows),
    biggestDrop,
    sentence,
  };
}
