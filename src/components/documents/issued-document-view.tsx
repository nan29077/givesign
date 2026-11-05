import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui';
import { PdfPreview } from '@/components/pdf/pdf-preview';
import { PrintButton } from '@/components/receipts/print-button';
import { formatKst } from '@/lib/datetime';
import type { IssuedSnapshot } from '@/server/services/issued-documents';

/**
 * 용도별 자동 발송 문서 열람 서식(인쇄 가능). 발급 당시 스냅샷만 그린다.
 * 본문은 React 글자로 그린다(HTML 로 해석하지 않는다). 머지 값은 발급 때 마스킹 규칙을 거쳤다.
 */
export function IssuedDocumentView({
  snapshot,
  verified,
  contentHash,
  createdAt,
  pdfHref,
}: {
  snapshot: IssuedSnapshot;
  verified: boolean;
  contentHash: string;
  createdAt: Date;
  /** 파일 서식 결과 PDF 를 내려받는 주소(열람 권한을 확인하는 경로) */
  pdfHref: string | null;
}) {
  return (
    <article className="card mx-auto max-w-[720px] p-6 print:border-0 print:shadow-none sm:p-8">
      <header className="border-b-2 border-ink-900 pb-4">
        <p className="text-[12px] font-bold tracking-widest text-ink-400">{snapshot.issuer.name}</p>
        <h1 className="mt-1 text-[24px] font-black text-ink-900">{snapshot.title}</h1>
        <div className="mt-2 flex flex-wrap gap-1.5 print:hidden">
          <Badge tone={verified ? 'success' : 'danger'}>
            {verified ? (
              <span className="inline-flex items-center gap-1"><ShieldCheck size={13} strokeWidth={1.7} /> 발급 당시 내용 그대로</span>
            ) : (
              <span className="inline-flex items-center gap-1"><ShieldAlert size={13} strokeWidth={1.7} /> 내용 확인값 불일치</span>
            )}
          </Badge>
        </div>
      </header>

      {snapshot.body ? (
        <section className="mt-6 whitespace-pre-wrap break-keep text-[15px] leading-[1.9] text-ink-800">{snapshot.body}</section>
      ) : null}

      {pdfHref ? (
        <section className="mt-6">
          <PdfPreview url={pdfHref} downloadName={`${snapshot.title}.pdf`} />
        </section>
      ) : null}

      <footer className="mt-8 rounded-xl bg-ink-50 p-4 text-[12px] leading-relaxed text-ink-500">
        <p>발급 {formatKst(createdAt, false)} · {snapshot.issuer.name}{snapshot.issuer.representative ? ` 대표 ${snapshot.issuer.representative}` : ''}</p>
        <p className="break-all font-mono text-[11px]">확인값 {contentHash}</p>
        <p className="mt-1 text-ink-400">이 문서는 기관이 보낸 안내 문서이며 기부금영수증이 아닙니다. 영수증은 기관의 영수증 발급 안내를 확인해 주세요.</p>
      </footer>

      <div className="mt-4 flex justify-end print:hidden">
        <PrintButton label="인쇄 · PDF 저장" />
      </div>
    </article>
  );
}
