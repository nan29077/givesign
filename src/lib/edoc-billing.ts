import { z } from 'zod';
export const EDOC_POLICY_KEY = 'givesign:edoc:policy';
export const edocAccountKey = (id: string) => `givesign:edoc:account:${id}`;
export const EDOC_POLICY_DEFAULT = { perDocument: 200, monthlyPrice: 30000, monthlyQuota: 200, trialQuota: 5 };
export const edocPolicySchema = z.object({
  perDocument: z.coerce.number().int().min(1).max(100000),
  monthlyPrice: z.coerce.number().int().min(1000).max(10000000),
  monthlyQuota: z.coerce.number().int().min(1).max(100000),
  trialQuota: z.coerce.number().int().min(0).max(100),
});
export type EDocPolicy = z.infer<typeof edocPolicySchema>;
export const edocAccountSchema = z.object({
  balance: z.number().int().nonnegative(), trialRemaining: z.number().int().nonnegative(),
  monthlyRemaining: z.number().int().nonnegative(), monthlyUntil: z.string().nullable(),
  totalUsed: z.number().int().nonnegative(),
});
export type EDocAccount = z.infer<typeof edocAccountSchema>;
export type EDocRequest = { id: string; merchantId: string; kind: 'TOPUP' | 'MONTHLY'; amount: number; quota: number; status: 'PENDING' | 'APPROVED' | 'REJECTED'; createdAt: string; resolvedAt?: string };
export function chargeDocument(account: EDocAccount, policy: EDocPolicy, now = new Date()) {
  const next = { ...account, totalUsed: account.totalUsed + 1 };
  if (account.monthlyUntil && new Date(account.monthlyUntil) > now && account.monthlyRemaining > 0) return { account: { ...next, monthlyRemaining: account.monthlyRemaining - 1 }, source: 'MONTHLY', amount: 0 };
  if (account.trialRemaining > 0) return { account: { ...next, trialRemaining: account.trialRemaining - 1 }, source: 'TRIAL', amount: 0 };
  if (account.balance < policy.perDocument) throw new Error('전자문서 이용 잔액이 부족합니다. 충전 또는 정액 이용 신청을 해 주세요.');
  return { account: { ...next, balance: account.balance - policy.perDocument }, source: 'PREPAID', amount: policy.perDocument };
}
