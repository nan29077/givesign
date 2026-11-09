import { runCronJob } from '@/server/cron';
import { processInquiryTriage } from '@/server/services/inquiry-auto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 문의 자동 응대 배치 (외부 스케줄러 → 기브싸인, 5분마다). 2026-11-12 4차 K4.
 *
 *   GET /api/cron/inquiry-auto
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 문자 '문의' 로 기관에 접수된 새 메시지를 분류한다. 기관이 켠 분류만 문의당 1회 자동 답변하고, 그 밖은 담당자에게 넘긴다.
 * 인증·잠금·실행 기록은 공용 runCronJob 이 맡는다. 문의 행 선점으로 겹친 실행에도 한 번만 답한다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'inquiry-auto', 240, async () => {
    const r = await processInquiryTriage({ deadline: Date.now() + 60_000 });
    return { ...r };
  });
}
