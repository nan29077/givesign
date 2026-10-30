import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { PrintButton } from '@/components/receipts/print-button';
import { EDocCertificate } from '@/components/edoc/edoc-certificate';
import { edocEventLabel, edocRoleLabel, envelopeValues, readSnapshot, verifyEnvelopeChain } from '@/server/services/edoc';

export const dynamic = 'force-dynamic';

/** 완료본 + 서명 확인서(인쇄·PDF 저장). 입력값을 복호화하므로 열 때마다 감사로그를 남긴다. */
export default async function EDocCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireMerchant();
  const { id } = await params;
  const e = await prisma.eDocEnvelope.findFirst({
    where: { id, merchantId: user.merchantId },
    include: { merchant: { select: { displayName: true } }, signers: { orderBy: { order: 'asc' } }, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  if (!e) notFound();
  const [values, chain] = await Promise.all([envelopeValues(e.id), verifyEnvelopeChain(e.id)]);
  await writeAudit({ adminUserId: user.id, action: 'EDOC_CERTIFICATE_VIEW', targetType: 'edoc_envelope', targetId: e.id });
  const who = new Map(e.signers.map((s) => [s.id, `${edocRoleLabel[s.role]} ${s.nameMasked}`]));
  return (
    <>
      <div className="print:hidden">
        <PageHeader title="완료 확인서" description="완료본과 서명 기록입니다. 인쇄하거나 PDF 로 저장할 수 있습니다." action={<PrintButton />} />
        <p className="mb-4 text-[12.5px]"><Link href={`/studio/e-documents/${e.id}`} className="font-bold text-brand-700">서명 요청 상세로</Link></p>
      </div>
      <EDocCertificate
        d={{
          orgName: e.merchant.displayName,
          title: e.title,
          envelopeId: e.id,
          snapshot: readSnapshot(e.snapshotEnc),
          values,
          status: e.status,
          sentAt: e.sentAt,
          completedAt: e.completedAt,
          snapshotHash: e.snapshotHash,
          documentHash: e.documentHash,
          lastEventHash: e.lastEventHash,
          chainOk: chain.ok,
          signers: e.signers.map((s) => ({ order: s.order, roleLabel: edocRoleLabel[s.role], nameMasked: s.nameMasked, phoneMasked: s.phoneMasked, signedAt: s.signedAt, signIp: s.signIp, signatureUrl: s.signatureUrl, otpVerifiedAt: s.otpVerifiedAt })),
          events: e.events.filter((ev) => ev.type !== 'VALUES_VIEWED').map((ev) => ({ at: ev.createdAt, label: edocEventLabel[ev.type] ?? ev.type, who: ev.signerId ? who.get(ev.signerId) ?? '' : '', ip: ev.ip })),
        }}
      />
    </>
  );
}
