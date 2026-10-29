import { prisma } from '@/server/db';
import type { ChargeProduct, MerchantShippingPolicy } from '@/generated/prisma/client';
import type { DigitalProductType, FulfillmentMode, ProductKind } from '@/generated/prisma/enums';

/**
 * 상품과 배송비.
 *
 * 상품은 두 종류다.
 *  - 비실물(DIGITAL) : 후원금 · 상품권 · 이용권 · 컨텐츠. 배송이 없고 재고도 세지 않는다.
 *  - 실물(PHYSICAL)  : 배송비 · 조건부 무료 · 재고 · 옵션 · 반품/교환을 관리한다.
 *
 * **배송비 계산은 반드시 이 파일의 함수 하나만 쓴다.**
 * 화면에서 보여준 금액과 서버가 실제로 청구한 금액이 다르면 그대로 결제 분쟁이 된다.
 * 그래서 상품 선택 화면·확정 로직·주문 조회가 모두 같은 함수를 부른다.
 */

/** 배송정책이 없을 때 쓰는 기본값. 화면과 계산이 같은 값을 보게 한 곳에 둔다. */
export const DEFAULT_SHIPPING = {
  baseFee: 3000n,
  freeOver: null as bigint | null,
  remoteFee: 0n,
  dispatchDays: 2,
  returnFee: 0n,
  exchangeFee: 0n,
} as const;

export interface ShippingPolicyView {
  baseFee: bigint;
  freeOver: bigint | null;
  remoteFee: bigint;
  carrier: string | null;
  guide: string | null;
  /** 결제 후 출고까지 걸리는 기본 영업일 */
  dispatchDays: number;
  /** 기본 반품 배송비(편도) */
  returnFee: bigint;
  /** 기본 교환 배송비(왕복) */
  exchangeFee: bigint;
  returnReceiver: string | null;
  returnPhone: string | null;
  returnZipCode: string | null;
  returnAddress: string | null;
}

export function shippingPolicyOf(row: MerchantShippingPolicy | null): ShippingPolicyView {
  return {
    baseFee: row?.baseFee ?? DEFAULT_SHIPPING.baseFee,
    freeOver: row?.freeOver ?? DEFAULT_SHIPPING.freeOver,
    remoteFee: row?.remoteFee ?? DEFAULT_SHIPPING.remoteFee,
    carrier: row?.carrier ?? null,
    guide: row?.guide ?? null,
    dispatchDays: row?.dispatchDays ?? DEFAULT_SHIPPING.dispatchDays,
    returnFee: row?.returnFee ?? DEFAULT_SHIPPING.returnFee,
    exchangeFee: row?.exchangeFee ?? DEFAULT_SHIPPING.exchangeFee,
    returnReceiver: row?.returnReceiver ?? null,
    returnPhone: row?.returnPhone ?? null,
    returnZipCode: row?.returnZipCode ?? null,
    returnAddress: row?.returnAddress ?? null,
  };
}

export async function loadShippingPolicy(merchantId: string): Promise<ShippingPolicyView> {
  const row = await prisma.merchantShippingPolicy.findUnique({ where: { merchantId } });
  return shippingPolicyOf(row);
}

/** 배송비 계산에 필요한 상품 값만 추린 것 (Prisma 행을 그대로 넘겨도 된다) */
export interface ShippingProductInput {
  kind: ProductKind;
  amount: bigint;
  shippingFee: bigint | null;
  freeShipOver: bigint | null;
  freeShipping: boolean;
}

export interface ShippingQuote {
  /** 상품 가격 합계 (배송비 제외, 옵션 추가금 포함) */
  goods: bigint;
  /** 청구할 배송비 */
  fee: bigint;
  /** 도서산간 추가분 (fee 에 이미 포함되어 있다. 표시용) */
  remoteExtra: bigint;
  /** 총 결제 금액 = goods + fee */
  total: bigint;
  /** 무료배송이 적용된 이유 (없으면 null) */
  freeReason: '무료배송 상품' | '조건부 무료' | null;
  /** 얼마를 더 담으면 무료가 되는지 (조건부 무료가 있고 아직 못 미쳤을 때만) */
  freeShortfall: bigint | null;
}

