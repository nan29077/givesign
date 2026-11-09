/**
 * 기관 통장 거래내역 파일 읽기 (2026-11-09 E — 입금 자동 대사).
 *
 * 순수 함수만 둔다(DB·파일 접근 없음). 국내 주요 은행 내보내기 형식의 열 이름을 자동 인식하고,
 * 모르면 화면에서 열을 고르게 한다(`ColumnMapping`). 출금 행은 버린다.
 * 계좌번호 원문은 어디에도 남기지 않는다 — 열 자체를 읽지 않고, 이름·적요 안의 긴 숫자는 가린다(`maskLongDigits`).
 */

export const DEPOSIT_FILE_MAX_BYTES = 2 * 1024 * 1024;
export const DEPOSIT_MAX_ROWS = 5000;
/** 머리글 줄을 찾는 범위(파일 맨 위 계좌 정보·조회 기간 줄을 건너뛴다) */
const HEADER_SCAN_ROWS = 30;

export interface ColumnMapping {
  /** 머리글 줄(0부터) */
  header: number;
  /** 거래일시(날짜+시각 한 칸) 또는 거래일자 */
  date: number;
  /** 거래시간(따로 있을 때) */
  time?: number;
  amountIn: number;
  amountOut?: number;
  /** 입금자(보낸 분·기재내용·내용) */
  name?: number;
  /** 적요·메모 */
  memo?: number;
  balance?: number;
}

/** 머리글 정규화: 공백·괄호 안 단위·기호 제거 */
export function normalizeHeader(h: string): string {
  return (h ?? '')
    .replace(/^﻿/, '')
    .replace(/\((원|₩|KRW|krw)\)/g, '')
    .replace(/[\s"'·.:]/g, '')
    .trim();
}

const ALIASES = {
  datetime: ['거래일시', '거래일자시간', '거래일시분', '거래시각', '일시', '거래일자/시간', '거래일자시각'],
  date: ['거래일자', '거래일', '일자', '날짜', '거래날짜', '입금일', '입금일자'],
  time: ['거래시간', '시간', '시각', '거래시각'],
  amountIn: ['입금액', '입금', '맡기신금액', '입금금액', '받은금액', '입금하신금액', '맡기신금액원'],
  amountOut: ['출금액', '출금', '찾으신금액', '출금금액', '지급액', '지급', '지급금액', '찾으신금액원'],
  name: [
    '입금자명', '입금자', '보낸분', '보낸사람', '보낸분/받는분', '받는분/보낸분', '의뢰인', '의뢰인/수취인', '수취인/의뢰인',
    '기재내용', '내용', '거래내용', '입금인', '입금의뢰인', '적요내용',
  ],
  memo: ['적요', '메모', '송금메모', '거래구분', '구분', '비고', '거래기록사항', '통장메모'],
  balance: ['잔액', '거래후잔액', '잔고', '거래후잔고', '잔액원'],
} as const;

type Role = keyof typeof ALIASES;

function findCol(headers: string[], role: Role, taken: Set<number>): number | undefined {
  // 별칭 순서가 우선순위다(예: '보낸분' 이 '내용' 보다 입금자명에 가깝다).
  for (const alias of ALIASES[role]) {
    const i = headers.findIndex((h, idx) => !taken.has(idx) && h === alias);
    if (i >= 0) return i;
  }
  return undefined;
}

/** 머리글 한 줄에서 열을 인식한다. 날짜와 입금액이 없으면 null. */
export function mapHeaderRow(row: string[], headerIndex: number): ColumnMapping | null {
  const headers = row.map(normalizeHeader);
  const taken = new Set<number>();
  const take = (role: Role) => {
    const i = findCol(headers, role, taken);
    if (i !== undefined) taken.add(i);
    return i;
  };
  const datetime = take('datetime');
  const date = datetime ?? take('date');
  if (date === undefined) return null;
  const amountIn = take('amountIn');
  if (amountIn === undefined) return null;
  const time = datetime === undefined ? take('time') : undefined;
  const amountOut = take('amountOut');
  const balance = take('balance');
  const name = take('name');
  const memo = take('memo');
  return { header: headerIndex, date, time, amountIn, amountOut, name, memo, balance };
}

/** 파일 위쪽에서 머리글 줄을 찾는다. */
export function detectColumns(rows: string[][]): ColumnMapping | null {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    const m = mapHeaderRow(rows[i] ?? [], i);
    if (m) return m;
  }
  return null;
}

/** 열 고르기 화면용: 머리글로 보이는 줄(값이 3칸 이상인 첫 줄) */
export function guessHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, HEADER_SCAN_ROWS); i++) {
    if ((rows[i] ?? []).filter((c) => (c ?? '').trim()).length >= 3) return i;
  }
  return 0;
}

