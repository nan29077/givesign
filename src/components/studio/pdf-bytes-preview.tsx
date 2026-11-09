'use client';

import * as React from 'react';
import { Loader2 } from 'lucide-react';
import { openPdf, pdfOpenErrorMessage } from '@/components/pdf/pdfjs';

/**
 * 메모리에서 만든 PDF(첫 쪽 미리보기, base64)를 그린다 — 발송 전 점검 표본용. 저장소에 올리지 않은 파일이라 주소가 없다.
 */
export function PdfBytesPreview({ base64, label }: { base64: string; label: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [reason, setReason] = React.useState('');
  React.useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    if (!el) return;
    (async () => {
      try {
        const bin = atob(base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const doc = await openPdf(bytes);
        if (cancelled) return;
        const page = await doc.getPage(1);
        const width = el.clientWidth || 320;
        const vp1 = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: width / vp1.width });
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width * dpr);
        canvas.height = Math.ceil(vp.height * dpr);
        canvas.style.width = '100%';
        canvas.style.height = 'auto';
        canvas.className = 'block rounded-lg bg-white ring-1 ring-ink-100';
        canvas.setAttribute('aria-label', `${label} 첫 쪽`);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        el.replaceChildren(canvas);
        await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
        if (!cancelled) setState('ready');
      } catch (err) {
        if (!cancelled) {
          setReason(pdfOpenErrorMessage(err));
          setState('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [base64, label]);
  return (
    <div>
      {state === 'loading' ? (
        <p className="flex items-center gap-1.5 py-4 text-[12px] text-ink-400"><Loader2 size={15} className="animate-spin" /> 미리보기를 그리는 중입니다</p>
      ) : null}
      {state === 'error' ? <p className="py-2 text-[12px] text-ink-500">{reason}</p> : null}
      <div ref={ref} />
    </div>
  );
}
