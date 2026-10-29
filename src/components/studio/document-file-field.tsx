'use client';

import * as React from 'react';
import { FileText, Loader2, X } from 'lucide-react';

/**
 * 문서 서식 파일 입력 필드.
 *
 * 파일을 올리면 /api/upload/document 로 보내 저장하고, 돌려받은 주소를 hidden input 에 채운다.
 * 이미지 필드(ImageUploadField)와 달리 URL 직접 입력은 받지 않는다 — 제3자 도메인 주소를
 * 그대로 두면 서식을 내려받는 모든 후원자의 IP·UA 가 그쪽으로 새어 나간다.
 */
export function DocumentFileField({
  name,
  nameFieldName,
  defaultValue = '',
  defaultFileName = '',
  label,
  hint,
}: {
  name: string;
  /** 표시용 파일 이름을 담을 hidden input 의 name */
  nameFieldName: string;
  defaultValue?: string;
  defaultFileName?: string;
  label: string;
  hint?: string;
}) {
  const [value, setValue] = React.useState(defaultValue);
  const [fileName, setFileName] = React.useState(defaultFileName);
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
      const data = (await res.json()) as { ok: boolean; url?: string; name?: string; message?: string };
      if (!res.ok || !data.ok || !data.url) {
        setError(data.message ?? '업로드에 실패했습니다.');
        return;
      }
      setValue(data.url);
      setFileName(data.name ?? file.name);
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
        accept=".pdf,.docx,.doc,.hwp,.hwpx"
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
        {busy ? '업로드 중…' : '서식 파일 선택 (PDF · DOCX · DOC · HWP · HWPX, 10MB 이하)'}
      </button>

      {hint ? <p className="mt-1 text-[11.5px] leading-relaxed text-ink-400">{hint}</p> : null}
      {error ? <p className="mt-1 text-[11.5px] text-danger-500">{error}</p> : null}

      {value ? (
        <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-ink-100 bg-ink-50 px-3 py-2.5">
          <FileText size={16} strokeWidth={1.7} className="shrink-0 text-brand-700" />
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-ink-800">
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
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2 py-1 text-[11.5px] font-bold text-ink-500 hover:bg-ink-50"
          >
            <X size={12} strokeWidth={1.8} /> 지우기
          </button>
        </div>
      ) : null}

      <input type="hidden" name={name} value={value} />
      <input type="hidden" name={nameFieldName} value={fileName} />
    </div>
  );
}
