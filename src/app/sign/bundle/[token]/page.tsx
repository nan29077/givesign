import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { CircleCheck, CircleX, FileText, Hourglass } from 'lucide-react';
import { Card, Notice } from '@/components/ui';
import { OrgLogo } from '@/components/brand/org-logo';
import { PdfPreview } from '@/components/pdf/pdf-preview';
import { BundleOtpGate, BundleSignForm, type BundleSignItem } from '@/components/edoc/bundle-sign-flow';
import type { SignField } from '@/components/edoc/signer-flow';
import { prisma } from '@/server/db';
import { readPrefill, readSnapshot } from '@/server/services/edoc';
import { BUNDLE_ITEM_STATE_LABEL, bundleCookieName, checkBundleProof, loadBundleSession } from '@/server/services/document-bundles';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '전자문서 묶음 서명', robots: { index: false, follow: false } };

/**
 * 문서 묶음 서명 화면(2026-11-12 4차 J2). 본인확인 한 번 → 한 화면에서 문서를 순서대로 확인·서명.
 * 문서마다 전자문서 봉투(감사기록·해시 체인)는 그대로다. 서명을 마친 문서는 완료로 보인다.
 */
export default async function BundleSignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const s = await loadBundleSession(token);
  if (!s.ok) {
    return (
      <Shell>
        <Card>
          <h1 className="flex items-center gap-2 text-[18px] font-extrabold text-ink-900"><CircleX size={22} strokeWidth={1.7} className="text-danger-500" /> 문서를 열 수 없습니다</h1>
          <p className="mt-2 text-[16px] leading-relaxed text-ink-700">{s.reason}</p>
          <div className="mt-3"><Notice tone="warning">기브싸인은 문자로 보낸 링크 외의 경로로 계좌·카드 정보나 비밀번호를 묻지 않습니다.</Notice></div>
        </Card>
      </Shell>
    );
  }
  const verified = checkBundleProof(s.sendId, s.tokenHash, (await cookies()).get(bundleCookieName(s.sendId))?.value);
  const header = (
    <div className="mb-4 flex items-center gap-3">
      <OrgLogo code={s.merchantCode} name={s.merchantName} logoUrl={s.avatarUrl} className="h-12 w-12" />
      <div className="min-w-0">
        <p className="truncate text-[14px] font-bold text-ink-500">{s.merchantName}</p>
        <h1 className="truncate text-[20px] font-black text-ink-900">{s.bundleName}</h1>
      </div>
    </div>
  );
  const list = (
    <ol className="mb-3 space-y-1.5">
      {s.items.map((it, n) => (
        <li key={it.id} className="flex items-center gap-2 rounded-xl bg-white px-3 py-2.5 text-[16px]">
          <span className="font-bold text-ink-400">{n + 1}</span>
          <span className="min-w-0 flex-1 font-semibold text-ink-900">{it.label}{it.required ? '' : ' (선택)'}</span>
          <span className="text-[14px] font-bold text-ink-500">{BUNDLE_ITEM_STATE_LABEL[it.state].text}</span>
        </li>
      ))}
    </ol>
  );

  if (s.done) {
    return (
      <Shell>
        {header}
        <Notice tone="success" title="모든 문서에 서명했습니다">서명 기록(본인확인·시각)은 위변조를 확인할 수 있는 감사기록으로 보관됩니다. 완료 안내 문자를 보내 드렸습니다.</Notice>
        <div className="mt-3">{list}</div>
      </Shell>
    );
  }
  if (!verified && s.closed) {
    return (
      <Shell>
        {header}
        <Card>
          <p className="flex items-center gap-2 text-[17px] font-extrabold text-ink-900"><Hourglass size={20} strokeWidth={1.7} className="text-ink-400" /> 지금은 서명할 문서가 없습니다</p>
          <p className="mt-2 text-[16px] leading-relaxed text-ink-700">기한이 지났거나 거절된 문서입니다. 기관에 다시 요청해 주세요.</p>
        </Card>
        <div className="mt-3">{list}</div>
      </Shell>
    );
  }
  if (!verified) {
    return (
      <Shell>
        {header}
        {list}
        <Card>
          <BundleOtpGate token={token} phoneMasked={s.phoneMasked} count={s.items.filter((i) => i.canSign).length} />
        </Card>
      </Shell>
    );
  }

  const open = s.items.filter((i) => i.canSign);
  const envs = await prisma.eDocEnvelope.findMany({ where: { id: { in: open.map((i) => i.envelopeId) }, merchantId: s.merchantId }, select: { id: true, snapshotEnc: true, prefillEnc: true } });
  const envMap = new Map(envs.map((e) => [e.id, e]));
  const docs = open.map((it) => {
    const e = envMap.get(it.envelopeId)!;
    const snap = readSnapshot(e.snapshotEnc);
    return { it, snap, prefill: readPrefill(e.prefillEnc) };
  });
  const formItems: BundleSignItem[] = docs.map(({ it, snap, prefill }) => ({ id: it.id, label: it.label, required: it.required, fields: snap.fields as unknown as SignField[], prefill }));
  return (
    <Shell>
      {header}
      {list}
      {docs.map(({ it, snap }, n) => (
        <Card key={it.id} className="mb-3">
          <p className="mb-2 flex items-center gap-1.5 text-[16px] font-extrabold text-ink-800"><FileText size={18} strokeWidth={1.7} /> {n + 1}. {snap.name}</p>
          {snap.body ? <div className="whitespace-pre-wrap rounded-2xl bg-ink-50 p-4 text-[16px] leading-[1.85] text-ink-800">{snap.body}</div> : null}
          {snap.pdfObject || snap.pdfUrl ? (
            <div className="mt-3"><PdfPreview url={`/sign/bundle/${token}/pdf/${it.id}`} downloadName={`${snap.name}.pdf`} /></div>
          ) : null}
        </Card>
      ))}
      <Card>
        <BundleSignForm token={token} items={formItems} />
      </Card>
      <p className="mt-4 flex items-center justify-center gap-1 text-center text-[13px] leading-relaxed text-ink-400">
        <CircleCheck size={14} strokeWidth={1.7} /> 서명 기록(본인확인·접속 정보·시각)은 문서마다 감사기록으로 보관됩니다. 공동인증서 전자서명은 아닙니다.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        {children}
        <p className="mt-8 text-center text-[11px] font-bold tracking-wide text-ink-300">GIVESIGN 전자문서</p>
      </div>
    </main>
  );
}
