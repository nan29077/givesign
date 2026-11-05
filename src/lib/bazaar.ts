/**
 * 라이브 바자회 공용 상수·순수 계산.
 *
 * 서버·클라이언트 양쪽에서 import 하므로 DB·암호화 같은 서버 전용 코드를 넣지 않는다.
 * 상태값은 DB 에 문자열로 저장하고 여기서만 정의한다.
 */

// ---------------------------------------------------------------- 기부자
export const DONOR_TYPES = ['CORPORATE', 'INDIVIDUAL'] as const;
export type DonorType = (typeof DONOR_TYPES)[number];
export const donorTypeLabel: Record<DonorType, string> = { CORPORATE: '기업', INDIVIDUAL: '개인' };

// ---------------------------------------------------------------- 기부 상태
export const DONATION_STATUS = {
  SUBMITTED: 'SUBMITTED', // 접수(운영 검토·매칭 대기)
  MATCH_PROPOSED: 'MATCH_PROPOSED', // 기관에 매칭 제안됨
  VALUATING: 'VALUATING', // 기관 수락, 가액 협의 중
  VALUE_CONFIRMED: 'VALUE_CONFIRMED', // 가액 확정, 약정서 동의 대기
  PLEDGED: 'PLEDGED', // 약정 완료, 발송·입고 대기
  INSPECTED: 'INSPECTED', // 입고·검수 등록, 기관 검수 확정 대기
  RECEIPTED: 'RECEIPTED', // 기관 검수 확정·영수증 발급 완료(판매 준비)
  ON_SALE: 'ON_SALE', // 판매 중
  SALE_ENDED: 'SALE_ENDED', // 판매 종료(잔여 처리)
  CLOSED: 'CLOSED', // 종결
  CANCELED: 'CANCELED', // 취소
  RETURNED: 'RETURNED', // 검수 불합격 반송·폐기
} as const;
export type DonationStatus = (typeof DONATION_STATUS)[keyof typeof DONATION_STATUS];

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';
export const donationStatusLabel: Record<DonationStatus, { text: string; tone: Tone }> = {
  SUBMITTED: { text: '접수', tone: 'neutral' },
  MATCH_PROPOSED: { text: '기관 매칭 중', tone: 'brand' },
  VALUATING: { text: '가액 협의', tone: 'warning' },
  VALUE_CONFIRMED: { text: '약정 대기', tone: 'warning' },
  PLEDGED: { text: '발송·입고 대기', tone: 'brand' },
  INSPECTED: { text: '검수 확정 대기', tone: 'warning' },
  RECEIPTED: { text: '영수증 발급', tone: 'success' },
  ON_SALE: { text: '판매 중', tone: 'success' },
  SALE_ENDED: { text: '판매 종료', tone: 'neutral' },
  CLOSED: { text: '종결', tone: 'neutral' },
  CANCELED: { text: '취소', tone: 'danger' },
  RETURNED: { text: '반송·폐기', tone: 'danger' },
};

/** 타임라인에 그리는 정상 흐름 순서 */
export const DONATION_FLOW: DonationStatus[] = [
  'SUBMITTED',
  'MATCH_PROPOSED',
  'VALUATING',
  'VALUE_CONFIRMED',
  'PLEDGED',
  'INSPECTED',
  'RECEIPTED',
  'ON_SALE',
  'SALE_ENDED',
  'CLOSED',
];

/** 기부자가 스스로 취소할 수 있는 단계(약정 전) */
export const DONOR_CANCELABLE: DonationStatus[] = ['SUBMITTED', 'MATCH_PROPOSED', 'VALUATING', 'VALUE_CONFIRMED'];
/** 관리자가 취소할 수 있는 단계(영수증 발급 전) */
export const ADMIN_CANCELABLE: DonationStatus[] = [...DONOR_CANCELABLE, 'PLEDGED', 'INSPECTED'];

