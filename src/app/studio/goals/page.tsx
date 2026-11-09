import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatNumber } from '@/lib/money';
import { GOAL_KIND_LABEL, GOAL_KINDS } from '@/lib/weekly-plan';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, EmptyState, Field, Input, LinkButton, Select } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { archiveGoalAction, saveGoalAction } from '@/app/actions/weekly';
import { goalProgress, GOALS_PER_MERCHANT } from '@/server/services/goals';

export const dynamic = 'force-dynamic';

const OUTLOOK_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'brand' | 'neutral' }> = {
  DONE: { label: '달성', tone: 'success' },
  ON_TRACK: { label: '순조로움', tone: 'brand' },
  AT_RISK: { label: '기한 안 어려움', tone: 'warning' },
};

/**
 * 기관 목표 (2026-11-11 G1-1). 진행률은 후원·약정·봉사 신청 기록에서 그때그때 계산한다.
 */
export default async function GoalsPage() {
  const { merchantId } = await requireMerchant();
  const [goals, campaigns] = await Promise.all([
    goalProgress(merchantId),
    prisma.campaign.findMany({ where: { merchantId, status: { in: ['ACTIVE', 'DRAFT'] }, goalAmount: { gt: 0n } }, select: { id: true, title: true }, orderBy: { createdAt: 'desc' }, take: 50 }),
  ]);

  return (
    <>
      <PageHeader
        title="기관 목표"
        description="정기후원자 수·캠페인 모금액·봉사자 수·월 후원액 목표를 정하면 주간 운영 보고가 남은 양과 속도를 알려 드립니다."
        action={<LinkButton href="/studio/weekly" variant="secondary" size="sm">주간 운영 보고</LinkButton>}
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">목표 등록</h2>
          <p className="mt-1 text-[12px] text-ink-400">기관당 {GOALS_PER_MERCHANT}개까지. 캠페인 모금액은 캠페인의 목표액·마감일을 그대로 씁니다. 월 후원액은 매달 말일이 기한입니다.</p>
          <div className="mt-3">
            <ActionForm action={saveGoalAction} submitLabel="목표 등록">
              <Field label="종류" required>
                <Select name="kind" defaultValue="RECURRING_DONORS">{GOAL_KINDS.map((k) => <option key={k} value={k}>{GOAL_KIND_LABEL[k]}</option>)}</Select>
              </Field>
              <Field label="이름 (선택)"><Input name="title" maxLength={60} placeholder="예: 올해 정기후원자 100명" /></Field>
              <Field label="목표 값 (명 또는 원)" hint="캠페인 모금액은 비워 두세요."><Input name="target" inputMode="numeric" placeholder="예: 100" /></Field>
              <Field label="기한" hint="정기후원자 수·봉사자 수에 씁니다."><Input type="date" name="dueOn" /></Field>
              <Field label="캠페인" hint="캠페인 모금액 목표에만 씁니다.">
                <Select name="campaignId" defaultValue="">
                  <option value="">고르지 않음</option>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </Select>
              </Field>
            </ActionForm>
          </div>
        </Card>
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">진행 중인 목표</h2>
          {goals.length === 0 ? (
            <div className="mt-3"><EmptyState title="등록한 목표가 없습니다" /></div>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100">
              {goals.map((g) => {
                const o = g.outlook ? OUTLOOK_LABEL[g.outlook] : null;
                const val = (v: bigint) => (g.unit === 'won' ? `${formatNumber(v)}원` : `${formatNumber(v)}명`);
                return (
                  <li key={g.id} className="py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[14px] font-bold text-ink-900">{g.title} <span className="text-[12px] font-normal text-ink-400">{g.label}</span></span>
                      {o ? <Badge tone={o.tone}>{o.label}</Badge> : null}
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100"><div className={`h-full ${g.outlook === 'AT_RISK' ? 'bg-warning-500' : 'bg-brand-600'}`} style={{ width: `${Math.max(2, g.percent)}%` }} /></div>
                    <p className="mt-1 text-[12.5px] text-ink-600">{val(g.current)} / {val(g.target)} ({g.percent}%){g.dueKey ? ` · 기한 ${g.dueKey}` : ''}</p>
                    <p className="text-[12px] text-ink-500">{g.sentence}</p>
                    <div className="mt-1">
                      <ActionForm action={archiveGoalAction} submitLabel="보관" variant="ghost" size="sm" confirmMessage="이 목표를 보관할까요? 주간 보고에서 빠집니다.">
                        <input type="hidden" name="id" value={g.id} />
                      </ActionForm>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
