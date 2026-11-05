import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics } from './helpers';
import {
  BazaarError,
  acceptValuation,
  approveSaleBatch,
  cancelDonationByDonor,
  confirmInspection,
  confirmSettlement,
  createDonation,
  createLive,
  createReconcile,
  createSaleBatch,
  decideParticipation,
  applyParticipation,
  eligibleMerchants,
  endProduct,
  expireMatches,
  generateSettlements,
  markProductListed,
  markSettlementPaid,
  pledgeDonation,
  proposeMatch,
  proposeValuation,
  registerGiver,
  registerInbound,
  respondMatch,
  saveSeller,
  updateDonorReceiptInfo,
  updateProduct,
  voidInKindReceipt,
  reissueInKindReceipt,
  saleRowsFromParsed,
} from '@/server/services/bazaar';
import { isLiveBazaarEnabled, setLiveBazaarEnabled, invalidateBazaarCache, saveBazaarConfig } from '@/server/services/bazaar-settings';
import { computeFee, parseSaleCsv, settleLine, DEFAULT_BAZAAR_CONFIG, blockedKeyword, settlementDueDate } from '@/lib/bazaar';
import { buildHometaxExport } from '@/server/services/receipts';
import { kstMonthKey } from '@/lib/datetime';

async function makeAdmin(permission: 'SUPER_ADMIN' | 'OPERATION' = 'SUPER_ADMIN') {
  const u = await prisma.user.create({ data: { id: newId(), email: `admin-${newId()}@test.kr`, name: '관리자', role: 'ADMIN' } });
  await prisma.adminProfile.create({ data: { id: newId(), userId: u.id, permission } });
  return u.id;
}

async function readyMerchant(merchantId: string) {
  await prisma.merchantProfile.update({
    where: { id: merchantId },
    data: {
      businessNo: '1234567890',
      representativeName: '김대표',
      address: '서울시 중구 세종대로 1',
      designatedDonee: true,
      designatedDoneeVerifiedAt: new Date(),
    },
  });
  await applyParticipation(merchantId, { consignmentName: '담당자', agree: true, neededItems: '생필품' });
}

async function corporateGiver() {
  return registerGiver({
    donorType: 'CORPORATE',
    email: `corp-${newId()}@test.kr`,
    password: 'x',
    passwordHash: 'x',
    displayName: '(주)나눔상사',
    contactName: '홍담당',
    phone: '010-2222-3333',
    businessNo: '220-81-12345',
    representativeName: '나대표',
    address: '서울시 강남구',
  });
}

const ITEMS = [
  { name: '주방세제 1L', category: '생활용품', quantity: 100, condition: 'NEW', declaredUnitValue: 3000 },
  { name: '수건 세트', category: '생활용품', quantity: 50, condition: 'NEW', declaredUnitValue: 8000 },
];

