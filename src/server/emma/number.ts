/**
 * MO 수신번호 복원 · 분해.
 *
 * 배경
 * ----
 * 기브싸인의 MO 수신번호는 두 가지로 운영된다.
 *   - **전용번호(DEDICATED)**: 사회복지기관 1곳에 번호 하나를 통째로 배정한다(현재 050 안심번호).
 *   - **대표번호 + 서브번호**: 앞자리는 사업자와 계약한 대표번호로 고정하고,
 *     뒤 4자리(서브번호)를 우리가 사회복지기관에 부여한다(사업자 승인 불필요).
 *
 * EMMA 는 수신번호를 두 컬럼에 나눠 담는다.
 *   mo_recipient  : "mo 번호 (특번)"
 *   emo_recipient : "mo 추가 번호 (특번), emo 번호"
 *
 * 그런데 **어디서 끊어서 담아 주는지는 통신망 등록 방식에 달려 있다.** 계약 전이라 확정할 수 없어
 * 아래 세 경우를 모두 수용한다.
 *
 *   A) mo_recipient="16881234", emo_recipient="5678"      → 168812345678
 *   B) mo_recipient="1688",     emo_recipient="12345678"  → 168812345678
 *   C) mo_recipient="168812345678", emo_recipient=null    → 168812345678
 *
 * 세 경우 모두 **두 값을 이어 붙인 뒤 숫자만 남기면** 같은 결과가 나온다. 그래서 분기 없이
 * 한 규칙으로 처리한다. 다만 사업자가 emo_recipient 에 전체번호를 통째로 넣어 주는 변형
 * (예: mo="16881234", emo="168812345678")도 보고된 적이 있어, 이어 붙이면 번호가 두 번
 * 반복되는 경우만 따로 걸러낸다.
 */

/** 숫자만 남긴다. 대시·공백·'#'(샵번호 표기) 등을 제거한다. */
export function digitsOnly(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/**
 * mo_recipient + emo_recipient → 수신번호 전체.
 *
 * @param moRecipient  EMMA 의 mo_recipient
 * @param emoRecipient EMMA 의 emo_recipient (없을 수 있음)
 * @returns 숫자만 남은 전체 수신번호. 두 값이 모두 비면 빈 문자열.
 */
export function restoreMoNumber(moRecipient: string | null | undefined, emoRecipient?: string | null): string {
  const base = digitsOnly(moRecipient);
  const ext = digitsOnly(emoRecipient);

  if (!ext) return base;
  if (!base) return ext;

  // 사업자가 emo 에 전체번호를 통째로 넣어 준 경우. 이어 붙이면 "1688123416881234 5678" 처럼
  // 대표번호가 두 번 반복된다. emo 가 이미 대표번호로 시작하면 emo 를 전체번호로 본다.
  if (ext.startsWith(base)) return ext;

  return `${base}${ext}`;
}

/** 사회복지기관별 서브번호 자리수. 대표번호 공유 체계가 이 값을 전제로 한다. */
export const SUB_CODE_LENGTH = 4;

/**
 * 전체번호를 대표번호 / 서브번호로 나눈다.
 *
 * @param fullNumber 숫자만 남은 전체 수신번호
 * @param subLength  서브번호 자리수 (기본 4)
 */
export function splitMoNumber(fullNumber: string, subLength = SUB_CODE_LENGTH): { base: string; sub: string } {
  const digits = digitsOnly(fullNumber);
  if (digits.length <= subLength) return { base: digits, sub: '' };
  return {
    base: digits.slice(0, digits.length - subLength),
    sub: digits.slice(-subLength),
  };
}

/**
 * 대표번호 + 서브번호 → 전체번호.
 * 저장·조회 키로 쓰는 표준 형태(숫자만)를 만든다.
 */
export function composeMoNumber(baseNumber: string, subCode: string): string {
  return `${digitsOnly(baseNumber)}${digitsOnly(subCode)}`;
}

/** 화면 표시용: 168812345678 → 1688-1234-5678 */
export function formatMoNumber(fullNumber: string): string {
  const digits = digitsOnly(fullNumber);

  // 050 안심번호 (현재 전용번호 체계) → 0505-1001-1001 / 0505-100-1001
  if (/^050\d/.test(digits) && digits.length >= 10 && digits.length <= 13) {
    return `${digits.slice(0, 4)}-${digits.slice(4, -4)}-${digits.slice(-4)}`;
  }
  // 대표번호(15xx/16xx/18xx) 8자리 + 서브번호 4자리 → 1688-1234-5678
  if (digits.length === 8 + SUB_CODE_LENGTH && /^1[568]\d{2}/.test(digits)) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`;
  }
  // 서브번호가 붙지 않은 대표번호 → 1688-1234
  if (/^1[0-9]{7}$/.test(digits)) {
    return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  }
  // 지역번호 (02-1234-5678, 031-123-4567 …)
  if (/^0[0-9]{9,10}$/.test(digits)) {
    const head = digits.startsWith('02') ? 2 : 3;
    const mid = digits.length - head - 4;
    return `${digits.slice(0, head)}-${digits.slice(head, head + mid)}-${digits.slice(head + mid)}`;
  }
  // 형식을 알아볼 수 없으면 손대지 않는다. 임의로 끊어 보여 주면 잘못된 번호를 옳은 것으로 착각한다.
  return fullNumber;
}

/**
 * 서브번호로 쓰지 않는 값.
 *
 * 오입력·장난 문자가 몰리기 쉬운 번호를 제외한다. 이 번호들이 배정돼 있으면 실수로 보낸 문자가
 * 특정 사회복지기관에게 실제 결제로 이어진다.
 */
export const RESERVED_SUB_CODES: ReadonlySet<string> = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '0123', '1004', '0119', '0112',
]);

/** 서브번호로 쓸 수 있는 값인지 검사한다. */
export function isUsableSubCode(subCode: string): boolean {
  if (!/^\d{4}$/.test(subCode)) return false;
  return !RESERVED_SUB_CODES.has(subCode);
}
