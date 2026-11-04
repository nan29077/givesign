import {
  PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream,
  type PDFDocument, type PDFPage, type PDFObject,
} from 'pdf-lib';

/**
 * 덮은 자리의 원래 글자를 내용 스트림에서 실제로 지운다.
 *
 * 덮개만 그리면 눈에는 사라져도 원래 글자는 PDF 안에 남아 복사·검색·화면 낭독에서 나온다.
 * 약정 금액처럼 바꾼 값이 중요한 서식에서는 옛 값이 숨어 있으면 안 된다.
 *
 * ── 방식 ────────────────────────────────────────────────────────────────
 * 쪽의 내용 스트림을 토큰으로 읽으면서 글자 상태(행렬·글꼴·자간 등)를 따라가 글자마다
 * 위치를 계산한다. 글자 한가운데가 덮개 안에 들면 그 글자를 빼고, 빠진 폭만큼 위치 조정값을
 * 넣어 뒤에 오는 글자 자리가 그대로 유지되게 한다. 고치는 것은 해당 글자 연산 하나뿐이고
 * 나머지 바이트는 원본 그대로 둔다.
 *
 * ── 하지 않는 것 (안전하게 남겨 두는 경우) ──────────────────────────────
 *  - 폭을 알 수 없는 글꼴(Type3·특수 CMap): 뒤 글자 위치를 지킬 수 없어 지우지 않는다.
 *  - 양식 XObject 안의 글자: 쪽 스트림만 다룬다. 덮개는 그대로 가린다.
 *  - 읽다가 해석할 수 없는 구문을 만나면 그 쪽은 원본 스트림을 그대로 둔다.
 * 지우지 못해도 화면·인쇄 결과는 덮개로 같다. 결과 보고에 지운 글자 수를 남긴다.
 */

type Mat = [number, number, number, number, number, number];
const I: Mat = [1, 0, 0, 1, 0, 0];

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}
function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export type Polygon = Array<[number, number]>;

function inside(poly: Polygon, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi) hit = !hit;
  }
  return hit;
}

// ===========================================================================
// 토큰
// ===========================================================================

type Tok =
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'str'; bytes: number[]; s: number; e: number }
  | { t: 'name'; v: string; s: number; e: number }
  | { t: 'arr'; items: Tok[]; s: number; e: number }
  | { t: 'dict'; s: number; e: number }
  | { t: 'op'; v: string; s: number; e: number }
  | { t: 'other'; s: number; e: number };

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set('()<>[]{}/%'.split('').map((c) => c.charCodeAt(0)));

class Lexer {
  i = 0;
  constructor(private b: Uint8Array) {}

  skipWs() {
    const b = this.b;
    while (this.i < b.length) {
      const c = b[this.i];
      if (WS.has(c)) this.i++;
      else if (c === 0x25) {
        while (this.i < b.length && b[this.i] !== 0x0a && b[this.i] !== 0x0d) this.i++;
      } else break;
    }
  }

