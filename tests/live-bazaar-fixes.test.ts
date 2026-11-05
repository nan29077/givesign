import { beforeEach, describe, expect, it, vi } from 'vitest';

// 서버 액션·API 를 직접 부르는 시험이 있다. 요청 헤더·쿠키·캐시는 빈 것으로 대체한다.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }));
vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: () => undefined, notFound: () => undefined }));
const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/server/auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/server/auth')>();
  return {
    ...real,
    getSessionUser: async () => session.user,
    requireMerchant: async () => {
      if (!session.user?.merchantId) throw new Error('사회복지기관 권한이 필요합니다.');
      return session.user;
    },
    requireAdmin: async () => {
      if (!session.user?.adminPermission) throw new Error('관리자 권한이 필요합니다.');
      return session.user;
    },
  };
});

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics } from './helpers';
import {
  acceptValuation,
  applyParticipation,
  approveSaleBatch,
  closeDonation,
  confirmInspection,
  confirmSettlement,
  carryOverSettlement,
  createDonation,
  createLive,
  createSaleBatch,
  decideParticipation,
  endProduct,
  generateSettlements,
  markProductListed,
  markSettlementPaid,
  pledgeDonation,
  prepareDonationFiles,
  proposeMatch,
  proposeValuation,
  registerGiver,
  registerInbound,
  reissueInKindReceipt,
  rejectSaleBatch,
  respondMatch,
  saveSeller,
  settlementTotals,
  updateProduct,
  voidInKindReceipt,
  receiptCorrectionNeeded,
} from '@/server/services/bazaar';
import { saveBazaarConfig, setLiveBazaarEnabled, getBazaarConfig } from '@/server/services/bazaar-settings';
import {
  DEFAULT_BAZAAR_CONFIG,
  amountMismatch,
  blockedKeyword,
  decodeCsvBytes,
  findTrackingCode,
  isFeeRateString,
  normalizeConfig,
  parseSaleCsv,
  settleLine,
  validateConfigInput,
} from '@/lib/bazaar';
import { buildHometaxExport } from '@/server/services/receipts';
import { kstMonthKey } from '@/lib/datetime';
import { nextMonth } from '@/lib/bazaar';
import { CRON_JOBS } from '@/server/cron-registry';

// ---------------------------------------------------------------- 공용 준비

async function makeAdmin(permission: 'SUPER_ADMIN' | 'OPERATION' | 'FINANCE' | 'SUPPORT' | 'READ_ONLY' = 'SUPER_ADMIN') {
  const u = await prisma.user.create({ data: { id: newId(), email: `admin-${newId()}@test.kr`, name: '관리자', role: 'ADMIN' } });
  await prisma.adminProfile.create({ data: { id: newId(), userId: u.id, permission } });
  return u.id;
}

