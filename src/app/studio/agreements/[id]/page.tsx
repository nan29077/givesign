import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { AgreementView } from '@/components/agreements/agreement-view';

export const dynamic = 'force-dynamic';

export default async function StudioAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const doc = await prisma.agreementDocument.findFirst({ where: { id, merchantId } });
  if (!doc) notFound();
  await writeAudit({ action: 'AGREEMENT_VIEW', targetType: 'agreement_document', targetId: doc.id }).catch(() => undefined);
  const versions = await prisma.agreementDocument.findMany({ where: { kind: doc.kind, subjectId: doc.subjectId }, select: { id: true, version: true }, orderBy: { version: 'asc' } });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <Link href="/studio/agreements" className="text-[13px] font-bold text-ink-500">← 약정서·신청서</Link>
        <div className="flex gap-1.5 text-[12.5px]">
          {versions.map((v) => (
            <Link key={v.id} href={`/studio/agreements/${v.id}`} className={`rounded-lg border px-2.5 py-1 font-bold ${v.id === doc.id ? 'border-ink-900 bg-ink-900 text-white' : 'border-ink-200 text-ink-600'}`}>제{v.version}판</Link>
          ))}
        </div>
      </div>
      <AgreementView doc={doc} />
      <p className="text-center text-[12px] text-ink-400 print:hidden">브라우저 인쇄(PDF 저장)로 보관본을 만들 수 있습니다.</p>
    </div>
  );
}
