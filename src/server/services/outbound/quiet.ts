/**
 * 야간 보류(21~9시 KST) — 발송 대기열용. 저니 엔진(`journeys/engine.ts` isQuietHour·nextMorning)과 같은 기준·같은 스위치
 * (`JOURNEY_QUIET_HOURS=off` 로만 끔)다. 엔진을 import 하면 순환 참조가 생겨 같은 계산을 여기 둔다.
 */
const QUIET_START = 21;
const QUIET_END = 9;

export function outboundQuietEnabled() {
  return (process.env.JOURNEY_QUIET_HOURS ?? 'on') !== 'off';
}

export function isOutboundQuietHour(d: Date): boolean {
  if (!outboundQuietEnabled()) return false;
  const h = new Date(d.getTime() + 9 * 3_600_000).getUTCHours();
  return h >= QUIET_START || h < QUIET_END;
}

/** 다음 9시(KST) */
export function nextOutboundMorning(d: Date): Date {
  const k = new Date(d.getTime() + 9 * 3_600_000);
  const day = k.getUTCHours() >= QUIET_END ? 1 : 0;
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + day, QUIET_END, 0, 0) - 9 * 3_600_000);
}
