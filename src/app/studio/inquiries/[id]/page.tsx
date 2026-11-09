import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, DataRow, Notice } from '@/components/ui';
import { InlineActionForm } from '@/components/studio/action-form';
import { InquiryReplyForm } from '@/components/studio/inquiry-reply-form';
import { formatKst } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { aiDraftAvailability } from '@/server/services/ai-drafts';
import { INQUIRY_CATEGORY_LABEL, getMerchantInquiry, readHistorySummary, type InquiryCategory } from '@/server/services/inquiry-auto';
import { closeInquiryAsMerchantAction } from '@/app/actions/inquiry-auto';

export const dynamic = 'force-dynamic';

function nowMs() {
  return Date.now();
}

/** 기관 문의 상세 — 대화·지난 이력 요약(숫자·날짜만)·답변(AI 초안은 입력칸 채우기만). 2026-11-12 4차 K4 */
export default async function StudioInquiryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const inq = await getMerchantInquiry(merchantId, id);
  if (!inq) notFound();
  const summary = readHistorySummary(inq.historySummary);
  const overdue = inq.status === 'OPEN' && inq.dueAt && inq.dueAt.getTime() < nowMs();
  const ai = aiDraftAvailability();

  return (
    <>
      <PageHeader title="문의 답변" description={`${inq.contactMasked ?? '후원자'} · 문자 '문의' 로 접수`} />
      <div className="mb-3"><Link href="/studio/inquiries" className="text-[13px] font-semibold text-ink-600 underline">목록으로</Link></div>
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <Card>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Badge tone={inq.status === 'OPEN' ? 'warning' : inq.autoAnsweredAt && inq.status === 'CLOSED' ? 'brand' : 'success'}>
              {inq.status === 'OPEN' ? '답변 필요' : inq.autoAnsweredAt && inq.status === 'CLOSED' ? '자동 답변됨' : inq.status === 'ANSWERED' ? '답변함' : '닫힘'}
            </Badge>
            {inq.autoCategory ? <span className="text-[13px] font-semibold text-ink-700">{INQUIRY_CATEGORY_LABEL[inq.autoCategory as InquiryCategory] ?? inq.autoCategory}{inq.autoCategoryBy === 'LLM' ? ' (AI 분류 — 확인 필요)' : ''}</span> : null}
            {inq.status === 'OPEN' && inq.dueAt ? <span className={`ml-auto text-[12.5px] ${overdue ? 'font-bold text-danger-500' : 'text-ink-500'}`}>처리 기한 {formatKst(inq.dueAt, false)}{overdue ? ' (지남)' : ''}</span> : null}
          </div>
          <div className="mb-5 space-y-2.5">
            {inq.messages.map((m) => (
              <div key={m.id} className={`rounded-2xl px-4 py-3 text-[14px] leading-relaxed ${m.sender === 'USER' ? 'bg-ink-50 text-ink-800' : 'bg-brand-50 text-ink-900'}`}>
                <p className="mb-1 text-[12px] text-ink-400">
                  {m.sender === 'USER' ? '후원자' : m.authorKind === 'AUTO' ? '자동 답변' : m.authorKind === 'MERCHANT' ? '기관 담당자' : '기브싸인 고객센터'} · {formatKst(m.createdAt, false)}
                </p>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            ))}
          </div>
          <InquiryReplyForm inquiryId={inq.id} ai={ai} />
          {inq.status !== 'CLOSED' ? (
            <div className="mt-4 border-t border-ink-100 pt-3">
              <InlineActionForm action={closeInquiryAsMerchantAction} submitLabel="답변 없이 닫기" variant="ghost" fields={{ inquiryId: inq.id }} confirmMessage="답변 없이 닫습니다. 후원자가 다시 쓰면 다시 열립니다." />
            </div>
          ) : null}
        </Card>
        <Card>
          <h2 className="mb-2 text-[15px] font-black text-ink-900">이 기관 안의 지난 이력</h2>
          {summary ? (
            <>
              <DataRow label="후원 완료" value={`${formatNumber(summary.paidCount)}건 · ${formatWon(BigInt(summary.paidAmount))}`} />
              <DataRow label="첫 후원" value={summary.firstPaidOn ?? '-'} />
              <DataRow label="최근 후원" value={summary.lastPaidOn ?? '-'} />
              <DataRow label="진행 중 정기후원" value={`${formatNumber(summary.activeRecurring)}건 · 월 ${formatWon(BigInt(summary.recurringMonthly))}`} />
              <DataRow label="환불 요청" value={`${formatNumber(summary.refundCount)}건`} />
              <DataRow label="발급된 영수증" value={`${formatNumber(summary.receiptsIssued)}장`} />
              <DataRow label="이전 문의 메시지" value={`${formatNumber(summary.previousMessages)}건`} />
              <p className="mt-2 text-[12px] text-ink-400">숫자·날짜만 보여 줍니다. 분류할 때 계산한 값입니다.</p>
            </>
          ) : (
            <p className="text-[13px] text-ink-500">아직 요약이 없습니다(자동 답변으로 닫혔거나 분류 전).</p>
          )}
          <div className="mt-4"><Notice tone="neutral">결제 링크·인증번호는 답변에 쓰지 마세요. 정기후원 변경·해지는 후원자가 문자 &quot;변경&quot;·&quot;해지&quot; 로 직접 할 수 있습니다.</Notice></div>
        </Card>
      </div>
    </>
  );
}