  next(): Tok | null {
    this.skipWs();
    const b = this.b;
    if (this.i >= b.length) return null;
    const s = this.i;
    const c = b[this.i];
    if (c === 0x28) return { t: 'str', bytes: this.literal(), s, e: this.i };
    if (c === 0x3c) {
      if (b[this.i + 1] === 0x3c) {
        this.dict();
        return { t: 'dict', s, e: this.i };
      }
      return { t: 'str', bytes: this.hex(), s, e: this.i };
    }
    if (c === 0x5b) {
      this.i++;
      const items: Tok[] = [];
      for (;;) {
        this.skipWs();
        if (this.i >= b.length) throw new Error('unterminated array');
        if (b[this.i] === 0x5d) {
          this.i++;
          break;
        }
        const tok = this.next();
        if (!tok) throw new Error('unterminated array');
        items.push(tok);
      }
      return { t: 'arr', items, s, e: this.i };
    }
    if (c === 0x2f) {
      this.i++;
      const st = this.i;
      while (this.i < b.length && !WS.has(b[this.i]) && !DELIM.has(b[this.i])) this.i++;
      return { t: 'name', v: latin1(b.subarray(st, this.i)), s, e: this.i };
    }
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      this.i++;
      return { t: 'other', s, e: this.i };
    }
    while (this.i < b.length && !WS.has(b[this.i]) && !DELIM.has(b[this.i])) this.i++;
    const word = latin1(b.subarray(s, this.i));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { t: 'num', v: Number(word), s, e: this.i };
    if (word === 'BI') {
      this.inlineImage();
      return { t: 'other', s, e: this.i };
    }
    return { t: 'op', v: word, s, e: this.i };
  }

  private literal(): number[] {
    const b = this.b;
    const out: number[] = [];
    let depth = 0;
    this.i++;
    while (this.i < b.length) {
      const c = b[this.i++];
      if (c === 0x5c) {
        const n = b[this.i++];
        const map: Record<number, number> = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 0x28, 0x29: 0x29, 0x5c: 0x5c };
        if (n in map) out.push(map[n]);
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let k = 0; k < 2 && b[this.i] >= 0x30 && b[this.i] <= 0x37; k++) v = v * 8 + (b[this.i++] - 0x30);
          out.push(v & 0xff);
        } else if (n === 0x0d) {
          if (b[this.i] === 0x0a) this.i++;
        } else if (n !== 0x0a) out.push(n);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (depth === 0) return out;
        depth--;
        out.push(c);
      } else out.push(c);
    }
    throw new Error('unterminated string');
  }

  private hex(): number[] {
    const b = this.b;
    this.i++;
    let digits = '';
    while (this.i < b.length && b[this.i] !== 0x3e) {
      const c = b[this.i++];
      if (!WS.has(c)) digits += String.fromCharCode(c);
    }
    this.i++;
    if (!/^[0-9a-fA-F]*$/.test(digits)) throw new Error('bad hex');
    if (digits.length % 2) digits += '0';
    const out: number[] = [];
    for (let k = 0; k < digits.length; k += 2) out.push(parseInt(digits.slice(k, k + 2), 16));
    return out;
  }

  private dict() {
    let depth = 0;
    const b = this.b;
    while (this.i < b.length) {
      if (b[this.i] === 0x3c && b[this.i + 1] === 0x3c) {
        depth++;
        this.i += 2;
      } else if (b[this.i] === 0x3e && b[this.i + 1] === 0x3e) {
        depth--;
        this.i += 2;
        if (depth === 0) return;
      } else if (b[this.i] === 0x28) {
        this.literal();
      } else this.i++;
    }
    throw new Error('unterminated dict');
  }

  /** 인라인 그림: ID 뒤 바이너리를 EI 까지 건너뛴다. */
  private inlineImage() {
    const b = this.b;
    while (this.i < b.length) {
      if (b[this.i] === 0x49 && b[this.i + 1] === 0x44 && WS.has(b[this.i + 2]) && WS.has(b[this.i - 1])) {
        this.i += 3;
        break;
      }
      this.i++;
    }
    while (this.i < b.length) {
      if (WS.has(b[this.i - 1]) && b[this.i] === 0x45 && b[this.i + 1] === 0x49 && (this.i + 2 >= b.length || WS.has(b[this.i + 2]))) {
        this.i += 2;
        return;
      }
      this.i++;
    }
    throw new Error('unterminated inline image');
  }
}

function latin1(bytes: Uint8Array): string {
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return s;
}

// ===========================================================================
// 글꼴 폭
// ===========================================================================

interface Metrics {
  bytes: 1 | 2;
  /** 1/1000 단위. 모르면 null */
  width(code: number): number | null;
}

function look(doc: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? doc.context.lookup(o) : o;
}
function num(doc: PDFDocument, o: PDFObject | undefined): number | null {
  const v = look(doc, o);
  return v instanceof PDFNumber ? v.asNumber() : null;
}

