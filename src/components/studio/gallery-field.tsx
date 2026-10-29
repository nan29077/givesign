'use client';

import * as React from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';

/**
 * 추가 이미지 여러 장 입력.
 *
 * 대표 이미지(ImageUploadField)와 달리 순서가 있는 목록이라 값 하나짜리 hidden 으로는 못 담는다.
 * 같은 name 의 hidden input 을 장수만큼 만들어 서버가 formData.getAll(name) 으로 읽게 한다.
 */
export function GalleryField({
  name,
  defaultValue = [],
  max = 5,
  label,
  hint,
}: {
  name: string;
  defaultValue?: string[];
  max?: number;
  label: string;
  hint?: string;
}) {
  const [items, setItems] = React.useState<string[]>(defaultValue);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const fileRef = React.useRef<HTMLInputElement>(null);

  const add = (v: string) => {
    const value = v.trim();
    if (!value) return;
    setItems((prev) => (prev.length >= max || prev.includes(value) ? prev : [...prev, value]));
  };

  const upload = async (files: FileList) => {
    setBusy(true);
    setError(null);
    try {
      // 남은 장수만큼만 올린다. 초과분을 올려 놓고 버리면 저장소만 지저분해진다.
      for (const file of Array.from(files).slice(0, Math.max(0, max - items.length))) {
        const fd = new FormData();
        fd.append('file', file);
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = (await res.json()) as { ok: boolean; url?: string; message?: string };
        if (!res.ok || !data.ok || !data.url) {
          setError(data.message ?? '업로드에 실패했습니다.');
          return;
        }
        add(data.url);
      }
    } catch {
      setError('업로드 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const full = items.length >= max;

  return (
    <div>
      <p className="mb-1.5 text-[13px] font-bold text-ink-900">
        {label}
        <span className="ml-1.5 font-semibold text-ink-400">
          {items.length}/{max}
        </span>
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) void upload(e.target.files);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy || full}
          className="flex h-11 items-center gap-2 rounded-xl border border-dashed border-ink-300 px-4 text-[13px] font-bold text-ink-500 hover:bg-ink-50 disabled:opacity-50"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ImagePlus size={16} />}
          {busy ? '업로드 중…' : full ? `최대 ${max}장` : '이미지 추가'}
        </button>

        <div className="flex min-w-[220px] flex-1 items-center gap-1.5">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https:// 주소로 추가"
            disabled={full}
            className="h-11 w-full rounded-xl border border-ink-200 px-3.5 text-[13.5px] outline-none transition-colors focus:border-brand-400 disabled:bg-ink-50"
          />
          <button
            type="button"
            onClick={() => {
              add(url);
              setUrl('');
            }}
            disabled={full || !url.trim()}
            className="h-11 shrink-0 rounded-xl border border-ink-200 px-3 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50 disabled:opacity-50"
          >
            추가
          </button>
        </div>
      </div>

      {hint ? <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">{hint}</p> : null}
      {error ? <p className="mt-1 text-[11.5px] text-danger-500">{error}</p> : null}

      {items.length > 0 ? (
        <ul className="mt-2.5 flex flex-wrap gap-2">
          {items.map((src, i) => (
            <li key={src} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt="" className="h-20 w-20 rounded-xl border border-ink-100 object-cover" />
              <button
                type="button"
                aria-label={`${i + 1}번째 이미지 지우기`}
                onClick={() => setItems((prev) => prev.filter((v) => v !== src))}
                className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-ink-200 bg-white text-ink-500 shadow-sm hover:text-danger-500"
              >
                <X size={13} strokeWidth={1.6} />
              </button>
              <input type="hidden" name={name} value={src} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
