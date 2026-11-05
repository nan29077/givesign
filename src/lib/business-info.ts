/**
 * 공개 화면 푸터의 사업자 표시 정보.
 *
 * 상호는 알려진 값(주식회사 이십세기 소년들)을 기본으로 두고, 대표자·사업자등록번호·주소·연락처 등은
 * 환경변수로만 받는다. 값이 없으면 그 줄을 그리지 않는다 — 모르는 값을 지어내 표시하지 않는다.
 *
 *   BUSINESS_NAME            상호 (기본: 주식회사 이십세기 소년들)
 *   BUSINESS_CEO             대표자
 *   BUSINESS_REG_NO          사업자등록번호
 *   BUSINESS_MAIL_ORDER_NO   통신판매업 신고번호 (해당 시)
 *   BUSINESS_ADDRESS         주소
 *   BUSINESS_PHONE           대표 전화
 *   BUSINESS_EMAIL           대표 이메일
 */

export const DEFAULT_BUSINESS_NAME = '주식회사 이십세기 소년들';

export interface BusinessLine {
  label: string;
  value: string;
}

export interface BusinessInfo {
  name: string;
  lines: BusinessLine[];
}

const FIELDS: Array<{ key: string; label: string }> = [
  { key: 'BUSINESS_CEO', label: '대표자' },
  { key: 'BUSINESS_REG_NO', label: '사업자등록번호' },
  { key: 'BUSINESS_MAIL_ORDER_NO', label: '통신판매업 신고번호' },
  { key: 'BUSINESS_ADDRESS', label: '주소' },
  { key: 'BUSINESS_PHONE', label: '대표 전화' },
  { key: 'BUSINESS_EMAIL', label: '이메일' },
];

function clean(v: string | undefined): string {
  // 한 줄 표시용. 줄바꿈·연속 공백을 하나로 접고 지나치게 긴 값은 자른다.
  return (v ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** 환경변수(또는 주어진 원천)에서 사업자 정보를 읽는다. 비어 있는 항목은 결과에 넣지 않는다. */
export function readBusinessInfo(source: Record<string, string | undefined> = process.env): BusinessInfo {
  const name = clean(source.BUSINESS_NAME) || DEFAULT_BUSINESS_NAME;
  const lines: BusinessLine[] = [];
  for (const f of FIELDS) {
    const value = clean(source[f.key]);
    if (value) lines.push({ label: f.label, value });
  }
  return { name, lines };
}
