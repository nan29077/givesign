import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { putObject, newObjectName } from '@/server/uploads';
import {
  emptyPdfLayout, parsePdfLayout, predictFontTier, classifyFontName, type PdfEdit, type PdfLayout,
} from '@/lib/pdf-form';
import { groupTextRuns, rectToCover, sampleColors, coverPolygon, type PdfTextRun } from '@/lib/pdf-form-runs';
import { renderPdfLayout } from '@/server/services/pdf-form/render';
import { parseToUnicode } from '@/server/services/pdf-form/fonts';
import { toBasePdf } from '@/server/services/pdf-form/convert';
import { saveTemplateLayout, previewTemplateLayout, effectivePdf } from '@/server/services/pdf-form';
import { createEnvelope, readSnapshot } from '@/server/services/edoc';
import { ensureWallet } from '@/server/services/edoc-billing';
import { resetDb, seedBasics, type Fixture } from './helpers';

/**
 * 원본 서식 위에서 고치기.
 *
 * 시험 자료
 *  - libreoffice-form.pdf : 한글·워드를 LibreOffice 로 PDF 저장한 형태(1바이트 Type1 글꼴, 256자마다 나뉜 사전)
 *  - chrome-type3.pdf     : 브라우저 인쇄로 만든 형태(Type3 글꼴, 같은 이름 사전 여럿)
 *  - 시험 중 생성          : 2바이트 Identity-H CID 글꼴(한글·워드의 PDF 저장 기본 형태)
 */

const FIX = path.join(__dirname, 'fixtures', 'pdf-form');
const LO = new Uint8Array(fs.readFileSync(path.join(FIX, 'libreoffice-form.pdf')));
const CHROME = new Uint8Array(fs.readFileSync(path.join(FIX, 'chrome-type3.pdf')));

async function runsOf(bytes: Uint8Array, pageNo = 1): Promise<PdfTextRun[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), fontExtraProperties: true, disableFontFace: true }).promise;
  const page = await doc.getPage(pageNo);
  await page.getOperatorList();
  const tc = await page.getTextContent();
  const items = tc.items.filter((i): i is typeof i & { str: string; transform: number[]; width: number; fontName: string } => 'str' in i);
  const runs = groupTextRuns(pageNo, items, (k) => (page.commonObjs.get(k) as { name?: string })?.name ?? k);
  await doc.loadingTask.destroy();
  return runs;
}

async function textOf(bytes: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true }).promise;
  let out = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out += tc.items.map((it) => ('str' in it ? it.str : '')).join('') + '\n';
  }
  await doc.loadingTask.destroy();
  return out;
}

function editFromRun(run: PdfTextRun, text: string, kind: PdfEdit['kind'] = 'replace'): PdfEdit {
  return {
    id: run.id, page: run.page, kind, matrix: run.matrix, width: run.width, text,
    font: { baseFont: run.baseFont, serif: run.serif, bold: run.bold },
    color: [0, 0, 0], cover: [1, 1, 1], original: run.text,
  };
}

function layoutOf(edits: PdfEdit[]): PdfLayout {
  return { ...emptyPdfLayout(), edits };
}

/** 2바이트 Identity-H 글꼴 PDF (한글·워드 PDF 저장과 같은 구조) */
async function makeType0(): Promise<{ bytes: Uint8Array; fontName: string }> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fs.readFileSync(path.join(process.cwd(), 'assets/fonts/NotoKRSans-Regular.ttf')), { subset: true });
  const page = doc.addPage([400, 300]);
  page.drawText('후원약정서 금액 10,000원', { x: 30, y: 200, size: 14, font });
  page.drawText('세로 글자', { x: 300, y: 40, size: 12, font, rotate: degrees(90) });
  const bytes = await doc.save();
  return { bytes, fontName: font.name };
}

