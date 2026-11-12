import { CRON_JOBS, type CronDef, type CronWhen } from '@/server/cron-registry';

/**
 * 내장 배치 실행기 (2026-11-13 점검 A-H1).
 *
 * 배치(/api/cron/*)는 밖에서 주기적으로 불러 줘야 돈다. 운영(AWS)은 EventBridge 에 등록하지만,
 * PC 에서 서버만 띄우는 운영에서는 아무도 부르지 않아 감사장·영수증 안내·정기 출금·월간 안내가 한 건도 나가지 않았다.
 *
 * 그래서 서버가 뜨면 이 실행기가 등록부(cron-registry.ts)의 주기대로 **자기 자신의 배치 주소를 HTTP 로 부른다**.
 *  - 인증·잠금·실행 기록은 라우트의 공용 runCronJob 이 그대로 맡는다(겹쳐 불려도 잠금이 막는다). 업무 코드를 직접 부르지 않는다.
 *  - CRON_RUNNER=internal(기본) | external(외부 스케줄러만 — AWS 등) | off. 테스트(Vitest)·빌드 중에는 돌지 않는다.
 *  - 정해진 시각 배치(매일 10:00 등)는 서버가 그 시각에 꺼져 있었다면 켜진 뒤 한 번 따라잡는다
 *    (마지막 실행 기록 cron_heartbeat.last_started_at 이 그 시각보다 이르면). 매월 1~5일처럼 날짜가 정해진 배치는 그날만.
 *  - 같은 프로세스에서 한 배치는 한 번에 하나만 부른다(앞선 호출이 끝나지 않았으면 건너뜀).
 */

const TICK_MS = 15_000;
const KST = 9 * 3_600_000;

export type CronRunnerMode = 'internal' | 'external' | 'off';

export function cronRunnerMode(): CronRunnerMode {
  const v = (process.env.CRON_RUNNER ?? '').trim().toLowerCase();
  if (v === 'external' || v === 'off') return v;
  if (process.env.VITEST || process.env.NODE_ENV === 'test') return 'off';
  return 'internal';
}

/**
 * 가장 최근의 예정 시각(≤ now). 매 N초 배치는 null(간격으로만 판단).
 * dailyAtKst 에 days 가 있으면 그 날짜(KST)의 예정 시각만 본다.
 */
export function lastScheduledAt(when: CronWhen, now: Date): Date | null {
  if ('everySec' in when) return null;
  if ('hourlyAtMin' in when) {
    const t = new Date(now);
    t.setUTCMinutes(when.hourlyAtMin, 0, 0);
    if (t > now) t.setTime(t.getTime() - 3_600_000);
    return t;
  }
  // dailyAtKst — 오늘·어제(KST) 중 now 이하의 가장 늦은 시각
  const k = new Date(now.getTime() + KST);
  let best: Date | null = null;
  for (const back of [0, 1]) {
    const y = k.getUTCFullYear();
    const m = k.getUTCMonth();
    const d = k.getUTCDate() - back;
    const day = new Date(Date.UTC(y, m, d)).getUTCDate();
    if (when.days && !when.days.includes(day)) continue;
    for (const hm of when.dailyAtKst) {
      const [hh, mm] = hm.split(':').map(Number) as [number, number];
      const at = new Date(Date.UTC(y, m, d, hh, mm) - KST);
      if (at <= now && (!best || at > best)) best = at;
    }
    if (best) break;
  }
  return best;
}

/** 지금 불러야 하는지. lastRun 은 이 배치를 마지막으로 시작한 시각(없으면 null). */
export function isCronDue(when: CronWhen, now: Date, lastRun: Date | null): boolean {
  if ('everySec' in when) return !lastRun || now.getTime() - lastRun.getTime() >= when.everySec * 1000 - 1000;
  const at = lastScheduledAt(when, now);
  if (!at) return false;
  // 따라잡기는 하루 안의 것만(오래 꺼져 있던 서버가 켜지자마자 지난 몇 주 치를 한꺼번에 돌리지 않게 — 시각 배치는 한 번이면 된다)
  if (now.getTime() - at.getTime() > 24 * 3_600_000) return false;
  return !lastRun || lastRun < at;
}

type RunnerState = { timer: ReturnType<typeof setInterval> | null; lastRun: Map<string, Date>; inFlight: Set<string>; seeded: boolean };

const g = globalThis as unknown as { __givesignCronRunner?: RunnerState };

function baseUrl(): string {
  const port = process.env.PORT || '3060';
  return (process.env.CRON_RUNNER_BASE_URL || `http://127.0.0.1:${port}`).replace(/\/$/, '');
}

async function call(def: CronDef, state: RunnerState) {
  state.inFlight.add(def.name);
  state.lastRun.set(def.name, new Date());
  try {
    const secret = process.env.CRON_SECRET ?? '';
    const res = await fetch(`${baseUrl()}${def.path}`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
      signal: AbortSignal.timeout(Math.max(def.lockTtlSec, 60) * 1000),
      cache: 'no-store',
    });
    if (res.status >= 400) console.warn(`[cron-runner] ${def.name} 응답 ${res.status}`);
    await res.body?.cancel().catch(() => undefined);
  } catch (e) {
    console.warn(`[cron-runner] ${def.name} 호출 실패: ${(e as Error).message}`);
  } finally {
    state.inFlight.delete(def.name);
  }
}

/** 기동 직후 한 번: 마지막 실행 기록으로 시각 배치의 따라잡기 기준을 잡는다(재시작마다 다시 돌지 않게). */
async function seedFromHeartbeats(state: RunnerState) {
  try {
    const { prisma } = await import('@/server/db');
    const rows = await prisma.cronHeartbeat.findMany({ select: { name: true, lastStartedAt: true } });
    for (const r of rows) if (r.lastStartedAt && !state.lastRun.has(r.name)) state.lastRun.set(r.name, r.lastStartedAt);
    state.seeded = true;
  } catch (e) {
    console.warn(`[cron-runner] 실행 기록을 읽지 못했습니다(다음 틱에 다시): ${(e as Error).message}`);
  }
}

export async function cronTick(state: RunnerState, now = new Date()) {
  if (!state.seeded) await seedFromHeartbeats(state);
  if (!state.seeded) return;
  for (const def of CRON_JOBS) {
    if (state.inFlight.has(def.name)) continue;
    if (!isCronDue(def.when, now, state.lastRun.get(def.name) ?? null)) continue;
    void call(def, state);
  }
}

export function startCronRunner() {
  if (cronRunnerMode() !== 'internal') return false;
  if (process.env.NEXT_PHASE === 'phase-production-build') return false;
  if (g.__givesignCronRunner?.timer) return false;
  const state: RunnerState = { timer: null, lastRun: new Map(), inFlight: new Set(), seeded: false };
  state.timer = setInterval(() => void cronTick(state).catch((e) => console.warn(`[cron-runner] ${(e as Error).message}`)), TICK_MS);
  state.timer.unref?.();
  g.__givesignCronRunner = state;
  console.info(`[cron-runner] 내장 배치 실행기를 켰습니다(${CRON_JOBS.length}개, ${baseUrl()}). 외부 스케줄러를 쓰면 CRON_RUNNER=external.`);
  return true;
}