export const MATCH_MODES = ['DESIGNATED', 'RECOMMEND', 'ANY'] as const;
export const matchModeLabel: Record<string, string> = { DESIGNATED: '기관 지정', RECOMMEND: '추천 받기', ANY: '상관없음' };
export const UNSOLD_ACTIONS = ['MERCHANT_USE', 'TRANSFER', 'RETURN'] as const;
export const unsoldActionLabel: Record<string, string> = {
  MERCHANT_USE: '기관이 직접 사용',
  TRANSFER: '다른 기관으로 이관',
  RETURN: '기부자에게 반환',
  DISPOSE: '폐기',
};
export const DELIVERY_METHODS = ['SEND', 'PICKUP'] as const;
export const deliveryMethodLabel: Record<string, string> = { SEND: '창고로 직접 발송', PICKUP: '수거 요청' };
export const ITEM_CONDITIONS = ['NEW', 'UNOPENED', 'LIKE_NEW', 'USED'] as const;
export const itemConditionLabel: Record<string, string> = {
  NEW: '새 상품',
  UNOPENED: '미개봉',
  LIKE_NEW: '사용감 적음',
  USED: '사용감 있음',
};
export const ITEM_CATEGORIES = ['생활용품', '식품', '의류·잡화', '주방', '가전·디지털', '도서·문구', '유아·완구', '화장품·미용', '기타'] as const;

/**
 * 판매·기부 접수 금지 품목. 기관이 판매자(위탁자)가 되므로 영업신고·인증이 필요한 품목은 받지 않는다.
 * 품명·분류에 아래 단어가 들어가면 접수 단계에서 막는다(운영자가 최종 검토).
 */
export const BLOCKED_KEYWORDS = [
  '건강기능식품', '의약품', '약품', '주류', '술', '담배', '전자담배', '의료기기', '총', '도검', '농약', '반려동물 사료', '중고 속옷',
  // 주류(2026-11-06 점검 낮음): 품명에 술 종류만 적는 경우가 많다.
  '소주', '맥주', '와인', '위스키', '막걸리', '보드카', '전통주', '사케', '고량주', '샴페인', '브랜디', '리큐르', '데킬라', '하이볼',
];
/** 금지어가 들어 있어도 술 자체가 아닌 용품(잔·오프너 등)은 막지 않는다. */
const BLOCKED_KEYWORD_EXCEPTIONS = ['와인잔', '와인글라스', '와인오프너', '와인셀러', '와인랙', '맥주잔', '맥주컵', '소주잔', '위스키잔', '하이볼잔', '샴페인잔'];

export function blockedKeyword(text: string): string | null {
  let t = text.replace(/\s+/g, '');
  for (const ex of BLOCKED_KEYWORD_EXCEPTIONS) t = t.split(ex).join('|');
  for (const k of BLOCKED_KEYWORDS) {
    const kk = k.replace(/\s+/g, '');
    if (kk.length <= 1) {
      // 한 글자 단어는 품명 전체가 그 단어일 때만 막는다(예: '술')
      if (t === kk) return k;
      continue;
    }
    if (t.includes(kk)) return k;
  }
  return null;
}

