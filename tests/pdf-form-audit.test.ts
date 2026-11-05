import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { emptyPdfLayout, predictFontTier, sameLayout, coverOnlyNotice, type PdfEdit, type PdfLayout } from '@/lib/pdf-form';
import { newTextMatrix, resizeMatrix, rectToCover, sampleWindow, screenAngleDeg } from '@/lib/pdf-form-runs';
import { renderPdfLayout } from '@/server/services/pdf-form/render';
import { describeFonts } from '@/server/services/pdf-form/fonts';
import {
  previewLayout, renderAndStore, saveTemplateLayout, signBasePdf,
} from '@/server/services/pdf-form';
import {
  FONT_ASSET_MAX_COUNT, cleanupUnreferencedFontAssets, fontLoaderFor, registerFontAsset,
} from '@/server/services/pdf-form/font-assets';
import { getPrivateObject, newObjectName, putObject } from '@/server/uploads';
import { resetDb, seedBasics, type Fixture } from './helpers';

/**
 * 2026-11-05 점검 D — 원본 서식 편집 조치 회귀 시험.
 */

const FIX = path.join(__dirname, 'fixtures', 'pdf-form');
const LO = new Uint8Array(fs.readFileSync(path.join(FIX, 'libreoffice-form.pdf')));
const SANS = fs.readFileSync(path.join(process.cwd(), 'assets/fonts/NotoKRSans-Regular.ttf'));

function areaEdit(id: string, x0: number, y0: number, x1: number, y1: number, page = 1): PdfEdit {
  const { matrix, width } = rectToCover(x0, y0, x1, y1);
  return {
    id, page, kind: 'erase', matrix, width, text: '',
    font: { baseFont: '', serif: false, bold: false }, color: [0, 0, 0], cover: [1, 1, 1], original: '(영역)',
  };
}
const layoutOf = (edits: PdfEdit[]): PdfLayout => ({ ...emptyPdfLayout(), edits });

/** 표준 14 글꼴(폭 표 없음) 글자 + 2바이트 CID 글꼴 글자가 함께 있는 쪽 */
async function makeStandardAndCid(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const cid = await doc.embedFont(SANS, { subset: true });
  const page = doc.addPage([400, 400]);
  page.drawText('Amount 10000', { x: 40, y: 300, size: 14, font: helv });
  page.drawText('후원 금액 20,000원', { x: 40, y: 100, size: 14, font: cid });
  return doc.save();
}

describe('H-8 덮개 아래 원래 글자를 지우지 못한 쪽 알리기', () => {
  it('표준 14 글꼴(폭 표 없음) 글자를 덮으면 그 쪽을 coverOnlyPages 로 알린다', async () => {
    const bytes = await makeStandardAndCid();
    // 시험 전제: pdf-lib 의 표준 글꼴 사전에는 Widths 가 없다.
    const doc = await PDFDocument.load(bytes);
    const fonts = doc.getPages()[0].node.Resources()!.lookup(PDFName.of('Font'))!;
    expect(String(fonts)).toContain('Helvetica');

    const r = await renderPdfLayout(bytes, layoutOf([areaEdit('a', 35, 290, 200, 320)]));
    expect(r.coverOnlyPages).toEqual([1]);
  });

  it('폭을 아는 글꼴 글자만 덮으면 지우고 알리지 않는다(폭 모르는 글자는 멀리 있음)', async () => {
    const bytes = await makeStandardAndCid();
    const r = await renderPdfLayout(bytes, layoutOf([areaEdit('b', 35, 92, 260, 120)]));
    expect(r.strippedGlyphs).toBeGreaterThan(5);
    expect(r.coverOnlyPages).toEqual([]);
  });

  it('양식 XObject 안의 글자를 덮으면 그 쪽을 알린다', async () => {
    const outer = await PDFDocument.create();
    const [embedded] = await outer.embedPdf(LO, [0]);
    const page = outer.addPage([embedded.width, embedded.height]);
    page.drawPage(embedded, { x: 0, y: 0 });
    const bytes = await outer.save();
    const r = await renderPdfLayout(bytes, layoutOf([areaEdit('c', 60, 400, 300, 430)]));
    expect(r.strippedGlyphs).toBe(0);
    expect(r.coverOnlyPages).toEqual([1]);
  });

  it('LibreOffice 서식(폭을 아는 글꼴)은 그대로 지우고 알리지 않는다', async () => {
    const doc = await PDFDocument.load(LO);
    const { width, height } = doc.getPages()[0].getSize();
    // 쪽 전체를 덮어도 모두 지울 수 있는 글꼴이다.
    const r = await renderPdfLayout(LO, layoutOf([areaEdit('d', 0, 0, width, height)]));
    expect(r.strippedGlyphs).toBeGreaterThan(20);
    expect(r.coverOnlyPages).toEqual([]);
  });

  it('안내 문구는 "일부 원래 글자를 지우지 못했을 수 있습니다" 로 쓴다', () => {
    expect(coverOnlyNotice([2, 3])).toContain('2, 3쪽은 일부 원래 글자를 지우지 못했을 수 있습니다');
    expect(coverOnlyNotice([])).toBe('');
  });
});

