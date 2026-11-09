import { runCronJob } from '@/server/cron';
import { runSelfCheck } from '@/server/services/self-check';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 자가 진단 배치 (2026-11-12 4차 I2-6).
 *
 *   GET /api/cron/self-check
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 1회(08:00 KST). SNS 연결 만료 7일 전, 전자문서 잔액 소진 예상, 문자 후원 수신 급감을 보고 기관(급감은 관리자도)에
 * 콘솔 알림을 보낸다. 같은 알림은 self_check_alert 키로 1회.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'self-check', 900, async () => ({ ...(await runSelfCheck()) }));
}