// ---------------------------------------------------------------- 매칭·참여
export const matchStatusLabel: Record<string, { text: string; tone: Tone }> = {
  PROPOSED: { text: '제안', tone: 'brand' },
  ACCEPTED: { text: '수락', tone: 'success' },
  REJECTED: { text: '거절', tone: 'danger' },
  EXPIRED: { text: '기한 만료', tone: 'neutral' },
  WITHDRAWN: { text: '철회', tone: 'neutral' },
};
export const participationLabel: Record<string, { text: string; tone: Tone }> = {
  APPLIED: { text: '승인 대기', tone: 'warning' },
  APPROVED: { text: '참여 중', tone: 'success' },
  REJECTED: { text: '반려', tone: 'danger' },
  SUSPENDED: { text: '정지', tone: 'danger' },
};
/** 위탁판매 동의서 판 번호. 문구를 바꾸면 올린다. */
export const CONSIGNMENT_VERSION = '2026-11-05';
export const CONSIGNMENT_TEXT = [
  '기관은 라이브 바자회로 기부받은 물품의 판매를 기브싸인 운영사에 위탁합니다(위탁판매).',
  '판매는 기브싸인 소속 셀러가 셀러브릭스 라이브 방송으로 진행하며, 상품 설명에 위탁판매 사실과 기관명을 표기합니다.',
  '판매 금액에서 수수료(설정된 요율, 기본 30%)와 기관 부담 반송비를 뺀 금액을 매월 1회 정산해 기관 계좌로 지급합니다.',
  '기부금영수증은 검수를 확정한 물품에 대해 기관 명의로 발급되며, 발급 가액은 기관과 기부자가 협의해 확정합니다.',
  '위탁판매에 따른 세금 처리는 기관과 운영사가 각각 세무 자문에 따라 처리합니다.',
];

// ---------------------------------------------------------------- 상품·편성·판매
export const productStatusLabel: Record<string, { text: string; tone: Tone }> = {
  DRAFT: { text: '등록 대기', tone: 'warning' },
  LISTED: { text: '판매 중', tone: 'success' },
  ENDED: { text: '판매 종료', tone: 'neutral' },
};
export const liveStatusLabel: Record<string, { text: string; tone: Tone }> = {
  PROPOSED: { text: '승인 대기', tone: 'warning' },
  APPROVED: { text: '승인', tone: 'success' },
  REJECTED: { text: '반려', tone: 'danger' },
  DONE: { text: '방송 완료', tone: 'neutral' },
  CANCELED: { text: '취소', tone: 'neutral' },
};
export const batchStatusLabel: Record<string, { text: string; tone: Tone }> = {
  DRAFT: { text: '승인 대기', tone: 'warning' },
  APPROVED: { text: '승인(원장 반영)', tone: 'success' },
  REJECTED: { text: '반려', tone: 'danger' },
};
export const settlementStatusLabel: Record<string, { text: string; tone: Tone }> = {
  DRAFT: { text: '집계', tone: 'neutral' },
  CONFIRMED: { text: '확정(지급 대기)', tone: 'warning' },
  PAID: { text: '지급 완료', tone: 'success' },
  CARRIED: { text: '다음 달로 이월', tone: 'neutral' },
};
/** 가액 협의 이력 종류(화면에 영문 코드를 보이지 않는다) */
export const valuationKindLabel: Record<string, string> = { PROPOSE: '제안', COUNTER: '역제안', CONFIRM: '확정', ACCEPT: '수락', RECALC: '재계산' };
export const RETURN_BEARERS = ['NONE', 'MERCHANT', 'GIVESIGN'] as const;
export const returnBearerLabel: Record<string, string> = { NONE: '없음', MERCHANT: '기관 부담', GIVESIGN: '기브싸인 부담' };
export const ledgerTypeLabel: Record<string, string> = {
  SALE: '판매',
  REFUND: '환불',
  FEE: '수수료',
  RETURN_COST: '반송비(기관 부담)',
  PAYOUT: '지급',
  CARRY_IN: '전월 이월',
  CARRY_OUT: '다음 달로 이월',
};

/** 추적 코드: 셀러브릭스 상품명 앞에 붙인다. 6자리(1,000,000번째부터는 7자리 이상). */
export function trackingCode(n: number): string {
  return `GSB-${String(n).padStart(6, '0')}`;
}
/**
 * 문자열에서 추적 코드를 찾는다(파일 업로드의 상품명 열에서도 찾는다).
 * 숫자를 끝까지 읽는다 — 예전에는 6자리만 읽어 'GSB-0000012'·'GSB-000001 2'·'GSB-0000015개' 를 GSB-000001 로 잘못 맞췄다.
 * 앞뒤가 다른 영문·숫자에 붙어 있으면 코드로 보지 않는다(예: XGSB-000001).
 */
