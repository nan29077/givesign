'use client';

import * as React from 'react';
import { FileDown, Loader2 } from 'lucide-react';
import { openPdf } from '@/components/pdf/pdfjs';

/**
 * 서식 PDF 를 화면 폭에 맞춰 쪽마다 그림으로 보여 준다(후원자·서명자 화면).
 * 휴대폰에서 PDF 를 따로 열지 않아도 내용을 읽을 수 있게 한다. 내려받기 링크도 함께 둔다.
 */
export function PdfPreview({
  url,
  downloadName,
  maxPages = 30,
}: {
  url: string;
  downloadName: string;
  maxPages?: number;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<'loading' | 'ready' | 'error'>('loading');
  const [count, setCount] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    const el = wrapRef.current;
    if (!el) return;
    (async () => {
      try {
        const doc = await openPdf(url);
        if (cancelled) return;
        const n = Math.min(doc.numPages, maxPages);
        setCount(doc.numPages);
        el.replaceChildren();
        const width = el.clientWidth || 360;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        for (let i = 1; i <= n; i++) {
          const page = await doc.getPage(i);
          if (cancelled) return;
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: width / vp1.width });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width * dpr);
          canvas.height = Math.ceil(vp.height * dpr);
          canvas.style.width = '100%';
          canvas.style.height = 'auto';
          canvas.className = 'block rounded-lg bg-white ring-1 ring-ink-100';
          canvas.setAttribute('aria-label', `${i}쪽`);
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          el.appendChild(canvas);
          await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: [dpr, 0, 0, dpr, 0, 0] }).promise;
        }
        if (!cancelled) setState('ready');
      } catch {
        if (!cancelled) setState('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url, maxPages]);

  return (
    <div>
      {state === 'loading' ? (
        <p className="flex items-center gap-1.5 py-6 text-[12.5px] text-ink-400">
          <Loader2 size={15} className="animate-spin" /> 서식을 불러오는 중입니다
        </p>
      ) : null}
      {state === 'error' ? (
        <p className="py-3 text-[12.5px] text-ink-500">화면에 서식을 그리지 못했습니다. 아래에서 내려받아 확인해 주세요.</p>
      ) : null}
      <div ref={wrapRef} className="space-y-2" />
      {count > maxPages ? <p className="mt-2 text-[11.5px] text-ink-400">앞 {maxPages}쪽만 보여 줍니다. 전체는 내려받아 확인해 주세요.</p> : null}
      <a
        href={`${url}?name=${encodeURIComponent(downloadName)}`}
        className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-bold text-brand-700 underline"
      >
        <FileDown size={16} strokeWidth={1.7} /> 서식 PDF 내려받기
      </a>
    </div>
  );
}
