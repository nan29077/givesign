'use client';

import * as React from 'react';
import * as QRCode from 'qrcode';
import { Check, Copy, Download, ExternalLink, QrCode, Share2 } from 'lucide-react';

export function ChargePageShare({ url, merchantName }: { url: string; merchantName: string }) {
  const [qrDataUrl, setQrDataUrl] = React.useState('');
  const [message, setMessage] = React.useState('');

  React.useEffect(() => {
    let active = true;
    void QRCode.toDataURL(url, {
      width: 768,
      margin: 3,
      errorCorrectionLevel: 'H',
      color: { dark: '#17161a', light: '#fff9e8' },
    }).then((dataUrl) => {
      if (active) setQrDataUrl(dataUrl);
    });
    return () => { active = false; };
  }, [url]);

  const flash = (text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage(''), 2200);
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      flash('결제페이지 주소를 복사했습니다.');
    } catch {
      flash('주소를 길게 눌러 복사해 주세요.');
    }
  };

  const share = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `${merchantName} 결제페이지`,
          text: `${merchantName}님의 서비스를 문자로 후원해 보세요.`,
          url,
        });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return;
      }
    }
    await copyUrl();
  };

  const downloadQr = () => {
    if (!qrDataUrl) return;
    const anchor = document.createElement('a');
    anchor.href = qrDataUrl;
    anchor.download = `givesign-${merchantName.replace(/[^a-zA-Z0-9가-힣_-]/g, '-')}-qr.png`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    flash('QR코드 다운로드를 시작했습니다.');
  };

  return (
    <div className="overflow-hidden rounded-[22px] border border-brand-200/70 bg-[linear-gradient(145deg,#fffdf5,#fff8df)]">
      <div className="grid gap-4 p-4 sm:grid-cols-[1fr_150px] sm:items-center sm:p-5">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-100 px-2.5 py-1 text-[11px] font-extrabold text-brand-800">
            <Share2 size={13} /> 내 결제페이지 공유
          </span>
          <p className="mt-2 break-all text-[12.5px] font-semibold leading-relaxed text-ink-600">{url}</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-ink-400">
            서비스 안내 페이지·프로필 링크에 주소를 넣거나 QR코드를 화면에 띄워보세요.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:flex">
            <button type="button" onClick={() => void share()} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl bg-ink-900 px-3 text-[12px] font-extrabold text-white hover:bg-ink-800">
              <Share2 size={14} /> 공유하기
            </button>
            <button type="button" onClick={() => void copyUrl()} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 text-[12px] font-bold text-ink-700 hover:bg-ink-50">
              <Copy size={14} /> 주소 복사
            </button>
            <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-white px-3 text-[12px] font-bold text-ink-700 hover:bg-ink-50">
              <ExternalLink size={14} /> 미리보기
            </a>
            <button type="button" onClick={downloadQr} disabled={!qrDataUrl} className="inline-flex h-10 items-center justify-center gap-1.5 rounded-xl border border-brand-300 bg-white px-3 text-[12px] font-extrabold text-brand-800 hover:bg-brand-50 disabled:opacity-50">
              <Download size={14} /> QR 다운로드
            </button>
          </div>
          <p aria-live="polite" className="mt-2 min-h-4 text-[11px] font-semibold text-success-500">
            {message ? <span className="inline-flex items-center gap-1"><Check size={12} />{message}</span> : null}
          </p>
        </div>
        <div className="mx-auto grid h-[150px] w-[150px] place-items-center rounded-[20px] border border-brand-200 bg-white p-2 shadow-sm">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={qrDataUrl} alt={`${merchantName} 결제페이지 QR코드`} className="h-full w-full rounded-xl" />
          ) : (
            <QrCode size={42} className="animate-pulse text-ink-200" />
          )}
        </div>
      </div>
    </div>
  );
}
