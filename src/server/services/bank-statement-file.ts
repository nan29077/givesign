import { inflateRawSync } from 'node:zlib';
import { decodeCsvBytes, splitCsvRecords } from '@/lib/bazaar';

/**
 * 거래내역 파일 → 표(줄×칸) (2026-11-09 E).
 *
 *  - CSV: UTF-8·CP949 자동 판별(`decodeCsvBytes` 재사용), 따옴표 안 줄바꿈 지원(`splitCsvRecords`).
 *  - XLSX: 패키지를 추가하지 않고 node:zlib 로 첫 번째 시트만 읽는다(공유 문자열·인라인 문자열·숫자).
 *    예전 엑셀(.xls, 이진 형식)은 읽지 않는다 — "CSV 로 저장해 올려 주세요" 로 안내한다.
 */

export class StatementFileError extends Error {}

export const XLS_NOT_SUPPORTED = '예전 엑셀 파일(.xls)은 읽을 수 없습니다. 엑셀에서 [다른 이름으로 저장 → CSV 또는 Excel 통합 문서(.xlsx)] 로 저장해 올려 주세요.';

export function readStatementTable(bytes: Uint8Array, fileName: string): { rows: string[][]; encoding: 'utf-8' | 'cp949' | 'xlsx' } {
  const lower = fileName.toLowerCase();
  const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const isOle = bytes.length > 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (isOle || lower.endsWith('.xls')) throw new StatementFileError(XLS_NOT_SUPPORTED);
  if (isZip || lower.endsWith('.xlsx')) {
    if (!isZip) throw new StatementFileError('엑셀 파일을 읽을 수 없습니다. CSV 로 저장해 올려 주세요.');
    return { rows: readXlsxRows(bytes), encoding: 'xlsx' };
  }
  const { text, encoding } = decodeCsvBytes(bytes);
  const body = text.replace(/^﻿/, '');
  // 탭으로 나눈 텍스트(일부 은행 '텍스트 저장')도 받는다.
  const firstLines = body.split(/\r?\n/, 5).join('\n');
  if (!firstLines.includes(',') && firstLines.includes('\t')) {
    return { rows: body.split(/\r?\n/).map((l) => l.split('\t').map((c) => c.trim())), encoding };
  }
  return { rows: splitCsvRecords(body).map((r) => r.cells), encoding };
}

// ---------------------------------------------------------------------------
// XLSX (zip + XML)
// ---------------------------------------------------------------------------

const MAX_ENTRY_BYTES = 40 * 1024 * 1024;

interface ZipEntry {
  name: string;
  method: number;
  compSize: number;
  size: number;
  localOffset: number;
}

function zipEntries(buf: Buffer): ZipEntry[] {
  // 중앙 디렉터리 끝 레코드(EOCD)를 뒤에서 찾는다.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new StatementFileError('엑셀 파일 구조를 읽을 수 없습니다. CSV 로 저장해 올려 주세요.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): string {
  if (e.size > MAX_ENTRY_BYTES) throw new StatementFileError('엑셀 파일이 너무 큽니다. 파일을 나눠 올려 주세요.');
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new StatementFileError('엑셀 파일 구조를 읽을 수 없습니다.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
  throw new StatementFileError('지원하지 않는 엑셀 압축 방식입니다. CSV 로 저장해 올려 주세요.');
}

function xmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function runsText(xml: string): string {
  // 후리가나(rPh) 같은 보조 글자는 뺀다.
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) s += m[1];
  return xmlText(s);
}

function colIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsxRows(bytes: Uint8Array): string[][] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = zipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const get = (n: string) => {
    const e = byName.get(n);
    return e ? readEntry(buf, e) : null;
  };
  const shared: string[] = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) shared.push(runsText(m[1] ?? ''));

  // 첫 번째 시트: workbook.xml 의 첫 <sheet r:id> → rels 의 Target. 못 찾으면 sheet1.xml.
  let sheetPath: string | null = null;
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const rid = wb ? /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1] : undefined;
  if (rid && rels) {
    const rel = [...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => m[1] ?? '').find((a) => a.includes(`Id="${rid}"`));
    const target = rel ? /Target="([^"]+)"/.exec(rel)?.[1] : undefined;
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }
  if (!sheetPath || !byName.has(sheetPath)) {
    sheetPath = entries.map((e) => e.name).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()[0] ?? null;
  }
  const sheet = sheetPath ? get(sheetPath) : null;
  if (!sheet) throw new StatementFileError('엑셀 파일에서 시트를 찾을 수 없습니다. CSV 로 저장해 올려 주세요.');

  const rows: string[][] = [];
  for (const rm of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rAttr = /\br="(\d+)"/.exec(rm[1] ?? '')?.[1];
    const rowIdx = rAttr ? Number(rAttr) - 1 : rows.length;
    const row: string[] = [];
    let next = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] ?? '';
      const inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const ci = ref ? colIndex(ref) : next;
      next = ci + 1;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = '';
      if (t === 's') val = shared[Number(v)] ?? '';
      else if (t === 'inlineStr') val = runsText(/<is>([\s\S]*?)<\/is>/.exec(inner)?.[1] ?? '');
      else val = v !== undefined ? xmlText(v) : '';
      if (ci >= 0 && ci < 200) row[ci] = val.trim();
    }
    for (let i = 0; i < row.length; i++) if (row[i] === undefined) row[i] = '';
    if (rowIdx > 20_000) break; // 상한(5,000행)을 훨씬 넘는 위치는 읽지 않는다
    while (rows.length < rowIdx) rows.push([]);
    rows[rowIdx] = row;
  }
  return rows;
}
