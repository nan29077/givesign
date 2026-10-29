/**
 * 영업일 계산.
 *
 * 정산일 규칙: **결제일 다음날부터 세어 영업일 5일째** 가 정산일이다.
 * 영업일 = 토요일·일요일·공휴일을 뺀 날. (공휴일은 public_holiday 표에서 온다)
 *
 * 검증된 예시
 *  - 2026-08-03(월) 결제 → 4,5,6,7(4일) + 8·9 주말 건너뜀 + 10(월) = **2026-08-10**
 *  - 2026-08-07(금) 결제 → 10,11,12,13,14 = **2026-08-14** (다음 주 금요일)
 *  - 2026-08-08(토) 결제 → 9 주말 건너뜀, 10~14 = **2026-08-14** (금·토·일 동일)
 *  - 2026-08-09(일) 결제 → 10~14 = **2026-08-14**
 *
 * 날짜는 전부 KST 기준 'YYYY-MM-DD' 문자열로 다룬다.
 * Date 객체로 주고받으면 서버 타임존(AWS 는 UTC)에 따라 하루가 밀리는데,
 * 정산일이 하루 밀리면 그대로 지급 사고가 된다.
 */

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 정산까지 필요한 기본 영업일 수 */
export const SETTLEMENT_BUSINESS_DAYS = 5;

/** Date → KST 기준 'YYYY-MM-DD' */
export function toDateKey(date: Date): string {
  const k = new Date(date.getTime() + KST_OFFSET_MS);
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}-${String(k.getUTCDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → 그 날 KST 00:00 에 해당하는 UTC Date */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - KST_OFFSET_MS);
}

/** 날짜 문자열 형식 + 실제 달력에 있는 날짜인지 확인 (2026-02-31 같은 값 차단) */
export function isValidDateKey(key: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** 'YYYY-MM-DD' 에 일수를 더한다. */
export function addDaysKey(key: string, days: number): string {
  return toDateKey(new Date(fromDateKey(key).getTime() + days * DAY_MS));
}

/** 요일 (0=일 … 6=토), KST 기준 */
export function weekdayOf(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWeekend(key: string): boolean {
  const w = weekdayOf(key);
  return w === 0 || w === 6;
}

/** 영업일인가? (주말·공휴일 제외) */
export function isBusinessDay(key: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(key) && !holidays.has(key);
}

/** 해당 날짜가 영업일이 아니면 다음 영업일로 밀어준다. 영업일이면 그대로. */
export function nextBusinessDay(key: string, holidays: ReadonlySet<string>): string {
  let cur = key;
  for (let i = 0; i < 400; i += 1) {
    if (isBusinessDay(cur, holidays)) return cur;
    cur = addDaysKey(cur, 1);
  }
  return cur;
}

/**
 * `from` 다음날부터 세어 영업일 `count` 일째 날짜.
 *
 * from 자체는 세지 않는다. from 이 주말이면 자연히 건너뛰므로
 * 금·토·일 결제가 모두 같은 정산일로 모이게 된다(운영 규칙과 일치).
 */
export function addBusinessDays(from: string, count: number, holidays: ReadonlySet<string>): string {
  let cur = from;
  let remaining = count;
  // 무한루프 방지: 영업일 1일당 최대 10일(장기 연휴 대비)씩만 진행한다.
  const limit = Math.max(1, count) * 10 + 30;
  for (let i = 0; i < limit && remaining > 0; i += 1) {
    cur = addDaysKey(cur, 1);
    if (isBusinessDay(cur, holidays)) remaining -= 1;
  }
  return cur;
}

/** 결제일 → 정산 예정일 */
export function settlementDateFor(
  chargeDateKey: string,
  holidays: ReadonlySet<string>,
  businessDays: number = SETTLEMENT_BUSINESS_DAYS,
): string {
  return addBusinessDays(chargeDateKey, businessDays, holidays);
}

/** 'YYYY-MM-DD' → '8월 10일 (월)' 같은 짧은 한국어 표기 */
export function formatDateKeyKo(key: string, withWeekday = true): string {
  if (!isValidDateKey(key)) return key;
  const [, m, d] = key.split('-').map(Number);
  const w = ['일', '월', '화', '수', '목', '금', '토'][weekdayOf(key)];
  return withWeekday ? `${m}월 ${d}일 (${w})` : `${m}월 ${d}일`;
}