/** 인식한 형식 이름(화면 표시용). 판단 근거는 은행마다 다른 열 이름이다. */
export function formatLabel(row: string[]): string {
  const h = new Set(row.map(normalizeHeader));
  if (h.has('보낸분/받는분') || h.has('받는분/보낸분')) return '국민은행 형식';
  if (h.has('기재내용')) return '우리은행 형식';
  if (h.has('의뢰인/수취인') || h.has('수취인/의뢰인')) return '하나은행 형식';
  if (h.has('거래기록사항')) return '농협 형식';
  if (h.has('맡기신금액') || h.has('찾으신금액')) return '신한은행·통장 형식';
  return '자동 인식';
}

// ---------------------------------------------------------------------------
// 값 읽기
// ---------------------------------------------------------------------------

/** "1,000,000" · "10000원" · "10000.00" · "" · "-" → 원(음수·형식 오류는 null) */
export function parseWon(raw: string | undefined): bigint | null {
  const s = (raw ?? '').replace(/[,\s원₩]/g, '');
  if (s === '' || s === '-' || s === '0') return 0n;
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  if (m[2] && /[1-9]/.test(m[2])) return null; // 원 미만 금액은 통장 입금이 아니다
  return BigInt(m[1]!);
}

const KST_MS = 9 * 3_600_000;

function kstDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date | null {
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s) - KST_MS;
  const back = new Date(t + KST_MS);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null; // 2월 30일 같은 날짜
  return new Date(t);
}

function parseTimePart(raw: string): [number, number, number] | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  m = /^(\d{2})(\d{2})(\d{2})?$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
  // 엑셀 시각(하루의 비율)
  if (/^0?\.\d+$/.test(s)) {
    const sec = Math.round(Number(s) * 86_400);
    return [Math.floor(sec / 3600) % 24, Math.floor(sec / 60) % 60, sec % 60];
  }
  return null;
}

/**
 * 거래일시 읽기(KST). "2026-11-03 14:22:10" · "2026.11.03 14:22" · "2026/11/03" · "20261103" · "2026년 11월 3일" ·
 * 엑셀 날짜 일련번호(45964.5). 시간 칸이 따로 있으면 함께 읽는다.
 */
export function parseKstDateTime(dateRaw: string | undefined, timeRaw?: string): { at: Date; timeKnown: boolean } | null {
  const s = (dateRaw ?? '').trim();
  if (!s) return null;
  let y: number, mo: number, d: number;
  let rest = '';
  let m = /^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})\s*일?\.?(.*)$/.exec(s);
  if (m) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
    rest = m[4] ?? '';
  } else if ((m = /^(\d{4})(\d{2})(\d{2})(\d{6}|\d{4})?$/.exec(s))) {
    y = Number(m[1]);
    mo = Number(m[2]);
    d = Number(m[3]);
    rest = m[4] ?? '';
  } else if (/^\d{5}(\.\d+)?$/.test(s)) {
    // 엑셀 일련번호: 1899-12-30 기준 일수(소수부 = 시각). 셀 값은 현지(KST) 시각이다.
    const v = Number(s);
    if (v < 36526 || v > 73051) return null; // 2000~2099
    const ms = Math.round(v * 86_400) * 1000; // 초 단위로 반올림(엑셀 소수 오차)
    const local = new Date(Date.UTC(1899, 11, 30) + ms);
    return { at: new Date(local.getTime() - KST_MS), timeKnown: Math.abs(v - Math.floor(v)) > 1e-9 };
  } else return null;
  const tp = parseTimePart(rest.trim()) ?? (timeRaw ? parseTimePart(timeRaw) : null);
  const at = kstDate(y, mo, d, tp?.[0] ?? 0, tp?.[1] ?? 0, tp?.[2] ?? 0);
  return at ? { at, timeKnown: Boolean(tp) } : null;
}

/** 이름·적요 안의 긴 숫자(계좌번호·전화번호 꼴)는 끝 4자리만 남긴다. */
export function maskLongDigits(s: string): string {
  return s.replace(/\d[\d\- ]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 8) return m;
    return `***${digits.slice(-4)}`;
  });
}

const CORP_MARKS = /\(주\)|㈜|\(유\)|\(사\)|\(재\)|\(합\)|주식회사|유한회사|사단법인|재단법인|사회복지법인/g;

/**
 * 매칭용 이름 키. 공백·괄호·"(주)" 같은 법인 표기·기호를 지우고, 괄호 안 메모("홍길동(후원)")는 뺀다.
 * 괄호 안만 남는 경우("(홍길동)")는 괄호 기호만 지운다.
 */
