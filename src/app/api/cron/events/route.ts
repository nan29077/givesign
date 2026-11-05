import { runCronJob } from '@/server/cron';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';

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
  return runCronJob(req, 'events', 240, async () => ({ ...(await processDomainEvents({ limit: 300 })) }));
}
