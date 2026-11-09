import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { emptyPdfLayout, type PdfLayout } from '@/lib/pdf-form';
import { groupTextRuns } from '@/lib/pdf-form-runs';
import {
  acceptCandidates, detectFieldCandidates, dropWideSpaces, extractHorizontalLines, inlinePairs, matchRule, ocrLinesToPages, type DetectPage,
} from '@/lib/pdf-form-detect';
import { MERGE_FIELD_KEYS, renderMergeText } from '@/lib/merge-fields';
import { putObject, newObjectName } from '@/server/uploads';
import { detectByOcr, checkLayoutPreflight } from '@/server/services/pdf-form/detect';
import { getOcrAdapter } from '@/server/adapters/ocr';
import { mergeValuesFromContext } from '@/server/services/purpose-templates';
import { resetDb, seedBasics, type Fixture } from './helpers';

/**
 * 4차 J1 — 서식 자동 인식(라벨 → 머지 필드 후보).
 *
 *  1) 한글 서식 픽스처 3개(생성 서식·LibreOffice 저장본·브라우저 인쇄본)에서 라벨 규칙대로 후보가 나온다.
 *  2) 주소·생년월일은 제안하지 않는다(민감).
 *  3) 후보를 만들어도 편집 기록은 그대로다 — 수락할 때만 새 기록이 생기고, 입력 기록·DB 는 바뀌지 않는다.
 *  4) 스캔본 OCR 은 mock 이면 빈 결과 + mock 표시(읽은 척하지 않음).
 *  5) 수락 뒤 발송 전 점검(1차 규칙)이 돈다. 연락처 머지 값은 항상 가린 번호다.
 */

const FIX = path.join(__dirname, 'fixtures', 'pdf-form');
const LO = new Uint8Array(fs.readFileSync(path.join(FIX, 'libreoffice-form.pdf')));
const CHROME = new Uint8Array(fs.readFileSync(path.join(FIX, 'chrome-type3.pdf')));

async function pagesOf(bytes: Uint8Array): Promise<DetectPage[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true, disableFontFace: true }).promise;
  const out: DetectPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const vp = page.getViewport({ scale: 1 });
    const ops = await page.getOperatorList();
    const tc = await page.getTextContent();
    const items = tc.items.filter((i): i is typeof i & { str: string; transform: number[]; width: number; fontName: string } => 'str' in i);
    const runs = groupTextRuns(n, dropWideSpaces(items), (k) => (page.commonObjs.get(k) as { name?: string })?.name ?? k);
    out.push({ page: n, width: vp.width, height: vp.height, runs, lines: extractHorizontalLines(n, ops, pdfjs.OPS) });
  }
  await doc.loadingTask.destroy();
  return out;
}

/** 빈칸·밑줄이 있는 한글 약정서(한글·워드에서 PDF 로 저장한 것과 같은 2바이트 글꼴) */
async function makePledgeForm(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(process.cwd(), 'assets/fonts/NotoKRSans-Regular.ttf')), { subset: true });
  const page = doc.addPage([595, 842]);
  const t = (s: string, x: number, y: number, size = 11) => page.drawText(s, { x, y, size, font, color: rgb(0, 0, 0) });
  t('정기후원 약정서', 230, 780, 18);
  t('성명', 60, 720);
  page.drawLine({ start: { x: 100, y: 716 }, end: { x: 300, y: 716 }, thickness: 0.6 });
  t('후원금액', 60, 690);
  t('출금일', 60, 660);
  t('연락처', 60, 630);
  t('주소', 60, 600);
  t('생년월일', 60, 570);
  t('20      년      월      일', 360, 300);
  t('서명', 60, 240);
  t('(인)', 520, 240);
  // 쪽 오른쪽 끝 라벨(오른쪽에 빈자리 없음) + 아래 밑줄
  t('후원자 성명', 495, 200);
  page.drawLine({ start: { x: 495, y: 180 }, end: { x: 575, y: 180 }, thickness: 0.6 });
  return doc.save();
}

