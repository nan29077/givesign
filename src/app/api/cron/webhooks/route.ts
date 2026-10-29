import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { drainWebhookQueue } from '@/server/services/webhooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 웹훅 재전송 배치 (외부 스케줄러 → 기브싸인).
 *
 *   GET /api/cron/webhooks
 *   Authorization: Bearer ${CRON_SECRET}
 *
 * 이벤트가 생기면 그 자리에서 한 번 보내 본다. 실패한 건만 여기로 넘어와
 * 간격을 늘려 가며 다시 시도한다(30초 → 2분 → 10분 → 1시간 → 6시간).
 * 다 쓰면 DEAD 가 되고, 사회복지기관이 화면이나 API 에서 수동으로 다시 보낼 수 있다.
 *
 * 인증은 fail-closed 다. 비밀이 없으면 로컬에서만 통과한다.
 */
function authorize(req: Request): boolean {
  const expected = env.cron.secret;
  if (!expected) return isLocal;
  const matched = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
  return matched ? safeEqual(expected, matched[1]!.trim()) : false;
}

export async function GET(req: Request) {
  if (!authorize(req)) {
    return NextResponse.json({ ok: false, message: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await drainWebhookQueue();
    if (result.tried > 0) logger.info('웹훅 재전송 배치', result);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logger.error('웹훅 재전송 배치 실패', { message: (e as Error).message });
    return NextResponse.json({ ok: false, message: (e as Error).message }, { status: 500 });
  }
}
