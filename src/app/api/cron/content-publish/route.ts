import { runCronJob } from '@/server/cron';
import { publishDueContent } from '@/server/services/content';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * SNS 예약 게시 배치 (외부 스케줄러 또는 내장 실행기 → 기브싸인, 5분마다). 2026-11-13 점검 A-M5.
 *
 *   GET /api/cron/content-publish
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 예전에는 1시간 콘텐츠 배치가 전 기관 콘텐츠 생성을 끝낸 뒤에야 게시해 예약 시각보다 최대 1시간 넘게 늦었다.
 * 1시간 배치도 놓친 것을 함께 올린다(예약 → 게시 중 전환이 조건부라 두 배치가 겹쳐도 한 번만 올라간다).
 */
export async function GET(req: Request) {
  return runCronJob(req, 'content-publish', 280, async () => ({ ...(await publishDueContent(new Date(), { limit: 100, budgetMs: 240_000 })) }));
}