describe('라이브 바자회 — 순수 계산', () => {
  it('수수료 30% 부가세 포함: 공급가액·부가세 분리', () => {
    const r = computeFee(100000n, '30', 'INCLUDED');
    expect(r.fee).toBe(30000n);
    expect(r.supply + r.vat).toBe(30000n);
    expect(r.supply).toBe(27273n);
    expect(r.vat).toBe(2727n);
  });
  it('수수료 30% 부가세 별도: 부가세 10% 추가', () => {
    const r = computeFee(100000n, '30', 'EXCLUDED');
    expect(r.supply).toBe(30000n);
    expect(r.vat).toBe(3000n);
    expect(r.fee).toBe(33000n);
  });
  it('판매 한 줄 정산: 환불 차감 후 수수료, 기관 부담 반송비만 공제', () => {
    const cfg = DEFAULT_BAZAAR_CONFIG;
    const a = settleLine({ grossAmount: 50000n, refundAmount: 10000n, returnCost: 3000n, returnBearer: 'MERCHANT' }, cfg);
    expect(a.net).toBe(40000n);
    expect(a.fee).toBe(12000n);
    expect(a.payout).toBe(40000n - 12000n - 3000n);
    const b = settleLine({ grossAmount: 50000n, refundAmount: 0n, returnCost: 3000n, returnBearer: 'GIVESIGN' }, cfg);
    expect(b.payout).toBe(35000n);
  });
  it('판매 결과 CSV 파싱: 추적 코드 없는 줄(임시상품)은 오류', () => {
    const rows = parseSaleCsv('추적코드,판매수량,판매금액,환불수량,환불금액,반송비,반송비부담,메모\n[GSB-000001] 세제,3,"15,000",0,0,0,없음,\n임시상품 양말,1,5000,0,0,0,없음,');
    expect(rows).toHaveLength(2);
    expect(rows[0].trackingCode).toBe('GSB-000001');
    expect(rows[0].grossAmount).toBe(15000n);
    expect(rows[1].error).toMatch(/추적 코드/);
  });
  it('머리줄 없이 첫 줄부터 데이터면 버리지 않는다(첫 줄 상품명에 "상품"이 있어도)', () => {
    const rows = parseSaleCsv('양말 임시상품,1,5000,0,0,0,없음,\nGSB-000002,2,10000,0,0,0,없음,');
    expect(rows).toHaveLength(2);
    expect(rows[0].error).toMatch(/추적 코드/);
    expect(rows[1].trackingCode).toBe('GSB-000002');
    expect(parseSaleCsv('추적코드,판매수량,판매금액\nGSB-000001,1,5000')).toHaveLength(1);
  });
  it('금지 품목 판정', () => {
    expect(blockedKeyword('홍삼 건강기능식품')).toBe('건강기능식품');
    expect(blockedKeyword('술')).toBe('술');
    expect(blockedKeyword('수술용 장갑')).toBeNull();
    expect(blockedKeyword('주방세제')).toBeNull();
  });
  it('정산 지급일은 다음 달 지정일', () => {
    expect(settlementDueDate('2026-12', 10).toISOString().slice(0, 10)).toBe('2027-01-10');
  });
});

describe('라이브 바자회 — 스위치', () => {
  beforeEach(async () => {
    await resetDb();
  });
  it('기본값은 꺼짐, 켜고 끌 수 있다', async () => {
    expect(await isLiveBazaarEnabled()).toBe(false);
    const admin = await makeAdmin();
    await setLiveBazaarEnabled(true, admin);
    expect(await isLiveBazaarEnabled()).toBe(true);
    await setLiveBazaarEnabled(false, admin);
    invalidateBazaarCache();
    expect(await isLiveBazaarEnabled()).toBe(false);
  });
});

