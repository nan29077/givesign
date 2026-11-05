import { logger } from '@/lib/logger';
import { runCronJob } from '@/server/cron';
import { drainWebhookQueue } from '@/server/services/webhooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 웹훅 재전송 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/webhooks
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 이벤트가 생기면 그 자리에서 한 번 보내 본다. 실패한 건만 여기로 넘어와
 * 간격을 늘려 가며 다시 시도한다(30초 → 2분 → 10분 → 1시간 → 6시간).
 * 다 쓰면 DEAD 가 되고, 사회복지기관이 화면이나 API 에서 수동으로 다시 보낼 수 있다.
 *
 * 예전에는 잠금이 없어 짧은 주기 호출이 겹치면 같은 전송을 두 번 시도할 수 있었다(적재 리스가 막아 주긴 했다).
 * 이제 공용 runCronJob 잠금 + 실행 기록을 쓴다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'webhooks', 120, async () => {
    const result = await drainWebhookQueue();
    if (result.tried > 0) logger.info('웹훅 재전송 배치', result);
    return { ...result };
  });
}