/**
 * 실물 상품 1종 주문의 배송비를 계산한다.
 *
 * 우선순위
 *  1. 상품이 '항상 무료배송' 이면 0원.
 *  2. 조건부 무료 기준(상품값 → 없으면 사회복지기관 정책)을 상품가 합계가 넘으면 0원.
 *  3. 그 외에는 상품 배송비(없으면 사회복지기관 기본 배송비).
 *  4. 도서산간이면 위 결과에 추가 배송비를 더한다.
 *     (무료배송이어도 도서산간 추가분은 붙는다 — 실제 택배 요금 구조와 같다)
 *
 * @param addPricePerUnit 후원자가 고른 옵션값의 추가금 합계(1개당). 조건부 무료 판정에도 포함된다.
 */
export function quoteShipping(
  product: ShippingProductInput,
  quantity: number,
  policy: ShippingPolicyView,
  remote = false,
  addPricePerUnit: bigint = 0n,
): ShippingQuote {
  const qty = BigInt(Math.max(1, quantity));
  const goods = (product.amount + addPricePerUnit) * qty;

  // 비실물은 배송 자체가 없다.
  if (product.kind !== 'PHYSICAL') {
    return { goods, fee: 0n, remoteExtra: 0n, total: goods, freeReason: null, freeShortfall: null };
  }

  const remoteExtra = remote ? policy.remoteFee : 0n;
  const freeOver = product.freeShipOver ?? policy.freeOver;

  if (product.freeShipping) {
    return {
      goods,
      fee: remoteExtra,
      remoteExtra,
      total: goods + remoteExtra,
      freeReason: '무료배송 상품',
      freeShortfall: null,
    };
  }

  if (freeOver !== null && goods >= freeOver) {
    return {
      goods,
      fee: remoteExtra,
      remoteExtra,
      total: goods + remoteExtra,
      freeReason: '조건부 무료',
      freeShortfall: null,
    };
  }

  const base = product.shippingFee ?? policy.baseFee;
  return {
    goods,
    fee: base + remoteExtra,
    remoteExtra,
    total: goods + base + remoteExtra,
    freeReason: null,
    freeShortfall: freeOver !== null ? freeOver - goods : null,
  };
}

/** 상품·정책을 합쳐 실제로 적용되는 배송/반품 조건을 만든다. */
export function effectiveDelivery(
  p: Pick<ChargeProduct, 'dispatchDays' | 'returnFee' | 'exchangeFee'>,
  policy: ShippingPolicyView,
) {
  return {
    dispatchDays: p.dispatchDays ?? policy.dispatchDays,
    returnFee: p.returnFee ?? policy.returnFee,
    exchangeFee: p.exchangeFee ?? policy.exchangeFee,
  };
}

// ---------------------------------------------------------------------------
// 옵션
// ---------------------------------------------------------------------------

/**
 * 옵션값 하나.
 *
 * 재고는 **상품 단위로만** 센다. 옵션값별 수량 재고를 두면 결제 승인 시점에
 * JSON 안의 숫자를 트랜잭션으로 깎아야 하는데, 그 경로가 이중결제 방어와
 * 얽혀 있어 지금 구조에서는 위험하다. 대신 옵션값 하나만 막을 수 있도록
 * soldOut 플래그를 둔다(사회복지기관이 직접 켜고 끈다).
 */
export interface ProductOptionValue {
  label: string;
  /** 이 값을 고르면 상품 1개 가격에 더해지는 금액 */
  addPrice: bigint;
  /** 이 값만 품절 처리 */
  soldOut: boolean;
}

export interface ProductOption {
  name: string;
  values: ProductOptionValue[];
}

/** 옵션 종류·값 상한. 화면 안내와 검증이 같은 값을 보게 한 곳에 둔다. */
export const OPTION_LIMIT = { groups: 3, values: 30 } as const;

