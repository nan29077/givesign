import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, DataRow, Input, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { SAMPLE_KIND_LABEL } from '@/lib/document-preflight';
import { receiptBatchPreview } from '@/server/services/receipt-batch-preview';
import { decideApprovalAction } from '@/app/actions/journeys';
import { infoSendPreview } from '@/server/services/impact-legal-approvals';
import { InfoSendConfirm } from '@/components/studio/impact/info-send-confirm';
import { bundleSendPreview } from '@/server/services/document-bundle-approvals';
import { BundleSendConfirm } from '@/components/studio/bundle-send-confirm';

export const dynamic = 'force-dynamic';

/**
 * 기부금영수증 일괄 발급 — 승인 전 확인 (2026-11-09 C1-4).
 * 대상 수·영수증 표본(정상·빈칸·이름이 가장 긴 것)·예상 비용·제외 대상과 이유를 본 뒤 승인한다.
 * 이 화면은 정보만 보여 준다. 실제 발급 대상은 승인 뒤 영수증 대장 규칙으로 다시 정한다.
 */
export default async function ReceiptBatchConfirmPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  // 2026-11-09 3차 H: 사업 결과 보고·연간 통보 발송은 같은 주소의 확인 화면(대상 수·표본·비용)
  const info = await infoSendPreview(merchantId, id);
  if (info) return <InfoSendConfirm p={info} />;
  // 2026-11-12 4차 J: 문서 묶음 대량 발송 — 대상 수·이용요금 예측
  const bundle = await bundleSendPreview(merchantId, id);
  if (bundle) return <BundleSendConfirm p={bundle} />;
  const p = await receiptBatchPreview(merchantId, id);
  if (!p) notFound();
  const pending = p.approval.status === 'PENDING';
  const changed = p.requestedCount != null && p.requestedCount !== p.targetCount;

  return (
    <>
      <Link href="/studio/inbox" className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={15} strokeWidth={1.8} />
        승인 대기함으로
      </Link>
      <PageHeader title={p.approval.title} description={`${p.approval.kindLabel} · 요청 ${formatKst(p.approval.createdAt, false)}`} />

      {!p.issuer.ok ? (
        <div className="mb-4">
          <Notice tone="danger" title="지금은 발급할 수 없습니다">
            빠진 기관 정보: {p.issuer.missing.join(', ')}. 기관 정보에서 채운 뒤 승인해 주세요.
          </Notice>
        </div>
      ) : null}
      {changed ? (
        <div className="mb-4">
          <Notice tone="warning" title="요청 뒤 대상이 바뀌었습니다">
            요청을 만들 때는 {formatNumber(p.requestedCount!)}명이었고 지금은 {formatNumber(p.targetCount)}명입니다. 승인하면 지금 기준으로 발급합니다.
          </Notice>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>발급 대상</CardTitle>
          <div className="mt-2 space-y-1">
            <DataRow label="귀속 연도" value={`${p.taxYear}년`} />
            <DataRow label="대상 후원자" value={`${formatNumber(p.targetCount)}명`} />
            <DataRow label="합계 금액" value={formatWon(p.targetAmount)} />
            <DataRow label="예상 비용" value={p.expectedCost.amount > 0n ? formatWon(p.expectedCost.amount) : '0원'} />
          </div>
          <p className="mt-2 text-[11.5px] text-ink-400">{p.expectedCost.note}</p>
        </Card>

        <Card>
          <CardTitle>제외 대상과 이유</CardTitle>
          {p.excluded.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-400">제외되는 후원자가 없습니다.</p>
          ) : (
            <ul className="mt-2 divide-y divide-ink-100">
              {p.excluded.map((e) => (
                <li key={e.reason} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
                  <span className="font-semibold text-ink-800">{e.label}</span>
                  <span className="text-ink-500">{formatNumber(e.count)}명 · {formatWon(e.amount)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-[11.5px] text-ink-400">영수증 정보가 없는 후원자에게는 승인 대기함 묶음에서 등록 안내를 보낼 수 있습니다.</p>
        </Card>
      </div>

      <Card className="mt-4">
        <CardTitle>영수증 표본</CardTitle>
        <p className="mt-0.5 text-[12px] text-ink-400">실제로 발급될 영수증에 들어갈 값입니다(주민등록번호는 가린 값). 저장·발급하지 않습니다.</p>
        {p.samples.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-400">발급할 대상이 없습니다.</p>
        ) : (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            {p.samples.map((s) => (
              <div key={`${s.kind}:${s.payerLabel}`} className="rounded-xl border border-ink-100 p-3 text-[12.5px]">
                <Badge tone={s.kind === 'blank' ? 'warning' : 'neutral'}>{SAMPLE_KIND_LABEL[s.kind]}</Badge>
                <p className="mt-1.5 text-[11.5px] text-ink-400">{s.payerLabel}</p>
                <dl className="mt-1 space-y-0.5">
                  <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-400">성명</dt><dd className="min-w-0 break-all font-semibold text-ink-900">{s.legalName || <span className="text-warning-500">빈칸</span>}</dd></div>
                  <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-400">주민번호</dt><dd className="font-mono">{s.residentNoMasked || <span className="text-warning-500">빈칸</span>}</dd></div>
                  <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-400">주소</dt><dd className="min-w-0 break-all">{s.address || <span className="text-ink-400">빈칸(선택 항목)</span>}</dd></div>
                  <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-400">금액</dt><dd className="font-semibold">{formatWon(s.amount)} · {formatNumber(s.count)}건</dd></div>
                </dl>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-4">
        {pending ? (
          <div className="flex flex-wrap items-center gap-2">
            <ActionForm
              action={decideApprovalAction}
              submitLabel={`${formatNumber(p.targetCount)}명 영수증 발급 승인`}
              confirmMessage="승인하면 몇 분 안에 차례로 발급합니다. 발급번호는 다시 쓰지 않습니다."
            >
              <input type="hidden" name="id" value={p.approval.id} />
              <input type="hidden" name="decision" value="APPROVE" />
            </ActionForm>
            <ActionForm action={decideApprovalAction} submitLabel="반려" variant="ghost" confirmMessage="반려하면 이번 일괄 발급 요청을 닫습니다.">
              <input type="hidden" name="id" value={p.approval.id} />
              <input type="hidden" name="decision" value="REJECT" />
              <Input name="note" placeholder="반려 사유(선택)" aria-label="반려 사유" className="h-10 w-48" />
            </ActionForm>
          </div>
        ) : (
          <p className="text-[13px] text-ink-500">이미 처리된 요청입니다(상태: {p.approval.status}).</p>
        )}
      </Card>
    </>
  );
}
