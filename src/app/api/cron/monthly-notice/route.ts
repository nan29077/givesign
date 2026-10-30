import { runCronJob } from '@/server/cron';
import { runMonthlyNotices } from '@/server/services/monthly-notice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 월간 후원 안내 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/monthly-notice
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 매월 1일 오전 10시(KST) 한 번 호출한다. 전월 후원자에게 안내를 보내고, 월별 영수증 기관은 먼저 발급한다.
 * (기관, 월) 당 한 번만 실행되고, 중간에 멈춘 실행은 다시 호출하면 남은 사람에게만 보낸다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'monthly-notice', 1800, async () => ({ ...(await runMonthlyNotices()) }));
}
