'use client';

import * as React from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { cx } from '@/components/ui';

/**
 * 복사 관련 클라이언트 컴포넌트.
 * 비밀값(API 키 등)은 서버가 발급 직후 1회만 내려주며 여기서만 화면에 표시한다.
 */

async function writeClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 아래 폴백 사용 */
  }
  try {
    const el = document.createElement('textarea');
    el.value = value;
    el.setAttribute('readonly', '');
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label = '복사',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = React.useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await writeClipboard(value);
        if (ok) {
          setDone(true);
          window.setTimeout(() => setDone(false), 1800);
        }
      }}
      className={cx(
        'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-ink-200 bg-white px-3 text-[12.5px] font-semibold text-ink-700 hover:bg-ink-50',
        className,
      )}
    >
      {done ? <Check size={15} strokeWidth={1.7} /> : <Copy size={15} strokeWidth={1.7} />}
      {done ? '복사됨' : label}
    </button>
  );
}

/** 읽기 전용 값 + 복사 버튼 */
export function CopyField({
  label,
  value,
  hint,
  mono = true,
}: {
  label: string;
  value: string;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-semibold text-ink-700">{label}</p>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className={cx(
            'h-11 w-full min-w-0 rounded-xl border border-ink-200 bg-ink-50 px-3 text-[13px] text-ink-900',
            mono && 'font-mono',
          )}
        />
        <CopyButton value={value} />
      </div>
      {hint ? <p className="mt-1.5 text-[12px] leading-relaxed text-ink-400">{hint}</p> : null}
    </div>
  );
}

/** 1회만 노출되는 비밀값 박스 */
export function SecretBox({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  const [visible, setVisible] = React.useState(true);

  return (
    <div className="rounded-xl border-2 border-brand-200 bg-brand-50 px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[13px] font-bold text-ink-900">{label}</p>
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="inline-flex items-center gap-1 text-[12px] font-semibold text-brand-700"
        >
          {visible ? <EyeOff size={15} strokeWidth={1.7} /> : <Eye size={15} strokeWidth={1.7} />}
          {visible ? '가리기' : '보기'}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          readOnly
          value={visible ? value : '•'.repeat(Math.min(48, value.length))}
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 w-full min-w-0 rounded-xl border border-brand-200 bg-white px-3 font-mono text-[12.5px] text-ink-900"
        />
        <CopyButton value={value} />
      </div>
      {hint ? <p className="mt-2 text-[12px] leading-relaxed text-brand-700">{hint}</p> : null}
    </div>
  );
}
