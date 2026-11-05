import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFHexString,
  decodePDFRawStream, type PDFDocument, type PDFPage, type PDFObject,
} from 'pdf-lib';
import { classifyFontName, displayFontName, stripSubsetTag, type PdfFontInfo } from '@/lib/pdf-form';

/**
 * 원본 PDF 의 글꼴을 찾아 "새 글자 → 그 글꼴의 문자 코드" 로 바꾸는 부분.
 *
 * PDF 글자는 유니코드가 아니라 글꼴마다 정해진 코드로 적혀 있다. 원본 글꼴로 새 글자를
 * 쓰려면 그 코드를 알아야 한다. 대부분의 PDF 는 복사·검색용으로 "코드 → 유니코드" 표
 * (ToUnicode CMap)를 함께 넣어 두므로, 이 표를 거꾸로 읽어 "유니코드 → 코드" 를 만든다.
 * 표에 있는 글자는 원본 문서에 실제로 쓰인 글자라서, 부분집합 글꼴이어도 모양이 들어 있다.
 *
 * 다루는 글꼴 형식
 *  - Type0 + Identity-H/V : 2바이트 CID. ToUnicode 를 거꾸로 읽는다(한글·워드에서 만든 PDF 대부분).
 *  - Type0 + UniKS-UCS2-H / UniKS-UTF16-H : 코드가 곧 UTF-16. 비내장 한글 글꼴이면 모든 글자를 쓸 수 있다.
 *  - Type1 / TrueType(1바이트) : ToUnicode 를 거꾸로 읽는다. 표가 없고 비내장·WinAnsi 이면 ASCII 만.
 *  - Type3 : 쓰지 않는다(그림으로 된 글꼴).
 * 한 글꼴 이름이 여러 글꼴 사전으로 나뉜 경우(LibreOffice 는 256자마다 나눈다)도 있어서,
 * 같은 이름의 사전을 모두 모아 글자마다 그것을 그릴 수 있는 사전을 고른다.
 */

/** 원본 글꼴 사전 1개와 그 인코딩. */
export interface FontEncoder {
  baseFont: string;
  ref: PDFRef | null;
  dict: PDFDict;
  bytesPerCode: 1 | 2;
  /** null 이면 그 글자를 이 사전으로 쓸 수 없다 */
  encode(ch: string): number | null;
  /** 이 사전으로 쓸 수 있는 글자 (null 이면 제한 없음) */
  chars: Set<string> | null;
  /** 글꼴 단위(1/1000) 폭. 모르면 null */
  widthOf(code: number): number | null;
  /** 글꼴 프로그램(파일)이 들어 있는지 */
  embedded: boolean;
  /** 부분집합(ABCDEF+) 여부 */
  subset: boolean;
  /** 글꼴 프로그램 원본 바이트 (FontFile2·FontFile3). 다시 넣기 판단용 */
  program: Uint8Array | null;
}

function nameOf(obj: PDFObject | undefined): string | null {
  if (obj instanceof PDFName) return obj.decodeText();
  return null;
}

/**
 * 글꼴 이름. BaseFont 가 없으면(Type3 에서 흔하다) Name, 글꼴 설명의 FontName 순으로 본다.
 * pdf.js 도 같은 순서로 이름을 정하므로 편집기와 서버가 같은 이름으로 글꼴을 가리킨다.
 */
export function fontNameOf(doc: PDFDocument, dict: PDFDict): string | null {
  const base = nameOf(dict.get(PDFName.of('BaseFont')));
  if (base) return base;
  const desc = lookupDict(doc, dict.get(PDFName.of('FontDescriptor')));
  const fromDesc = desc ? nameOf(desc.get(PDFName.of('FontName'))) : null;
  return fromDesc ?? nameOf(dict.get(PDFName.of('Name')));
}

function lookupDict(doc: PDFDocument, obj: PDFObject | undefined): PDFDict | null {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFDict ? v : null;
}

function lookupArray(doc: PDFDocument, obj: PDFObject | undefined): PDFArray | null {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFArray ? v : null;
}

function lookupNumber(doc: PDFDocument, obj: PDFObject | undefined): number | null {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  return v instanceof PDFNumber ? v.asNumber() : null;
}

