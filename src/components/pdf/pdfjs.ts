'use client';

import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * 브라우저에서 pdf.js 를 늦게 불러온다(편집기·서식 보기 화면에서만 필요하다).
 *
 * 워커는 같은 출처의 번들 파일로 둔다(외부 CDN 을 쓰지 않는다 — 기관 콘솔의 글자 내용이
 * 제3자에게 가지 않게). 받은 PDF 는 기관이 올린 파일이라 신뢰할 수 없으므로 스크립트(XFA·JS)를
 * 돌리지 않는 기본값을 쓴다.
 */
let loader: Promise<typeof import('pdfjs-dist')> | null = null;

export function pdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!loader) {
    loader = import('pdfjs-dist').then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
      return mod;
    });
  }
  return loader;
}

export async function openPdf(src: string | Uint8Array): Promise<PDFDocumentProxy> {
  const lib = await pdfjs();
  const task = lib.getDocument({
    ...(typeof src === 'string' ? { url: src } : { data: src }),
    fontExtraProperties: true,
    enableXfa: false,
    // 같은 출처의 /api/media 만 연다. 쿠키는 보낼 필요가 없다.
    withCredentials: false,
  });
  return task.promise;
}