function metricsOf(doc: PDFDocument, dict: PDFDict): Metrics | null {
  const subtype = look(doc, dict.get(PDFName.of('Subtype')));
  const st = subtype instanceof PDFName ? subtype.decodeText() : '';
  if (!st) return null;
  if (st === 'Type3') {
    // 폭은 글리프 공간 값이라 FontMatrix 로 1/1000 em 단위로 바꾼다.
    const fm = look(doc, dict.get(PDFName.of('FontMatrix')));
    const scale = fm instanceof PDFArray ? (num(doc, fm.get(0)) ?? 0.001) * 1000 : 1;
    const first3 = num(doc, dict.get(PDFName.of('FirstChar'))) ?? 0;
    const w3 = look(doc, dict.get(PDFName.of('Widths')));
    if (!(w3 instanceof PDFArray)) return null;
    return {
      bytes: 1,
      width: (c) => {
        const idx = c - first3;
        if (idx < 0 || idx >= w3.size()) return null;
        const v = num(doc, w3.get(idx));
        return v === null ? null : v * scale;
      },
    };
  }
  if (st === 'Type0') {
    const enc = look(doc, dict.get(PDFName.of('Encoding')));
    const encName = enc instanceof PDFName ? enc.decodeText() : '';
    // Identity 계열만 코드 = CID 라서 /W 로 폭을 알 수 있다.
    if (encName !== 'Identity-H' && encName !== 'Identity-V') return null;
    const desc = look(doc, dict.get(PDFName.of('DescendantFonts')));
    const cid = desc instanceof PDFArray ? look(doc, desc.get(0)) : undefined;
    if (!(cid instanceof PDFDict)) return null;
    const dw = num(doc, cid.get(PDFName.of('DW'))) ?? 1000;
    const widths = new Map<number, number>();
    const w = look(doc, cid.get(PDFName.of('W')));
    if (w instanceof PDFArray) {
      const items = w.asArray();
      let k = 0;
      while (k < items.length) {
        const first = num(doc, items[k]);
        if (first === null) break;
        const next = look(doc, items[k + 1]);
        if (next instanceof PDFArray) {
          next.asArray().forEach((x, j) => {
            const n = num(doc, x);
            if (n !== null) widths.set(first + j, n);
          });
          k += 2;
        } else {
          const last = num(doc, items[k + 1]);
          const width = num(doc, items[k + 2]);
          if (last === null || width === null) break;
          for (let c = first; c <= last && c - first < 70_000; c++) widths.set(c, width);
          k += 3;
        }
      }
    }
    return { bytes: 2, width: (c) => widths.get(c) ?? dw };
  }
  const first = num(doc, dict.get(PDFName.of('FirstChar'))) ?? 0;
  const arr = look(doc, dict.get(PDFName.of('Widths')));
  const desc = look(doc, dict.get(PDFName.of('FontDescriptor')));
  const missing = desc instanceof PDFDict ? num(doc, desc.get(PDFName.of('MissingWidth'))) : null;
  if (!(arr instanceof PDFArray)) return null; // 표준 14 글꼴 등: 폭 표가 없어 지우지 않는다.
  return {
    bytes: 1,
    width: (c) => {
      const idx = c - first;
      if (idx < 0 || idx >= arr.size()) return missing;
      return num(doc, arr.get(idx)) ?? missing;
    },
  };
}

// ===========================================================================
// 해석 · 고쳐 쓰기
// ===========================================================================

interface Glyph {
  codes: number[];
  removed: boolean;
  /** 이 글자의 진행 폭(글자 공간 TJ 단위, 1/1000 em 기준) */
  advTJ: number;
}

export interface StripResult {
  /** 지운 글자 수 */
  removed: number;
  /** 해석하지 못해 원본을 그대로 둔 경우 */
  skipped: boolean;
}

/** 쪽 내용 스트림을 하나로 읽는다. */
function readContents(doc: PDFDocument, page: PDFPage): Uint8Array | null {
  const contents = look(doc, page.node.get(PDFName.of('Contents')));
  const streams: PDFObject[] = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  const parts: Uint8Array[] = [];
  for (const s of streams) {
    const st = look(doc, s);
    if (!(st instanceof PDFStream)) return null;
    try {
      parts.push(st instanceof PDFRawStream ? decodePDFRawStream(st).decode() : st.getContents());
    } catch {
      return null; // 알 수 없는 압축 방식
    }
  }
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 0x0a;
  }
  return out;
}

function hexOf(codes: number[], bytes: 1 | 2): string {
  return '<' + codes.map((c) => c.toString(16).padStart(bytes * 2, '0')).join('') + '>';
}