function streamBytes(doc: PDFDocument, obj: PDFObject | undefined): Uint8Array | null {
  const v = obj instanceof PDFRef ? doc.context.lookup(obj) : obj;
  if (!(v instanceof PDFStream)) return null;
  try {
    if (v instanceof PDFRawStream) return decodePDFRawStream(v).decode();
    return v.getContents();
  } catch {
    return null;
  }
}

// ===========================================================================
// ToUnicode CMap
// ===========================================================================

/** 16진 글자열(UTF-16BE)을 문자열로. */
function utf16FromHex(hex: string): string {
  const clean = hex.replace(/\s+/g, '');
  const units: number[] = [];
  for (let i = 0; i + 4 <= clean.length; i += 4) units.push(parseInt(clean.slice(i, i + 4), 16));
  if (clean.length === 2) units.push(parseInt(clean, 16));
  return String.fromCharCode(...units);
}

/**
 * ToUnicode CMap 을 읽어 "코드 → 글자" 표를 만든다.
 * 한 코드가 여러 글자(합자)를 뜻하는 항목은 거꾸로 쓸 수 없으므로 버린다.
 */
export function parseToUnicode(text: string): { map: Map<number, string>; bytes: 1 | 2 } {
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 2;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (cs) {
    const first = /<([0-9a-fA-F]+)>/.exec(cs[1]);
    if (first && first[1].length <= 2) bytes = 1;
  }

  const put = (code: number, s: string) => {
    if (Array.from(s).length === 1 && !map.has(code)) map.set(code, s);
  };

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (!cs && m[1].length <= 2) bytes = 1;
      put(parseInt(m[1], 16), utf16FromHex(m[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const m of body.matchAll(re)) {
      if (!cs && m[1].length <= 2) bytes = 1;
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi < lo || hi - lo > 0xffff) continue;
      if (m[3] !== undefined) {
        const start = utf16FromHex(m[3]);
        // 범위의 마지막 UTF-16 단위만 증가한다(PDF 규격).
        const head = start.slice(0, -1);
        const last = start.charCodeAt(start.length - 1);
        for (let c = lo; c <= hi; c++) put(c, head + String.fromCharCode(last + (c - lo)));
      } else if (m[4] !== undefined) {
        const items = Array.from(m[4].matchAll(/<([0-9a-fA-F]*)>/g)).map((x) => x[1]);
        items.forEach((h, i) => {
          if (lo + i <= hi) put(lo + i, utf16FromHex(h));
        });
      }
    }
  }
  return { map, bytes };
}

// ===========================================================================
// 글꼴 사전 → 인코더
// ===========================================================================

/** Type0 의 /W 배열을 읽는다: [c [w1 w2 ...]] 또는 [c1 c2 w]. */
function parseCidWidths(doc: PDFDocument, arr: PDFArray | null): Map<number, number> {
  const out = new Map<number, number>();
  if (!arr) return out;
  const items = arr.asArray();
  let i = 0;
  while (i < items.length && out.size < 70_000) {
    const first = lookupNumber(doc, items[i]);
    if (first === null) break;
    const next = items[i + 1] instanceof PDFRef ? doc.context.lookup(items[i + 1] as PDFRef) : items[i + 1];
    if (next instanceof PDFArray) {
      next.asArray().forEach((w, k) => {
        const n = lookupNumber(doc, w);
        if (n !== null) out.set(first + k, n);
      });
      i += 2;
    } else {
      const last = lookupNumber(doc, items[i + 1]);
      const w = lookupNumber(doc, items[i + 2]);
      if (last === null || w === null) break;
      for (let c = first; c <= last && c - first < 70_000; c++) out.set(c, w);
      i += 3;
    }
  }
  return out;
}

function fontProgram(doc: PDFDocument, descriptor: PDFDict | null): Uint8Array | null {
  if (!descriptor) return null;
  for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
    const bytes = streamBytes(doc, descriptor.get(PDFName.of(key)));
    if (bytes) return bytes;
  }
  return null;
}

const STANDARD_ASCII_ENCODINGS = new Set(['WinAnsiEncoding', 'StandardEncoding', 'MacRomanEncoding']);

