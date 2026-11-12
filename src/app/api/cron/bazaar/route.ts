import { runCronJob } from '@/server/cron';
import { expireMatches, runBazaarSettlementAutomation } from '@/server/services/bazaar';
import { remindExpiringMatches } from '@/server/services/bazaar-notify';
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
    const now = new Date();
    // 정산은 스위치와 무관하다 — 꺼져도 확정된 정산은 계속 지급한다(2026-11-05 결정). 지난달 집계 자동 생성·지급일 알림(2026-11-13 B-M5).
    const settlement = await runBazaarSettlementAutomation(now);
    if (!(await isLiveBazaarEnabled())) return { skipped: true, message: '라이브 바자회가 꺼져 있어 매칭 처리는 건너뜁니다.', ...settlement };
    const expiredMatches = await expireMatches(now);
    // 수락 기한 하루 전 재알림(제안당 1회, 2026-11-13 B-M2)
    const reminded = await remindExpiringMatches(now);
    return { expiredMatches, reminded, ...settlement };
  });
}
