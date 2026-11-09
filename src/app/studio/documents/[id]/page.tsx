import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, FileDown, FileText } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, Notice, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { InlineActionForm } from '@/components/studio/action-form';
import { DocumentTemplateForm } from '@/components/studio/document-template-form';
import {
  archiveDocumentTemplateAction,
  restoreDocumentTemplateAction,
  toggleDocumentTemplateActiveAction,
  updateDocumentTemplateAction,
} from '@/app/actions/studio-documents';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import {
  documentStatusLabel, documentTemplateTypeLabel, fieldTypeLabel, parseDocumentFields,
} from '@/server/services/documents';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import type { PdfFontInfo } from '@/lib/pdf-form';
import { fontInfoForBase, layoutMergeTexts, readMediaPdf, templateLayout } from '@/server/services/pdf-form';
import { MergePreview } from '@/components/studio/merge-preview';
import { DOCUMENT_PURPOSE_LABEL } from '@/server/services/purpose-documents';
import { isDocumentPurpose } from '@/server/services/purpose-templates';
import type { ExistingPdfForm } from '@/components/studio/document-file-editor-field';

export const dynamic = 'force-dynamic';

/** 문서 서식 수정. 왼쪽은 폼, 오른쪽은 후원자에게 보이는 모습과 제출 현황. */
export default async function EditDocumentTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;

  const [template, products, recent, counts, purposeOwners] = await Promise.all([
    prisma.documentTemplate.findFirst({ where: { id, merchantId } }),
    prisma.chargeProduct.findMany({
      where: { merchantId, documentTemplateId: id, archivedAt: null },
      select: { id: true, name: true, active: true, amount: true },
      orderBy: { sortOrder: 'asc' },
    }),
    prisma.documentSubmission.findMany({
      where: { merchantId, templateId: id },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, status: true, payerNameMasked: true, submittedAt: true, createdAt: true },
    }),
    prisma.documentSubmission.groupBy({
      by: ['status'],
      where: { merchantId, templateId: id },
      _count: { _all: true },
    }),
    prisma.documentTemplate.findMany({
      where: { merchantId, archivedAt: null, purpose: { not: null }, id: { not: id } },
      select: { name: true, purpose: true },
    }),
  ]);
  if (!template) notFound();

  const fields = parseDocumentFields(template.fields);
  const isFile = template.templateType === 'FILE';

  // 파일 서식: 서식 화면 안에서 바로 원본 미리보기·편집을 하도록 저장된 원본·기록·글꼴 정보를 넘긴다.
  let pdfEditor: ExistingPdfForm | null = null;
  if (isFile && !template.archivedAt) {
    const layout = templateLayout(template.pdfLayout);
    let fonts: PdfFontInfo[] = [];
    const base = template.basePdfUrl ? await readMediaPdf(template.basePdfUrl) : null;
    if (base) fonts = await fontInfoForBase(base, layout).catch(() => []);
    pdfEditor = {
      templateId: template.id,
      basePdfUrl: base ? template.basePdfUrl : null,
      renderedPdfUrl: template.renderedPdfUrl,
      convertedFrom: template.baseConvertedFrom,
      pageCount: template.pdfPageCount,
      layout,
      fonts,
    };
  }
  const countOf = (status: string) => counts.find((c) => c.status === status)?._count._all ?? 0;
  const takenPurposes = Object.fromEntries(purposeOwners.map((o) => [o.purpose!, o.name]));
  const purposeLabel = isDocumentPurpose(template.purpose) ? DOCUMENT_PURPOSE_LABEL[template.purpose] : null;

  return (
    <>
      <Link
        href="/studio/documents"
        className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
      >
        <ChevronLeft size={15} strokeWidth={1.8} />
        문서 관리로
      </Link>

      <PageHeader
        title={template.name}
        description={`${documentTemplateTypeLabel[template.templateType].text} 서식 · 입력 항목 ${fields.length}개${
          template.archivedAt ? ' · 보관됨' : ''
        }`}
      />

      {template.archivedAt ? (
        <div className="space-y-3">
          <Notice tone="warning" title="보관된 서식입니다">
            보관 중에는 수정할 수 없습니다. 아래 [되살리기] 를 눌러 중지 상태로 되돌린 뒤 수정해 주세요.
          </Notice>
          <Card>
            <InlineActionForm
              action={restoreDocumentTemplateAction}
              submitLabel="되살리기"
              variant="secondary"
              fields={{ templateId: template.id }}
              confirmMessage="중지 상태로 되돌립니다. 내용을 확인한 뒤 사용을 켜 주세요."
            />
          </Card>
        </div>
      ) : (
        // 파일 서식은 원본 미리보기·편집이 넓어야 해서 한 줄로 두고, 현황은 아래로 내린다.
        <div className={cx('grid gap-4', isFile ? '' : 'xl:grid-cols-[minmax(0,1fr)_340px]')}>
          <div className="min-w-0">
            <DocumentTemplateForm
              action={updateDocumentTemplateAction}
              templateType={template.templateType}
              template={template}
              fields={fields}
              submitLabel="서식 저장"
              pdfEditor={pdfEditor}
              takenPurposes={takenPurposes}
            />

            <Card className="mt-4">
              <CardTitle>이 서식 관리</CardTitle>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Link
                  href={`/studio/documents/${template.id}/preflight?mode=stress`}
                  className="inline-flex h-9 items-center rounded-xl border border-ink-200 px-3 text-[13px] font-bold text-ink-800 hover:bg-ink-50"
                >
                  점검
                </Link>
                <InlineActionForm
                  action={toggleDocumentTemplateActiveAction}
                  submitLabel={template.active ? '사용 중지' : '사용하기'}
                  variant="secondary"
                  fields={{ templateId: template.id }}
                />
                <InlineActionForm
                  action={archiveDocumentTemplateAction}
                  submitLabel="보관"
                  variant="danger"
                  fields={{ templateId: template.id }}
                  confirmMessage="이 서식을 보관합니다. 연결된 상품이나 작성 대기 문서가 있으면 보관할 수 없습니다."
                />
              </div>
            </Card>
          </div>

          {/* ── 미리보기 · 현황 ─────────────────────────────────── */}
          <aside className={cx('min-w-0 space-y-3', isFile ? 'grid gap-3 md:grid-cols-2 md:space-y-0 xl:grid-cols-3' : 'xl:sticky xl:top-20 xl:self-start')}>
            <MergePreview body={template.body} pdfTexts={isFile ? layoutMergeTexts(template.pdfLayout) : undefined} purposeLabel={purposeLabel} />
            <Card>
              <CardTitle>후원자에게 보이는 모습</CardTitle>
              <p className="mb-3 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
                저장한 값 기준입니다. 작성 링크를 받은 후원자는 이 항목들을 채웁니다.
              </p>

              {template.templateType === 'FILE' ? (
                <div className="flex items-center gap-2 rounded-xl border border-ink-100 bg-ink-50 px-3 py-2.5">
                  <FileText size={16} strokeWidth={1.7} className="shrink-0 text-brand-700" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-800">
                    {template.fileName ?? '서식 파일'}
                  </span>
                  {template.renderedPdfUrl || template.basePdfUrl ? (
                    <a
                      href={`${template.renderedPdfUrl ?? template.basePdfUrl}?name=${encodeURIComponent(`${template.name}.pdf`)}`}
                      className="flex shrink-0 items-center gap-1 text-[11px] font-bold text-brand-700 hover:underline"
                    >
                      <FileDown size={13} strokeWidth={1.7} />
                      {template.renderedPdfUrl ? '고친 서식' : '원본 서식'}
                    </a>
                  ) : (
                    <span className="shrink-0 text-[11px] font-bold text-ink-400">내려받기</span>
                  )}
                </div>
              ) : null}

              {fields.length === 0 ? (
                <p className="mt-2 text-[12.5px] text-ink-400">입력 항목이 없습니다.</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {fields.map((f) => (
                    <li key={f.id} className="flex items-center gap-1.5 text-[12.5px] text-ink-700">
                      <span className="font-semibold">{f.label}</span>
                      <span className="text-[11px] text-ink-400">{fieldTypeLabel[f.type].text}</span>
                      {f.required ? <Badge tone="brand">필수</Badge> : null}
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-3">
                <DataRow label="자필 서명" value={template.requireSignature ? '받음' : '받지 않음'} />
                <DataRow label="사용 여부" value={template.active ? '사용 중' : '중지'} />
                <DataRow label="자동 발송" value={purposeLabel ? `${purposeLabel} · ${template.autoSend ? '사용' : '끔'}` : '쓰지 않음'} />
                <DataRow label="등록" value={formatKst(template.createdAt, false)} />
              </div>
            </Card>

            <Card>
              <CardTitle>연결된 상품</CardTitle>
              {products.length === 0 ? (
                <p className="mt-2 text-[12.5px] leading-relaxed text-ink-400">
                  아직 없습니다.{' '}
                  <Link href="/studio/products?tab=document" className="font-bold text-brand-700">
                    후원 항목 관리
                  </Link>{' '}
                  에서 문서 상품을 만들고 이 서식을 연결해 주세요.
                </p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {products.map((p) => (
                    <li key={p.id} className="flex items-center gap-1.5 text-[12.5px]">
                      <Link href={`/studio/products/${p.id}`} className="font-semibold text-ink-800 hover:underline">
                        {p.name}
                      </Link>
                      {p.active ? <Badge tone="success">노출</Badge> : <Badge tone="neutral">숨김</Badge>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card>
              <CardTitle>제출 현황</CardTitle>
              <div className="mt-2">
                <DataRow label="작성 대기" value={`${formatNumber(countOf('DRAFT'))}건`} />
                <DataRow label="제출 완료" value={`${formatNumber(countOf('SUBMITTED'))}건`} />
                <DataRow label="확인 완료" value={`${formatNumber(countOf('REVIEWED'))}건`} />
              </div>

              {recent.length > 0 ? (
                <ul className="mt-3 space-y-1.5">
                  {recent.map((s) => (
                    <li key={s.id} className="flex items-center gap-1.5 text-[12px]">
                      <Badge tone={documentStatusLabel[s.status].tone}>{documentStatusLabel[s.status].text}</Badge>
                      <Link
                        href={`/studio/documents/submissions/${s.id}`}
                        className="min-w-0 flex-1 truncate font-semibold text-ink-700 hover:underline"
                      >
                        {s.payerNameMasked ?? '제출자 미확인'}
                      </Link>
                      <span className="shrink-0 text-[11px] text-ink-400">
                        {formatKst(s.submittedAt ?? s.createdAt, false)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </aside>
        </div>
      )}
    </>
  );
}
