/**
 * 시간 유틸.
 * - DB 저장은 UTC(timestamptz)
 * - 화면 표시/집계 기준일은 Asia/Seoul (KST, UTC+9, 서머타임 없음)
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function toKst(date: Date): Date {
  return new Date(date.getTime() + KST_OFFSET_MS);
}

/** KST 기준 YYYY-MM-DD */
export function kstDateKey(date = new Date()): string {
  const k = toKst(date);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}

/** KST 기준 YYYY-MM */
export function kstMonthKey(date = new Date()): string {
  const k = toKst(date);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * 해당 월의 마지막 날짜(YYYY-MM-DD).
 *
 * `${ym}-31` 로 쓰면 안 된다. JS 는 2026-02-31 을 2026-03-03 으로 굴려버려서
 * 다음 달 초 데이터가 이번 달 집계·원천징수 신고 자료에 섞여 들어간다.
 */
export function kstMonthEndKey(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return `${ym}-28`;
  // 다음 달 0일 = 이번 달 마지막 날
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(last).padStart(2, '0')}`;
}

/** KST 기준 하루의 시작(UTC Date 반환) */
export function kstStartOfDay(date = new Date()): Date {
  const k = toKst(date);
  const startKst = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 0, 0, 0, 0);
  return new Date(startKst - KST_OFFSET_MS);
}

export function kstStartOfMonth(date = new Date()): Date {
  const k = toKst(date);
  const startKst = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1, 0, 0, 0, 0);
  return new Date(startKst - KST_OFFSET_MS);
}

export function formatKst(date: Date | null | undefined, withSeconds = true): string {
  if (!date) return '-';
  const k = toKst(date);
  const p = (n: number) => String(n).padStart(2, '0');
  const base = `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p(k.getUTCSeconds())}` : base;
}

export function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}
