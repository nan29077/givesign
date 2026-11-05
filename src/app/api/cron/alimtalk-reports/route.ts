import { logger } from '@/lib/logger';
import { runCronJob } from '@/server/cron';
import { processAlimtalkReports } from '@/server/services/alimtalk-reports';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 알림톡 전달 결과 확인 배치 (2026-11-06 점검 A-5).
 *
 *   GET /api/cron/alimtalk-reports
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 접수(ACCEPTED)된 알림톡의 최종 결과를 공급자(솔라피)에 조회한다. 수신 완료 → SENT,
 * 명시적 실패 코드 → 같은 본문을 문자로 1회 대체(fallback=true), 2시간 넘게 결과가 없으면 UNKNOWN(자동 재발송 없음).
 */
export async function GET(req: Request) {
  return runCronJob(req, 'alimtalk-reports', 240, async () => {
    const result = await processAlimtalkReports();
    if (result.checked || result.unknown) logger.info('알림톡 전달 결과 확인 배치', { ...result });
    return { ...result };
  });
}
