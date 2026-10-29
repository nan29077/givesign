import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
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
const LOCK_KEY = 'cron:emma-mo:lock';

function authorize(req: Request): { ok: boolean; reason?: string } {
  const expected = env.cron.secret;
  if (!expected) {
    // 비밀 미설정: 로컬에서만 열어 둔다. 운영/스테이징에서는 어떤 호출도 받지 않는다.
    return isLocal ? { ok: true } : { ok: false, reason: 'CRON_SECRET 미설정' };
  }
  const header = req.headers.get('authorization') ?? '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!matched) return { ok: false, reason: 'Authorization: Bearer 헤더 없음' };
  return safeEqual(expected, matched[1]!.trim()) ? { ok: true } : { ok: false, reason: '비밀 불일치' };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    logger.warn('EMMA MO 폴링 호출 거절', { reason: auth.reason });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }

  if (!env.emma.enabled) {
    // 꺼져 있는 것은 오류가 아니다. 스케줄러가 계속 호출해도 조용히 넘어간다.
    return NextResponse.json({
      ok: true,
      skipped: true,
      message: 'EMMA 연동이 꺼져 있습니다. (EMMA_ENABLED=false)',
    });
  }

  const locked = await kv.setnx(LOCK_KEY, String(Date.now()), LOCK_TTL_SEC).catch(() => true);
  if (!locked) {
    return NextResponse.json({ ok: true, skipped: true, message: '이전 폴링이 아직 진행 중입니다.' });
  }

  const started = Date.now();
  try {
    const result = await runEmmaMoPolling();
    const latencyMs = Date.now() - started;

    if (result.handed > 0 || result.failed > 0) {
      logger.info('EMMA MO 폴링', {
        fetched: result.fetched,
        handed: result.handed,
        skipped: result.skipped,
        failed: result.failed,
        latencyMs,
      });
    }

    return NextResponse.json({
      ok: result.failed === 0,
      at: new Date().toISOString(),
      latencyMs,
      fetched: result.fetched,
      handed: result.handed,
      skipped: result.skipped,
      failed: result.failed,
      // 상세는 운영 진단용이다. 전화번호·본문은 담기지 않는다(mo_key 와 결과 코드뿐).
      details: result.details,
    });
  } catch (e) {
    // 폴링 자체가 실패한 경우(예: EMMA DB 접속 불가). 다음 호출에서 다시 시도한다.
    const message = (e as Error).message;
    logger.error('EMMA MO 폴링 실패', { message });
    return NextResponse.json({ ok: false, message }, { status: 500 });
  } finally {
    await kv.del(LOCK_KEY).catch(() => undefined);
  }
}
