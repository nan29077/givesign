import Link from 'next/link';
import { AlarmClock, CircleAlert, CircleCheck, Circle, Clock, Layers, Users } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, Input, Notice, StatTile } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { automationReadiness } from '@/server/services/inbox';
import { inboxOverview, type DecoratedInboxGroup, type DecoratedInboxItem } from '@/server/services/inbox-overview';
import { merchantStaffAccounts } from '@/server/services/inbox-assignments';
import { decideApprovalAction, retryApprovalAction } from '@/app/actions/journeys';
import { resolveInboxAssignmentAction, retryJourneyRunAction, runInboxGroupActionAction, saveInboxAssignmentAction } from '@/app/actions/inbox';
import type { InboxAssignment } from '@/generated/prisma/client';

export const dynamic = 'force-dynamic';

/**
 * 승인 대기함 — 예외 해결 화면 (2026-11-09 고도화).
 *
 * 위에서부터: 지금 처리할 일 요약 → 원인별 묶음(같은 원인을 한 줄로, 바로 실행 버튼) → 승인·처리할 일 → 막힌 일 → 기다리는 일.
 * 항목마다 발생 이유·영향받는 후원자 수·관련 금액·기다린 시간·권장 조치를 보이고, 담당·처리 기한을 걸 수 있다.
 * 결과를 모르는 건(게시 결과 미확인 등)은 "다시 실행" 대신 "결과 확인" 으로만 안내한다.
 * 위쪽 준비도는 자동화가 멈추는 이유(빠진 기관 정보·채널·서식)를 보여 준다.
 */
