import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { prisma } from '@/server/db';
import { formatKst, kstDateKey } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { maskName } from '@/lib/crypto';
import { INCOME_SOURCE_LABEL, LEGAL_NOTICE, incomeStatement, usageStatement, type IncomeStatement } from './legal-reports';

/**
 * 법정 서류 파일 만들기 — 2026-11-09 3차 H2. 저장하지 않고 내려받을 때마다 만든다(원천이 바뀌면 결과도 바뀐다).
 *
 *  (a) 후원금 수입 및 사용결과 보고서 — 별지 제19호서식 "항목을 채운 작성 보조 자료"(서식 복제가 아님) PDF + 엑셀 호환 CSV(UTF-8 BOM)
 *  (b) 후원금 영수증 발급 대장 — 기존 영수증 대장(기부금영수증 + 현물 영수증) 데이터, 이름·번호는 마스킹만
 *  (c) 공개용 게시 판 — 후원자 이름 없음(3개월 게시)
 * 공개·제출용 판에는 후원자 이름이 없다. 내부용(수입 명세 마스킹 이름·발급 대장)은 화면에서 금전 권한(기관 계정)만 받는다.
 */

export type LegalFileKind = 'report-pdf' | 'report-csv' | 'public-pdf' | 'public-csv' | 'income-internal-csv' | 'receipt-ledger-csv';

export const LEGAL_FILE_LABEL: Record<LegalFileKind, string> = {
  'report-pdf': '후원금 수입 및 사용결과 보고서(PDF)',
  'report-csv': '후원금 수입 및 사용결과 보고서(CSV·엑셀)',
  'public-pdf': '공개용 게시 판(PDF, 이름 없음)',
  'public-csv': '공개용 게시 판(CSV, 이름 없음)',
  'income-internal-csv': '수입 명세 내부용(CSV, 마스킹 이름)',
  'receipt-ledger-csv': '후원금 영수증 발급 대장(CSV)',
};

/** 내부용(개인 식별 가능성이 있는) 파일 — 사유를 받고 금전 권한만 */
export const INTERNAL_FILE_KINDS: readonly LegalFileKind[] = ['income-internal-csv', 'receipt-ledger-csv'];

export function isLegalFileKind(v: string): v is LegalFileKind {
  return v in LEGAL_FILE_LABEL;
}

function csvCell(v: string | number | bigint | null | undefined): string {
  const s = String(v ?? '').replace(/\r?\n/g, ' ');
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

function csv(lines: Array<Array<string | number | bigint | null | undefined>>): string {
  return '﻿' + lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

interface MerchantInfo {
  displayName: string;
  code: string;
  businessNo: string | null;
  representativeName: string | null;
  address: string | null;
}

async function merchantInfo(merchantId: string): Promise<MerchantInfo> {
  return prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { displayName: true, code: true, businessNo: true, representativeName: true, address: true } });
}

function incomeSummaryLines(i: IncomeStatement) {
  return [
    ['수입 합계', formatNumber(i.total)],
    ...(['CHARGE', 'OFFLINE', 'IN_KIND'] as const).map((k) => [`  ${INCOME_SOURCE_LABEL[k]}`, `${formatNumber(i.bySource[k].amount)} (${formatNumber(i.bySource[k].count)}건)`]),
    ['  지정 후원', formatNumber(i.designated)],
    ['  비지정 후원', formatNumber(i.undesignated)],
  ];
}