/**
 * 한 쪽의 덮개 영역 안 글자를 지운다.
 * 바뀐 것이 있으면 쪽 Contents 를 새 스트림 하나로 바꾼다.
 */
export function stripCoveredText(doc: PDFDocument, page: PDFPage, polys: Polygon[]): StripResult {
  if (polys.length === 0) return { removed: 0, skipped: false };
  const src = readContents(doc, page);
  if (!src) return { removed: 0, skipped: true };

  const res = page.node.Resources();
  const fontDict = res ? look(doc, res.get(PDFName.of('Font'))) : undefined;
  const metricsCache = new Map<string, Metrics | null>();
  const metricsFor = (name: string): Metrics | null => {
    if (metricsCache.has(name)) return metricsCache.get(name) ?? null;
    let m: Metrics | null = null;
    if (fontDict instanceof PDFDict) {
      const d = look(doc, fontDict.get(PDFName.of(name)));
      if (d instanceof PDFDict) m = metricsOf(doc, d);
    }
    metricsCache.set(name, m);
    return m;
  };

  const edits: Array<{ s: number; e: number; text: string }> = [];
  let removed = 0;

  try {
    const lx = new Lexer(src);
    const operands: Tok[] = [];
    let ctm: Mat = I;
    const stack: Mat[] = [];
    let tm: Mat = I;
    let tlm: Mat = I;
    let font: string | null = null;
    let fs = 1;
    let tc = 0;
    let tw = 0;
    let th = 1;
    let tl = 0;
    let rise = 0;
    // 직전 글자 연산 뒤 현재 위치를 모르면(폭을 모르는 글꼴) 다음 절대 위치 지정까지 지우지 않는다.
    let posKnown = true;

    const nextLine = () => {
      tlm = mul([1, 0, 0, 1, 0, -tl], tlm);
      tm = tlm;
      posKnown = true;
    };

    /** 글자열을 걸으며 지울 글자를 정한다. 고쳐 쓸 TJ 조각을 돌려준다(바뀐 것이 없으면 null). */
    const walk = (items: Array<{ bytes: number[] } | { adj: number }>): string | null => {
      const m = font ? metricsFor(font) : null;
      if (!m || !posKnown) {
        posKnown = false;
        return null;
      }
      const out: Array<Glyph | { adj: number }> = [];
      let changed = false;
      for (const it of items) {
        if ('adj' in it) {
          tm = mul([1, 0, 0, 1, (-it.adj / 1000) * fs * th, 0], tm);
          out.push(it);
          continue;
        }
        for (let k = 0; k + m.bytes <= it.bytes.length; k += m.bytes) {
          const code = m.bytes === 2 ? (it.bytes[k] << 8) | it.bytes[k + 1] : it.bytes[k];
          const w0 = m.width(code);
          if (w0 === null) {
            posKnown = false;
            return null;
          }
          const spacing = tc + (m.bytes === 1 && code === 32 ? tw : 0);
          const tx = ((w0 / 1000) * fs + spacing) * th;
          const trm = mul(mul([fs * th, 0, 0, fs, 0, rise], tm), ctm);
          // 글자 한가운데(진행 방향 절반, 높이 0.35em)
          const half = fs > 0 ? tx / 2 / (fs * th) : 0;
          const [cx, cy] = apply(trm, half, 0.35);
          const hit = polys.some((p) => inside(p, cx, cy));
          if (hit) {
            changed = true;
            removed++;
          }
          out.push({ codes: [code], removed: hit, advTJ: fs > 0 ? (tx / (fs * th)) * 1000 : 0 });
          tm = mul([1, 0, 0, 1, tx, 0], tm);
        }
      }
      if (!changed) return null;
      // 고쳐 쓰기: 남은 글자는 16진 글자열로, 지운 글자는 그 폭만큼 위치 조정값으로.
      const parts: string[] = [];
      let run: number[] = [];
      let gap = 0;
      const flushRun = () => {
        if (run.length) parts.push(hexOf(run, m.bytes));
        run = [];
      };
      const flushGap = () => {
        if (gap) parts.push(String(Math.round(-gap * 1000) / 1000));
        gap = 0;
      };
      for (const g of out) {
        if ('adj' in g) {
          flushRun();
          gap -= g.adj;
          continue;
        }
        if (g.removed) {
          flushRun();
          gap += g.advTJ;
        } else {
          flushGap();
          // 남는 글자의 Tc·Tw 는 원래대로 적용되므로 코드만 옮긴다.
          run.push(...g.codes);
        }
      }
      flushRun();
      flushGap();
      return `[${parts.join(' ')}] TJ`;
    };

    for (;;) {
      const tok = lx.next();
      if (!tok) break;
      if (tok.t !== 'op') {
        operands.push(tok);
        continue;
      }
      const op = tok.v;
      const nums = operands.filter((o): o is Extract<Tok, { t: 'num' }> => o.t === 'num').map((o) => o.v);
      const start = operands.length ? operands[0].s : tok.s;
      switch (op) {
        case 'q':
          stack.push(ctm);
          break;
        case 'Q':
          ctm = stack.pop() ?? I;
          break;
        case 'cm':
          if (nums.length === 6) ctm = mul(nums as Mat, ctm);
          break;
        case 'BT':
          tm = I;
          tlm = I;
          posKnown = true;
          break;
        case 'Tf': {
          const n = operands.find((o) => o.t === 'name');
          font = n && n.t === 'name' ? n.v : null;
          if (nums.length) fs = nums[nums.length - 1];
          break;
        }
        case 'Tc':
          if (nums.length) tc = nums[0];
          break;
        case 'Tw':
          if (nums.length) tw = nums[0];
          break;
        case 'Tz':
          if (nums.length) th = nums[0] / 100;
          break;
        case 'TL':
          if (nums.length) tl = nums[0];
          break;
        case 'Ts':
          if (nums.length) rise = nums[0];
          break;
        case 'Td':
        case 'TD':
          if (nums.length === 2) {
            if (op === 'TD') tl = -nums[1];
            tlm = mul([1, 0, 0, 1, nums[0], nums[1]], tlm);
            tm = tlm;
            posKnown = true;
          }
          break;
        case 'Tm':
          if (nums.length === 6) {
            tlm = nums as Mat;
            tm = tlm;
            posKnown = true;
          }
          break;
        case 'T*':
          nextLine();
          break;
        case 'Tj':
        case "'":
        case '"': {
          if (op === '"' && nums.length >= 2) {
            tw = nums[0];
            tc = nums[1];
          }
          if (op !== 'Tj') nextLine();
          const str = operands.find((o) => o.t === 'str');
          if (str && str.t === 'str') {
            const rewritten = walk([{ bytes: str.bytes }]);
            if (rewritten) {
              // ' 와 " 는 줄바꿈(·간격 설정)을 함께 하므로 그 효과를 앞에 풀어 쓴다.
              const prefix =
                op === "'" ? 'T* ' : op === '"' ? `${nums[0]} Tw ${nums[1]} Tc T* ` : '';
              edits.push({ s: start, e: tok.e, text: prefix + rewritten });
            }
          }
          break;
        }
        case 'TJ': {
          const arr = operands.find((o) => o.t === 'arr');
          if (arr && arr.t === 'arr') {
            const items: Array<{ bytes: number[] } | { adj: number }> = [];
            for (const it of arr.items) {
              if (it.t === 'str') items.push({ bytes: it.bytes });
              else if (it.t === 'num') items.push({ adj: it.v });
            }
            const rewritten = walk(items);
            if (rewritten) edits.push({ s: start, e: tok.e, text: rewritten });
          }
          break;
        }
        default:
          break;
      }
      operands.length = 0;
    }
  } catch {
    return { removed: 0, skipped: true };
  }

  if (edits.length === 0) return { removed: 0, skipped: false };

  // 뒤에서부터 바꿔 끼운다.
  const chunks: Uint8Array[] = [];
  let pos = 0;
  for (const ed of edits.sort((a, b) => a.s - b.s)) {
    chunks.push(src.subarray(pos, ed.s));
    chunks.push(new TextEncoder().encode(ed.text));
    pos = ed.e;
  }
  chunks.push(src.subarray(pos));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }

  const stream = doc.context.flateStream(out);
  page.node.set(PDFName.of('Contents'), doc.context.register(stream));
  return { removed, skipped: false };
}
