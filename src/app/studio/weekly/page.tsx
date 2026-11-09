import Link from 'next/link';
import { ChevronRight, Target } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatNumber, formatWon } from '@/lib/money';
import { dateKeyOf, weekLabel, WEEKLY_PLAN_STATUS_LABEL } from '@/lib/weekly-plan';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Checkbox, EmptyState, LinkButton, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { weeklyReportSettingAction } from '@/app/actions/weekly';
import { goalProgress } from '@/server/services/goals';
import { weeklyReportEnabled, type StoredEvaluation, type StoredSuggestion } from '@/server/services/weekly-plan';

export const dynamic = 'force-dynamic';

/**
 * 주간 운영 보고 (2026-11-11 G1) — 매주 월요일 07시에 만든 지난주 평가·이번 주 제안. 모바일은 한 장 요약 → 자세히.
 */
export default async function WeeklyPage() {
  const { merchantId } = await requireMerchant();
  const [plans, enabled, goals] = await Promise.all([
    prisma.weeklyPlan.findMany({ where: { merchantId }, orderBy: { weekStart: 'desc' }, take: 12 }),
    weeklyReportEnabled(merchantId),
    goalProgress(merchantId),
  ]);
  const latest = plans[0] ?? null;
  const ev = latest ? (latest.evaluation as unknown as StoredEvaluation) : null;
  const sugg = latest ? ((latest.suggestions as unknown as StoredSuggestion[]) ?? []) : [];
  const actionable = sugg.filter((s) => s.approvalId).length;

  return (
    <>
      <PageHeader
        title="주간 운영 보고"
        description="매주 월요일 아침, 지난주 결과와 이번 주에 할 일을 정리해 드립니다. 숫자는 후원·약정 기록에서 바로 계산합니다."
        action={<LinkButton href="/studio/goals" variant="secondary" size="sm">기관 목표</LinkButton>}
      />

      {latest && ev ? (
        <Link href={`/studio/weekly/${latest.id}`} className="card block p-4 transition hover:-translate-y-0.5 sm:p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12px] font-bold text-ink-400">{weekLabel(dateKeyOf(latest.weekStart))}</p>
            <Badge tone={latest.status === 'ACKED' ? 'success' : 'brand'}>{WEEKLY_PLAN_STATUS_LABEL[latest.status] ?? latest.status}</Badge>
          </div>
          <p className="mt-2 text-[20px] font-black text-ink-900">지난주 후원 {formatNumber(ev.metrics.donations.count)}건 · {formatWon(BigInt(ev.metrics.donations.amount))}</p>
          <p className="mt-1 text-[14px] text-ink-600">신규 후원자 {formatNumber(ev.metrics.newDonors)}명 · 승인할 제안 {actionable}건 · 승인 대기 {formatNumber(ev.metrics.pendingApprovals)}건</p>
          <ul className="mt-3 space-y-1 text-[14px] text-ink-700">
            {sugg.slice(0, 3).map((s) => <li key={s.key} className="line-clamp-2">· {s.polished ?? s.title}</li>)}
          </ul>
          <span className="mt-3 inline-flex items-center gap-1 text-[13px] font-bold text-brand-700">자세히 <ChevronRight size={16} strokeWidth={1.7} /></span>
        </Link>
      ) : (
        <EmptyState title="아직 만든 보고가 없습니다" description="매주 월요일 07시에 지난주 결과로 보고를 만듭니다." />
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="flex items-center gap-1.5 text-[16px] font-black text-ink-900"><Target size={18} strokeWidth={1.7} />기관 목표</h2>
          {goals.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-500">목표를 등록하면 보고에 진행률과 남은 양을 함께 보여 드립니다. <Link href="/studio/goals" className="font-bold text-brand-700">목표 등록</Link></p>
          ) : (
            <ul className="mt-3 space-y-3">
              {goals.map((g) => (
                <li key={g.id}>
                  <div className="flex items-center justify-between text-[13px]"><span className="font-bold text-ink-900">{g.title}</span><span className="text-ink-500">{g.percent}%</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink-100"><div className={`h-full ${g.outlook === 'AT_RISK' ? 'bg-warning-500' : 'bg-brand-600'}`} style={{ width: `${Math.max(2, g.percent)}%` }} /></div>
                  <p className="mt-1 text-[12px] text-ink-500">{g.sentence}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">보고 받기</h2>
          <p className="mt-1 text-[12.5px] text-ink-500">월요일 09시에 기관 대표 담당자 휴대폰으로 알림톡(승인 전이면 문자) 1통을 보냅니다. 끄면 문자는 보내지 않고 콘솔에서만 볼 수 있습니다.</p>
          <div className="mt-2">
            <ActionForm action={weeklyReportSettingAction} submitLabel="저장" variant="secondary" size="sm">
              <Checkbox name="enabled" defaultChecked={enabled} label="월요일 운영 보고 받기" />
            </ActionForm>
          </div>
        </Card>
      </div>

      <h2 className="mt-6 mb-2 text-[16px] font-black text-ink-900">지난 보고</h2>
      {plans.length <= 1 ? (
        <p className="text-[13px] text-ink-400">지난 보고가 없습니다.</p>
      ) : (
        <ul className="divide-y divide-ink-100 rounded-2xl border border-ink-100 bg-white">
          {plans.slice(1).map((p) => {
            const e = p.evaluation as unknown as StoredEvaluation;
            return (
              <li key={p.id}>
                <Link href={`/studio/weekly/${p.id}`} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-[13px]">
                  <span className="font-bold text-ink-900">{weekLabel(dateKeyOf(p.weekStart))}</span>
                  <span className="text-ink-500">후원 {formatNumber(e?.metrics?.donations?.count ?? 0)}건 · {WEEKLY_PLAN_STATUS_LABEL[p.status] ?? p.status}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4"><Notice tone="neutral" title="보고는 제안만 합니다">계획의 콘텐츠 제안을 승인해도 바로 게시되거나 후원자에게 문자가 나가지 않습니다. 콘텐츠는 만든 뒤 다시 승인해야 게시되고, 안내 발송은 자동 안내·승인 대기함의 기존 절차를 따릅니다.</Notice></div>
    </>
  );
}
