import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { formatNumber } from '@/lib/money';

/**
 * MT 문자 템플릿.
 * - 이모지를 사용하지 않는다.
 * - 최초 문자가 결제 처리되지 않았음을 명확히 고지한다.
 * - 보안 링크 원문은 로그/DB 본문에 남기지 않고 마스킹해 저장한다.
 */

export const MT_TEMPLATE = {
  REGISTER_GUIDE: 'REGISTER_GUIDE',
  CONFIRM_PAYMENT: 'CONFIRM_PAYMENT',
  SELECT_AMOUNT: 'SELECT_AMOUNT',
  PIN_REQUEST: 'PIN_REQUEST',
  CHARGE_SUCCESS: 'CHARGE_SUCCESS',
  CHARGE_FAILED: 'CHARGE_FAILED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  LIMIT_BLOCKED: 'LIMIT_BLOCKED',
  CONTENT_BLOCKED: 'CONTENT_BLOCKED',
  REFUND_DONE: 'REFUND_DONE',
  UNKNOWN_ROUTE: 'UNKNOWN_ROUTE',
  /** 결제내역 확인(비회원 조회) 인증번호 */
  LOOKUP_VERIFY: 'LOOKUP_VERIFY',
  /** 마이페이지 휴대폰 번호 연결 인증번호 */
  PHONE_LINK_VERIFY: 'PHONE_LINK_VERIFY',
  /** 결제 페이지 PC 웹 결제 인증번호 */
  PAYMENT_VERIFY: 'PAYMENT_VERIFY',
  /** 실물 주문 발송 안내(택배사·송장번호) */
  SHIPMENT_SENT: 'SHIPMENT_SENT',
  /** 비실물 상품 즉시 지급 안내(코드·다운로드 주소) */
  FULFILLMENT_INSTANT: 'FULFILLMENT_INSTANT',
  /** 문서 상품 작성 안내(약정서·주문서 작성 링크) */
  DOCUMENT_REQUEST: 'DOCUMENT_REQUEST',
  /**
   * 사회복지기관이 연동 API 로 직접 보내는 거래 안내 문자.
   * 본문은 사회복지기관이 등록해 검수받은 템플릿에서 나온다. 관리자 공통 문구로 덮어쓰지 않는다.
   */
  MERCHANT_NOTICE: 'MERCHANT_NOTICE',
  /** 정기후원 약정 완료 안내 */
  RECURRING_STARTED: 'RECURRING_STARTED',
  /** 정기후원 출금 실패 (재시도 예정) */
  RECURRING_FAILED: 'RECURRING_FAILED',
  /** 정기후원 연속 실패로 정지 */
  RECURRING_SUSPENDED: 'RECURRING_SUSPENDED',
  /** 기부금영수증 발급 안내 (열람 링크) */
  RECEIPT_ISSUED: 'RECEIPT_ISSUED',
  /** 전자문서 서명 요청(서명 링크) */
  EDOC_SIGN_REQUEST: 'EDOC_SIGN_REQUEST',
  /** 전자문서 서명 본인확인 인증번호 */
  EDOC_SIGN_VERIFY: 'EDOC_SIGN_VERIFY',
  /** 전자문서 서명 완료 안내 */
  EDOC_COMPLETED: 'EDOC_COMPLETED',
} as const;

export type MtTemplateCode = (typeof MT_TEMPLATE)[keyof typeof MT_TEMPLATE];

export interface TemplateOutput {
  code: MtTemplateCode;
  text: string;
  /** DB/로그 저장용. 링크 토큰을 제거한 본문 */
  masked: string;
  /**
   * 관리자 커스텀 본문(MtMessageTemplate)에 치환해 넣을 값.
   *
   * 이 값이 있는 템플릿만 관리자 화면에서 본문을 바꿀 수 있다.
   * 보안링크가 들어가는 본문(등록 안내/결제 확인/PIN 요청)은 링크가 빠지면
   * 흐름 자체가 끊기므로 vars 를 두지 않아 오버라이드 대상에서 제외된다.
   */
  vars?: Record<string, string>;
}

function withLink(body: string, link: string): TemplateOutput['text'] {
  return `${body} ${link}`;
}

function maskLink(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/g, '[보안링크]');
}

/**
 * 최초 1회 결제수단 등록 안내.
 *
 * 계좌(내통장결제)와 카드 빌링키 모두 같은 흐름을 쓴다. 안내 문구만 결제수단에 맞춰 바뀐다.
 * 카드는 아직 실 연동 전이라 현재 호출부는 모두 기본값(ACCOUNT)을 쓴다.
 */
export function tplRegisterGuide(
  merchantName: string,
  link: string,
  method: 'ACCOUNT' | 'CARD' = 'ACCOUNT',
): TemplateOutput {
  const what = method === 'CARD' ? '카드 등록' : '계좌 등록';
  // 등록 화면에서 표시 이름도 정할 수 있다는 것을 미리 알려 입력률을 높인다.
  // (선택 항목이라 안내가 없으면 대부분 그냥 지나친다)
  const text = withLink(
    `[기브싸인] ${merchantName} 후원을 하려면 ${what}과 이용 동의가 필요합니다. 보내신 문자로는 아직 후원되지 않았습니다. 등록 화면에서 후원 내역에 표시될 이름도 정할 수 있습니다. 등록:`,
    link,
  );
  return { code: MT_TEMPLATE.REGISTER_GUIDE, text, masked: maskLink(text) };
}

/** MO 안내 문자 본문 최대 길이. LMS(2,000byte) 안에 링크까지 확실히 들어가는 보수적인 값. */
export const MO_GUIDE_MAX_LENGTH = 160;

