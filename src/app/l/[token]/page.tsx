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
            <div className="mt-3 space-y-2">
              <p className="text-[16px] leading-relaxed text-ink-700">로그인하면 받은 문서에서 언제든 다시 열 수 있습니다.</p>
              {/* 로그인 후 받은 문서로 바로 돌아오게 next 를 넘긴다(2026-11-09 2차 F). 기관 후원 회원은 그 기관 로그인으로. */}
              {loaded.merchantCode ? (
                <Link href={`/donate/${loaded.merchantCode}/login?next=${encodeURIComponent(`/donate/${loaded.merchantCode}/my/documents`)}`} className="flex h-12 items-center justify-center rounded-xl bg-ink-900 px-4 text-[16px] font-extrabold text-white">
                  {loaded.merchantName ?? '기관'} 후원 회원으로 로그인
                </Link>
              ) : null}
              <Link href={`/login?next=${encodeURIComponent('/my/documents')}`} className="flex h-12 items-center justify-center rounded-xl border border-ink-200 bg-white px-4 text-[16px] font-extrabold text-ink-900">
                기브싸인 후원자 계정으로 로그인
              </Link>
              {loaded.merchantName ? <p className="text-[14px] text-ink-500">계정이 없으면 {loaded.merchantName}에 다시 보내 달라고 요청해 주세요.</p> : null}
            </div>
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
