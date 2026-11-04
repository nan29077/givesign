'use client';

import * as React from 'react';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import {
  Eraser, Eye, Info, Loader2, Maximize2, MousePointerClick, Redo2, RotateCcw, ScanEye, Smartphone, TriangleAlert, Type,
  Undo2, Upload, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import { Card, CardTitle, cx } from '@/components/ui';
import { openPdf, pdfOpenErrorMessage } from '@/components/pdf/pdfjs';
import {
  MAX_EDIT_TEXT, MAX_PDF_EDITS, displayFontName, matrixFontSize, pdfFontTierLabel, predictFontTier, stripSubsetTag,
  type PdfEdit, type PdfFontInfo, type PdfFontTier, type PdfLayout, type PdfMatrix,
} from '@/lib/pdf-form';
import {
  coverPolygon, groupTextRuns, rectToCover, sampleColors, styleOptions, type PdfTextRun, type TextStyleOption,
} from '@/lib/pdf-form-runs';

/**
 * 올린 서식 원본 위에서 직접 고치는 편집기 (미리보기 겸용).
 *
 * 편집 내용(layout)은 부모가 쥔다. 서식 등록 폼에서는 폼 저장 때 함께 보내고,
 * 넓은 화면 편집(/studio/documents/[id]/edit)에서는 따로 저장한다.
 *
 * ── 화면 ────────────────────────────────────────────────────────────────
 *  - 편집: 보이는 그림은 항상 서버가 만든 "실제 결과 PDF" 다(고칠 때마다 다시 받아 그린다).
 *    입력 중에만 브라우저 글꼴로 비슷하게 보여 주고, 확정하면 서버 결과로 바꿔 그린다.
 *  - 원본 비교: 누르고 있는 동안 고치기 전 원본을 보여 준다.
 *  - 후원자 화면: 휴대폰 폭에서 후원자·서명자가 받는 모습 그대로 보여 준다.
 *
 * ── 할 수 있는 것 ──────────────────────────────────────────────────────
 *  - 글자 고치기: 원래 글자를 누르면 그 자리에서 고친다. 원래 글꼴·크기·색·방향 그대로.
 *  - 새 글 넣기: 빈자리를 누르면 가장 가까운 글자의 모양으로 넣는다. 넣은 글은 끌어서 옮길 수 있다.
 *  - 지우기: 글자를 누르거나, 끌어서 영역을 덮는다(바탕색으로). 원래 글자는 파일에서도 지운다.
 */

export type PdfEditorSource = { templateId: string } | { basePdfUrl: string; token: string };

type Mode = 'edit' | 'add' | 'erase';
type View = 'edit' | 'phone';

interface PageState {
  pageNo: number;
  widthPt: number;
  heightPt: number;
  runs: PdfTextRun[];
  /** 색 읽기용 원본 그림 */
  sample: { data: Uint8ClampedArray; width: number; height: number; viewport: PageViewport } | null;
}

type Active =
  | { kind: 'run'; run: PdfTextRun }
  | { kind: 'edit'; edit: PdfEdit }
  | { kind: 'new'; page: number; matrix: PdfMatrix; style: TextStyleOption | null; color: [number, number, number] };

interface ReportItem {
  id: string;
  tier: PdfFontTier | null;
  missing: string[];
}

const SANS_STACK = '"Noto Sans KR","Malgun Gothic","Apple SD Gothic Neo","Nanum Gothic",sans-serif';
const SERIF_STACK = '"Noto Serif KR","Batang","AppleMyungjo","Nanum Myeongjo",serif';
const SAMPLE_SCALE = 2;
const ZOOMS = [0.6, 0.75, 1, 1.25, 1.5, 2];

function rid(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function rgbCss(c: [number, number, number]) {
  return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
}

/** PDF 좌표의 다각형 → 화면 사각형 */
function boxOf(vp: PageViewport, poly: Array<[number, number]>) {
  const pts = poly.map(([x, y]) => vp.convertToViewportPoint(x, y));
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** 넣은 글의 대략적인 폭(화면 상자용). 실제 폭은 서버 결과 그림이 정확하다. */
function approxAddWidth(e: PdfEdit) {
  const size = matrixFontSize(e.matrix);
  let units = 0;
  for (const ch of Array.from(e.text)) units += /[ᄀ-ᇿ㄰-㆏가-힣一-鿿]/.test(ch) ? 1 : 0.55;
  return Math.max(size, units * size);
}

export function PdfFormEditor({
  source,
  basePdfUrl,
  initialResultUrl,
  fonts,
  convertedFrom,
  layout,
  onLayoutChange,
  variant = 'page',
  toolbarEnd,
  downloadName,
}: {
  source: PdfEditorSource;
  basePdfUrl: string;
  /** 저장된 결과 PDF. layout 이 저장된 것과 같을 때 첫 화면으로 쓴다. 없으면 미리보기를 만든다. */
  initialResultUrl: string | null;
  fonts: PdfFontInfo[];
  convertedFrom: string | null;
  layout: PdfLayout;
  onLayoutChange: (next: PdfLayout) => void;
  variant?: 'page' | 'embedded';
  /** 도구 막대 오른쪽 끝(저장 버튼 등) */
  toolbarEnd?: React.ReactNode;
  downloadName: string;
}) {
  const [past, setPast] = React.useState<PdfLayout[]>([]);
  const [future, setFuture] = React.useState<PdfLayout[]>([]);

  const [mode, setMode] = React.useState<Mode>('edit');
  const [view, setView] = React.useState<View>('edit');
  const [pages, setPages] = React.useState<PageState[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [baseDoc, setBaseDoc] = React.useState<PDFDocumentProxy | null>(null);
  const [resultDoc, setResultDoc] = React.useState<PDFDocumentProxy | null>(null);
  const [showOriginal, setShowOriginal] = React.useState(false);
  const [report, setReport] = React.useState<Map<string, ReportItem>>(new Map());
  const [coverOnly, setCoverOnly] = React.useState<number[]>([]);
  const [stripped, setStripped] = React.useState<number | null>(null);
  const [previewing, setPreviewing] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [active, setActive] = React.useState<Active | null>(null);
  const [draft, setDraft] = React.useState('');
  const [fit, setFit] = React.useState(1.2);
  const [zoom, setZoom] = React.useState(1);
  const [uploadingFont, setUploadingFont] = React.useState<string | null>(null);
  const scale = fit * zoom;

  const wrapRef = React.useRef<HTMLDivElement>(null);
  // 실행 취소·글꼴 올리기 등 비동기 처리에서 최신 기록을 읽기 위한 참조.
  const layoutRef = React.useRef(layout);
  React.useLayoutEffect(() => {
    layoutRef.current = layout;
  }, [layout]);

  // ── 글꼴 정보: 올린 글꼴은 편집 기록 기준으로 바로 반영한다 ─────────────
  const fontByName = React.useMemo(() => {
    const map = new Map<string, PdfFontInfo>();
    const uploaded = new Set(layout.fonts.map((f) => f.match.toLowerCase()));
    for (const f of fonts) {
      const info = { ...f, uploaded: uploaded.has(stripSubsetTag(f.baseFont).toLowerCase()) };
      map.set(f.baseFont, info);
      if (!map.has(stripSubsetTag(f.baseFont))) map.set(stripSubsetTag(f.baseFont), info);
    }
    return map;
  }, [fonts, layout.fonts]);
  const fontInfo = React.useCallback(
    (name: string) => fontByName.get(name) ?? fontByName.get(stripSubsetTag(name)),
    [fontByName],
  );

  const allRuns = React.useMemo(() => pages.flatMap((p) => p.runs), [pages]);
  const styles = React.useMemo(() => styleOptions(allRuns), [allRuns]);

  // ── 원본 읽기: 글자 묶음·색 읽기용 그림 ────────────────────────────────
  React.useEffect(() => {
    // 바탕 PDF 가 바뀌면 부모가 key 로 새로 그리므로 여기서 상태를 비울 필요가 없다.
    let cancelled = false;
    (async () => {
      try {
        const doc = await openPdf(basePdfUrl);
        if (cancelled) return;
        setBaseDoc(doc);
        const out: PageState[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          const vp1 = page.getViewport({ scale: 1 });
          const vp = page.getViewport({ scale: SAMPLE_SCALE });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(vp.width);
          canvas.height = Math.ceil(vp.height);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          let sample: PageState['sample'] = null;
          if (ctx) {
            await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
            sample = { data: ctx.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height, viewport: vp };
          }
          const text = await page.getTextContent();
          const nameOf = (key: string) => {
            try {
              const f = page.commonObjs.get(key) as { name?: string } | undefined;
              return f?.name ?? key;
            } catch {
              return key;
            }
          };
          const items = text.items.filter(
            (it): it is typeof it & { str: string; transform: number[]; width: number; fontName: string } => 'str' in it,
          );
          out.push({ pageNo: n, widthPt: vp1.width, heightPt: vp1.height, runs: groupTextRuns(n, items, nameOf), sample });
          if (cancelled) return;
        }
        if (!cancelled) setPages(out);
      } catch (err) {
        if (!cancelled) setLoadError(pdfOpenErrorMessage(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [basePdfUrl]);

  // ── 화면 폭에 맞춰 배율 ────────────────────────────────────────────────
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el || pages.length === 0) return;
    const maxW = Math.max(...pages.map((p) => p.widthPt));
    const doFit = () => setFit(Math.max(0.4, Math.min(1.8, (el.clientWidth - 8) / maxW)));
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages, view]);

  // ── 실제 결과 받기 (고칠 때마다, 0.45초 모아서) ───────────────────────────
  const layoutJson = JSON.stringify(layout);
  const sourceJson = JSON.stringify(source);
  const firstRun = React.useRef(true);
  React.useEffect(() => {
    const isFirst = firstRun.current;
    firstRun.current = false;
    // 첫 화면: 고친 곳이 없으면 원본, 저장된 결과가 있으면 그 파일을 그대로 쓴다.
    if (isFirst && (layout.edits.length === 0 || initialResultUrl)) {
      let cancelled = false;
      openPdf(layout.edits.length ? initialResultUrl! : basePdfUrl)
        .then((d) => !cancelled && setResultDoc(d))
        .catch(() => undefined);
      if (layout.edits.length === 0) return () => { cancelled = true; };
      // 저장된 결과를 보여 주면서도 글꼴 판정표는 받아 둔다(아래로 이어서 미리보기 요청).
    }
    if (layout.edits.length === 0) {
      let cancelled = false;
      openPdf(basePdfUrl)
        .then((d) => {
          if (cancelled) return;
          setReport(new Map());
          setCoverOnly([]);
          setStripped(null);
          setResultDoc(d);
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await fetch('/api/studio/pdf-form/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...source, layout }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { message?: string } | null;
          setNotice(data?.message ?? '미리보기를 만들지 못했습니다.');
          return;
        }
        const header = res.headers.get('x-render-report');
        if (header) {
          const parsed = JSON.parse(decodeURIComponent(header)) as { report: ReportItem[]; coverOnlyPages: number[]; stripped: number };
          setReport(new Map(parsed.report.map((r) => [r.id, r])));
          setCoverOnly(parsed.coverOnlyPages ?? []);
          setStripped(parsed.stripped ?? null);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (isFirst && initialResultUrl) return; // 첫 화면은 저장된 결과 그대로
        const doc = await openPdf(bytes);
        setNotice(null);
        setResultDoc((prev) => {
          if (prev && prev !== baseDoc) void prev.loadingTask.destroy();
          return doc;
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setNotice('미리보기를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.');
      } finally {
        setPreviewing(false);
      }
    }, isFirst ? 0 : 450);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutJson, sourceJson, basePdfUrl]);

  // ── 편집 기록 다루기 ───────────────────────────────────────────────────
  const commit = React.useCallback(
    (next: PdfLayout) => {
      setPast((p) => [...p.slice(-79), layoutRef.current]);
      setFuture([]);
      onLayoutChange(next);
    },
    [onLayoutChange],
  );
  const undo = React.useCallback(() => {
    if (past.length === 0) return;
    setActive(null);
    setFuture([layoutRef.current, ...future]);
    setPast(past.slice(0, -1));
    onLayoutChange(past[past.length - 1]);
  }, [past, future, onLayoutChange]);
  const redo = React.useCallback(() => {
    if (future.length === 0) return;
    setActive(null);
    setPast([...past, layoutRef.current]);
    setFuture(future.slice(1));
    onLayoutChange(future[0]);
  }, [past, future, onLayoutChange]);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [undo, redo]);

  const upsertEdit = (edit: PdfEdit) => {
    const cur = layoutRef.current;
    const exists = cur.edits.some((e) => e.id === edit.id);
    if (!exists && cur.edits.length >= MAX_PDF_EDITS) {
      setNotice(`수정은 ${MAX_PDF_EDITS}곳까지 할 수 있습니다.`);
      return;
    }
    commit({ ...cur, edits: exists ? cur.edits.map((e) => (e.id === edit.id ? edit : e)) : [...cur.edits, edit] });
  };
  const removeEdit = (id: string) => commit({ ...layoutRef.current, edits: layoutRef.current.edits.filter((e) => e.id !== id) });

  /** 원본 그림에서 그 자리의 바탕·글자색을 읽는다. */
  const colorsAt = (pageNo: number, poly: Array<[number, number]>) => {
    const p = pages.find((x) => x.pageNo === pageNo);
    if (!p?.sample) return { cover: [1, 1, 1] as [number, number, number], color: [0, 0, 0] as [number, number, number] };
    const b = boxOf(p.sample.viewport, poly);
    return sampleColors(p.sample.data, p.sample.width, p.sample.height, { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom });
  };

  const editForRun = (run: PdfTextRun) => layout.edits.find((e) => e.id === run.id) ?? null;

  // ── 누르기 처리 ────────────────────────────────────────────────────────
  const openRun = (run: PdfTextRun) => {
    const existing = editForRun(run);
    if (mode === 'erase') {
      if (existing) return;
      const { cover, color } = colorsAt(run.page, coverPolygon(run));
      upsertEdit({
        id: run.id, page: run.page, kind: 'erase', matrix: run.matrix, width: run.width, text: '',
        font: { baseFont: run.baseFont, serif: run.serif, bold: run.bold }, color, cover, original: run.text,
      });
      return;
    }
    if (existing) {
      setActive({ kind: 'edit', edit: existing });
      setDraft(existing.kind === 'erase' ? '' : existing.text);
      return;
    }
    setActive({ kind: 'run', run });
    setDraft(run.text);
  };

  const nearestStyle = (pageNo: number, x: number, y: number): { run: PdfTextRun | null; style: TextStyleOption | null } => {
    const runs = pages.find((p) => p.pageNo === pageNo)?.runs ?? [];
    let best: PdfTextRun | null = null;
    let bestD = Infinity;
    for (const r of runs) {
      // 같은 줄 높이를 더 중요하게 본다(표 안 빈칸은 옆 칸 글자 모양을 따르는 것이 자연스럽다).
      const d = Math.hypot((r.matrix[4] - x) * 0.5, (r.matrix[5] - y) * 1.5);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    const r = best ?? allRuns[0] ?? null;
    if (!r) return { run: null, style: null };
    const key = `${r.baseFont}|${Math.round(r.size * 10) / 10}`;
    return { run: r, style: styles.find((s) => s.key === key) ?? null };
  };

  const onPageClick = (pageNo: number, vp: PageViewport, e: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== 'add') return;
    if ((e.target as HTMLElement).closest('[data-editor-ui]')) return;
    if (active) {
      finish(true);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const [x, y] = vp.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
    const { run, style } = nearestStyle(pageNo, x, y);
    const size = style?.size ?? 11;
    const matrix: PdfMatrix = [size, 0, 0, size, x, y - size * 0.35];
    const color: [number, number, number] = run ? colorsAt(run.page, coverPolygon(run)).color : [0, 0, 0];
    setActive({ kind: 'new', page: pageNo, matrix, style, color });
    setDraft('');
  };

  // 영역 지우기(끌기)
  const dragRef = React.useRef<{ page: number; x0: number; y0: number; vp: PageViewport; el: HTMLDivElement } | null>(null);
  const [dragBox, setDragBox] = React.useState<{ page: number; left: number; top: number; w: number; h: number } | null>(null);
  const onPointerDown = (pageNo: number, vp: PageViewport, e: React.PointerEvent<HTMLDivElement>) => {
    if (mode !== 'erase' || (e.target as HTMLElement).closest('[data-editor-ui]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    dragRef.current = { page: pageNo, x0: e.clientX - rect.left, y0: e.clientY - rect.top, vp, el: e.currentTarget };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const rect = d.el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setDragBox({ page: d.page, left: Math.min(d.x0, x), top: Math.min(d.y0, y), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) });
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    const box = dragBox;
    setDragBox(null);
    if (!d || !box || box.w < 4 || box.h < 4) return;
    const [x0, y0] = d.vp.convertToPdfPoint(box.left, box.top);
    const [x1, y1] = d.vp.convertToPdfPoint(box.left + box.w, box.top + box.h);
    const { matrix, width } = rectToCover(x0, y0, x1, y1);
    const { cover, color } = colorsAt(d.page, coverPolygon({ matrix, width }));
    upsertEdit({
      id: rid('area'), page: d.page, kind: 'erase', matrix, width, text: '',
      font: { baseFont: '', serif: false, bold: false }, color, cover, original: '(영역)',
    });
  };

  /** 넣은 글 옮기기(화면 px 만큼) */
  const moveEdit = (edit: PdfEdit, vp: PageViewport, dx: number, dy: number) => {
    const [ax, ay] = vp.convertToPdfPoint(0, 0);
    const [bx, by] = vp.convertToPdfPoint(dx, dy);
    const m = edit.matrix;
    upsertEdit({ ...edit, matrix: [m[0], m[1], m[2], m[3], m[4] + (bx - ax), m[5] + (by - ay)] });
  };

  // ── 입력 확정 ──────────────────────────────────────────────────────────
  function finish(apply: boolean) {
    if (!active) return;
    const text = draft.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_EDIT_TEXT);
    if (apply) {
      if (active.kind === 'run') {
        const r = active.run;
        if (text !== r.text) {
          const { cover, color } = colorsAt(r.page, coverPolygon(r));
          upsertEdit({
            id: r.id, page: r.page, kind: text.trim() ? 'replace' : 'erase', matrix: r.matrix, width: r.width, text,
            font: { baseFont: r.baseFont, serif: r.serif, bold: r.bold }, color, cover, original: r.text,
          });
        }
      } else if (active.kind === 'edit') {
        const e = active.edit;
        if (e.kind === 'add' && !text.trim()) removeEdit(e.id);
        else if (e.kind !== 'add' && text === e.original) removeEdit(e.id);
        else if (text !== e.text || e.kind === 'erase') upsertEdit({ ...e, kind: e.kind === 'add' ? 'add' : text.trim() ? 'replace' : 'erase', text });
      } else if (active.kind === 'new' && text.trim()) {
        const st = active.style;
        upsertEdit({
          id: rid('add'), page: active.page, kind: 'add', matrix: active.matrix, width: 0, text,
          font: st ? { baseFont: st.baseFont, serif: st.serif, bold: st.bold } : { baseFont: '', serif: false, bold: false },
          color: active.color, cover: [1, 1, 1], original: '',
        });
      }
    }
    setActive(null);
    setDraft('');
  }

  /** 새 글의 모양을 문서에 쓰인 다른 모양으로 바꾼다. */
  const changeStyle = (key: string) => {
    if (!active) return;
    const st = styles.find((s) => s.key === key);
    if (!st) return;
    if (active.kind === 'new') {
      const m = active.matrix;
      setActive({ ...active, style: st, matrix: [st.size, 0, 0, st.size, m[4], m[5]] });
    } else if (active.kind === 'edit' && active.edit.kind === 'add') {
      const m = active.edit.matrix;
      const next: PdfEdit = {
        ...active.edit,
        font: { baseFont: st.baseFont, serif: st.serif, bold: st.bold },
        matrix: [st.size, 0, 0, st.size, m[4], m[5]],
      };
      upsertEdit(next);
      setActive({ kind: 'edit', edit: next });
    }
  };

  const uploadFont = async (font: PdfFontInfo, file: File) => {
    setUploadingFont(font.baseFont);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('match', stripSubsetTag(font.baseFont));
      const res = await fetch('/api/studio/pdf-form/font', { method: 'POST', body: fd });
      const data = (await res.json()) as { ok: boolean; message?: string; font?: { match: string; url: string; name: string } };
      if (!data.ok || !data.font) {
        setNotice(data.message ?? '글꼴을 올리지 못했습니다.');
        return;
      }
      const f = data.font;
      const cur = layoutRef.current;
      commit({ ...cur, fonts: [...cur.fonts.filter((x) => x.match.toLowerCase() !== f.match.toLowerCase()), f] });
    } catch {
      setNotice('글꼴을 올리지 못했습니다.');
    } finally {
      setUploadingFont(null);
    }
  };

  const tierOf = (edit: PdfEdit): { tier: PdfFontTier | null; missing: string[]; predicted: boolean } => {
    if (edit.kind === 'erase') return { tier: null, missing: [], predicted: false };
    const r = report.get(edit.id);
    if (r) return { tier: r.tier, missing: r.missing, predicted: false };
    const p = predictFontTier(edit.text, fontInfo(edit.font.baseFont));
    return { tier: p.tier, missing: p.missing, predicted: true };
  };

  const scrollToPage = (n: number) => {
    document.getElementById(`pdf-edit-page-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // ── 그리기 ─────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="rounded-xl bg-danger-50 px-3 py-3 text-[13px] leading-relaxed text-danger-500">
        <p className="flex items-start gap-2">
          <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" /> {loadError}
        </p>
        <a
          href={`${basePdfUrl}?name=${encodeURIComponent(`${downloadName}.pdf`)}`}
          className="mt-1.5 inline-block pl-6 text-[12px] font-bold text-ink-700 underline"
        >
          올린 서식 내려받아 확인하기
        </a>
      </div>
    );
  }

  const activeFontName = active
    ? active.kind === 'run'
      ? active.run.baseFont
      : active.kind === 'edit'
        ? active.edit.font.baseFont
        : (active.style?.baseFont ?? '')
    : '';
  const activeSize = active
    ? active.kind === 'run'
      ? active.run.size
      : matrixFontSize(active.kind === 'edit' ? active.edit.matrix : active.matrix)
    : 0;
  const activePrediction = active ? predictFontTier(draft, fontInfo(activeFontName)) : null;
  const activeStyleKey = active && activeFontName ? `${activeFontName}|${Math.round(activeSize * 10) / 10}` : '';
  const canPickStyle = active?.kind === 'new' || (active?.kind === 'edit' && active.edit.kind === 'add');
  const fallbackCount = layout.edits.filter((e) => tierOf(e).tier === 'FALLBACK').length;
  const displayDoc = showOriginal ? baseDoc : resultDoc;

  const sticky = variant === 'page' ? 'top-14' : 'top-2';

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_288px]">
      <div className="min-w-0">
        {/* 도구 막대 */}
        <div className={cx('sticky z-20 mb-3 flex flex-wrap items-center gap-1 rounded-2xl border border-ink-100 bg-white/95 p-1.5 shadow-sm backdrop-blur', sticky)}>
          <div className="flex items-center rounded-xl bg-ink-50 p-0.5">
            {(
              [
                { key: 'edit', label: '편집', icon: MousePointerClick },
                { key: 'phone', label: '후원자 화면', icon: Smartphone },
              ] as const
            ).map((v) => (
              <button
                key={v.key}
                type="button"
                onClick={() => {
                  finish(true);
                  setView(v.key);
                }}
                className={cx(
                  'flex h-8 items-center gap-1 rounded-lg px-2.5 text-[12px] font-bold',
                  view === v.key ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900',
                )}
              >
                <v.icon size={15} strokeWidth={1.7} />
                {v.label}
              </button>
            ))}
          </div>
          {view === 'edit' ? (
            <>
              <span className="mx-1 h-6 w-px bg-ink-100" />
              {(
                [
                  { key: 'edit', label: '글자 고치기', icon: Type },
                  { key: 'add', label: '새 글 넣기', icon: Type },
                  { key: 'erase', label: '지우기', icon: Eraser },
                ] as const
              ).map((m, i) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => {
                    finish(true);
                    setMode(m.key);
                  }}
                  className={cx(
                    'flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-[12.5px] font-bold',
                    mode === m.key ? 'bg-brand-700 text-white' : 'text-ink-700 hover:bg-ink-50',
                  )}
                  title={i === 0 ? '원래 글자를 눌러 고칩니다' : i === 1 ? '빈자리를 눌러 글을 넣습니다' : '글자를 누르거나 끌어서 덮습니다'}
                >
                  <m.icon size={16} strokeWidth={1.7} />
                  {m.label}
                </button>
              ))}
              <span className="mx-1 h-6 w-px bg-ink-100" />
              <IconButton onClick={undo} disabled={past.length === 0} title="되돌리기 (Ctrl+Z)"><Undo2 size={16} strokeWidth={1.7} /></IconButton>
              <IconButton onClick={redo} disabled={future.length === 0} title="다시 하기 (Ctrl+Shift+Z)"><Redo2 size={16} strokeWidth={1.7} /></IconButton>
              <span className="mx-1 h-6 w-px bg-ink-100" />
              <IconButton onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)] ?? z)} disabled={zoom <= ZOOMS[0]} title="축소"><ZoomOut size={16} strokeWidth={1.7} /></IconButton>
              <button type="button" onClick={() => setZoom(1)} className="h-9 min-w-12 rounded-xl px-1.5 text-[11.5px] font-bold text-ink-500 hover:bg-ink-50" title="화면 폭에 맞추기">
                {zoom === 1 ? '맞춤' : `${Math.round(zoom * 100)}%`}
              </button>
              <IconButton onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)] ?? z)} disabled={zoom >= ZOOMS[ZOOMS.length - 1]} title="확대"><ZoomIn size={16} strokeWidth={1.7} /></IconButton>
              <button
                type="button"
                onPointerDown={() => setShowOriginal(true)}
                onPointerUp={() => setShowOriginal(false)}
                onPointerLeave={() => setShowOriginal(false)}
                onKeyDown={(e) => e.key === ' ' && setShowOriginal(true)}
                onKeyUp={() => setShowOriginal(false)}
                disabled={layout.edits.length === 0}
                className={cx(
                  'ml-1 flex h-9 items-center gap-1 rounded-xl px-2.5 text-[12px] font-bold disabled:opacity-40',
                  showOriginal ? 'bg-ink-900 text-white' : 'text-ink-700 hover:bg-ink-50',
                )}
                title="누르고 있는 동안 고치기 전 원본을 보여 줍니다"
              >
                <ScanEye size={16} strokeWidth={1.7} /> 원본과 비교
              </button>
            </>
          ) : null}
          <span className="ml-auto flex items-center gap-2 pl-1 text-[11.5px] text-ink-400">
            {previewing ? (
              <>
                <Loader2 size={14} className="animate-spin" /> 결과 그리는 중
              </>
            ) : null}
            {toolbarEnd}
          </span>
        </div>

        {view === 'edit' ? (
          <p className="mb-2 text-[12px] leading-relaxed text-ink-500">
            {showOriginal
              ? '고치기 전 원본입니다. 손을 떼면 고친 결과로 돌아갑니다.'
              : mode === 'edit'
                ? '고칠 글자를 누르세요. 원래 글꼴·크기·색 그대로 그 자리에 들어갑니다. Enter 확정 · Esc 취소. 넣은 글은 끌어서 옮길 수 있습니다.'
                : mode === 'add'
                  ? '글을 넣을 자리를 누르세요. 가장 가까운 글자와 같은 글꼴·크기로 들어가고, 모양은 바꿀 수 있습니다.'
                  : '지울 글자를 누르거나, 끌어서 영역을 덮으세요. 바탕색으로 덮고 원래 글자는 파일에서도 지웁니다.'}
          </p>
        ) : null}

        {notice ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl bg-danger-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-danger-500">
            <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" />
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="shrink-0 opacity-60 hover:opacity-100" aria-label="닫기">
              <X size={14} />
            </button>
          </div>
        ) : null}

        {convertedFrom === 'image' && view === 'edit' ? (
          <p className="mb-3 rounded-xl bg-ink-50 px-3 py-2 text-[12px] text-ink-700">
            스캔 그림으로 만든 서식이라 원래 글자를 글자로 고칠 수 없습니다. [지우기] 로 영역을 덮고 [새 글 넣기] 로 써 주세요.
          </p>
        ) : null}

        <div ref={wrapRef} className={cx('rounded-2xl bg-ink-50/70 p-2 sm:p-4', variant === 'embedded' ? 'max-h-[78vh] overflow-auto' : '')}>
          {pages.length === 0 ? (
            <div className="flex h-60 items-center justify-center text-[13px] text-ink-400">
              <Loader2 size={16} className="mr-2 animate-spin" /> 원본을 읽는 중입니다
            </div>
          ) : view === 'phone' ? (
            <PhonePreview doc={resultDoc} pages={pages.length} />
          ) : (
            <div className="space-y-4">
              {pages.map((p) => (
                <PageView
                  key={p.pageNo}
                  page={p}
                  scale={scale}
                  doc={displayDoc}
                  mode={showOriginal ? 'view' : mode}
                  edits={layout.edits.filter((e) => e.page === p.pageNo)}
                  active={active}
                  draft={draft}
                  setDraft={setDraft}
                  finish={finish}
                  onRun={openRun}
                  onEdit={(e) => {
                    setActive({ kind: 'edit', edit: e });
                    setDraft(e.text);
                  }}
                  onMove={moveEdit}
                  onClick={onPageClick}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  dragBox={dragBox?.page === p.pageNo ? dragBox : null}
                  hint={
                    activePrediction && active ? (
                      <EditHint
                        prediction={activePrediction}
                        fontName={activeFontName}
                        size={activeSize}
                        styles={canPickStyle ? styles : null}
                        styleKey={activeStyleKey}
                        onStyle={changeStyle}
                        onDelete={
                          active.kind === 'edit'
                            ? () => {
                                removeEdit(active.edit.id);
                                setActive(null);
                              }
                            : null
                        }
                      />
                    ) : null
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── 오른쪽: 쪽 · 수정 목록 · 글꼴 ─────────────────────────────── */}
      <aside className={cx('min-w-0 space-y-3 lg:sticky lg:self-start lg:overflow-y-auto', variant === 'page' ? 'lg:top-20 lg:max-h-[calc(100vh-6rem)]' : 'lg:top-2 lg:max-h-[80vh]')}>
        {pages.length > 1 ? (
          <div className="rounded-2xl border border-ink-100 bg-white p-3">
            <p className="mb-2 text-[12px] font-bold text-ink-700">쪽 {pages.length}</p>
            <div className="flex flex-wrap gap-1.5">
              {pages.map((p) => {
                const n = layout.edits.filter((e) => e.page === p.pageNo).length;
                return (
                  <button
                    key={p.pageNo}
                    type="button"
                    onClick={() => {
                      setView('edit');
                      scrollToPage(p.pageNo);
                    }}
                    className="relative h-8 min-w-8 rounded-lg border border-ink-200 px-2 text-[12px] font-bold text-ink-700 hover:border-brand-400"
                  >
                    {p.pageNo}
                    {n ? <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-brand-700 px-1 text-[9.5px] text-white">{n}</span> : null}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>수정한 곳 {layout.edits.length}</CardTitle>
            {layout.edits.length ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('모든 수정을 지우고 원본으로 되돌립니다.')) commit({ ...layout, edits: [] });
                }}
                className="flex items-center gap-1 text-[11.5px] font-bold text-ink-500 hover:text-ink-900"
              >
                <RotateCcw size={13} strokeWidth={1.8} /> 원본으로
              </button>
            ) : null}
          </div>
          {layout.edits.length === 0 ? (
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-400">아직 고친 곳이 없습니다. 올린 원본이 그대로 쓰입니다.</p>
          ) : (
            <>
              <p className={cx('mt-1 text-[11.5px]', fallbackCount ? 'text-warning-500' : 'text-brand-700')}>
                {fallbackCount
                  ? `${fallbackCount}곳은 원본 글꼴에 없는 글자가 있어 같은 계열 글꼴로 들어갑니다.`
                  : '모두 원본 글꼴로 들어갑니다.'}
                {stripped ? ` 덮은 자리의 원래 글자 ${stripped}자는 파일에서도 지웁니다.` : ''}
              </p>
              <ul className="mt-2 space-y-1.5">
                {layout.edits.map((e) => {
                  const t = tierOf(e);
                  return (
                    <li key={e.id}>
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          setView('edit');
                          scrollToPage(e.page);
                          if (e.kind !== 'erase') {
                            setActive({ kind: 'edit', edit: e });
                            setDraft(e.text);
                          }
                        }}
                        onKeyDown={(ev) => ev.key === 'Enter' && (ev.currentTarget as HTMLElement).click()}
                        className="flex cursor-pointer items-start gap-2 rounded-xl border border-ink-100 px-2.5 py-2 hover:border-brand-200"
                      >
                        <span className="mt-0.5 shrink-0 rounded-md bg-ink-50 px-1.5 py-0.5 text-[10.5px] font-bold text-ink-500">{e.page}쪽</span>
                        <div className="min-w-0 flex-1 text-[12px] leading-snug">
                          {e.kind === 'add' ? (
                            <p className="truncate font-semibold text-ink-900">+ {e.text}</p>
                          ) : e.kind === 'erase' ? (
                            <p className="truncate text-ink-500 line-through">{e.original || '영역'}</p>
                          ) : (
                            <>
                              <p className="truncate text-ink-400 line-through">{e.original}</p>
                              <p className="truncate font-semibold text-ink-900">{e.text}</p>
                            </>
                          )}
                          {t.tier ? (
                            <p className={cx('mt-0.5 text-[11px]', t.tier === 'FALLBACK' ? 'text-warning-500' : 'text-brand-700')}>
                              {pdfFontTierLabel[t.tier].text} · {e.font.baseFont ? displayFontName(e.font.baseFont) : '기본'}{' '}
                              {Math.round(matrixFontSize(e.matrix) * 10) / 10}pt
                              {t.missing.length && t.tier === 'FALLBACK' ? ` · 없는 글자: ${t.missing.slice(0, 6).join(' ')}` : ''}
                              {t.predicted ? ' (예상)' : ''}
                            </p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            removeEdit(e.id);
                          }}
                          className="shrink-0 text-ink-300 hover:text-ink-700"
                          aria-label="이 수정 되돌리기"
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {coverOnly.length ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
              {coverOnly.join(', ')}쪽은 원본 구조상 원래 글자를 파일에서 지우지 못하고 덮기만 합니다. 화면·인쇄 결과는 같습니다.
            </p>
          ) : null}
        </Card>

        <Card>
          <CardTitle>원본 글꼴</CardTitle>
          <p className="mb-2 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
            PDF 에는 보통 문서에 쓰인 글자만 들어 있습니다. 그 밖의 글자는 같은 계열·굵기의 글꼴로 넣고 크기·색은 그대로 둡니다.
            같은 글꼴 파일(TTF·OTF)을 올리면 모든 글자를 원본 글꼴로 씁니다.
          </p>
          {fonts.length === 0 ? (
            <p className="text-[12px] text-ink-400">글자로 된 내용이 없는 서식입니다(스캔본).</p>
          ) : (
            <ul className="space-y-1.5">
              {dedupeFonts(fonts).map((f) => {
                const info = fontInfo(f.baseFont) ?? f;
                const sizes = Array.from(
                  new Set(allRuns.filter((r) => stripSubsetTag(r.baseFont) === stripSubsetTag(f.baseFont)).map((r) => Math.round(r.size * 10) / 10)),
                ).sort((a, b) => a - b);
                return (
                  <li key={f.baseFont} className="rounded-xl border border-ink-100 px-2.5 py-2 text-[12px]">
                    <p className="font-semibold text-ink-900" style={{ fontFamily: f.serif ? SERIF_STACK : SANS_STACK, fontWeight: f.bold ? 700 : 400 }}>
                      {displayFontName(f.baseFont)}
                    </p>
                    <p className="mt-0.5 text-[11px] text-ink-400">
                      {f.serif ? '명조 계열' : '고딕 계열'}
                      {f.bold ? ' · 굵게' : ''}
                      {sizes.length ? ` · ${sizes.slice(0, 5).join(', ')}pt` : ''}
                      {' · '}
                      {info.uploaded
                        ? '올린 글꼴 사용'
                        : info.chars === null
                          ? '모든 글자 사용 가능'
                          : info.reusableProgram
                            ? '글꼴 전체 포함'
                            : `원본에 있는 글자 ${Array.from(info.chars ?? '').length}자`}
                    </p>
                    <label className="mt-1.5 inline-flex cursor-pointer items-center gap-1 text-[11.5px] font-bold text-brand-700 hover:underline">
                      {uploadingFont === f.baseFont ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} strokeWidth={1.8} />}
                      {info.uploaded ? '글꼴 파일 바꾸기' : '이 글꼴 파일 올리기'}
                      <input
                        type="file"
                        accept=".ttf,.otf"
                        className="hidden"
                        onChange={(ev) => {
                          const file = ev.target.files?.[0];
                          if (file) void uploadFont(f, file);
                          ev.target.value = '';
                        }}
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <p className="flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-ink-400">
          <Info size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" />
          올린 원본은 그대로 보관되고, 저장할 때마다 고친 결과가 새 파일로 남습니다. 이미 보낸 서명 요청·작성 링크는 보낼 때의 서식 그대로입니다.
          {' '}
          <a href={`${basePdfUrl}?name=${encodeURIComponent(`${downloadName}_원본.pdf`)}`} className="font-bold text-ink-500 underline">
            원본 내려받기
          </a>
        </p>
      </aside>
    </div>
  );
}

function IconButton({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="grid h-9 w-9 place-items-center rounded-xl text-ink-700 hover:bg-ink-50 disabled:opacity-35" {...props}>
      {children}
    </button>
  );
}

function dedupeFonts(fonts: PdfFontInfo[]): PdfFontInfo[] {
  const seen = new Set<string>();
  return fonts.filter((f) => {
    const k = stripSubsetTag(f.baseFont);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ===========================================================================
// 쪽 그리기 (공용)
// ===========================================================================

/** 쪽 하나를 캔버스에 그린다. scale 을 주면 그 배율, width 를 주면 그 폭에 맞춘다. */
function useRenderedPage(doc: PDFDocumentProxy | null, pageNo: number, size: { scale?: number; width?: number }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [vp, setVp] = React.useState<PageViewport | null>(null);
  const { scale, width } = size;

  React.useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      let pg: PDFPageProxy;
      try {
        pg = await doc.getPage(pageNo);
      } catch {
        return;
      }
      if (cancelled) return;
      const vp1 = pg.getViewport({ scale: 1 });
      const viewport = pg.getViewport({ scale: width ? width / vp1.width : (scale ?? 1) });
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const off = document.createElement('canvas');
      off.width = Math.ceil(viewport.width * dpr);
      off.height = Math.ceil(viewport.height * dpr);
      const ctx = off.getContext('2d');
      if (!ctx) return;
      task = pg.render({ canvas: off, canvasContext: ctx, viewport, transform: [dpr, 0, 0, dpr, 0, 0] });
      try {
        await task.promise;
      } catch {
        return;
      }
      if (cancelled) return;
      // 다 그린 뒤 한 번에 바꿔 끼워 깜빡임을 없앤다.
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      canvas.getContext('2d')?.drawImage(off, 0, 0);
      setVp(viewport);
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, pageNo, scale, width]);
  return { canvasRef, vp };
}

function PageView({
  page, scale, doc, mode, edits, active, draft, setDraft, finish, onRun, onEdit, onMove, onClick,
  onPointerDown, onPointerMove, onPointerUp, dragBox, hint,
}: {
  page: PageState;
  scale: number;
  doc: PDFDocumentProxy | null;
  mode: Mode | 'view';
  edits: PdfEdit[];
  active: Active | null;
  draft: string;
  setDraft: (v: string) => void;
  finish: (apply: boolean) => void;
  onRun: (r: PdfTextRun) => void;
  onEdit: (e: PdfEdit) => void;
  onMove: (e: PdfEdit, vp: PageViewport, dx: number, dy: number) => void;
  onClick: (pageNo: number, vp: PageViewport, e: React.MouseEvent<HTMLDivElement>) => void;
  onPointerDown: (pageNo: number, vp: PageViewport, e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: () => void;
  dragBox: { left: number; top: number; w: number; h: number } | null;
  hint: React.ReactNode;
}) {
  const { canvasRef, vp } = useRenderedPage(doc, page.pageNo, { scale });

  // 넣은 글 끌어 옮기기
  const moveRef = React.useRef<{ edit: PdfEdit; x: number; y: number; moved: boolean } | null>(null);
  const [moveDelta, setMoveDelta] = React.useState<{ id: string; dx: number; dy: number } | null>(null);

  const editIds = new Set(edits.map((e) => e.id));
  const activeId = active?.kind === 'run' ? active.run.id : active?.kind === 'edit' ? active.edit.id : null;
  const interactive = mode !== 'view';

  return (
    <div id={`pdf-edit-page-${page.pageNo}`} className="mx-auto w-fit scroll-mt-24">
      <p className="mb-1 text-[11px] font-bold text-ink-400">{page.pageNo}쪽</p>
      <div
        className={cx(
          'relative select-none overflow-hidden rounded-[3px] bg-white shadow-[0_1px_6px_rgba(15,23,42,0.14)]',
          mode === 'add' ? 'cursor-text' : mode === 'erase' ? 'cursor-crosshair' : '',
        )}
        style={{ width: vp?.width ?? page.widthPt * scale, height: vp?.height ?? page.heightPt * scale }}
        onClick={(e) => vp && interactive && onClick(page.pageNo, vp, e)}
        onPointerDown={(e) => vp && interactive && onPointerDown(page.pageNo, vp, e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="block" />

        {vp && interactive && mode !== 'add'
          ? page.runs.map((r) => {
              if (r.id === activeId) return null;
              const b = boxOf(vp, coverPolygon(r));
              const edited = editIds.has(r.id);
              return (
                <button
                  key={r.id}
                  type="button"
                  data-editor-ui
                  title={r.text}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRun(r);
                  }}
                  className={cx(
                    'absolute rounded-[2px] transition-colors',
                    edited ? 'ring-1 ring-brand-400/70' : '',
                    mode === 'erase' ? 'hover:bg-danger-500/15' : 'hover:bg-brand-500/15 hover:ring-1 hover:ring-brand-500',
                  )}
                  style={{ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top }}
                />
              );
            })
          : null}

        {vp && interactive
          ? edits
              .filter((e) => e.kind === 'add' && e.id !== activeId)
              .map((e) => {
                const b = boxOf(vp, coverPolygon({ matrix: e.matrix, width: approxAddWidth(e) }));
                const d = moveDelta?.id === e.id ? moveDelta : null;
                return (
                  <button
                    key={e.id}
                    type="button"
                    data-editor-ui
                    title="눌러서 고치기 · 끌어서 옮기기"
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      moveRef.current = { edit: e, x: ev.clientX, y: ev.clientY, moved: false };
                      ev.currentTarget.setPointerCapture(ev.pointerId);
                    }}
                    onPointerMove={(ev) => {
                      const m = moveRef.current;
                      if (!m) return;
                      const dx = ev.clientX - m.x;
                      const dy = ev.clientY - m.y;
                      if (!m.moved && Math.hypot(dx, dy) < 4) return;
                      m.moved = true;
                      setMoveDelta({ id: e.id, dx, dy });
                    }}
                    onPointerUp={(ev) => {
                      ev.stopPropagation();
                      const m = moveRef.current;
                      moveRef.current = null;
                      setMoveDelta(null);
                      if (!m) return;
                      if (m.moved) onMove(m.edit, vp, ev.clientX - m.x, ev.clientY - m.y);
                      else onEdit(e);
                    }}
                    onClick={(ev) => ev.stopPropagation()}
                    className={cx(
                      'absolute cursor-move rounded-[2px] border border-dashed border-brand-400 hover:bg-brand-500/10',
                      d ? 'bg-brand-500/10' : '',
                    )}
                    style={{
                      left: b.left,
                      top: b.top,
                      width: b.right - b.left,
                      height: b.bottom - b.top,
                      transform: d ? `translate(${d.dx}px, ${d.dy}px)` : undefined,
                    }}
                  />
                );
              })
          : null}

        {vp && interactive && active && activePage(active) === page.pageNo ? (
          <InlineInput vp={vp} active={active} draft={draft} setDraft={setDraft} finish={finish} hint={hint} />
        ) : null}

        {dragBox ? (
          <div className="pointer-events-none absolute border border-danger-500 bg-danger-500/10" style={{ left: dragBox.left, top: dragBox.top, width: dragBox.w, height: dragBox.h }} />
        ) : null}
      </div>
    </div>
  );
}

function activePage(a: Active): number {
  return a.kind === 'run' ? a.run.page : a.kind === 'edit' ? a.edit.page : a.page;
}

/** 후원자 휴대폰에서 보이는 모습 (360px 폭) */
function PhonePreview({ doc, pages }: { doc: PDFDocumentProxy | null; pages: number }) {
  return (
    <div className="flex flex-col items-center py-2">
      <div className="w-[360px] max-w-full overflow-hidden rounded-[28px] border-[6px] border-ink-900 bg-white shadow-xl">
        <div className="flex items-center gap-1.5 border-b border-ink-100 px-4 py-2.5 text-[12px] font-bold text-ink-700">
          <Eye size={14} strokeWidth={1.7} /> 후원자·서명자가 보는 서식
        </div>
        <div className="max-h-[70vh] space-y-2 overflow-y-auto bg-ink-50 p-3">
          {Array.from({ length: pages }, (_, i) => (
            <PhonePage key={i} doc={doc} pageNo={i + 1} />
          ))}
          <p className="pb-1 pt-2 text-center text-[11px] text-ink-400">아래에 작성 항목·서명 칸이 이어집니다</p>
        </div>
      </div>
      <p className="mt-2 flex items-center gap-1 text-[11.5px] text-ink-400">
        <Maximize2 size={13} strokeWidth={1.7} /> 휴대폰 폭에 맞춰 줄어든 모습입니다. 글자가 너무 작으면 내려받아 볼 수 있게 안내됩니다.
      </p>
    </div>
  );
}

function PhonePage({ doc, pageNo }: { doc: PDFDocumentProxy | null; pageNo: number }) {
  const { canvasRef } = useRenderedPage(doc, pageNo, { width: 324 });
  return <canvas ref={canvasRef} className="block rounded-md bg-white ring-1 ring-ink-100" />;
}

/** 원래 글자 자리 위에 같은 크기·색으로 뜨는 입력칸 */
function InlineInput({
  vp, active, draft, setDraft, finish, hint,
}: {
  vp: PageViewport;
  active: Active;
  draft: string;
  setDraft: (v: string) => void;
  finish: (apply: boolean) => void;
  hint: React.ReactNode;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  let matrix: PdfMatrix;
  let width: number;
  let serif = false;
  let bold = false;
  let color: [number, number, number] = [0, 0, 0];
  let cover: [number, number, number] | null = null;
  if (active.kind === 'run') {
    matrix = active.run.matrix;
    width = active.run.width;
    serif = active.run.serif;
    bold = active.run.bold;
  } else if (active.kind === 'edit') {
    matrix = active.edit.matrix;
    width = active.edit.kind === 'add' ? approxAddWidth(active.edit) : active.edit.width;
    serif = active.edit.font.serif;
    bold = active.edit.font.bold;
    color = active.edit.color;
    cover = active.edit.kind === 'add' ? null : active.edit.cover;
  } else {
    matrix = active.matrix;
    width = 0;
    serif = active.style?.serif ?? false;
    bold = active.style?.bold ?? false;
    color = active.color;
  }
  const size = matrixFontSize(matrix);
  const b = boxOf(vp, coverPolygon({ matrix, width: Math.max(width, size * 4) }));
  const px = size * vp.scale;

  return (
    <div data-editor-ui className="absolute z-10" style={{ left: b.left - 2, top: b.top - 2 }} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        value={draft}
        maxLength={MAX_EDIT_TEXT}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onBlur={(e) => {
          // 모양 고르기·되돌리기 버튼으로 옮겨 갈 때는 닫지 않는다.
          if ((e.relatedTarget as HTMLElement | null)?.closest('[data-editor-hint]')) return;
          finish(true);
        }}
        className="rounded-[3px] border-0 px-0.5 outline-none ring-2 ring-brand-500"
        style={{
          fontFamily: serif ? SERIF_STACK : SANS_STACK,
          fontWeight: bold ? 700 : 400,
          fontSize: px,
          lineHeight: `${b.bottom - b.top + 2}px`,
          height: b.bottom - b.top + 4,
          minWidth: Math.max(60, b.right - b.left + 4),
          width: `${Math.max(4, Array.from(draft).length + 1) * 1.05}em`,
          maxWidth: Math.max(80, vp.width - b.left),
          color: rgbCss(color),
          background: cover ? rgbCss(cover) : 'rgba(255,255,255,0.96)',
        }}
      />
      {hint}
    </div>
  );
}

function EditHint({
  prediction, fontName, size, styles, styleKey, onStyle, onDelete,
}: {
  prediction: { tier: PdfFontTier; missing: string[] };
  fontName: string;
  size: number;
  styles: TextStyleOption[] | null;
  styleKey: string;
  onStyle: (key: string) => void;
  onDelete: (() => void) | null;
}) {
  const fallback = prediction.tier === 'FALLBACK';
  return (
    <div data-editor-hint className="mt-1 w-max max-w-[320px] rounded-lg border border-ink-100 bg-white px-2.5 py-1.5 text-[11.5px] leading-relaxed shadow-lg">
      <p className={fallback ? 'text-warning-500' : 'text-brand-700'}>
        {pdfFontTierLabel[prediction.tier].text} · {fontName ? displayFontName(fontName) : '기본 글꼴'} {Math.round(size * 10) / 10}pt
      </p>
      {fallback && prediction.missing.length ? (
        <p className="text-ink-500">
          원본 글꼴에 없는 글자: {prediction.missing.slice(0, 8).join(' ')}
          {prediction.missing.length > 8 ? ' …' : ''} — 같은 계열 글꼴로 대신합니다. 오른쪽에서 글꼴 파일을 올리면 원본 글꼴로 씁니다.
        </p>
      ) : null}
      {styles && styles.length ? (
        <label className="mt-1 flex items-center gap-1.5 text-ink-700">
          글자 모양
          <select
            value={styleKey}
            onChange={(e) => onStyle(e.target.value)}
            className="max-w-[220px] rounded-md border border-ink-200 bg-white px-1.5 py-0.5 text-[11.5px]"
          >
            {!styles.some((s) => s.key === styleKey) ? <option value={styleKey}>현재 모양</option> : null}
            {styles.map((s) => (
              <option key={s.key} value={s.key}>
                {displayFontName(s.baseFont)} {s.size}pt — {s.sample}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {onDelete ? (
        <button type="button" onClick={onDelete} className="mt-1 text-[11.5px] font-bold text-danger-500 hover:underline">
          이 수정 되돌리기
        </button>
      ) : null}
    </div>
  );
}
