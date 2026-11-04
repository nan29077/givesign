import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { Notice } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { PdfFormEditorPage } from '@/components/studio/pdf-form-editor-page';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { fontInfoForBase, readMediaPdf, templateLayout } from '@/server/services/pdf-form';
import type { PdfFontInfo } from '@/lib/pdf-form';

export const dynamic = 'force-dynamic';

export const metadata = { title: '원본 서식 고치기' };

/**
 * 올린 서식 원본 위에서 직접 고치기.
 * 파일 업로드(FILE) 서식이고 편집 바탕 PDF 가 있을 때만 열린다.
 */
export default async function EditDocumentPdfPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const template = await prisma.documentTemplate.findFirst({
    where: { id, merchantId },
    select: {
      id: true, name: true, templateType: true, archivedAt: true, basePdfUrl: true, renderedPdfUrl: true,
      pdfLayout: true, baseConvertedFrom: true, pdfPageCount: true,
    },
  });
  if (!template) notFound();

  const back = (
    <Link
      href={`/studio/documents/${template.id}`}
      className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900"
    >
      <ChevronLeft size={15} strokeWidth={1.8} />
      서식으로
    </Link>
  );

  if (template.archivedAt || template.templateType !== 'FILE' || !template.basePdfUrl) {
    return (
      <>
        {back}
        <PageHeader title="원본 서식 고치기" description={template.name} />
        <Notice tone="warning" title="원본 위에서 고칠 수 없는 서식입니다">
          {template.archivedAt
            ? '보관된 서식은 고칠 수 없습니다. 먼저 되살려 주세요.'
            : template.templateType !== 'FILE'
              ? '파일 업로드 서식만 원본 위에서 고칠 수 있습니다. 직접 작성·기본 서식은 서식 화면에서 본문을 고쳐 주세요.'
              : '편집용 PDF 가 없습니다. 서식 화면에서 파일을 PDF 로 다시 올려 주세요. (한글·워드는 PDF 로 저장해 올리면 원본 글꼴이 그대로 들어갑니다)'}
        </Notice>
      </>
    );
  }

  const layout = templateLayout(template.pdfLayout);
  const base = await readMediaPdf(template.basePdfUrl);
  let fonts: PdfFontInfo[] = [];
  if (base) {
    try {
      fonts = await fontInfoForBase(base, layout);
    } catch {
      fonts = [];
    }
  }

  return (
    <>
      {back}
      <PageHeader
        title="원본 서식 고치기"
        description={`${template.name} · ${template.pdfPageCount ?? '?'}쪽 · 올린 원본 위에 원래 글꼴·크기로 고칩니다. 원본 파일은 그대로 보관됩니다.`}
      />
      {!base ? (
        <Notice tone="warning" title="원본 PDF 를 찾을 수 없습니다">
          저장소에서 원본 파일을 읽지 못했습니다. 서식 화면에서 파일을 다시 올려 주세요.
        </Notice>
      ) : (
        <PdfFormEditorPage
          templateId={template.id}
          templateName={template.name}
          basePdfUrl={template.basePdfUrl}
          renderedPdfUrl={template.renderedPdfUrl}
          initialLayout={layout}
          fonts={fonts}
          convertedFrom={template.baseConvertedFrom}
        />
      )}
    </>
  );
}