describe('라이브 바자회 — 전체 흐름', () => {
  let merchantId: string;
  let merchantUserId: string;
  let adminA: string;
  let adminB: string;

  beforeEach(async () => {
    await resetDb();
    const f = await seedBasics();
    merchantId = f.merchantId;
    merchantUserId = f.merchantUserId;
    adminA = await makeAdmin('SUPER_ADMIN');
    adminB = await makeAdmin('OPERATION');
    await setLiveBazaarEnabled(true, adminA);
    await readyMerchant(merchantId);
  });

  it('참여 승인 전에는 매칭 대상이 아니다', async () => {
    expect(await eligibleMerchants()).toHaveLength(0);
    await decideParticipation(merchantId, 'APPROVED', adminA);
    expect((await eligibleMerchants()).map((m) => m.id)).toEqual([merchantId]);
  });

  it('금지 품목·유통기한 짧은 물품은 접수되지 않는다', async () => {
    const g = await corporateGiver();
    await expect(
      createDonation(g.donorId, g.userId, {
        items: [{ name: '비타민 건강기능식품', category: '식품', quantity: 1, condition: 'NEW', declaredUnitValue: 1000 }],
        matchMode: 'ANY', brandPublic: false, unsoldAction: 'MERCHANT_USE', deliveryMethod: 'SEND',
      }),
    ).rejects.toThrow(/받을 수 없는 품목/);
    await expect(
      createDonation(g.donorId, g.userId, {
        items: [{ name: '라면', category: '식품', quantity: 1, condition: 'NEW', declaredUnitValue: 1000, expiryDate: '2020-01-01' }],
        matchMode: 'ANY', brandPublic: false, unsoldAction: 'MERCHANT_USE', deliveryMethod: 'SEND',
      }),
    ).rejects.toThrow(/유통기한/);
  });

  it('기업 기부 → 매칭 → 가액 협의 → 약정 → 입고 → 검수 확정·영수증 → 판매 → 정산 → 지급', async () => {
    await decideParticipation(merchantId, 'APPROVED', adminA);
    const g = await corporateGiver();
    const donationId = await createDonation(g.donorId, g.userId, {
      items: ITEMS, matchMode: 'ANY', brandPublic: false, unsoldAction: 'MERCHANT_USE', deliveryMethod: 'SEND',
    });
    let d = await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId }, include: { items: { orderBy: { seq: 'asc' } } } });
    expect(d.status).toBe('SUBMITTED');
    expect(d.declaredTotal).toBe(100n * 3000n + 50n * 8000n);

    // 매칭 제안 → 기관 수락
    await proposeMatch(donationId, merchantId, adminA);
    const match = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId } });
    await respondMatch(merchantId, match.id, true, merchantUserId);
    d = await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId }, include: { items: { orderBy: { seq: 'asc' } } } });
    expect(d.status).toBe('VALUATING');
    expect(d.merchantId).toBe(merchantId);

    // 자기 제안은 스스로 확정할 수 없다 (기부자 접수 제안 → 기부자가 확정 시도)
    await expect(acceptValuation(donationId, { type: 'DONOR', userId: g.userId, donorId: g.donorId })).rejects.toThrow(/상대가 수락/);
    // 기관 역제안 → 기부자 수락
    await proposeValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId }, { [d.items[0].id]: '2500', [d.items[1].id]: '7000' }, '시중가 반영');
    await acceptValuation(donationId, { type: 'DONOR', userId: g.userId, donorId: g.donorId });
    d = await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId }, include: { items: { orderBy: { seq: 'asc' } } } });
    expect(d.status).toBe('VALUE_CONFIRMED');
    expect(d.confirmedTotal).toBe(100n * 2500n + 50n * 7000n);
    expect(d.items[0].unitValue).toBe(2500n);

    // 약정 이후에는 기부자가 스스로 취소할 수 없다
    const hash = await pledgeDonation(g.donorId, donationId, g.userId, { name: '홍담당', agree: true });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    await expect(cancelDonationByDonor(g.donorId, donationId, g.userId, '변심')).rejects.toThrow(/약정 이후/);

    // 입고·검수(일부 합격, 반송비 기관 부담)
    await registerInbound(donationId, adminA, {
      warehouse: '기브싸인 바자회 센터', receivedAt: new Date(), result: 'PARTIAL',
      items: [
        { itemId: d.items[0].id, receivedQty: 100, acceptedQty: 90, note: '파손 10' },
        { itemId: d.items[1].id, receivedQty: 50, acceptedQty: 50 },
      ],
      returnCost: 4000n, returnCostBearer: 'MERCHANT',
    });
    // 기관 검수 확정 → 현물 영수증
    const receipt = await confirmInspection(merchantId, donationId, merchantUserId);
    expect(receipt.totalAmount).toBe(90n * 2500n + 50n * 7000n);
    expect(receipt.receiptNo).toMatch(/-H000001$/);
    expect(receipt.donorType).toBe('CORPORATE');
    await expect(confirmInspection(merchantId, donationId, merchantUserId)).rejects.toThrow();

    const products = await prisma.bazaarProduct.findMany({ where: { donationId }, orderBy: { trackingCode: 'asc' } });
    expect(products).toHaveLength(2);
    expect(products[0].trackingCode).toBe('GSB-000001');
    expect(products[0].quantity).toBe(90);
    expect(products[0].salePrice).toBe(5000n); // 최소 판매가

    // 최소 판매가 아래로는 바꿀 수 없다
    await expect(updateProduct(products[0].id, { name: '주방세제', salePrice: 1000, shippingFee: 3000, quantity: 90, perPersonLimit: 5 })).rejects.toThrow(/최소 판매가/);
    await updateProduct(products[0].id, { name: '주방세제 1L', salePrice: 5000, shippingFee: 3000, quantity: 90, perPersonLimit: 5 });

    // 판매 등록 대기 상품은 판매 결과에 넣을 수 없다
    await expect(
      createSaleBatch(adminB, { title: '1회차', source: 'MANUAL', rows: [{ trackingCode: 'GSB-000001', soldQty: 1, grossAmount: 5000n, refundQty: 0, refundAmount: 0n, returnCost: 0n, returnBearer: 'NONE' }] }),
    ).rejects.toThrow(/등록 완료/);
    await markProductListed(products[0].id, adminA, 'SB-123');
    await markProductListed(products[1].id, adminA, 'SB-124');
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('ON_SALE');

    // 셀러·편성
    await saveSeller({ name: '김셀러', sellerbricksId: 'seller01', phone: '01099998888' });
    const seller = await prisma.bazaarSeller.findFirstOrThrow();
    const liveId = await createLive(adminA, { merchantId, sellerId: seller.id, title: '나눔 바자회 1회', scheduledAt: new Date(Date.now() + 86400000), productIds: products.map((p) => p.id) });
    expect(liveId).toBeTruthy();

    // 판매 결과 입력(초과 판매는 거절)
    await expect(
      createSaleBatch(adminB, { title: '초과', source: 'MANUAL', rows: [{ trackingCode: 'GSB-000001', soldQty: 91, grossAmount: 455000n, refundQty: 0, refundAmount: 0n, returnCost: 0n, returnBearer: 'NONE' }] }),
    ).rejects.toThrow(/누적 판매 수량/);
    const csv = parseSaleCsv(
      '추적코드,판매수량,판매금액,환불수량,환불금액,반송비,반송비부담,메모\n' +
        'GSB-000001,20,100000,2,10000,3000,기관,\n' +
        'GSB-000002,10,150000,0,0,0,없음,',
    );
    const { rows, errors } = saleRowsFromParsed(csv);
    expect(errors).toEqual([]);
    const batchId = await createSaleBatch(adminB, { title: '1회차', liveId, source: 'CSV', rows });

    // 입력자 본인은 승인 불가(운영 권한), 최고관리자는 사유가 있어야 단독 승인
    await expect(approveSaleBatch(batchId, { userId: adminB, superAdmin: false })).rejects.toThrow(/다른 관리자/);
    const payout = await approveSaleBatch(batchId, { userId: adminA, superAdmin: true });
    // 판매 250,000 - 환불 10,000 = 240,000. 수수료: 줄별 (90,000×30%)+(150,000×30%) = 27,000+45,000 = 72,000. 반송비 3,000(기관)
    expect(payout).toBe(240000n - 72000n - 3000n);
    await expect(approveSaleBatch(batchId, { userId: adminA, superAdmin: true })).rejects.toThrow(/이미 처리/);

    // 원장 append-only
    await expect(prisma.$executeRawUnsafe(`UPDATE bazaar_ledger SET amount = 0`)).rejects.toThrow();

    // 월 정산: 판매 + 검수 반송비(4,000) 포함
    const month = kstMonthKey();
    await generateSettlements(month);
    const s = await prisma.bazaarSettlement.findFirstOrThrow({ where: { merchantId, month } });
    expect(s.gross).toBe(250000n);
    expect(s.refund).toBe(10000n);
    expect(s.fee).toBe(72000n);
    expect(s.returnCost).toBe(3000n + 4000n);
    expect(s.payout).toBe(250000n - 10000n - 72000n - 7000n);
    await expect(markSettlementPaid(s.id, adminA, { transferRef: 'x', paidAt: new Date() })).rejects.toThrow(/확정된 정산/);
    await confirmSettlement(s.id, adminA);

    // 확정 뒤 들어온 판매는 다음 달로 넘어간다(확정 금액 불변)
    const batch2 = await createSaleBatch(adminB, { title: '2회차', source: 'MANUAL', rows: [{ trackingCode: 'GSB-000002', soldQty: 1, grossAmount: 15000n, refundQty: 0, refundAmount: 0n, returnCost: 0n, returnBearer: 'NONE' }] });
    await approveSaleBatch(batch2, { userId: adminA, superAdmin: true });
    const sale2 = await prisma.bazaarLedger.findFirstOrThrow({ where: { batchId: batch2, entryType: 'SALE' } });
    expect(sale2.month).not.toBe(month);

    await markSettlementPaid(s.id, adminA, { transferRef: '국민 이체 0001', paidAt: new Date() });
    const paid = await prisma.bazaarSettlement.findUniqueOrThrow({ where: { id: s.id } });
    expect(paid.status).toBe('PAID');
    const payoutRow = await prisma.bazaarLedger.findFirstOrThrow({ where: { settlementId: s.id, entryType: 'PAYOUT' } });
    expect(payoutRow.amount).toBe(-s.payout);

    // 대사
    const rec = await createReconcile(month, 240000n, adminA);
    expect(rec.diff).toBe(0n);

    // 판매 종료 → 기부 건 판매 종료
    await endProduct(products[0].id, adminA, 'MERCHANT_USE');
    await endProduct(products[1].id, adminA, 'MERCHANT_USE');
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('SALE_ENDED');

    // 홈택스 명세에 현물 영수증(사업자번호) 포함
    const ht = await buildHometaxExport(merchantId, receipt.taxYear, adminA);
    expect(ht.content).toContain(receipt.receiptNo);
    expect(ht.content).toContain('2208112345');
    expect(ht.content).toContain('현물');

    // 무효 → 재발급(번호 재사용 안 함)
    await voidInKindReceipt(receipt.id, adminA, '가액 정정');
    const again = await reissueInKindReceipt(donationId, adminA);
    expect(again.receiptNo).toMatch(/-H000002$/);
    const ht2 = await buildHometaxExport(merchantId, receipt.taxYear, adminA);
    expect(ht2.content).not.toContain(receipt.receiptNo);
    expect(ht2.content).toContain(again.receiptNo);
  });

  it('개인 기부자는 영수증 정보가 있어야 검수 확정(영수증 발급)이 된다', async () => {
    await decideParticipation(merchantId, 'APPROVED', adminA);
    const g = await registerGiver({
      donorType: 'INDIVIDUAL', email: `p-${newId()}@test.kr`, password: 'x', passwordHash: 'x',
      displayName: '김개인', contactName: '김개인', phone: '01055556666',
    });
    // 기관 지정 → 자동 매칭 제안
    const donationId = await createDonation(g.donorId, g.userId, {
      items: [{ name: '동화책', category: '도서·문구', quantity: 10, condition: 'LIKE_NEW', declaredUnitValue: 5000 }],
      matchMode: 'DESIGNATED', preferredMerchantId: merchantId, brandPublic: false, unsoldAction: 'TRANSFER', deliveryMethod: 'SEND',
    });
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('MATCH_PROPOSED');
    const m = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId } });
    await respondMatch(merchantId, m.id, true, merchantUserId);
    await acceptValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId });
    await pledgeDonation(g.donorId, donationId, g.userId, { name: '김개인', agree: true });
    const item = await prisma.inKindItem.findFirstOrThrow({ where: { donationId } });
    await registerInbound(donationId, adminA, { warehouse: '센터', receivedAt: new Date(), result: 'PASS', items: [{ itemId: item.id, receivedQty: 10, acceptedQty: 10 }], returnCost: 0n, returnCostBearer: 'NONE' });
    await expect(confirmInspection(merchantId, donationId, merchantUserId)).rejects.toThrow(/영수증 정보/);
    // 실패하면 전체가 되돌아가 다시 확정할 수 있다
    expect((await prisma.inKindInbound.findUniqueOrThrow({ where: { donationId } })).merchantConfirmedAt).toBeNull();
    await expect(updateDonorReceiptInfo(g.donorId, { legalName: '김개인', resident: '9001011234567', hometaxOptIn: true })).rejects.toThrow(/주민등록번호/);
    await updateDonorReceiptInfo(g.donorId, { legalName: '김개인', resident: '9001011234568', hometaxOptIn: true });
    const r = await confirmInspection(merchantId, donationId, merchantUserId);
    expect(r.totalAmount).toBe(50000n);
    expect(r.residentNoEnc).toBeTruthy();
    const ht = await buildHometaxExport(merchantId, r.taxYear, adminA);
    expect(ht.content).toContain('9001011234568');
  });

  it('기관 거절·기한 만료 시 접수 상태로 돌아가고 같은 기관에 다시 제안할 수 없다', async () => {
    await decideParticipation(merchantId, 'APPROVED', adminA);
    const g = await corporateGiver();
    const donationId = await createDonation(g.donorId, g.userId, { items: ITEMS, matchMode: 'ANY', brandPublic: false, unsoldAction: 'MERCHANT_USE', deliveryMethod: 'SEND' });
    await proposeMatch(donationId, merchantId, adminA);
    const m = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId } });
    await expect(respondMatch(merchantId, m.id, false, merchantUserId, '')).rejects.toThrow(/거절 사유/);
    await respondMatch(merchantId, m.id, false, merchantUserId, '보관 공간 부족');
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('SUBMITTED');
    await expect(proposeMatch(donationId, merchantId, adminA)).rejects.toThrow(/이미 이 기부 건을 거절/);

    // 기한 만료
    const g2 = await corporateGiver();
    const d2 = await createDonation(g2.donorId, g2.userId, { items: ITEMS, matchMode: 'ANY', brandPublic: false, unsoldAction: 'MERCHANT_USE', deliveryMethod: 'SEND' });
    await proposeMatch(d2, merchantId, adminA);
    await prisma.inKindMatch.updateMany({ where: { donationId: d2 }, data: { deadline: new Date(Date.now() - 1000) } });
    const m2 = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId: d2 } });
    await expect(respondMatch(merchantId, m2.id, true, merchantUserId)).rejects.toThrow(/기한/);
    expect(await expireMatches()).toBe(1);
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: d2 } })).status).toBe('SUBMITTED');
    const logs = await prisma.inKindStatusLog.count({ where: { donationId: d2 } });
    expect(logs).toBeGreaterThanOrEqual(3);
    await expect(prisma.$executeRawUnsafe(`DELETE FROM in_kind_status_log`)).rejects.toThrow();
  });

  it('검수 불합격: 반송비 기관 부담분은 원장에 남고 기부 건은 반송으로 끝난다', async () => {
    await decideParticipation(merchantId, 'APPROVED', adminA);
    const g = await corporateGiver();
    const donationId = await createDonation(g.donorId, g.userId, { items: ITEMS.slice(0, 1), matchMode: 'DESIGNATED', preferredMerchantId: merchantId, brandPublic: false, unsoldAction: 'MERCHANT_USE', deliveryMethod: 'SEND' });
    const m = await prisma.inKindMatch.findFirstOrThrow({ where: { donationId } });
    await respondMatch(merchantId, m.id, true, merchantUserId);
    await acceptValuation(donationId, { type: 'MERCHANT', userId: merchantUserId, merchantId });
    await pledgeDonation(g.donorId, donationId, g.userId, { name: '홍담당', agree: true });
    const item = await prisma.inKindItem.findFirstOrThrow({ where: { donationId } });
    await expect(
      registerInbound(donationId, adminA, { warehouse: '센터', receivedAt: new Date(), result: 'FAIL', items: [{ itemId: item.id, receivedQty: 100, acceptedQty: 0 }], returnCost: 5000n, returnCostBearer: 'NONE' }),
    ).rejects.toThrow(/부담 주체/);
    await registerInbound(donationId, adminA, { warehouse: '센터', receivedAt: new Date(), result: 'FAIL', items: [{ itemId: item.id, receivedQty: 100, acceptedQty: 0 }], returnCost: 5000n, returnCostBearer: 'MERCHANT', disposition: 'RETURNED' });
    expect((await prisma.inKindDonation.findUniqueOrThrow({ where: { id: donationId } })).status).toBe('RETURNED');
    const led = await prisma.bazaarLedger.findFirstOrThrow({ where: { merchantId, entryType: 'RETURN_COST' } });
    expect(led.amount).toBe(-5000n);
  });

  it('설정 변경: 부가세 별도 모드면 수수료에 부가세가 더해진다', async () => {
    await saveBazaarConfig({ ...DEFAULT_BAZAAR_CONFIG, feeVatMode: 'EXCLUDED' }, adminA);
    const { getBazaarConfig } = await import('@/server/services/bazaar-settings');
    const cfg = await getBazaarConfig();
    expect(cfg.feeVatMode).toBe('EXCLUDED');
    expect(settleLine({ grossAmount: 10000n, refundAmount: 0n, returnCost: 0n, returnBearer: 'NONE' }, cfg).payout).toBe(10000n - 3300n);
  });

  it('BazaarError 는 일반 Error 다(서버 액션이 메시지를 그대로 보여 준다)', () => {
    expect(new BazaarError('x')).toBeInstanceOf(Error);
  });
});