/** MO 안내 문자에서 쓸 수 있는 치환자. 설정 화면 안내와 검증에 함께 쓴다. */
export const MO_GUIDE_VARIABLES = [
  { token: '{사회복지기관}', label: '사회복지기관 이름' },
  { token: '{상품목록}', label: '판매 중인 상품 이름 (최대 4개)' },
  { token: '{유효시간}', label: '링크 유효시간(분)' },
] as const;

export interface MoGuideInput {
  merchantName: string;
  link: string;
  ttlMin: number;
  /** 판매 중인 상품 이름 몇 개. 비어 있으면 {상품목록} 치환자는 지워진다. */
  productNames?: string[];
  /** 사회복지기관이 설정한 안내 문구. 비어 있으면 기본 문구를 쓴다. */
  custom?: string | null;
}

const MO_GUIDE_TOKEN_RE = /\{(사회복지기관|상품목록|유효시간)\}/g;

/**
 * MO 를 받았을 때 보내는 **안내 문자**.
 *
 * 결제 감사 문자와는 다른 문자다. 이 문자에는 상품 선택·결제 링크가 붙고,
 * 아직 출금이 일어나지 않았다는 점을 반드시 알려야 한다(오인 결제 민원의 대부분이 여기서 난다).
 * 그래서 사회복지기관이 본문을 바꿔도 "아직 결제되지 않았습니다" 고지와 링크는 시스템이 붙인다.
 */
export function tplSelectAmount(input: MoGuideInput): TemplateOutput {
  const list = (input.productNames ?? []).slice(0, 4).join(' · ');
  const custom = input.custom ? sanitizeLine(input.custom) : '';
  const body = custom
    ? sanitizeLine(
        custom.replace(MO_GUIDE_TOKEN_RE, (_m, key: string) =>
          key === '사회복지기관' ? input.merchantName : key === '상품목록' ? list : String(input.ttlMin),
        ),
      )
    : `${input.merchantName} 결제를 진행합니다.${list ? ` (${list})` : ''} 아래 링크에서 상품과 금액을 고르고 PIN 을 입력해 주세요. (유효시간 ${input.ttlMin}분)`;

  // 고지는 사회복지기관이 지울 수 없다. 본문에 이미 들어 있으면 두 번 붙이지 않는다.
  const notice = body.includes('아직 결제되지 않았습니다') ? '' : ' 아직 결제되지 않았습니다.';
  // 사회복지기관이 본문을 비워 둔 것과 같은 상태(치환 결과가 빈 문자열)면 최소 문구를 쓴다.
  const head = body || `${input.merchantName} 결제를 진행합니다.`;
  const text = withLink(`[기브싸인] ${head}${notice}`, input.link);
  return { code: MT_TEMPLATE.SELECT_AMOUNT, text, masked: maskLink(text) };
}

export function tplConfirmPayment(merchantName: string, amount: bigint, link: string, ttlMin: number): TemplateOutput {
  const text = withLink(
    `[기브싸인] ${merchantName}에 ${formatNumber(amount)}원을 후원하시려면 아래 링크에서 확인해 주세요. ${ttlMin}분 내 미확인 시 자동 취소됩니다. 확인:`,
    link,
  );
  return { code: MT_TEMPLATE.CONFIRM_PAYMENT, text, masked: maskLink(text) };
}

/**
 * 결제 PIN 입력 요청.
 *
 * 결제사(헥토/카드)가 발급한 PIN 입력 링크를 후원자에게 보낸다.
 * 이 문자를 받은 시점에는 아직 출금이 일어나지 않았고, PIN 을 입력해야 결제가 완료된다.
 *
 * @param mock 결제사 실연동이 아닌 mock 링크이면 본문에 [MOCK] 을 명시한다.
 *             (계약 전 연동을 실제 결제로 오인하지 않게 하기 위한 표시다)
 */
export function tplPinRequest(input: {
  merchantName: string;
  amount: bigint;
  pinUrl: string;
  ttlMin: number;
  mock: boolean;
}): TemplateOutput {
  const tag = input.mock ? ' [MOCK]' : '';
  const text = withLink(
    `[기브싸인]${tag} ${input.merchantName}에 ${formatNumber(input.amount)}원 후원을 진행합니다. ` +
      `아직 결제되지 않았습니다. 결제 PIN 입력 링크: `,
    `${input.pinUrl} (유효시간: ${input.ttlMin}분)`,
  );
  return { code: MT_TEMPLATE.PIN_REQUEST, text, masked: maskLink(text) };
}

// ---------------------------------------------------------------------------
// 결제 감사 문자 (사회복지기관 커스터마이즈)
// ---------------------------------------------------------------------------

export interface ChargeSuccessInput {
  payerName: string;
  merchantName: string;
  amount: bigint;
  message: string;
  cumulative: bigint;
  /** 사회복지기관이 설정한 감사 문자 본문. 비어 있으면 기본 문구를 쓴다. */
  custom?: string | null;
}

/** 감사 문자 본문 최대 길이. LMS(2,000byte) 안에 확실히 들어가는 보수적인 값. */
export const THANKS_MT_MAX_LENGTH = 200;

/** 감사 문자에서 쓸 수 있는 치환자. 스튜디오 설정 화면 안내와 검증에 함께 쓴다. */
export const THANKS_MT_VARIABLES = [
  { token: '{후원자}', label: '후원자 이름' },
  { token: '{사회복지기관}', label: '사회복지기관 이름' },
  { token: '{금액}', label: '결제 금액' },
  { token: '{메시지}', label: '후원자가 보낸 메시지' },
  { token: '{누적}', label: '누적 후원 금액' },
] as const;

const THANKS_VALUES: Record<string, (i: ChargeSuccessInput) => string> = {
  '후원자': (i) => i.payerName,
  '사회복지기관': (i) => i.merchantName,
  '금액': (i) => `${formatNumber(i.amount)}원`,
  '메시지': (i) => i.message,
  '누적': (i) => `${formatNumber(i.cumulative)}원`,
};