export function depositorKey(name: string): string {
  let s = (name ?? '').normalize('NFC').replace(CORP_MARKS, '');
  const noParen = s.replace(/[(\[{<（［【][^)\]}>）］】]*[)\]}>）］】]/g, '');
  s = noParen.trim() ? noParen : s;
  return s.replace(/[\s()\[\]{}<>（）［］【】.,·\-_/\\'"`~!@#$%^&*+=|:;?]/g, '').toLowerCase();
}

export interface ParsedDeposit {
  /** 파일 줄 번호(1부터) */
  line: number;
  occurredAt: Date;
  timeKnown: boolean;
  name: string;
  key: string;
  memo: string | null;
  amount: bigint;
  balance: bigint | null;
}

export interface ParseResult {
  deposits: ParsedDeposit[];
  /** 출금·0원 행 */
  skipped: number;
  errors: Array<{ line: number; reason: string }>;
  /** 입금 행이 상한을 넘음 */
  tooMany: boolean;
  periodFrom: Date | null;
  periodTo: Date | null;
}

const cell = (row: string[], i: number | undefined) => (i === undefined ? '' : (row[i] ?? '').trim());

/** 표(줄×칸)를 열 지정대로 읽는다. 출금 행·합계 줄·빈 줄은 버린다. */
export function parseStatementRows(rows: string[][], mapping: ColumnMapping): ParseResult {
  const out: ParseResult = { deposits: [], skipped: 0, errors: [], tooMany: false, periodFrom: null, periodTo: null };
  for (let i = mapping.header + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const line = i + 1;
    if (!row.some((c) => (c ?? '').trim())) continue;
    const dateRaw = cell(row, mapping.date);
    const inRaw = cell(row, mapping.amountIn);
    const amountIn = parseWon(inRaw);
    const amountOut = parseWon(cell(row, mapping.amountOut));
    const when = parseKstDateTime(dateRaw, mapping.time !== undefined ? cell(row, mapping.time) : undefined);
    if (!when) {
      // 합계·안내 줄(날짜 칸이 비었거나 글자)은 오류로 세지 않고 건너뛴다.
      if (!dateRaw || !/\d/.test(dateRaw)) {
        out.skipped += 1;
        continue;
      }
      out.errors.push({ line, reason: '거래일시를 읽을 수 없음' });
      continue;
    }
    if (amountIn === null) {
      out.errors.push({ line, reason: '입금액을 읽을 수 없음' });
      continue;
    }
    if (amountIn <= 0n || (amountOut !== null && amountOut > 0n)) {
      out.skipped += 1; // 출금 행·0원
      continue;
    }
    const rawName = maskLongDigits(cell(row, mapping.name) || cell(row, mapping.memo)).slice(0, 40).trim();
    const memoRaw = mapping.name !== undefined ? cell(row, mapping.memo) : '';
    const balance = mapping.balance !== undefined ? parseWon(cell(row, mapping.balance)) : null;
    if (out.deposits.length >= DEPOSIT_MAX_ROWS) {
      out.tooMany = true;
      break;
    }
    out.deposits.push({
      line,
      occurredAt: when.at,
      timeKnown: when.timeKnown,
      name: rawName || '(입금자 없음)',
      key: depositorKey(rawName),
      memo: memoRaw ? maskLongDigits(memoRaw).slice(0, 60) : null,
      amount: amountIn,
      balance: balance ?? null,
    });
    if (!out.periodFrom || when.at < out.periodFrom) out.periodFrom = when.at;
    if (!out.periodTo || when.at > out.periodTo) out.periodTo = when.at;
  }
  return out;
}

/** 열 지정 폼 값 → ColumnMapping (빈 값은 없음, 숫자가 아니면 null) */
export function mappingFromForm(get: (k: string) => string): ColumnMapping | null {
  const num = (k: string) => {
    const v = get(k).trim();
    if (v === '') return undefined;
    return /^\d{1,3}$/.test(v) ? Number(v) : NaN;
  };
  const header = num('map_header');
  const date = num('map_date');
  const amountIn = num('map_in');
  if (header === undefined || date === undefined || amountIn === undefined) return null;
  const m: ColumnMapping = {
    header,
    date,
    amountIn,
    time: num('map_time'),
    amountOut: num('map_out'),
    name: num('map_name'),
    memo: num('map_memo'),
    balance: num('map_balance'),
  };
  if (Object.values(m).some((v) => typeof v === 'number' && Number.isNaN(v))) return null;
  return m;
}