export function findTrackingCode(text: string): string | null {
  const m = /(?<![A-Za-z0-9])GSB-(\d{6,9})(?![\d])/i.exec(text);
  if (!m) return null;
  const digits = m[1];
  // 7자리 이상이면서 0으로 시작하면 정규 코드가 아니다(1,000,000 이상만 7자리).
  if (digits.length > 6 && digits.startsWith('0')) return null;
  return `GSB-${digits}`;
}
/** 추적 코드의 번호(정렬·다음 번호 계산용) */
export function trackingNumber(code: string): number {
  return Number(code.replace(/^GSB-/i, '')) || 0;
}

// ---------------------------------------------------------------- 설정
export interface BazaarConfig {
  /** 수수료 요율(퍼센트, 예: "30") */
  feeRatePercent: string;
  /** INCLUDED: 요율 안에 부가세 포함 / EXCLUDED: 요율 + 부가세 10% 별도 */
  feeVatMode: 'INCLUDED' | 'EXCLUDED';
  minSalePrice: number;
  defaultPerPersonLimit: number;
  matchDeadlineDays: number;
  /** 정산 지급일(익월 n일) */
  settlementPayDay: number;
  /** 기부 물품을 보낼 창고 주소(기부자 화면에 표시) */
  warehouseAddress: string;
  /** 셀러브릭스 상품 설명에 붙이는 위탁판매 표기 문구. {기관명} 은 기관 이름으로 바뀐다. */
  consignmentNotice: string;
}

export const DEFAULT_BAZAAR_CONFIG: BazaarConfig = {
  feeRatePercent: '30',
  feeVatMode: 'INCLUDED',
  minSalePrice: 5000,
  defaultPerPersonLimit: 5,
  matchDeadlineDays: 3,
  settlementPayDay: 10,
  warehouseAddress: '',
  consignmentNotice: '{기관명} 위탁판매 상품입니다. 판매 금액에서 수수료를 뺀 금액이 {기관명}에 귀속됩니다.',
};

/** 요율 입력: 0~90, 소수 둘째 자리까지. '1e1'·' 30'·'030.' 같은 꼴은 받지 않는다. */
export function isFeeRateString(v: unknown): v is string {
  return typeof v === 'string' && /^(0|[1-9]\d?)(\.\d{1,2})?$/.test(v) && Number(v) <= 90;
}

/** 운영 설정 입력 범위(화면 검증·저장 정규화 공용) */
export const BAZAAR_CONFIG_RANGES = {
  minSalePrice: { min: 100, max: 10_000_000, label: '최소 판매가', unit: '원' },
  defaultPerPersonLimit: { min: 1, max: 999, label: '1인 구매 제한', unit: '개' },
  matchDeadlineDays: { min: 1, max: 30, label: '매칭 수락 기한', unit: '일' },
  settlementPayDay: { min: 1, max: 28, label: '정산 지급일', unit: '일' },
} as const;

/** 범위를 벗어난 값을 기본값으로 바꾸지 않고 오류 문구로 돌려준다(저장 전 검증). */
export function validateConfigInput(v: Partial<Record<keyof BazaarConfig, unknown>>): string[] {
  const errors: string[] = [];
  if (!isFeeRateString(v.feeRatePercent)) errors.push('수수료 요율은 0~90 사이 숫자(소수 둘째 자리까지)로 입력해 주세요.');
  for (const [key, r] of Object.entries(BAZAAR_CONFIG_RANGES)) {
    const n = Number(v[key as keyof BazaarConfig]);
    if (!Number.isInteger(n) || n < r.min || n > r.max)
      errors.push(`${r.label}은(는) ${r.min.toLocaleString('ko-KR')}~${r.max.toLocaleString('ko-KR')}${r.unit} 사이 정수로 입력해 주세요.`);
  }
  if (typeof v.warehouseAddress === 'string' && v.warehouseAddress.length > 300) errors.push('창고 주소는 300자 이내로 입력해 주세요.');
  if (typeof v.consignmentNotice === 'string' && v.consignmentNotice.length > 300) errors.push('위탁판매 문구는 300자 이내로 입력해 주세요.');
  return errors;
}

