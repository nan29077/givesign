import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, DataRow, Input, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { PREFLIGHT_LEVEL_LABEL, SAMPLE_KIND_LABEL, type PreflightLevel } from '@/lib/document-preflight';
import type { InfoSendPreview } from '@/server/services/impact-legal-approvals';
import { decideApprovalAction } from '@/app/actions/journeys';

/**
 * 대량 정보성 문서 발송(사업 결과 보고·연간 통보) 승인 전 확인 — 대상 수·표본 3건·비용 (2026-11-09 3차 H).
 * 이 화면은 정보만 보여 준다. 승인하면 QUEUED → 배치가 나눠 보낸다.
 */
export function InfoSendConfirm({ p }: { p: InfoSendPreview }) {
  const pending = p.approval.status === 'PENDING';
  const changed = p.requestedCount != null && p.requestedCount !== p.targetCount + p.alreadySent && p.requestedCount !== p.targetCount;
  return (
    <>
      <Link href="/studio/inbox" className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={15} strokeWidth={1.8} />
        승인 대기함으로
      </Link>
      <PageHeader title={p.approval.title} description={`${p.approval.kindLabel} · 요청 ${formatKst(p.approval.createdAt, false)}`} />
      {p.blocked ? (
        <div className="mb-4"><Notice tone="danger" title="지금은 보낼 수 없습니다">{p.blocked}</Notice></div>
      ) : null}
      {changed ? (
        <div className="mb-4"><Notice tone="warning" title="요청 뒤 대상이 바뀌었습니다">요청 때 {formatNumber(p.requestedCount!)}명, 지금 보낼 대상 {formatNumber(p.targetCount)}명입니다. 승인하면 지금 기준으로 보냅니다.</Notice></div>
      ) : null}
      <div className="mb-4">
        <Notice tone="neutral" title="정보성 안내">
          {p.purposeLabel}는 후원금 사용·수입 내용을 알려 드리는 안내입니다. 후원 권유 문구·후원 링크가 없는지 표본에서 확인해 주세요. 안내 문자는 통합 발송 대기열(7일 상한·야간 보류·같은 날 안내 묶음)을 거칩니다.
        </Notice>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>보낼 대상</CardTitle>
          <div className="mt-2 space-y-1">
            <DataRow label="보낼 후원자" value={`${formatNumber(p.targetCount)}명`} />
            <DataRow label="이미 받은 분(다시 보내지 않음)" value={`${formatNumber(p.alreadySent)}명`} />
            <DataRow label="전자문서 이용요금" value={`${formatNumber(p.cost.edocAmount)}원`} />
          </div>
          <p className="mt-2 text-[11.5px] text-ink-400">{p.cost.note}</p>
        </Card>
        <Card>
          <CardTitle>제외 대상과 이유</CardTitle>
          {p.excluded.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-400">제외되는 후원자가 없습니다.</p>
          ) : (
            <ul className="mt-2 divide-y divide-ink-100">
              {p.excluded.map((e) => (
                <li key={e.reason} className="flex items-center justify-between py-2 text-[12.5px]"><span className="font-semibold text-ink-800">{e.label}</span><span className="text-ink-500">{formatNumber(e.count)}명</span></li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card className="mt-4">
        <CardTitle>문서 표본</CardTitle>
        <p className="mt-0.5 text-[12px] text-ink-400">실제로 나갈 문서 내용입니다(정상·빈칸·이름이 가장 긴 표본). 저장·발송하지 않습니다.</p>
        {p.samples.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-400">보낼 대상이 없습니다.</p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {p.samples.map((s) => {
              const lv = PREFLIGHT_LEVEL_LABEL[s.level as PreflightLevel] ?? PREFLIGHT_LEVEL_LABEL.ok;
              return (
                <div key={`${s.kind}:${s.label}`} className="min-w-0 rounded-xl border border-ink-100 p-3 text-[12.5px]">
                  <div className="flex flex-wrap gap-1.5"><Badge tone="neutral">{SAMPLE_KIND_LABEL[s.kind]}</Badge><Badge tone={lv.tone}>{lv.text}</Badge></div>
                  <p className="mt-1.5 text-[11.5px] text-ink-400">{s.label}</p>
                  {s.issues.length ? <ul className="mt-1 list-disc pl-4 text-[11.5px] text-warning-500">{s.issues.map((m) => <li key={m}>{m}</li>)}</ul> : null}
                  {s.html ? <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-ink-50 p-2 text-[12px] leading-relaxed" dangerouslySetInnerHTML={{ __html: s.html }} /> : null}
                </div>
              );
            })}
          </div>
        )}
      </Card>
      <Card className="mt-4">
        {pending ? (
          <div className="flex flex-wrap items-center gap-2">
            <ActionForm action={decideApprovalAction} submitLabel={`${formatNumber(p.targetCount)}명에게 보내기 승인`} confirmMessage="승인하면 몇 분 안에 차례로 보냅니다. 같은 후원자에게는 한 번만 보냅니다.">
              <input type="hidden" name="id" value={p.approval.id} />
              <input type="hidden" name="decision" value="APPROVE" />
            </ActionForm>
            <ActionForm action={decideApprovalAction} submitLabel="반려" variant="ghost" confirmMessage="반려하면 이번 발송 요청을 닫습니다.">
              <input type="hidden" name="id" value={p.approval.id} />
              <input type="hidden" name="decision" value="REJECT" />
              <Input name="note" placeholder="반려 사유(선택)" aria-label="반려 사유" className="h-10 w-48" />
            </ActionForm>
          </div>
        ) : (
          <p className="text-[13px] text-ink-500">이미 처리된 요청입니다(상태: {p.approval.status}{p.approval.result ? ` · ${p.approval.result}` : ''}).</p>
        )}
      </Card>
    </>
  );
}