describe('편집기 예측과 서버 렌더러 일치', () => {
  it('글꼴 글자표를 쪽별로 주고, 다른 쪽에만 있는 글자는 대체 글꼴로 예측한다', async () => {
    // 같은 이름의 부분집합 글꼴이 쪽마다 다른 사전인 문서
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const a = await doc.embedFont(SANS, { subset: true });
    const p1 = doc.addPage([300, 200]);
    p1.drawText('가나', { x: 20, y: 100, size: 12, font: a });
    const p2 = doc.addPage([300, 200]);
    p2.drawText('다라', { x: 20, y: 100, size: 12, font: a });
    const bytes = await doc.save();
    const loaded = await PDFDocument.load(bytes);
    const infos = describeFonts(loaded, [], () => false);
    const info = infos[0];
    expect(info.pages?.map((p) => p.page)).toEqual([1, 2]);
    // pdf-lib 는 같은 글꼴 객체를 두 쪽이 함께 쓰므로 쪽별 글자표도 같다 → 두 쪽 모두 원본.
    expect(predictFontTier('가다', info, 1).tier).toBe('ORIGINAL');

    // 쪽별 글자표가 다른 경우(LibreOffice·한글 출력): 1쪽에 없는 글자는 대체 글꼴
    const split = { ...info, chars: '가나다라', pages: [{ page: 1, chars: '가나', reusableProgram: false }, { page: 2, chars: '다라', reusableProgram: false }] };
    expect(predictFontTier('가다', split).tier).toBe('ORIGINAL'); // 쪽을 모르면 합산
    expect(predictFontTier('가다', split, 1)).toEqual({ tier: 'FALLBACK', missing: ['다'] });
    expect(predictFontTier('다라', split, 2).tier).toBe('ORIGINAL');
    // 그 쪽에 글꼴이 없으면 원본 글꼴로 예측하지 않는다.
    expect(predictFontTier('가', split, 3).tier).toBe('FALLBACK');
  });

  it('원본 글꼴에 모든 글자가 있으면 올린 글꼴보다 원본 글꼴로 예측한다(서버 순서)', () => {
    const info = { baseFont: 'X', display: 'X', serif: false, bold: false, chars: '후원', reusableProgram: false, uploaded: true };
    expect(predictFontTier('후원', info).tier).toBe('ORIGINAL');
    expect(predictFontTier('후원금', info).tier).toBe('UPLOADED');
  });

  it('같은 기록인지 정규화 후 비교한다', () => {
    const l = layoutOf([areaEdit('x', 0, 0, 10, 10)]);
    expect(sameLayout(l, JSON.parse(JSON.stringify(l)))).toBe(true);
    expect(sameLayout(l, emptyPdfLayout())).toBe(false);
  });
});

