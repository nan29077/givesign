'use server';

import { revalidatePath } from 'next/cache';
import type { AdminActionState } from '@/components/admin/state';
import { writeAudit } from '@/server/auth';
import { requireBazaarMerchant, requireBazaarMerchantAny } from '@/server/bazaar-auth';
import * as svc from '@/server/services/bazaar';

/**
 * 라이브 바자회 — 기관 콘솔 액션.
 * 기관이 직접 하는 일은 네 가지다: 매칭 수락/거절, 가액 확정(또는 역제안), 검수 확정, 편성 승인.
 * 참여 신청(위탁판매 동의)도 여기서 한다.
 */

async function runMerchant(fn: (m: { id: string; merchantId: string }) => Promise<string>, guard = requireBazaarMerchant): Promise<AdminActionState> {
  try {
    const m = await guard();
    const message = await fn({ id: m.id, merchantId: m.merchantId });
    revalidatePath('/studio/bazaar', 'layout');
    revalidatePath('/admin/bazaar', 'layout');
    revalidatePath('/giver', 'layout');
    return { ok: true, message };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '처리 중 오류가 발생했습니다.' };
  }
}

const t = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

export async function applyParticipationAction(_p: AdminActionState, fd: FormData) {
  return runMerchant(async (m) => {
    const r = await svc.applyParticipation(m.merchantId, {
      consignmentName: t(fd, 'consignmentName'),
      agree: fd.get('agree') === 'on',
      neededItems: t(fd, 'neededItems') || null,
      mailOrderRegNo: t(fd, 'mailOrderRegNo') || null,
    });
    await writeAudit({ actorUserId: m.id, action: 'BAZAAR_PARTICIPATION_APPLY', targetType: 'merchant_bazaar', targetId: m.merchantId });
    return r === 'UPDATED' ? '필요 물품·통신판매업 정보를 저장했습니다.' : '참여를 신청했습니다. 운영자 승인 후 기부 물품을 매칭받을 수 있습니다.';
  }, requireBazaarMerchantAny);
}

export async function respondMatchAction(_p: AdminActionState, fd: FormData) {
  return runMerchant(async (m) => {
    const accept = t(fd, 'decision') === 'ACCEPT';
    await svc.respondMatch(m.merchantId, t(fd, 'matchId'), accept, m.id, t(fd, 'reason') || null);
    await writeAudit({ actorUserId: m.id, action: accept ? 'BAZAAR_MATCH_ACCEPT' : 'BAZAAR_MATCH_REJECT', targetType: 'in_kind_match', targetId: t(fd, 'matchId') });
    return accept ? '수락했습니다. 기부자가 제시한 가액을 확인해 확정하거나 다른 가액을 제안해 주세요.' : '거절했습니다.';
  });
}

export async function merchantValuationAction(_p: AdminActionState, fd: FormData) {
  return runMerchant(async (m) => {
    const donationId = t(fd, 'donationId');
    if (t(fd, 'mode') === 'CONFIRM') {
      // 화면에서 본 제안 id 를 함께 보낸다. 그 사이 기부자가 다시 제안했으면 확정하지 않는다(점검 B-3).
      await svc.acceptValuation(donationId, { type: 'MERCHANT', userId: m.id, merchantId: m.merchantId }, t(fd, 'valuationId'));
      await writeAudit({ actorUserId: m.id, action: 'BAZAAR_VALUATION_CONFIRM', targetType: 'in_kind_donation', targetId: donationId });
      return '가액을 확정했습니다. 기부자가 약정에 동의하면 물품이 입고됩니다.';
    }
    const values: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('unit_')) values[k.slice(5)] = String(v);
    const total = await svc.proposeValuation(donationId, { type: 'MERCHANT', userId: m.id, merchantId: m.merchantId }, values, t(fd, 'note') || null);
    await writeAudit({ actorUserId: m.id, action: 'BAZAAR_VALUATION_COUNTER', targetType: 'in_kind_donation', targetId: donationId, after: { total: total.toString() } });
    return `합계 ${Number(total).toLocaleString('ko-KR')}원으로 다시 제안했습니다. 기부자가 수락하면 확정됩니다.`;
  });
}

export async function confirmInspectionAction(_p: AdminActionState, fd: FormData) {
  return runMerchant(async (m) => {
    const donationId = t(fd, 'donationId');
    const r = await svc.confirmInspection(m.merchantId, donationId, m.id);
    await writeAudit({ actorUserId: m.id, action: 'BAZAAR_INSPECTION_CONFIRM', targetType: 'in_kind_receipt', targetId: r.id });
    revalidatePath('/studio/receipts');
    return `검수를 확정하고 현물 기부금영수증 ${r.receiptNo} 를 발급했습니다.`;
  });
}

export async function decideLiveAction(_p: AdminActionState, fd: FormData) {
  return runMerchant(async (m) => {
    const approve = t(fd, 'decision') === 'APPROVE';
    await svc.decideLive(m.merchantId, t(fd, 'liveId'), approve, m.id, t(fd, 'note') || null);
    await writeAudit({ actorUserId: m.id, action: approve ? 'BAZAAR_LIVE_APPROVE' : 'BAZAAR_LIVE_REJECT', targetType: 'bazaar_live', targetId: t(fd, 'liveId') });
    return approve ? '편성을 승인했습니다.' : '편성을 반려했습니다.';
  });
}
