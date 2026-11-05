import { runCronJob } from '@/server/cron';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { advanceDueJourneyRuns } from '@/server/services/journeys/engine';
import { expireApprovals, recoverStaleApprovals, runQueuedApprovals } from '@/server/services/approvals';
import { emitShiftReminders } from '@/server/services/journeys/reminders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 도메인 이벤트 처리 배치 (외부 스케줄러 → 기브싸인, 1분마다).
 *
 *   GET /api/cron/events
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 결제·약정·봉사·영수증 트랜잭션이 함께 남긴 이벤트를 소비자(기관 알림·명단 연결·목표 달성·저니)에게 나눠 준다.
 * (이벤트, 소비자) 1회 — 실패한 소비자만 백오프로 다시 돈다. 업무 결과는 바꾸지 않는다.
 */
export async function GET(req: Request) {
  registerDefaultConsumers();
  return runCronJob(req, 'events', 300, async () => {
    // 봉사 회차 전날 안내 이벤트(9~21시, 신청·회차마다 한 번) → 같은 배치에서 저니가 처리한다.
    const reminders = await emitShiftReminders();
    const events = await processDomainEvents({ limit: 300 });
    // 기한이 된 저니 실행(대기·보류가 끝난 것)을 이어 간다.
    const journeys = await advanceDueJourneyRuns({ limit: 300 });
    const approvalsExpired = await expireApprovals();
    // 처리 도중 끊긴 승인(PROCESSING 15분)은 다시 승인 대기로, 승인된 일괄 발급(QUEUED)은 시간 상한 안에서 이어서 실행(점검 A-1).
    const approvalsRecovered = await recoverStaleApprovals();
    const approvalsRun = await runQueuedApprovals({ budgetMs: 60_000 });
    return { reminders, events, journeys, approvalsExpired, approvalsRecovered, approvalsRun };
  });
}
