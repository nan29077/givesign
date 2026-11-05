import { NextResponse } from 'next/server';
import { env, isLocal } from '@/lib/env';
import { generateToken, safeEqual } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kv } from '@/server/redis';
import { prisma } from '@/server/db';
import { cronDef } from '@/server/cron-registry';

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

/** job 결과에 이 키로 숫자를 넣으면 응답 상태 코드로 쓴다(본문에서는 빠진다). 예: 일부 단계 실패 → 500. */
export const CRON_HTTP_STATUS = '__httpStatus' as const;

/** 실행 기록. 기록 실패가 배치 결과를 바꾸지 않는다. */
async function heartbeat(name: string, phase: 'start' | 'end', info: { ok?: boolean; status?: number; error?: string | null; durationMs?: number } = {}) {
  const now = new Date();
  try {
    if (phase === 'start') {
      await prisma.cronHeartbeat.upsert({
        where: { name },
        create: { name, lastStartedAt: now },
        update: { lastStartedAt: now },
      });
    } else {
      await prisma.cronHeartbeat.upsert({
        where: { name },
        create: {
          name, lastStartedAt: now, lastFinishedAt: now, lastOk: info.ok ?? null, lastStatus: info.status ?? null,
          lastError: info.error ?? null, lastDurationMs: info.durationMs ?? null, runCount: 1, failCount: info.ok ? 0 : 1,
        },
        update: {
          lastFinishedAt: now, lastOk: info.ok ?? null, lastStatus: info.status ?? null,
          lastError: info.error?.slice(0, 500) ?? null, lastDurationMs: info.durationMs ?? null,
          runCount: { increment: 1 }, ...(info.ok ? {} : { failCount: { increment: 1 } }),
        },
      });
    }
  } catch (e) {
    logger.warn('배치 실행 기록 실패', { name, message: (e as Error).message });
  }
}

export interface RunCronOptions {
  /** 잠금 저장소 장애 때도 실행한다(중복이 DB 유니크로 막히는 수신 배치 전용). 기본은 레지스트리 값. */
  failOpenLock?: boolean;
  /** 잠금을 잡기 전에 검사해 건너뛸 이유가 있으면 돌려준다(예: 연동 꺼짐). */
  precheck?: () => Record<string, unknown> | null;
}

/**
 * 배치 공용 실행기: 인증(fail-closed) → 사전 검사 → 잠금(소유자 표식) → 실행 → 실행 기록 → 내 잠금만 해제.
 * 잠금 TTL 은 레지스트리(cron-registry.ts) 값을 우선하고, 없으면 인자를 쓴다.
 */
export async function runCronJob(
  req: Request,
  name: string,
  lockTtlSec: number,
  job: () => Promise<Record<string, unknown>>,
  opts: RunCronOptions = {},
): Promise<NextResponse> {
  const auth = authorizeCron(req);
  if (!auth.ok) {
    logger.warn(`${name} 배치 호출 거절`, { reason: auth.reason });
    return NextResponse.json({ ok: false, message: '인증되지 않은 요청입니다.' }, { status: 401 });
  }
  const skip = opts.precheck?.();
  if (skip) return NextResponse.json({ ok: true, skipped: true, ...skip });

  const def = cronDef(name);
  const ttl = def?.lockTtlSec ?? lockTtlSec;
  const failOpen = opts.failOpenLock ?? def?.failOpenLock ?? false;
  const lockKey = `cron:${name}:lock`;
  const owner = `${Date.now()}:${generateToken(8)}`;
  let locked: boolean;
  try {
    locked = await kv.setnx(lockKey, owner, ttl);
  } catch (e) {
    if (!failOpen) {
      logger.error(`${name} 배치 잠금 획득 실패 — 실행하지 않습니다`, { message: (e as Error).message });
      return NextResponse.json({ ok: false, message: '실행 잠금을 확인할 수 없어 배치를 건너뛰었습니다.' }, { status: 503 });
    }
    logger.warn(`${name} 배치 잠금 확인 불가 — 중복은 DB 유니크가 막으므로 실행합니다`, { message: (e as Error).message });
    locked = true;
  }
  if (!locked) return NextResponse.json({ ok: true, skipped: true, message: '이전 실행이 아직 진행 중입니다.' });
  const started = Date.now();
  await heartbeat(name, 'start');
  try {
    const { [CRON_HTTP_STATUS]: status, ...result } = await job();
    const code = typeof status === 'number' ? status : 200;
    await heartbeat(name, 'end', { ok: code < 400, status: code, durationMs: Date.now() - started, error: code < 400 ? null : String(result.message ?? '') });
    return NextResponse.json({ ok: true, ...result }, { status: code });
  } catch (e) {
    const message = (e as Error).message;
    logger.error(`${name} 배치 실패`, { message });
    await heartbeat(name, 'end', { ok: false, status: 500, durationMs: Date.now() - started, error: message });
    return NextResponse.json({ ok: false, message: '배치 실행 중 오류가 발생했습니다.' }, { status: 500 });
  } finally {
    const current = await kv.get(lockKey).catch(() => null);
    if (current === owner) await kv.del(lockKey).catch(() => undefined);
  }
}
