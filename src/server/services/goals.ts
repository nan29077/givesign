import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { addDaysKey, dateColumn, dateKeyOf, goalOutlook, GOAL_KIND_LABEL, GOAL_UNIT, isGoalKind, kstDayStart, type GoalKind } from '@/lib/weekly-plan';
import { PAID_STATUSES } from '@/components/studio/shared';
import { campaignStats } from './fundraising';
import { monthRange } from './monthly-notice';

/**
 * 기관 목표 (2026-11-11 G1-1). 진행률은 항상 원천에서 계산한다(캐시 컬럼 금지).
 *  - 정기후원자 수 = 지금 진행 중(ACTIVE) 정기 약정이 있는 후원자 수
 *  - 캠페인 모금액 = 캠페인 목표액·기간 재사용, 모금액은 charge.campaign_id 기준(절대 규칙 10)
 *  - 봉사자 수 = 시작일 이후 승인·완료된 봉사 신청의 후원자 수(중복 제거)
 *  - 월 후원액 = 이번 달(KST) 결제 성공 합계(테스트 제외). 기관 통장 계좌이체는 합치지 않는다(2차 E 규칙)
 * 속도는 최근 4주 기준 주당 증가량이다.
 */

export class GoalError extends Error {}

const DAY = 86_400_000;
const PACE_WEEKS = 4;
export const GOALS_PER_MERCHANT = 10;

export interface GoalInput {
  kind: string;
  title?: string | null;
  target?: number | string | null;
  campaignId?: string | null;
  dueOn?: string | null;
}

export async function saveGoal(merchantId: string, userId: string, input: GoalInput, id?: string) {
  if (!isGoalKind(input.kind)) throw new GoalError('목표 종류를 골라 주세요.');
  const kind = input.kind;
  const title = (input.title ?? '').trim().slice(0, 60) || null;
  let target = 0n;
  let campaignId: string | null = null;
  let dueOn: Date | null = null;
  if (kind === 'CAMPAIGN_AMOUNT') {
    if (!input.campaignId) throw new GoalError('캠페인을 골라 주세요.');
    const c = await prisma.campaign.findFirst({ where: { id: input.campaignId, merchantId }, select: { id: true, goalAmount: true, status: true } });
    if (!c) throw new GoalError('캠페인을 찾을 수 없습니다.');
    if (c.status === 'ARCHIVED') throw new GoalError('보관된 캠페인은 목표로 쓸 수 없습니다.');
    if (c.goalAmount <= 0n) throw new GoalError('목표액이 없는 캠페인입니다. 캠페인에서 목표액을 먼저 정해 주세요.');
    campaignId = c.id;
  } else {
    const raw = String(input.target ?? '').replace(/[,\s원명]/g, '');
    if (!/^\d{1,13}$/.test(raw) || BigInt(raw) <= 0n) throw new GoalError('목표 값을 숫자로 넣어 주세요.');
    target = BigInt(raw);
    if (kind !== 'MONTHLY_AMOUNT') {
      if (!input.dueOn || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueOn)) throw new GoalError('기한을 골라 주세요.');
      if (input.dueOn < kstDateKey()) throw new GoalError('기한은 오늘 이후로 골라 주세요.');
      dueOn = dateColumn(input.dueOn);
    }
  }
  if (id) {
    const r = await prisma.merchantGoal.updateMany({ where: { id, merchantId, archivedAt: null }, data: { kind, title, target, campaignId, dueOn } });
    if (r.count === 0) throw new GoalError('목표를 찾을 수 없습니다.');
    return prisma.merchantGoal.findUniqueOrThrow({ where: { id } });
  }
  const count = await prisma.merchantGoal.count({ where: { merchantId, archivedAt: null } });
  if (count >= GOALS_PER_MERCHANT) throw new GoalError(`목표는 ${GOALS_PER_MERCHANT}개까지 둘 수 있습니다.`);
  return prisma.merchantGoal.create({
    data: { id: newId(), merchantId, kind, title, target, campaignId, startsOn: dateColumn(kstDateKey()), dueOn, createdBy: userId },
  });
}

export async function archiveGoal(merchantId: string, id: string) {
  const r = await prisma.merchantGoal.updateMany({ where: { id, merchantId, archivedAt: null }, data: { archivedAt: new Date() } });
  if (r.count === 0) throw new GoalError('목표를 찾을 수 없습니다.');
}

export interface GoalProgress {
  id: string;
  kind: GoalKind;
  label: string;
  title: string;
  unit: 'people' | 'won';
  current: bigint;
  target: bigint;
  remaining: bigint;
  /** 0~100 */
  percent: number;
  /** 주당 증가 속도(최근 4주) */
  weeklyPace: number;
  dueKey: string | null;
  weeksLeft: number | null;
  outlook: 'DONE' | 'ON_TRACK' | 'AT_RISK' | null;
  sentence: string;
}

function fmt(unit: 'people' | 'won', v: bigint | number) {
  const n = typeof v === 'bigint' ? v : BigInt(Math.round(v));
  return unit === 'won' ? `${formatNumber(n)}원` : `${formatNumber(n)}명`;
}

