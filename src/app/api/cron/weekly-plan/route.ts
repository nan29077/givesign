import { runCronJob } from '@/server/cron';
import { runWeeklyPlanJob } from '@/server/services/weekly-plan';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 주간 운영 계획·보고 배치 (2026-11-11 G).
 *
 *   GET /api/cron/weekly-plan
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 1시간마다 호출한다. 월요일 07시(KST) 이후 그 주 계획이 없는 기관에 (기관, 주) 1건을 만들고,
 * 월요일 09시 이후(21시 전) 기관 대표 담당자에게 보고 안내 1통을 보낸다(report_claimed_at 선점 — 1회).
 * 계획의 실행 제안은 승인 요청으로만 남고, 이 배치가 게시·후원자 발송을 하지 않는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'weekly-plan', 600, async () => ({ ...(await runWeeklyPlanJob()) }));
}