function toOptionValue(raw: unknown): ProductOptionValue | null {
  // 구 형식: 값이 그냥 문자열
  if (typeof raw === 'string') {
    const label = raw.trim();
    return label ? { label: label.slice(0, 30), addPrice: 0n, soldOut: false } : null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as { label?: unknown; value?: unknown; addPrice?: unknown; soldOut?: unknown };
  const label = String(o.label ?? o.value ?? '').trim();
  if (!label) return null;
  let addPrice = 0n;
  try {
    const n = BigInt(String(o.addPrice ?? '0').replace(/[^\d-]/g, '') || '0');
    if (n >= 0n && n <= 10_000_000n) addPrice = n;
  } catch {
    addPrice = 0n;
  }
  return { label: label.slice(0, 30), addPrice, soldOut: o.soldOut === true };
}

/**
 * 상품 옵션 JSON 을 안전하게 읽는다.
 *
 * DB 의 Json 컬럼은 어떤 모양이든 들어올 수 있으므로(과거 데이터·수기 수정),
 * 모양이 맞지 않으면 예외를 던지지 말고 빈 배열로 떨어뜨린다.
 * 여기서 throw 하면 상품 하나 때문에 결제 화면 전체가 뜨지 않는다.
 */
export function parseOptions(raw: unknown): ProductOption[] {
  if (!Array.isArray(raw)) return [];
  const out: ProductOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as { name?: unknown }).name ?? '').trim();
    const values = (item as { values?: unknown }).values;
    if (!name || !Array.isArray(values)) continue;
    const list = values
      .map(toOptionValue)
      .filter((v): v is ProductOptionValue => v !== null)
      .slice(0, OPTION_LIMIT.values);
    if (list.length === 0) continue;
    out.push({ name: name.slice(0, 20), values: list });
    if (out.length >= OPTION_LIMIT.groups) break;
  }
  return out;
}

/**
 * 옵션 편집기가 보내는 JSON 문자열을 옵션 정의로 바꾼다.
 * 형식이 깨져 있으면 빈 배열을 돌려주고, 호출부가 여러 줄 입력으로 되돌아간다.
 */
export function parseOptionsJson(text: string): ProductOption[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    return parseOptions(JSON.parse(trimmed));
  } catch {
    return [];
  }
}

/**
 * "사이즈:S,M,L" 형태의 입력 여러 줄을 옵션 정의로 바꾼다.
 * 옵션 편집기를 쓰지 못하는 환경(자바스크립트 비활성)의 대비 입력이다.
 */
export function parseOptionLines(text: string): ProductOption[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, OPTION_LIMIT.groups);
  const out: ProductOption[] = [];
  for (const line of lines) {
    const [rawName, rawValues] = line.split(':');
    const name = (rawName ?? '').trim();
    const values = (rawValues ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, OPTION_LIMIT.values)
      .map((label) => ({ label: label.slice(0, 30), addPrice: 0n, soldOut: false }));
    if (!name || values.length === 0) continue;
    out.push({ name: name.slice(0, 20), values });
  }
  return out;
}

/** 옵션 정의를 편집 화면의 여러 줄 텍스트로 되돌린다(값 이름만). */
export function optionsToLines(raw: unknown): string {
  return parseOptions(raw)
    .map((o) => `${o.name}: ${o.values.map((v) => v.label).join(', ')}`)
    .join('\n');
}

/** 옵션 정의를 편집기가 읽는 JSON 문자열로 되돌린다. */
export function optionsToJson(raw: unknown): string {
  const defs = parseOptions(raw);
  if (defs.length === 0) return '';
  return JSON.stringify(
    defs.map((o) => ({
      name: o.name,
      values: o.values.map((v) => ({ label: v.label, addPrice: v.addPrice.toString(), soldOut: v.soldOut })),
    })),
  );
}

/** 저장용 JSON(BigInt 를 문자열로 낮춘 형태) */
export function optionsToStorage(defs: ProductOption[]) {
  return defs.map((o) => ({
    name: o.name,
    values: o.values.map((v) => ({ label: v.label, addPrice: v.addPrice.toString(), soldOut: v.soldOut })),
  }));
}

/**
 * 후원자가 고른 옵션이 상품 정의에 있는 값인지 확인하고, 표기 문자열로 만든다.
 * 정의에 없는 값이나 품절 처리된 값이 들어오면(폼 조작) 거절한다.
 */
