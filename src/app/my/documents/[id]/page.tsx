import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePayerContext } from '@/components/my/payer';
import { IssuedDocumentView } from '@/components/documents/issued-document-view';
import { loadIssuedForPayer } from '@/server/services/issued-documents';

export const dynamic = 'force-dynamic';

/** 받은 문서 열람(본인 문서만, 열람 링크 만료와 무관) */
export default async function MyIssuedDocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { payerId } = await requirePayerContext(`/my/documents/${id}`);
  if (!payerId) notFound();
  const loaded = await loadIssuedForPayer(payerId, id);
  if (!loaded.ok || loaded.row.signature) notFound();
  return (
    <div className="space-y-4">
      <Link href="/my/documents" className="text-[13px] font-bold text-ink-500 print:hidden">← 받은 문서</Link>
      <IssuedDocumentView
        snapshot={loaded.snapshot}
        verified={loaded.verified}
        contentHash={loaded.row.contentHash}
        createdAt={loaded.row.createdAt}
        pdfHref={loaded.row.pdfObject ? `/my/documents/${id}/file` : null}
      />
    </div>
  );
}
