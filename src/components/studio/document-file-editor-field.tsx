'use client';

import * as React from 'react';
import Link from 'next/link';
import { Expand, FileText, FileUp, Loader2, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { cx } from '@/components/ui';
import { PdfFormEditor, type PdfEditorSource } from '@/components/studio/pdf-form-editor';
import { emptyPdfLayout, type PdfFontInfo, type PdfLayout } from '@/lib/pdf-form';

/**
 * 서식 파일 올리기 + 그 자리에서 미리보며 고치기.
 *
 * 기관이 쓰던 서식(PDF·한글·워드·스캔본)을 끌어다 놓으면 업로드·변환이 끝나는 즉시 같은 화면에
 * 원본 미리보기 편집기가 열린다. 고친 내용은 서식 저장 버튼으로 서식과 **한 번에** 저장된다
 * (따로 저장할 것이 없다). 서버는 저장할 때 업로드 서명 토큰으로 이 기관이 올린 파일인지 확인하고,
 * 바탕 PDF 의 해시·쪽수를 직접 다시 읽는다.
 *
 * 폼으로 보내는 값(hidden): fileUrl · fileName · basePdfUrl · baseConvertedFrom · baseToken · pdfLayoutJson
 * URL 직접 입력은 받지 않는다 — 제3자 주소를 두면 서식을 여는 후원자의 IP·UA 가 그쪽으로 새어 나간다.
 */

const ACCEPT = '.pdf,.hwp,.hwpx,.docx,.doc,.png,.jpg,.jpeg';
const MAX_BYTES = 10 * 1024 * 1024;

interface UploadResult {
  ok: boolean;
  url?: string;
  name?: string;
  message?: string;
  base?: {
    basePdfUrl: string;
    pageCount: number;
    convertedFrom: 'none' | 'image' | 'office';
    token: string;
    fonts: PdfFontInfo[];
  } | null;
  editMessage?: string | null;
}

export interface ExistingPdfForm {
  templateId: string;
  basePdfUrl: string | null;
  renderedPdfUrl: string | null;
  convertedFrom: string | null;
  pageCount: number | null;
  layout: PdfLayout;
  fonts: PdfFontInfo[];
}

function uploadWithProgress(file: File, onProgress: (p: number) => void): Promise<UploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload/document');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const data = (xhr.response ?? null) as UploadResult | null;
      resolve(data ?? { ok: false, message: '업로드에 실패했습니다.' });
    };
    xhr.onerror = () => resolve({ ok: false, message: '업로드 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

export function DocumentFileEditorField({
  defaultFileUrl = '',
  defaultFileName = '',
  existing,
}: {
  defaultFileUrl?: string;
  defaultFileName?: string;
  /** 저장된 서식(수정 화면) */
  existing?: ExistingPdfForm | null;
}) {
  const [fileUrl, setFileUrl] = React.useState(defaultFileUrl);
  const [fileName, setFileName] = React.useState(defaultFileName);
  const [base, setBase] = React.useState<{
    url: string;
    token: string;
    convertedFrom: string | null;
    pageCount: number | null;
    fonts: PdfFontInfo[];
    source: PdfEditorSource;
    initialResultUrl: string | null;
  } | null>(() =>
    existing?.basePdfUrl
      ? {
          url: existing.basePdfUrl,
          token: '',
          convertedFrom: existing.convertedFrom,
          pageCount: existing.pageCount,
          fonts: existing.fonts,
          source: { templateId: existing.templateId },
          initialResultUrl: existing.renderedPdfUrl,
        }
      : null,
  );
  const [layout, setLayout] = React.useState<PdfLayout>(existing?.layout ?? emptyPdfLayout());
  const [initialJson] = React.useState(() => JSON.stringify(existing?.layout ?? emptyPdfLayout()));
  const [phase, setPhase] = React.useState<'idle' | 'uploading' | 'processing'>('idle');
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [editMessage, setEditMessage] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const [changedFile, setChangedFile] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  const dirty = changedFile || JSON.stringify(layout) !== initialJson;
  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    // 폼을 저장하면(제출) 경고 없이 이동할 수 있어야 한다.
    const form = rootRef.current?.closest('form');
    const off = () => window.removeEventListener('beforeunload', h);
    form?.addEventListener('submit', off);
    return () => {
      off();
      form?.removeEventListener('submit', off);
    };
  }, [dirty]);

  /** 서식 이름이 비어 있으면 파일 이름으로 채운다. */
  const fillName = (name: string) => {
    const form = rootRef.current?.closest('form');
    const input = form?.querySelector<HTMLInputElement>('input[name="name"]');
    if (input && !input.value.trim()) {
      const clean = name.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 60);
      // React 가 관리하지 않는 입력(defaultValue)이라 직접 넣는다.
      input.value = clean;
    }
  };

  const upload = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError('파일 용량은 10MB 이하만 올릴 수 있습니다.');
      return;
    }
    if (layout.edits.length > 0 && !window.confirm('새 파일을 올리면 지금 원본 위에서 고친 내용은 사라집니다. 바꿀까요?')) return;
    setPhase('uploading');
    setProgress(0);
    const data = await uploadWithProgress(file, (p) => {
      setProgress(p);
      if (p >= 100) setPhase('processing');
    });
    setPhase('idle');
    if (!data.ok || !data.url) {
      setError(data.message ?? '업로드에 실패했습니다.');
      return;
    }
    setFileUrl(data.url);
    setFileName(data.name ?? file.name);
    fillName(data.name ?? file.name);
    setChangedFile(true);
    setLayout(emptyPdfLayout());
    if (data.base) {
      setBase({
        url: data.base.basePdfUrl,
        token: data.base.token,
        convertedFrom: data.base.convertedFrom,
        pageCount: data.base.pageCount,
        fonts: data.base.fonts ?? [],
        source: { basePdfUrl: data.base.basePdfUrl, token: data.base.token },
        initialResultUrl: null,
      });
      setEditMessage(null);
    } else {
      setBase(null);
      setEditMessage(data.editMessage ?? null);
    }
  };

  const clear = () => {
    if (layout.edits.length > 0 && !window.confirm('파일을 지우면 원본 위에서 고친 내용도 사라집니다. 지울까요?')) return;
    setFileUrl('');
    setFileName('');
    setBase(null);
    setLayout(emptyPdfLayout());
    setEditMessage(null);
    setChangedFile(true);
    if (inputRef.current) inputRef.current.value = '';
  };

  const busy = phase !== 'idle';

  return (
    <div ref={rootRef}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />

      {!fileUrl || busy ? (
        <button
          type="button"
          onClick={() => !busy && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f && !busy) void upload(f);
          }}
          disabled={busy}
          className={cx(
            'flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed px-4 py-9 text-center transition-colors',
            dragOver ? 'border-brand-500 bg-brand-50' : 'border-ink-200 bg-ink-50/60 hover:border-brand-300 hover:bg-brand-50/50',
          )}
        >
          {busy ? (
            <>
              <Loader2 size={20} className="animate-spin text-brand-700" />
              <p className="text-[13.5px] font-bold text-ink-900">
                {phase === 'uploading' ? `올리는 중 ${progress}%` : '원본을 읽고 미리보기를 준비하는 중'}
              </p>
              <div className="h-1.5 w-56 overflow-hidden rounded-full bg-ink-100">
                <div className="h-full rounded-full bg-brand-500 transition-all" style={{ width: `${phase === 'uploading' ? progress : 100}%` }} />
              </div>
              {phase === 'processing' ? (
                <p className="text-[11.5px] text-ink-400">한글·워드 파일은 PDF 로 바꾸느라 조금 더 걸릴 수 있습니다.</p>
              ) : null}
            </>
          ) : (
            <>
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-white text-brand-700 shadow-sm">
                <FileUp size={20} strokeWidth={1.7} />
              </span>
              <p className="text-[14px] font-bold text-ink-900">쓰던 서식 파일을 여기에 끌어다 놓거나 눌러서 고르세요</p>
              <p className="text-[12px] text-ink-500">PDF · 한글(HWP·HWPX) · 워드(DOCX·DOC) · 스캔 그림(PNG·JPG), 10MB 이하</p>
              <p className="text-[11.5px] text-ink-400">올리는 즉시 원본 그대로 미리보기가 열리고, 그 위에서 바로 고칠 수 있습니다.</p>
            </>
          )}
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-ink-100 bg-white px-3 py-2.5">
          <FileText size={16} strokeWidth={1.7} className="shrink-0 text-brand-700" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-900">
            {fileName || '업로드된 서식'}
            {base?.pageCount ? <span className="ml-1.5 font-normal text-ink-400">{base.pageCount}쪽</span> : null}
          </span>
          {existing?.templateId && base && !dirty ? (
            <Link
              href={`/studio/documents/${existing.templateId}/edit`}
              className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11.5px] font-bold text-ink-500 hover:bg-ink-50 hover:text-ink-900"
            >
              <Expand size={13} strokeWidth={1.8} /> 넓은 화면
            </Link>
          ) : null}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2 py-1 text-[11.5px] font-bold text-ink-700 hover:bg-ink-50"
          >
            <RefreshCw size={12} strokeWidth={1.8} /> 파일 바꾸기
          </button>
          <button
            type="button"
            onClick={clear}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2 py-1 text-[11.5px] font-bold text-ink-500 hover:bg-ink-50"
          >
            <X size={12} strokeWidth={1.8} /> 지우기
          </button>
        </div>
      )}

      {error ? <p className="mt-1.5 text-[12px] text-danger-500">{error}</p> : null}

      {fileUrl && !busy && base ? (
        <div className="mt-3">
          {base.convertedFrom === 'office' ? (
            <p className="mb-2 rounded-xl bg-ink-50 px-3 py-2 text-[12px] leading-relaxed text-ink-700">
              한글·워드 파일을 서버에서 PDF 로 바꿨습니다. 글꼴이 원본과 다르게 보이면 쓰던 프로그램에서 PDF 로 저장해 다시 올려 주세요
              (한글: 파일 → PDF로 저장하기 · 워드: 다른 이름으로 저장 → PDF). 그러면 원본 글꼴이 그대로 들어갑니다.
            </p>
          ) : null}
          <PdfFormEditor
            key={base.url}
            source={base.source}
            basePdfUrl={base.url}
            initialResultUrl={JSON.stringify(layout) === initialJson ? base.initialResultUrl : null}
            fonts={base.fonts}
            convertedFrom={base.convertedFrom}
            layout={layout}
            onLayoutChange={setLayout}
            variant="embedded"
            downloadName={fileName.replace(/\.[a-z0-9]+$/i, '') || '서식'}
            toolbarEnd={dirty ? <span className="hidden sm:inline">서식 저장 때 함께 저장됩니다</span> : null}
          />
        </div>
      ) : null}

      {fileUrl && !busy && !base && editMessage ? (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-ink-200 bg-warning-50 px-3 py-2.5 text-[12px] leading-relaxed text-ink-700">
          <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-warning-500" />
          <span>{editMessage} 지금 파일은 내려받기 서식으로만 쓸 수 있습니다.</span>
        </div>
      ) : null}
      {fileUrl && !busy && !base && !editMessage && existing ? (
        <p className="mt-2 rounded-xl bg-ink-50 px-3 py-2 text-[12px] leading-relaxed text-ink-700">
          이 파일은 원본 위에서 고칠 수 없는 형식입니다. 한글은 [파일 → PDF로 저장하기], 워드는 [다른 이름으로 저장 → PDF] 로
          저장해 [파일 바꾸기] 로 올리면 원래 글꼴·크기 그대로 화면에서 고칠 수 있습니다.
        </p>
      ) : null}

      <input type="hidden" name="fileUrl" value={fileUrl} />
      <input type="hidden" name="fileName" value={fileName} />
      <input type="hidden" name="basePdfUrl" value={base?.url ?? ''} />
      <input type="hidden" name="baseConvertedFrom" value={base?.convertedFrom ?? ''} />
      <input type="hidden" name="baseToken" value={base?.token ?? ''} />
      <input type="hidden" name="pdfLayoutJson" value={base ? JSON.stringify(layout) : ''} />
    </div>
  );
}