export default async function StudioInboxPage() {
  const { merchantId } = await requireMerchant();
  const [ov, readiness, staff] = await Promise.all([inboxOverview(merchantId), automationReadiness(merchantId), merchantStaffAccounts(merchantId)]);
  const missing = readiness.items.filter((i) => !i.ok);
  const groupsShown = ov.groups;

  return (
    <>
      <PageHeader
        title="승인 대기함"
        description="기브싸인이 자동으로 준비한 일 중 기관의 확인이 필요한 것과, 막힌 일을 원인별로 모았습니다. 위에서부터 처리하면 됩니다."
      />
      <Card className="mb-4 flex flex-wrap items-center gap-3 border-brand-200 bg-brand-50/50">
        <AlarmClock size={20} strokeWidth={1.7} className="shrink-0 text-brand-700" aria-hidden />
        <p className="min-w-0 flex-1 text-[14px] font-black text-ink-900">
          지금 처리할 일 {formatNumber(ov.nowCount)}건
          {ov.overdueCount ? <span className="ml-2 text-[12.5px] font-bold text-danger-500">기한 넘김 {formatNumber(ov.overdueCount)}건</span> : null}
        </p>
        {groupsShown.length ? <span className="text-[12px] text-ink-500">원인별 묶음 {groupsShown.length}개</span> : null}
      </Card>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="승인·처리할 일" value={`${formatNumber(ov.actions.length)}건`} tone={ov.actions.length ? 'warning' : 'success'} />
        <StatTile label="기다리는 일" value={`${formatNumber(ov.waiting.length)}건`} sub="후원자·관리자 차례" />
        <StatTile label="막힌 일" value={`${formatNumber(ov.blocked.length)}건`} tone={ov.blocked.length ? 'danger' : 'neutral'} />
        <StatTile
          label="자동화 준비"
          value={readiness.requiredMissing ? `필수 ${readiness.requiredMissing}개 빠짐` : '필수 항목 완료'}
          tone={readiness.requiredMissing ? 'danger' : 'success'}
          sub={readiness.recommendedMissing ? `권장 ${readiness.recommendedMissing}개` : undefined}
        />
      </div>

      {groupsShown.length ? (
        <Card className="mb-5">
          <h2 className="flex items-center gap-1.5 text-[16px] font-black text-ink-900">
            <Layers size={18} strokeWidth={1.7} aria-hidden /> 원인별로 묶은 일
          </h2>
          <p className="mt-1 text-[12.5px] text-ink-500">같은 이유로 멈춘 일을 한 줄로 묶었습니다. 버튼 하나로 한꺼번에 풀 수 있는 것은 버튼을 두었습니다.</p>
          <ul className="mt-3 space-y-3">
            {groupsShown.map((g) => (
              <GroupCard key={g.key} g={g} staffCount={staff.length} />
            ))}
          </ul>
        </Card>
      ) : null}

      {missing.length ? (
        <Card className="mb-5">
          <h2 className="text-[16px] font-black text-ink-900">자동화 준비도</h2>
          <p className="mt-1 text-[12.5px] text-ink-500">빠진 항목이 있으면 그 부분의 자동화가 멈추거나 대체 방식으로 동작합니다.</p>
          <ul className="mt-3 divide-y divide-ink-100">
            {readiness.items.map((i) => (
              <li key={i.key} className="flex items-start gap-3 py-2.5">
                {i.ok ? (
                  <CircleCheck size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-success-500" aria-hidden />
                ) : i.required ? (
                  <CircleAlert size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-danger-500" aria-hidden />
                ) : (
                  <Circle size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-300" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-ink-900">
                    {i.label} {!i.ok ? <Badge tone={i.required ? 'danger' : 'neutral'} className="ml-1">{i.required ? '필수' : '권장'}</Badge> : null}
                  </p>
                  {!i.ok && i.impact ? <p className="text-[12px] leading-relaxed text-ink-500">{i.impact}</p> : null}
                </div>
                {!i.ok ? <Link href={i.href} className="shrink-0 text-[12.5px] font-semibold text-brand-700 hover:underline">설정</Link> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <p className="mb-4 text-[12px] text-ink-400">자동화 준비도: 필수·권장 항목이 모두 준비되었습니다.</p>
      )}

      <Section title="승인·처리할 일" empty="지금 처리할 일이 없습니다." items={ov.actions} staffCount={staff.length} />
      <Section title="막힌 일 (최근 14일)" empty="막힌 일이 없습니다." items={ov.blocked} muted staffCount={staff.length} />
      <Section title="기다리는 일" empty="기다리는 일이 없습니다." items={ov.waiting} muted staffCount={staff.length} />

      <Notice tone="neutral">
        자동 안내의 승인 단계와 기준은 <Link href="/studio/journeys" className="font-semibold underline">자동 안내</Link>에서 바꿀 수 있습니다.
        반려한 안내는 그 단계만 건너뛰고, 나머지 단계는 그대로 진행됩니다. 결과를 확인하지 못한 일은 자동으로 다시 하지 않습니다 — 먼저 결과를 확인해 주세요.
      </Notice>
    </>
  );
}

function AssignForm({ itemKey, assignment, staffCount }: { itemKey: string; assignment: InboxAssignment | null; staffCount: number }) {
  const due = assignment?.dueAt ? new Date(assignment.dueAt.getTime() + 9 * 3_600_000).toISOString().slice(0, 16) : '';
  return (
    <details className="group mt-2 rounded-xl bg-ink-50 px-3 py-2 text-[12px]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-semibold text-ink-600">
        <Users size={14} strokeWidth={1.7} aria-hidden />
        {assignment?.dueAt ? `처리 기한 ${formatKst(assignment.dueAt, false)}` : '담당·처리 기한 정하기'}
        {assignment?.memo ? <span className="truncate font-normal text-ink-400">· {assignment.memo}</span> : null}
      </summary>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <ActionForm action={saveInboxAssignmentAction} submitLabel="저장" size="sm" variant="secondary">
          <input type="hidden" name="itemKey" value={itemKey} />
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[11px] text-ink-500">처리 기한</span>
              <Input type="datetime-local" name="dueAt" defaultValue={due} className="h-9 w-[210px]" />
            </label>
            {staffCount > 1 ? (
              <span className="text-[11px] text-ink-400">담당자 지정은 계정이 여럿일 때 쓸 수 있습니다.</span>
            ) : null}
            <label className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[11px] text-ink-500">메모</span>
              <Input name="memo" defaultValue={assignment?.memo ?? ''} maxLength={300} placeholder="예: 금요일까지 연락처 확인" className="h-9 w-[220px] max-w-full" />
            </label>
          </div>
        </ActionForm>
        {assignment ? (
          <ActionForm action={resolveInboxAssignmentAction} submitLabel="처리 완료" size="sm" variant="ghost">
            <input type="hidden" name="itemKey" value={itemKey} />
          </ActionForm>
        ) : null}
      </div>
      <p className="mt-1.5 text-[11px] text-ink-400">기한이 지나면 기관 대표 담당자에게 콘솔 알림을 한 번 보냅니다.</p>
    </details>
  );
}

function GroupCard({ g, staffCount }: { g: DecoratedInboxGroup; staffCount: number }) {
  if (!g.group) {
    return (
      <li className="rounded-2xl border border-ink-100 p-3.5">
        <p className="text-[13px] font-bold text-ink-700">{g.errorLabel ?? '묶음'}</p>
        <p className="text-[12px] text-ink-400">불러오지 못함 — 잠시 뒤 새로 고쳐 주세요. 다른 항목은 그대로 처리할 수 있습니다.</p>
      </li>
    );
  }
  const x = g.group;
  return (
    <li className={`rounded-2xl border p-3.5 ${g.overdue ? 'border-danger-500/50 bg-danger-50/40' : x.severity === 'high' ? 'border-warning-500/40' : 'border-ink-100'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[14px] font-black text-ink-900">{x.title}</p>
        {g.overdue ? <Badge tone="danger">기한 넘김</Badge> : x.severity === 'high' ? <Badge tone="warning">먼저 처리</Badge> : null}
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-700">{x.reason}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-500">
        <span className="inline-flex items-center gap-1"><Users size={13} strokeWidth={1.7} aria-hidden />영향 {formatNumber(x.affectedCount)}명</span>
        {x.amount ? <span>관련 금액 {formatWon(x.amount)}</span> : null}
        <span className="inline-flex items-center gap-1"><Clock size={13} strokeWidth={1.7} aria-hidden />{g.waitedLabel} 기다림</span>
      </div>
      <p className="mt-1.5 text-[12.5px] font-semibold text-brand-800">권장: {x.recommendedAction}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {(x.actions ?? []).map((a) => (
          <ActionForm key={`${a.action}:${JSON.stringify(a.payload ?? {})}`} action={runInboxGroupActionAction} submitLabel={a.label} size="sm" confirmMessage={`「${a.label}」 을(를) 실행합니다.`}>
            <input type="hidden" name="action" value={a.action} />
            {Object.entries(a.payload ?? {}).map(([k, v]) => <input key={k} type="hidden" name={`p_${k}`} value={v} />)}
          </ActionForm>
        ))}
        <Link href={x.href} className="text-[12.5px] font-semibold text-brand-700 hover:underline">{(x.actions ?? []).length ? '자세히' : '결과 확인'}</Link>
      </div>
      <AssignForm itemKey={g.key} assignment={g.assignment} staffCount={staffCount} />
    </li>
  );
}

function Section({ title, items, empty, muted, staffCount }: { title: string; items: DecoratedInboxItem[]; empty: string; muted?: boolean; staffCount: number }) {
  return (
    <Card className="mb-5">
      <h2 className="text-[16px] font-black text-ink-900">
        {title} <span className="text-[13px] font-semibold text-ink-400">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-[13px] text-ink-400">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {items.map((it) => (
            <li key={it.key} className={`rounded-2xl border p-3 ${it.decision.overdue ? 'border-danger-500/50 bg-danger-50/40' : 'border-ink-100'}`}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={muted ? 'neutral' : 'brand'}>{it.kindLabel}</Badge>
                    {it.decision.overdue ? <Badge tone="danger">기한 넘김</Badge> : null}
                    <span className="inline-flex items-center gap-1 text-[12px] text-ink-400">
                      <Clock size={12} strokeWidth={1.7} aria-hidden />{it.decision.waitedLabel} 기다림 · {formatKst(it.at, false)}
                    </span>
                  </div>
                  <p className="mt-1 break-keep text-[13.5px] font-semibold text-ink-900">{it.title}</p>
                  {it.summary ? <p className="text-[12.5px] text-ink-500">{it.summary}</p> : null}
                  <p className="mt-1 text-[12px] text-ink-600">{it.decision.reason}</p>
                  {it.affectedCount || it.amount ? (
                    <p className="text-[12px] text-ink-500">
                      {it.affectedCount ? `영향 ${formatNumber(it.affectedCount)}명` : ''}
                      {it.affectedCount && it.amount ? ' · ' : ''}
                      {it.amount ? `관련 금액 ${formatWon(it.amount)}` : ''}
                    </p>
                  ) : null}
                  <p className="mt-0.5 text-[12px] font-semibold text-brand-800">권장: {it.decision.recommendedAction}</p>
                  {it.error ? <p className="text-[12px] text-danger-500">지난 처리 실패: {it.error}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {it.approvalId && (it.kind === 'RECEIPT_BATCH' || it.kind === 'IMPACT_REPORT_SEND' || it.kind === 'ANNUAL_NOTICE_SEND' || it.kind === 'BUNDLE_SEND') ? (
                    <Link href={`/studio/inbox/approvals/${it.approvalId}`} className="inline-flex h-9 items-center rounded-xl bg-brand-400 px-3 text-[13px] font-bold text-ink-900">
                      확인하고 승인
                    </Link>
                  ) : it.approvalId ? (
                    <>
                      <ActionForm action={decideApprovalAction} submitLabel="승인" size="sm" confirmMessage={`「${it.title}」 을(를) 승인합니다.`}>
                        <input type="hidden" name="id" value={it.approvalId} />
                        <input type="hidden" name="decision" value="APPROVE" />
                      </ActionForm>
                      <ActionForm action={decideApprovalAction} submitLabel="반려" variant="ghost" size="sm" confirmMessage="반려하면 이 단계는 보내지 않습니다.">
                        <input type="hidden" name="id" value={it.approvalId} />
                        <input type="hidden" name="decision" value="REJECT" />
                        <Input name="note" placeholder="반려 사유(선택)" aria-label="반려 사유" className="h-9 w-40" />
                      </ActionForm>
                    </>
                  ) : null}
                  {it.retryApprovalId ? (
                    <ActionForm action={retryApprovalAction} submitLabel="다시 실행" size="sm" confirmMessage="실패한 부분부터 다시 실행합니다. 이미 발급된 건은 다시 발급하지 않습니다.">
                      <input type="hidden" name="id" value={it.retryApprovalId} />
                    </ActionForm>
                  ) : null}
                  {it.retryRunId && !it.decision.resultUnknown ? (
                    <ActionForm action={retryJourneyRunAction} submitLabel="다시 실행" size="sm" confirmMessage="멈춘 단계부터 다시 실행합니다. 이미 보낸 단계는 다시 보내지 않습니다.">
                      <input type="hidden" name="id" value={it.retryRunId} />
                    </ActionForm>
                  ) : null}
                  <Link href={it.href} className="text-[12.5px] font-semibold text-brand-700 hover:underline">{it.decision.resultUnknown ? '결과 확인' : '열기'}</Link>
                </div>
              </div>
              {!muted || it.key.startsWith('run:') || it.key.startsWith('approval-failed:') ? (
                <AssignForm itemKey={it.key} assignment={it.decision.assignment} staffCount={staffCount} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
