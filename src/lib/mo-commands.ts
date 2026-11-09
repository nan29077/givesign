import { normalizeCampaignCode, reservedKeywordKind } from './fundraising';

/**
 * 문자 명령어 (2026-11-12 4차 K3).
 *
 * 기관 번호로 이 단어를 보내면 후원(결제 건)이 아니라 본인 확인이 필요한 화면 링크로 답한다.
 * 기존 예약어(정기·봉사 — RESERVED_MO_KEYWORDS)와 별개 목록이다:
 *  - 기존 예약어는 캠페인 키워드 검증(campaignSchema)에서 막혀 있고 그대로 둔다.
 *  - 명령어는 **새로 만드는** 캠페인·홍보물·별칭에서만 막는다. 이미 이 단어를 키워드로 쓰는 캠페인이 있으면
 *    그 캠페인 키워드가 우선한다(문자 처리에서 명령어로 보지 않음) — 기존 동작을 깨지 않기 위한 대표 결정 대기 사항.
 * 비교는 normalizeCampaignCode 기준(공백·기호 제거, 대문자).
 */
export const MO_COMMAND_KEYWORDS = {
  RECEIPT: ['영수증', '기부금영수증', '영수증발급', '연말정산'],
  HISTORY: ['내역', '후원내역', '기부내역', '결제내역'],
  CHANGE: ['변경', '정기변경', '후원변경', '금액변경'],
  CANCEL: ['해지', '정기해지', '후원해지', '해지신청'],
  INQUIRY: ['문의', '상담', '문의하기'],
} as const;
export type MoCommandKind = keyof typeof MO_COMMAND_KEYWORDS;
export const MO_COMMAND_KINDS = Object.keys(MO_COMMAND_KEYWORDS) as MoCommandKind[];

export const MO_COMMAND_LABEL: Record<MoCommandKind, string> = {
  RECEIPT: '영수증',
  HISTORY: '후원 내역',
  CHANGE: '정기후원 변경',
  CANCEL: '정기후원 해지',
  INQUIRY: '문의',
};

export function moCommandKind(token: string): MoCommandKind | null {
  const c = normalizeCampaignCode(token);
  if (!c) return null;
  for (const kind of MO_COMMAND_KINDS) {
    if (MO_COMMAND_KEYWORDS[kind].some((w) => normalizeCampaignCode(w) === c)) return kind;
  }
  return null;
}

/** 기존 예약어 또는 명령어인가(새 키워드·홍보물·별칭 검증용). */
export function isMoReservedWord(code: string): boolean {
  return Boolean(reservedKeywordKind(code) || moCommandKind(code));
}

/** 화면 안내용: 모든 명령어(대표 단어) */
export const MO_COMMAND_WORDS_TEXT = MO_COMMAND_KINDS.map((k) => MO_COMMAND_KEYWORDS[k][0]).join('·');