const THANKS_TOKEN_RE = /\{(후원자|사회복지기관|금액|메시지|누적)\}/g;

/** 문자 본문에 들어가면 안 되는 값(제어문자)을 제거한다. 줄바꿈은 그대로 둔다. */
function sanitizeLine(v: string): string {
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
}

/**
 * 사회복지기관이 설정한 본문의 치환자를 실제 값으로 바꾼다.
 *
 * 치환값에 `$&` 같은 문자가 들어와도 그대로 남도록 함수형 치환을 쓴다.
 * (문자열 치환을 쓰면 후원자 이름이나 메시지에 `$` 가 있을 때 본문이 깨진다)
 */
export function renderThanksMessage(template: string, input: ChargeSuccessInput): string {
  return sanitizeLine(template.replace(THANKS_TOKEN_RE, (_m, key: string) => THANKS_VALUES[key](input)));
}

/** 감사 문자 기본 문구 (사회복지기관 설정이 없을 때) */
export function defaultThanksMessage(input: ChargeSuccessInput): string {
  return (
    `${input.payerName}님, ${input.merchantName}에 ${formatNumber(input.amount)}원 후원이 완료되었습니다. 따뜻한 마음에 감사드립니다. ` +
    `메시지: "${input.message}" 누적 후원: ${formatNumber(input.cumulative)}원`
  );
}

/**
 * 결제 성공 감사 문자.
 *
 * 사회복지기관이 스튜디오에서 본문을 설정했으면 그 문구를 쓰고, 없으면 기본 문구를 쓴다.
 * 발신 주체 표기(`[기브싸인]`)는 어떤 경우에도 앞에 붙인다.
 */
export function tplChargeSuccess(input: ChargeSuccessInput): TemplateOutput {
  const custom = input.custom ? sanitizeLine(input.custom) : '';
  const body = custom ? renderThanksMessage(custom, input) : defaultThanksMessage(input);
  const text = `[기브싸인] ${body || defaultThanksMessage(input)}`;
  return {
    code: MT_TEMPLATE.CHARGE_SUCCESS,
    text,
    masked: maskLink(text),
    // 사회복지기관이 직접 설정한 문구가 있으면 그 문구가 우선이다.
    // 관리자 기본 문구가 사회복지기관 설정을 덮어쓰지 않도록 vars 를 넘기지 않는다.
    vars: custom
      ? undefined
      : {
          후원자: input.payerName,
          사회복지기관: input.merchantName,
          금액: `${formatNumber(input.amount)}원`,
          메시지: input.message,
          누적: `${formatNumber(input.cumulative)}원`,
        },
  };
}

/**
 * 실물 주문 발송 안내.
 *
 * 송장을 등록해도 후원자가 모르면 "언제 오냐" 문의가 그대로 사회복지기관에 쌓인다.
 * 링크는 넣지 않는다(택배사 조회 주소는 통신사 스팸 필터에 자주 걸린다).
 */
export function tplShipmentSent(input: {
  merchantName: string;
  productName: string;
  carrier: string;
  trackingNo: string;
}): TemplateOutput {
  const text =
    `[기브싸인] ${input.merchantName} 주문하신 ${input.productName} 이(가) 발송되었습니다. ` +
    `${input.carrier} ${input.trackingNo}. 택배사 앱이나 홈페이지에서 송장번호로 조회하실 수 있습니다.`;
  return {
    code: MT_TEMPLATE.SHIPMENT_SENT,
    text,
    masked: text,
    vars: {
      사회복지기관: input.merchantName,
      상품: input.productName,
      택배사: input.carrier,
      송장번호: input.trackingNo,
    },
  };
}

/**
 * 비실물 상품 즉시 지급 안내.
 *
 * 사회복지기관이 상품에 적어 둔 안내 문구(코드·이용 방법)를 그대로 보낸다.
 * 문구는 저장 시점에 링크·개인정보 검증을 거친다.
 */
export function tplFulfillmentInstant(input: {
  merchantName: string;
  productName: string;
  note: string;
}): TemplateOutput {
  const body = sanitizeLine(input.note);
  const text = `[기브싸인] ${input.merchantName} ${input.productName} 결제가 완료되었습니다. ${body}`;
  return {
    code: MT_TEMPLATE.FULFILLMENT_INSTANT,
    text,
    masked: maskLink(text),
    vars: { 사회복지기관: input.merchantName, 상품: input.productName, 안내: body },
  };
}

/**
 * 문서 상품 작성 안내.
 *
 * 결제 감사 문자와 따로 보낸다. 감사 문자 본문은 사회복지기관이 바꿀 수 있어서
 * 거기에 링크를 끼워 넣으면 문구를 고치는 순간 링크가 사라진다 —
 * 그러면 후원자는 결제만 하고 문서를 쓸 방법이 없다.
 *
 * vars 를 두지 않는다(관리자 커스텀 본문 대상에서 제외). 링크가 빠지면 흐름이 끊긴다.
 */
export function tplDocumentRequest(input: {
  merchantName: string;
  documentName: string;
  link: string;
  ttlDays: number;
}): TemplateOutput {
  const text = withLink(
    `[기브싸인] ${input.merchantName} ${input.documentName} 작성이 필요합니다. ` +
      `아래 링크에서 내용을 확인하고 작성해 주세요. ${input.ttlDays}일 안에 작성해 주세요. 작성:`,
    input.link,
  );
  return { code: MT_TEMPLATE.DOCUMENT_REQUEST, text, masked: maskLink(text) };
}

