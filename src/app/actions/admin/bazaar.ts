'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { writeAudit } from '@/server/auth';
import { assertMoneyAdmin, run, text, optText, type AdminActionState } from './shared';
import {
  assertBazaarEnabled,
  getBazaarConfig,
  saveBazaarConfig,
  setLiveBazaarEnabled,
} from '@/server/services/bazaar-settings';
import * as svc from '@/server/services/bazaar';
import { BAZAAR_CSV_MAX_BYTES, decodeCsvBytes, isMonthKey, parseSaleCsv, validateConfigInput, type BazaarConfig } from '@/lib/bazaar';

/**
 * 라이브 바자회 — 통합 관리자 액션.
 *
 * - 스위치·운영 설정: 최고관리자만.
 * - 금전(판매 결과 승인·정산 확정·지급 기록): 최고관리자·운영·재무.
 * - 정산 확정·지급 기록은 스위치가 꺼져 있어도 동작한다(확정된 정산은 계속 지급 — 2026-11-05 결정).
 * - 나머지는 스위치가 꺼지면 거절한다.
 */

function revalidateBazaar() {
  revalidatePath('/admin/bazaar', 'layout');
  revalidatePath('/studio/bazaar', 'layout');
  revalidatePath('/giver', 'layout');
}

function assertSuper(admin: { adminPermission?: string }) {
  if (admin.adminPermission !== 'SUPER_ADMIN') throw new Error('최고관리자만 바꿀 수 있습니다.');
}

/**
 * 영수증 금액·정산에 영향을 주는 입력(입고·검수, 판매 결과 입력·반려, 판매 종료)은 고객지원(SUPPORT) 권한을 뺀
 * 금전 권한(최고관리자·운영·재무)에서만 한다(점검 낮음 — 기존 MONEY 화이트리스트 재사용).
 */
function assertBazaarOperator(admin: Parameters<typeof assertMoneyAdmin>[0]) {
  assertMoneyAdmin(admin, '입고·검수, 판매 결과, 판매 종료는 최고관리자·운영·재무 권한에서만 처리할 수 있습니다.');
}

function intOf(fd: FormData, key: string, label: string): number {
  const raw = text(fd, key).replace(/[,\s원]/g, '');
  if (!/^\d+$/.test(raw)) throw new Error(`${label}을(를) 숫자로 입력해 주세요.`);
  return Number(raw);
}

// ------------------------------------------------------------------ 스위치·설정

export async function setBazaarSwitchAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertSuper(admin);
    const enabled = text(fd, 'enabled') === 'on';
    if (!enabled && text(fd, 'confirmText') !== '끄기') throw new Error("끄려면 확인란에 '끄기' 를 입력해 주세요.");
    await setLiveBazaarEnabled(enabled, admin.id);
    await writeAudit({ adminUserId: admin.id, action: enabled ? 'BAZAAR_ENABLE' : 'BAZAAR_DISABLE', targetType: 'system_setting', targetId: 'live_bazaar.enabled', after: { enabled } });
    revalidatePath('/', 'layout');
    return enabled ? '라이브 바자회를 켰습니다. 메인·메뉴·콘솔에 바로 나타납니다.' : '라이브 바자회를 껐습니다. 관련 화면과 메뉴가 모두 숨겨졌습니다.';
  });
}