describe('글자 묶음 인식', () => {
  it('같은 줄·같은 글꼴은 한 묶음으로, 글꼴·크기는 원본 값으로 잡는다', async () => {
    const runs = await runsOf(LO);
    const title = runs.find((r) => r.text.includes('후원 약정서'));
    expect(title).toBeTruthy();
    expect(title!.size).toBeCloseTo(20, 1);
    expect(title!.baseFont).toMatch(/NotoSerifCJKkr-Bold/);
    expect(title!.serif).toBe(true);
    expect(title!.bold).toBe(true);
    const amount = runs.find((r) => r.text.includes('10,000'));
    expect(amount?.size).toBeCloseTo(11, 1);
  });

  it('글꼴 이름으로 계열·굵기를 판정한다(한국 서식에 흔한 이름 포함)', () => {
    expect(classifyFontName('ABCDEF+HCRBatang')).toEqual({ serif: true, bold: false });
    expect(classifyFontName('HYHeadLine-Medium').bold).toBe(true); // HY헤드라인은 굵은 제목 글꼴
    expect(classifyFontName('MalgunGothicBold')).toEqual({ serif: false, bold: true });
    expect(classifyFontName('NotoSansCJKkr-Regular').serif).toBe(false);
  });

  it('영역 지우기 사각형은 덮개 다각형으로 되돌렸을 때 같은 영역이다', () => {
    const { matrix, width } = rectToCover(100, 200, 180, 230);
    const poly = coverPolygon({ matrix, width });
    expect(poly[0][0]).toBeCloseTo(100, 3);
    expect(poly[0][1]).toBeCloseTo(200, 3);
    expect(poly[2][0]).toBeCloseTo(180, 3);
    expect(poly[2][1]).toBeCloseTo(230, 3);
  });

  it('바탕색과 글자색을 그림에서 읽는다', () => {
    const w = 20;
    const h = 10;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([250, 240, 200, 255], i * 4);
    for (let x = 6; x < 14; x++) for (let y = 3; y < 7; y++) data.set([200, 20, 20, 255], (y * w + x) * 4);
    const c = sampleColors(data, w, h, { x0: 0, y0: 0, x1: 19, y1: 9 });
    expect(c.cover[0]).toBeCloseTo(250 / 255, 2);
    expect(c.color[0]).toBeCloseTo(200 / 255, 2);
    expect(c.color[1]).toBeCloseTo(20 / 255, 2);
  });
});

describe('ToUnicode 읽기', () => {
  it('bfchar · bfrange(시작값·배열) 를 모두 읽고 합자는 버린다', () => {
    const cmap = `
      1 begincodespacerange <0000> <FFFF> endcodespacerange
      2 beginbfchar <0003> <D6C4> <0004> <00660069> endbfchar
      2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<AC00> <AC01>] endbfrange`;
    const { map, bytes } = parseToUnicode(cmap);
    expect(bytes).toBe(2);
    expect(map.get(3)).toBe('후');
    expect(map.has(4)).toBe(false);
    expect(map.get(0x11)).toBe('B');
    expect(map.get(0x21)).toBe('각');
  });
});