export function normalizeConfig(raw: unknown): BazaarConfig {
  const v = (raw && typeof raw === 'object' ? raw : {}) as Partial<BazaarConfig>;
  const num = (x: unknown, d: number, min: number, max: number) => {
    const n = Number(x);
    return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : d;
  };
  return {
    // 저장은 정규형 문자열("30", "12.5")로. 지수 표기 등은 기본값(검증은 validateConfigInput 이 먼저 한다).
    feeRatePercent: isFeeRateString(v.feeRatePercent) ? String(Number(v.feeRatePercent)) : DEFAULT_BAZAAR_CONFIG.feeRatePercent,
    feeVatMode: v.feeVatMode === 'EXCLUDED' ? 'EXCLUDED' : 'INCLUDED',
    minSalePrice: num(v.minSalePrice, DEFAULT_BAZAAR_CONFIG.minSalePrice, 100, 10_000_000),
    defaultPerPersonLimit: num(v.defaultPerPersonLimit, DEFAULT_BAZAAR_CONFIG.defaultPerPersonLimit, 1, 999),
    matchDeadlineDays: num(v.matchDeadlineDays, DEFAULT_BAZAAR_CONFIG.matchDeadlineDays, 1, 30),
    settlementPayDay: num(v.settlementPayDay, DEFAULT_BAZAAR_CONFIG.settlementPayDay, 1, 28),
    warehouseAddress: typeof v.warehouseAddress === 'string' ? v.warehouseAddress.slice(0, 300) : '',
    consignmentNotice:
      typeof v.consignmentNotice === 'string' && v.consignmentNotice.trim()
        ? v.consignmentNotice.slice(0, 300)
        : DEFAULT_BAZAAR_CONFIG.consignmentNotice,
  };
}

// ---------------------------------------------------------------- 수수료 계산
/**
 * 순판매액(판매 - 환불)에 대한 수수료.
 *  - INCLUDED: fee = round(net × rate), 그 안에서 공급가액 = round(fee / 1.1), 부가세 = fee - 공급가액
 *  - EXCLUDED: 공급가액 = round(net × rate), 부가세 = round(공급가액 × 0.1), fee = 공급가액 + 부가세
 * 반환 fee 는 기관 귀속액에서 빠지는 총액이다. 순판매액이 음수(환불 초과)면 수수료도 음수(환입)다.
 */
export function computeFee(net: bigint, ratePercent: string, mode: 'INCLUDED' | 'EXCLUDED') {
  // 요율을 만분율 정수로 바꿔 부동소수 오차를 없앤다(30 → 3000, 12.5 → 1250).
  const bp = BigInt(Math.round(Number(ratePercent) * 100));
  const roundDiv = (a: bigint, b: bigint) => {
    const neg = a < 0n;
    const x = neg ? -a : a;
    const q = (x * 2n + b) / (2n * b);
    return neg ? -q : q;
  };
  if (mode === 'INCLUDED') {
    const fee = roundDiv(net * bp, 10000n);
    const supply = roundDiv(fee * 10n, 11n);
    return { fee, supply, vat: fee - supply };
  }
  const supply = roundDiv(net * bp, 10000n);
  const vat = roundDiv(supply, 10n);
  return { fee: supply + vat, supply, vat };
}

export type FeeRate = Pick<BazaarConfig, 'feeRatePercent' | 'feeVatMode'>;

/**
 * 판매 결과 한 줄의 기관 귀속 계산(미리보기·원장 반영 공용).
 * refundRate 를 주면 환불분 수수료 환입은 그 요율(원래 판매 때 요율)로 계산한다(점검 B-M3).
 * 판매·환불 요율이 같으면 예전과 같이 순판매액(판매-환불)에 한 번 계산한다(반올림 결과 동일 유지).
 * 반올림은 줄 단위다(월 합계 반올림과 원 단위 차이가 날 수 있음 — 결정 필요 항목, 2026-11-06 점검 낮음).
 */
