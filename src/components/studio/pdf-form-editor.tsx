'use client';

import * as React from 'react';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import {
  CircleCheck, Eraser, FileDown, Info, Loader2, MousePointerClick, Redo2, RotateCcw, Save, TriangleAlert, Type, Undo2,
  Upload, X,
} from 'lucide-react';
import { Button, Card, CardTitle, cx } from '@/components/ui';
import { openPdf } from '@/components/pdf/pdfjs';
import {
  MAX_EDIT_TEXT, MAX_PDF_EDITS, displayFontName, matrixFontSize, pdfFontTierLabel, predictFontTier, stripSubsetTag,
  type PdfEdit, type PdfFontInfo, type PdfFontTier, type PdfLayout, type PdfMatrix,
} from '@/lib/pdf-form';
import {
  coverPolygon, groupTextRuns, rectToCover, sampleColors, styleOptions, type PdfTextRun, type TextStyleOption,
} from '@/lib/pdf-form-runs';
import { saveDocumentPdfLayoutAction } from '@/app/actions/studio-documents';

/**
 * 올린 서식 원본 위에서 직접 고치는 편집기.
 *
 * ── 화면 구성 ───────────────────────────────────────────────────────────
 *  - 보이는 그림은 항상 서버가 만든 "실제 결과 PDF" 다(고칠 때마다 다시 받아 그린다).
 *    브라우저는 원본 글꼴을 온전히 쓸 수 없어서, 입력 중에만 비슷한 글꼴로 보여 주고
 *    확정하면 서버 결과로 바꿔 그린다. 그래서 화면에서 본 것이 후원자가 받는 것과 같다.
 *  - 글자 위치·글꼴·크기는 원본 PDF 에서 읽는다. 글자색과 바탕색은 원본 그림에서 읽는다.
 *
 * ── 할 수 있는 것 ──────────────────────────────────────────────────────
 *  - 글자 고치기: 원래 글자를 누르면 그 자리에서 고친다. 원래 글꼴·크기·색·방향 그대로.
 *  - 새 글 넣기: 빈자리를 누르면 가장 가까운 글자의 모양(글꼴·크기·색)으로 넣는다. 모양은 바꿀 수 있다.
 *  - 지우기: 글자를 누르거나, 끌어서 영역을 덮는다(바탕색으로).
 */

type Mode = 'edit' | 'add' | 'erase';

