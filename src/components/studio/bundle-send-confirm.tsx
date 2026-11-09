import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { PageHeader } from '@/components/layout/console-shell';
import { Card, CardTitle, DataRow, Input, Notice } from '@/components/ui';
import { ActionForm } from '@/components/studio/action-form';
import { EDocForecastBox } from '@/components/studio/edoc-forecast';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import type { BundleSendPreview } from '@/server/services/document-bundle-approvals';
import { decideApprovalAction } from '@/app/actions/journeys';

/**
 * 문서 묶음 대량 발송 승인 전 확인(2026-11-12 4차 J2·J3) — 대상 수·1명당 문서 수·이용요금 예측.
 * 정보만 보여 준다. 승인하면 QUEUED → 배치가 나눠 보낸다(잔액이 모자라면 멈춘 곳부터 충전 뒤 이어서).
 */
export function BundleSendConfirm({ p }: { p: BundleSendPreview }) {
  const pending = p.approval.status === 'PENDING';
  return (
    <>
      <Link href="/studio/inbox" className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={15} strokeWidth={1.8} />
        승인 대기함으로
      </Link>
      <PageHeader title={p.approval.title} description={`${p.approval.kindLabel} · 요청 ${formatKst(p.approval.createdAt, false)}`} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardTitle>보낼 대상</CardTitle>
          <div className="mt-2 space-y-1">
            <DataRow label="묶음" value={p.bundleName} />
            <DataRow label="대상" value={`${p.targetLabel} ${formatNumber(p.targetCount)}명`} />
            <DataRow label="이미 받은 분(다시 보내지 않음)" value={`${formatNumber(p.alreadySent)}명`} />
            <DataRow label="탈퇴·차단으로 제외" value={`${formatNumber(p.excluded)}명`} />
            <DataRow label="1명당 서명 문서" value={`${p.units}건`} />
          </div>
          {p.samples.length ? <p className="mt-2 text-[11.5px] text-ink-400">예: {p.samples.join(', ')}</p> : null}
        </Card>
        <Card>
          <CardTitle>이용요금 예측</CardTitle>
          <EDocForecastBox forecast={p.forecast} className="mt-2" />
          <p className="mt-2 text-[11.5px] text-ink-400">약정서는 약정 흐름이 이미 보낸 서명 요청을 잇기만 해서 세지 않습니다. 실제 차감은 보내는 순간의 잔액으로 다시 정합니다.</p>
        </Card>
      </div>
      {p.approval.result ? <div className="mt-4"><Notice tone="neutral" title="진행 상황">{p.approval.result}</Notice></div> : null}
      <Card className="mt-4">
        {pending ? (
          <div className="flex flex-wrap items-center gap-2">
            <ActionForm action={decideApprovalAction} submitLabel={`${formatNumber(p.targetCount)}명에게 묶음 보내기 승인`} confirmMessage="승인하면 몇 분 안에 차례로 서명 링크를 보냅니다. 문서마다 이용요금이 차감됩니다.">
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
          <p className="text-[13px] text-ink-500">이미 처리된 요청입니다(상태: {p.approval.status}).</p>
        )}
      </Card>
    </>
  );
}