export function encoderFromDict(doc: PDFDocument, dict: PDFDict, ref: PDFRef | null): FontEncoder | null {
  const subtype = nameOf(dict.get(PDFName.of('Subtype')));
  const baseFont = fontNameOf(doc, dict) ?? '';
  if (!subtype || !baseFont) return null;

  const toUni = streamBytes(doc, dict.get(PDFName.of('ToUnicode')));
  const cmap = toUni ? parseToUnicode(new TextDecoder('latin1').decode(toUni)) : null;
  const subset = /^[A-Z]{6}\+/.test(baseFont);

  if (subtype === 'Type0') {
    const encName = nameOf(dict.get(PDFName.of('Encoding')));
    const descendants = lookupArray(doc, dict.get(PDFName.of('DescendantFonts')));
    const cid = descendants ? lookupDict(doc, descendants.get(0)) : null;
    const descriptor = cid ? lookupDict(doc, cid.get(PDFName.of('FontDescriptor'))) : null;
    const program = fontProgram(doc, descriptor);
    const widths = cid ? parseCidWidths(doc, lookupArray(doc, cid.get(PDFName.of('W')))) : new Map();
    const dw = cid ? (lookupNumber(doc, cid.get(PDFName.of('DW'))) ?? 1000) : 1000;

    // 코드가 곧 UTF-16 인 한국어 CMap. 비내장이면 보는 쪽이 같은 글꼴로 그리므로 모든 글자를 쓸 수 있다.
    if (encName === 'UniKS-UCS2-H' || encName === 'UniKS-UTF16-H') {
      const inverse = cmap ? invert(cmap.map) : null;
      return {
        baseFont, ref, dict, bytesPerCode: 2, embedded: !!program, subset, program,
        chars: program ? (inverse ? new Set(inverse.keys()) : new Set()) : null,
        encode: (ch) => {
          const code = ch.charCodeAt(0);
          if (ch.length !== 1) return null;
          if (program) return inverse?.has(ch) ? code : null;
          return code;
        },
        widthOf: () => null,
      };
    }

    if ((encName === 'Identity-H' || encName === 'Identity-V') && cmap) {
      const inverse = invert(cmap.map);
      return {
        baseFont, ref, dict, bytesPerCode: 2, embedded: !!program, subset, program,
        chars: new Set(inverse.keys()),
        encode: (ch) => inverse.get(ch) ?? null,
        widthOf: (code) => widths.get(code) ?? dw,
      };
    }
    return null;
  }

  // Type3: 글자마다 그리기 절차가 들어 있다. 원본에 쓰인 코드(ToUnicode)만 다시 쓸 수 있다.
  if (subtype === 'Type3') {
    if (!cmap) return null;
    const inverse = invert(cmap.map);
    const fm = lookupArray(doc, dict.get(PDFName.of('FontMatrix')));
    const scale = fm ? (lookupNumber(doc, fm.get(0)) ?? 0.001) * 1000 : 1;
    const first3 = lookupNumber(doc, dict.get(PDFName.of('FirstChar'))) ?? 0;
    const w3 = lookupArray(doc, dict.get(PDFName.of('Widths')));
    return {
      baseFont, ref, dict, bytesPerCode: 1, embedded: true, subset: true, program: null,
      chars: new Set(inverse.keys()),
      encode: (ch) => {
        const c = inverse.get(ch);
        return c !== undefined && c <= 0xff ? c : null;
      },
      widthOf: (code) => {
        if (!w3) return null;
        const v = lookupNumber(doc, w3.get(code - first3));
        return v === null ? null : v * scale;
      },
    };
  }

  // 1바이트 글꼴 (Type1 · TrueType · MMType1)
  const descriptor = lookupDict(doc, dict.get(PDFName.of('FontDescriptor')));
  const program = fontProgram(doc, descriptor);
  const first = lookupNumber(doc, dict.get(PDFName.of('FirstChar'))) ?? 0;
  const widthsArr = lookupArray(doc, dict.get(PDFName.of('Widths')));
  const widthOf = (code: number) => {
    if (!widthsArr) return null;
    const idx = code - first;
    if (idx < 0 || idx >= widthsArr.size()) return null;
    return lookupNumber(doc, widthsArr.get(idx));
  };

  if (cmap) {
    const inverse = invert(cmap.map);
    return {
      baseFont, ref, dict, bytesPerCode: 1, embedded: !!program, subset, program,
      chars: new Set(inverse.keys()),
      encode: (ch) => {
        const c = inverse.get(ch);
        return c !== undefined && c <= 0xff ? c : null;
      },
      widthOf,
    };
  }

  // 표가 없으면 비내장(보는 쪽 글꼴로 그림) + 표준 인코딩일 때만 ASCII 를 그대로 쓴다.
  const encObj = dict.get(PDFName.of('Encoding'));
  const encName = nameOf(encObj);
  const encDict = lookupDict(doc, encObj);
  const hasDifferences = !!encDict?.get(PDFName.of('Differences'));
  const baseEnc = encName ?? (encDict ? nameOf(encDict.get(PDFName.of('BaseEncoding'))) : null);
  if (!program && !hasDifferences && (!baseEnc || STANDARD_ASCII_ENCODINGS.has(baseEnc))) {
    const ascii = new Set<string>();
    for (let c = 0x20; c <= 0x7e; c++) ascii.add(String.fromCharCode(c));
    return {
      baseFont, ref, dict, bytesPerCode: 1, embedded: false, subset, program: null,
      chars: ascii,
      encode: (ch) => (ascii.has(ch) ? ch.charCodeAt(0) : null),
      widthOf,
    };
  }
  return null;
}