export function tplChargeFailed(merchantName: string, reason?: string): TemplateOutput {
  const text =
    `[기브싸인] ${merchantName} 후원이 완료되지 않았습니다. ` +
    `${reason ? `사유: ${reason} ` : ''}계좌 상태 또는 이용 한도를 확인해 주세요. 결제되지 않은 요청은 후원으로 반영되지 않습니다.`;
  return {
    code: MT_TEMPLATE.CHARGE_FAILED,
    text,
    masked: text,
    vars: { 사회복지기관: merchantName, 사유: reason ?? '' },
  };
}

// ---------------------------------------------------------------------------
// 정기후원 · 기부금영수증
// ---------------------------------------------------------------------------

export function tplRecurringStarted(input: { merchantName: string; amount: bigint; dayOfMonth: number; nextDate: string }): TemplateOutput {
  const text =
    `[기브싸인] ${input.merchantName} 정기후원이 등록되었습니다. 매월 ${input.dayOfMonth}일 ${formatNumber(input.amount)}원이 등록된 결제수단에서 출금됩니다. ` +
    `첫 출금 ${input.nextDate}. 변경·해지는 마이페이지에서 언제든 가능합니다.`;
  return {
    code: MT_TEMPLATE.RECURRING_STARTED,
    text,
    masked: text,
    vars: { 사회복지기관: input.merchantName, 금액: `${formatNumber(input.amount)}원`, 출금일: `${input.dayOfMonth}일`, 다음출금: input.nextDate },
  };
}

export function tplRecurringFailed(input: { merchantName: string; amount: bigint; reason?: string; retryDate: string }): TemplateOutput {
  const text =
    `[기브싸인] ${input.merchantName} 정기후원 ${formatNumber(input.amount)}원 출금이 완료되지 않았습니다. ` +
    `${input.reason ? `사유: ${input.reason} ` : ''}${input.retryDate}에 다시 시도합니다. 계좌 잔액을 확인해 주세요.`;
  return {
    code: MT_TEMPLATE.RECURRING_FAILED,
    text,
    masked: text,
    vars: { 사회복지기관: input.merchantName, 금액: `${formatNumber(input.amount)}원`, 사유: input.reason ?? '', 다음출금: input.retryDate },
  };
}

export function tplRecurringSuspended(input: { merchantName: string; amount: bigint }): TemplateOutput {
  const text =
    `[기브싸인] ${input.merchantName} 정기후원(${formatNumber(input.amount)}원)이 출금 실패가 반복되어 잠시 멈췄습니다. ` +
    `마이페이지에서 결제수단을 확인한 뒤 다시 시작할 수 있습니다. 그동안 출금은 일어나지 않습니다.`;
  return {
    code: MT_TEMPLATE.RECURRING_SUSPENDED,
    text,
    masked: text,
    vars: { 사회복지기관: input.merchantName, 금액: `${formatNumber(input.amount)}원` },
  };
}

export function tplReceiptIssued(input: { merchantName: string; taxYear: number; amount: bigint; link: string }): TemplateOutput {
  const body = `[기브싸인] ${input.merchantName} ${input.taxYear}년 기부금영수증(${formatNumber(input.amount)}원)이 발급되었습니다. 열람·출력:`;
  const text = withLink(body, input.link);
  return { code: MT_TEMPLATE.RECEIPT_ISSUED, text, masked: maskLink(text) };
}

export function tplAccountInactive(merchantName: string): TemplateOutput {
  // 해지한 후원자에게 문자만으로 등록 링크를 자동 재발급하지는 않는다(의도된 정책).
  // 대신 실제로 다시 등록할 수 있는 경로를 알려 준다. 예전 문구("이용 상태를 확인하거나
  // 고객센터로 문의")는 다음에 무엇을 해야 하는지 알려 주지 않아 후원자가 막혔다.
  const text =
    `[기브싸인] ${merchantName} 후원을 진행할 수 없습니다. ` +
    '후원 페이지에서 휴대폰 번호 인증을 거쳐 계좌를 다시 등록해 주세요. 결제는 진행되지 않았습니다.';
  return { code: MT_TEMPLATE.ACCOUNT_INACTIVE, text, masked: text, vars: { 사회복지기관: merchantName } };
}

export function tplLimitBlocked(merchantName: string, reason: string): TemplateOutput {
  const text = `[기브싸인] ${merchantName} 후원이 제한되었습니다. 사유: ${reason} 후원은 진행되지 않았습니다.`;
  return { code: MT_TEMPLATE.LIMIT_BLOCKED, text, masked: text, vars: { 사회복지기관: merchantName, 사유: reason } };
}

export function tplContentBlocked(merchantName: string): TemplateOutput {
  const text = `[기브싸인] ${merchantName}에 보낸 메시지가 운영정책에 따라 차단되었습니다. 후원은 진행되지 않았습니다.`;
  return { code: MT_TEMPLATE.CONTENT_BLOCKED, text, masked: text, vars: { 사회복지기관: merchantName } };
}

export function tplRefundDone(merchantName: string, amount: bigint): TemplateOutput {
  const text = `[기브싸인] ${merchantName} 후원 ${formatNumber(amount)}원이 취소되어 환불 처리되었습니다.`;
  return {
    code: MT_TEMPLATE.REFUND_DONE,
    text,
    masked: text,
    vars: { 사회복지기관: merchantName, 금액: `${formatNumber(amount)}원` },
  };
}

export function tplUnknownRoute(): TemplateOutput {
  const text =
    '[기브싸인] 후원할 기관을 찾을 수 없습니다. 기관이 안내한 번호와 키워드를 다시 확인해 주세요. 후원은 진행되지 않았습니다.';
  return { code: MT_TEMPLATE.UNKNOWN_ROUTE, text, masked: text, vars: {} };
}