export async function saveBazaarConfigAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertSuper(admin);
    await assertBazaarEnabled();
    const before = await getBazaarConfig();
    const raw = {
      feeRatePercent: text(fd, 'feeRatePercent'),
      minSalePrice: text(fd, 'minSalePrice').replace(/[,\s원]/g, ''),
      defaultPerPersonLimit: text(fd, 'defaultPerPersonLimit').replace(/[,\s]/g, ''),
      matchDeadlineDays: text(fd, 'matchDeadlineDays').replace(/[,\s]/g, ''),
      settlementPayDay: text(fd, 'settlementPayDay').replace(/[,\s]/g, ''),
      warehouseAddress: text(fd, 'warehouseAddress'),
      consignmentNotice: text(fd, 'consignmentNotice'),
    };
    // 범위를 벗어난 값을 기본값으로 바꿔 저장하고 "저장했습니다" 라고 하지 않는다(점검 낮음).
    const errors = validateConfigInput({ ...raw, minSalePrice: raw.minSalePrice || 'x', defaultPerPersonLimit: raw.defaultPerPersonLimit || 'x', matchDeadlineDays: raw.matchDeadlineDays || 'x', settlementPayDay: raw.settlementPayDay || 'x' });
    if (errors.length) throw new Error(errors.join('\n'));
    const next: BazaarConfig = {
      feeRatePercent: raw.feeRatePercent,
      feeVatMode: text(fd, 'feeVatMode') === 'EXCLUDED' ? 'EXCLUDED' : 'INCLUDED',
      minSalePrice: Number(raw.minSalePrice),
      defaultPerPersonLimit: Number(raw.defaultPerPersonLimit),
      matchDeadlineDays: Number(raw.matchDeadlineDays),
      settlementPayDay: Number(raw.settlementPayDay),
      warehouseAddress: raw.warehouseAddress,
      consignmentNotice: raw.consignmentNotice,
    };
    const saved = await saveBazaarConfig(next, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_CONFIG', targetType: 'system_setting', targetId: 'live_bazaar.config', before, after: saved });
    revalidateBazaar();
    return '운영 설정을 저장했습니다. 이후 승인하는 판매 결과부터 적용됩니다.';
  });
}

// ------------------------------------------------------------------ 기관 참여

export async function decideParticipationAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const merchantId = text(fd, 'merchantId');
    const decision = text(fd, 'decision') as 'APPROVED' | 'REJECTED' | 'SUSPENDED';
    if (!['APPROVED', 'REJECTED', 'SUSPENDED'].includes(decision)) throw new Error('처리 방법을 골라 주세요.');
    const r = await svc.decideParticipation(merchantId, decision, admin.id, optText(fd, 'note'));
    await writeAudit({ adminUserId: admin.id, action: `BAZAAR_PARTICIPATION_${decision}`, targetType: 'merchant_bazaar', targetId: merchantId, after: { withdrawnMatches: r.withdrawn } });
    revalidateBazaar();
    if (decision === 'APPROVED') return '참여를 승인했습니다. 이제 매칭 대상에 포함됩니다.';
    return r.withdrawn ? `처리했습니다. 응답 대기 중이던 매칭 제안 ${r.withdrawn}건을 철회하고 접수 상태로 되돌렸습니다.` : '처리했습니다.';
  });
}

// ------------------------------------------------------------------ 기부 건

export async function proposeMatchAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const donationId = text(fd, 'donationId');
    const merchantId = text(fd, 'merchantId');
    if (!merchantId) throw new Error('매칭할 기관을 골라 주세요.');
    await svc.proposeMatch(donationId, merchantId, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_MATCH_PROPOSE', targetType: 'in_kind_donation', targetId: donationId, after: { merchantId } });
    revalidateBazaar();
    return '기관에 매칭을 제안했습니다. 기관이 수락하면 가액 협의가 시작됩니다.';
  });
}

export async function withdrawMatchAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const donationId = text(fd, 'donationId');
    await svc.withdrawMatch(donationId, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_MATCH_WITHDRAW', targetType: 'in_kind_donation', targetId: donationId });
    revalidateBazaar();
    return '매칭 제안을 철회했습니다.';
  });
}

export async function cancelDonationAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const donationId = text(fd, 'donationId');
    await svc.cancelDonationByAdmin(donationId, admin.id, text(fd, 'reason'));
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_DONATION_CANCEL', targetType: 'in_kind_donation', targetId: donationId, after: { reason: text(fd, 'reason') } });
    revalidateBazaar();
    return '기부 건을 취소했습니다.';
  });
}

