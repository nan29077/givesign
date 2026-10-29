import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { generateToken, safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
import { runRecurringDonations } from '@/server/services/recurring';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 정기후원 실행 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/recurring
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 한 번(권장 오전 10시 KST) 호출한다. 출금일이 도래한 ACTIVE 약정을 결제한다.
 *
 * 원칙
 *  - **돈이 나가는 배치다.** 겹쳐 도는 것을 막는 잠금을 반드시 잡는다.
 *  - 한 달에 한 번만 결제되도록 멱등키(`recurring:{id}:{yyyy-MM}`)에 걸린 건은 건너뛴다.
 *  - 한 약정의 실패가 다른 약정 실행을 막지 않는다.
 *  - 인증은 fail-closed. 비밀이 없으면 로컬에서만 통과한다.
 */

const LOCK_TTL_SEC = 900;
const LOCK_KEY = 'cron:recurring:lock';

function authorize(req: Request): { ok: boolean; reason?: string } {
  const expected = env.cron.secret;
  if (!expected) return isLocal ? { ok: true } : { ok: false, reason: 'CRON_SECRET 미설정' };
  const header = req.headers.get('authorization') ?? '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!matched) return { ok: false, reason: 'Authorization: Bearer 헤더 없음' };
  return safeEqual(expected, matched[1]!.trim()) ? { ok: true } : { ok: false, reason: '비밀 불일치' };
}

export async function GET(req: Request) {
  const auth = authorize(req);
  if (!auth.ok) {
    logger.warn('정기후원 배치 호출 거절', { reason: auth.reason });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }

  // 잠금 값에 이번 실행의 표식을 넣어, 끝날 때 내 잠금일 때만 푼다.
  // (TTL 이 지나 다른 실행이 잡은 잠금을 지우면 두 배치가 겹쳐 돈다)
  const owner = `${Date.now()}:${generateToken(8)}`;
  let locked: boolean;
  try {
    locked = await kv.setnx(LOCK_KEY, owner, LOCK_TTL_SEC);
  } catch (e) {
    logger.error('정기후원 배치 잠금 획득 실패 — 실행하지 않습니다', { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: '실행 잠금을 확인할 수 없어 배치를 건너뛰었습니다.' }, { status: 503 });
  }
  if (!locked) return NextResponse.json({ ok: true, skipped: true, message: '이전 실행이 아직 진행 중입니다.' });

  try {
    const result = await runRecurringDonations();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logger.error('정기후원 배치 실패', { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: '배치 실행 중 오류가 발생했습니다.' }, { status: 500 });
  } finally {
    const current = await kv.get(LOCK_KEY).catch(() => null);
    if (current === owner) await kv.del(LOCK_KEY).catch(() => undefined);
  }
}
