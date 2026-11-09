import { runCronJob } from '@/server/cron';
import { notifyOverdueInboxAssignments } from '@/server/services/inbox-assignments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 승인 대기함 배치 (외부 스케줄러 → 기브싸인, 1시간마다).
 *
 *   GET /api/cron/inbox
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 처리 기한이 지난 배정마다 기관 대표 담당자(기관 소유자 계정)에게 콘솔 알림을 한 번 보낸다(조건부 선점).
 * 항목이 이미 처리돼 대기함에서 사라졌으면 배정을 닫는다. 인증·잠금·실행 기록은 공용 runCronJob 이 맡는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'inbox', 600, async () => {
    const r = await notifyOverdueInboxAssignments();
    return { ...r };
  });
}