describe('결과 PDF 만들기', () => {
  it('원본 글꼴에 있는 글자는 원본 글꼴 그대로, 원래 글자는 파일에서도 지운다 (1바이트 Type1)', async () => {
    const runs = await runsOf(LO);
    const amount = runs.find((r) => r.text.startsWith('후원 금액'))!;
    const r = await renderPdfLayout(LO, layoutOf([editFromRun(amount, amount.text.replace('10,000', '20,000'))]));
    expect(r.report[0].tier).toBe('ORIGINAL');
    expect(r.strippedGlyphs).toBeGreaterThan(5);
    const text = await textOf(r.bytes);
    expect(text).toContain('20,000');
    expect(text).not.toContain('10,000');
    // 새 글꼴이 추가되지 않았다(원본 글꼴 객체를 다시 썼다).
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(Buffer.from(r.bytes).includes(Buffer.from('NotoKRSans'))).toBe(false);
  });

  it('원본 글꼴에 없는 글자가 섞이면 같은 계열·굵기 대체 글꼴로, 없는 글자를 알려 준다', async () => {
    const runs = await runsOf(LO);
    const title = runs.find((r) => r.text.includes('후원 약정서'))!;
    const r = await renderPdfLayout(LO, layoutOf([editFromRun(title, '정기 후원 약정서')]));
    expect(r.report[0].tier).toBe('FALLBACK');
    expect(r.report[0].missing).toContain('기');
    const text = await textOf(r.bytes);
    expect(text).toContain('정기 후원 약정서');
    expect(text.match(/후원 약정서/g)?.length).toBe(1);
  });

  it('브라우저 인쇄 PDF(Type3)도 원본 글꼴을 다시 쓰고 원래 글자를 지운다', async () => {
    const runs = await runsOf(CHROME);
    const field = runs.find((r) => r.text === '분야')!;
    const r = await renderPdfLayout(CHROME, layoutOf([editFromRun(field, '구분')]));
    expect(r.report[0].tier).toBe('ORIGINAL');
    expect(r.strippedGlyphs).toBe(2);
    expect(await textOf(r.bytes)).not.toContain('분야');
  });

  it('2바이트 CID 글꼴: 원본 글꼴로 쓰고, 세로 글자 방향도 그대로 둔다', async () => {
    const { bytes, fontName } = await makeType0();
    const runs = await runsOf(bytes);
    const line = runs.find((r) => r.text.includes('10,000'))!;
    const vertical = runs.find((r) => r.text.includes('세로'))!;
    expect(Math.abs(vertical.matrix[1])).toBeGreaterThan(10); // 세로 방향
    const r = await renderPdfLayout(
      bytes,
      layoutOf([
        editFromRun(line, '후원약정서 금액 1,000원'),
        { ...editFromRun(vertical, '글자 세로'), id: 'v' },
      ]),
    );
    expect(r.report.map((x) => x.tier)).toEqual(['ORIGINAL', 'ORIGINAL']);
    const text = await textOf(r.bytes);
    expect(text).toContain('1,000원');
    expect(text).not.toContain('10,000');
    expect(line.baseFont.startsWith(fontName)).toBe(true);
  });

  it('기관이 올린 글꼴이 있으면 원본에 없는 글자도 그 글꼴로 쓴다', async () => {
    const runs = await runsOf(LO);
    const title = runs.find((r) => r.text.includes('후원 약정서'))!;
    const fontFile = new Uint8Array(fs.readFileSync(path.join(process.cwd(), 'assets/fonts/NotoKRSerif-Bold.ttf')));
    const layout: PdfLayout = {
      ...layoutOf([editFromRun(title, '정기 후원 약정서')]),
      fonts: [{ match: 'NotoSerifCJKkr-Bold', url: 'a'.repeat(32) + '.ttf', name: '명조.ttf' }],
    };
    const r = await renderPdfLayout(LO, layout, { loadAsset: async () => fontFile });
    expect(r.report[0].tier).toBe('UPLOADED');
  });

  it('새 글 넣기는 덮개 없이 글자만, 지우기는 덮개만 그린다', async () => {
    const runs = await runsOf(LO);
    const near = runs.find((r) => r.text.startsWith('본인은'))!;
    const add: PdfEdit = { ...editFromRun(near, '서명란', 'add'), id: 'add-1', matrix: [11, 0, 0, 11, 60, 500], width: 0 };
    const erase: PdfEdit = { ...editFromRun(runs.find((r) => r.text.startsWith('Contact'))!, '', 'erase') };
    const r = await renderPdfLayout(LO, layoutOf([add, erase]));
    const text = await textOf(r.bytes);
    expect(text).toContain('본인은'); // 넣기는 기존 글자를 지우지 않는다
    expect(text).toContain('서명란');
    expect(text).not.toContain('Contact');
  });

  it('같은 기록으로 두 번 만들면 같은 결과가 나온다(원본은 바뀌지 않는다)', async () => {
    const runs = await runsOf(LO);
    const amount = runs.find((r) => r.text.startsWith('후원 금액'))!;
    const layout = layoutOf([editFromRun(amount, '후원 금액: 월 30,000원')]);
    const before = Buffer.from(LO).toString('base64');
    const a = await renderPdfLayout(LO, layout);
    const b = await renderPdfLayout(LO, layout);
    expect(await textOf(a.bytes)).toBe(await textOf(b.bytes));
    expect(Buffer.from(LO).toString('base64')).toBe(before);
  });
});

describe('편집 기록 검증', () => {
  it('모양이 틀린 기록은 받지 않는다', () => {
    expect(parsePdfLayout({ v: 1, edits: [{ id: 'x' }] })).toBeNull();
    expect(parsePdfLayout('not json')).toBeNull();
    expect(parsePdfLayout({ v: 1, edits: [] })).toEqual({ v: 1, edits: [], fonts: [] });
  });

  it('원본 글꼴에 있는 글자인지 미리 판정한다', () => {
    const info = { baseFont: 'X', display: 'X', serif: false, bold: false, chars: '후원금액', reusableProgram: false, uploaded: false };
    expect(predictFontTier('후원 금액', info)).toEqual({ tier: 'ORIGINAL', missing: [] });
    expect(predictFontTier('후원 앵', info)).toEqual({ tier: 'FALLBACK', missing: ['앵'] });
    expect(predictFontTier('아무거나', { ...info, uploaded: true }).tier).toBe('UPLOADED');
    expect(predictFontTier('아무거나', { ...info, chars: null }).tier).toBe('ORIGINAL');
  });
});

describe('편집 바탕 PDF 만들기', () => {
  it('PDF 는 그대로, PNG 스캔본은 한 쪽 PDF 로 감싼다', async () => {
    const pdf = await toBasePdf(LO, 'pdf');
    expect(pdf.ok && pdf.converted).toBe('none');
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAwMDAxMDAAAAeBQIBxbgP2QAAAABJRU5ErkJggg==',
      'base64',
    );
    const img = await toBasePdf(new Uint8Array(png), 'png');
    expect(img.ok && img.pageCount).toBe(1);
    expect(img.ok && img.converted).toBe('image');
  });

  it('PDF 가 아닌 파일·쪽수 초과는 거절한다', async () => {
    const bad = await toBasePdf(new Uint8Array(Buffer.from('%PDF-1.4 garbage')), 'pdf');
    expect(bad.ok).toBe(false);
    const big = await PDFDocument.create();
    for (let i = 0; i < 31; i++) big.addPage([100, 100]);
    const over = await toBasePdf(await big.save(), 'pdf');
    expect(over.ok).toBe(false);
  });
});

