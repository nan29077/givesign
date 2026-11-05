import { logger } from '@/lib/logger';
import { runCronJob } from '@/server/cron';
import { expireEDocSubscriptions } from '@/server/services/edoc-billing';
import { expireEDocEnvelopes, reconcileClosedEnvelopes } from '@/server/services/edoc';
import { cleanupUnreferencedFontAssets } from '@/server/services/pdf-form/font-assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 전자문서 만료 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/edoc
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 한 번 이상 호출한다. 기간이 끝난 30일 정액을 마감하고(남은 제공량 소멸 기록),
 * 서명 기한이 지난 서명 요청을 만료로 바꾼다. 끝난 봉투의 결과를 발급 문서·약정서에 다시 맞춘다. 돈을 받거나 내보내지 않는다.
 * 원본 서식 편집용으로 올렸지만 어느 서식에도 쓰이지 않은 채 오래된 글꼴 파일도 정리한다.
 * 인증·잠금(소유자 확인)·실행 기록은 공용 runCronJob 이 맡는다.
 */
export async function GET(req: Request) {
  return runCronJob(req, 'edoc', 600, async () => {
    const subscriptions = await expireEDocSubscriptions();
    const envelopes = await expireEDocEnvelopes();
    // 끝난 봉투인데 발급 문서·약정서가 아직 "요청됨" 인 것을 맞춘다(반영 실패 복구 — 점검 A-M7).
    const reconciled = await reconcileClosedEnvelopes().catch((e) => {
      logger.warn('전자문서 결과 대사 실패', { message: (e as Error).message });
      return null;
    });
    // 글꼴 정리 실패는 만료 처리 결과를 바꾸지 않는다.
    const fonts = await cleanupUnreferencedFontAssets().catch((e) => {
      logger.warn('쓰이지 않는 글꼴 정리 실패', { message: (e as Error).message });
      return null;
    });
    return { subscriptions, envelopes, reconciled, fonts };
  });
}
