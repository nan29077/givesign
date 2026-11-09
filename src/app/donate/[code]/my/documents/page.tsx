import type { Metadata } from 'next';
import { DonorShell } from '@/components/public/donor-shell';
import { receivedDocuments } from '@/server/services/donor-documents';
import { ReceivedDocumentsList } from '@/components/self-service/received-documents';
import { MemberMyNav, NeedPhoneNotice, loadMemberSelf } from '../_member';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '받은 문서', robots: { index: false } };

/** 기관 후원 회원 — 이 기관에서 받은 감사장·확인서·약정서(2026-11-09 2차 F). 만료된 열람 링크로 온 사람도 로그인 후 여기서 연다. */
export default async function DonorDocumentsPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const { ctx, me, base, scope } = await loadMemberSelf(code, '/documents');
  const docs = scope ? await receivedDocuments(scope.payerId, scope.merchantId) : [];
  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-4 px-4 pt-6 text-[16px] sm:px-7">
        <MemberMyNav base={base} active="documents" color={ctx.color} />
        <h1 className="text-[22px] font-black text-ink-900">받은 문서</h1>
        {!scope ? <NeedPhoneNotice base={base} /> : (
          <section className="rounded-[24px] border border-ink-100 bg-white p-5">
            <p className="leading-relaxed text-ink-700">{ctx.org.displayName}에서 보낸 감사장·확인서와 정기후원 약정서입니다. 문자 링크의 열람 기간이 지나도 여기서 다시 열 수 있습니다.</p>
            <ReceivedDocumentsList docs={docs} base={`${base}/my`} showMerchant={false} />
          </section>
        )}
      </div>
    </DonorShell>
  );
}
