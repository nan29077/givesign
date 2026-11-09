import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DonorShell } from '@/components/public/donor-shell';
import { IssuedDocumentView } from '@/components/documents/issued-document-view';
import { loadIssuedForPayer } from '@/server/services/issued-documents';
import { loadMemberSelf } from '../../_member';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '받은 문서', robots: { index: false } };

/** 기관 후원 회원 — 받은 문서 열람(이 기관 문서만, 열람 링크 만료와 무관) */
export default async function DonorIssuedDocumentPage({ params }: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await params;
  const { ctx, me, base, scope } = await loadMemberSelf(code, `/documents/${id}`);
  if (!scope) notFound();
  const loaded = await loadIssuedForPayer(scope.payerId, id);
  if (!loaded.ok || loaded.row.signature || loaded.row.merchantId !== scope.merchantId) notFound();
  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-4 px-4 pt-6 sm:px-7">
        <Link href={`${base}/my/documents`} className="text-[15px] font-bold text-ink-500 print:hidden">받은 문서로</Link>
        <IssuedDocumentView
          snapshot={loaded.snapshot}
          verified={loaded.verified}
          contentHash={loaded.row.contentHash}
          createdAt={loaded.row.createdAt}
          pdfHref={loaded.row.pdfObject ? `${base}/my/documents/${id}/file` : null}
        />
      </div>
    </DonorShell>
  );
}