export async function registerInboundAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    assertBazaarOperator(admin);
    const donationId = text(fd, 'donationId');
    // 검수 사진을 먼저 검사한다(형식·크기·개수). 틀리면 검수 결과도 저장하지 않는다.
    const photos = await svc.prepareDonationFiles(fd.getAll('photos').filter((f): f is File => f instanceof File).map((file) => ({ kind: 'INSPECTION' as const, file })));
    const items = await prisma.inKindItem.findMany({ where: { donationId }, select: { id: true, name: true } });
    const result = text(fd, 'result') as 'PASS' | 'PARTIAL' | 'FAIL';
    if (!['PASS', 'PARTIAL', 'FAIL'].includes(result)) throw new Error('검수 결과를 골라 주세요.');
    const receivedAtRaw = text(fd, 'receivedAt');
    const receivedAt = receivedAtRaw ? new Date(`${receivedAtRaw}T12:00:00+09:00`) : new Date();
    if (Number.isNaN(receivedAt.getTime())) throw new Error('입고일을 확인해 주세요.');
    const bearer = text(fd, 'returnCostBearer') as 'NONE' | 'MERCHANT' | 'GIVESIGN';
    await svc.registerInbound(donationId, admin.id, {
      warehouse: text(fd, 'warehouse'),
      receivedAt,
      result,
      items: items.map((it) => ({
        itemId: it.id,
        receivedQty: intOf(fd, `received_${it.id}`, `${it.name} 입고 수량`),
        acceptedQty: result === 'FAIL' ? 0 : intOf(fd, `accepted_${it.id}`, `${it.name} 합격 수량`),
        note: optText(fd, `note_${it.id}`),
      })),
      returnCost: BigInt(text(fd, 'returnCost').replace(/[,\s원]/g, '') || '0'),
      returnCostBearer: ['NONE', 'MERCHANT', 'GIVESIGN'].includes(bearer) ? bearer : 'NONE',
      disposition: text(fd, 'disposition') === 'DISPOSED' ? 'DISPOSED' : 'RETURNED',
      note: optText(fd, 'note'),
    });
    if (photos.length) await svc.attachDonationFiles(donationId, photos, admin.id, [...svc.INSPECTION_PHOTO_STATUSES, 'RETURNED']);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_INBOUND', targetType: 'in_kind_donation', targetId: donationId, after: { result } });
    revalidateBazaar();
    return result === 'FAIL' ? '불합격으로 등록했습니다(반송·폐기).' : '입고·검수를 등록했습니다. 기관이 검수를 확정하면 영수증이 발급됩니다.';
  });
}

export async function closeDonationAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    await svc.closeDonation(text(fd, 'donationId'), admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_DONATION_CLOSE', targetType: 'in_kind_donation', targetId: text(fd, 'donationId') });
    revalidateBazaar();
    return '기부 건을 종결했습니다.';
  });
}

export async function voidReceiptAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertSuper(admin);
    const id = text(fd, 'receiptId');
    await svc.voidInKindReceipt(id, admin.id, text(fd, 'reason'));
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_RECEIPT_VOID', targetType: 'in_kind_receipt', targetId: id, after: { reason: text(fd, 'reason') } });
    revalidateBazaar();
    revalidatePath('/studio/receipts');
    return '영수증을 무효 처리했습니다. 필요하면 재발급해 주세요.';
  });
}

export async function reissueReceiptAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertSuper(admin);
    const donationId = text(fd, 'donationId');
    const r = await svc.reissueInKindReceipt(donationId, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_RECEIPT_REISSUE', targetType: 'in_kind_receipt', targetId: r.id });
    revalidateBazaar();
    revalidatePath('/studio/receipts');
    return `영수증 ${r.receiptNo} 를 새로 발급했습니다.`;
  });
}

// 영수증 무효·재발급은 스위치가 꺼져도 동작한다(발급된 현물 영수증은 법정 서류 — 정정 경로가 있어야 한다).
// 꺼져 있을 때는 /admin/in-kind-receipts 화면에서 쓴다.

// ------------------------------------------------------------------ 상품

export async function updateProductAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const id = text(fd, 'productId');
    await svc.updateProduct(id, {
      name: text(fd, 'name'),
      salePrice: intOf(fd, 'salePrice', '판매가'),
      shippingFee: intOf(fd, 'shippingFee', '배송비'),
      quantity: intOf(fd, 'quantity', '판매 수량'),
      perPersonLimit: intOf(fd, 'perPersonLimit', '1인 구매 제한'),
    });
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_PRODUCT_UPDATE', targetType: 'bazaar_product', targetId: id });
    revalidateBazaar();
    return '상품 정보를 저장했습니다.';
  });
}