async function readyMerchant(merchantId: string) {
  await prisma.merchantProfile.update({
    where: { id: merchantId },
    data: { businessNo: '1234567890', representativeName: '김대표', address: '서울시 중구 세종대로 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date() },
  });
  await applyParticipation(merchantId, { consignmentName: '담당자', agree: true });
}

async function corporateGiver() {
  return registerGiver({
    donorType: 'CORPORATE', email: `corp-${newId()}@test.kr`, password: 'x', passwordHash: 'x',
    displayName: '(주)나눔상사', contactName: '홍담당', phone: '010-2222-3333', businessNo: '220-81-12345', representativeName: '나대표', address: '서울시 강남구',
  });
}

async function lastProposalId(donationId: string) {
  const v = await prisma.inKindValuation.findFirstOrThrow({ where: { donationId, kind: { in: ['PROPOSE', 'COUNTER'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return v.id;
}

const BASE = { matchMode: 'DESIGNATED', brandPublic: false, unsoldAction: 'RETURN', deliveryMethod: 'SEND' } as const;

/** 기관 지정 기부 → 수락 → (가액 확정 전) VALUATING 까지 */
async function toValuating(merchantId: string, merchantUserId: string, items = [{ name: '수건 세트', category: '생활용품', quantity: 10, condition: 'NEW', declaredUnitValue: 10000 }]) {
  const g = await corporateGiver();
  const donationId = await createDonation(g.donorId, g.userId, { ...BASE, preferredMerchantId: merchantId, items });
  const m = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId } });
  await respondMatch(merchantId, m.id, true, merchantUserId);
  return { g, donationId };
}

/** 검수 확정·영수증 발급·상품 등록(LISTED)까지 */
async function toListed(merchantId: string, merchantUserId: string, adminId: string, qty = 10, unit = 10000) {
  const { g, donationId } = await toValuating(merchantId, merchantUserId, [{ name: '수건 세트', category: '생활용품', quantity: qty, condition: 'NEW', declaredUnitValue: unit }]);
  await acceptValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId }, await lastProposalId(donationId));
  await pledgeDonation(g.donorId, donationId, g.userId, { name: '홍담당', agree: true });
  const item = await prisma.inKindItem.findFirstOrThrow({ where: { donationId } });
  await registerInbound(donationId, adminId, { warehouse: '센터', receivedAt: new Date(), result: 'PASS', items: [{ itemId: item.id, receivedQty: qty, acceptedQty: qty }], returnCost: 0n, returnCostBearer: 'NONE' });
  const receipt = await confirmInspection(merchantId, donationId, merchantUserId);
  const product = await prisma.bazaarProduct.findFirstOrThrow({ where: { donationId } });
  await updateProduct(product.id, { name: product.name, salePrice: 10000, shippingFee: 0, quantity: qty, perPersonLimit: 5 });
  await markProductListed(product.id, adminId);
  return { g, donationId, receipt, product: await prisma.bazaarProduct.findUniqueOrThrow({ where: { id: product.id } }), item };
}

const row = (code: string, soldQty: number, gross: bigint, refundQty = 0, refund = 0n) => ({
  trackingCode: code, soldQty, grossAmount: gross, refundQty, refundAmount: refund, returnCost: 0n, returnBearer: 'NONE' as const,
});

async function sell(adminIn: string, approver: string, rows: ReturnType<typeof row>[]) {
  const id = await createSaleBatch(adminIn, { title: '방송', source: 'MANUAL', rows });
  await approveSaleBatch(id, { userId: approver, superAdmin: false });
  return id;
}

// ---------------------------------------------------------------- 순수 계산

describe('라이브 바자회 점검 조치 — 순수 계산', () => {
  it('B-M5: 따옴표 없는 "10,000" 처럼 열이 밀린 줄은 오류(10원으로 들어가지 않음)', () => {
    const rows = parseSaleCsv('추적코드,판매수량,판매금액,환불수량,환불금액,반송비,반송비부담,메모\nGSB-000001,1,10,000,0,0,0,없음,');
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toMatch(/열이 9개/);
    const ok = parseSaleCsv('GSB-000001,1,"10,000",0,0,0,없음,');
    expect(ok[0].error).toBeNull();
    expect(ok[0].grossAmount).toBe(10000n);
  });
  it('B-M5: 따옴표 안의 줄바꿈 메모를 한 레코드로 읽는다', () => {
    const rows = parseSaleCsv('GSB-000001,1,10000,0,0,0,없음,"첫 줄\n둘째 줄"\nGSB-000002,2,20000,0,0,0,없음,');
    expect(rows).toHaveLength(2);
    expect(rows[0].note).toBe('첫 줄\n둘째 줄');
    expect(rows[1].trackingCode).toBe('GSB-000002');
    expect(rows[1].line).toBe(3);
  });
  it('B-M5: CP949(엑셀 기본 저장) 바이트를 읽는다', () => {
    // '추적코드,판매수량' + 줄바꿈 + 'GSB-000001,1,10000,0,0,0,없음,' 의 CP949 인코딩
    const header = Buffer.from([0xc3, 0xdf, 0xc0, 0xfb, 0xc4, 0xda, 0xb5, 0xe5, 0x2c, 0xc6, 0xc7, 0xb8, 0xc5]);
    const none = Buffer.from([0xbe, 0xf8, 0xc0, 0xbd]); // '없음'
    const bytes = Buffer.concat([header, Buffer.from('\nGSB-000001,1,10000,0,0,0,'), none, Buffer.from(',')]);
    const { text, encoding } = decodeCsvBytes(new Uint8Array(bytes));
    expect(encoding).toBe('cp949');
    expect(text.startsWith('추적코드,판매')).toBe(true);
    const rows = parseSaleCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].error).toBeNull();
    expect(rows[0].returnBearer).toBe('NONE');
    expect(decodeCsvBytes(new TextEncoder().encode('GSB-000001,가')).encoding).toBe('utf-8');
  });
  it('B-M5: 판매 금액이 수량 × 판매가와 크게 다르면 불일치', () => {
    expect(amountMismatch(10, 10n, 5000n, 0n)).toBe(true);
    expect(amountMismatch(10, 50000n, 5000n, 3000n)).toBe(false);
    expect(amountMismatch(10, 45000n, 5000n, 0n)).toBe(false); // 할인
    expect(amountMismatch(1, 500000n, 5000n, 3000n)).toBe(true);
    expect(parseSaleCsv('GSB-000001,0,5000,0,0,0,없음,')[0].error).toMatch(/함께/);
  });
  it('B-M3: 환불 환입은 원래 판매 요율로 계산한다', () => {
    const cfg20 = { feeRatePercent: '20', feeVatMode: 'INCLUDED' as const };
    const cfg30 = { feeRatePercent: '30', feeVatMode: 'INCLUDED' as const };
    // 30% 에 100,000 판매 → 20% 로 변경 → 전액 환불: 환입은 30% (기관 0원, 예전 계산은 −10,000원)
    const r = settleLine({ grossAmount: 0n, refundAmount: 100000n, returnCost: 0n, returnBearer: 'NONE' }, cfg20, cfg30);
    expect(r.fee).toBe(-30000n);
    expect(r.payout).toBe(-70000n);
    const old = settleLine({ grossAmount: 0n, refundAmount: 100000n, returnCost: 0n, returnBearer: 'NONE' }, cfg20);
    expect(old.payout).toBe(-80000n);
    // 같은 요율이면 예전 결과와 같다
    expect(settleLine({ grossAmount: 50000n, refundAmount: 10000n, returnCost: 0n, returnBearer: 'NONE' }, cfg30, cfg30).fee).toBe(12000n);
  });
  it('낮음: 추적 코드는 숫자를 끝까지 읽는다(7자리·뒤에 숫자 붙은 오인식 방지)', () => {
    expect(findTrackingCode('[GSB-000001] 세제')).toBe('GSB-000001');
    expect(findTrackingCode('GSB-0000012')).toBeNull();
    expect(findTrackingCode('GSB-0000015개')).toBeNull();
    expect(findTrackingCode('GSB-1000000 수건')).toBe('GSB-1000000');
    expect(findTrackingCode('XGSB-000001')).toBeNull();
    expect(findTrackingCode('gsb-000123')).toBe('GSB-000123');
  });
  it('낮음: 주류 금지어(소주·와인·맥주·위스키 등), 술잔은 허용', () => {
    for (const w of ['참이슬 소주 360ml', '레드 와인', '수제 맥주 세트', '위스키 700ml', '막걸리']) expect(blockedKeyword(w)).not.toBeNull();
    expect(blockedKeyword('와인잔 2개 세트')).toBeNull();
    expect(blockedKeyword('무알코올 맥주')).toBe('맥주'); // 무알코올도 운영자 검토 전에는 막는다
    expect(blockedKeyword('수술용 장갑')).toBeNull();
  });
  it('낮음: 요율 문자열 검증(1e1 등 거절)·설정 범위 오류 문구', () => {
    expect(isFeeRateString('30')).toBe(true);
    expect(isFeeRateString('12.5')).toBe(true);
    for (const v of ['1e1', ' 30', '030', '91', '-1', '30.123', '']) expect(isFeeRateString(v)).toBe(false);
    expect(normalizeConfig({ feeRatePercent: '1e1' }).feeRatePercent).toBe('30');
    const errs = validateConfigInput({ ...DEFAULT_BAZAAR_CONFIG, feeRatePercent: '1e1', settlementPayDay: 31, matchDeadlineDays: 0 });
    expect(errs.join('\n')).toMatch(/수수료 요율/);
    expect(errs.join('\n')).toMatch(/정산 지급일/);
    expect(errs.join('\n')).toMatch(/매칭 수락 기한/);
    expect(validateConfigInput(DEFAULT_BAZAAR_CONFIG)).toEqual([]);
  });
  it('낮음: 매칭 만료 배치가 배치 목록에 등록돼 있다', () => {
    expect(CRON_JOBS.find((j) => j.name === 'bazaar')?.path).toBe('/api/cron/bazaar');
  });
});

