import { pickUseSource } from '@/lib/edoc-billing';

/**
 * 전자문서 발송 비용 예측(2026-11-12 4차 J3) — 순수 함수.
 *
 * 실제 차감(`edoc-billing.ts` debitForEnvelope)과 같은 판정 함수 `pickUseSource` 를 건수만큼 되풀이한다:
 * 정액 제공량 → 시범 제공량 → 충전 잔액. 그래서 예측과 실제 차감 순서가 어긋나지 않는다.
 * 문서 1건 = 봉투 1개 = 1건 차감(현재 요금 규칙). 묶음은 문서 수만큼이다.
 */

export interface EDocWalletState {
  /** 진행 중 정액의 남은 제공량(정액이 없으면 0) */
  monthlyLeft: number;
  trialLeft: number;
  /** 충전 잔액(원) */
  balance: number;
  perDocument: number;
}

export interface EDocForecast {
  count: number;
  monthly: number;
  trial: number;
  /** 충전 잔액으로 보내는 건수 */
  prepaid: number;
  /** 충전 잔액 차감 예상(원) */
  prepaidAmount: number;
  /** 잔액이 모자라 멈출 건수 */
  blocked: number;
  balanceAfter: number;
  perDocument: number;
}

export function forecastEDocCost(state: EDocWalletState, count: number): EDocForecast {
  const n = Math.max(0, Math.floor(count));
  const far = new Date(8640000000000000);
  let monthlyLeft = Math.max(0, state.monthlyLeft);
  let trial = Math.max(0, state.trialLeft);
  let balance = Math.max(0, state.balance);
  const out: EDocForecast = { count: n, monthly: 0, trial: 0, prepaid: 0, prepaidAmount: 0, blocked: 0, balanceAfter: balance, perDocument: state.perDocument };
  for (let i = 0; i < n; i++) {
    const source = pickUseSource({
      subscription: monthlyLeft > 0 ? { endsAt: far, quota: monthlyLeft, used: 0 } : null,
      trialRemaining: trial,
      balance,
      perDocument: state.perDocument,
    });
    if (source === 'MONTHLY') {
      monthlyLeft -= 1;
      out.monthly += 1;
    } else if (source === 'TRIAL') {
      trial -= 1;
      out.trial += 1;
    } else if (source === 'PREPAID') {
      balance -= state.perDocument;
      out.prepaid += 1;
      out.prepaidAmount += state.perDocument;
    } else {
      out.blocked = n - i;
      break;
    }
  }
  out.balanceAfter = balance;
  return out;
}

/** "이번 발송에 N건 · 정액 제공량 M건 사용 · 충전 잔액 K원 차감 예상 · 부족 시 J건이 멈춥니다" */
export function forecastSentence(f: EDocForecast): string {
  if (f.count === 0) return '이번 발송에는 전자문서 이용요금이 들지 않습니다.';
  const parts = [`이번 발송에 ${f.count.toLocaleString('ko-KR')}건`];
  if (f.monthly) parts.push(`정액 제공량 ${f.monthly.toLocaleString('ko-KR')}건 사용`);
  if (f.trial) parts.push(`시범 제공 ${f.trial.toLocaleString('ko-KR')}건 사용`);
  if (f.prepaid) parts.push(`충전 잔액 ${f.prepaidAmount.toLocaleString('ko-KR')}원 차감 예상`);
  parts.push(f.blocked ? `잔액이 부족해 ${f.blocked.toLocaleString('ko-KR')}건이 멈춥니다` : '잔액으로 모두 보낼 수 있습니다');
  return parts.join(' · ');
}

/** 멈출 건을 다 보내려면 더 충전할 금액(원) */
export function topupNeeded(f: EDocForecast): number {
  return f.blocked * f.perDocument;
}
