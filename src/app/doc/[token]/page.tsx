import type { Metadata } from 'next';
import { CircleCheck, CircleX, FileSignature, Hourglass } from 'lucide-react';
import { Badge, Card, CardTitle, DataRow, Notice } from '@/components/ui';
import { Logo } from '@/components/brand/logo';
import { loadDocumentContext, type DocumentContext } from '@/server/services/documents';
import { formatKst } from '@/lib/datetime';
import { DocumentForm } from './document-form';
import { DocumentPrintButton } from '@/components/public/document-print-button';

/**
 * 문서 작성 화면 (문자로 받은 작성 링크).
 *
 * 결제를 마친 후원자가 약정서·주문서를 작성해 제출하는 곳이다.
 * 보안링크(/r/[token])와 달리 제출 전까지 몇 번이든 열 수 있다 — 서류를 찾아보고
 * 나중에 다시 여는 일이라, 한 번 열었다고 링크가 죽으면 작성할 방법이 없다.
 *
 * 검색엔진 색인을 막고, 항상 서버에서 새로 검증한다.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '문서 작성',
  robots: { index: false, follow: false },
};

export default async function DocumentPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const loaded = await loadDocumentContext(token);

  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column">
        <div className="mb-4 flex items-center justify-between">
          <Logo />
          <span className="text-[11px] font-semibold text-ink-300">문서 작성</span>
        </div>

        {!loaded.ok ? (
          <Card>
            <div className="flex items-center gap-2 text-danger-500">
              <CircleX size={20} strokeWidth={1.7} />
              <p className="text-[16px] font-extrabold text-ink-900">문서를 열 수 없습니다</p>
            </div>
            <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">{loaded.reason}</p>
            <div className="mt-3">
              <Notice tone="warning" title="주의">
                기브싸인은 문자로 발송한 링크 외에 다른 경로로 개인정보나 계좌 정보를 요구하지 않습니다.
              </Notice>
            </div>
          </Card>
        ) : (
          <Body ctx={loaded.ctx} token={token} />
        )}

        <p className="mt-6 text-center text-[11px] leading-relaxed text-ink-300">
          이 링크는 본인에게만 발송된 링크입니다. 다른 사람에게 전달하지 마세요.
        </p>
      </div>
    </main>
  );
}

function Body({ ctx, token }: { ctx: DocumentContext; token: string }) {
  const done = ctx.status !== 'DRAFT';

  return (
    <div className="space-y-3">
      {done && <DocumentPrintButton />}
      {ctx.documentHash && <p className="break-all rounded-xl bg-white p-3 text-[10px] text-ink-400">요청 당시 문서 SHA-256 · {ctx.documentHash}</p>}
      <Card>
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
            <FileSignature size={18} strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <p className="text-[12px] font-semibold text-brand-700">{ctx.merchantName}</p>
            <h1 className="truncate text-[19px] font-extrabold leading-snug tracking-tight text-ink-900">
              {ctx.templateName}
            </h1>
          </div>
        </div>

        {ctx.description ? (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-500">{ctx.description}</p>
        ) : null}

        <div className="mt-3">
          {ctx.productName ? <DataRow label="결제 상품" value={ctx.productName} /> : null}
          {ctx.transactionNo ? (
            <DataRow label="거래번호" value={<span className="font-mono text-[12px]">{ctx.transactionNo}</span>} />
          ) : null}
          <DataRow
            label="상태"
            value={
              done ? (
                <Badge tone="success">제출 완료</Badge>
              ) : (
                <Badge tone="warning">작성 전</Badge>
              )
            }
          />
          {!done ? <DataRow label="작성 기한" value={formatKst(ctx.expiresAt, false)} /> : null}
          {ctx.submittedAt ? <DataRow label="제출 시각" value={formatKst(ctx.submittedAt)} /> : null}
        </div>
      </Card>

      {done ? (
        <Card>
          <div className="flex items-center gap-2 text-success-500">
            <CircleCheck size={20} strokeWidth={1.7} />
            <p className="text-[16px] font-extrabold text-ink-900">제출이 완료되었습니다</p>
          </div>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
            {ctx.merchantName} 에서 내용을 확인합니다. 아래는 제출하신 내용입니다. 정정이 필요하면
            {ctx.merchantName} 에 직접 연락해 주세요.
          </p>

          {ctx.fields.length > 0 ? (
            <div className="mt-3 rounded-xl border border-ink-100">
              {ctx.fields.map((f) => {
                const raw = ctx.values[f.id] ?? '';
                const value = f.type === 'CHECKBOX' ? (raw === 'Y' ? '동의함' : '동의하지 않음') : raw || '-';
                return (
                  <div
                    key={f.id}
                    className="flex items-start justify-between gap-4 border-b border-ink-100 px-3.5 py-2.5 last:border-0"
                  >
                    <span className="shrink-0 text-[12.5px] text-ink-400">{f.label}</span>
                    <span className="whitespace-pre-wrap break-words text-right text-[12.5px] font-semibold text-ink-900">
                      {value}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}

          {ctx.signatureUrl ? (
            <>
              <p className="mt-3 text-[12px] font-bold text-ink-400">서명</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={ctx.signatureUrl}
                alt="제출한 서명"
                className="mt-1 h-24 w-full rounded-xl border border-ink-100 bg-white object-contain"
              />
            </>
          ) : null}
        </Card>
      ) : ctx.expiresAt < new Date() ? (
        <Card>
          <div className="flex items-center gap-2 text-warning-500">
            <Hourglass size={20} strokeWidth={1.7} />
            <p className="text-[16px] font-extrabold text-ink-900">작성 기간이 지났습니다</p>
          </div>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-700">
            {ctx.merchantName} 에 문의하시면 작성 링크를 다시 받을 수 있습니다. 결제는 이미 완료되어 있습니다.
          </p>
        </Card>
      ) : (
        <>
          {ctx.body ? (
            <Card>
              <CardTitle>{ctx.templateType === 'FILE' ? '작성 안내' : '문서 내용'}</CardTitle>
              <p className="mt-2 max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-xl bg-ink-50 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-700">
                {ctx.body}
              </p>
            </Card>
          ) : null}

          <DocumentForm
            token={token}
            templateType={ctx.templateType}
            fileUrl={ctx.fileUrl}
            fileName={ctx.fileName}
            requireSignature={ctx.requireSignature}
            fields={ctx.fields.map((f) => ({
              id: f.id,
              label: f.label,
              type: f.type,
              required: f.required,
              hint: f.hint,
            }))}
          />

          <Notice tone="neutral" title="제출하면 고칠 수 없습니다">
            제출한 내용은 사회복지기관과의 약정 근거로 남습니다. 내용을 다시 확인한 뒤 제출해 주세요.
          </Notice>
        </>
      )}
    </div>
  );
}
