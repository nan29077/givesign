import { runCronJob } from '@/server/cron';
import { generatePlannedSlots, runCampaignPaceCheck } from '@/server/services/campaign-setup';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 캠페인 운영 배치 (2026-11-12 4차 I).
 *
 *   GET /api/cron/campaign-ops
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 1시간마다. 개설 마법사가 잡은 콘텐츠 일정 슬롯(PLANNED) 중 7일 안으로 들어온 것의 콘텐츠를 만들어 **검토 대기**로 올리고
 * (게시는 담당자 승인 뒤), 기간 70% 경과·진행률 미달 캠페인에 기관 알림을 1회 보낸다. 후원자에게 아무것도 보내지 않는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'campaign-ops', 900, async () => {
    const planned = await generatePlannedSlots();
    const pace = await runCampaignPaceCheck();
    return { ...planned, paceChecked: pace.checked, paceAlerted: pace.alerted };
  });
}
