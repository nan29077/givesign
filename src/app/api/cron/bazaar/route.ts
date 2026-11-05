import { runCronJob } from '@/server/cron';
import { expireMatches } from '@/server/services/bazaar';
import { isLiveBazaarEnabled } from '@/server/services/bazaar-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 라이브 바자회 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/bazaar
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 매칭 수락 기한이 지난 제안을 만료로 바꾸고 기부 건을 접수 상태로 되돌린다(조건부 갱신이라 화면 조회와 겹쳐도 한 번만).
 * 예전에는 관리자 대시보드를 열 때만 돌았다(2026-11-06 점검 낮음). 스위치가 꺼져 있으면 일하지 않는다.
 * 인증·잠금(소유자 확인)·실행 기록은 공용 runCronJob 이 맡는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'bazaar', 600, async () => {
    if (!(await isLiveBazaarEnabled())) return { skipped: true, message: '라이브 바자회가 꺼져 있습니다.' };
    const expiredMatches = await expireMatches();
    return { expiredMatches };
  });
}
