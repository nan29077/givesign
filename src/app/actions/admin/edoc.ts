'use server';

import { revalidatePath } from 'next/cache';
import { writeAudit } from '@/server/auth';
import { newId } from '@/lib/id';
import { parseTopupBonusText } from '@/lib/edoc-billing';
import {
  adjustWallet,
  approveBillingRequest,
  cancelUpcomingEDocPlan,
  createEDocPlan,
  expireEDocSubscriptions,
  rejectBillingRequest,
  verifyWallet,
} from '@/server/services/edoc-billing';
import { expireEDocEnvelopes, verifyEnvelopeChain } from '@/server/services/edoc';
import type { AdminActionState } from '@/components/admin/state';
import { assertMoneyAdmin, optText, run, text } from './shared';

const refresh = () => {
  revalidatePath('/admin/e-documents');
  revalidatePath('/studio/document-billing');
  revalidatePath('/studio/e-documents');
};

function int(f: FormData, key: string, label: string, min: number, max: number) {
  const n = Number(text(f, key).replace(/,/g, ''));
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label}을(를) ${min.toLocaleString('ko-KR')}~${max.toLocaleString('ko-KR')} 범위로 입력해 주세요.`);
  return n;
}

/** 새 요금제 버전 등록. 기존 요금제는 고치지 않고 시행일이 지나면 새 요금제가 적용된다. */
export async function saveEDocPlanAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') throw new Error('요금제는 최고관리자만 등록할 수 있습니다.');
    const bonus = parseTopupBonusText(text(f, 'topupBonus'));
    if (bonus === null) throw new Error('충전 보너스는 "100000:5, 300000:10"(금액:퍼센트) 형식으로 입력해 주세요.');
    const fromText = text(f, 'effectiveFrom');
    const effectiveFrom = fromText ? new Date(`${fromText}+09:00`) : new Date();
    if (Number.isNaN(effectiveFrom.getTime())) throw new Error('시행일을 확인해 주세요.');
    const plan = await createEDocPlan({
      perDocument: int(f, 'perDocument', '건당 금액', 1, 100_000),
      monthlyPrice: int(f, 'monthlyPrice', '정액 요금', 1000, 10_000_000),
      monthlyQuota: int(f, 'monthlyQuota', '정액 제공 건수', 1, 100_000),
      trialQuota: int(f, 'trialQuota', '시범 제공 건수', 0, 100),
      lowBalance: int(f, 'lowBalance', '잔액 알림 기준', 0, 1_000_000),
      topupBonus: bonus,
      effectiveFrom,
      note: optText(f, 'note')?.slice(0, 100) ?? null,
      actorId: admin.id,
    });
    await writeAudit({ adminUserId: admin.id, action: 'EDOC_PLAN_CREATE', targetType: 'edoc_plan', targetId: plan.id, after: { perDocument: plan.perDocument, monthlyPrice: plan.monthlyPrice, monthlyQuota: plan.monthlyQuota, trialQuota: plan.trialQuota, effectiveFrom: plan.effectiveFrom.toISOString() } });
    refresh();
    return plan.effectiveFrom <= new Date() ? '새 요금제를 등록했습니다. 지금부터 적용됩니다. 이미 접수한 신청 금액은 바뀌지 않습니다.' : '새 요금제를 예약했습니다. 시행일부터 적용됩니다.';
  });
}

export async function cancelEDocPlanAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    if (admin.adminPermission !== 'SUPER_ADMIN') throw new Error('요금제는 최고관리자만 관리할 수 있습니다.');
    const row = await cancelUpcomingEDocPlan(text(f, 'planId'));
    await writeAudit({ adminUserId: admin.id, action: 'EDOC_PLAN_CANCEL', targetType: 'edoc_plan', targetId: row.id, before: { effectiveFrom: row.effectiveFrom.toISOString() } });
    refresh();
    return '예약한 요금제를 취소했습니다.';
  });
}

export async function approveEDocBillingAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '충전·정액 승인은 최고관리자·운영·재무 권한에서만 할 수 있습니다.');
    const r = await approveBillingRequest({
      requestId: text(f, 'requestId'),
      actorId: admin.id,
      paymentConfirmed: f.get('paymentConfirmed') != null,
      taxInvoiceIssued: f.get('taxInvoiceIssued') != null,
    });
    await writeAudit({ adminUserId: admin.id, action: 'EDOC_BILLING_APPROVE', targetType: 'edoc_billing_request', targetId: text(f, 'requestId'), after: { merchantId: r.merchantId, kind: r.kind, amount: r.amount } });
    refresh();
    return r.kind === 'TOPUP'
      ? `충전을 반영했습니다. ${r.amount.toLocaleString('ko-KR')}원${r.bonus ? ` + 보너스 ${r.bonus.toLocaleString('ko-KR')}원` : ''}`
      : '30일 정액 이용을 시작했습니다.';
  });
}

export async function rejectEDocBillingAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '충전·정액 처리는 최고관리자·운영·재무 권한에서만 할 수 있습니다.');
    const req = await rejectBillingRequest({ requestId: text(f, 'requestId'), actorId: admin.id, reason: text(f, 'reason') });
    await writeAudit({ adminUserId: admin.id, action: 'EDOC_BILLING_REJECT', targetType: 'edoc_billing_request', targetId: req.id, after: { merchantId: req.merchantId, reason: text(f, 'reason') } });
    refresh();
    return '신청을 반려했습니다.';
  });
}

export async function adjustEDocWalletAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    assertMoneyAdmin(admin, '잔액 조정은 최고관리자·운영·재무 권한에서만 할 수 있습니다.');
    const merchantId = text(f, 'merchantId');
    const amount = Number(text(f, 'amount').replace(/,/g, '') || '0');
    const units = Number(text(f, 'units') || '0');
    const r = await adjustWallet({ merchantId, actorId: admin.id, amount, units, reason: text(f, 'reason'), nonce: text(f, 'nonce') || newId() });
    await writeAudit({ adminUserId: admin.id, action: 'EDOC_WALLET_ADJUST', targetType: 'edoc_wallet', targetId: merchantId, before: r.before, after: { ...r.after, reason: text(f, 'reason') } });
    refresh();
    return `조정했습니다. 충전 잔액 ${r.after.balance.toLocaleString('ko-KR')}원 · 시범 ${r.after.trial}건`;
  });
}

/** 만료 배치 수동 실행(평소에는 /api/cron/edoc 이 돈다). */
export async function runEDocBatchAction(_prev: AdminActionState, _f: FormData): Promise<AdminActionState> {
  return run(async (admin) => {
    const [subs, envelopes] = await Promise.all([expireEDocSubscriptions(), expireEDocEnvelopes()]);
    await writeAudit({ adminUserId: admin.id, action: 'EDOC_BATCH_RUN', targetType: 'edoc', after: { subs, envelopes } });
    refresh();
    return `정액 마감 ${subs}건 · 서명 기한 만료 ${envelopes}건을 처리했습니다.`;
  });
}

export async function verifyEDocAction(_prev: AdminActionState, f: FormData): Promise<AdminActionState> {
  return run(async () => {
    const envelopeId = text(f, 'envelopeId');
    if (envelopeId) {
      const r = await verifyEnvelopeChain(envelopeId);
      if (!r.ok) throw new Error(`감사추적 해시가 맞지 않습니다. (${r.count}번째 기록 뒤, ${r.brokenAt ?? '-'})`);
      return `감사추적 ${r.count}건의 해시 연결이 모두 맞습니다.`;
    }
    const r = await verifyWallet(text(f, 'merchantId'));
    if (!r.ok) throw new Error(`원장과 지갑이 다릅니다. 원장 ${r.ledgerBalance}원/지갑 ${r.walletBalance}원, 시범 원장 ${r.trialLedger}/지갑 ${r.trialWallet}`);
    return `원장과 지갑이 일치합니다. (${r.walletBalance.toLocaleString('ko-KR')}원 · 시범 ${r.trialWallet}건)`;
  });
}