interface PageState {
  pageNo: number;
  /** PDF 단위(pt) 크기 — 회전 반영 */
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

export function PdfFormEditor({
  templateId,
  templateName,
  basePdfUrl,
  renderedPdfUrl,
  initialLayout,
  fonts,
  convertedFrom,
}: {
  templateId: string;
  templateName: string;
  basePdfUrl: string;
  renderedPdfUrl: string | null;
  initialLayout: PdfLayout;
  fonts: PdfFontInfo[];
  convertedFrom: string | null;
}) {
  const [layout, setLayout] = React.useState<PdfLayout>(initialLayout);
  const [past, setPast] = React.useState<PdfLayout[]>([]);
  const [future, setFuture] = React.useState<PdfLayout[]>([]);
  const [savedJson, setSavedJson] = React.useState(() => JSON.stringify(initialLayout));
  const dirty = JSON.stringify(layout) !== savedJson;

  const [mode, setMode] = React.useState<Mode>('edit');
  const [pages, setPages] = React.useState<PageState[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [resultDoc, setResultDoc] = React.useState<PDFDocumentProxy | null>(null);
  const [report, setReport] = React.useState<Map<string, ReportItem>>(new Map());
  const [coverOnly, setCoverOnly] = React.useState<number[]>([]);
  const [previewing, setPreviewing] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [active, setActive] = React.useState<Active | null>(null);
  const [draft, setDraft] = React.useState('');
  const [scale, setScale] = React.useState(1.2);
  const [uploadingFont, setUploadingFont] = React.useState<string | null>(null);

  const wrapRef = React.useRef<HTMLDivElement>(null);
  const baseDocRef = React.useRef<PDFDocumentProxy | null>(null);

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
    let cancelled = false;
    (async () => {
      try {
        const doc = await openPdf(basePdfUrl);
        if (cancelled) return;
        baseDocRef.current = doc;
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
          const items = text.items.filter((it): it is typeof it & { str: string; transform: number[]; width: number; fontName: string } => 'str' in it);
          out.push({ pageNo: n, widthPt: vp1.width, heightPt: vp1.height, runs: groupTextRuns(n, items, nameOf), sample });
          page.cleanup();
        }
        if (!cancelled) setPages(out);
      } catch {
        if (!cancelled) setLoadError('원본 PDF 를 열지 못했습니다. 파일이 손상되었는지 확인하거나 다시 올려 주세요.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [basePdfUrl]);

  // ── 처음 보이는 결과: 저장된 결과 PDF(없으면 원본) ───────────────────────
  React.useEffect(() => {
    let cancelled = false;
    openPdf(renderedPdfUrl ?? basePdfUrl)
      .then((d) => {
        if (!cancelled) setResultDoc(d);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [renderedPdfUrl, basePdfUrl]);

  // ── 화면 폭에 맞춰 배율 ────────────────────────────────────────────────
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el || pages.length === 0) return;
    const maxW = Math.max(...pages.map((p) => p.widthPt));
    const fit = () => setScale(Math.max(0.5, Math.min(1.8, (el.clientWidth - 2) / maxW)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pages]);

  // ── 고칠 때마다 실제 결과를 다시 받는다 (0.5초 모아서) ───────────────────
  const layoutJson = JSON.stringify(layout);
  const firstPreview = React.useRef(true);
  React.useEffect(() => {
    if (firstPreview.current) {
      firstPreview.current = false;
      // 저장된 결과가 이미 있으면 첫 화면은 그것으로 충분하다. 판정표만 받는다.
      if (layout.edits.length === 0) return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await fetch(`/api/studio/documents/${templateId}/pdf-preview`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: layoutJson,
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { message?: string } | null;
          setNotice({ tone: 'error', text: data?.message ?? '미리보기를 만들지 못했습니다.' });
          return;
        }
        const header = res.headers.get('x-render-report');
        if (header) {
          const parsed = JSON.parse(decodeURIComponent(header)) as { report: ReportItem[]; coverOnlyPages: number[] };
          setReport(new Map(parsed.report.map((r) => [r.id, r])));
          setCoverOnly(parsed.coverOnlyPages ?? []);
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const doc = await openPdf(bytes);
        setResultDoc((prev) => {
          void prev?.loadingTask.destroy();
          return doc;
        });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setNotice({ tone: 'error', text: '미리보기를 만들지 못했습니다.' });
      } finally {
        setPreviewing(false);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutJson, templateId]);

  // ── 저장하지 않고 나가려 하면 묻는다 ───────────────────────────────────
  React.useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ── 편집 기록 다루기 ───────────────────────────────────────────────────
  const commit = React.useCallback((next: PdfLayout) => {
    setLayout((prev) => {
      setPast((p) => [...p.slice(-49), prev]);
      setFuture([]);
      return next;
    });
  }, []);

  const undo = React.useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const prev = p[p.length - 1];
      setLayout((cur) => {
        setFuture((f) => [cur, ...f]);
        return prev;
      });
      return p.slice(0, -1);
    });
    setActive(null);
  }, []);
  const redo = React.useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setLayout((cur) => {
        setPast((p) => [...p, cur]);
        return next;
      });
      return f.slice(1);
    });
    setActive(null);
  }, []);

  React.useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
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
    const exists = layout.edits.some((e) => e.id === edit.id);
    if (!exists && layout.edits.length >= MAX_PDF_EDITS) {
      setNotice({ tone: 'error', text: `수정은 ${MAX_PDF_EDITS}곳까지 할 수 있습니다.` });
      return;
    }
    commit({ ...layout, edits: exists ? layout.edits.map((e) => (e.id === edit.id ? edit : e)) : [...layout.edits, edit] });
  };
  const removeEdit = (id: string) => commit({ ...layout, edits: layout.edits.filter((e) => e.id !== id) });

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
      const poly = coverPolygon(run);
      const { cover, color } = colorsAt(run.page, poly);
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
      const d = Math.hypot(r.matrix[4] - x, r.matrix[5] - y);
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    const pool = best ? [best] : allRuns.slice(0, 1);
    const r = pool[0] ?? null;
    if (!r) return { run: null, style: null };
    const key = `${r.baseFont}|${Math.round(r.size * 10) / 10}`;
    return { run: r, style: styles.find((s) => s.key === key) ?? null };
  };

  const onPageClick = (pageNo: number, vp: PageViewport, e: React.MouseEvent<HTMLDivElement>) => {
    if (mode !== 'add') return;
    if ((e.target as HTMLElement).closest('[data-editor-ui]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const [x, y] = vp.convertToPdfPoint(e.clientX - rect.left, e.clientY - rect.top);
    const { run, style } = nearestStyle(pageNo, x, y);
    const size = style?.size ?? 11;
    // 누른 곳이 글자 한가운데쯤이 되도록 기준선을 조금 내린다.
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
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    const box = dragBox;
    setDragBox(null);
    if (!d || !box || box.w < 4 || box.h < 4) return;
    void e;
    const [x0, y0] = d.vp.convertToPdfPoint(box.left, box.top);
    const [x1, y1] = d.vp.convertToPdfPoint(box.left + box.w, box.top + box.h);
    const { matrix, width } = rectToCover(x0, y0, x1, y1);
    const poly = coverPolygon({ matrix, width });
    const { cover, color } = colorsAt(d.page, poly);
    upsertEdit({
      id: rid('area'), page: d.page, kind: 'erase', matrix, width, text: '',
      font: { baseFont: '', serif: false, bold: false }, color, cover, original: '(영역)',
    });
  };

  // ── 입력 확정 ──────────────────────────────────────────────────────────
  const finish = (apply: boolean) => {
    if (!active) return;
    const text = draft.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_EDIT_TEXT);
    if (apply) {
      if (active.kind === 'run') {
        const r = active.run;
        if (text !== r.text) {
          const poly = coverPolygon(r);
          const { cover, color } = colorsAt(r.page, poly);
          upsertEdit({
            id: r.id, page: r.page, kind: text.trim() ? 'replace' : 'erase', matrix: r.matrix, width: r.width, text,
            font: { baseFont: r.baseFont, serif: r.serif, bold: r.bold }, color, cover, original: r.text,
          });
        }
      } else if (active.kind === 'edit') {
        const e = active.edit;
        if (e.kind === 'add' && !text.trim()) removeEdit(e.id);
        else if (e.kind !== 'add' && text === e.original) removeEdit(e.id);
        else upsertEdit({ ...e, kind: e.kind === 'add' ? 'add' : text.trim() ? 'replace' : 'erase', text });
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
  };

  /** 새 글의 모양을 문서에 쓰인 다른 모양으로 바꾼다. */
  const changeNewStyle = (key: string) => {
    if (!active || active.kind !== 'new') return;
    const st = styles.find((s) => s.key === key) ?? null;
    const size = st?.size ?? matrixFontSize(active.matrix);
    const m = active.matrix;
    setActive({ ...active, style: st, matrix: [size, 0, 0, size, m[4], m[5]] });
  };
  const changeAddEditStyle = (edit: PdfEdit, key: string) => {
    const st = styles.find((s) => s.key === key);
    if (!st) return;
    const m = edit.matrix;
    const next: PdfEdit = { ...edit, font: { baseFont: st.baseFont, serif: st.serif, bold: st.bold }, matrix: [st.size, 0, 0, st.size, m[4], m[5]] };
    upsertEdit(next);
    setActive({ kind: 'edit', edit: next });
  };

  // ── 저장 ───────────────────────────────────────────────────────────────
  const save = async () => {
    if (active) finish(true);
    setSaving(true);
    setNotice(null);
    try {
      const res = await saveDocumentPdfLayoutAction(templateId, JSON.stringify(layout));
      if (!res.ok) {
        setNotice({ tone: 'error', text: res.message });
        return;
      }
      setSavedJson(JSON.stringify(layout));
      setReport(new Map(res.report.map((r) => [r.id, r])));
      setCoverOnly(res.coverOnlyPages);
      const fallback = res.report.filter((r) => r.tier === 'FALLBACK').length;
      setNotice({
        tone: 'ok',
        text:
          res.edits === 0
            ? '원본 그대로 쓰도록 저장했습니다.'
            : `저장했습니다. 수정 ${res.edits}곳` +
              (res.stripped ? ` · 덮은 자리의 원래 글자 ${res.stripped}자를 지웠습니다` : '') +
              (fallback ? ` · ${fallback}곳은 원본 글꼴에 없는 글자가 있어 대체 글꼴을 썼습니다.` : ' · 모두 원본 글꼴로 들어갔습니다.'),
      });
    } catch {
      setNotice({ tone: 'error', text: '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    } finally {
      setSaving(false);
    }
  };

  const uploadFont = async (font: PdfFontInfo, file: File) => {
    setUploadingFont(font.baseFont);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('match', stripSubsetTag(font.baseFont));
      const res = await fetch(`/api/studio/documents/${templateId}/pdf-font`, { method: 'POST', body: fd });
      const data = (await res.json()) as { ok: boolean; message?: string; font?: { match: string; url: string; name: string } };
      if (!data.ok || !data.font) {
        setNotice({ tone: 'error', text: data.message ?? '글꼴을 올리지 못했습니다.' });
        return;
      }
      const f = data.font;
      commit({ ...layout, fonts: [...layout.fonts.filter((x) => x.match.toLowerCase() !== f.match.toLowerCase()), f] });
      setNotice({ tone: 'ok', text: `${f.name} 을(를) ${displayFontName(font.baseFont)} 대신 쓰도록 올렸습니다. 저장하면 반영됩니다.` });
    } catch {
      setNotice({ tone: 'error', text: '글꼴을 올리지 못했습니다.' });
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

  // ── 그리기 ─────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <Card>
        <p className="flex items-center gap-2 text-[13px] text-danger-500">
          <TriangleAlert size={16} strokeWidth={1.7} /> {loadError}
        </p>
      </Card>
    );
  }

  const activeFont = active
    ? active.kind === 'run'
      ? fontInfo(active.run.baseFont)
      : active.kind === 'edit'
        ? fontInfo(active.edit.font.baseFont)
        : active.style
          ? fontInfo(active.style.baseFont)
          : undefined
    : undefined;
  const activePrediction = active ? predictFontTier(draft, activeFont) : null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        {/* 도구 막대 */}
        <div className="sticky top-14 z-20 mb-3 flex flex-wrap items-center gap-1.5 rounded-2xl border border-ink-100 bg-white/95 p-1.5 shadow-sm backdrop-blur">
          {(
            [
              { key: 'edit', label: '글자 고치기', icon: MousePointerClick },
              { key: 'add', label: '새 글 넣기', icon: Type },
              { key: 'erase', label: '지우기', icon: Eraser },
            ] as const
          ).map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                finish(true);
                setMode(m.key);
              }}
              className={cx(
                'flex h-9 items-center gap-1.5 rounded-xl px-3 text-[12.5px] font-bold',
                mode === m.key ? 'bg-brand-700 text-white' : 'text-ink-700 hover:bg-ink-50',
              )}
            >
              <m.icon size={16} strokeWidth={1.7} />
              {m.label}
            </button>
          ))}
          <span className="mx-1 h-6 w-px bg-ink-100" />
          <button type="button" onClick={undo} disabled={past.length === 0} className="grid h-9 w-9 place-items-center rounded-xl text-ink-700 hover:bg-ink-50 disabled:opacity-40" title="되돌리기 (Ctrl+Z)">
            <Undo2 size={16} strokeWidth={1.7} />
          </button>
          <button type="button" onClick={redo} disabled={future.length === 0} className="grid h-9 w-9 place-items-center rounded-xl text-ink-700 hover:bg-ink-50 disabled:opacity-40" title="다시 하기 (Ctrl+Shift+Z)">
            <Redo2 size={16} strokeWidth={1.7} />
          </button>
          <span className="ml-auto flex items-center gap-2 pr-1 text-[11.5px] text-ink-400">
            {previewing ? (
              <>
                <Loader2 size={14} className="animate-spin" /> 실제 결과 그리는 중
              </>
            ) : dirty ? (
              '저장하지 않은 수정이 있습니다'
            ) : (
              '저장됨'
            )}
          </span>
          <Button type="button" size="sm" onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} strokeWidth={1.7} />}
            <span className="ml-1">저장</span>
          </Button>
        </div>

        <p className="mb-2 text-[12px] leading-relaxed text-ink-500">
          {mode === 'edit'
            ? '고칠 글자를 누르세요. 원래 글꼴·크기·색 그대로 그 자리에 들어갑니다. Enter 로 확정, Esc 로 취소합니다.'
            : mode === 'add'
              ? '글을 넣을 자리를 누르세요. 가장 가까운 글자와 같은 글꼴·크기로 들어가고, 모양은 바꿀 수 있습니다.'
              : '지울 글자를 누르거나, 끌어서 영역을 덮으세요. 바탕색으로 덮고 원래 글자는 파일에서도 지웁니다.'}
        </p>

        {notice ? (
          <div
            className={cx(
              'mb-3 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px] leading-relaxed',
              notice.tone === 'ok' ? 'bg-brand-50 text-brand-900' : 'bg-danger-50 text-danger-500',
            )}
          >
            {notice.tone === 'ok' ? <CircleCheck size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" /> : <TriangleAlert size={16} strokeWidth={1.7} className="mt-0.5 shrink-0" />}
            <span className="flex-1">{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} className="shrink-0 opacity-60 hover:opacity-100" aria-label="닫기">
              <X size={14} />
            </button>
          </div>
        ) : null}

        {convertedFrom === 'image' ? (
          <p className="mb-3 rounded-xl bg-ink-50 px-3 py-2 text-[12px] text-ink-700">
            스캔 그림으로 만든 서식이라 원래 글자를 글자로 고칠 수 없습니다. [지우기] 로 영역을 덮고 [새 글 넣기] 로 써 주세요.
          </p>
        ) : null}

        <div ref={wrapRef} className="space-y-4">
          {pages.length === 0 ? (
            <div className="flex h-60 items-center justify-center rounded-2xl border border-ink-100 bg-white text-[13px] text-ink-400">
              <Loader2 size={16} className="mr-2 animate-spin" /> 원본을 읽는 중입니다
            </div>
          ) : (
            pages.map((p) => (
              <PageView
                key={p.pageNo}
                page={p}
                scale={scale}
                doc={resultDoc}
                mode={mode}
                edits={layout.edits.filter((e) => e.page === p.pageNo)}
                active={active}
                draft={draft}
                setDraft={setDraft}
                finish={finish}
                onRun={openRun}
                onEdit={(e) => {
                  if (mode === 'erase') return;
                  setActive({ kind: 'edit', edit: e });
                  setDraft(e.text);
                }}
                onClick={onPageClick}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                dragBox={dragBox?.page === p.pageNo ? dragBox : null}
                hint={
                  activePrediction && active ? (
                    <EditHint
                      prediction={activePrediction}
                      fontName={
                        active.kind === 'run'
                          ? active.run.baseFont
                          : active.kind === 'edit'
                            ? active.edit.font.baseFont
                            : (active.style?.baseFont ?? '')
                      }
                      size={
                        active.kind === 'run'
                          ? active.run.size
                          : active.kind === 'edit'
                            ? matrixFontSize(active.edit.matrix)
                            : matrixFontSize(active.matrix)
                      }
                      styles={active.kind === 'new' || (active.kind === 'edit' && active.edit.kind === 'add') ? styles : null}
                      styleKey={
                        active.kind === 'new'
                          ? (active.style?.key ?? '')
                          : active.kind === 'edit'
                            ? `${active.edit.font.baseFont}|${Math.round(matrixFontSize(active.edit.matrix) * 10) / 10}`
                            : ''
                      }
                      onStyle={(key) => {
                        if (active.kind === 'new') changeNewStyle(key);
                        else if (active.kind === 'edit') changeAddEditStyle(active.edit, key);
                      }}
                      onDelete={active.kind === 'edit' ? () => {
                        removeEdit(active.edit.id);
                        setActive(null);
                      } : null}
                    />
                  ) : null
                }
              />
            ))
          )}
        </div>
      </div>

      {/* ── 오른쪽: 수정 목록 · 글꼴 ───────────────────────────────────── */}
      <aside className="min-w-0 space-y-3 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:self-start xl:overflow-y-auto">
        <Card>
          <div className="flex items-center justify-between">
            <CardTitle>수정한 곳 {layout.edits.length}</CardTitle>
            {layout.edits.length ? (
              <button
                type="button"
                onClick={() => {
                  if (window.confirm('모든 수정을 지우고 원본으로 되돌립니다. 저장해야 반영됩니다.')) commit({ ...layout, edits: [] });
                }}
                className="flex items-center gap-1 text-[11.5px] font-bold text-ink-500 hover:text-ink-900"
              >
                <RotateCcw size={13} strokeWidth={1.8} /> 원본으로
              </button>
            ) : null}
          </div>
          {layout.edits.length === 0 ? (
            <p className="mt-2 text-[12.5px] text-ink-400">아직 고친 곳이 없습니다. 원본 그대로 쓰입니다.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {layout.edits.map((e) => {
                const t = tierOf(e);
                return (
                  <li key={e.id} className="rounded-xl border border-ink-100 px-2.5 py-2">
                    <div className="flex items-start gap-2">
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
                            {pdfFontTierLabel[t.tier].text} · {e.font.baseFont ? displayFontName(e.font.baseFont) : '기본'} {Math.round(matrixFontSize(e.matrix) * 10) / 10}pt
                            {t.missing.length && t.tier === 'FALLBACK' ? ` · 원본에 없는 글자: ${t.missing.slice(0, 6).join(' ')}` : ''}
                            {t.predicted ? ' (예상)' : ''}
                          </p>
                        ) : null}
                      </div>
                      <button type="button" onClick={() => removeEdit(e.id)} className="shrink-0 text-ink-300 hover:text-ink-700" aria-label="이 수정 되돌리기">
                        <X size={14} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          {coverOnly.length ? (
            <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
              {coverOnly.join(', ')}쪽은 원본 구조상 원래 글자를 파일에서 지우지 못하고 덮기만 했습니다. 화면·인쇄 결과는 같습니다.
            </p>
          ) : null}
        </Card>

        <Card>
          <CardTitle>원본 글꼴</CardTitle>
          <p className="mb-2 mt-0.5 text-[11.5px] leading-relaxed text-ink-400">
            PDF 에는 보통 문서에 쓰인 글자만 들어 있습니다. 새 글자가 원본 글꼴에 없으면 같은 계열·굵기의 글꼴로 대신하고 크기·색은 그대로 둡니다.
            같은 글꼴 파일(TTF·OTF)을 올리면 모든 글자를 원본 글꼴로 씁니다.
          </p>
          {fonts.length === 0 ? (
            <p className="text-[12px] text-ink-400">글자로 된 내용이 없는 서식입니다(스캔본).</p>
          ) : (
            <ul className="space-y-1.5">
              {dedupeFonts(fonts).map((f) => {
                const info = fontInfo(f.baseFont) ?? f;
                const sizes = Array.from(new Set(allRuns.filter((r) => stripSubsetTag(r.baseFont) === stripSubsetTag(f.baseFont)).map((r) => Math.round(r.size * 10) / 10))).sort((a, b) => a - b);
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

        <Card>
          <CardTitle>내려받기</CardTitle>
          <div className="mt-2 flex flex-col gap-1.5 text-[12.5px]">
            <a href={`${basePdfUrl}?name=${encodeURIComponent(`${templateName}_원본.pdf`)}`} className="flex items-center gap-1.5 font-bold text-ink-700 hover:text-ink-900">
              <FileDown size={15} strokeWidth={1.7} /> 올린 원본
            </a>
            {renderedPdfUrl && !dirty ? (
              <a href={`${renderedPdfUrl}?name=${encodeURIComponent(`${templateName}.pdf`)}`} className="flex items-center gap-1.5 font-bold text-brand-700 hover:underline">
                <FileDown size={15} strokeWidth={1.7} /> 고친 서식 (후원자에게 가는 파일)
              </a>
            ) : (
              <p className="text-[11.5px] text-ink-400">고친 서식은 저장한 뒤 내려받을 수 있습니다.</p>
            )}
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-400">
            <Info size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" />
            저장할 때마다 새 파일로 남습니다. 이미 보낸 서명 요청·작성 링크는 보낼 때의 서식 그대로입니다.
          </p>
        </Card>
      </aside>
    </div>
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
// 쪽 하나
// ===========================================================================

function PageView({
  page, scale, doc, mode, edits, active, draft, setDraft, finish, onRun, onEdit, onClick,
  onPointerDown, onPointerMove, onPointerUp, dragBox, hint,
}: {
  page: PageState;
  scale: number;
  doc: PDFDocumentProxy | null;
  mode: Mode;
  edits: PdfEdit[];
  active: Active | null;
  draft: string;
  setDraft: (v: string) => void;
  finish: (apply: boolean) => void;
  onRun: (r: PdfTextRun) => void;
  onEdit: (e: PdfEdit) => void;
  onClick: (pageNo: number, vp: PageViewport, e: React.MouseEvent<HTMLDivElement>) => void;
  onPointerDown: (pageNo: number, vp: PageViewport, e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: React.PointerEvent<HTMLDivElement>) => void;
  dragBox: { left: number; top: number; w: number; h: number } | null;
  hint: React.ReactNode;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const [vp, setVp] = React.useState<PageViewport | null>(null);

  React.useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let task: { cancel(): void; promise: Promise<void> } | null = null;
    (async () => {
      let pg: PDFPageProxy;
      try {
        pg = await doc.getPage(page.pageNo);
      } catch {
        return;
      }
      if (cancelled) return;
      const viewport = pg.getViewport({ scale });
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
  }, [doc, page.pageNo, scale]);

  const editIds = new Set(edits.map((e) => e.id));
  const activeId =
    active?.kind === 'run' ? active.run.id : active?.kind === 'edit' ? active.edit.id : null;

  return (
    <div className="mx-auto w-fit">
      <p className="mb-1 text-[11px] font-bold text-ink-400">{page.pageNo}쪽</p>
      <div
        className={cx(
          'relative select-none overflow-hidden rounded-md bg-white shadow-[0_1px_4px_rgba(15,23,42,0.12)] ring-1 ring-ink-100',
          mode === 'add' ? 'cursor-text' : mode === 'erase' ? 'cursor-crosshair' : '',
        )}
        style={{ width: vp?.width ?? page.widthPt * scale, height: vp?.height ?? page.heightPt * scale }}
        onClick={(e) => vp && onClick(page.pageNo, vp, e)}
        onPointerDown={(e) => vp && onPointerDown(page.pageNo, vp, e)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <canvas ref={canvasRef} className="block" />

        {vp && mode !== 'add'
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

        {vp
          ? edits
              .filter((e) => e.kind === 'add' && e.id !== activeId)
              .map((e) => {
                const size = matrixFontSize(e.matrix);
                const approxW = Math.max(size, e.text.length * size * 0.92);
                const b = boxOf(vp, coverPolygon({ matrix: e.matrix, width: approxW }));
                return (
                  <button
                    key={e.id}
                    type="button"
                    data-editor-ui
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onEdit(e);
                    }}
                    className="absolute rounded-[2px] border border-dashed border-brand-400 hover:bg-brand-500/10"
                    style={{ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top }}
                  />
                );
              })
          : null}

        {vp && active && activePage(active) === page.pageNo ? (
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
    width = active.edit.width;
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
    <div data-editor-ui className="absolute z-10" style={{ left: b.left - 2, top: b.top - 2 }} onClick={(e) => e.stopPropagation()}>
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
          // 모양 고르기·삭제 버튼으로 옮겨 갈 때는 닫지 않는다.
          if ((e.relatedTarget as HTMLElement | null)?.closest('[data-editor-hint]')) return;
          finish(true);
        }}
        className="rounded-[3px] border-0 px-0.5 outline-none ring-2 ring-brand-500"
        style={{
          fontFamily: serif ? SERIF_STACK : SANS_STACK,
          fontWeight: bold ? 700 : 400,
          fontSize: px,
          lineHeight: `${(b.bottom - b.top) + 2}px`,
          height: b.bottom - b.top + 4,
          minWidth: Math.max(60, b.right - b.left + 4),
          width: `${Math.max(4, Array.from(draft).length + 1) * 1.05}em`,
          maxWidth: vp.width - b.left,
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