// ---------------------------------------------------------------------------
// 인증번호 문자 (결제내역 확인 / 휴대폰 번호 연결 / 결제 페이지 결제)
// ---------------------------------------------------------------------------

/**
 * 인증번호 유효시간(분).
 * 각 액션(charge-lookup / phone-link / web-charge)의 TTL_SEC(300초)와 같은 값이어야 한다.
 * 문자에 안내한 시간과 실제 만료 시간이 어긋나면 후원자가 유효한 코드를 버리게 된다.
 */
export const VERIFY_CODE_TTL_MIN = 5;

/** 인증번호 6자리는 로그/DB 본문에 남기지 않는다. */
function maskVerifyCode(text: string, code: string): string {
  return text.split(code).join('[인증번호]');
}

function verifyTemplate(code: MtTemplateCode, purpose: string, verifyCode: string): TemplateOutput {
  const text = `[기브싸인] ${purpose} 인증번호는 ${verifyCode} 입니다. ${VERIFY_CODE_TTL_MIN}분 안에 입력해 주세요.`;
  return {
    code,
    text,
    masked: maskVerifyCode(text, verifyCode),
    vars: { 인증번호: verifyCode, 유효시간: String(VERIFY_CODE_TTL_MIN) },
  };
}

/** 결제내역 확인(비회원 조회) 인증번호. */
export function tplLookupVerify(code: string): TemplateOutput {
  return verifyTemplate(MT_TEMPLATE.LOOKUP_VERIFY, '결제내역 확인', code);
}

/** 마이페이지 휴대폰 번호 확인 인증번호. */
export function tplPhoneLinkVerify(code: string): TemplateOutput {
  return verifyTemplate(MT_TEMPLATE.PHONE_LINK_VERIFY, '휴대폰 번호 확인', code);
}

/** 전자문서 서명 본인확인 인증번호. */
export function tplEDocVerify(code: string): TemplateOutput {
  return verifyTemplate(MT_TEMPLATE.EDOC_SIGN_VERIFY, '전자문서 본인확인', code);
}

/** 전자문서 서명 요청. reminder 면 재안내 문구를 쓴다. */
export function tplEDocSignRequest(input: { merchantName: string; title: string; link: string; dueDate: string; reminder?: boolean }): TemplateOutput {
  const head = input.reminder ? '서명을 아직 마치지 않으셨습니다.' : '서명 요청이 도착했습니다.';
  const text = withLink(
    `[기브싸인] ${input.merchantName} 「${input.title}」 ${head} ${input.dueDate}까지 내용을 확인하고 서명해 주세요. 서명:`,
    input.link,
  );
  return { code: MT_TEMPLATE.EDOC_SIGN_REQUEST, text, masked: maskLink(text) };
}

/** 전자문서 서명 완료 안내. 링크는 넣지 않는다(받은 서명 링크에서 완료본을 다시 볼 수 있다). */
export function tplEDocCompleted(input: { merchantName: string; title: string }): TemplateOutput {
  const text = `[기브싸인] ${input.merchantName} 「${input.title}」 서명이 모두 끝났습니다. 완료본은 받으신 서명 링크에서 확인할 수 있습니다.`;
  return { code: MT_TEMPLATE.EDOC_COMPLETED, text, masked: text };
}

/** 결제 페이지 PC 웹 결제 인증번호. */
export function tplPaymentVerify(code: string): TemplateOutput {
  return verifyTemplate(MT_TEMPLATE.PAYMENT_VERIFY, '후원 페이지 후원', code);
}

// ---------------------------------------------------------------------------
// 관리자 커스텀 본문 (MtMessageTemplate) — 재배포 없이 문구를 바꾸기 위한 오버라이드
// ---------------------------------------------------------------------------

/**
 * 관리자 화면에서 본문을 고칠 수 있는 템플릿 목록과 안내 정보.
 *
 * editable=false 인 항목은 본문에 **보안링크**가 들어간다. 링크가 빠지거나 잘리면
 * 등록/결제 흐름 자체가 끊기므로 코드에서만 관리하고 화면에서는 읽기 전용으로 보여준다.
 */
export interface MtTemplateMeta {
  label: string;
  description: string;
  editable: boolean;
  /** 오버라이드가 없을 때 편집칸에 채워 넣는 기본 본문 (치환자 형태, 발신 표기 제외) */
  defaultBody: string;
  /** 이 템플릿에서 쓸 수 있는 치환자 */
  variables: Array<{ token: string; label: string }>;
}

const V = {
  payer: { token: '{후원자}', label: '후원자 이름' },
  merchant: { token: '{사회복지기관}', label: '사회복지기관 이름' },
  amount: { token: '{금액}', label: '결제 금액 (예: 10,000원)' },
  message: { token: '{메시지}', label: '후원자가 보낸 메시지' },
  cumulative: { token: '{누적}', label: '누적 후원 금액' },
  reason: { token: '{사유}', label: '실패·제한 사유' },
  verifyCode: { token: '{인증번호}', label: '6자리 인증번호' },
  ttl: { token: '{유효시간}', label: '인증번호 유효시간(분)' },
  product: { token: '{상품}', label: '주문한 상품 이름' },
  carrier: { token: '{택배사}', label: '택배사 이름' },
  tracking: { token: '{송장번호}', label: '송장번호' },
  fulfillNote: { token: '{안내}', label: '사회복지기관이 상품에 적어 둔 지급 안내 문구' },
  document: { token: '{문서}', label: '작성할 문서 서식 이름' },
} as const;

