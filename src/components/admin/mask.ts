/**
 * 관리자 화면 표시용 추가 마스킹.
 * 원칙: 빌키/보안링크 토큰/스트림키 원문은 관리자 화면에도 절대 노출하지 않는다.
 */

/** 문자 본문 안의 보안링크 토큰을 가린다. (개발용 모의 발송함 출력에도 동일 적용) */
export function maskLinkTokens(text: string): string {
  return text
    .replace(/(\/r\/)[A-Za-z0-9_-]{6,}/g, '$1****')
    .replace(/(token=)[A-Za-z0-9_-]{6,}/gi, '$1****');
}

/** 계좌는 은행명 + 끝 4자리만 노출한다. */
export function bankLabel(bankName?: string | null, tail4?: string | null): string {
  if (!bankName && !tail4) return '-';
  return `${bankName ?? '은행미상'} ****${tail4 ?? '****'}`;
}

/**
 * 사업자등록번호 마스킹. 개인사업자의 등록번호는 개인정보에 해당하므로
 * 화면에는 앞 3자리와 끝 2자리만 남긴다. (예: 123-45-67890 -> 123-**-***90)
 */
export function maskBusinessNo(value?: string | null): string {
  if (!value) return '미등록';
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 10) return '***';
  return `${digits.slice(0, 3)}-**-***${digits.slice(8)}`;
}

/** 사업자/제휴 식별자처럼 길이가 긴 값은 앞뒤만 남긴다. */
export function shortId(value?: string | null, head = 6, tail = 4): string {
  if (!value) return '-';
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}
