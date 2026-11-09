import { runCronJob } from '@/server/cron';
import { runContentReviewAlerts } from '@/server/services/content-review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 콘텐츠 승인 알림 배치 (2026-11-09).
 *
 *   GET /api/cron/content-review
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 15분마다 호출한다. 월요일 09시(KST) 이후 첫 실행에 그 주 검토 대기 건수를, 캘린더 게시 시각 하루 전·3시간 전에 미승인 건을
 * 기관 콘솔 알림으로 보낸다. (기관·주) / (콘텐츠·슬롯 시각·시점) 키로 한 번만 보낸다(content_review_alert).
 * 콘텐츠는 승인 없이 게시되지 않으므로 이 배치는 알리기만 한다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'content-review', 300, async () => ({ ...(await runContentReviewAlerts()) }));
}