let fx: Fixture;
beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

describe('[1] 라벨 규칙', () => {
  it('라벨 전체가 맞아야 한다(문장 속 낱말은 라벨이 아님)', () => {
    expect(matchRule('성 명')?.field).toBe('후원자명');
    expect(matchRule('후원자명:')?.field).toBe('후원자명');
    expect(matchRule('· 약정금액')?.field).toBe('금액');
    expect(matchRule('이체일')?.field).toBe('출금일');
    expect(matchRule('휴대폰')?.field).toBe('연락처');
    expect(matchRule('작성일')?.field).toBe('발급일');
    expect(matchRule('20   년   월   일')?.field).toBe('발급일');
    expect(matchRule('(인)')?.field).toBe('서명');
    expect(matchRule('서명란')?.field).toBe('서명');
    expect(matchRule('본인은 성명과 연락처를 제공합니다')).toBeNull();
    expect(matchRule('주소')).toBeNull();
    expect(matchRule('생년월일')).toBeNull();
  });

  it('한 묶음 안 "라벨: 값" 쌍을 나눠 읽는다', () => {
    const t = '후원 금액: 월 10,000 원 / 출금일: 매월 25 일';
    const p = inlinePairs(t);
    expect(p.map((x) => [x.label, x.value, x.last])).toEqual([
      ['후원 금액', '월 10,000 원', false],
      ['출금일', '매월 25 일', true],
    ]);
    expect(t.slice(p[1]!.vStart, p[1]!.vEnd)).toBe('매월 25 일');
    expect(inlinePairs('주소: 서울')[0]!.label).toBe('주소');
    expect(inlinePairs('Contact: help@example.org')).toEqual([]);
  });
});

describe('[2] 한글 서식 픽스처', () => {
  it('생성 서식: 빈칸·밑줄·날짜 줄·(인) 자리를 찾고 민감 항목은 제안하지 않는다', async () => {
    const pages = await pagesOf(await makePledgeForm());
    expect(pages[0]!.lines!.length).toBeGreaterThanOrEqual(2);
    const r = detectFieldCandidates(pages);
    const by = (field: string, label?: string) => r.candidates.filter((c) => c.field === field && (!label || c.labelText.replace(/\s/g, '') === label));

    const name = by('후원자명', '성명')[0]!;
    expect(name).toMatchObject({ kind: 'add', text: '{{후원자명}}', confidence: 'high' });
    expect(name.matrix[4]).toBeGreaterThan(80);
    expect(name.matrix[4]).toBeLessThan(110);
    expect(Math.abs(name.matrix[5] - 720)).toBeLessThan(1);
    expect(name.reason).toContain('밑줄');

    expect(by('금액')[0]).toMatchObject({ kind: 'add', text: '{{금액}}' });
    expect(by('출금일')[0]).toMatchObject({ kind: 'add', text: '{{출금일}}' });
    expect(by('연락처')[0]).toMatchObject({ kind: 'add', text: '{{연락처}}' });

    const date = by('발급일')[0]!;
    expect(date).toMatchObject({ kind: 'replace', text: '{{발급일}}', confidence: 'low' });
    expect(date.original.replace(/\s/g, '')).toBe('20년월일');

    const seal = r.candidates.find((c) => c.field === '서명' && c.labelText === '(인)')!;
    expect(seal).toMatchObject({ kind: 'add', text: '{{후원자명}}', confidence: 'low' });
    expect(seal.matrix[4]).toBeLessThan(520);

    // 오른쪽이 막힌 라벨 → 아래 밑줄 위에 넣는다
    const under = by('후원자명', '후원자성명')[0]!;
    expect(under).toMatchObject({ kind: 'add', confidence: 'high', reason: '라벨 아래 밑줄' });
    expect(under.matrix[5]).toBeGreaterThan(180);
    expect(under.matrix[5]).toBeLessThan(190);

    // 민감 항목: 후보 없음 + 제외 이유
    expect(r.candidates.some((c) => /주소|생년월일/.test(c.labelText))).toBe(false);
    expect(r.skipped.filter((s) => /주소|생년월일/.test(s.labelText)).map((s) => s.reason)).toEqual([
      expect.stringContaining('민감'), expect.stringContaining('민감'),
    ]);
  });

  it('LibreOffice 저장본: 이미 적힌 예시 값(금액·출금일)을 바꾸는 후보, 금액 뒤 "원" 까지 덮는다', async () => {
    const r = detectFieldCandidates(await pagesOf(LO));
    const amount = r.candidates.find((c) => c.field === '금액')!;
    expect(amount).toMatchObject({ kind: 'replace', text: '{{금액}}', confidence: 'low' });
    expect(amount.original).toContain('10,000');
    expect(amount.original).toContain('원');
    const day = r.candidates.find((c) => c.field === '출금일')!;
    expect(day).toMatchObject({ kind: 'replace', original: '25' });
    expect(amount.width).toBeGreaterThan(30);
  });

  it('브라우저 인쇄본: "라벨: 값" 한 묶음은 콜론 뒤 자리를 바꾸는 후보(신뢰도 낮음)', async () => {
    const r = detectFieldCandidates(await pagesOf(CHROME));
    const name = r.candidates.find((c) => c.field === '후원자명')!;
    expect(name).toMatchObject({ kind: 'replace', original: '홍길동', confidence: 'low' });
    expect(name.matrix[4]).toBeGreaterThan(60);
    const phone = r.candidates.find((c) => c.field === '연락처')!;
    expect(phone).toMatchObject({ kind: 'replace', original: '010-0000-0000', text: '{{연락처}}' });
  });
});

