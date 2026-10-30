import { z } from 'zod';

/**
 * 전자문서 이용요금 — 순수 계산(화면·서버 공용).
 *
 * 금액은 모두 부가세 포함 원 단위다. 원장에는 공급가액과 부가세를 나눠 남긴다(절대 규칙 8).
 * 이 잔액은 기관이 전자문서 서비스를 쓰기 위해 낸 이용료이고, 후원금과 섞이지 않는다.
 */

/** 요금제가 하나도 없을 때 쓰는 기본값. 운영 요금은 관리자가 요금제 버전으로 등록한다. */
export const EDOC_PLAN_DEFAULT = {
  perDocument: 200,
  monthlyPrice: 30000,
  monthlyQuota: 200,
  trialQuota: 5,
  lowBalance: 2000,
  topupBonus: [] as TopupBonusRule[],
};

export const EDOC_TOPUP_MIN = 1000;
export const EDOC_TOPUP_MAX = 10_000_000;
export const EDOC_MONTHLY_DAYS = 30;
/** 기관당 확인 대기 신청 상한 */
export const EDOC_PENDING_MAX = 3;

export interface TopupBonusRule {
  /** 이 금액 이상 충전하면 */
  min: number;
  /** 충전액의 이 퍼센트를 보너스로 더한다 */
  percent: number;
}

export const topupBonusSchema = z
  .array(z.object({ min: z.number().int().min(EDOC_TOPUP_MIN), percent: z.number().min(0).max(50) }))
  .max(5);

export function parseTopupBonus(raw: unknown): TopupBonusRule[] {
  const p = topupBonusSchema.safeParse(raw);
  return p.success ? [...p.data].sort((a, b) => a.min - b.min) : [];
}

/** "100000:5, 300000:10" 형태 입력을 구간 목록으로 읽는다. */
export function parseTopupBonusText(text: string): TopupBonusRule[] | null {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const rules: TopupBonusRule[] = [];
  for (const part of trimmed.split(/[,\n]/)) {
    const m = /^\s*([\d,]+)\s*[:=]\s*(\d+(?:\.\d+)?)\s*%?\s*$/.exec(part);
    if (!m) return null;
    rules.push({ min: Number(m[1]!.replace(/,/g, '')), percent: Number(m[2]) });
  }
  const p = topupBonusSchema.safeParse(rules);
  return p.success ? p.data.sort((a, b) => a.min - b.min) : null;
}

export function topupBonusText(rules: TopupBonusRule[]): string {
  return rules.map((r) => `${r.min}:${r.percent}`).join(', ');
}

/** 충전액에 붙는 보너스(원, 내림). 가장 높은 구간 하나만 적용한다. */
export function topupBonusFor(amount: number, rules: TopupBonusRule[]): number {
  let percent = 0;
  for (const r of rules) if (amount >= r.min) percent = r.percent;
  return Math.floor((amount * percent) / 100);
}

/** 부가세 포함 금액을 공급가액·부가세로 나눈다. 음수(차감)도 같은 규칙으로 부호를 유지한다. */
export function splitVat(amount: number): { supply: number; vat: number } {
  const sign = amount < 0 ? -1 : 1;
  const abs = Math.abs(amount);
  const supply = Math.round(abs / 1.1);
  return { supply: sign * supply, vat: sign * (abs - supply) };
}

export type EDocUseSourceKey = 'MONTHLY' | 'TRIAL' | 'PREPAID';

/**
 * 발송 1건을 어디서 차감할지 고른다. 순서: 진행 중 정액 제공량 → 시범 제공량 → 충전 잔액.
 * 정액은 기간이 남았고 제공량이 있을 때만 쓴다.
 */
export function pickUseSource(input: {
  subscription: { endsAt: Date; quota: number; used: number } | null;
  trialRemaining: number;
  balance: number;
  perDocument: number;
  now?: Date;
}): EDocUseSourceKey | null {
  const now = input.now ?? new Date();
  const s = input.subscription;
  if (s && s.endsAt > now && s.used < s.quota) return 'MONTHLY';
  if (input.trialRemaining > 0) return 'TRIAL';
  if (input.balance >= input.perDocument) return 'PREPAID';
  return null;
}

export const edocUseSourceLabel: Record<EDocUseSourceKey, string> = {
  MONTHLY: '정액 제공량',
  TRIAL: '시범 제공',
  PREPAID: '충전 잔액',
};

export const edocLedgerKindLabel: Record<string, string> = {
  TOPUP: '충전',
  PLAN_GRANT: '정액 제공',
  TRIAL_GRANT: '시범 제공',
  USE: '발송 차감',
  REFUND: '발송 취소 환원',
  EXPIRE: '정액 기간 종료',
  ADJUST: '관리자 조정',
};
