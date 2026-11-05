import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { runCronJob, CRON_HTTP_STATUS } from '@/server/cron';
import { runEmmaMoPolling } from '@/server/services/emma-mo-ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * EMMA MO 수신 폴링 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/emma-mo
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 왜 정리 배치(/api/cron/cleanup)에 얹지 않았나
 * ---------------------------------------------
 * 정리 배치는 여러 작업을 순서대로 돈다. 여기에 MO 폴링을 넣으면
 *  - 후원자가 문자를 보내고 결제 링크를 받기까지 배치 주기 + 앞선 작업 시간이 더해진다.
 *  - 정산·환불 배치가 느려지면 결제 접수까지 같이 밀린다.
 *  - 잠금 시간 안에 다 끝나지 않으면 잠금이 풀려 겹쳐 돈다.
 * 수신은 사용자를 기다리게 하는 경로이므로 **10~15초 주기의 독립 배치**로 분리한다.
 *
 * 겹쳐 도는 것에 대하여
 * ---------------------
 * 짧은 주기로 부르므로 이전 실행이 끝나기 전에 다음 호출이 올 수 있다. 잠금으로 막지만,
 * 잠금이 만료된 채로 겹치더라도 결과는 같다. 중복 결제는 잠금이 아니라
 * `mo_inbound_message (provider_code, provider_message_id)` UNIQUE 가 막는다.
 */

/**
 * 잠금 유지 시간.
 * 정상 실행은 1초 안에 끝나고 끝나면 즉시 잠금을 지운다. 이 값은 프로세스가 죽었을 때
 * 잠금이 영원히 남지 않게 하는 상한일 뿐이다.
 */
const LOCK_TTL_SEC = 50;

export async function GET(req: Request) {
  // 수신 배치라 잠금 저장소 장애 때도 돈다(failOpenLock — 레지스트리). 중복 결제는
  // `mo_inbound_message (provider_code, provider_message_id)` UNIQUE 가 막는다.
  // 끝날 때는 내 잠금일 때만 푼다(예전에는 무조건 지워, 겹친 다음 실행의 잠금까지 지웠다).
  return runCronJob(
    req,
    'emma-mo',
    LOCK_TTL_SEC,
    async () => {
      const started = Date.now();
      try {
        const result = await runEmmaMoPolling();
        const latencyMs = Date.now() - started;
        if (result.handed > 0 || result.failed > 0) {
          logger.info('EMMA MO 폴링', { fetched: result.fetched, handed: result.handed, skipped: result.skipped, failed: result.failed, latencyMs });
        }
        return {
          ok: result.failed === 0,
          at: new Date().toISOString(),
          latencyMs,
          fetched: result.fetched,
          handed: result.handed,
          skipped: result.skipped,
          failed: result.failed,
          // 상세는 운영 진단용이다. 전화번호·본문은 담기지 않는다(mo_key 와 결과 코드뿐).
          details: result.details,
        };
      } catch (e) {
        // 폴링 자체가 실패한 경우(예: EMMA DB 접속 불가). 다음 호출에서 다시 시도한다.
        const message = (e as Error).message;
        logger.error('EMMA MO 폴링 실패', { message });
        return { ok: false, message, [CRON_HTTP_STATUS]: 500 };
      }
    },
    {
      failOpenLock: true,
      // 꺼져 있는 것은 오류가 아니다. 스케줄러가 계속 호출해도 조용히 넘어간다.
      precheck: () => (env.emma.enabled ? null : { message: 'EMMA 연동이 꺼져 있습니다. (EMMA_ENABLED=false)' }),
    },
  );
}
