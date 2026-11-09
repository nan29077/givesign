import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DonorShell } from '@/components/public/donor-shell';
import { AgreementView } from '@/components/agreements/agreement-view';
import { prisma } from '@/server/db';
import { loadMemberSelf } from '../../_member';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '약정서', robots: { index: false } };

/** 기관 후원 회원 — 약정서·신청서 열람(이 기관·본인 문서만) */
export default async function DonorAgreementPage({ params }: { params: Promise<{ code: string; id: string }> }) {
  const { code, id } = await params;
  const { ctx, me, base, scope } = await loadMemberSelf(code, `/agreements/${id}`);
  if (!scope) notFound();
  const doc = await prisma.agreementDocument.findFirst({ where: { id, payerId: scope.payerId, merchantId: scope.merchantId } });
  if (!doc) notFound();
  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-4 px-4 pt-6 sm:px-7">
        <Link href={`${base}/my/documents`} className="text-[15px] font-bold text-ink-500 print:hidden">받은 문서로</Link>
        <AgreementView doc={doc} />
      </div>
    </DonorShell>
  );
}
