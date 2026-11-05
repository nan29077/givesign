import { runCronJob } from '@/server/cron';
import { runScheduledPayouts } from '@/server/services/auto-settlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 자동 정산 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/payout
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 한 번, 은행 영업시간 안(예: 오전 10시)에 호출한다.
 * 지급일이 도래한 결제를 모아 사회복지기관 계좌로 이체한다.
 *
 * 원칙
 *  - **돈이 나가는 배치다.** 잠금을 못 잡으면(저장소 장애 포함) 돌리지 않는다 — runCronJob 기본값(fail-closed).
 *  - 같은 날 두 번 호출돼도 이미 처리된 사회복지기관은 멱등키에 걸려 건너뛴다.
 *  - 한 사회복지기관의 실패가 다른 사회복지기관 지급을 막지 않는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'payout', 600, async () => {
    const result = await runScheduledPayouts();
    return {
      dateKey: result.dateKey,
      checked: result.checked,
      paid: result.paid,
      failed: result.failed,
      skipped: result.skipped,
      totalPaid: result.totalPaid.toString(),
      details: result.details.map((d) => ({ ...d, amount: d.amount.toString() })),
    };
  });
}
