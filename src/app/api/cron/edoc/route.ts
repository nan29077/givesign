import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { generateToken, safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
import { expireEDocSubscriptions } from '@/server/services/edoc-billing';
import { expireEDocEnvelopes } from '@/server/services/edoc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 전자문서 만료 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/edoc
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 하루 한 번 이상 호출한다. 기간이 끝난 30일 정액을 마감하고(남은 제공량 소멸 기록),
 * 서명 기한이 지난 서명 요청을 만료로 바꾼다. 돈을 받거나 내보내지 않는다.
 */

const LOCK_TTL_SEC = 600;
const LOCK_KEY = 'cron:edoc:lock';

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
    logger.warn('전자문서 배치 호출 거절', { reason: auth.reason });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }

  // 잠금 값에 이번 실행의 표식을 넣어, 끝날 때 내 잠금일 때만 푼다.
  // (TTL 이 지나 다른 실행이 잡은 잠금을 지우면 두 배치가 겹쳐 돈다)
  const owner = `${Date.now()}:${generateToken(8)}`;
  let locked: boolean;
  try {
    locked = await kv.setnx(LOCK_KEY, owner, LOCK_TTL_SEC);
  } catch (e) {
    logger.error('전자문서 배치 잠금 획득 실패 — 실행하지 않습니다', { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: '실행 잠금을 확인할 수 없어 배치를 건너뛰었습니다.' }, { status: 503 });
  }
  if (!locked) return NextResponse.json({ ok: true, skipped: true, message: '이전 실행이 아직 진행 중입니다.' });

  try {
    const subscriptions = await expireEDocSubscriptions();
    const envelopes = await expireEDocEnvelopes();
    return NextResponse.json({ ok: true, subscriptions, envelopes });
  } catch (e) {
    logger.error('전자문서 배치 실패', { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: '배치 실행 중 오류가 발생했습니다.' }, { status: 500 });
  } finally {
    const current = await kv.get(LOCK_KEY).catch(() => null);
    if (current === owner) await kv.del(LOCK_KEY).catch(() => undefined);
  }
}