describe('[3] 수락 전 기록 불변 · 수락', () => {
  it('후보를 만들어도 편집 기록이 바뀌지 않고, 고른 후보만 새 기록에 들어간다', async () => {
    const pages = await pagesOf(await makePledgeForm());
    const layout: PdfLayout = emptyPdfLayout();
    const before = JSON.stringify(layout);
    const r = detectFieldCandidates(pages, { existing: layout });
    expect(JSON.stringify(layout)).toBe(before);

    const one = r.candidates[0]!;
    const a = acceptCandidates(layout, r.candidates, [one.id]);
    expect(JSON.stringify(layout)).toBe(before); // 입력 기록 그대로
    expect(a.added).toBe(1);
    expect(a.layout.edits).toHaveLength(1);
    expect(a.layout.edits[0]).toMatchObject({ id: `auto-${one.id}`, text: one.text, kind: one.kind });

    // 같은 후보를 다시 수락해도 한 번만
    const again = acceptCandidates(a.layout, r.candidates, 'all');
    expect(again.layout.edits.filter((e) => e.id === `auto-${one.id}`)).toHaveLength(1);
    expect(again.added).toBe(r.candidates.length - 1);

    // 이미 고친 자리는 다시 제안하지 않는다
    const next = detectFieldCandidates(pages, { existing: again.layout });
    expect(next.candidates).toHaveLength(0);
  });

  it('DB 의 서식 편집 기록은 자동 인식(OCR 경로 포함)으로 바뀌지 않는다', async () => {
    const bytes = await makePledgeForm();
    const name = newObjectName('pdf');
    const url = await putObject(name, Buffer.from(bytes), 'application/pdf');
    const t = await prisma.documentTemplate.create({
      data: {
        id: newId(), merchantId: fx.merchantId, name: '약정서 파일', templateType: 'FILE', basePdfUrl: url, basePdfHash: 'x',
        pdfLayout: emptyPdfLayout() as object, purpose: 'SUPPORT_AGREEMENT', active: true,
      },
    });
    const r = await detectByOcr(fx.merchantId, { templateId: t.id }, emptyPdfLayout());
    expect(r).toMatchObject({ ok: true, mock: true, candidates: [] });
    const after = await prisma.documentTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.pdfLayout).toEqual(emptyPdfLayout());
    expect(after.renderedPdfUrl).toBeNull();
    // 다른 기관 서식은 열 수 없다
    expect(await detectByOcr('other-merchant', { templateId: t.id })).toMatchObject({ ok: false });
  });
});

