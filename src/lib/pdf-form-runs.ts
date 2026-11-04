import { classifyFontName, matrixFontSize, type PdfEdit, type PdfMatrix } from '@/lib/pdf-form';

/**
 * pdf.js 텍스트 항목 → 편집 단위(한 줄 묶음).
 *
 * PDF 는 글자를 낱자·낱말 단위로 잘게 나눠 적는 경우가 많다(자간 조정, 한글·영문 글꼴 전환 등).
 * 그대로 고치게 하면 "금액" 한 단어를 고치는 데 서너 번 눌러야 하므로, 같은 글꼴·크기·방향으로
 * 이어지는 항목을 한 줄로 묶는다. 묶음의 시작 행렬·폭이 곧 덮개 영역이 된다.
 *
 * 브라우저 편집기와 테스트가 함께 쓴다(순수 함수).
 */

export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  /** pdf.js 내부 글꼴 키 */
  fontName: string;
}

export interface PdfTextRun {
  id: string;
  page: number;
  text: string;
  matrix: PdfMatrix;
  width: number;
  /** PDF 글꼴 이름(BaseFont) */
  baseFont: string;
  size: number;
  serif: boolean;
  bold: boolean;
}

const EPS = 0.5;

function sameDirection(a: number[], b: number[]): boolean {
  return (
    Math.abs(a[0] - b[0]) < 0.01 * Math.max(1, Math.abs(a[0])) + 0.01 &&
    Math.abs(a[1] - b[1]) < 0.01 * Math.max(1, Math.abs(a[1])) + 0.01 &&
    Math.abs(a[2] - b[2]) < 0.01 * Math.max(1, Math.abs(a[2])) + 0.01 &&
    Math.abs(a[3] - b[3]) < 0.01 * Math.max(1, Math.abs(a[3])) + 0.01
  );
}

/**
 * 같은 줄로 이어지는 항목을 묶는다.
 * @param fontNameOf pdf.js 글꼴 키 → PDF 글꼴 이름
 */
export function groupTextRuns(
  page: number,
  items: PdfTextItem[],
  fontNameOf: (key: string) => string,
): PdfTextRun[] {
  const runs: PdfTextRun[] = [];
  let cur: (PdfTextRun & { key: string; endU: number; dir: [number, number] }) | null = null;

  const flush = () => {
    if (cur && cur.text.trim()) {
      const { key: _k, endU: _e, dir: _d, ...run } = cur;
      runs.push({ ...run, text: run.text.replace(/\s+$/, ''), id: `p${page}-r${runs.length + 1}` });
    }
    cur = null;
  };

  for (const it of items) {
    if (!it || typeof it.str !== 'string' || !Array.isArray(it.transform) || it.transform.length !== 6) continue;
    const m = it.transform as PdfMatrix;
    const size = matrixFontSize(m);
    if (!(size > 0.5)) continue;
    const dir: [number, number] = [m[0] / size, m[1] / size];
    // 진행 방향 좌표(u)와 그에 수직인 좌표(v, 기준선 높이)
    const u = m[4] * dir[0] + m[5] * dir[1];
    const v = -m[4] * dir[1] + m[5] * dir[0];
    const key = it.fontName;

    if (!it.str) continue;
    if (cur) {
      const c = cur as PdfTextRun & { key: string; endU: number; dir: [number, number] };
      const cv = -c.matrix[4] * c.dir[1] + c.matrix[5] * c.dir[0];
      const gap = u - c.endU;
      const sameLine =
        sameDirection(c.matrix, m) && Math.abs(cv - v) < Math.max(EPS, size * 0.08) && gap > -size * 0.3 && gap < size * 0.6;
      // 같은 줄이면 글꼴이 달라도(한글·영문 글꼴 전환) 묶지 않는다 — 덮고 다시 쓸 글꼴이 하나여야 한다.
      if (sameLine && c.key === key) {
        if (gap > size * 0.15 && !/\s$/.test(c.text) && !/^\s/.test(it.str)) c.text += ' ';
        c.text += it.str;
        c.endU = Math.max(c.endU, u + it.width);
        c.width = c.endU - (c.matrix[4] * c.dir[0] + c.matrix[5] * c.dir[1]);
        continue;
      }
      // 공백 하나짜리 항목은 앞 묶음에 붙인다.
      if (sameLine && !it.str.trim()) {
        if (!/\s$/.test(c.text)) c.text += ' ';
        continue;
      }
      flush();
    }
    if (!it.str.trim()) continue;
    const baseFont = fontNameOf(key) || key;
    const cls = classifyFontName(baseFont);
    cur = {
      id: '',
      page,
      text: it.str,
      matrix: [...m] as PdfMatrix,
      width: it.width,
      baseFont,
      size,
      serif: cls.serif,
      bold: cls.bold,
      key,
      endU: u + it.width,
      dir,
    };
  }
  flush();
  return runs;
}

