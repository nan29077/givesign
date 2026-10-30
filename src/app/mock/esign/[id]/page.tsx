import { notFound } from 'next/navigation';
import { prisma } from '@/server/db';
import { mockESignPageAllowed } from '@/server/adapters/esign';
import { renderAgreementText } from '@/server/services/agreements';
import { Card, Notice } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { mockESignAction } from '@/app/actions/volunteer';

export const dynamic = 'force-dynamic';

/**
 * 모의 전자서명 화면 (로컬 + ESIGN_PROVIDER=mock 에서만).
 * 실연동에서는 페이싸인·모두싸인 화면이 이 역할을 하고 결과는 콜백으로 들어온다.
 * 사람이 직접 눌러야 결과가 난다 — 자동으로 "서명 완료" 를 만들지 않는다.
 */
export default async function MockESignPage({ params }: { params: Promise<{ id: string }> }) {
  if (!mockESignPageAllowed()) notFound();
  const { id } = await params;
  const doc = await prisma.agreementDocument.findFirst({ where: { esignRequestId: id } });
  if (!doc) notFound();
  return (
    <main className="mx-auto max-w-[560px] space-y-4 px-5 py-10">
      <Notice tone="warning" title="모의 전자서명 (mock)">실제 전자서명이 아닙니다. 로컬 환경에서 흐름을 확인하기 위한 화면입니다.</Notice>
      <Card>
        <p className="text-[12px] font-bold text-ink-400">{doc.docNo}</p>
        <pre className="mt-2 whitespace-pre-wrap font-sans text-[14px] leading-relaxed text-ink-800">{renderAgreementText(doc.snapshot as Record<string, unknown>)}</pre>
        <p className="mt-3 break-all font-mono text-[11px] text-ink-400">SHA-256 {doc.contentHash}</p>
      </Card>
      <p className="text-[13px] font-bold">현재 상태: {doc.esignStatus}</p>
      {doc.esignStatus === 'REQUESTED' ? (
        <div className="flex gap-2">
          <DonorActionForm action={mockESignAction} submitLabel="서명하기">
            <input type="hidden" name="requestId" value={id} />
            <input type="hidden" name="outcome" value="SIGNED" />
          </DonorActionForm>
          <DonorActionForm action={mockESignAction} submitLabel="거절" variant="ghost">
            <input type="hidden" name="requestId" value={id} />
            <input type="hidden" name="outcome" value="DECLINED" />
          </DonorActionForm>
        </div>
      ) : null}
    </main>
  );
}