async function distinctPayers(where: Parameters<typeof prisma.volunteerApplication.groupBy>[0]['where']) {
  const rows = await prisma.volunteerApplication.groupBy({ by: ['payerId'], where });
  return rows.length;
}

/** 목표 진행률(원천 계산). now 기준. */
export async function goalProgress(merchantId: string, now = new Date()): Promise<GoalProgress[]> {
  const goals = await prisma.merchantGoal.findMany({ where: { merchantId, archivedAt: null }, orderBy: { createdAt: 'asc' } });
  const paceSince = new Date(now.getTime() - PACE_WEEKS * 7 * DAY);
  const todayKey = kstDateKey(now);
  const out: GoalProgress[] = [];
  for (const g of goals) {
    if (!isGoalKind(g.kind)) continue;
    const kind = g.kind;
    const unit = GOAL_UNIT[kind];
    let current = 0n;
    let target = g.target;
    let pace = 0;
    let dueKey: string | null = g.dueOn ? dateKeyOf(g.dueOn) : null;
    let title = g.title ?? GOAL_KIND_LABEL[kind];
    if (kind === 'RECURRING_DONORS') {
      const active = await prisma.recurringDonation.groupBy({ by: ['payerId'], where: { merchantId, status: 'ACTIVE' } });
      current = BigInt(active.length);
      const [created, lost] = await Promise.all([
        prisma.recurringDonation.count({ where: { merchantId, createdAt: { gte: paceSince, lte: now } } }),
        prisma.recurringDonation.count({ where: { merchantId, OR: [{ canceledAt: { gte: paceSince, lte: now } }, { suspendedAt: { gte: paceSince, lte: now } }] } }),
      ]);
      pace = (created - lost) / PACE_WEEKS;
    } else if (kind === 'CAMPAIGN_AMOUNT') {
      const c = g.campaignId ? await prisma.campaign.findFirst({ where: { id: g.campaignId, merchantId }, select: { id: true, title: true, goalAmount: true, endsOn: true } }) : null;
      if (!c) continue;
      title = g.title ?? `${c.title} 모금액`;
      target = c.goalAmount;
      current = (await campaignStats([c.id])).get(c.id)?.raised ?? 0n;
      dueKey = dateKeyOf(c.endsOn);
      const recent = await prisma.charge.aggregate({ where: { merchantId, campaignId: c.id, status: { in: PAID_STATUSES }, isTest: false, paidAt: { gte: paceSince, lte: now } }, _sum: { amount: true } });
      pace = Number(recent._sum.amount ?? 0n) / PACE_WEEKS;
    } else if (kind === 'VOLUNTEERS') {
      const start = kstDayStart(dateKeyOf(g.startsOn));
      current = BigInt(await distinctPayers({ merchantId, status: { in: ['APPROVED', 'COMPLETED'] }, createdAt: { gte: start, lte: now } }));
      pace = (await distinctPayers({ merchantId, status: { in: ['APPROVED', 'COMPLETED'] }, createdAt: { gte: paceSince > start ? paceSince : start, lte: now } })) / PACE_WEEKS;
    } else {
      const ym = kstMonthKey(now);
      const { start, end } = monthRange(ym);
      const sum = await prisma.charge.aggregate({ where: { merchantId, status: { in: PAID_STATUSES }, isTest: false, paidAt: { gte: start, lt: end } }, _sum: { amount: true } });
      current = sum._sum.amount ?? 0n;
      const elapsedDays = Math.max(1, (now.getTime() - start.getTime()) / DAY);
      pace = (Number(current) / elapsedDays) * 7;
      dueKey = addDaysKey(dateKeyOf(new Date(end.getTime() + 9 * 3600_000)), -1);
    }
    const remaining = target > current ? target - current : 0n;
    const weeksLeft = dueKey ? Math.max(0, Math.round(((kstDayStart(addDaysKey(dueKey, 1)).getTime() - now.getTime()) / (7 * DAY)) * 10) / 10) : null;
    const outlook = goalOutlook({ remaining: Number(remaining), weeklyPace: pace, weeksLeft });
    const percent = target > 0n ? Math.min(100, Number((current * 1000n) / target) / 10) : 0;
    let sentence: string;
    if (outlook === 'DONE') sentence = `${title}: 목표 ${fmt(unit, target)} 달성`;
    else {
      const paceText = unit === 'won' ? `주 ${fmt(unit, Math.max(0, pace))}` : `주 ${Math.max(0, Math.round(pace * 10) / 10)}명`;
      const tail = outlook === 'AT_RISK' ? `${paceText} 속도면 기한(${dueKey}) 안에 어려움` : outlook === 'ON_TRACK' ? `${paceText} 속도면 기한 안 달성 예상` : paceText;
      sentence = `${title}: 목표까지 ${fmt(unit, remaining)} 남음, ${tail}`;
    }
    if (dueKey && dueKey < todayKey && outlook !== 'DONE') sentence = `${title}: 기한(${dueKey})이 지났고 ${fmt(unit, remaining)} 남음`;
    out.push({ id: g.id, kind, label: GOAL_KIND_LABEL[kind], title, unit, current, target, remaining, percent, weeklyPace: pace, dueKey, weeksLeft, outlook, sentence });
  }
  return out;
}