describe('[4] 스캔본 OCR', () => {
  it('mock 어댑터는 빈 결과 + mock 표시(읽은 척하지 않는다)', async () => {
    const a = getOcrAdapter();
    expect(a.info().mode).toBe('mock');
    expect(await a.recognize(new Uint8Array([1, 2, 3]), 'application/pdf')).toEqual({ lines: [], mock: true });
  });

  it('OCR 줄도 같은 규칙으로 후보가 되고, 신뢰도가 낮은 줄의 후보는 낮음(노란색)', () => {
    const pages = ocrLinesToPages(
      [
        { text: '성명', box: { page: 1, x: 0.1, y: 0.2, w: 0.06, h: 0.015 }, confidence: 0.95 },
        { text: '연락처', box: { page: 1, x: 0.1, y: 0.25, w: 0.08, h: 0.015 }, confidence: 0.5 },
        { text: '주소', box: { page: 1, x: 0.1, y: 0.3, w: 0.06, h: 0.015 }, confidence: 0.99 },
      ],
      [{ w: 595, h: 842 }],
    );
    const r = detectFieldCandidates(pages, { source: 'ocr' });
    expect(r.candidates.map((c) => [c.field, c.confidence, c.source])).toEqual([
      ['후원자명', 'high', 'ocr'],
      ['연락처', 'low', 'ocr'],
    ]);
    expect(r.skipped[0]!.labelText).toBe('주소');
  });
});

describe('[5] 수락 뒤 발송 전 점검 · 연락처 머지', () => {
  it('수락한 기록으로 1차 점검이 돈다(필수 항목·넘침) — 저장하지 않는다', async () => {
    const bytes = await makePledgeForm();
    const url = await putObject(newObjectName('pdf'), Buffer.from(bytes), 'application/pdf');
    const t = await prisma.documentTemplate.create({
      data: { id: newId(), merchantId: fx.merchantId, name: '약정서 파일2', templateType: 'FILE', basePdfUrl: url, basePdfHash: 'x', pdfLayout: emptyPdfLayout() as object, purpose: 'SUPPORT_AGREEMENT', active: true },
    });
    const det = detectFieldCandidates(await pagesOf(bytes));
    const { layout } = acceptCandidates(emptyPdfLayout(), det.candidates, 'all');
    const r = await checkLayoutPreflight(fx.merchantId, { templateId: t.id }, layout, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(['ok', 'warn', 'block']).toContain(r.normal.level);
    // 가장 긴 이름은 '성명' 칸(밑줄 200pt)을 넘는다 → 경고 이상
    expect(r.stress.issues.length).toBeGreaterThan(0);
    expect((await prisma.documentTemplate.findUniqueOrThrow({ where: { id: t.id } })).pdfLayout).toEqual(emptyPdfLayout());
  });

  it('연락처는 알려진 머지 필드이고 값은 가린 번호만 나간다', () => {
    expect(MERGE_FIELD_KEYS).toContain('연락처');
    const v = mergeValuesFromContext({ phoneMasked: '010-****-5678' }, { merchantName: '해오름', representative: null });
    expect(renderMergeText('연락처: {{연락처}}', v).text).toBe('연락처: 010-****-5678');
    // 원문이 잘못 들어와도 가린다(절대 규칙 6)
    expect(renderMergeText('{{연락처}}', { 연락처: '01012345678' }).text).toBe('010-****-5678');
  });
});
