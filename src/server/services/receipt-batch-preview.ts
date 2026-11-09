import { prisma } from '@/server/db';
import { pickSamples, type SampleKind } from '@/lib/document-preflight';
import { APPROVAL_KIND_LABEL, type ApprovalKind } from './approvals';

/**
 * 기부금영수증 일괄 발급(RECEIPT_BATCH) 승인 전 확인 (2026-11-09 과제 C1-4·C2-5).
 *
 * 승인 버튼 전에 대상 수·영수증 표본·예상 비용·제외 대상과 이유를 보여 준다. **정보 제공만** 한다 —
 * 실제 발급 대상 판정은 승인 뒤 `issueReceiptsBulk`(영수증 대장 규칙, 절대 규칙 9) 그대로다.
 * 주민등록번호는 등록 여부·마스킹 값만 쓴다(원문 복호화 없음 — 절대 규칙 6).
 */

export type ReceiptExcludeReason = 'NO_PROFILE' | 'WITHDRAWN' | 'CONFLICT' | 'NO_NAME' | 'NO_AMOUNT';

export const RECEIPT_EXCLUDE_LABEL: Record<ReceiptExcludeReason, string> = {
  NO_PROFILE: '영수증 정보(성명·주민등록번호) 미등록',
  WITHDRAWN: '탈퇴한 후원자',
  CONFLICT: '주민등록번호 중복 정리 필요',
  NO_NAME: '성명 빈칸',
  NO_AMOUNT: '합계 금액 0원 이하',
};

export interface ReceiptBatchSample {
  kind: SampleKind;
  payerLabel: string;
  legalName: string | null;
  residentNoMasked: string | null;
  address: string | null;
  amount: bigint;
  count: number;
}

export interface ReceiptBatchPreview {
  approval: { id: string; title: string; summary: string | null; status: string; kindLabel: string; createdAt: Date };
  taxYear: number;
  targetCount: number;
  targetAmount: bigint;
  /** 요청을 만들 때 센 대상 수(그 사이 바뀌었으면 화면이 알린다) */
  requestedCount: number | null;
  samples: ReceiptBatchSample[];
  excluded: Array<{ reason: ReceiptExcludeReason; label: string; count: number; amount: bigint }>;
  /** 전자문서 이용요금(영수증은 전자서명 문서가 아니라 0원) */
  expectedCost: { amount: bigint; note: string };
  issuer: { ok: boolean; missing: string[] };
}

export async function receiptBatchPreview(merchantId: string, approvalId: string): Promise<ReceiptBatchPreview | null> {
  const a = await prisma.approvalRequest.findFirst({ where: { id: approvalId, merchantId } });
  if (!a || a.kind !== 'RECEIPT_BATCH') return null;
  const payload = (a.payload ?? {}) as Record<string, unknown>;
  const taxYear = Number(payload.taxYear);
  if (!Number.isInteger(taxYear)) return null;
  const { receiptCandidates, issuerReadiness } = await import('./receipts');
  const [cands, m] = await Promise.all([
    receiptCandidates(merchantId, taxYear),
    prisma.merchantProfile.findUniqueOrThrow({
      where: { id: merchantId },
      select: { businessNo: true, representativeName: true, address: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true },
    }),
  ]);
  const profiles = await prisma.payerReceiptProfile.findMany({
    where: { payerId: { in: cands.map((c) => c.payerId) } },
    select: { payerId: true, legalName: true, residentNoMasked: true, address: true },
  });
  const prof = new Map(profiles.map((p) => [p.payerId, p]));
  const excludedMap = new Map<ReceiptExcludeReason, { count: number; amount: bigint }>();
  const exclude = (r: ReceiptExcludeReason, amount: bigint) => {
    const e = excludedMap.get(r) ?? { count: 0, amount: 0n };
    e.count += 1;
    e.amount += amount;
    excludedMap.set(r, e);
  };
  const ready: typeof cands = [];
  for (const c of cands) {
    if (c.withdrawn) exclude('WITHDRAWN', c.amount);
    else if (c.conflict) exclude('CONFLICT', c.amount);
    else if (!c.ready) exclude('NO_PROFILE', c.amount);
    else if (!(c.legalName ?? '').trim()) exclude('NO_NAME', c.amount);
    else if (c.amount <= 0n) exclude('NO_AMOUNT', c.amount);
    else ready.push(c);
  }
  const picked = pickSamples(
    ready.map((c) => {
      const p = prof.get(c.payerId);
      return {
        key: c.payerId,
        label: c.displayName ? `${c.displayName} (${c.phoneMasked})` : c.phoneMasked,
        values: { 후원자명: p?.legalName ?? c.legalName, 주민번호: p?.residentNoMasked ?? null, 주소: p?.address ?? null },
        c,
      };
    }),
    // 주소는 영수증 선택 항목이라 빈칸 판정에 넣지 않는다.
    ['후원자명', '주민번호'],
  );
  return {
    approval: { id: a.id, title: a.title, summary: a.summary, status: a.status, kindLabel: APPROVAL_KIND_LABEL[a.kind as ApprovalKind] ?? '승인 요청', createdAt: a.createdAt },
    taxYear,
    targetCount: ready.length,
    targetAmount: ready.reduce((s, c) => s + c.amount, 0n),
    requestedCount: Number.isFinite(Number(payload.readyCount)) ? Number(payload.readyCount) : null,
    samples: picked.map(({ kind, cand }) => {
      const p = prof.get(cand.key);
      return {
        kind,
        payerLabel: cand.label,
        legalName: p?.legalName ?? cand.c.legalName,
        residentNoMasked: p?.residentNoMasked ?? null,
        address: p?.address ?? null,
        amount: cand.c.amount,
        count: cand.c.count,
      };
    }),
    excluded: [...excludedMap.entries()].map(([reason, v]) => ({ reason, label: RECEIPT_EXCLUDE_LABEL[reason], ...v })),
    expectedCost: { amount: 0n, note: '기부금영수증은 전자서명 문서가 아니라 전자문서 이용요금이 들지 않습니다.' },
    issuer: issuerReadiness(m),
  };
}