export async function buildLegalCsv(merchantId: string, year: number, kind: Exclude<LegalFileKind, 'report-pdf' | 'public-pdf'>): Promise<{ content: string; fileName: string; rows: number }> {
  const m = await merchantInfo(merchantId);
  const made = formatKst(new Date(), false);
  if (kind === 'receipt-ledger-csv') return receiptLedgerCsv(merchantId, year, m);
  if (kind === 'income-internal-csv') {
    const i = await incomeStatement(merchantId, year, 'internal');
    const lines: Array<Array<string | number | bigint | null>> = [
      [`${m.displayName} ${year}년 후원금 수입 명세(내부용 — 외부 공개 금지)`],
      [LEGAL_NOTICE],
      [`작성 ${made}`],
      [],
      ['일자', '출처', '후원자 구분', '후원자(마스킹)', '지정/비지정', '금액(원)'],
      ...i.rows.map((r) => [r.date, INCOME_SOURCE_LABEL[r.source], r.donorKind, r.maskedName ?? '', r.designation, r.amount]),
      [],
      ...incomeSummaryLines(i),
    ];
    return { content: csv(lines), fileName: `income-internal-${m.code}-${year}.csv`, rows: i.rows.length };
  }
  const [i, u] = await Promise.all([incomeStatement(merchantId, year, 'public'), usageStatement(merchantId, year)]);
  const posting = kind === 'public-csv';
  const lines: Array<Array<string | number | bigint | null>> = [
    [posting ? `${m.displayName} ${year}년 후원금 수입 및 사용결과(공개용 게시 — 후원자 성명 비공개, 3개월 게시)` : `${m.displayName} ${year}년 후원금 수입 및 사용결과 보고서(별지 제19호서식 항목 작성 보조 자료)`],
    [LEGAL_NOTICE],
    ['기관명', m.displayName],
    ['고유번호(사업자번호)', m.businessNo ?? ''],
    ['대표자', m.representativeName ?? ''],
    ['소재지', m.address ?? ''],
    ['기간', `${year}-01-01 ~ ${year}-12-31`],
    ['작성', made],
    [],
    ['[후원금 수입 명세]'],
    ['일자', '출처', '후원자 구분', '지정/비지정', '금액(원)'],
    ...i.rows.map((r) => [r.date, INCOME_SOURCE_LABEL[r.source], r.donorKind, r.designation, r.amount]),
    [],
    ...incomeSummaryLines(i),
    [],
    ['[후원금 사용 명세]'],
    ['사용일', '사용 내역', '지정 용도', '금액(원)'],
    ...u.rows.map((r) => [r.date, r.description, r.designation, r.amount]),
    [],
    ['사용 합계', formatNumber(u.total)],
    ['  지정 후원 사용', formatNumber(u.designated)],
    ['  비지정 후원 사용', formatNumber(u.undesignated)],
  ];
  return { content: csv(lines), fileName: `${posting ? 'public' : 'report'}-${m.code}-${year}.csv`, rows: i.rows.length + u.rows.length };
}

async function receiptLedgerCsv(merchantId: string, year: number, m: MerchantInfo) {
  const [cash, inKind] = await Promise.all([
    prisma.donationReceipt.findMany({ where: { merchantId, taxYear: year }, orderBy: [{ seq: 'asc' }] }),
    prisma.inKindReceipt.findMany({ where: { merchantId, taxYear: year }, orderBy: [{ seq: 'asc' }] }),
  ]);
  const lines: Array<Array<string | number | bigint | null>> = [
    [`${m.displayName} ${year}년 후원금 영수증 발급 대장(내부용 — 외부 공개 금지)`],
    [LEGAL_NOTICE],
    [`작성 ${formatKst(new Date(), false)}`],
    [],
    ['발급번호', '발급일', '구분', '기부자(마스킹)', '주민등록번호(마스킹)', '금액(원)', '건수', '상태', '무효 사유'],
  ];
  for (const r of cash) {
    const d = (r.donorSnapshot ?? {}) as { legalName?: string; residentNoMasked?: string };
    lines.push([r.receiptNo, kstDateKey(r.issuedAt), '금전', maskName(d.legalName ?? ''), d.residentNoMasked ?? '', r.totalAmount, r.chargeCount, r.status === 'ISSUED' ? '발급' : '무효', r.voidReason ?? '']);
  }
  for (const r of inKind) {
    const d = (r.donorSnapshot ?? {}) as { name?: string; legalName?: string; residentNoMasked?: string };
    lines.push([r.receiptNo, kstDateKey(r.issuedAt), r.donorType === 'CORPORATE' ? '현물(법인)' : '현물(개인)', maskName(d.name ?? d.legalName ?? ''), r.donorType === 'CORPORATE' ? '' : (d.residentNoMasked ?? ''), r.totalAmount, 1, r.status === 'ISSUED' ? '발급' : '무효', r.voidReason ?? '']);
  }
  return { content: csv(lines), fileName: `receipt-ledger-${m.code}-${year}.csv`, rows: cash.length + inKind.length };
}

// ---------------------------------------------------------------------------
// PDF (pdf-lib + 번들 한글 글꼴 assets/fonts — 원본 서식 복제가 아니라 항목을 채운 표)
// ---------------------------------------------------------------------------

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');

