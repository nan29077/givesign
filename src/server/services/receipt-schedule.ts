import { kstDateKey } from '@/lib/datetime';

/**
 * "올해 영수증은 언제 발급되나요" 안내 (2026-11-09 2차 F). 순수 함수.
 * 기관 설정 `merchant_profile.receipt_cycle` 기준이며 실제 발급 규칙은 그대로다:
 *  - YEARLY : 다음 해 1~2월에 /api/cron/receipts 가 승인 요청을 올리고 담당자가 승인하면 발급(receipt-batch.ts).
 *  - MONTHLY: 매월 1일 월간 안내 배치가 그때까지의 올해 후원분을 발급(monthly-notice.ts).
 * 공익법인 확인 전이거나 영수증 정보가 없으면 발급되지 않는다는 것은 호출하는 화면이 따로 적는다.
 */
export function receiptScheduleNote(receiptCycle: string | null | undefined, now = new Date()): { month: string; text: string } {
  const today = kstDateKey(now);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  if (receiptCycle === 'MONTHLY') {
    const nextY = month === 12 ? year + 1 : year;
    const nextM = month === 12 ? 1 : month + 1;
    return {
      month: `${nextY}-${String(nextM).padStart(2, '0')}`,
      text: `이 기관은 매월 영수증을 발급합니다. 이번 달 후원분은 ${nextY !== year ? `${nextY}년 ` : ''}${nextM}월 초에 발급됩니다(기관 설정 기준).`,
    };
  }
  return {
    month: `${year + 1}-01`,
    text: `올해(${year}년) 후원 영수증은 ${year + 1}년 1월에 발급됩니다(기관 설정 기준, 담당자 확인 후 늦어도 2월).`,
  };
}