export async function listProductAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const id = text(fd, 'productId');
    await svc.markProductListed(id, admin.id, optText(fd, 'externalRef'));
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_PRODUCT_LISTED', targetType: 'bazaar_product', targetId: id });
    revalidateBazaar();
    return '셀러브릭스 등록 완료로 표시했습니다.';
  });
}

export async function endProductAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    assertBazaarOperator(admin);
    const id = text(fd, 'productId');
    const r = await svc.endProduct(id, admin.id, text(fd, 'remainingAction'));
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_PRODUCT_END', targetType: 'bazaar_product', targetId: id, after: { remainingAction: text(fd, 'remainingAction'), returnedQty: r.returnedQty } });
    revalidateBazaar();
    return r.correctionNeeded
      ? `판매를 종료했습니다. 기부자에게 돌려준 ${r.returnedQty}개는 기부가 아니므로 현물 영수증을 무효 처리한 뒤 재발급해 금액을 정정해 주세요(기부 건 상세).`
      : '판매를 종료했습니다.';
  });
}

// ------------------------------------------------------------------ 셀러·편성

export async function saveSellerAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    await svc.saveSeller({
      id: optText(fd, 'sellerId') ?? undefined,
      name: text(fd, 'name'),
      sellerbricksId: text(fd, 'sellerbricksId'),
      phone: optText(fd, 'phone'),
      memo: optText(fd, 'memo'),
      active: fd.has('activeField') ? text(fd, 'active') === 'on' : true,
    });
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_SELLER_SAVE', targetType: 'bazaar_seller', targetId: optText(fd, 'sellerId') ?? 'new' });
    revalidateBazaar();
    return '셀러를 저장했습니다.';
  });
}

export async function createLiveAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const at = text(fd, 'scheduledAt');
    const id = await svc.createLive(admin.id, {
      merchantId: text(fd, 'merchantId'),
      sellerId: text(fd, 'sellerId'),
      title: text(fd, 'title'),
      scheduledAt: new Date(`${at}:00+09:00`),
      broadcastUrl: optText(fd, 'broadcastUrl'),
      productIds: fd.getAll('productIds').map(String).filter(Boolean),
      note: optText(fd, 'note'),
    });
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_LIVE_CREATE', targetType: 'bazaar_live', targetId: id });
    revalidateBazaar();
    return '편성을 등록했습니다. 기관이 승인하면 확정됩니다.';
  });
}

export async function liveStatusAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const id = text(fd, 'liveId');
    const status = text(fd, 'status');
    if (status === 'URL') {
      const r = await svc.updateLiveUrl(id, text(fd, 'broadcastUrl'));
      // 공개 화면에 걸리는 주소라 바꾼 사람·전후 값을 남긴다(점검 낮음).
      await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_LIVE_URL', targetType: 'bazaar_live', targetId: id, before: { broadcastUrl: r.before }, after: { broadcastUrl: text(fd, 'broadcastUrl') } });
      revalidateBazaar();
      return '방송 주소를 저장했습니다.';
    }
    if (status !== 'DONE' && status !== 'CANCELED') throw new Error('처리 방법을 골라 주세요.');
    await svc.updateLiveStatus(id, status, optText(fd, 'broadcastUrl'));
    await writeAudit({ adminUserId: admin.id, action: `BAZAAR_LIVE_${status}`, targetType: 'bazaar_live', targetId: id });
    revalidateBazaar();
    return status === 'DONE' ? '방송 완료로 표시했습니다. 판매 결과를 입력해 주세요.' : '편성을 취소했습니다.';
  });
}

// ------------------------------------------------------------------ 판매 결과

