import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
import { runScheduledPayouts } from '@/server/services/auto-settlement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 자동 정산 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/payout
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 한 번, 은행 영업시간 안(예: 오전 10시)에 호출한다.
 * 지급일이 도래한 결제를 모아 사회복지기관 계좌로 이체한다.
 *
 * 원칙
 *  - **돈이 나가는 배치다.** 겹쳐 도는 것을 막는 잠금을 반드시 잡는다.
 *  - 같은 날 두 번 호출돼도 이미 처리된 사회복지기관은 멱등키에 걸려 건너뛴다.
 *  - 한 사회복지기관의 실패가 다른 사회복지기관 지급을 막지 않는다.
 *  - 인증은 fail-closed. 비밀이 없으면 로컬에서만 통과한다.
 */

/** 잠금 유지 시간. 사회복지기관 수가 늘어도 겹치지 않도록 넉넉히 잡는다. */
const LOCK_TTL_SEC = 600;
const LOCK_KEY = 'cron:payout:lock';

function authorize(req: Request): { ok: boolean; reason?: string } {
  const expected = env.cron.secret;
  if (!expected) {
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
    logger.warn('자동 정산 배치 호출 거절', { reason: auth.reason });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }

  // 돈이 나가는 배치다. 잠금을 못 잡으면 돌리지 않는다.
  // Redis 오류를 "잠금 획득"으로 바꾸면(예전 .catch(() => true)) 겹쳐 도는 것을 막는
  // 유일한 장치가 장애 때 정확히 사라진다.
  let locked: boolean;
  try {
    locked = await kv.setnx(LOCK_KEY, String(Date.now()), LOCK_TTL_SEC);
  } catch (e) {
    logger.error('자동 정산 배치 잠금 획득 실패 — 실행하지 않습니다', { message: (e as Error).message });
    return NextResponse.json(
      { ok: false, message: '실행 잠금을 확인할 수 없어 배치를 건너뛰었습니다.' },
      { status: 503 },
    );
  }
  if (!locked) {
    return NextResponse.json({ ok: true, skipped: true, message: '이전 실행이 아직 진행 중입니다.' });
  }

  try {
    const result = await runScheduledPayouts();
    return NextResponse.json({
      ok: true,
      dateKey: result.dateKey,
      checked: result.checked,
      paid: result.paid,
      failed: result.failed,
      skipped: result.skipped,
      totalPaid: result.totalPaid.toString(),
      details: result.details.map((d) => ({ ...d, amount: d.amount.toString() })),
    });
  } catch (e) {
    logger.error('자동 정산 배치 실패', { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: '배치 실행 중 오류가 발생했습니다.' }, { status: 500 });
  } finally {
    await kv.del(LOCK_KEY).catch(() => undefined);
  }
}