export const MT_TEMPLATE_META: Record<MtTemplateCode, MtTemplateMeta> = {
  [MT_TEMPLATE.REGISTER_GUIDE]: {
    label: '최초 결제수단 등록 안내',
    description: '처음 문자를 보낸 후원자에게 계좌/카드 등록 링크를 보냅니다.',
    editable: false,
    defaultBody:
      '{사회복지기관} 후원을 하려면 계좌 등록과 이용 동의가 필요합니다. 보내신 문자로는 아직 후원되지 않았습니다. 등록: [보안링크]',
    variables: [V.merchant],
  },
  [MT_TEMPLATE.SELECT_AMOUNT]: {
    label: '후원 금액 선택 링크',
    description: '문자를 받으면 후원 금액을 고르고 PIN 을 입력하는 링크를 보냅니다. 이 시점에는 금액이 정해지지 않았습니다.',
    editable: false,
    defaultBody:
      '{사회복지기관} 후원을 진행합니다. 아직 후원되지 않았습니다. 아래 링크에서 후원 금액을 고르고 PIN 을 입력해 주세요. [보안링크]',
    variables: [V.merchant],
  },
  [MT_TEMPLATE.CONFIRM_PAYMENT]: {
    label: '결제 확인 링크',
    description: '결제 진행 여부를 확인받는 링크를 보냅니다.',
    editable: false,
    defaultBody: '{사회복지기관}에 {금액}을 후원하시려면 아래 링크에서 확인해 주세요. 확인: [보안링크]',
    variables: [V.merchant, V.amount],
  },
  [MT_TEMPLATE.PIN_REQUEST]: {
    label: '결제 PIN 입력 요청',
    description: '결제사 PIN 입력 링크를 보냅니다. 이 시점에는 아직 출금되지 않았습니다.',
    editable: false,
    defaultBody:
      '{사회복지기관}에 {금액} 후원을 진행합니다. 아직 후원되지 않았습니다. PIN 입력 링크: [보안링크]',
    variables: [V.merchant, V.amount],
  },
  [MT_TEMPLATE.RECURRING_STARTED]: {
    label: '정기후원 등록 안내',
    description: '정기후원 약정이 등록되면 출금 금액·출금일·첫 출금일을 안내합니다.',
    editable: true,
    defaultBody: '{사회복지기관} 정기후원이 등록되었습니다. 매월 {출금일} {금액}이 출금됩니다. 첫 출금 {다음출금}.',
    variables: [V.merchant, V.amount, { token: '{출금일}', label: '매월 출금일' }, { token: '{다음출금}', label: '다음 출금 예정일' }],
  },
  [MT_TEMPLATE.RECURRING_FAILED]: {
    label: '정기후원 출금 실패 안내',
    description: '정기후원 출금이 실패하면 사유와 다음 재시도일을 안내합니다.',
    editable: true,
    defaultBody: '{사회복지기관} 정기후원 {금액} 출금이 완료되지 않았습니다. 사유: {사유} {다음출금}에 다시 시도합니다.',
    variables: [V.merchant, V.amount, V.reason, { token: '{다음출금}', label: '다음 재시도일' }],
  },
  [MT_TEMPLATE.RECURRING_SUSPENDED]: {
    label: '정기후원 정지 안내',
    description: '출금이 연속 실패해 정기후원이 멈췄을 때 보냅니다.',
    editable: true,
    defaultBody: '{사회복지기관} 정기후원({금액})이 출금 실패가 반복되어 잠시 멈췄습니다. 마이페이지에서 결제수단을 확인해 주세요.',
    variables: [V.merchant, V.amount],
  },
  [MT_TEMPLATE.RECEIPT_ISSUED]: {
    label: '기부금영수증 발급 안내',
    description: '기부금영수증이 발급되면 열람 링크를 보냅니다. 링크가 들어가므로 본문을 바꾸지 않습니다.',
    editable: false,
    defaultBody: '{사회복지기관} 기부금영수증이 발급되었습니다. 열람·출력: [보안링크]',
    variables: [V.merchant],
  },
  [MT_TEMPLATE.MERCHANT_NOTICE]: {
    label: '사회복지기관 발송 문자',
    description:
      '사회복지기관이 연동 API 로 직접 보내는 거래 안내입니다. 본문은 사회복지기관이 등록해 검수받은 템플릿에서 나오므로 여기서 바꾸지 않습니다.',
    editable: false,
    defaultBody: '(사회복지기관이 등록한 템플릿 본문)',
    variables: [V.merchant],
  },
  [MT_TEMPLATE.CHARGE_SUCCESS]: {
    label: '결제 완료 감사 문자',
    description:
      '결제가 완료되었을 때 후원자에게 보냅니다. 사회복지기관이 스튜디오에서 직접 문구를 설정한 경우에는 그 문구가 우선합니다.',
    editable: true,
    defaultBody:
      '{후원자}님, {사회복지기관}에 {금액} 후원이 완료되었습니다. 따뜻한 마음에 감사드립니다. 메시지: "{메시지}" 누적 후원: {누적}',
    variables: [V.payer, V.merchant, V.amount, V.message, V.cumulative],
  },
  [MT_TEMPLATE.CHARGE_FAILED]: {
    label: '결제 실패 안내',
    description: '결제가 완료되지 않았을 때 보냅니다.',
    editable: true,
    defaultBody:
      '{사회복지기관} 후원이 완료되지 않았습니다. 사유: {사유} 계좌 상태 또는 이용 한도를 확인해 주세요. 결제되지 않은 요청은 후원으로 반영되지 않습니다.',
    variables: [V.merchant, V.reason],
  },
  [MT_TEMPLATE.ACCOUNT_INACTIVE]: {
    label: '결제수단 이용 불가 안내',
    description: '등록된 결제수단을 쓸 수 없을 때 보냅니다.',
    editable: true,
    defaultBody:
      '{사회복지기관} 후원을 진행할 수 없습니다. 내통장결제 이용 상태를 확인하거나 고객센터로 문의해 주세요. 후원은 진행되지 않았습니다.',
    variables: [V.merchant],
  },
  [MT_TEMPLATE.LIMIT_BLOCKED]: {
    label: '한도 초과 안내',
    description: '일일/월간 한도나 이상거래 탐지로 결제가 막혔을 때 보냅니다.',
    editable: true,
    defaultBody: '{사회복지기관} 후원이 제한되었습니다. 사유: {사유} 후원은 진행되지 않았습니다.',
    variables: [V.merchant, V.reason],
  },
  [MT_TEMPLATE.CONTENT_BLOCKED]: {
    label: '금칙어 차단 안내',
    description: '메시지가 운영정책(금칙어)에 걸렸을 때 보냅니다.',
    editable: true,
    defaultBody: '{사회복지기관}에 보낸 메시지가 운영정책에 따라 차단되었습니다. 후원은 진행되지 않았습니다.',
    variables: [V.merchant],
  },
  [MT_TEMPLATE.REFUND_DONE]: {
    label: '환불 완료 안내',
    description: '결제가 취소되어 환불 처리되었을 때 보냅니다.',
    editable: true,
    defaultBody: '{사회복지기관} 후원 {금액}이 취소되어 환불 처리되었습니다.',
    variables: [V.merchant, V.amount],
  },
  [MT_TEMPLATE.UNKNOWN_ROUTE]: {
    label: '수신 대상 없음 안내',
    description: '어느 사회복지기관에 보낸 문자인지 찾지 못했을 때 보냅니다.',
    editable: true,
    defaultBody:
      '후원할 기관을 찾을 수 없습니다. 기관이 안내한 번호와 키워드를 다시 확인해 주세요. 후원은 진행되지 않았습니다.',
    variables: [],
  },
  [MT_TEMPLATE.LOOKUP_VERIFY]: {
    label: '결제내역 확인 인증번호',
    description: '비회원이 결제내역을 조회할 때 보내는 인증번호입니다.',
    editable: true,
    defaultBody: '결제내역 확인 인증번호는 {인증번호} 입니다. {유효시간}분 안에 입력해 주세요.',
    variables: [V.verifyCode, V.ttl],
  },
  [MT_TEMPLATE.PHONE_LINK_VERIFY]: {
    label: '휴대폰 번호 확인 인증번호',
    description: '마이페이지에서 휴대폰 번호를 계정에 연결할 때 보내는 인증번호입니다.',
    editable: true,
    defaultBody: '휴대폰 번호 확인 인증번호는 {인증번호} 입니다. {유효시간}분 안에 입력해 주세요.',
    variables: [V.verifyCode, V.ttl],
  },
  [MT_TEMPLATE.PAYMENT_VERIFY]: {
    label: '후원 페이지 후원 인증번호',
    description: 'PC 웹 후원 페이지에서 후원 전 본인확인을 할 때 보내는 인증번호입니다.',
    editable: true,
    defaultBody: '후원 페이지 후원 인증번호는 {인증번호} 입니다. {유효시간}분 안에 입력해 주세요.',
    variables: [V.verifyCode, V.ttl],
  },
  [MT_TEMPLATE.SHIPMENT_SENT]: {
    label: '실물 주문 발송 안내',
    description: '사회복지기관이 송장을 등록하고 발송 처리하면 후원자에게 나가는 문자입니다.',
    editable: true,
    defaultBody:
      '{사회복지기관} 주문하신 {상품} 이(가) 발송되었습니다. {택배사} {송장번호}. 택배사 앱이나 홈페이지에서 송장번호로 조회하실 수 있습니다.',
    variables: [V.merchant, V.product, V.carrier, V.tracking],
  },
  [MT_TEMPLATE.FULFILLMENT_INSTANT]: {
    label: '비실물 즉시 지급 안내',
    description: '지급 방식이 [결제 즉시 문자 발급] 인 비실물 상품이 결제되면 나가는 문자입니다.',
    editable: true,
    defaultBody: '{사회복지기관} {상품} 후원이 완료되었습니다. {안내}',
    variables: [V.merchant, V.product, V.fulfillNote],
  },
  [MT_TEMPLATE.DOCUMENT_REQUEST]: {
    label: '문서 작성 안내',
    description:
      '문서 상품(약정서·주문서 등)이 결제되면 작성 링크를 보냅니다. 링크가 빠지면 후원자가 문서를 작성할 수 없어 화면에서 수정할 수 없습니다.',
    editable: false,
    defaultBody:
      '{사회복지기관} {문서} 작성이 필요합니다. 아래 링크에서 내용을 확인하고 작성해 주세요. (작성 링크 포함)',
    variables: [V.merchant, V.document],
  },
  [MT_TEMPLATE.EDOC_SIGN_REQUEST]: {
    label: '전자문서 서명 요청',
    description: '기관이 전자문서 센터에서 서명을 요청하면 서명 링크를 보냅니다. 링크가 들어가므로 화면에서 수정할 수 없습니다.',
    editable: false,
    defaultBody: '{사회복지기관} 「{문서}」 서명 요청이 도착했습니다. 기한까지 내용을 확인하고 서명해 주세요. 서명: [보안링크]',
    variables: [V.merchant, V.document],
  },
  [MT_TEMPLATE.EDOC_SIGN_VERIFY]: {
    label: '전자문서 본인확인 인증번호',
    description: '서명 링크를 연 사람이 받은 번호의 주인인지 확인하는 인증번호입니다.',
    editable: true,
    defaultBody: '전자문서 본인확인 인증번호는 {인증번호} 입니다. {유효시간}분 안에 입력해 주세요.',
    variables: [V.verifyCode, V.ttl],
  },
  [MT_TEMPLATE.EDOC_COMPLETED]: {
    label: '전자문서 서명 완료 안내',
    description: '모든 서명자가 서명을 마치면 서명자 전원에게 보냅니다.',
    editable: false,
    defaultBody: '{사회복지기관} 「{문서}」 서명이 모두 끝났습니다. 완료본은 받으신 서명 링크에서 확인할 수 있습니다.',
    variables: [V.merchant, V.document],
  },
};