function invert(map: Map<number, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [code, ch] of map) if (!out.has(ch)) out.set(ch, code);
  return out;
}

// ===========================================================================
// 쪽에서 글꼴 모으기
// ===========================================================================

export interface PageFont {
  /** 원본 사전 참조 (없으면 직접 사전) */
  ref: PDFRef | null;
  dict: PDFDict;
  baseFont: string;
}

/**
 * 한 쪽에서 쓰이는 글꼴 사전을 모두 모은다.
 * 쪽 자원뿐 아니라 그 안의 양식 XObject(머리말·꼬리말·표를 따로 묶은 것) 자원까지 본다.
 */
export function collectPageFonts(doc: PDFDocument, page: PDFPage): PageFont[] {
  const out: PageFont[] = [];
  const seen = new Set<string>();
  const visitResources = (res: PDFDict | null, depth: number) => {
    if (!res || depth > 4) return;
    const fonts = lookupDict(doc, res.get(PDFName.of('Font')));
    if (fonts) {
      for (const [, value] of fonts.entries()) {
        const ref = value instanceof PDFRef ? value : null;
        const key = ref ? ref.toString() : `inline-${out.length}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dict = lookupDict(doc, value);
        if (!dict) continue;
        const baseFont = fontNameOf(doc, dict);
        if (baseFont) out.push({ ref, dict, baseFont });
      }
    }
    const xobjects = lookupDict(doc, res.get(PDFName.of('XObject')));
    if (xobjects) {
      for (const [, value] of xobjects.entries()) {
        const target = value instanceof PDFRef ? doc.context.lookup(value) : value;
        if (target instanceof PDFStream) {
          const sub = target.dict;
          if (nameOf(sub.get(PDFName.of('Subtype'))) === 'Form') {
            visitResources(lookupDict(doc, sub.get(PDFName.of('Resources'))), depth + 1);
          }
        }
      }
    }
  };
  visitResources(page.node.Resources() ?? null, 0);
  return out;
}

/** 같은 BaseFont 이름의 사전을 묶어 인코더 목록으로. */
export function fontGroups(doc: PDFDocument, page: PDFPage): Map<string, FontEncoder[]> {
  const groups = new Map<string, FontEncoder[]>();
  for (const f of collectPageFonts(doc, page)) {
    const enc = encoderFromDict(doc, f.dict, f.ref);
    if (!enc) continue;
    const list = groups.get(f.baseFont) ?? [];
    list.push(enc);
    groups.set(f.baseFont, list);
  }
  return groups;
}

/** 이름으로 찾는다. 정확히 같은 이름이 없으면 부분집합 접두사를 떼고 비교한다. */
export function findGroup(groups: Map<string, FontEncoder[]>, baseFont: string): FontEncoder[] | null {
  const exact = groups.get(baseFont);
  if (exact?.length) return exact;
  const want = stripSubsetTag(baseFont);
  for (const [name, list] of groups) if (stripSubsetTag(name) === want && list.length) return list;
  return null;
}

/**
 * 새 글자를 원본 글꼴 사전들로 나눠 쓴다. 한 글자라도 어느 사전에도 없으면 null.
 * 연속한 글자는 같은 사전으로 묶어 Tf 전환을 줄인다.
 */
export function encodeWithGroup(
  group: FontEncoder[],
  text: string,
): Array<{ enc: FontEncoder; codes: number[] }> | null {
  const out: Array<{ enc: FontEncoder; codes: number[] }> = [];
  for (const ch of Array.from(text)) {
    let picked: { enc: FontEncoder; code: number } | null = null;
    const prev = out[out.length - 1]?.enc;
    if (prev) {
      const c = prev.encode(ch);
      if (c !== null) picked = { enc: prev, code: c };
    }
    if (!picked) {
      for (const enc of group) {
        const c = enc.encode(ch);
        if (c !== null) {
          picked = { enc, code: c };
          break;
        }
      }
    }
    if (!picked) return null;
    if (prev === picked.enc) out[out.length - 1].codes.push(picked.code);
    else out.push({ enc: picked.enc, codes: [picked.code] });
  }
  return out;
}

export function codesToHex(codes: number[], bytes: 1 | 2): PDFHexString {
  return PDFHexString.of(codes.map((c) => c.toString(16).padStart(bytes * 2, '0')).join(''));
}

/**
 * 편집기에 돌려줄 글꼴별 정보.
 * 전 쪽 합산 값과 함께 **쪽별** 값(`pages`)을 준다. 렌더러는 쪽마다 `findGroup(fontGroups(doc, page), 이름)`
 * 으로 고르므로, 같은 이름의 부분집합 사전이 쪽마다 다르면 합산 값으로는 예측이 틀린다.
 */
export function describeFonts(
  doc: PDFDocument,
  uploadedMatches: string[],
  reusable: (enc: FontEncoder) => boolean,
): PdfFontInfo[] {
  const summarize = (list: FontEncoder[]) => {
    let chars: Set<string> | null = new Set<string>();
    let canReuse = false;
    for (const enc of list) {
      if (enc.chars === null) chars = null;
      else if (chars) for (const ch of enc.chars) chars.add(ch);
      if (!canReuse && reusable(enc)) canReuse = true;
    }
    return { chars, reusable: canReuse };
  };
  const byName = new Map<string, { chars: Set<string> | null; reusable: boolean }>();
  const perPage: Array<Map<string, FontEncoder[]>> = [];
  for (const page of doc.getPages()) {
    const groups = fontGroups(doc, page);
    perPage.push(groups);
    for (const [name, list] of groups) {
      const cur = byName.get(name) ?? { chars: new Set<string>(), reusable: false };
      const s = summarize(list);
      if (s.chars === null) cur.chars = null;
      else if (cur.chars) for (const ch of s.chars) cur.chars.add(ch);
      if (s.reusable) cur.reusable = true;
      byName.set(name, cur);
    }
  }
  const pagesFor = (baseFont: string) => {
    const out: NonNullable<PdfFontInfo['pages']> = [];
    perPage.forEach((groups, i) => {
      const group = findGroup(groups, baseFont);
      if (!group) return;
      const s = summarize(group);
      out.push({ page: i + 1, chars: s.chars ? Array.from(s.chars).join('') : null, reusableProgram: s.reusable });
    });
    return out;
  };
  const uploaded = new Set(uploadedMatches.map((m) => m.toLowerCase()));
  return Array.from(byName.entries()).map(([baseFont, v]) => {
    const cls = classifyFontName(baseFont);
    return {
      baseFont,
      display: displayFontName(baseFont),
      serif: cls.serif,
      bold: cls.bold,
      chars: v.chars ? Array.from(v.chars).join('') : null,
      reusableProgram: v.reusable,
      uploaded: uploaded.has(stripSubsetTag(baseFont).toLowerCase()),
      pages: pagesFor(baseFont),
    };
  });
}