describe('회전된 쪽 새 글 방향 · 색 읽기 창', () => {
  it('/Rotate 에 맞춰 새 글 행렬을 돌린다', () => {
    expect(newTextMatrix(10, 100, 200, 0)).toEqual([10, 0, 0, 10, 100, 196.5]);
    const r90 = newTextMatrix(10, 100, 200, 90);
    expect(r90.slice(0, 4)).toEqual([0, 10, -10, 0]);
    expect(r90[4]).toBeCloseTo(103.5);
    expect(newTextMatrix(10, 0, 0, 270).slice(0, 4)).toEqual([0, -10, 10, 0]);
    expect(newTextMatrix(10, 0, 0, -90).slice(0, 4)).toEqual([0, -10, 10, 0]);
    expect(newTextMatrix(10, 0, 0, 180).slice(0, 4)).toEqual([-10, 0, 0, -10]);
    // 크기만 바꾸면 방향은 유지
    expect(resizeMatrix(r90, 20).slice(0, 4)).toEqual([0, 20, -20, 0]);
    expect(screenAngleDeg([0, 0], [0, 10])).toBe(90);
    expect(screenAngleDeg([0, 0], [10, 0.01])).toBe(0);
  });

  it('회전된 쪽에 넣은 글은 결과 PDF 에서도 그 방향 그대로 쓰인다', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const f = await doc.embedFont(SANS, { subset: true });
    const page = doc.addPage([300, 400]);
    page.setRotation(degrees(90));
    page.drawText('가', { x: 10, y: 10, size: 10, font: f });
    const bytes = await doc.save();
    const edit: PdfEdit = {
      id: 'add-r', page: 1, kind: 'add', matrix: newTextMatrix(12, 150, 200, 90), width: 0, text: '가',
      font: { baseFont: f.name, serif: false, bold: false }, color: [0, 0, 0], cover: [1, 1, 1], original: '',
    };
    const r = await renderPdfLayout(bytes, layoutOf([edit]));
    expect(Buffer.from(r.bytes).length).toBeGreaterThan(0);
    const out = await PDFDocument.load(r.bytes);
    expect(out.getPages()[0].getRotation().angle).toBe(90);
  });

  it('색 읽기는 누른 자리만 작은 창으로 그린다', () => {
    const w = sampleWindow({ left: 100, top: 50, right: 160, bottom: 70 }, { scale: 2, pad: 4 });
    expect(w.scale).toBe(2);
    expect(w.width).toBe(128);
    expect(w.height).toBe(48);
    expect(w.offsetX).toBe(-196);
    expect(w.inner).toEqual({ x0: 4, y0: 4, x1: 124, y1: 44 });
    // 쪽 전체 같은 큰 영역은 배율을 줄여 상한(px) 안에 둔다.
    const big = sampleWindow({ left: 0, top: 0, right: 600, bottom: 850 }, { scale: 2, maxPx: 1200 });
    expect(big.height).toBeLessThanOrEqual(1200 + 8);
  });
});

