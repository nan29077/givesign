import { runCronJob } from '@/server/cron';
import { runRecurringDonations } from '@/server/services/recurring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 정기후원 실행 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/recurring
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 한 번(권장 오전 10시 KST) 호출한다. 출금일이 도래한 ACTIVE 약정을 결제한다.
 *
 * 원칙
 *  - **돈이 나가는 배치다.** 잠금을 못 잡으면 돌리지 않는다(runCronJob 기본 fail-closed, 소유자 확인 해제).
 *  - 한 달에 한 번만 결제되도록 멱등키(`recurring:{id}:{yyyy-MM}`)에 걸린 건은 건너뛴다.
 *  - 한 약정의 실패가 다른 약정 실행을 막지 않는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'recurring', 900, async () => ({ ...(await runRecurringDonations()) }));
}