export function settleLine(
  line: { grossAmount: bigint; refundAmount: bigint; returnCost: bigint; returnBearer: string },
  config: FeeRate,
  refundRate?: FeeRate | null,
) {
  const net = line.grossAmount - line.refundAmount;
  const rr = refundRate ?? config;
  let fee: bigint, supply: bigint, vat: bigint;
  if (rr.feeRatePercent === config.feeRatePercent && rr.feeVatMode === config.feeVatMode) {
    ({ fee, supply, vat } = computeFee(net, config.feeRatePercent, config.feeVatMode));
  } else {
    const a = computeFee(line.grossAmount, config.feeRatePercent, config.feeVatMode);
    const b = computeFee(line.refundAmount, rr.feeRatePercent, rr.feeVatMode);
    fee = a.fee - b.fee;
    supply = a.supply - b.supply;
    vat = a.vat - b.vat;
  }
  const returnCost = line.returnBearer === 'MERCHANT' ? line.returnCost : 0n;
  return { net, fee, supply, vat, returnCost, payout: net - fee - returnCost };
}

/** 저장된 판매 줄의 요율(승인 때 기록). 승인 전·기록 이전 줄은 현재 설정으로 본다. */
export function lineRates(
  line: { feeRatePercent?: string | null; feeVatMode?: string | null; refundFeeRatePercent?: string | null; refundFeeVatMode?: string | null },
  fallback: FeeRate,
): { sale: FeeRate; refund: FeeRate } {
  const mode = (v: string | null | undefined, d: FeeRate['feeVatMode']) => (v === 'EXCLUDED' ? 'EXCLUDED' : v === 'INCLUDED' ? 'INCLUDED' : d);
  const sale: FeeRate = { feeRatePercent: line.feeRatePercent ?? fallback.feeRatePercent, feeVatMode: mode(line.feeVatMode, fallback.feeVatMode) };
  const refund: FeeRate = { feeRatePercent: line.refundFeeRatePercent ?? sale.feeRatePercent, feeVatMode: mode(line.refundFeeVatMode, sale.feeVatMode) };
  return { sale, refund };
}

// ---------------------------------------------------------------- 월·날짜
/** KST 기준 YYYY-MM 의 다음 달 */
export function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
/** 정산 지급일: 정산 월의 다음 달 payDay 일(KST 날짜, DB @db.Date 용 UTC 자정) */
export function settlementDueDate(ym: string, payDay: number): Date {
  const [y, m] = nextMonth(ym).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, payDay));
}
export function isMonthKey(v: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

// ---------------------------------------------------------------- 판매 결과 파일(CSV)
/**
 * 판매 결과 업로드 양식.
 * 열: 추적코드(또는 상품명에 포함), 판매수량, 판매금액, 환불수량, 환불금액, 반송비, 반송비부담(기관/기브싸인/없음), 메모
 * 셀러브릭스 주문 화면을 옮겨 적거나 내려받은 표를 이 순서로 맞춰 올린다.
 */
export const SALE_CSV_HEADER = ['추적코드', '판매수량', '판매금액', '환불수량', '환불금액', '반송비', '반송비부담', '메모'] as const;

export interface ParsedSaleRow {
  line: number;
  trackingCode: string | null;
  soldQty: number;
  grossAmount: bigint;
  refundQty: number;
  refundAmount: bigint;
  returnCost: bigint;
  returnBearer: 'NONE' | 'MERCHANT' | 'GIVESIGN';
  note: string | null;
  error: string | null;
}

/** 따옴표를 지원하는 간단한 CSV 한 줄 분리 */
export function splitCsvLine(line: string): string[] {
  return splitCsvRecords(line)[0]?.cells ?? [''];
}

/**
 * CSV 전체를 레코드로 나눈다. 따옴표 안의 쉼표·줄바꿈("메모\n둘째 줄")을 지원한다.
 * line 은 레코드가 시작한 파일 줄 번호(1부터)다.
 */
export function splitCsvRecords(text: string): Array<{ line: number; cells: string[]; raw: string }> {
  const out: Array<{ line: number; cells: string[]; raw: string }> = [];
  let cells: string[] = [];
  let cur = '';
  let q = false;
  let line = 1;
  let startLine = 1;
  let raw = '';
  const flush = () => {
    cells.push(cur);
    out.push({ line: startLine, cells: cells.map((x) => x.trim()), raw });
    cells = [];
    cur = '';
    raw = '';
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cur += '"';
        raw += '""';
        i++;
        continue;
      }
      if (c === '"') q = false;
      else {
        if (c === '\n') line++;
        cur += c;
      }
      raw += c;
      continue;
    }
    if (c === '"') {
      q = true;
      raw += c;
    } else if (c === ',') {
      cells.push(cur);
      cur = '';
      raw += c;
    } else if (c === '\r' && text[i + 1] === '\n') {
      continue;
    } else if (c === '\n' || c === '\r') {
      flush();
      line++;
      startLine = line;
    } else {
      cur += c;
      raw += c;
    }
  }
  if (cur !== '' || cells.length || raw !== '') flush();
  return out;
}