export async function createSaleBatchAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    assertBazaarOperator(admin);
    const file = fd.get('file');
    let csvText = text(fd, 'rowsText');
    let source: 'MANUAL' | 'CSV' = 'MANUAL';
    if (file instanceof File && file.size > 0) {
      if (file.size > BAZAAR_CSV_MAX_BYTES) throw new Error('파일은 2MB 이하만 올릴 수 있습니다.');
      // 엑셀 기본 저장(CP949)도 읽는다(점검 B-M5).
      csvText = decodeCsvBytes(new Uint8Array(await file.arrayBuffer())).text;
      source = 'CSV';
    }
    if (!csvText.trim()) throw new Error('판매 결과를 입력하거나 파일을 올려 주세요.');
    const parsed = svc.saleRowsFromParsed(parseSaleCsv(csvText));
    if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 6).join('\n') + (parsed.errors.length > 6 ? `\n외 ${parsed.errors.length - 6}건` : ''));
    const id = await svc.createSaleBatch(admin.id, {
      title: text(fd, 'title'),
      liveId: optText(fd, 'liveId'),
      source,
      rows: parsed.rows,
      note: optText(fd, 'note'),
    });
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_SALE_BATCH_CREATE', targetType: 'bazaar_sale_batch', targetId: id, after: { rows: parsed.rows.length, source } });
    revalidateBazaar();
    return `판매 결과 ${parsed.rows.length}줄을 등록했습니다. 다른 관리자가 승인하면 정산에 반영됩니다.`;
  });
}

export async function approveSaleBatchAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    assertMoneyAdmin(admin);
    const id = text(fd, 'batchId');
    const payout = await svc.approveSaleBatch(id, { userId: admin.id, superAdmin: admin.adminPermission === 'SUPER_ADMIN' }, optText(fd, 'soloReason'));
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_SALE_BATCH_APPROVE', targetType: 'bazaar_sale_batch', targetId: id, after: { payout: payout.toString(), solo: optText(fd, 'soloReason') } });
    revalidateBazaar();
    return `승인했습니다. 기관 귀속 합계 ${Number(payout).toLocaleString('ko-KR')}원이 원장에 반영되었습니다.`;
  });
}

export async function rejectSaleBatchAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    assertBazaarOperator(admin);
    const id = text(fd, 'batchId');
    await svc.rejectSaleBatch(id, admin.id, text(fd, 'reason'));
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_SALE_BATCH_REJECT', targetType: 'bazaar_sale_batch', targetId: id });
    revalidateBazaar();
    return '반려했습니다. 고쳐서 다시 등록해 주세요.';
  });
}

// ------------------------------------------------------------------ 정산(스위치가 꺼져도 동작)
// 꺼져도 이미 승인된 판매의 정산 집계·확정·이월·지급은 계속 처리한다(확정 정산은 계속 지급 — 2026-11-05 결정).
// 꺼진 동안에는 새 판매 결과를 받지 않으므로 새 원장은 생기지 않는다.

export async function generateSettlementsAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertMoneyAdmin(admin);
    const month = text(fd, 'month');
    if (!isMonthKey(month)) throw new Error('정산 월을 YYYY-MM 형식으로 골라 주세요.');
    const r = await svc.generateSettlements(month);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_SETTLEMENT_GENERATE', targetType: 'bazaar_settlement', targetId: month, after: r });
    revalidatePath('/admin/bazaar', 'layout');
    revalidatePath('/admin/in-kind-settlements');
    return `${month} 정산을 집계했습니다(기관 ${r.merchants}곳, 신규 ${r.created}건).`;
  });
}

export async function confirmSettlementAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertMoneyAdmin(admin);
    const id = text(fd, 'settlementId');
    const r = await svc.confirmSettlement(id, admin.id);
    await writeAudit({ adminUserId: admin.id, action: r.status === 'CARRIED' ? 'BAZAAR_SETTLEMENT_CARRY' : 'BAZAAR_SETTLEMENT_CONFIRM', targetType: 'bazaar_settlement', targetId: id, after: { payout: r.payout.toString(), carriedToMonth: r.carriedToMonth } });
    revalidatePath('/admin/bazaar', 'layout');
    revalidatePath('/admin/in-kind-settlements');
    revalidatePath('/studio/bazaar', 'layout');
    if (r.status === 'CARRIED')
      return r.carriedToMonth
        ? `지급액이 ${Number(r.payout).toLocaleString('ko-KR')}원이라 지급하지 않고 ${r.carriedToMonth} 정산으로 넘겼습니다. 다음 정산에서 차감됩니다.`
        : '지급액이 0원이라 지급 없이 정산을 마감했습니다.';
    return '정산을 확정했습니다. 지급일에 이체한 뒤 지급 완료를 기록해 주세요.';
  });
}

