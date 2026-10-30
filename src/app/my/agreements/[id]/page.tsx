import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePayerContext } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { AgreementView } from '@/components/agreements/agreement-view';
import { Notice } from '@/components/ui';

export const dynamic = 'force-dynamic';

/** 후원자 보관용 약정서·신청서 열람 (문자·알림톡 안내 링크의 목적지) */
export default async function MyAgreementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { payerId } = await requirePayerContext(`/my/agreements/${id}`);
  if (!payerId) notFound();
  const doc = await prisma.agreementDocument.findFirst({ where: { id, payerId } });
  if (!doc) notFound();
  return (
    <div className="space-y-4">
      <Link href="/my/agreements" className="text-[13px] font-bold text-ink-500 print:hidden">← 내 약정서</Link>
      {doc.esignStatus === 'REQUESTED' && doc.esignProvider === 'mock' ? (
        <Notice tone="warning">전자서명 서비스 계약 전이라 서명 요청 문자가 실제로 나가지 않습니다. 약정은 동의 기록으로 이미 성립했습니다.</Notice>
      ) : null}
      <AgreementView doc={doc} />
    </div>
  );
}
