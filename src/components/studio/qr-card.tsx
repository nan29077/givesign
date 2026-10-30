'use client';

import * as React from 'react';
import { Check, Copy, Download, Printer } from 'lucide-react';

/**
 * QR 코드 카드 (기관 콘솔).
 * 이미지는 /api/qr/... 가 서버에서 만든다. 주소에는 유입 경로(?src=qr)가 들어 있어
 * QR 로 들어온 후원·약정·봉사 신청이 따로 집계된다.
 */
export function QrCard({
  title,
  subtitle,
  qrPath,
  targetUrl,
  compact = false,
}: {
  title: string;
  subtitle?: string;
  /** /api/qr/GIV-XXXX 또는 /api/qr/GIV-XXXX/campaigns/ID */
  qrPath: string;
  /** QR 이 가리키는 주소 (화면 표시·복사용) */
  targetUrl: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 복사 권한이 없으면 아래 주소를 직접 선택해 복사한다 */
    }
  };
  const print = () => {
    const w = window.open('', '_blank', 'width=640,height=820');
    if (!w) return;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${esc(title)}</title>
      <style>body{font-family:Pretendard,'Noto Sans KR',sans-serif;text-align:center;padding:48px;color:#17261f}
      h1{font-size:28px;margin:0 0 8px}p{margin:0 0 24px;color:#4b5a52;font-size:16px}img{width:420px;height:420px}
      small{display:block;margin-top:18px;color:#7a877f;font-size:12px;word-break:break-all}</style></head>
      <body><h1>${esc(title)}</h1><p>${esc(subtitle ?? '휴대폰 카메라로 비추면 후원 페이지가 열립니다')}</p>
      <img src="${qrPath}?size=1200" alt="QR" onload="setTimeout(()=>window.print(),200)"><small>${esc(targetUrl)}</small></body></html>`);
    w.document.close();
  };
  return (
    <div className={compact ? 'flex items-start gap-3' : 'flex flex-col gap-3 sm:flex-row sm:items-start'}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${qrPath}?size=480`}
        alt={`${title} QR 코드`}
        width={compact ? 96 : 140}
        height={compact ? 96 : 140}
        className="shrink-0 rounded-xl border border-ink-100 bg-white p-1.5"
        loading="lazy"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-extrabold text-ink-900">{title}</p>
        {subtitle ? <p className="mt-0.5 text-[12.5px] text-ink-500">{subtitle}</p> : null}
        <p className="mt-1.5 break-all font-mono text-[11.5px] text-ink-400">{targetUrl}</p>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <a href={`${qrPath}?format=png&size=1200&download=1`} className="inline-flex h-9 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2.5 text-[12.5px] font-bold text-ink-800 hover:bg-ink-50">
            <Download size={16} strokeWidth={1.7} /> PNG
          </a>
          <a href={`${qrPath}?format=svg&download=1`} className="inline-flex h-9 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2.5 text-[12.5px] font-bold text-ink-800 hover:bg-ink-50">
            <Download size={16} strokeWidth={1.7} /> SVG
          </a>
          <button type="button" onClick={print} className="inline-flex h-9 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2.5 text-[12.5px] font-bold text-ink-800 hover:bg-ink-50">
            <Printer size={16} strokeWidth={1.7} /> 인쇄
          </button>
          <button type="button" onClick={copy} className="inline-flex h-9 items-center gap-1 rounded-lg border border-ink-200 bg-white px-2.5 text-[12.5px] font-bold text-ink-800 hover:bg-ink-50">
            {copied ? <Check size={16} strokeWidth={1.7} /> : <Copy size={16} strokeWidth={1.7} />} {copied ? '복사됨' : '주소 복사'}
          </button>
        </div>
      </div>
    </div>
  );
}
