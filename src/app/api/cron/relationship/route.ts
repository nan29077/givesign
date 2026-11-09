import { runCronJob } from '@/server/cron';
import { runRelationshipCron } from '@/server/services/relationship-messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 관계 확장 안내 배치 (1시간마다, 2026-11-13 5차 L4).
 *   GET /api/cron/relationship   Authorization: Bearer ${CRON_SECRET}
 * 전역 스위치(relationship_messages.enabled, 기본 꺼짐)가 꺼져 있으면 아무것도 계산·발송하지 않는다.
 * 켜져 있으면: 기관별 주간 대상 묶음 → 승인 요청, 승인분 발송(야간 21~8시 금지), 발송 후 7일 수신 거부율 감시(2% 초과 자동 중지).
 */
export async function GET(req: Request) {
  return runCronJob(req, 'relationship', 600, async () => ({ ...(await runRelationshipCron()) }));
}