export function buildOptionText(
  raw: unknown,
  selected: Record<string, string>,
): { ok: true; text: string | null } | { ok: false; message: string } {
  const defs = parseOptions(raw);
  if (defs.length === 0) return { ok: true, text: null };

  const parts: string[] = [];
  for (const def of defs) {
    const picked = (selected[def.name] ?? '').trim();
    if (!picked) return { ok: false, message: `${def.name} 을(를) 선택해 주세요.` };
    const found = def.values.find((v) => v.label === picked);
    if (!found) return { ok: false, message: `${def.name} 선택값이 올바르지 않습니다.` };
    if (found.soldOut) return { ok: false, message: `${def.name} - ${picked} 은(는) 품절입니다.` };
    parts.push(`${def.name}: ${picked}`);
  }
  return { ok: true, text: parts.join(' / ') };
}

/**
 * 후원자가 고른 옵션값의 추가금 합계(상품 1개당).
 *
 * 화면이 보낸 금액을 믿으면 폼을 고쳐 추가금을 0원으로 만들 수 있으므로,
 * 결제 확정 경로는 반드시 이 함수로 다시 계산한다.
 */
export function optionAddPrice(raw: unknown, selected: Record<string, string>): bigint {
  let sum = 0n;
  for (const def of parseOptions(raw)) {
    const picked = (selected[def.name] ?? '').trim();
    const found = def.values.find((v) => v.label === picked);
    if (found) sum += found.addPrice;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// 상품정보 제공 고시 (전자상거래법)
// ---------------------------------------------------------------------------

/**
 * 실물 상품에 표시해야 하는 품목별 고지 항목.
 *
 * 전자상거래 등에서의 상품 등의 정보제공에 관한 고시를 따른다.
 * 모든 품목을 담지 않고 사회복지기관이 실제로 파는 범위만 두되, 해당 없으면 '기타 재화' 를 쓴다.
 */
export const NOTICE_CATEGORIES = [
  {
    key: 'ETC',
    label: '기타 재화',
    items: ['품명 및 모델명', '법에 의한 인증·허가 등', '제조국 또는 원산지', '제조자', 'A/S 책임자와 전화번호'],
  },
  {
    key: 'FASHION',
    label: '의류 · 패션잡화',
    items: ['제품 소재', '색상', '치수', '제조자', '제조국', '세탁방법 및 취급 주의사항', '품질보증기준', 'A/S 책임자와 전화번호'],
  },
  {
    key: 'FOOD',
    label: '가공식품',
    items: ['제품명', '식품의 유형', '생산자 및 소재지', '제조연월일 및 유통기한', '포장단위별 내용물의 용량', '원재료명 및 함량', '영양성분', '수입식품 문구', '소비자상담 전화번호'],
  },
  {
    key: 'COSMETIC',
    label: '화장품',
    items: ['용량 또는 중량', '제품 주요 사양', '사용기한 또는 개봉 후 사용기간', '사용방법', '제조업자·책임판매업자', '제조국', '주요 성분', '기능성 화장품 심사필 여부', '사용할 때 주의사항', '소비자상담 전화번호'],
  },
  {
    key: 'DIGITAL_DEVICE',
    label: '가전 · 디지털기기',
    items: ['품명 및 모델명', 'KC 인증정보', '정격전압·소비전력', '동일모델 출시년월', '제조자', '제조국', '품질보증기준', 'A/S 책임자와 전화번호'],
  },
  {
    key: 'GOODS',
    label: '문구 · 굿즈 · 생활용품',
    items: ['품명 및 모델명', '재질', '동일모델 출시년월', '제조자', '제조국', '취급 주의사항', 'A/S 책임자와 전화번호'],
  },
] as const;

export type NoticeCategoryKey = (typeof NOTICE_CATEGORIES)[number]['key'];

export interface NoticeInfo {
  category: NoticeCategoryKey;
  items: Array<{ label: string; value: string }>;
}

export function noticeCategoryOf(key: string) {
  return NOTICE_CATEGORIES.find((c) => c.key === key) ?? NOTICE_CATEGORIES[0];
}

/** 고시 JSON 을 안전하게 읽는다. 모양이 깨져 있으면 null. */
export function parseNoticeInfo(raw: unknown): NoticeInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { category?: unknown; items?: unknown };
  const category = noticeCategoryOf(String(o.category ?? '')).key;
  if (!Array.isArray(o.items)) return null;
  const items: NoticeInfo['items'] = [];
  for (const it of o.items) {
    if (!it || typeof it !== 'object') continue;
    const label = String((it as { label?: unknown }).label ?? '').trim();
    const value = String((it as { value?: unknown }).value ?? '').trim();
    if (!label) continue;
    items.push({ label: label.slice(0, 40), value: value.slice(0, 200) });
  }
  return items.length > 0 ? { category, items } : null;
}

/** 고시에서 아직 안 채운 항목 이름들. 저장은 막지 않고 화면에서 경고만 한다. */
export function noticeMissing(info: NoticeInfo | null): string[] {
  if (!info) return [...noticeCategoryOf('ETC').items];
  const filled = new Map(info.items.map((i) => [i.label, i.value]));
  return noticeCategoryOf(info.category).items.filter((label) => !(filled.get(label) ?? '').trim());
}

// ---------------------------------------------------------------------------
// 추가 이미지
// ---------------------------------------------------------------------------

/** 상품 추가 이미지 최대 장수 */
export const MAX_EXTRA_IMAGES = 5;

export function parseImages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => String(v ?? '').trim())
    .filter((v) => v.length > 0 && v.length <= 500)
    .slice(0, MAX_EXTRA_IMAGES);
}

