import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CircleCheck, Lightbulb } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { dateKeyOf, weekLabel, WEEKLY_PLAN_STATUS_LABEL } from '@/lib/weekly-plan';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, LinkButton, Notice, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { ackWeeklyPlanAction, decideWeeklySuggestionAction } from '@/app/actions/weekly';
import { aiDraftAvailability } from '@/server/services/ai-drafts';
import { planApprovalStates, type StoredEvaluation, type StoredSuggestion } from '@/server/services/weekly-plan';

export const dynamic = 'force-dynamic';

const APPROVAL_STATUS_LABEL: Record<string, string> = {
  PENDING: '승인 대기', PROCESSING: '처리 중', QUEUED: '실행 대기', APPROVED: '승인됨', REJECTED: '반려', EXPIRED: '기한 지남', CANCELED: '취소', FAILED: '실행 실패',
};

export default async function WeeklyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const plan = await prisma.weeklyPlan.findFirst({ where: { id, merchantId } });
  if (!plan) notFound();
  const ev = plan.evaluation as unknown as StoredEvaluation;
  const sugg = (plan.suggestions as unknown as StoredSuggestion[]) ?? [];
  const states = await planApprovalStates(plan.id, sugg);
  const ai = aiDraftAvailability();
  const m = ev.metrics;
  const lines = ev.polished ?? ev.lines;

  return (
    <div className="space-y-4">
      <Link href="/studio/weekly" className="text-[13px] font-bold text-ink-500">← 주간 운영 보고</Link>
      <PageHeader
        title={`주간 운영 보고 · ${weekLabel(dateKeyOf(plan.weekStart))}`}
        description={`지난주(${m.from} ~ ${m.to}) 결과와 이번 주 제안입니다.`}
        action={<Badge tone={plan.status === 'ACKED' ? 'success' : 'brand'}>{WEEKLY_PLAN_STATUS_LABEL[plan.status] ?? plan.status}</Badge>}
      />
      {plan.generatedBy === 'RULES' ? (
        <Notice tone="neutral" title="규칙 문장">{ai.available ? 'AI 문장 다듬기에 실패해 규칙 문장으로 보여 드립니다.' : 'AI 공급자 연결 후 문장 다듬기 — 지금은 규칙으로 만든 문장입니다.'} 숫자는 모두 원천 기록에서 계산했습니다.</Notice>
      ) : (
        <Notice tone="neutral" title="AI 가 다듬은 문장">문장만 AI 가 다듬었고 숫자는 원천 기록에서 계산한 값 그대로입니다.</Notice>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="지난주 후원" value={`${formatNumber(m.donations.count)}건`} sub={formatWon(BigInt(m.donations.amount))} tone="brand" />
        <StatTile label="신규 후원자" value={`${formatNumber(m.newDonors)}명`} />
        <StatTile label="정기 신규 · 해지 · 정지 · 복구" value={`${m.recurring.newPledges} · ${m.recurring.canceled} · ${m.recurring.suspended} · ${m.recurring.recovered}`} />
        <StatTile label="승인 대기" value={`${formatNumber(m.pendingApprovals)}건`} tone={m.pendingApprovals ? 'warning' : 'neutral'} />
      </div>

      <Card>
        <h2 className="text-[16px] font-black text-ink-900">지난주 평가</h2>
        <ul className="mt-2 space-y-1.5 text-[14px] text-ink-700">{lines.map((l, i) => <li key={i}>· {l}</li>)}</ul>
        <dl className="mt-3 grid gap-x-4 gap-y-1 text-[12.5px] text-ink-500 sm:grid-cols-2">
          <div>문자 후원 완료율: {m.funnel.rate === null ? '측정 기록 없음' : `${m.funnel.rate}% (${m.funnel.paid}/${m.funnel.started})`}</div>
          <div>콘텐츠: 게시 {m.content.published}건 · 클릭 {formatNumber(m.content.clicks)}회 · 후원 {m.content.donations}건 {formatWon(BigInt(m.content.amount))}</div>
          <div>전자문서 완료율: {m.documents.rate === null ? '보낸 문서 없음' : `${m.documents.rate}% (${m.documents.completed}/${m.documents.sent})`}</div>
          <div>정기 출금 조치 필요: {m.recurring.actionRequired}명</div>
        </dl>
      </Card>

      {ev.goals.length ? (
        <Card>
          <h2 className="text-[16px] font-black text-ink-900">기관 목표 (보고 시점)</h2>
          <ul className="mt-2 space-y-1 text-[13px] text-ink-700">{ev.goals.map((g) => <li key={g.id}>· {g.sentence} ({g.percent}%)</li>)}</ul>
        </Card>
      ) : null}

      <Card>
        <h2 className="flex items-center gap-1.5 text-[16px] font-black text-ink-900"><Lightbulb size={18} strokeWidth={1.7} />이번 주 제안</h2>
        {sugg.length === 0 ? <p className="mt-2 text-[13px] text-ink-400">이번 주 제안이 없습니다.</p> : null}
        <ul className="mt-2 divide-y divide-ink-100">
          {sugg.map((s) => {
            const st = states.get(s.key);
            return (
              <li key={s.key} className="py-3">
                <p className="text-[14px] font-bold text-ink-900">{s.polished ?? s.title}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-500">{s.detail}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {s.href ? <LinkButton href={s.href} variant="ghost" size="sm">{s.type === 'NOTICE' ? '기존 안내 경로로 가기' : '화면 열기'}</LinkButton> : null}
                  {st ? <Badge tone={st.status === 'APPROVED' ? 'success' : st.status === 'PENDING' ? 'warning' : 'neutral'}>{APPROVAL_STATUS_LABEL[st.status] ?? st.status}</Badge> : null}
                  {st?.result ? <span className="text-[12px] text-ink-500">{st.result}</span> : null}
                  {st?.status === 'PENDING' ? (
                    <>
                      <ActionForm action={decideWeeklySuggestionAction} submitLabel={s.type === 'CONTENT_SLOT_ADD' ? '승인 — 캘린더에 반영' : '승인 — 콘텐츠 만들기'} size="sm">
                        <input type="hidden" name="approvalId" value={st.id} />
                        <input type="hidden" name="planId" value={plan.id} />
                        <input type="hidden" name="decision" value="APPROVE" />
                      </ActionForm>
                      <ActionForm action={decideWeeklySuggestionAction} submitLabel="반려" variant="ghost" size="sm">
                        <input type="hidden" name="approvalId" value={st.id} />
                        <input type="hidden" name="planId" value={plan.id} />
                        <input type="hidden" name="decision" value="REJECT" />
                      </ActionForm>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[12px] text-ink-400">승인해도 게시·발송은 일어나지 않습니다. 만든 콘텐츠는 주간 승인 화면에서 다시 승인해야 게시됩니다.</p>
      </Card>

      <Card>
        <h2 className="text-[16px] font-black text-ink-900">보고 발송</h2>
        <p className="mt-1 text-[13px] text-ink-600">
          {plan.reportSentAt
            ? `${formatKst(plan.reportSentAt, false)} ${plan.reportChannel === 'ALIMTALK' ? '알림톡' : '문자'}로 보냄`
            : plan.reportClaimedAt
              ? plan.reportNote ?? '보내지 않음'
              : '월요일 09시에 보냅니다.'}
          {plan.reportSentAt && plan.reportNote ? ` · ${plan.reportNote}` : ''}
        </p>
        {plan.status !== 'ACKED' ? (
          <div className="mt-3">
            <ActionForm action={ackWeeklyPlanAction} submitLabel="확인했습니다" variant="secondary" size="sm">
              <input type="hidden" name="id" value={plan.id} />
            </ActionForm>
          </div>
        ) : (
          <p className="mt-2 flex items-center gap-1 text-[12.5px] text-[#0b7d59]"><CircleCheck size={16} strokeWidth={1.7} />{plan.ackedAt ? formatKst(plan.ackedAt, false) : ''} 확인함</p>
        )}
      </Card>
    </div>
  );
}
