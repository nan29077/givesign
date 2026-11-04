'use client';

import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * 브라우저에서 pdf.js 를 늦게 불러온다(편집기·서식 보기 화면에서만 필요하다).
 *
 * ── 호환 빌드(legacy)를 쓰는 이유 ───────────────────────────────────────
 * pdf.js 6 의 기본 빌드는 `Map.prototype.getOrInsertComputed` 같은 아주 최근 브라우저 기능을
 * 보완 코드 없이 쓴다. 최신이 아닌 크롬·엣지·사파리에서는 PDF 를 여는 순간 오류가 나서 미리보기가
 * 그려지지 않는다(2026-11-04 확인). 호환 빌드는 같은 기능에 보완 코드를 넣어 두었으므로 기관 담당자
 * PC·후원자 휴대폰처럼 브라우저 버전을 고를 수 없는 화면에서는 반드시 호환 빌드를 쓴다.
 * 워커도 같은 호환 빌드여야 한다(워커 안에서도 같은 기능을 쓴다).
 *
 * 워커는 같은 출처의 번들 파일로 둔다(외부 CDN 을 쓰지 않는다 — 서식 내용이 제3자에게 가지 않게).
 * 받은 PDF 는 기관이 올린 파일이라 신뢰할 수 없으므로 스크립트(XFA·JS)를 돌리지 않는다.
 */
type PdfJs = typeof import('pdfjs-dist');

let loader: Promise<PdfJs> | null = null;

export function pdfjs(): Promise<PdfJs> {
  if (!loader) {
    loader = (import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJs>).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
      return mod;
    });
    // 불러오기 자체가 실패하면(배포 중 파일 교체 등) 다음 시도에서 다시 불러온다.
    loader.catch(() => {
      loader = null;
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

/** 미리보기 실패 원인을 사람이 읽는 말로. 화면에 그대로 보여 준다. */
export function pdfOpenErrorMessage(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (name === 'PasswordException' || /password/i.test(msg)) {
    return '암호가 걸린 PDF 라 미리볼 수 없습니다. 암호를 풀어 다시 저장한 뒤 올려 주세요.';
  }
  if (name === 'InvalidPDFException' || /invalid pdf/i.test(msg)) {
    return 'PDF 형식이 올바르지 않아 미리볼 수 없습니다. 파일이 손상되었는지 확인하고 다시 올려 주세요.';
  }
  if (name === 'ResponseException' || /missing pdf|unexpected server response|failed to fetch|network/i.test(msg)) {
    return '서식 파일을 불러오지 못했습니다. 인터넷 연결을 확인하고 화면을 새로 고쳐 주세요.';
  }
  if (/is not a function|is not defined|unexpected token|syntaxerror/i.test(msg)) {
    return '이 브라우저에서 미리보기를 그리지 못했습니다. 브라우저를 최신 버전으로 업데이트하거나 크롬·엣지 최신판으로 열어 주세요.';
  }
  return `미리보기를 그리지 못했습니다. 화면을 새로 고쳐 다시 시도해 주세요. (${msg.slice(0, 120) || '알 수 없는 오류'})`;
}
