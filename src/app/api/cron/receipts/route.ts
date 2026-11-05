import { runCronJob } from '@/server/cron';
import { runAnnualReceiptPrep } from '@/server/services/receipt-batch';
import { registerDefaultConsumers } from '@/server/services/event-consumers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 연 1회 기부금영수증 준비 배치 (외부 스케줄러 → 기브싸인, 매일 09:00 KST — 1~2월에만 일한다).
 *
 *   GET /api/cron/receipts
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 발급 자체는 기관 담당자가 승인 대기함에서 승인해야 일어난다. 이 배치는 준비(대상 계산·승인 요청·등록 안내 이벤트)만 한다.
 */
export async function GET(req: Request) {
  registerDefaultConsumers();
  return runCronJob(req, 'receipts', 1800, async () => ({ ...(await runAnnualReceiptPrep()) }));
}