describe('서식에 저장', () => {
  let fx: Fixture;
  let templateId: string;
  let baseUrl: string;

  beforeAll(async () => {
    baseUrl = await putObject(newObjectName('pdf'), Buffer.from(LO), 'application/octet-stream');
  });

  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
    templateId = newId();
    await prisma.documentTemplate.create({
      data: {
        id: templateId, merchantId: fx.merchantId, name: '후원약정서', templateType: 'FILE',
        fileUrl: baseUrl, fileName: '후원약정서.pdf', requireSignature: true,
        basePdfUrl: baseUrl, basePdfHash: 'x', pdfPageCount: 1,
      },
    });
  });

  it('저장하면 새 결과 파일을 남기고, 다시 저장해도 이전 결과 파일은 그대로다', async () => {
    const runs = await runsOf(LO);
    const amount = runs.find((r) => r.text.startsWith('후원 금액'))!;
    const first = await saveTemplateLayout(fx.merchantId, templateId, layoutOf([editFromRun(amount, '후원 금액: 월 20,000원')]));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.renderedPdfUrl).toMatch(/^\/api\/media\/[a-f0-9]{32}\.pdf$/);
    const second = await saveTemplateLayout(fx.merchantId, templateId, layoutOf([editFromRun(amount, '후원 금액: 월 30,000원')]));
    expect(second.ok && second.renderedPdfUrl).not.toBe(first.renderedPdfUrl);
    const t = await prisma.documentTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(effectivePdf(t)?.url).toBe(second.ok ? second.renderedPdfUrl : null);
    expect(t.renderedPdfHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('수정을 모두 지우고 저장하면 원본을 그대로 쓴다', async () => {
    const res = await saveTemplateLayout(fx.merchantId, templateId, emptyPdfLayout());
    expect(res.ok && res.renderedPdfUrl).toBeNull();
    const t = await prisma.documentTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(effectivePdf(t)?.url).toBe(baseUrl);
  });

  it('다른 기관의 서식·원본에 없는 쪽·깨진 기록은 저장하지 않는다', async () => {
    const other = await saveTemplateLayout('someone-else', templateId, emptyPdfLayout());
    expect(other.ok).toBe(false);
    const runs = await runsOf(LO);
    const e = { ...editFromRun(runs[0], 'x'), page: 2 };
    const outOfPage = await saveTemplateLayout(fx.merchantId, templateId, layoutOf([e]));
    expect(outOfPage.ok).toBe(false);
    const broken = await previewTemplateLayout(fx.merchantId, templateId, { v: 2 });
    expect(broken.ok).toBe(false);
  });

  it('올린 글꼴 주소는 저장소 이름 형식만 받는다(공개 주소·경로 조작 거절)', async () => {
    const res = await saveTemplateLayout(fx.merchantId, templateId, {
      ...emptyPdfLayout(),
      fonts: [{ match: 'X', url: '../../etc/passwd', name: 'x' }],
    });
    expect(res.ok).toBe(false);
  });

  it('서명 요청은 보낼 때의 고친 서식 주소·해시로 고정되고, 그 뒤 다시 고쳐도 바뀌지 않는다', async () => {
    const runs = await runsOf(LO);
    const amount = runs.find((r) => r.text.startsWith('후원 금액'))!;
    const saved = await saveTemplateLayout(fx.merchantId, templateId, layoutOf([editFromRun(amount, '후원 금액: 월 20,000원')]));
    expect(saved.ok).toBe(true);
    await ensureWallet(fx.merchantId);
    const sent = await createEnvelope({
      merchantId: fx.merchantId, actorId: fx.merchantUserId, nonce: newId(), templateId, signingOrder: 'PARALLEL',
      signers: [{ name: '홍길동', phone: '010-1111-2222', role: 'DONOR' }],
    });
    const env = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: sent.envelopeId } });
    const snap = readSnapshot(env.snapshotEnc);
    const t1 = await prisma.documentTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(snap.pdfUrl).toBe(t1.renderedPdfUrl);
    expect(snap.pdfHash).toBe(t1.renderedPdfHash);

    await saveTemplateLayout(fx.merchantId, templateId, layoutOf([editFromRun(amount, '후원 금액: 월 50,000원')]));
    const again = readSnapshot((await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: sent.envelopeId } })).snapshotEnc);
    expect(again.pdfUrl).toBe(t1.renderedPdfUrl);
    const t2 = await prisma.documentTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(t2.renderedPdfUrl).not.toBe(t1.renderedPdfUrl);
  });
});
