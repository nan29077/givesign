import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { CircleX, FileText, Hourglass, Paperclip } from 'lucide-react';
import { Card, Notice } from '@/components/ui';
import { OrgLogo } from '@/components/brand/org-logo';
import { EDocCertificate } from '@/components/edoc/edoc-certificate';
import { SignerOtpGate, SignerSignForm } from '@/components/edoc/signer-flow';
import {
  accessCookieName,
  checkAccessProof,
  edocEventLabel,
  edocRoleLabel,
  envelopeValues,
  loadSigner,
  readPrefill,
  verifyEnvelopeChain,
} from '@/server/services/edoc';
import { prisma } from '@/server/db';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '전자문서 서명', robots: { index: false, follow: false } };

/**
 * 전자문서 서명 화면 (문자로 받은 링크).
 * 받은 번호로 본인확인을 해야 내용이 보인다. 서명을 마친 뒤에도 같은 링크로 완료본을 다시 볼 수 있다.
 */
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadSigner(token);

  if (!loaded.ok) {
    return (
      <Shell>
        <Card>
          <p className="flex items-center gap-2 text-[16px] font-extrabold text-ink-900"><CircleX size={20} strokeWidth={1.7} className="text-danger-500" /> 문서를 열 수 없습니다</p>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
          <div className="mt-3"><Notice tone="warning">기브싸인은 문자로 보낸 링크 외의 경로로 계좌·카드 정보나 비밀번호를 묻지 않습니다.</Notice></div>
        </Card>
      </Shell>
    );
  }

  const { signer: s, snapshot, merchantName, isPrimary, canSign, waitingReason } = loaded;
  const e = s.envelope;
  const verified = checkAccessProof(s.id, s.tokenHash, (await cookies()).get(accessCookieName(s.id))?.value);
  const header = (
    <div className="mb-4 flex items-center gap-3">
      <OrgLogo code={e.merchant.code} name={merchantName} logoUrl={e.merchant.avatarUrl} className="h-11 w-11" />
      <div className="min-w-0">
        <p className="truncate text-[12px] font-bold text-ink-500">{merchantName}</p>
        <h1 className="truncate text-[19px] font-black text-ink-900">{e.title}</h1>
      </div>
    </div>
  );

  if (!verified) {
    return (
      <Shell>
        {header}
        <Card>
          <p className="mb-1 text-[12.5px] text-ink-500">{edocRoleLabel[s.role]} {s.nameMasked}님께 온 문서입니다 · 기한 {formatKst(e.expiresAt, false).slice(0, 10)}</p>
          <SignerOtpGate token={token} phoneMasked={s.phoneMasked} />
        </Card>
      </Shell>
    );
  }

  // 서명을 마쳤거나 문서가 완료되면 완료본을 보여 준다.
  if (s.status === 'SIGNED' || e.status === 'COMPLETED') {
    const full = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: e.id }, include: { signers: { orderBy: { order: 'asc' } }, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    const [values, chain] = await Promise.all([envelopeValues(e.id), verifyEnvelopeChain(e.id)]);
    const who = new Map(full.signers.map((x) => [x.id, `${edocRoleLabel[x.role]} ${x.nameMasked}`]));
    return (
      <Shell wide>
        {e.status !== 'COMPLETED' ? <div className="mb-3"><Notice tone="brand" title="서명했습니다">다른 서명자가 서명하면 완료됩니다. 완료되면 문자로 알려 드립니다.</Notice></div> : null}
        <EDocCertificate
          d={{
            orgName: merchantName, title: full.title, envelopeId: full.id, snapshot, values, status: full.status, sentAt: full.sentAt, completedAt: full.completedAt,
            snapshotHash: full.snapshotHash, documentHash: full.documentHash, lastEventHash: full.lastEventHash, chainOk: chain.ok,
            signers: full.signers.map((x) => ({ order: x.order, roleLabel: edocRoleLabel[x.role], nameMasked: x.nameMasked, phoneMasked: x.phoneMasked, signedAt: x.signedAt, signIp: null, signatureUrl: x.signatureUrl, otpVerifiedAt: x.otpVerifiedAt })),
            events: full.events.filter((ev) => !['VALUES_VIEWED', 'OTP_SENT'].includes(ev.type)).map((ev) => ({ at: ev.createdAt, label: edocEventLabel[ev.type] ?? ev.type, who: ev.signerId ? who.get(ev.signerId) ?? '' : '', ip: null })),
          }}
        />
        <p className="mt-3 text-center text-[11.5px] text-ink-400">휴대폰 브라우저의 공유·인쇄 기능으로 PDF 로 저장할 수 있습니다.</p>
      </Shell>
    );
  }

  const prefill = isPrimary ? readPrefill(e.prefillEnc) : await envelopeValues(e.id);
  return (
    <Shell>
      {header}
      {e.message ? <p className="mb-3 rounded-2xl bg-brand-50 px-4 py-3 text-[13px] leading-relaxed text-brand-800">{e.message}</p> : null}
      <Card>
        <p className="mb-3 flex items-center gap-1.5 text-[12.5px] font-bold text-ink-500"><FileText size={16} strokeWidth={1.7} /> {snapshot.name}</p>
        {snapshot.body ? <div className="whitespace-pre-wrap rounded-2xl bg-ink-50 p-4 text-[13.5px] leading-[1.85] text-ink-800">{snapshot.body}</div> : null}
        {snapshot.fileUrl ? (
          <a href={snapshot.fileUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-bold text-brand-700 underline">
            <Paperclip size={16} strokeWidth={1.7} /> {snapshot.fileName ?? '첨부 서식'} 열기
          </a>
        ) : null}
        {!isPrimary && snapshot.fields.length ? (
          <dl className="mt-4 divide-y divide-ink-100 rounded-2xl border border-ink-100">
            {snapshot.fields.map((f) => (
              <div key={f.id} className="grid gap-0.5 px-4 py-2.5 sm:grid-cols-[160px_1fr]">
                <dt className="text-[12px] font-semibold text-ink-500">{f.label}</dt>
                <dd className="whitespace-pre-wrap text-[13.5px] text-ink-900">{f.type === 'CHECKBOX' ? (prefill[f.id] === 'Y' ? '동의함' : '동의하지 않음') : prefill[f.id] || '-'}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Card>

      <Card className="mt-3">
        {canSign ? (
          <SignerSignForm token={token} fields={snapshot.fields} prefill={prefill} editable={isPrimary} />
        ) : (
          <p className="flex items-start gap-2 text-[13.5px] leading-relaxed text-ink-700"><Hourglass size={18} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-400" /> {waitingReason}</p>
        )}
      </Card>
      <p className="mt-4 text-center text-[11px] leading-relaxed text-ink-400">
        서명 기록(본인확인·접속 정보·시각)은 위변조를 확인할 수 있는 감사기록으로 보관됩니다. 공동인증서 전자서명은 아닙니다.
      </p>
    </Shell>
  );
}

function Shell({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className={wide ? 'mx-auto max-w-[820px]' : 'app-column'}>
        {children}
        <p className="mt-8 text-center text-[11px] font-bold tracking-wide text-ink-300">GIVESIGN 전자문서</p>
      </div>
    </main>
  );
}
