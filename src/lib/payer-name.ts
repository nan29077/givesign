import { normalizePhone, phoneTail4 } from '@/lib/phone';

/**
 * 후원자 표시 이름(닉네임) 규칙.
 *
 * 문자후원은 휴대폰 번호만 수집하므로, 닉네임을 설정하기 전에는
 * 사회복지기관 화면과 후원 내역에 번호가 그대로 노출된다.
 * 그래서 기본값을 "후원자{끝 4자리}" 로 두어
 *  - 이름처럼 읽히고
 *  - 앞자리(010 등)가 화면에 나가지 않도록 노출 범위를 좁힌다.
 *
 * 여기 있는 함수는 순수 함수만 둔다(브라우저에서도 그대로 쓴다).
 * 금칙어 검사처럼 DB 가 필요한 검증은 server/services/payer-name.ts 가 담당한다.
 */

export const PAYER_NAME_MIN = 2;
export const PAYER_NAME_MAX = 10;

/** 기본 닉네임 접두사. 바꾸면 기존 사용자의 표시 이름도 함께 바뀐다. */
const DEFAULT_PREFIX = '후원자';

/**
 * 번호로 기본 닉네임을 만든다. 예) 010-1234-5678 → 후원자5678
 * 번호가 짧아 끝 4자리를 못 얻으면 접두사만 돌려준다.
 */
export function defaultPayerName(phone: string): string {
  const digits = normalizePhone(phone).replace(/\D/g, '');
  const tail = digits.slice(-4);
  return tail.length === 4 ? `${DEFAULT_PREFIX}${tail}` : DEFAULT_PREFIX;
}

/** 화면에 쓸 표시 이름. 저장된 닉네임이 있으면 그것을, 없으면 기본값을 쓴다. */
export function payerDisplayName(nickname: string | null | undefined, phone: string): string {
  const t = (nickname ?? '').trim();
  return t.length > 0 ? t : defaultPayerName(phone);
}

/** 기본값으로 자동 생성된 이름인지(= 사용자가 직접 정하지 않았는지) */
export function isDefaultPayerName(name: string | null | undefined): boolean {
  const t = (name ?? '').trim();
  return t === DEFAULT_PREFIX || new RegExp(`^${DEFAULT_PREFIX}\\d{4}$`).test(t);
}

/** 마스킹된 전화번호 표시명. 예: 010-****-1234 (닉네임 기능 이전 데이터) */
const MASKED_PHONE = /^\d{2,3}-\*+-\d{4}$/;
const RAW_PHONE = /^\+?\d{9,13}$/;

/**
 * 후원 내역과 사회복지기관 화면에 실제로 나가는 이름.
 *
 * 저장된 표시 이름(Charge.displayName)은 "후원자5678" 이지만,
 * 후원 내역에서 "후원자5678님이 3,000원을 결제하셨습니다" 는 어색하게 읽힌다.
 * 그래서 직접 정한 닉네임이 아닌 경우에만 끝 4자리로 줄여 부른다.
 *
 * **이 함수는 브라우저와 서버가 함께 쓴다.**
 * 닉네임 설정 화면의 "이렇게 표시됩니다" 미리보기와 실제 송출이 같은 규칙을 봐야
 * 후원자가 화면에서 약속받은 이름과 실제 기록되는 이름이 어긋나지 않는다.
 * (예전에는 규칙이 broadcast-dispatch 안에만 있어서 실제로 어긋나 있었다)
 */
export function displayPayerName(displayName: string): string {
  const value = (displayName || '').trim();

  // 번호가 그대로 남아 있는 예전 데이터 → 끝 4자리만
  if (MASKED_PHONE.test(value) || RAW_PHONE.test(value)) {
    return phoneTail4(value) || value;
  }

  // 자동 생성된 기본 이름 → 끝 4자리만
  if (isDefaultPayerName(value)) {
    const tail = value.slice(-4);
    return /^\d{4}$/.test(tail) ? tail : value;
  }

  // 직접 정한 닉네임은 그대로 부른다.
  return value;
}

/**
 * 입력값 정리.
 * 제어문자·이모지 조합을 깨뜨리지 않도록 제어문자와 폭 없는 문자만 걷어내고,
 * 연속 공백을 하나로 줄인 뒤 앞뒤 공백을 없앤다.
 */
export function normalizePayerName(raw: string): string {
  return raw
    // 제어문자 제거
    .replace(/[\u0000-\u001F\u007F]/g, '')
    // 폭 없는 문자·방향 제어 문자 제거 (보이지 않는 글자로 길이 제한을 우회하는 것을 막는다)
    .replace(/[\u200B-\u200F\u202A-\u202E\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface PayerNameCheck {
  ok: boolean;
  /** 정리된 값. ok 일 때만 저장에 쓴다. */
  value: string;
  message?: string;
}

/**
 * 형식 검사(길이·문자). 금칙어는 서버에서 별도로 본다.
 * 빈 값은 "설정하지 않음"이라 허용한다(기본값이 대신 쓰인다).
 */
export function checkPayerName(raw: string): PayerNameCheck {
  const value = normalizePayerName(raw);
  if (value.length === 0) return { ok: true, value: '' };

  // 이모지·한글 등은 코드 포인트 기준으로 세야 길이가 사람 감각과 맞는다.
  const length = [...value].length;
  if (length < PAYER_NAME_MIN) {
    return { ok: false, value, message: `닉네임은 ${PAYER_NAME_MIN}자 이상 입력해 주세요.` };
  }
  if (length > PAYER_NAME_MAX) {
    return { ok: false, value, message: `닉네임은 ${PAYER_NAME_MAX}자 이내로 입력해 주세요.` };
  }
  // 후원 내역과 사회복지기관 화면에 그대로 나가므로 링크·연락처는 애초에 막는다.
  if (/(https?:\/\/|www\.)/i.test(value)) {
    return { ok: false, value, message: '닉네임에는 링크를 넣을 수 없습니다.' };
  }
  if (/\d{6,}/.test(value)) {
    return { ok: false, value, message: '닉네임에 연락처처럼 보이는 숫자는 넣을 수 없습니다.' };
  }
  return { ok: true, value };
}
