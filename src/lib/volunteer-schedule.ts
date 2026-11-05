/**
 * 자원봉사 회차 일정 계산(순수 함수). 회차 시각은 KST 날짜 + "HH:MM" 으로 받고 UTC 시각으로 저장한다.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];
const WEEKDAY_CODE = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function isDateKey(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

export function isHm(v: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/** KST 날짜·시각 → UTC 시각 */
export function kstInstant(dateKey: string, hm: string): Date {
  const [h, m] = hm.split(':').map(Number);
  const base = Date.UTC(Number(dateKey.slice(0, 4)), Number(dateKey.slice(5, 7)) - 1, Number(dateKey.slice(8, 10)), h, m);
  return new Date(base - KST_OFFSET_MS);
}

/** DB 의 @db.Date 값(UTC 자정) → YYYY-MM-DD */
export function dateKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function weekdayCode(dateKey: string): string {
  return WEEKDAY_CODE[new Date(`${dateKey}T00:00:00Z`).getUTCDay()]!;
}

/** "11/8(토) 10:00~12:00" */
export function shiftWhenLabel(s: { shiftDate: Date | string; startTime: string; endTime: string }): string {
  const key = typeof s.shiftDate === 'string' ? s.shiftDate : dateKeyOf(s.shiftDate);
  const d = new Date(`${key}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WEEKDAY_KO[d.getUTCDay()]}) ${s.startTime}~${s.endTime}`;
}

/** 승인 시 배정 안내 자동 문구: "11/8(토) 10:00~12:00 · 복지관 1층" (120자 제한) */
export function shiftScheduleLabel(s: { shiftDate: Date | string; startTime: string; endTime: string }, place: string | null | undefined): string {
  const when = shiftWhenLabel(s);
  return (place?.trim() ? `${when} · ${place.trim()}` : when).slice(0, 120);
}