describe('기관이 올린 글꼴 대장', () => {
  let fx: Fixture;
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  it('기관 소유로 비공개 저장소에 저장하고, 다른 기관 이름으로는 렌더에 쓰지 않는다', async () => {
    const saved = await registerFontAsset(fx.merchantId, SANS, 'ttf', 'NotoSans', '고딕.ttf');
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.asset.name).toMatch(/^[a-f0-9]{32}\.ttf$/);
    // 공개 저장 위치(var/uploads)에는 없다.
    expect(fs.existsSync(path.join(process.cwd(), 'var', 'uploads', saved.asset.name))).toBe(false);
    expect((await getPrivateObject(saved.asset.name))?.length).toBe(SANS.length);
    expect((await fontLoaderFor(fx.merchantId)(saved.asset.name))?.length).toBe(SANS.length);
    expect(await fontLoaderFor('other-merchant')(saved.asset.name)).toBeNull();

    const baseUrl = await putObject(newObjectName('pdf'), Buffer.from(LO), 'application/octet-stream');
    const layout: PdfLayout = {
      ...layoutOf([areaEdit('a', 10, 10, 50, 30)]),
      fonts: [{ match: 'NotoSans', url: saved.asset.name, name: 'x' }],
    };
    const otherToken = signBasePdf('other-merchant', baseUrl);
    const other = await previewLayout('other-merchant', { basePdfUrl: baseUrl, token: otherToken }, layout);
    expect(other.ok).toBe(false);
    const mine = await previewLayout(fx.merchantId, { basePdfUrl: baseUrl, token: signBasePdf(fx.merchantId, baseUrl) }, layout);
    expect(mine.ok).toBe(true);
    const stored = await renderAndStore('other-merchant', baseUrl, layout);
    expect(stored.ok).toBe(false);
  });

  it('기관별 개수 상한을 넘으면 거절한다', async () => {
    const tiny = Buffer.from(SANS.subarray(0, 64));
    for (let i = 0; i < FONT_ASSET_MAX_COUNT; i++) {
      await prisma.documentFontAsset.create({
        data: { id: newId(), merchantId: fx.merchantId, name: newObjectName('ttf'), match: 'X', displayName: 'x', bytes: 10 },
      });
    }
    const res = await registerFontAsset(fx.merchantId, tiny, 'ttf', 'X', 'x.ttf');
    expect(res.ok).toBe(false);
  });

  it('어느 서식에도 쓰이지 않고 오래된 글꼴만 파일과 함께 정리한다', async () => {
    const used = await registerFontAsset(fx.merchantId, SANS, 'ttf', 'A', 'a.ttf');
    const orphan = await registerFontAsset(fx.merchantId, SANS, 'ttf', 'B', 'b.ttf');
    const fresh = await registerFontAsset(fx.merchantId, SANS, 'ttf', 'C', 'c.ttf');
    if (!used.ok || !orphan.ok || !fresh.ok) throw new Error('setup');
    const old = new Date(Date.now() - 72 * 3600_000);
    await prisma.documentFontAsset.updateMany({ where: { name: { in: [used.asset.name, orphan.asset.name] } }, data: { createdAt: old } });
    await prisma.documentTemplate.create({
      data: {
        id: newId(), merchantId: fx.merchantId, name: '서식', templateType: 'FILE', fileUrl: '/api/media/' + 'a'.repeat(32) + '.pdf',
        pdfLayout: { ...emptyPdfLayout(), fonts: [{ match: 'A', url: used.asset.name, name: 'a' }] },
      },
    });
    const res = await cleanupUnreferencedFontAssets();
    expect(res.removed).toBe(1);
    const left = (await prisma.documentFontAsset.findMany({ select: { name: true } })).map((r) => r.name).sort();
    expect(left).toEqual([used.asset.name, fresh.asset.name].sort());
    expect(await getPrivateObject(orphan.asset.name)).toBeNull();
  });

  it('넓은 화면 저장은 같은 기록이면 결과 PDF 를 다시 만들지 않는다', async () => {
    const baseUrl = await putObject(newObjectName('pdf'), Buffer.from(LO), 'application/octet-stream');
    const templateId = newId();
    await prisma.documentTemplate.create({
      data: {
        id: templateId, merchantId: fx.merchantId, name: '약정서', templateType: 'FILE', fileUrl: baseUrl,
        basePdfUrl: baseUrl, basePdfHash: 'x', pdfPageCount: 1,
      },
    });
    const layout = layoutOf([areaEdit('a', 10, 10, 50, 30)]);
    const first = await saveTemplateLayout(fx.merchantId, templateId, layout);
    const second = await saveTemplateLayout(fx.merchantId, templateId, JSON.parse(JSON.stringify(layout)));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.unchanged).toBe(true);
    expect(second.renderedPdfUrl).toBe(first.renderedPdfUrl);
  });

  it('미리보기에서 그리다 실패하면 예외 대신 한국어 안내를 돌려준다', async () => {
    const broken = await putObject(newObjectName('pdf'), Buffer.from('%PDF-1.4\n%%EOF'), 'application/octet-stream');
    const res = await previewLayout(fx.merchantId, { basePdfUrl: broken, token: signBasePdf(fx.merchantId, broken) }, layoutOf([areaEdit('a', 1, 1, 5, 5)]));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).toMatch(/PDF 로 만들지 못했습니다/);
  });
});
