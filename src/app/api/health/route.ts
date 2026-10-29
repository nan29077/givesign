import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { kv } from '@/server/redis';
import { env, assertProductionSafety } from '@/lib/env';
import { getSessionUser } from '@/server/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 시스템 상태 및 외부 연동 모드 점검 */
export async function GET() {
  const checks: Record<string, string> = {};

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = 'ok';
  } catch (e) {
    checks.database = `error: ${(e as Error).message}`;
  }

  try {
    // ALB 헬스체크가 30초마다 여러 인스턴스에서 들어오므로 매 호출 쓰기를 피하고,
    // 연결 가능 여부만 확인하는 읽기 전용 점검으로 대체한다(값이 null 이어도 ok).
    await kv.get('health:ping');
    checks.cache = 'ok';
  } catch (e) {
    checks.cache = `error: ${(e as Error).message}`;
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');

  // 공개 응답은 최소 정보만 담는다.
  // 연동 사업자·안전모드·설정 경고는 내부 정찰에 그대로 쓰일 수 있어 관리자에게만 노출한다.
  const user = await getSessionUser().catch(() => null);
  if (user?.role !== 'ADMIN') {
    return NextResponse.json({ ok: healthy }, { status: healthy ? 200 : 503 });
  }

  return NextResponse.json(
    {
      ok: healthy,
      env: env.appEnv,
      safeMode: env.safety.safeMode,
      allowDirectTrigger: env.safety.allowDirectTrigger,
      providers: {
        payment: env.payment.provider,
        mo: env.mo.provider,
        mt: env.mt.provider,
      },
      checks,
      productionWarnings: assertProductionSafety(),
      at: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}
