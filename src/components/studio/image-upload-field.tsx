'use client';

import * as React from 'react';
import { ImagePlus, Link2, Loader2, X } from 'lucide-react';
import { cx } from '@/components/ui';

/**
 * 이미지 입력 필드 — URL 직접 입력 + 파일 업로드 겸용.
 *
 * - 파일을 올리면 /api/upload 로 전송해 저장하고, 반환된 URL 을 hidden input(name) 에 채운다.
 * - URL 직접 입력도 그대로 지원한다.
 * - 미리보기를 보여주고, 지우기 버튼으로 비울 수 있다.
 */
export function ImageUploadField({
  name,
  defaultValue = '',
  label,
  hint,
  aspect = 'wide',
}: {
  name: string;
  defaultValue?: string;
  label: string;
  hint?: string;
  aspect?: 'wide' | 'square';
}) {
  const [value, setValue] = React.useState(defaultValue);
  const [mode, setMode] = React.useState<'upload' | 'url'>('url');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = (await res.json()) as { ok: boolean; url?: string; message?: string };
      if (!res.ok || !data.ok || !data.url) {
        setError(data.message ?? '업로드에 실패했습니다.');
        return;
      }
      setValue(data.url);
    } catch {
      setError('업로드 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="mb-1.5 text-[13px] font-bold text-ink-900">{label}</p>

      <div className="mb-2 inline-flex overflow-hidden rounded-lg border border-ink-200 text-[12px] font-bold">
        <button
          type="button"
          onClick={() => setMode('upload')}
          className={cx('flex items-center gap-1 px-3 py-1.5', mode === 'upload' ? 'bg-brand-400 text-ink-900' : 'text-ink-400')}
        >
          <ImagePlus size={13} /> 파일 업로드
        </button>
        <button
          type="button"
          onClick={() => setMode('url')}
          className={cx('flex items-center gap-1 px-3 py-1.5', mode === 'url' ? 'bg-brand-400 text-ink-900' : 'text-ink-400')}
        >
          <Link2 size={13} /> URL 입력
        </button>
      </div>

      {mode === 'upload' ? (
        <div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
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
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
            {busy ? '업로드 중…' : '이미지 선택 (JPG·PNG·WEBP·GIF, 5MB 이하)'}
          </button>
        </div>
      ) : (
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https:// 또는 /uploads/... 경로"
          className="h-11 w-full rounded-xl border border-ink-200 px-3.5 text-[14px] outline-none transition-colors focus:border-brand-400"
        />
      )}

      {hint ? <p className="mt-1 text-[11.5px] leading-relaxed text-ink-400">{hint}</p> : null}
      {error ? <p className="mt-1 text-[11.5px] text-danger-500">{error}</p> : null}

      {value ? (
        <div className="mt-2.5 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt="미리보기"
            className={cx(
              'rounded-xl border border-ink-100 object-cover',
              aspect === 'square' ? 'h-16 w-16' : 'h-16 w-28',
            )}
          />
          <button
            type="button"
            onClick={() => {
              setValue('');
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="flex items-center gap-1 rounded-lg border border-ink-200 px-2.5 py-1.5 text-[12px] font-bold text-ink-500 hover:bg-ink-50"
          >
            <X size={13} /> 지우기
          </button>
        </div>
      ) : null}

      <input type="hidden" name={name} value={value} />
    </div>
  );
}
