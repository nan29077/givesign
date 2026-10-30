import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { generateToken, safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';

/**
 * 배치 라우트 공용 인증·잠금 (정기후원 배치와 같은 규칙).
 *
 *  - 인증은 fail-closed. CRON_SECRET 이 없으면 로컬에서만 통과한다.
 *  - 겹쳐 도는 것을 막는 잠금을 잡고, 끝날 때 내 잠금일 때만 푼다.
 *  - 잠금 상태를 확인할 수 없으면 실행하지 않는다(503).
 */
export function authorizeCron(req: Request): { ok: boolean; reason?: string } {
  const expected = env.cron.secret;
  if (!expected) return isLocal ? { ok: true } : { ok: false, reason: 'CRON_SECRET 미설정' };
  const header = req.headers.get('authorization') ?? '';
  const matched = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!matched) return { ok: false, reason: 'Authorization: Bearer 헤더 없음' };
  return safeEqual(expected, matched[1]!.trim()) ? { ok: true } : { ok: false, reason: '비밀 불일치' };
}

export async function runCronJob(
  req: Request,
  name: string,
  lockTtlSec: number,
  job: () => Promise<Record<string, unknown>>,
): Promise<NextResponse> {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    logger.warn(`${name} 배치 호출 거절`, { reason: auth.reason });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }
  const lockKey = `cron:${name}:lock`;
  const owner = `${Date.now()}:${generateToken(8)}`;
  let locked: boolean;
  try {
    locked = await kv.setnx(lockKey, owner, lockTtlSec);
  } catch (e) {
    logger.error(`${name} 배치 잠금 획득 실패 — 실행하지 않습니다`, { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: '실행 잠금을 확인할 수 없어 배치를 건너뛰었습니다.' }, { status: 503 });
  }
  if (!locked) return NextResponse.json({ ok: true, skipped: true, message: '이전 실행이 아직 진행 중입니다.' });
  try {
    const result = await job();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logger.error(`${name} 배치 실패`, { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: '배치 실행 중 오류가 발생했습니다.' }, { status: 500 });
  } finally {
    const current = await kv.get(lockKey).catch(() => null);
    if (current === owner) await kv.del(lockKey).catch(() => undefined);
  }
}
