import { runCronJob } from '@/server/cron';
import { flushDueOutbound } from '@/server/services/outbound/coordinator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 통합 발송 관리 배치 (외부 스케줄러 → 기브싸인, 1분마다).
 *
 *   GET /api/cron/outbound
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 기한이 된 관계·정보형 안내(발송 대기열)를 후원자 단위로 묶어 한 통으로 보낸다(7일 상한·야간·담당자 확인 보류 적용).
 * 발송 중 멈춘 안내는 다시 보내지 않고 결과 미확인으로 닫는다. 인증·잠금·실행 기록은 공용 runCronJob 이 맡는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'outbound', 55, async () => {
    const r = await flushDueOutbound();
    return { ...r };
  });
}
