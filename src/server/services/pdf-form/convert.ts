import path from 'node:path';
import os from 'node:os';
import { promises as fs, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { PDFDocument } from 'pdf-lib';
import { MAX_PDF_PAGES } from '@/lib/pdf-form';
import { logger } from '@/lib/logger';

/**
 * 올린 서식 파일 → 편집의 바탕이 되는 원본 PDF.
 *
 *  - PDF          : 그대로 쓴다. 암호가 걸렸거나 열 수 없으면 거절한다.
 *  - PNG · JPG    : 그림 크기 그대로 한 쪽짜리 PDF 로 감싼다(스캔본). 글자는 그림이라 고칠 수 없고,
 *                   빈자리에 새 글을 넣거나 영역을 덮는 것만 된다.
 *  - DOCX·DOC·HWP·HWPX : 서버에 LibreOffice 가 있으면 PDF 로 바꾼다. 없으면 PDF 로 저장해
 *                   다시 올려 달라고 안내한다(한글: 파일 → PDF로 저장하기, 워드: 다른 이름으로 저장 → PDF).
 *                   변환 결과의 글꼴은 서버에 설치된 글꼴이 정한다. 원본 글꼴을 그대로 지키려면
 *                   기관 PC 에서 PDF 로 저장해 올리는 편이 정확하다(화면에서도 그렇게 안내한다).
 */

export type BasePdfResult =
  | { ok: true; pdf: Uint8Array; pageCount: number; converted: 'none' | 'image' | 'office' }
  | { ok: false; message: string };

const OFFICE_EXT = new Set(['docx', 'doc', 'hwp', 'hwpx']);
const CONVERT_TIMEOUT_MS = 90_000;

export async function toBasePdf(buf: Uint8Array, ext: string): Promise<BasePdfResult> {
  if (ext === 'pdf') return checkPdf(buf, 'none');
  if (ext === 'png' || ext === 'jpg') return imageToPdf(buf, ext);
  if (OFFICE_EXT.has(ext)) {
    const converted = await officeToPdf(buf, ext);
    if (!converted.ok) return converted;
    return checkPdf(converted.pdf, 'office');
  }
  return { ok: false, message: '편집할 수 없는 형식입니다.' };
}

async function checkPdf(buf: Uint8Array, converted: 'none' | 'office'): Promise<BasePdfResult> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(buf, { updateMetadata: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : '';
    if (/encrypt/i.test(msg)) {
      return { ok: false, message: '암호가 걸린 PDF 는 고칠 수 없습니다. 암호를 풀어 다시 저장한 뒤 올려 주세요.' };
    }
    return { ok: false, message: 'PDF 를 열 수 없습니다. 파일이 손상되었는지 확인해 주세요.' };
  }
  if (doc.isEncrypted) {
    return { ok: false, message: '암호가 걸린 PDF 는 고칠 수 없습니다. 암호를 풀어 다시 저장한 뒤 올려 주세요.' };
  }
  let pageCount: number;
  try {
    pageCount = doc.getPageCount();
    doc.getPages();
  } catch {
    // 머리말만 PDF 이고 몸체가 깨진 파일은 쪽 목록을 읽을 때 실패한다.
    return { ok: false, message: 'PDF 를 열 수 없습니다. 파일이 손상되었는지 확인해 주세요.' };
  }
  if (pageCount < 1) return { ok: false, message: '쪽이 없는 PDF 입니다.' };
  if (pageCount > MAX_PDF_PAGES) {
    return { ok: false, message: `서식은 ${MAX_PDF_PAGES}쪽 이하만 고칠 수 있습니다. (이 파일 ${pageCount}쪽)` };
  }
  return { ok: true, pdf: buf, pageCount, converted };
}

async function imageToPdf(buf: Uint8Array, ext: 'png' | 'jpg'): Promise<BasePdfResult> {
  try {
    const doc = await PDFDocument.create();
    const img = ext === 'png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
    // 스캔본은 픽셀이 커서 그대로 쓰면 쪽이 지나치게 크다. 긴 변을 A4 긴 변(842pt)에 맞춘다.
    const scale = Math.min(1, 842 / Math.max(img.width, img.height));
    const w = Math.max(1, img.width * scale);
    const h = Math.max(1, img.height * scale);
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
    const pdf = await doc.save();
    return { ok: true, pdf, pageCount: 1, converted: 'image' };
  } catch {
    return { ok: false, message: '그림 파일을 읽을 수 없습니다.' };
  }
}

/** LibreOffice 실행 파일 위치. SOFFICE_PATH 가 우선이고, 흔한 설치 위치를 찾아본다. */
export function findSoffice(): string | null {
  const fromEnv = process.env.SOFFICE_PATH?.trim();
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
          'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
        ]
      : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function officeToPdf(
  buf: Uint8Array,
  ext: string,
): Promise<{ ok: true; pdf: Uint8Array } | { ok: false; message: string }> {
  const label = ext.startsWith('hwp') ? '한글' : '워드';
  const howTo =
    ext.startsWith('hwp')
      ? '한글에서 [파일 → PDF로 저장하기] 로 저장해 올리면 원본 글꼴이 그대로 들어갑니다.'
      : '워드에서 [다른 이름으로 저장 → PDF] 로 저장해 올리면 원본 글꼴이 그대로 들어갑니다.';
  const soffice = findSoffice();
  if (!soffice) {
    return { ok: false, message: `이 서버에서는 ${label} 파일을 바로 바꿀 수 없습니다. ${howTo}` };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'givesign-convert-'));
  try {
    const input = path.join(dir, `form.${ext}`);
    await fs.writeFile(input, buf);
    await new Promise<void>((resolve, reject) => {
      execFile(
        soffice,
        [
          `-env:UserInstallation=file://${dir.replace(/\\/g, '/')}/profile`,
          '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, input,
        ],
        { timeout: CONVERT_TIMEOUT_MS, windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    const out = path.join(dir, 'form.pdf');
    if (!existsSync(out)) {
      return { ok: false, message: `${label} 파일을 PDF 로 바꾸지 못했습니다. ${howTo}` };
    }
    return { ok: true, pdf: new Uint8Array(await fs.readFile(out)) };
  } catch (err) {
    logger.warn('[pdf-form] 문서 변환 실패', { err: err instanceof Error ? err.message : String(err), ext });
    return { ok: false, message: `${label} 파일을 PDF 로 바꾸지 못했습니다. ${howTo}` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