/** 0원 이하로 확정만 되어 남아 있던 정산(이전 데이터)을 다음 달로 넘긴다. */
export async function carryOverSettlementAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertMoneyAdmin(admin);
    const id = text(fd, 'settlementId');
    const r = await svc.carryOverSettlement(id, admin.id);
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_SETTLEMENT_CARRY', targetType: 'bazaar_settlement', targetId: id, after: { payout: r.payout.toString(), carriedToMonth: r.carriedToMonth } });
    revalidatePath('/admin/bazaar', 'layout');
    revalidatePath('/admin/in-kind-settlements');
    revalidatePath('/studio/bazaar', 'layout');
    return r.carriedToMonth ? `${r.carriedToMonth} 정산으로 넘겼습니다.` : '지급 없이 정산을 마감했습니다.';
  });
}

export async function paySettlementAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    assertMoneyAdmin(admin);
    const id = text(fd, 'settlementId');
    const paidAtRaw = text(fd, 'paidAt');
    const paidAt = paidAtRaw ? new Date(`${paidAtRaw}T12:00:00+09:00`) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new Error('지급일을 확인해 주세요.');
    await svc.markSettlementPaid(id, admin.id, { transferRef: text(fd, 'transferRef'), paidAt });
    await writeAudit({ adminUserId: admin.id, action: 'BAZAAR_SETTLEMENT_PAID', targetType: 'bazaar_settlement', targetId: id, after: { transferRef: text(fd, 'transferRef') } });
    revalidatePath('/admin/bazaar', 'layout');
    revalidatePath('/admin/in-kind-settlements');
    revalidatePath('/studio/bazaar', 'layout');
    return '지급 완료로 기록했습니다.';
  });
}

export async function reconcileAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    assertMoneyAdmin(admin);
    const month = text(fd, 'month');
    if (!isMonthKey(month)) throw new Error('대사 월을 YYYY-MM 형식으로 골라 주세요.');
    const ext = text(fd, 'externalAmount').replace(/[,\s원]/g, '');
    if (!/^\d+$/.test(ext)) throw new Error('셀러브릭스 판매 총액을 숫자로 입력해 주세요.');
    const r = await svc.createReconcile(month, BigInt(ext), admin.id, optText(fd, 'note'));
    revalidatePath('/admin/bazaar', 'layout');
    return r.diff === 0n ? '일치합니다.' : `차이 ${Number(r.diff).toLocaleString('ko-KR')}원 — 누락·중복 입력을 확인해 주세요.`;
  });
}

// ------------------------------------------------------------------ 기부자 대장

export async function giverStatusAction(_p: AdminActionState, fd: FormData) {
  return run(async (admin) => {
    await assertBazaarEnabled();
    const donorId = text(fd, 'donorId');
    const status = text(fd, 'status');
    if (status !== 'ACTIVE' && status !== 'SUSPENDED') throw new Error('상태를 골라 주세요.');
    const donor = await prisma.inKindDonor.findUnique({ where: { id: donorId } });
    if (!donor) throw new Error('기부 회원을 찾을 수 없습니다.');
    await prisma.user.update({ where: { id: donor.userId }, data: { status } });
    if (status === 'SUSPENDED') await prisma.userSession.updateMany({ where: { userId: donor.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    const note = optText(fd, 'adminNote');
    if (note !== null) await prisma.inKindDonor.update({ where: { id: donorId }, data: { adminNote: note.slice(0, 300) } });
    await writeAudit({ adminUserId: admin.id, action: `BAZAAR_GIVER_${status}`, targetType: 'in_kind_donor', targetId: donorId });
    revalidateBazaar();
    return status === 'SUSPENDED' ? '정지했습니다(로그인 세션도 끊었습니다).' : '정지를 해제했습니다.';
  });
}
