import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ChevronLeft, FileCheck2, Fingerprint, History, ShieldAlert, ShieldCheck } from 'lucide-react';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { Badge, Card, CardTitle, DataRow, Input, LinkButton, Notice, Table, Td, Th } from '@/components/ui';
import { ActionForm, InlineActionForm } from '@/components/studio/action-form';
import { EDocReveal } from '@/components/studio/edoc-reveal';
import { cancelEDocEnvelopeAction, remindEDocSignerAction } from '@/app/actions/edoc';
import {
  EDOC_REMIND_MAX,
  edocEnvelopeStatusLabel,
  edocEventLabel,
  edocRoleLabel,
  edocSignerStatusLabel,
  readSnapshot,
  verifyEnvelopeChain,
} from '@/server/services/edoc';
import { edocUseSourceLabel } from '@/lib/edoc-billing';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

export default async function EDocEnvelopePage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const e = await prisma.eDocEnvelope.findFirst({
    where: { id, merchantId },
    include: { signers: { orderBy: { order: 'asc' } }, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  if (!e) notFound();
  const snapshot = readSnapshot(e.snapshotEnc);
  const chain = await verifyEnvelopeChain(e.id);
  const open = e.status === 'SENT' || e.status === 'IN_PROGRESS';
  const touched = e.signers.some((s) => s.viewedAt || s.otpVerifiedAt);
  const primarySigned = e.signers[0]?.status === 'SIGNED';
  const st = edocEnvelopeStatusLabel[e.status];
  const signerName = new Map(e.signers.map((s) => [s.id, `${edocRoleLabel[s.role]} ${s.nameMasked}`]));

  return (
    <>
      <Link href="/studio/e-documents" className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={16} strokeWidth={1.7} /> 전자문서 센터
      </Link>
      <PageHeader
        title={e.title}
        description={`${snapshot.name} · ${e.signingOrder === 'SEQUENTIAL' ? '순서대로 서명' : '동시 서명'} · 서명자 ${e.signers.length}명`}
        action={e.status === 'COMPLETED' ? <LinkButton href={`/studio/e-documents/${e.id}/certificate`}><FileCheck2 size={16} strokeWidth={1.7} /> 완료 확인서</LinkButton> : undefined}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {e.status === 'DECLINED' ? (
            <Notice tone="danger" title="서명이 거절되었습니다">
              {e.signers.filter((s) => s.status === 'DECLINED').map((s) => `${edocRoleLabel[s.role]} ${s.nameMasked}: ${s.declineReason ?? '-'}`).join(' / ')}
            </Notice>
          ) : e.status === 'CANCELLED' ? (
            <Notice tone="neutral" title="발송을 취소했습니다">{e.cancelReason}</Notice>
          ) : null}

          <Card>
            <CardTitle>서명자</CardTitle>
            <Table className="mt-3 min-w-[720px]">
              <thead>
                <tr>
                  <Th>순서</Th>
                  <Th>서명자</Th>
                  <Th>상태</Th>
                  <Th>발송 · 열람 · 서명</Th>
                  <Th>재안내</Th>
                </tr>
              </thead>
              <tbody>
                {e.signers.map((s) => (
                  <tr key={s.id}>
                    <Td className="tabular-nums">{s.order}</Td>
                    <Td>
                      <span className="block font-bold text-ink-900">{s.nameMasked}</span>
                      <span className="block text-[12px] text-ink-500">{edocRoleLabel[s.role]} · <span className="font-mono">{s.phoneMasked}</span></span>
                    </Td>
                    <Td><Badge tone={edocSignerStatusLabel[s.status].tone}>{edocSignerStatusLabel[s.status].text}</Badge></Td>
                    <Td className="whitespace-nowrap text-[12px] text-ink-500">
                      {s.sentAt ? formatKst(s.sentAt, false) : '-'}
                      <span className="block">{s.viewedAt ? `열람 ${formatKst(s.viewedAt, false)}` : '미열람'}</span>
                      {s.signedAt ? <span className="block text-[#0b7d59]">서명 {formatKst(s.signedAt, false)}</span> : null}
                    </Td>
                    <Td className="min-w-[140px]">
                      {open && (s.status === 'SENT' || s.status === 'VIEWED') ? (
                        <InlineActionForm
                          action={remindEDocSignerAction}
                          submitLabel={`다시 보내기 (${s.remindCount}/${EDOC_REMIND_MAX})`}
                          fields={{ envelopeId: e.id, signerId: s.id }}
                          disabled={s.remindCount >= EDOC_REMIND_MAX}
                          confirmMessage="새 서명 링크로 다시 보냅니다. 이전에 보낸 링크는 열리지 않게 됩니다."
                        />
                      ) : (
                        <span className="text-[12px] text-ink-300">-</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>

          <Card>
            <CardTitle>작성 내용</CardTitle>
            <div className="mt-3">
              {primarySigned ? <EDocReveal envelopeId={e.id} /> : <p className="text-[13px] text-ink-500">첫 번째 서명자가 작성·서명하면 볼 수 있습니다.</p>}
            </div>
            {e.signers.some((s) => s.signatureUrl) ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {e.signers.filter((s) => s.signatureUrl).map((s) => (
                  <figure key={s.id} className="rounded-2xl border border-ink-100 p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={s.signatureUrl!} alt={`${s.nameMasked} 서명`} className="h-24 w-full object-contain" />
                    <figcaption className="mt-1 text-center text-[11.5px] text-ink-500">{edocRoleLabel[s.role]} {s.nameMasked} · {s.signedAt ? formatKst(s.signedAt, false) : ''}</figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
          </Card>

          <Card>
            <CardTitle><span className="inline-flex items-center gap-1.5"><History size={17} strokeWidth={1.7} /> 감사추적</span></CardTitle>
            <ol className="mt-3 space-y-2">
              {e.events.map((ev) => (
                <li key={ev.id} className="flex gap-3 text-[12.5px]">
                  <span className="w-[120px] shrink-0 tabular-nums text-ink-400">{formatKst(ev.createdAt, true).slice(2)}</span>
                  <span className="min-w-0">
                    <span className="font-bold text-ink-800">{edocEventLabel[ev.type] ?? ev.type}</span>
                    {ev.signerId ? <span className="ml-1.5 text-ink-500">{signerName.get(ev.signerId)}</span> : null}
                    {ev.ip ? <span className="ml-1.5 font-mono text-[11px] text-ink-400">{ev.ip}</span> : null}
                    <span className="block truncate font-mono text-[10.5px] text-ink-300">{ev.hash}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <div className="flex items-center justify-between">
              <CardTitle>요약</CardTitle>
              <Badge tone={st.tone}>{st.text}</Badge>
            </div>
            <div className="mt-2">
              <DataRow label="서식" value={snapshot.name} />
              <DataRow label="보낸 날" value={formatKst(e.sentAt, false)} />
              <DataRow label="서명 기한" value={formatKst(e.expiresAt, false)} />
              {e.completedAt ? <DataRow label="완료" value={formatKst(e.completedAt, false)} /> : null}
              <DataRow label="이용료" value={e.chargeSource ? edocUseSourceLabel[e.chargeSource] : '-'} />
            </div>
            {e.message ? <p className="mt-3 rounded-xl bg-ink-50 px-3 py-2 text-[12.5px] text-ink-600">{e.message}</p> : null}
          </Card>

          <Card>
            <CardTitle><span className="inline-flex items-center gap-1.5"><Fingerprint size={17} strokeWidth={1.7} /> 무결성</span></CardTitle>
            <p className={`mt-2 flex items-center gap-1.5 text-[13px] font-bold ${chain.ok ? 'text-[#0b7d59]' : 'text-danger-500'}`}>
              {chain.ok ? <ShieldCheck size={16} strokeWidth={1.7} /> : <ShieldAlert size={16} strokeWidth={1.7} />}
              {chain.ok ? `감사추적 ${chain.count}건 해시 연결 정상` : '감사추적 해시가 맞지 않습니다'}
            </p>
            <p className="mt-2 break-all font-mono text-[10.5px] text-ink-400">서식 {e.snapshotHash}</p>
            {e.documentHash ? <p className="mt-1 break-all font-mono text-[10.5px] text-ink-400">완료본 {e.documentHash}</p> : null}
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">기브싸인 내부 감사기록입니다. 공인전자문서·시점확인(TSA) 인증은 연동하지 않았습니다.</p>
          </Card>

          {open ? (
            <Card>
              <CardTitle>발송 취소</CardTitle>
              <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
                {touched ? '서명자가 이미 문서를 열어 이용료는 되돌리지 않습니다.' : '아직 아무도 열지 않아 취소하면 이용료 1건을 되돌립니다.'}
              </p>
              <ActionForm action={cancelEDocEnvelopeAction} submitLabel="발송 취소" variant="danger" confirmMessage="취소하면 서명 링크가 더 이상 열리지 않습니다." className="mt-3">
                <input type="hidden" name="envelopeId" value={e.id} />
                <Input name="reason" placeholder="취소 사유 (필수)" maxLength={200} required />
              </ActionForm>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
