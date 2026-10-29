'use client';

import * as React from 'react';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui';

/** 결제 수신번호 / 예시 문구 복사 버튼. 클립보드 미지원 환경에서는 안내 문구를 표시한다. */
export function CopyButton({ value, label = '복사' }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setFailed(true);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="secondary" size="sm" onClick={copy} aria-label={`${label} 복사`}>
        {copied ? <Check size={15} strokeWidth={1.8} /> : <Copy size={15} strokeWidth={1.7} />}
        {copied ? '복사됨' : label}
      </Button>
      {failed ? <span className="text-[11px] text-ink-400">직접 길게 눌러 복사해 주세요.</span> : null}
    </div>
  );
}
