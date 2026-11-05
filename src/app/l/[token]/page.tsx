import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleX, Hourglass } from 'lucide-react';
import { Card, Notice } from '@/components/ui';
import { IssuedDocumentView } from '@/components/documents/issued-document-view';
import { loadIssuedByToken } from '@/server/services/issued-documents';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '기관 문서 열람', robots: { index: false, follow: false } };

/**
 * 용도별 자동 발송 문서 열람 (문자로 받은 링크). 로그인 없이 토큰으로 연다(토큰은 해시만 저장).
 * 만료되면 후원자 마이페이지에서 다시 열도록 안내한다. 인쇄할 수 있다.
 */
export default async function IssuedDocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadIssuedByToken(token);

  if (!loaded.ok) {
    return (
      <Shell>
        <Card>
          <h1 className="flex items-center gap-2 text-[16px] font-extrabold text-ink-900">
            {loaded.expired ? <Hourglass size={20} strokeWidth={1.7} className="text-warning-500" /> : <CircleX size={20} strokeWidth={1.7} className="text-danger-500" />}
            {loaded.expired ? '열람 기간이 지났습니다' : '문서를 열 수 없습니다'}
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
          {loaded.expired ? (
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
              기브싸인 후원자 계정으로 로그인하면{' '}
              <Link href="/my/documents" className="font-bold text-brand-700 underline">마이페이지 &gt; 받은 문서</Link>
              에서 언제든 다시 열 수 있습니다.{loaded.merchantName ? ` 계정이 없으면 ${loaded.merchantName}에 다시 보내 달라고 요청해 주세요.` : ''}
            </p>
          ) : null}
          <div className="mt-3">
            <Notice tone="warning">기브싸인은 문자로 보낸 링크 외의 경로로 계좌·카드 정보나 비밀번호를 묻지 않습니다.</Notice>
          </div>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <IssuedDocumentView
        snapshot={loaded.snapshot}
        verified={loaded.verified}
        contentHash={loaded.row.contentHash}
        createdAt={loaded.row.createdAt}
        pdfHref={loaded.row.pdfObject ? `/l/${token}/file` : null}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6 print:bg-white print:p-0">
      <div className="mx-auto max-w-[760px]">
        {children}
        <p className="mt-8 text-center text-[11px] font-bold tracking-wide text-ink-300 print:hidden">GIVESIGN 기관 문서</p>
      </div>
    </main>
  );
}
