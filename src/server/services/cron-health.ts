import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { CRON_JOBS } from '@/server/cron-registry';
import { kstDateKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import { notifySuperAdmins } from './notifications';

/**
 * 배치 지연 감지·알림 (2026-11-13 점검 A-H1).
 *
 * 예전에는 관리자 '자동화' 화면을 열어야만 지연이 보였다. 배치가 멈춰도 아무도 알 수 없었다.
 *  - 지연 = 실행 기록이 있는 배치의 마지막 종료가 주기(intervalSec)의 3배를 넘음, 또는 마지막 실행이 실패.
 *    실행 기록이 아예 없는 배치(연동 꺼짐으로 건너뛰는 배치 등)는 지연으로 보지 않는다.
 *  - 알림은 최고관리자 콘솔 알림, 배치·날짜(KST)마다 한 번(system_setting 키 선점).
 *  - events 배치(1분)가 부른다. events 자체가 멈추면 이 알림도 멈추므로 관리자 대시보드에도 같은 판정을 보인다.
 */

export interface LateCronJob {
  name: string;
  description: string;
  lastFinishedAt: Date | null;
  lastOk: boolean | null;
  reason: 'LATE' | 'FAILED';
}

export async function lateCronJobs(now = new Date()): Promise<LateCronJob[]> {
  const beats = await prisma.cronHeartbeat.findMany();
  const byName = new Map(beats.map((b) => [b.name, b]));
  const out: LateCronJob[] = [];
  for (const def of CRON_JOBS) {
    const h = byName.get(def.name);
    if (!h) continue;
    const last = h.lastFinishedAt ?? h.lastStartedAt;
    const late = !last || now.getTime() - last.getTime() > def.intervalSec * 3000;
    if (late) out.push({ name: def.name, description: def.description, lastFinishedAt: h.lastFinishedAt, lastOk: h.lastOk, reason: 'LATE' });
    else if (h.lastOk === false) out.push({ name: def.name, description: def.description, lastFinishedAt: h.lastFinishedAt, lastOk: h.lastOk, reason: 'FAILED' });
  }
  return out;
}

export async function alertLateCronJobs(now = new Date()): Promise<number> {
  let sent = 0;
  try {
    const late = await lateCronJobs(now);
    const day = kstDateKey(now);
    for (const j of late) {
      const key = `cron-alert:${j.name}:${j.reason}:${day}`;
      const first = await prisma.systemSetting.createMany({
        data: [{ key, value: { at: now.toISOString() } as Prisma.InputJsonValue, memo: '배치 지연 알림 1회' }],
        skipDuplicates: true,
      });
      if (first.count !== 1) continue;
      await notifySuperAdmins({
        title: j.reason === 'LATE' ? `배치 지연 — ${j.name}` : `배치 실패 — ${j.name}`,
        body:
          j.reason === 'LATE'
            ? `${j.description} 배치가 정해진 주기의 3배가 넘도록 끝나지 않았습니다. 스케줄러(또는 서버 내장 실행기) 상태를 확인해 주세요.`
            : `${j.description} 배치의 마지막 실행이 실패했습니다. 자동화 > 배치·이벤트에서 오류를 확인해 주세요.`,
        linkUrl: '/admin/automation',
      });
      sent += 1;
    }
  } catch (e) {
    logger.warn('배치 지연 알림 실패', { message: (e as Error).message });
  }
  return sent;
}