export async function buildLegalPdf(merchantId: string, year: number, kind: 'report-pdf' | 'public-pdf'): Promise<{ bytes: Uint8Array; fileName: string; rows: number }> {
  const { PDFDocument, rgb } = await import('pdf-lib');
  const fontkit = (await import('@pdf-lib/fontkit')).default;
  const [m, i, u] = await Promise.all([merchantInfo(merchantId), incomeStatement(merchantId, year, 'public'), usageStatement(merchantId, year)]);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [reg, bold] = await Promise.all([readFile(path.join(FONT_DIR, 'NotoKRSans-Regular.ttf')), readFile(path.join(FONT_DIR, 'NotoKRSans-Bold.ttf'))]);
  const font = await doc.embedFont(reg, { subset: true });
  const fontB = await doc.embedFont(bold, { subset: true });
  doc.setTitle(`${year} 후원금 수입 및 사용결과`);
  const W = 595.28;
  const H = 841.89;
  const M = 40;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const ink = rgb(0.1, 0.1, 0.12);
  const grey = rgb(0.45, 0.45, 0.5);

  const fit = (text: string, size: number, max: number, f = font) => {
    let t = text;
    if (f.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length > 1 && f.widthOfTextAtSize(`${t}…`, size) > max) t = t.slice(0, -1);
    return `${t}…`;
  };
  const ensure = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const line = (text: string, size = 9, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; x?: number } = {}) => {
    ensure(size + 5);
    const f = opts.bold ? fontB : font;
    page.drawText(fit(text, size, W - M * 2 - (opts.x ?? 0), f), { x: M + (opts.x ?? 0), y: y - size, size, font: f, color: opts.color ?? ink });
    y -= size + 5;
  };
  const table = (head: string[], widths: number[], rows: string[][], alignRight: number[]) => {
    const size = 8.5;
    const drawRow = (cells: string[], f = font) => {
      ensure(size + 6);
      let x = M;
      cells.forEach((c, idx) => {
        const w = widths[idx]!;
        const t = fit(c, size, w - 4, f);
        const tx = alignRight.includes(idx) ? x + w - 2 - f.widthOfTextAtSize(t, size) : x + 2;
        page.drawText(t, { x: tx, y: y - size, size, font: f, color: ink });
        x += w;
      });
      y -= size + 6;
      page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.3, color: rgb(0.85, 0.85, 0.88) });
    };
    drawRow(head, fontB);
    if (!rows.length) line('(내역 없음)', 8.5, { color: grey });
    for (const r of rows) drawRow(r);
  };

  const posting = kind === 'public-pdf';
  line(posting ? `${year}년 후원금 수입 및 사용결과 (공개용 게시)` : `${year}년 후원금 수입 및 사용결과 보고서`, 15, { bold: true });
  line(posting ? '후원자 성명(법인 명칭) 비공개 · 게시판·홈페이지 3개월 게시용' : '별지 제19호서식 항목을 채운 작성 보조 자료(법정 서식 원본이 아님)', 9, { color: grey });
  line(LEGAL_NOTICE, 8, { color: grey });
  y -= 4;
  line(`기관명 ${m.displayName}   고유번호 ${m.businessNo ?? '-'}   대표자 ${m.representativeName ?? '-'}`, 9);
  line(`소재지 ${m.address ?? '-'}`, 9);
  line(`기간 ${year}-01-01 ~ ${year}-12-31   작성 ${formatKst(new Date(), false)}`, 9);
  y -= 6;
  line('1. 후원금 수입 명세', 11, { bold: true });
  for (const [k, v] of incomeSummaryLines(i)) line(`${k.trim()}: ${v}${k === '수입 합계' ? '원' : ''}`, 9, { x: k.startsWith('  ') ? 10 : 0 });
  y -= 2;
  table(['일자', '출처', '후원자 구분', '지정/비지정', '금액(원)'], [70, 120, 70, 170, 85], i.rows.map((r) => [r.date, INCOME_SOURCE_LABEL[r.source], r.donorKind, r.designation, formatNumber(r.amount)]), [4]);
  y -= 8;
  line('2. 후원금 사용 명세', 11, { bold: true });
  line(`사용 합계: ${formatWon(u.total)} (지정 ${formatWon(u.designated)} · 비지정 ${formatWon(u.undesignated)})`, 9);
  y -= 2;
  table(['사용일', '사용 내역', '지정 용도', '금액(원)'], [70, 220, 140, 85], u.rows.map((r) => [r.date, r.description, r.designation, formatNumber(r.amount)]), [3]);
  y -= 8;
  line('후원금 사용 결과는 기관 결산과 대조해 확인하세요. 지정 후원금은 지정 용도 외에 사용할 수 없습니다(제41조의7 — 법령 서식과 대조 필요).', 8, { color: grey });
  const bytes = await doc.save();
  return { bytes, fileName: `${posting ? 'public' : 'report'}-${m.code}-${year}.pdf`, rows: i.rows.length + u.rows.length };
}

/** 내려받기 가능한 연도(기관 승인 이후 ~ 올해) — 화면 선택지 */
export function legalYearOptions(now = new Date()): number[] {
  const y = Number(kstDateKey(now).slice(0, 4));
  return [y, y - 1, y - 2, y - 3, y - 4];
}