/**
 * 업로드한 CSV 바이트를 글자로 바꾼다. UTF-8 로 읽어 깨진 글자(U+FFFD)가 나오면
 * 엑셀 기본 저장 형식(CP949 = WHATWG 'euc-kr')으로 다시 읽는다.
 */
export function decodeCsvBytes(bytes: Uint8Array): { text: string; encoding: 'utf-8' | 'cp949' } {
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  if (!utf8.includes('\uFFFD')) return { text: utf8, encoding: 'utf-8' };
  try {
    return { text: new TextDecoder('euc-kr').decode(bytes), encoding: 'cp949' };
  } catch {
    return { text: utf8, encoding: 'utf-8' };
  }
}

function toInt(v: string | undefined): number | null {
  const s = (v ?? '').replace(/[,\s원]/g, '');
  if (s === '') return 0;
  return /^\d{1,9}$/.test(s) ? Number(s) : null;
}
function toWon(v: string | undefined): bigint | null {
  const s = (v ?? '').replace(/[,\s원]/g, '');
  if (s === '') return 0n;
  return /^\d{1,15}$/.test(s) ? BigInt(s) : null;
}
function toBearer(v: string | undefined): 'NONE' | 'MERCHANT' | 'GIVESIGN' | null {
  const s = (v ?? '').trim();
  if (s === '' || s === '없음' || s.toUpperCase() === 'NONE') return 'NONE';
  if (s === '기관' || s === '기관 부담' || s.toUpperCase() === 'MERCHANT') return 'MERCHANT';
  if (s === '기브싸인' || s === '기브싸인 부담' || s.toUpperCase() === 'GIVESIGN') return 'GIVESIGN';
  return null;
}

