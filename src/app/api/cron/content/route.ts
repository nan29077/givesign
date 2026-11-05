import { runCronJob } from '@/server/cron';
import { processContentQueue } from '@/server/services/content';
import { runContentCalendar } from '@/server/services/content-calendar';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 콘텐츠 배치: 콘텐츠 캘린더(자율 생성) · 멈춘 생성 재개 · SNS 예약 게시 · 게시물 지표 수집.
 *
 *   GET /api/cron/content
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 1시간마다 호출한다. 캘린더는 (기관, 슬롯 시각) 유니크로 같은 슬롯을 두 번 만들지 않는다.
 * 게시는 (콘텐츠, 플랫폼) 당 1회이고 예약 → 게시 중 전환을 조건부 갱신으로 잡아 겹쳐 돌아도 두 번 올라가지 않는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'content', 900, async () => {
    const calendar = await runContentCalendar();
    const queue = await processContentQueue();
    return { ...queue, calendarCreated: calendar.created, calendarScheduled: calendar.autoScheduled, calendarFailed: calendar.failed };
  });
}
