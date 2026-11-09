/**
 * 주간 운영 계획 — 순수 함수(날짜·시기 캘린더·라벨). DB 를 만지지 않는다(2026-11-11 G1).
 * 서비스는 `src/server/services/weekly-plan.ts`.
 */

export const KST_MS = 9 * 3600_000;
const DAY_MS = 86_400_000;

/** now 가 속한 주의 월요일(KST) 날짜 'YYYY-MM-DD' */
export function kstWeekStartKey(now = new Date()): string {
  const k = new Date(now.getTime() + KST_MS);
  const back = (k.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD'(KST 날짜) → 그날 00:00 KST 의 UTC 시각 */
export function kstDayStart(key: string): Date {
  return new Date(Date.parse(`${key}T00:00:00Z`) - KST_MS);
}

/** 'YYYY-MM-DD' → DB DATE 컬럼 값(UTC 자정) */
export function dateColumn(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

/** DB DATE 컬럼 값 → 'YYYY-MM-DD' */
export function dateKeyOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysKey(key: string, days: number): string {
  return new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** KST 기준 요일(0=일)·시각 */
export function kstWeekdayHour(at: Date): { weekday: number; hour: number } {
  const k = new Date(at.getTime() + KST_MS);
  return { weekday: k.getUTCDay(), hour: k.getUTCHours() };
}

export const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** "11월 10일(월)" */
export function weekLabel(weekStartKey: string): string {
  const [, m, d] = weekStartKey.split('-').map(Number);
  const end = addDaysKey(weekStartKey, 6);
  const [, m2, d2] = end.split('-').map(Number);
  return `${m}월 ${d}일(월) ~ ${m2}월 ${d2}일(일)`;
}

// ---------------------------------------------------------------------------
// 목표
// ---------------------------------------------------------------------------

export const GOAL_KINDS = ['RECURRING_DONORS', 'CAMPAIGN_AMOUNT', 'VOLUNTEERS', 'MONTHLY_AMOUNT'] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

export const GOAL_KIND_LABEL: Record<GoalKind, string> = {
  RECURRING_DONORS: '정기후원자 수',
  CAMPAIGN_AMOUNT: '캠페인 모금액',
  VOLUNTEERS: '봉사자 수',
  MONTHLY_AMOUNT: '월 후원액',
};

/** 목표 단위 — 명(people) 또는 원(won) */
export const GOAL_UNIT: Record<GoalKind, 'people' | 'won'> = {
  RECURRING_DONORS: 'people',
  CAMPAIGN_AMOUNT: 'won',
  VOLUNTEERS: 'people',
  MONTHLY_AMOUNT: 'won',
};

export function isGoalKind(v: unknown): v is GoalKind {
  return typeof v === 'string' && (GOAL_KINDS as readonly string[]).includes(v);
}

/**
 * 기한 안 달성 가능성(규칙). 남은 양 ÷ 주 속도 > 남은 주 → 어려움.
 * 속도가 0 이하이면서 남은 양이 있으면 어려움. 기한이 없으면 판단하지 않는다(null).
 */
export function goalOutlook(input: { remaining: number; weeklyPace: number; weeksLeft: number | null }): 'DONE' | 'ON_TRACK' | 'AT_RISK' | null {
  if (input.remaining <= 0) return 'DONE';
  if (input.weeksLeft === null) return null;
  if (input.weeksLeft <= 0) return 'AT_RISK';
  if (input.weeklyPace <= 0) return 'AT_RISK';
  return input.remaining / input.weeklyPace > input.weeksLeft ? 'AT_RISK' : 'ON_TRACK';
}

// ---------------------------------------------------------------------------
// 시기 캘린더 — 1~2월 연말정산, 설·추석 명절 전, 9월 7일 사회복지의 날, 12월 연말, 기관 창립일(있으면)
// ---------------------------------------------------------------------------

/** public_holiday 에 그해 설날·추석이 없을 때 쓰는 예비 표(양력 날짜). */
export const LUNAR_HOLIDAY_FALLBACK: Record<number, { seollal: string; chuseok: string }> = {
  2026: { seollal: '2026-02-17', chuseok: '2026-09-25' },
  2027: { seollal: '2027-02-07', chuseok: '2027-09-15' },
  2028: { seollal: '2028-01-27', chuseok: '2028-10-03' },
  2029: { seollal: '2029-02-13', chuseok: '2029-09-22' },
  2030: { seollal: '2030-02-03', chuseok: '2030-09-12' },
};

export interface SeasonHint {
  key: string;
  title: string;
  detail: string;
  /** 기존 경로로 이어지는 화면 */
  href?: string;
}

/** 명절·기념일이 이 주 시작일부터 며칠 안에 있으면 "앞두고" 제안을 낸다 */
export const SEASON_LOOKAHEAD_DAYS = 14;

function daysBetween(fromKey: string, toKey: string) {
  return Math.round((Date.parse(`${toKey}T00:00:00Z`) - Date.parse(`${fromKey}T00:00:00Z`)) / DAY_MS);
}

/**
 * 이번 주에 맞는 시기 제안(규칙). holidays 는 public_holiday 의 '설날'·'추석' 날짜(없으면 예비 표).
 * foundedOn 은 기관 정보에 창립일이 있을 때만(지금 기관 정보에는 창립일 칸이 없어 호출부가 null 을 준다).
 */
export function seasonalHints(weekStartKey: string, opts: { holidays?: Array<{ date: string; name: string }>; foundedOn?: string | null } = {}): SeasonHint[] {
  const out: SeasonHint[] = [];
  const [y, m] = weekStartKey.split('-').map(Number) as [number, number];
  if (m === 1 || m === 2) {
    out.push({
      key: `season:tax-${y}`,
      title: '연말정산 시즌 — 영수증 정보 안내',
      detail: '후원자들이 기부금영수증을 찾는 시기입니다. 영수증 정보(성명·주민번호)를 등록하지 않은 후원자 안내는 승인 대기함의 "연간 영수증 준비" 묶음에서 기존 경로로 보낼 수 있습니다.',
      href: '/studio/inbox',
    });
  }
  const named = (name: string) => (opts.holidays ?? []).filter((h) => h.name === name).map((h) => h.date);
  for (const [name, label, field] of [['설날', '설 명절', 'seollal'], ['추석', '추석 명절', 'chuseok']] as const) {
    const dates = new Set<string>(named(name));
    for (const yy of [y, y + 1]) {
      const fb = LUNAR_HOLIDAY_FALLBACK[yy]?.[field];
      if (fb && ![...dates].some((d) => d.startsWith(String(yy)))) dates.add(fb);
    }
    const next = [...dates].sort().find((d) => {
      const n = daysBetween(weekStartKey, d);
      return n >= 0 && n <= SEASON_LOOKAHEAD_DAYS;
    });
    if (next) {
      out.push({
        key: `season:${field}-${next.slice(0, 4)}`,
        title: `${label}을 앞두고 있습니다 (${Number(next.slice(5, 7))}월 ${Number(next.slice(8, 10))}일)`,
        detail: '명절 전 나눔·감사 소식 콘텐츠를 준비해 보세요. 명절 연휴에는 게시 슬롯을 줄이는 것도 방법입니다.',
        href: '/studio/content',
      });
    }
  }
  const welfareDay = `${y}-09-07`;
  const wd = daysBetween(weekStartKey, welfareDay);
  if (wd >= 0 && wd <= SEASON_LOOKAHEAD_DAYS) {
    out.push({ key: `season:welfare-day-${y}`, title: '9월 7일 사회복지의 날', detail: '기관 활동과 봉사자 이야기를 알리기 좋은 날입니다. 감사·활동 소식 콘텐츠를 제안합니다.', href: '/studio/content' });
  }
  if (m === 12) {
    out.push({ key: `season:year-end-${y}`, title: '연말 — 한 해 감사 소식', detail: '한 해 후원 결과와 감사 인사를 전하기 좋은 시기입니다. 연말 감사장은 자동 안내 설정을 따릅니다.', href: '/studio/journeys' });
  }
  if (opts.foundedOn && /^\d{4}-\d{2}-\d{2}$/.test(opts.foundedOn)) {
    const anniv = `${y}-${opts.foundedOn.slice(5)}`;
    const n = daysBetween(weekStartKey, anniv);
    if (n >= 0 && n <= SEASON_LOOKAHEAD_DAYS) {
      out.push({ key: `season:founded-${y}`, title: '기관 창립일을 앞두고 있습니다', detail: '창립 기념 감사 소식을 준비해 보세요.', href: '/studio/content' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 제안 형식
// ---------------------------------------------------------------------------

/**
 * 제안 종류.
 *  INFO            : 알림만(실행 없음)
 *  NOTICE          : 안내 발송이 필요한 일 — 기존 저니·승인 대기함 경로로 보내 준다(링크만, 계획이 발송하지 않음)
 *  CONTENT_SLOT_ADD: 콘텐츠 캘린더에 요일 추가 — 승인하면 캘린더 설정에 반영(게시는 각 콘텐츠 승인 뒤)
 *  CONTENT_TOPIC   : 콘텐츠 주제(캠페인) 제안 — 승인하면 콘텐츠를 만들어 검토 대기로(게시는 개별 승인 뒤)
 */
export type WeeklySuggestionType = 'INFO' | 'NOTICE' | 'CONTENT_SLOT_ADD' | 'CONTENT_TOPIC';

export interface WeeklySuggestion {
  key: string;
  type: WeeklySuggestionType;
  title: string;
  detail: string;
  href?: string | null;
  /** 실행이 필요한 제안이면 승인 요청 id */
  approvalId?: string | null;
  /** 실행 값(요일·캠페인 id 등 — 개인정보 없음) */
  params?: Record<string, string | number>;
}

export const ACTIONABLE_SUGGESTION_TYPES: readonly WeeklySuggestionType[] = ['CONTENT_SLOT_ADD', 'CONTENT_TOPIC'];

export const WEEKLY_PLAN_STATUS_LABEL: Record<string, string> = {
  DRAFT: '준비됨',
  SENT: '보고 보냄',
  ACKED: '확인함',
};
