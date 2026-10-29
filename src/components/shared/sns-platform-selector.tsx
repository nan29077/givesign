'use client';

import * as React from 'react';
import { cx } from '@/components/ui';

export const SNS_PLATFORMS = [
  { value: 'YOUTUBE', label: 'YouTube' },
  { value: 'INSTAGRAM', label: 'Instagram' },
  { value: 'FACEBOOK', label: 'Facebook' },
  { value: 'TIKTOK', label: 'TikTok' },
  { value: 'OTHER', label: '기타' },
] as const;

export type SnsPlatform = (typeof SNS_PLATFORMS)[number]['value'];

export function SnsPlatformSelector({
  value,
  onChange,
}: {
  value: SnsPlatform | '';
  onChange: (v: SnsPlatform | '') => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SNS_PLATFORMS.map((p) => (
        <button
          key={p.value}
          type="button"
          onClick={() => onChange(value === p.value ? '' : p.value)}
          className={cx(
            'rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors',
            value === p.value
              ? 'border-brand-500 bg-brand-500 text-white'
              : 'border-ink-200 bg-white text-ink-600 hover:border-brand-300 hover:text-brand-700',
          )}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}