export function parseSaleCsv(text: string): ParsedSaleRow[] {
  const records = splitCsvRecords(text.replace(/^\uFEFF/, ''));
  const rows: ParsedSaleRow[] = [];
  records.forEach(({ line, cells, raw }, idx) => {
    if (!raw.trim() || cells.every((c) => c === '')) return;
    // 머리줄은 건너뛴다. 첫 줄이라도 추적 코드가 있거나 둘째 칸이 숫자면 데이터 줄이다
    // (예전에는 '상품' 이 들어간 첫 데이터 줄을 머리줄로 보고 조용히 버렸다 — 2026-11-05 E2E 에서 발견).
    if (idx === 0 && !findTrackingCode(cells[0] ?? '') && !/^\s*[\d,]+\s*$/.test(cells[1] ?? '')) return;
    const code = findTrackingCode(cells[0] ?? '');
    const soldQty = toInt(cells[1]);
    const gross = toWon(cells[2]);
    const refundQty = toInt(cells[3]);
    const refund = toWon(cells[4]);
    const returnCost = toWon(cells[5]);
    const bearer = toBearer(cells[6]);
    let error: string | null = null;
    if (!code) error = '추적 코드(GSB-000000)가 없습니다. 셀러브릭스 임시상품이면 바자회 정산에서 제외됩니다.';
    // 열 개수가 다르면 따옴표 없는 "10,000" 처럼 칸이 밀린 것이다(점검 B-M5: 10원으로 조용히 들어가던 문제).
    else if (cells.length !== SALE_CSV_HEADER.length)
      error = `열이 ${cells.length}개입니다. ${SALE_CSV_HEADER.length}개 열(${SALE_CSV_HEADER.join(', ')})을 맞춰 주세요. 쉼표가 든 금액은 따옴표로 감싸거나 쉼표 없이 적어 주세요(예: 10000).`;
    else if (soldQty === null || gross === null || refundQty === null || refund === null || returnCost === null)
      error = '수량·금액은 숫자로 입력해 주세요.';
    else if (bearer === null) error = '반송비 부담은 기관 / 기브싸인 / 없음 중 하나로 입력해 주세요.';
    else if (soldQty === 0 && gross === 0n && refund === 0n && returnCost === 0n) error = '판매·환불·반송비가 모두 0 입니다.';
    else if ((soldQty > 0) !== (gross > 0n)) error = '판매 수량과 판매 금액은 함께 적어 주세요(한쪽만 0 일 수 없습니다).';
    else if (refundQty > 0 && refund === 0n) error = '환불 수량이 있으면 환불 금액을 적어 주세요.';
    // 환불은 이전에 승인된 판매에 대한 정정일 수 있다. 상품 누적 판매액을 넘는지·단가와 맞는지는 서비스가 확인한다.
    rows.push({
      line,
      trackingCode: code,
      soldQty: soldQty ?? 0,
      grossAmount: gross ?? 0n,
      refundQty: refundQty ?? 0,
      refundAmount: refund ?? 0n,
      returnCost: returnCost ?? 0n,
      returnBearer: bearer ?? 'NONE',
      note: (cells[7] ?? '').slice(0, 200) || null,
      error,
    });
  });
  return rows;
}

/**
 * 판매 금액이 수량 × 판매가와 크게 다르면 입력 실수로 본다(쉼표 밀림·자릿수 오타).
 * 할인·배송비·가격 변경을 감안해 수량 × 판매가의 절반 미만, 수량 × (판매가 + 배송비)의 2배 초과만 거절한다.
 */
export function amountMismatch(qty: number, amount: bigint, salePrice: bigint, shippingFee: bigint): boolean {
  if (qty <= 0) return false;
  const low = (BigInt(qty) * salePrice) / 2n;
  const high = BigInt(qty) * (salePrice + shippingFee) * 2n;
  return amount < low || amount > high;
}

/** 서버 액션 한 번에 올릴 수 있는 파일(사진·근거 합계). next.config.ts serverActions.bodySizeLimit 와 맞춘다. */
export const BAZAAR_UPLOAD_MAX_FILES = 6;
export const BAZAAR_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
/** 기부 건당 파일 상한 */
export const BAZAAR_FILES_PER_DONATION = 20;
/** 판매 결과 CSV 상한 */
export const BAZAAR_CSV_MAX_BYTES = 2 * 1024 * 1024;

/** 엑셀 수식 주입 방지 + 따옴표 이스케이프 */
export function csvCell(v: string | number | bigint | null | undefined): string {
  const s = v == null ? '' : String(v);
  const guarded = /^[=+\-@\t\r\n]/.test(s) ? `'${s}` : s;
  return /[",\n\r\t]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
export function toCsv(rows: Array<Array<string | number | bigint | null | undefined>>): string {
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function formatBizNo(v: string | null | undefined): string {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : (v ?? '');
}
