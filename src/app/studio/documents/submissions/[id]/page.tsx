import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, FileText } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, Field, Notice, Textarea } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { DocumentReveal } from '@/components/studio/document-reveal';
import {
  markDocumentReviewedAction,
  resendDocumentLinkAction,
  saveDocumentMemoAction,
} from '@/app/actions/studio-documents';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import {
  DOCUMENT_LINK_TTL_DAYS, documentStatusLabel, documentTemplateTypeLabel, parseDocumentFields,
  documentTemplateSnapshot,
} from '@/server/services/documents';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * 제출된 문서 한 건.
 *
 * 제출자 성명·연락처와 입력값은 가려서 보여 주고, [내용 보기] 를 눌러 열 때마다
 * 감사로그(DOCUMENT_SUBMISSION_VIEW)를 남긴다. 배송지 열람과 같은 기준이다.
 */
export default async function DocumentSubmissionPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;

  const row = await prisma.documentSubmission.findFirst({
    where: { id, merchantId },
    include: {
      template: true,
      charge: {
        select: {
          id: true,
          transactionNo: true,
          amount: true,
          paidAt: true,
          product: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!row) notFound();
  const snapshot = await documentTemplateSnapshot(row.id, row.template);
  row.template = snapshot.template;

  const fields = parseDocumentFields(row.template.fields);
  const label = documentStatusLabel[row.status];
  const isDraft = row.status === 'DRAFT';
  const expired = isDraft && row.expiresAt < new Date();

  return (
    <>
      <Link
        href="/studio/documents?tab=submissions"
        className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
      >
        <ChevronLeft size={15} strokeWidth={1.8} />
        제출된 문서로
      </Link>

      <PageHeader
        title={row.template.name}
        description={`${documentTemplateTypeLabel[row.template.templateType].text} 서식 · ${label.text}`}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {isDraft ? (
            <Notice tone={expired ? 'danger' : 'warning'} title={expired ? '작성 기간이 지났습니다' : '아직 작성하지 않았습니다'}>
              {expired
                ? '후원자가 작성하지 않은 채 링크가 만료되었습니다. 아래 [작성 링크 다시 보내기] 로 새 링크를 보낼 수 있습니다.'
                : `후원자가 작성 링크를 받았지만 아직 제출하지 않았습니다. 링크는 ${formatKst(row.expiresAt, false)} 까지 유효합니다.`}
            </Notice>
          ) : (
            <Card>
              <DocumentReveal
                submissionId={row.id}
                payerNameMasked={row.payerNameMasked}
                payerPhoneMasked={row.payerPhoneMasked}
                fields={fields.map((f) => ({ id: f.id, label: f.label, isCheckbox: f.type === 'CHECKBOX' }))}
              />
            </Card>
          )}

          {row.signatureUrl ? (
            <Card>
              <CardTitle>자필 서명</CardTitle>
              <p className="mb-2 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
                후원자가 작성 화면에서 그린 서명입니다. 공인전자서명은 아닙니다.
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={row.signatureUrl}
                alt="제출자 서명"
                className="h-28 w-full max-w-[380px] rounded-xl border border-ink-100 bg-white object-contain"
              />
            </Card>
          ) : null}

          {row.template.templateType === 'FILE' && row.template.fileUrl ? (
            <Card>
              <CardTitle>서식 파일</CardTitle>
              <p className="mb-2 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
                후원자가 내려받은 원본 서식입니다.
              </p>
              <a
                href={`${row.template.fileUrl}?name=${encodeURIComponent(row.template.fileName ?? '문서서식')}`}
                className="inline-flex items-center gap-2 rounded-xl border border-ink-200 px-3.5 py-2.5 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50"
              >
                <FileText size={15} strokeWidth={1.7} />
                {row.template.fileName ?? '서식 내려받기'}
              </a>
            </Card>
          ) : null}

          {row.template.body ? (
            <Card>
              <CardTitle>문서 본문</CardTitle>
              <p className="mb-2 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
                {snapshot.sha256 ? '작성 요청을 발급한 시점에 고정한 서식 본문입니다. 이후 서식 변경은 이 문서에 반영되지 않습니다.' : '이전 방식으로 발급한 문서의 현재 서식 본문입니다. 제출 당시 본문은 별도 보관 자료를 확인해 주세요.'}
              </p>
              <p className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-xl bg-ink-50 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-700">
                {row.template.body}
              </p>
            </Card>
          ) : null}

          <Card>
            <CardTitle>사회복지기관 메모</CardTitle>
            <p className="mb-3 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
              내부 기록용입니다. 후원자에게 보이지 않습니다.
            </p>
            <ActionForm action={saveDocumentMemoAction} submitLabel="메모 저장" variant="secondary" size="sm">
              <input type="hidden" name="submissionId" value={row.id} />
              <Field label="메모" hint="500자 이내">
                <Textarea
                  name="merchantMemo"
                  rows={3}
                  maxLength={500}
                  defaultValue={row.merchantMemo ?? ''}
                  placeholder="확인 결과·후속 처리 내용을 적어 두세요."
                />
              </Field>
            </ActionForm>
          </Card>
        </div>

        {/* ── 처리 · 결제 정보 ─────────────────────────────────── */}
        <aside className="min-w-0 space-y-3 xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardTitle>처리</CardTitle>
            <div className="mt-2">
              <DataRow label="상태" value={<Badge tone={label.tone}>{label.text}</Badge>} />
              <DataRow label="링크 발급" value={formatKst(row.createdAt, false)} />
              <DataRow label="링크 만료" value={formatKst(row.expiresAt, false)} />
              {row.submittedAt ? <DataRow label="제출" value={formatKst(row.submittedAt)} /> : null}
              {row.reviewedAt ? <DataRow label="확인" value={formatKst(row.reviewedAt)} /> : null}
              {row.submitIp ? <DataRow label="제출 IP" value={row.submitIp} /> : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {row.status === 'SUBMITTED' ? (
                <InlineActionForm
                  action={markDocumentReviewedAction}
                  submitLabel="확인 완료로 표시"
                  variant="primary"
                  fields={{ submissionId: row.id }}
                />
              ) : null}
              {isDraft ? (
                <InlineActionForm
                  action={resendDocumentLinkAction}
                  submitLabel="작성 링크 다시 보내기"
                  variant="secondary"
                  fields={{ submissionId: row.id }}
                  confirmMessage={`새 링크를 문자로 보냅니다. 이전에 보낸 링크는 바로 쓸 수 없게 되고, 새 링크는 ${DOCUMENT_LINK_TTL_DAYS}일간 유효합니다.`}
                />
              ) : null}
            </div>
          </Card>

          <Card>
            <CardTitle>{row.charge ? '연결된 후원 정보' : '전자문서 이용 정보'}</CardTitle>
            {row.charge ? (
              <div className="mt-2">
                <DataRow
                  label="거래번호"
                  value={
                    <Link href={`/studio/charges/${row.charge.id}`} className="font-mono text-[12px] text-brand-700 hover:underline">
                      {row.charge.transactionNo}
                    </Link>
                  }
                />
                <DataRow label="상품" value={row.charge.product?.name ?? '-'} />
                <DataRow label="결제 금액" value={formatWon(row.charge.amount)} />
                <DataRow
                  label="결제 시각"
                  value={row.charge.paidAt ? formatKst(row.charge.paidAt, false) : '-'}
                />
              </div>
            ) : (
              <div className="mt-2 text-[12.5px] leading-6 text-ink-500"><p>후원 결제와 별개로 생성한 기관 전자문서입니다.</p><Link href="/studio/document-billing" className="font-bold text-brand-700 underline">충전·정액 이용 내역 확인</Link>{snapshot.sha256 && <p className="mt-3 break-all font-mono text-[10px]">원본 SHA-256 · {snapshot.sha256}</p>}</div>
            )}
          </Card>
        </aside>
      </div>
    </>
  );
}