// ---------------------------------------------------------------------------
// 표기
// ---------------------------------------------------------------------------

export const productKindLabel: Record<ProductKind, string> = {
  DIGITAL: '비실물(컨텐츠)',
  PHYSICAL: '실물',
  DOCUMENT: '문서(약정서·주문서)',
};

/** 좁은 자리(뱃지 등)에 쓰는 짧은 표기 */
export const productKindShort: Record<ProductKind, string> = {
  DIGITAL: '비실물',
  PHYSICAL: '실물',
  DOCUMENT: '문서',
};

export const digitalTypeLabel: Record<DigitalProductType, string> = {
  POINT: '후원금',
  VOUCHER: '상품권',
  PASS: '이용권',
  CONTENT: '컨텐츠',
};

export const fulfillmentLabel: Record<FulfillmentMode, { text: string; hint: string }> = {
  MANUAL: {
    text: '사회복지기관 수동 지급',
    hint: '결제가 끝나면 판매 내역에서 사회복지기관이 직접 지급 처리합니다.',
  },
  API: {
    text: '연동 API 자동 지급',
    hint: '사회복지기관 서버가 연동 API 로 결제 건을 가져가 회원에게 자동 적립합니다.',
  },
  INSTANT: {
    text: '결제 즉시 문자 발급',
    hint: '결제가 끝나는 즉시 아래 안내 문구를 문자로 보냅니다. 코드·다운로드 주소를 적어 두세요.',
  },
};

/** 지급 수량 안내 문구. 후원금는 금액과 1:1 이 기본이다. */
export function giveText(p: Pick<ChargeProduct, 'kind' | 'digitalType' | 'amount' | 'giveAmount' | 'giveUnit' | 'validDays'>): string | null {
  if (p.kind !== 'DIGITAL') return null;
  const unit =
    p.giveUnit?.trim() ||
    (p.digitalType === 'POINT' ? '후원금' : p.digitalType === 'VOUCHER' ? '매' : p.digitalType === 'PASS' ? '개월' : '개');
  const value = p.giveAmount ?? (p.digitalType === 'POINT' ? p.amount : null);
  if (value === null) return null;
  const base = `${value.toLocaleString('ko-KR')}${unit}`;
  return p.validDays ? `${base} (유효기간 ${p.validDays}일)` : base;
}

/** 재고 표기. null 이면 무제한이라 문구를 만들지 않는다. */
export function stockText(p: Pick<ChargeProduct, 'kind' | 'stock'>): string | null {
  if (p.kind !== 'PHYSICAL' || p.stock === null) return null;
  return p.stock <= 0 ? '품절' : `재고 ${p.stock.toLocaleString('ko-KR')}개`;
}
