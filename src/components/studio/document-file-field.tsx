'use client';

import * as React from 'react';
import { FilePen, FileText, Loader2, TriangleAlert, X } from 'lucide-react';

/**
 * 문서 서식 파일 입력 필드.
 *
 * 파일을 올리면 /api/upload/document 로 보내 저장하고, 돌려받은 주소를 hidden input 에 채운다.
 * 이미지 필드(ImageUploadField)와 달리 URL 직접 입력은 받지 않는다 — 제3자 도메인 주소를
 * 그대로 두면 서식을 내려받는 모든 후원자의 IP·UA 가 그쪽으로 새어 나간다.
 *
 * 업로드 응답에 편집 바탕 PDF(base)가 있으면 hidden 으로 함께 보낸다. 저장할 때 서버가
 * 저장소의 파일을 다시 읽어 해시·쪽수를 정하므로, 여기 값은 "어느 파일인지" 만 알린다.
 */
export function DocumentFileField({
  name,
  nameFieldName,
  defaultValue = '',
  defaultFileName = '',
  defaultBasePdfUrl = '',
  defaultConvertedFrom = '',
  label,
  hint,
}: {
  name: string;
  /** 표시용 파일 이름을 담을 hidden input 의 name */
  nameFieldName: string;
  defaultValue?: string;
  defaultFileName?: string;
  /** 저장된 편집 바탕 PDF 주소 (수정 화면) */
  defaultBasePdfUrl?: string;
  defaultConvertedFrom?: string;
  label: string;
  hint?: string;
}) {
  const [value, setValue] = React.useState(defaultValue);
  const [fileName, setFileName] = React.useState(defaultFileName);
  const [baseUrl, setBaseUrl] = React.useState(defaultBasePdfUrl);
  const [convertedFrom, setConvertedFrom] = React.useState(defaultConvertedFrom);
  const [editMessage, setEditMessage] = React.useState<string | null>(null);
  const [pageCount, setPageCount] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload/document', { method: 'POST', body: fd });
      const data = (await res.json()) as {
        ok: boolean;
        url?: string;
        name?: string;
        message?: string;
        base?: { basePdfUrl: string; pageCount: number; convertedFrom: string } | null;
        editMessage?: string | null;
      };
      if (!res.ok || !data.ok || !data.url) {
        setError(data.message ?? '업로드에 실패했습니다.');
        return;
      }
      setValue(data.url);
      setFileName(data.name ?? file.name);
      setBaseUrl(data.base?.basePdfUrl ?? '');
      setConvertedFrom(data.base?.convertedFrom ?? '');
      setPageCount(data.base?.pageCount ?? null);
      setEditMessage(data.base ? null : (data.editMessage ?? null));
    } catch {
      setError('업로드 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="mb-1.5 text-[13px] font-bold text-ink-900">{label}</p>

      <input
        ref={fileRef}
        type="file"
        accept=".pdf,.docx,.doc,.hwp,.hwpx,.png,.jpg,.jpeg"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-ink-300 text-[13px] font-bold text-ink-500 hover:bg-ink-50 disabled:opacity-60"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} strokeWidth={1.7} />}
        {busy ? '업로드·변환 중…' : '서식 파일 선택 (PDF · 한글 · 워드 · 스캔 그림, 10MB 이하)'}
      </button>

      {hint ? <p className="mt-1 text-[11.5px] leading-relaxed text-ink-400">{hint}</p> : null}
      {error ? <p className="mt-1 text-[11.5px] text-danger-500">{error}</p> : null}

      {value ? (
        <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-ink-100 bg-ink-50 px-3 py-2.5">
          <FileText size={16} strokeWidth={1.7} className="shrink-0 text-brand-700" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-900">
            {fileName || '업로드된 서식'}
          </span>
          <a
            href={`${value}?name=${encodeURIComponent(fileName || '문서서식')}`}
            className="shrink-0 text-[11.5px] font-bold text-brand-700 hover:underline"
          >
            확인
          </a>
          <button
            type="button"
            onClick={() => {
              setValue('');
              setFileName('');
              setBaseUrl('');
              setConvertedFrom('');
              setEditMessage(null);
              setPageCount(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2 py-1 text-[11.5px] font-bold text-ink-500 hover:bg-ink-50"
          >
            <X size={12} strokeWidth={1.8} /> 지우기
          </button>
        </div>
      ) : null}

      {value && baseUrl ? (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12px] leading-relaxed text-brand-900">
          <FilePen size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" />
          <span>
            원본 위에서 고칠 수 있습니다{pageCount ? ` (${pageCount}쪽)` : ''}. 서식을 저장하면 편집 화면이 열립니다.
            {convertedFrom === 'office'
              ? ' 한글·워드 파일을 서버에서 PDF 로 바꿨습니다. 글꼴이 원본과 다르게 보이면 PDF 로 저장해 다시 올려 주세요.'
              : convertedFrom === 'image'
                ? ' 스캔 그림이라 기존 글자는 고칠 수 없고, 덮거나 새 글을 넣을 수 있습니다.'
                : ''}
          </span>
        </div>
      ) : null}
      {value && !baseUrl && editMessage ? (
        <div className="mt-2 flex items-start gap-2 rounded-xl border border-ink-200 bg-warning-50 px-3 py-2.5 text-[12px] leading-relaxed text-ink-700">
          <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-warning-500" />
          <span>{editMessage} 지금 파일은 내려받기 서식으로만 쓸 수 있습니다.</span>
        </div>
      ) : null}

      <input type="hidden" name={name} value={value} />
      <input type="hidden" name="basePdfUrl" value={baseUrl} />
      <input type="hidden" name="baseConvertedFrom" value={convertedFrom} />
      <input type="hidden" name={nameFieldName} value={fileName} />
    </div>
  );
}