/** 관리 화면 카드 순서. */
export const MT_TEMPLATE_CODES = Object.keys(MT_TEMPLATE_META) as MtTemplateCode[];

/** 관리자 커스텀 본문 최대 길이. LMS(2,000byte) 안에 확실히 들어가는 보수적인 값. */
export const MT_TEMPLATE_BODY_MAX_LENGTH = 400;

const SENDER_TAG = '[기브싸인]';

/** 발신 주체 표기는 어떤 커스텀 본문에서도 빠지지 않게 강제한다. */
function ensureSenderTag(text: string): string {
  return text.startsWith(SENDER_TAG) ? text : `${SENDER_TAG} ${text}`;
}

const OVERRIDE_TOKEN_RE = /\{([^{}\s]{1,12})\}/g;

/**
 * 커스텀 본문의 치환자를 실제 값으로 바꾼다.
 *
 * 값에 `$&` 같은 문자가 있어도 그대로 남도록 함수형 치환을 쓴다.
 * 지원하지 않는 치환자는 건드리지 않고 원문 그대로 남긴다
 * (오타로 문장이 통째로 사라지는 것보다 눈에 띄는 편이 낫다).
 */
export function renderMtTemplateBody(body: string, vars: Record<string, string>): string {
  return body.replace(OVERRIDE_TOKEN_RE, (m, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : m,
  );
}

/** 커스텀 본문 유효성 검사. 문제가 있으면 사유를, 없으면 null 을 돌려준다. */
export function validateMtTemplateBody(code: MtTemplateCode, body: string): string | null {
  const meta = MT_TEMPLATE_META[code];
  if (!meta) return '알 수 없는 템플릿 코드입니다.';
  if (!meta.editable) {
    return `${meta.label} 문자는 보안링크가 포함되어 있어 화면에서 수정할 수 없습니다.`;
  }

  const trimmed = sanitizeLine(body);
  if (trimmed === '') return '본문을 입력해 주세요. 기본 문구로 되돌리려면 초기화를 사용하세요.';
  if (trimmed.length > MT_TEMPLATE_BODY_MAX_LENGTH) {
    return `본문은 ${MT_TEMPLATE_BODY_MAX_LENGTH}자 이하로 입력해 주세요. (현재 ${trimmed.length}자)`;
  }

  const allowed = new Set(meta.variables.map((v) => v.token.slice(1, -1)));
  const unknown = [...trimmed.matchAll(OVERRIDE_TOKEN_RE)].map((m) => m[1]).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    return `이 문자에서 쓸 수 없는 치환자입니다: ${[...new Set(unknown)].map((k) => `{${k}}`).join(', ')}`;
  }

  // 인증번호가 빠지면 후원자가 인증을 끝낼 방법이 없어진다.
  if (allowed.has('인증번호') && !trimmed.includes('{인증번호}')) {
    return '인증번호 문자에는 {인증번호} 치환자가 반드시 들어가야 합니다.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// 저장된 커스텀 본문 읽기
// ---------------------------------------------------------------------------

/**
 * 문자 발송 경로에서 매번 호출되므로 짧게 캐싱한다.
 * DB 조회가 실패해도 문자 발송 자체는 기본 문구로 계속 나가야 하므로 예외를 삼킨다.
 */
const OVERRIDE_CACHE_TTL_MS = 30_000;
let overrideCache: { at: number; map: Map<string, string> } | null = null;

/** 관리자가 본문을 저장/초기화한 직후 즉시 반영되도록 캐시를 비운다. */
export function clearMtTemplateOverrideCache(): void {
  overrideCache = null;
}

export async function loadMtTemplateOverrides(): Promise<Map<string, string>> {
  const now = Date.now();
  if (overrideCache && now - overrideCache.at < OVERRIDE_CACHE_TTL_MS) return overrideCache.map;
  try {
    const rows = await prisma.mtMessageTemplate.findMany({ select: { code: true, body: true } });
    const map = new Map(rows.filter((r) => r.body.trim() !== '').map((r) => [r.code, r.body]));
    overrideCache = { at: now, map };
    return map;
  } catch (e) {
    logger.warn('MT 커스텀 본문 조회 실패 - 기본 문구로 발송합니다.', { message: (e as Error).message });
    return overrideCache?.map ?? new Map();
  }
}

/**
 * 템플릿 결과에 관리자 커스텀 본문을 적용한다.
 *
 * 적용하지 않는 경우 (원본을 그대로 돌려준다)
 *  - vars 가 없는 템플릿 (보안링크 포함 본문, 사회복지기관이 직접 설정한 감사 문자)
 *  - editable=false 인 템플릿
 *  - 저장된 본문이 없거나 치환 후 빈 문자열이 되는 경우
 */
export async function applyMtTemplateOverride(out: TemplateOutput): Promise<TemplateOutput> {
  if (!out.vars) return out;
  if (!MT_TEMPLATE_META[out.code]?.editable) return out;

  const body = (await loadMtTemplateOverrides()).get(out.code);
  if (!body) return out;

  const rendered = sanitizeLine(renderMtTemplateBody(body, out.vars));
  if (rendered === '') return out;

  const text = ensureSenderTag(rendered);
  const verifyCode = out.vars['인증번호'];
  const masked = verifyCode ? maskVerifyCode(maskLink(text), verifyCode) : maskLink(text);
  return { ...out, text, masked };
}
