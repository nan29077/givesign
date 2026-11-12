import { runCronJob } from '@/server/cron';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { advanceDueJourneyRuns, stopExpiredJourneyApprovals } from '@/server/services/journeys/engine';
import { alertLateCronJobs } from '@/server/services/cron-health';
import { expireApprovals, recoverStaleApprovals, runQueuedApprovals } from '@/server/services/approvals';
import { emitShiftReminders } from '@/server/services/journeys/reminders';
import { reassembleQueuedVideos } from '@/server/services/content';

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
    const reminders = await emitShiftReminders(new Date(), { throttle: true });
    const events = await processDomainEvents({ limit: 300 });
    // 기한이 된 저니 실행(대기·보류가 끝난 것)을 이어 간다.
    const journeys = await advanceDueJourneyRuns({ limit: 300 });
    const approvalsExpired = await expireApprovals();
    // 승인 기한(14일)이 지난 저니 실행은 멈춘다(2026-11-13 A-L3).
    const journeysExpired = await stopExpiredJourneyApprovals();
    // 처리 도중 끊긴 승인(PROCESSING 15분)은 다시 승인 대기로, 승인된 일괄 발급(QUEUED)은 시간 상한 안에서 이어서 실행(점검 A-1).
    const approvalsRecovered = await recoverStaleApprovals();
    const approvalsRun = await runQueuedApprovals({ budgetMs: 60_000 });
    // 담당자 수정 뒤 숏폼 영상 재조립 — 응답 뒤 실행이 끊긴 것을 1분 안에 이어 만든다(2026-11-12, 시간 상한 45초).
    const videos = await reassembleQueuedVideos({ limit: 3, budgetMs: 45_000 });
    // 다른 배치가 멈췄거나 실패하면 최고관리자에게 알린다(배치·날짜마다 1회, 2026-11-13 A-H1).
    const cronAlerts = await alertLateCronJobs();
    return { reminders, events, journeys, approvalsExpired, journeysExpired, approvalsRecovered, approvalsRun, videos, cronAlerts };
  });
}