// ---------------------------------------------------------------- DB 흐름

describe('라이브 바자회 점검 조치 — 흐름·동시성', () => {
  let merchantId: string;
  let merchantUserId: string;
  let adminA: string;
  let adminB: string;

  beforeEach(async () => {
    await resetDb();
    session.user = null;
    const f = await seedBasics();
    merchantId = f.merchantId;
    merchantUserId = f.merchantUserId;
    adminA = await makeAdmin('SUPER_ADMIN');
    adminB = await makeAdmin('OPERATION');
    await setLiveBazaarEnabled(true, adminA);
    await readyMerchant(merchantId);
    await decideParticipation(merchantId, 'APPROVED', adminA);
  });

  // ------------------------------------------------ B-1
  it('B-1: 0원 이하 정산은 확정 때 다음 달로 이월(CARRIED)되고 다음 정산에서 차감된다', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA);
    await sell(adminB, adminA, [row(product.trackingCode, 10, 100000n)]);
    const m1 = kstMonthKey();
    await generateSettlements(m1);
    const s1 = await prisma.bazaarSettlement.findFirstOrThrow({ where: { merchantId, month: m1 } });
    expect((await confirmSettlement(s1.id, adminA)).status).toBe('CONFIRMED');
    await markSettlementPaid(s1.id, adminA, { transferRef: '이체', paidAt: new Date() });

    // 다음 달(열린 달)로 환불 10,000 만 들어옴 → 지급액 −7,000
    await sell(adminB, adminA, [row(product.trackingCode, 0, 0n, 1, 10000n)]);
    const m2 = nextMonth(m1);
    await generateSettlements(m2);
    const s2 = await prisma.bazaarSettlement.findFirstOrThrow({ where: { merchantId, month: m2 } });
    expect(s2.payout).toBe(-7000n);
    const r = await confirmSettlement(s2.id, adminA);
    expect(r.status).toBe('CARRIED');
    const m3 = nextMonth(m2);
    expect(r.carriedToMonth).toBe(m3);
    const after = await prisma.bazaarSettlement.findUniqueOrThrow({ where: { id: s2.id } });
    expect(after.status).toBe('CARRIED');
    expect(after.carriedToMonth).toBe(m3);
    // 원장: 넘긴 달에 +7,000(CARRY_OUT) → 그 달 순합계 0, 받는 달에 −7,000(CARRY_IN)
    const carry = await prisma.bazaarLedger.findUniqueOrThrow({ where: { idempotencyKey: `carry:${s2.id}` } });
    expect(carry.month).toBe(m3);
    expect(carry.amount).toBe(-7000n);
    const m2sum = await prisma.bazaarLedger.aggregate({ where: { merchantId, month: m2 }, _sum: { amount: true } });
    expect(m2sum._sum.amount).toBe(0n);
    // 다시 확정·이월해도 두 번 반영되지 않는다
    await expect(confirmSettlement(s2.id, adminA)).rejects.toThrow(/집계 상태/);
    await expect(carryOverSettlement(s2.id, adminA)).rejects.toThrow(/확정/);

    // 다음 달 판매 20,000 → 귀속 14,000 − 이월 7,000 = 7,000
    const t3 = await settlementTotals(merchantId, m3);
    expect(t3.carryAmount).toBe(-7000n);
    expect(t3.payout).toBe(-7000n);
    await prisma.bazaarLedger.create({ data: { id: newId(), merchantId, month: m3, entryType: 'SALE', amount: 20000n, idempotencyKey: `test-sale:${newId()}` } });
    await prisma.bazaarLedger.create({ data: { id: newId(), merchantId, month: m3, entryType: 'FEE', amount: -6000n, idempotencyKey: `test-fee:${newId()}` } });
    await generateSettlements(m3);
    const s3 = await prisma.bazaarSettlement.findFirstOrThrow({ where: { merchantId, month: m3 } });
    expect(s3.carryAmount).toBe(-7000n);
    expect(s3.payout).toBe(7000n);
  });

  it('B-1: 예전 방식으로 0원 이하가 확정만 된 정산은 이월 버튼으로 닫는다', async () => {
    const month = kstMonthKey();
    const s = await prisma.bazaarSettlement.create({
      data: { id: newId(), merchantId, month, gross: 0n, refund: 5000n, fee: -1500n, feeVat: 0n, returnCost: 0n, payout: -3500n, status: 'CONFIRMED', dueDate: new Date() },
    });
    await expect(markSettlementPaid(s.id, adminA, { transferRef: 'x', paidAt: new Date() })).rejects.toThrow(/이월/);
    const r = await carryOverSettlement(s.id, adminA);
    expect(r.status).toBe('CARRIED');
    expect((await prisma.bazaarLedger.findUniqueOrThrow({ where: { idempotencyKey: `carry:${s.id}` } })).amount).toBe(-3500n);
    // 미지급 요약에서 빠진다
    const { unpaidSettlementSummary } = await import('@/server/services/bazaar-views');
    expect((await unpaidSettlementSummary()).count).toBe(0);
  });

  // ------------------------------------------------ B-2 / B-M6
  it('B-2: 판매 승인과 정산 확정이 동시에 일어나도 판매가 어느 정산에서도 빠지지 않는다', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA);
    await sell(adminB, adminA, [row(product.trackingCode, 1, 10000n)]);
    const month = kstMonthKey();
    await generateSettlements(month);
    const s = await prisma.bazaarSettlement.findFirstOrThrow({ where: { merchantId, month } });
    const batch2 = await createSaleBatch(adminB, { title: '2회', source: 'MANUAL', rows: [row(product.trackingCode, 5, 50000n)] });
    await Promise.all([approveSaleBatch(batch2, { userId: adminA, superAdmin: false }), confirmSettlement(s.id, adminA)]);
    const confirmed = await prisma.bazaarSettlement.findUniqueOrThrow({ where: { id: s.id } });
    const sale2 = await prisma.bazaarLedger.findFirstOrThrow({ where: { batchId: batch2, entryType: 'SALE' } });
    // 판매가 확정 정산에 들어갔으면 그 금액이 확정 금액에 포함되고, 아니면 다음 달 원장으로 갔다.
    const monthLedger = await settlementTotals(merchantId, month);
    expect(confirmed.gross).toBe(monthLedger.gross);
    if (sale2.month === month) expect(confirmed.gross).toBe(60000n);
    else {
      expect(sale2.month).toBe(nextMonth(month));
      expect(confirmed.gross).toBe(10000n);
    }
  });

  it('B-M6: 집계와 확정이 겹쳐도 확정 금액을 덮어쓰지 않는다', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA);
    await sell(adminB, adminA, [row(product.trackingCode, 2, 20000n)]);
    const month = kstMonthKey();
    await generateSettlements(month);
    const s = await prisma.bazaarSettlement.findFirstOrThrow({ where: { merchantId, month } });
    await Promise.all([confirmSettlement(s.id, adminA), generateSettlements(month), generateSettlements(month)]);
    const after = await prisma.bazaarSettlement.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.status).toBe('CONFIRMED');
    expect(after.gross).toBe(20000n);
    expect(after.payout).toBe(14000n);
  });

  // ------------------------------------------------ B-3
  it('B-3: 화면에서 본 제안이 아니면 확정하지 않는다(그 사이 재제안)', async () => {
    const { g, donationId } = await toValuating(merchantId, merchantUserId);
    const item = await prisma.inKindItem.findFirstOrThrow({ where: { donationId } });
    const seen = await lastProposalId(donationId); // 기관이 본 100,000원 제안
    await proposeValuation(donationId, { type: 'DONOR', userId: g.userId, donorId: g.donorId }, { [item.id]: '100000' });
    await expect(acceptValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId }, seen)).rejects.toThrow(/새 가액/);
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('VALUATING');
    await expect(acceptValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId }, '')).rejects.toThrow(/확인할 수 없습니다/);
    await acceptValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId }, await lastProposalId(donationId));
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).confirmedTotal).toBe(1_000_000n);
  });

  it('B-3: 확정과 재제안이 동시에 와도 확정 가액은 화면에서 본 제안과 같다', async () => {
    const { g, donationId } = await toValuating(merchantId, merchantUserId);
    const item = await prisma.inKindItem.findFirstOrThrow({ where: { donationId } });
    const seen = await lastProposalId(donationId);
    const res = await Promise.allSettled([
      acceptValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId }, seen),
      proposeValuation(donationId, { type: 'DONOR', userId: g.userId, donorId: g.donorId }, { [item.id]: '100000' }),
    ]);
    const d = await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } });
    if (res[0].status === 'fulfilled') {
      expect(d.status).toBe('VALUE_CONFIRMED');
      expect(d.confirmedTotal).toBe(100_000n);
      expect(res[1].status).toBe('rejected'); // 확정 뒤 제안은 거절
    } else {
      expect(d.status).toBe('VALUATING');
      expect(d.confirmedTotal).toBeNull();
    }
  });

  // ------------------------------------------------ B-5
  it('B-5: 참여 정지 시 대기 제안 철회, 정지 기관은 수락·가액 확정·검수 확정·편성 승인 불가', async () => {
    const { donationId: valuating } = await toValuating(merchantId, merchantUserId);
    const g = await corporateGiver();
    const pending = await createDonation(g.donorId, g.userId, { ...BASE, preferredMerchantId: merchantId, items: [{ name: '세제', category: '생활용품', quantity: 1, condition: 'NEW', declaredUnitValue: 5000 }] });
    const match = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId: pending } });

    const r = await decideParticipation(merchantId, 'SUSPENDED', adminA, '점검');
    expect(r.withdrawn).toBe(1);
    expect((await prisma.inKindMatch.findUniqueOrThrow({ where: { id: match.id } })).status).toBe('WITHDRAWN');
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: pending } })).status).toBe('SUBMITTED');
    const log = await prisma.inKindStatusLog.findFirst({ where: { donationId: pending, note: { contains: '참여 정지' } } });
    expect(log).not.toBeNull();

    await expect(respondMatch(merchantId, match.id, true, merchantUserId)).rejects.toThrow();
    await expect(acceptValuation(valuating, { type: 'MERCHANT', userId: merchantUserId, merchantId }, await lastProposalId(valuating))).rejects.toThrow(/참여가 승인된/);
    await expect(confirmInspection(merchantId, valuating, merchantUserId)).rejects.toThrow(/참여가 승인된/);
    const { decideLive } = await import('@/server/services/bazaar');
    await expect(decideLive(merchantId, newId(), true, merchantUserId)).rejects.toThrow(/참여가 승인된/);

    // 서버 액션 가드: 정지 기관은 막히고, 참여 신청 화면 저장(applyParticipation)은 가드를 통과한다(서비스가 정지 문구로 거절).
    session.user = { id: merchantUserId, role: 'MERCHANT', merchantId, merchantStatus: 'APPROVED' };
    const { respondMatchAction, applyParticipationAction } = await import('@/app/actions/bazaar-studio');
    const fd = new FormData();
    fd.set('matchId', match.id);
    fd.set('decision', 'ACCEPT');
    const res = await respondMatchAction({ ok: false }, fd);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/정지/);
    const fd2 = new FormData();
    fd2.set('consignmentName', '담당자');
    fd2.set('agree', 'on');
    const res2 = await applyParticipationAction({ ok: false }, fd2);
    expect(res2.message).toMatch(/정지된 상태/);
  });

  it('B-5: 제안 뒤 공익법인 지정이 만료되면 수락하지 못한다', async () => {
    const g = await corporateGiver();
    const d = await createDonation(g.donorId, g.userId, { ...BASE, preferredMerchantId: merchantId, items: [{ name: '세제', category: '생활용품', quantity: 1, condition: 'NEW', declaredUnitValue: 5000 }] });
    const m = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId: d } });
    await prisma.merchantProfile.update({ where: { id: merchantId }, data: { designatedDoneeUntil: new Date(Date.now() - 86_400_000) } });
    await expect(respondMatch(merchantId, m.id, true, merchantUserId)).rejects.toThrow(/공익법인/);
  });

  // ------------------------------------------------ B-M1
  it('B-M1: 재발급을 동시에 두 번 눌러도 발급 영수증은 1장', async () => {
    const { donationId, receipt } = await toListed(merchantId, merchantUserId, adminA);
    await voidInKindReceipt(receipt.id, adminA, '정정');
    const res = await Promise.allSettled([reissueInKindReceipt(donationId, adminA), reissueInKindReceipt(donationId, adminA)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.inKindReceipt.count({ where: { donationId, status: 'ISSUED' } })).toBe(1);
    // DB 최후 방어선: 부분 유니크 인덱스
    const issued = await prisma.inKindReceipt.findFirstOrThrow({ where: { donationId, status: 'ISSUED' } });
    await expect(
      prisma.inKindReceipt.create({ data: { ...issued, id: newId(), seq: issued.seq + 50, receiptNo: `${issued.receiptNo}-X`, donorSnapshot: {}, issuerSnapshot: {}, items: [] } }),
    ).rejects.toThrow();
  });

  // ------------------------------------------------ B-M2
  it('B-M2: 근거 판매가 반려되면 그 판매를 근거로 넣은 환불은 승인되지 않는다', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA);
    const saleBatch = await createSaleBatch(adminB, { title: '판매', source: 'MANUAL', rows: [row(product.trackingCode, 2, 20000n)] });
    const refundBatch = await createSaleBatch(adminB, { title: '환불', source: 'MANUAL', rows: [row(product.trackingCode, 0, 0n, 1, 10000n)] });
    await rejectSaleBatch(saleBatch, adminA, '오입력');
    await expect(approveSaleBatch(refundBatch, { userId: adminA, superAdmin: false })).rejects.toThrow(/환불/);
    expect(await prisma.bazaarLedger.count({ where: { batchId: refundBatch } })).toBe(0);
    expect((await prisma.bazaarSaleBatch.findUniqueOrThrow({ where: { id: refundBatch } })).status).toBe('DRAFT');
  });

  it('B-M2: 따로 입력한 두 판매 결과를 동시에 승인해도 재고를 넘지 않는다', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA, 10);
    const b1 = await createSaleBatch(adminB, { title: '1', source: 'MANUAL', rows: [row(product.trackingCode, 6, 60000n)] });
    // 같은 상품의 두 번째 입력은 대기 묶음까지 보므로 입력 단계에서 막힌다. 동시 입력 경쟁을 흉내 내 DB 에 직접 넣는다.
    const b2 = newId();
    await prisma.bazaarSaleBatch.create({
      data: { id: b2, title: '2', source: 'MANUAL', createdBy: adminB, lines: { create: [{ id: newId(), productId: product.id, merchantId, soldQty: 6, grossAmount: 60000n }] } },
    });
    const res = await Promise.allSettled([approveSaleBatch(b1, { userId: adminA, superAdmin: false }), approveSaleBatch(b2, { userId: adminA, superAdmin: false })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const sold = await prisma.bazaarSaleLine.aggregate({ where: { productId: product.id, batch: { status: 'APPROVED' } }, _sum: { soldQty: true } });
    expect(sold._sum.soldQty).toBe(6);
  });

  it('낮음(B-M2 연계): 판매 수량은 이미 판매 결과에 들어간 수량 아래로 줄일 수 없다', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA, 10);
    await sell(adminB, adminA, [row(product.trackingCode, 4, 40000n)]);
    await expect(updateProduct(product.id, { name: product.name, salePrice: 10000, shippingFee: 0, quantity: 3, perPersonLimit: 5 })).rejects.toThrow(/아래로 줄일 수 없습니다/);
    await updateProduct(product.id, { name: product.name, salePrice: 10000, shippingFee: 0, quantity: 4, perPersonLimit: 5 });
  });

  // ------------------------------------------------ B-M3
  it('B-M3: 요율이 바뀐 뒤 환불하면 원래 판매 요율로 환입한다', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA);
    await sell(adminB, adminA, [row(product.trackingCode, 10, 100000n)]); // 30%
    const line1 = await prisma.bazaarSaleLine.findFirstOrThrow({ where: { productId: product.id } });
    expect(line1.feeRatePercent).toBe('30');
    expect(line1.feeVatMode).toBe('INCLUDED');
    await saveBazaarConfig({ ...(await getBazaarConfig()), feeRatePercent: '20' }, adminA);
    const refundBatch = await sell(adminB, adminA, [row(product.trackingCode, 0, 0n, 10, 100000n)]);
    const fee = await prisma.bazaarLedger.findFirstOrThrow({ where: { batchId: refundBatch, entryType: 'FEE' } });
    expect(fee.amount).toBe(30000n); // 30% 환입(예전 계산은 20% = 20,000)
    const line2 = await prisma.bazaarSaleLine.findFirstOrThrow({ where: { batchId: refundBatch } });
    expect(line2.refundFeeRatePercent).toBe('30');
    // 판매·환불 합계 기관 귀속 0
    const all = await prisma.bazaarLedger.aggregate({ where: { merchantId, entryType: { in: ['SALE', 'REFUND', 'FEE'] } }, _sum: { amount: true } });
    expect(all._sum.amount).toBe(0n);
  });

  // ------------------------------------------------ B-M4
  it('B-M4: 남은 물품을 기부자에게 반환하면 재발급 금액에서 빠지고, 정정 전에는 종결할 수 없다', async () => {
    const { donationId, receipt, product } = await toListed(merchantId, merchantUserId, adminA, 10, 30000);
    expect(receipt.totalAmount).toBe(300000n);
    await sell(adminB, adminA, [row(product.trackingCode, 4, 40000n)]);
    const r = await endProduct(product.id, adminA, 'RETURN');
    expect(r.returnedQty).toBe(6);
    expect(r.correctionNeeded).toBe(true);
    const note = await prisma.inKindStatusLog.findFirst({ where: { donationId, note: { contains: '기부자 반환' } } });
    expect(note?.note).toMatch(/영수증 정정 필요/);
    const fix = await receiptCorrectionNeeded(donationId);
    expect(fix?.expected).toBe(120000n);
    await expect(closeDonation(donationId, adminA)).rejects.toThrow(/정정이 필요/);
    await voidInKindReceipt(receipt.id, adminA, '반환 수량 정정');
    const again = await reissueInKindReceipt(donationId, adminA);
    expect(again.totalAmount).toBe(4n * 30000n);
    expect((again.items as Array<{ quantity: number }>)[0].quantity).toBe(4);
    expect(await receiptCorrectionNeeded(donationId)).toBeNull();
    await closeDonation(donationId, adminA);
    // 반환 종료 상품에는 판매를 더 넣을 수 없다
    await expect(createSaleBatch(adminB, { title: 'x', source: 'MANUAL', rows: [row(product.trackingCode, 1, 10000n)] })).rejects.toThrow(/돌려주고/);
  });

  // ------------------------------------------------ B-M5 (서비스)
  it('B-M5: 판매 금액이 수량 × 판매가와 크게 다르면 판매 결과 입력을 거절', async () => {
    const { product } = await toListed(merchantId, merchantUserId, adminA);
    await expect(createSaleBatch(adminB, { title: 'x', source: 'CSV', rows: [row(product.trackingCode, 1, 10n)] })).rejects.toThrow(/크게 다릅니다/);
  });

  // ------------------------------------------------ B-M7
  it('B-M7: 현물 기부 회원 계정으로는 기관 도입 신청을 할 수 없다(역할 유지)', async () => {
    const g = await corporateGiver();
    session.user = { id: g.userId, role: 'GIVER', email: 'g@test.kr' };
    const { applyMerchant } = await import('@/app/actions/merchant-apply');
    const fd = new FormData();
    for (const [k, v] of Object.entries({ displayName: '새 기관', contactEmail: 'org@test.kr', agree: 'on', channelUrl: '' })) fd.set(k, v);
    const r = await applyMerchant({ ok: false }, fd);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/별도|새 계정/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: g.userId } })).role).toBe('GIVER');
    expect(await prisma.merchantProfile.count({ where: { userId: g.userId } })).toBe(0);
  });

  // ------------------------------------------------ B-M8
  it('B-M8: 기부자 대장·셀러브릭스 CSV 는 금전 권한 관리자만, 대장 반출은 감사로그', async () => {
    const { GET } = await import('@/app/api/bazaar/export/route');
    await corporateGiver();
    const req = (k: string) => new Request(`http://localhost/api/bazaar/export?kind=${k}&merchantId=${merchantId}`);
    for (const permission of ['READ_ONLY', 'SUPPORT']) {
      const id = await makeAdmin(permission as 'READ_ONLY' | 'SUPPORT');
      session.user = { id, role: 'ADMIN', adminPermission: permission };
      expect((await GET(req('givers'))).status).toBe(404);
      expect((await GET(req('sellerbricks'))).status).toBe(404);
      expect((await GET(req('ledger'))).status).toBe(404);
    }
    session.user = { id: adminB, role: 'ADMIN', adminPermission: 'OPERATION' };
    expect((await GET(req('givers'))).status).toBe(200);
    expect((await GET(req('ledger'))).status).toBe(200);
    session.user = { id: merchantUserId, role: 'MERCHANT', merchantId, merchantStatus: 'APPROVED' };
    expect((await GET(req('ledger'))).status).toBe(200);
    expect(await prisma.adminAuditLog.count({ where: { action: 'BAZAAR_LEDGER_EXPORT' } })).toBe(2);
  });

  // ------------------------------------------------ B-M9
  it('B-M9: 파일 검사에 실패하면 기부 건을 만들지 않는다', async () => {
    const g = await corporateGiver();
    const bad = new File([Buffer.from('this is not an image file')], 'evil.exe');
    await expect(prepareDonationFiles([{ kind: 'PHOTO', file: bad }])).rejects.toThrow(/JPG/);
    const big = new File([Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(5 * 1024 * 1024)])], 'big.jpg');
    await expect(prepareDonationFiles([{ kind: 'PHOTO', file: big }])).rejects.toThrow(/5MB/);
    const jpg = () => new File([Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)])], 'a.jpg');
    await expect(prepareDonationFiles(Array.from({ length: 7 }, () => ({ kind: 'PHOTO' as const, file: jpg() })))).rejects.toThrow(/6개/);
    const pdf = new File([Buffer.from('%PDF-1.4 xxxxxxxxx')], 'a.pdf');
    await expect(prepareDonationFiles([{ kind: 'PHOTO', file: pdf }])).rejects.toThrow(/사진/);

    // 서버 액션: 파일이 틀리면 기부 건이 생기지 않는다
    session.user = { id: g.userId, role: 'GIVER' };
    const { createDonationAction } = await import('@/app/actions/bazaar-giver');
    const fd = new FormData();
    for (const [k, v] of Object.entries({ itemCount: '1', item_name_0: '수건', item_category_0: '생활용품', item_qty_0: '1', item_condition_0: 'NEW', item_value_0: '1000', matchMode: 'ANY', unsoldAction: 'MERCHANT_USE', deliveryMethod: 'SEND' })) fd.set(k, v);
    fd.append('photos', bad);
    const res = await createDonationAction({ ok: false }, fd);
    expect(res.ok).toBe(false);
    expect(await prisma.inKindDonation.count({ where: { donorId: g.donorId } })).toBe(0);
    // 최저 판매가가 숫자가 아니면 조용히 버리지 않고 거절(낮음)
    const fd2 = new FormData();
    for (const [k, v] of fd.entries()) if (k !== 'photos') fd2.set(k, v);
    fd2.set('minSalePrice', '만원');
    const res2 = await createDonationAction({ ok: false }, fd2);
    expect(res2.message).toMatch(/최저 판매가/);
    expect(await prisma.inKindDonation.count({ where: { donorId: g.donorId } })).toBe(0);
    // 올바른 파일은 기부 건과 함께 한 번에 저장된다
    const files = await prepareDonationFiles([{ kind: 'PHOTO', file: jpg() }, { kind: 'EVIDENCE', file: new File([Buffer.from('%PDF-1.4 xxxxxxxxx')], 'b.pdf') }]);
    const id = await createDonation(g.donorId, g.userId, { ...BASE, matchMode: 'ANY', items: [{ name: '수건', category: '생활용품', quantity: 1, condition: 'NEW', declaredUnitValue: 1000 }] }, files);
    expect(await prisma.inKindFile.count({ where: { donationId: id } })).toBe(2);
  });

  // ------------------------------------------------ 낮음
  it('낮음: 고객지원 권한은 입고·판매 결과·판매 종료를 처리할 수 없다', async () => {
    const support = await makeAdmin('SUPPORT');
    session.user = { id: support, role: 'ADMIN', adminPermission: 'SUPPORT' };
    const actions = await import('@/app/actions/admin/bazaar');
    const fd = new FormData();
    fd.set('donationId', 'x');
    fd.set('rowsText', 'GSB-000001,1,10000,0,0,0,없음,');
    fd.set('title', 't');
    fd.set('productId', 'x');
    fd.set('remainingAction', 'MERCHANT_USE');
    for (const a of [actions.registerInboundAction, actions.createSaleBatchAction, actions.endProductAction]) {
      const r = await a({ ok: false }, fd);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/최고관리자·운영·재무/);
    }
  });

  it('낮음: 설정 범위 밖 값은 기본값으로 바꿔 저장하지 않고 오류', async () => {
    session.user = { id: adminA, role: 'ADMIN', adminPermission: 'SUPER_ADMIN' };
    const { saveBazaarConfigAction } = await import('@/app/actions/admin/bazaar');
    const fd = new FormData();
    for (const [k, v] of Object.entries({ feeRatePercent: '1e1', minSalePrice: '5000', defaultPerPersonLimit: '5', matchDeadlineDays: '45', settlementPayDay: '10', warehouseAddress: '', consignmentNotice: '' })) fd.set(k, v);
    const r = await saveBazaarConfigAction({ ok: false }, fd);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/수수료 요율/);
    expect(r.message).toMatch(/매칭 수락 기한/);
  });

  it('낮음: 편성은 참여 승인 기관만, 방송 주소 변경은 감사로그', async () => {
    await saveSeller({ name: '셀러', sellerbricksId: 's1' });
    const seller = await prisma.bazaarSeller.findFirstOrThrow();
    const other = await prisma.merchantProfile.create({ data: { id: newId(), userId: (await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@t.kr`, name: 'm', role: 'MERCHANT' } })).id, code: `GIV-${newId().slice(-4)}`, displayName: '다른 기관', status: 'APPROVED' } });
    await expect(createLive(adminA, { merchantId: other.id, sellerId: seller.id, title: '방송', scheduledAt: new Date(), productIds: [] })).rejects.toThrow(/참여가 승인된/);
    const liveId = await createLive(adminA, { merchantId, sellerId: seller.id, title: '방송', scheduledAt: new Date(), productIds: [] });
    session.user = { id: adminA, role: 'ADMIN', adminPermission: 'SUPER_ADMIN' };
    const { liveStatusAction } = await import('@/app/actions/admin/bazaar');
    const fd = new FormData();
    fd.set('liveId', liveId);
    fd.set('status', 'URL');
    fd.set('broadcastUrl', 'https://live.example.com/1');
    expect((await liveStatusAction({ ok: false }, fd)).ok).toBe(true);
    expect(await prisma.adminAuditLog.count({ where: { action: 'BAZAAR_LIVE_URL', targetId: liveId } })).toBe(1);
  });

  it('낮음: 매칭 만료 배치가 기한 지난 제안을 되돌린다', async () => {
    const g = await corporateGiver();
    const d = await createDonation(g.donorId, g.userId, { ...BASE, matchMode: 'ANY', items: [{ name: '세제', category: '생활용품', quantity: 1, condition: 'NEW', declaredUnitValue: 5000 }] });
    await proposeMatch(d, merchantId, adminA);
    await prisma.inKindMatch.updateMany({ where: { donationId: d }, data: { deadline: new Date(Date.now() - 1000) } });
    const { GET } = await import('@/app/api/cron/bazaar/route');
    const res = await GET(new Request('http://localhost/api/cron/bazaar', { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.expiredMatches).toBe(1);
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: d } })).status).toBe('SUBMITTED');
  });

  it('낮음(결정 필요 안전 처리): 법인 현물 영수증은 홈택스 명세의 개인 주민번호 열이 아닌 별도 구역', async () => {
    const { receipt } = await toListed(merchantId, merchantUserId, adminA);
    const ht = await buildHometaxExport(merchantId, receipt.taxYear, adminA);
    const lines = ht.content.split('\r\n');
    const sep = lines.findIndex((l) => l.includes('법인·사업자 현물 기부'));
    expect(sep).toBeGreaterThan(0);
    const before = lines.slice(0, sep).join('\n');
    expect(before).not.toContain('2208112345');
    expect(lines.slice(sep).join('\n')).toContain('2208112345');
    expect(lines[sep + 1]).toContain('사업자등록번호');
  });
});