/** 덮개 꼭짓점 (PDF 좌표). 서버 렌더러와 같은 식이다. */
export function coverPolygon(edit: Pick<PdfEdit, 'matrix' | 'width'>): Array<[number, number]> {
  const [a, b, c, d, e, f] = edit.matrix;
  const size = matrixFontSize(edit.matrix) || 1;
  const pad = 0.05;
  const u0 = -pad;
  const u1 = edit.width / size + pad;
  const v0 = -0.26;
  const v1 = 0.95;
  const pt = (u: number, v: number): [number, number] => [a * u + c * v + e, b * u + d * v + f];
  return [pt(u0, v0), pt(u1, v0), pt(u1, v1), pt(u0, v1)];
}

/**
 * 직사각형 영역(PDF 좌표, 가로 글자 기준) → 덮개용 행렬·폭.
 * 영역 지우기·스캔본 글자 덮기에 쓴다. coverPolygon 으로 되돌리면 같은 사각형이 된다.
 */
export function rectToCover(x0: number, y0: number, x1: number, y1: number): { matrix: PdfMatrix; width: number } {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const bottom = Math.min(y0, y1);
  const top = Math.max(y0, y1);
  const s = Math.max(1, (top - bottom) / 1.21);
  return {
    matrix: [s, 0, 0, s, left + 0.05 * s, bottom + 0.26 * s],
    width: Math.max(0, right - left - 0.1 * s),
  };
}

/** 쪽 그림(RGBA)에서 영역의 바탕색과 글자색을 읽는다. 0~1 RGB. */
export function sampleColors(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  box: { x0: number; y0: number; x1: number; y1: number },
): { cover: [number, number, number]; color: [number, number, number] } {
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));
  const x0 = clamp(box.x0, width);
  const x1 = clamp(box.x1, width);
  const y0 = clamp(box.y0, height);
  const y1 = clamp(box.y1, height);
  const px = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };

  // 바탕: 테두리 픽셀에서 가장 흔한 색(양자화)
  const counts = new Map<string, { n: number; rgb: [number, number, number] }>();
  const addBorder = (x: number, y: number) => {
    const c = px(x, y);
    const k = c.map((v) => v >> 3).join(',');
    const e = counts.get(k);
    if (e) e.n++;
    else counts.set(k, { n: 1, rgb: c });
  };
  for (let x = x0; x <= x1; x++) {
    addBorder(x, y0);
    addBorder(x, y1);
  }
  for (let y = y0; y <= y1; y++) {
    addBorder(x0, y);
    addBorder(x1, y);
  }
  let bg: [number, number, number] = [255, 255, 255];
  let best = 0;
  for (const v of counts.values()) {
    if (v.n > best) {
      best = v.n;
      bg = v.rgb;
    }
  }

  // 글자: 바탕과 가장 먼 픽셀들의 평균(상위 15%)
  const dist: Array<{ d: number; c: [number, number, number] }> = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = px(x, y);
      const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (d > 60) dist.push({ d, c });
    }
  }
  let fg: [number, number, number] = [0, 0, 0];
  if (dist.length) {
    dist.sort((a, b) => b.d - a.d);
    const top = dist.slice(0, Math.max(1, Math.ceil(dist.length * 0.15)));
    fg = [0, 1, 2].map((k) => top.reduce((s, t) => s + t.c[k], 0) / top.length) as [number, number, number];
  }
  const norm = (c: [number, number, number]) =>
    c.map((v) => Math.round((v / 255) * 1000) / 1000) as [number, number, number];
  return { cover: norm(bg), color: norm(fg) };
}

/** 문서에 쓰인 글자 모양(글꼴·크기) 목록. 새 글을 넣을 때 고르게 한다. */
export interface TextStyleOption {
  key: string;
  baseFont: string;
  size: number;
  serif: boolean;
  bold: boolean;
  /** 이 모양이 쓰인 글자 묶음 수 */
  count: number;
  sample: string;
}

export function styleOptions(runs: PdfTextRun[]): TextStyleOption[] {
  const map = new Map<string, TextStyleOption>();
  for (const r of runs) {
    const size = Math.round(r.size * 10) / 10;
    const key = `${r.baseFont}|${size}`;
    const cur = map.get(key);
    if (cur) cur.count++;
    else map.set(key, { key, baseFont: r.baseFont, size, serif: r.serif, bold: r.bold, count: 1, sample: r.text.slice(0, 12) });
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count);
}
