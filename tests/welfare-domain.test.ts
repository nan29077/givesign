import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt } from '@/lib/crypto';
import { readMockOutbox, clearMockOutbox } from '@/server/adapters/mt';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';
import {
  campaignStats,
  listCampaigns,
  matchCampaignKeyword,
  merchantDonationSummary,
  recentDonors,
  saveCampaign,
  setCampaignStatus,
  CampaignCodeTakenError,
} from '@/server/services/fundraising';
import {
  createRecurringDonation,
  runRecurringDonations,
  setRecurringStatus,
  firstChargeDate,
  nextMonthDate,
  RECURRING_MAX_ATTEMPTS,
} from '@/server/services/recurring';
import {
  buildHometaxExport,
  eligibleCharges,
  issueReceipt,
  issueReceiptsBulk,
  receiptByToken,
  receiptCandidates,
  reissueReceipt,
  upsertReceiptProfile,
  voidReceiptForRefundedCharge,
  ReceiptError,
} from '@/server/services/receipts';
import { approveRefund, requestRefund } from '@/server/services/refund';
import { PAID_STATUSES } from '@/components/studio/shared';

/**
 * 기브싸인 사회복지기관 도메인 — 캠페인 · 정기후원 · 기부금영수증.
 *
 * 이 파일이 지키는 것
 *  1) 캠페인 모금액은 결제 성공 건에서만 집계되고, 문자 키워드로 지정후원이 잡힌다.
 *  2) 정기후원은 한 달에 한 번만 결제되고, 연속 실패하면 멈춘다.
 *  3) 기부금영수증은 결제 성공 건만 합산하고, 환불되면 무효화되며, 주민번호는 암호화된다.
 */

let fx: Fixture;

async function seedContextualTerms() {
  for (const t of ['RECEIPT_ISSUANCE', 'RECURRING_DEBIT'] as const) {
    await prisma.termsVersion.create({
      data: { id: newId(), type: t, version: '1.0', title: `${t} 동의`, content: '테스트', required: false, effectiveFrom: new Date('2026-01-01') },
    });
  }
}

async function makeIssuerReady(merchantId: string) {
  await prisma.merchantProfile.update({
    where: { id: merchantId },
    data: { businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION' },
  });
}

const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + 9 * 3600000 + n * 86_400_000).toISOString().slice(0, 10);

function campaignInput(over: Partial<Parameters<typeof saveCampaign>[1]> = {}) {
  return {
    code: '김장',
    title: '김장 나눔',
    summary: '어르신 300가구에 김장김치를 전합니다',
    story: '',
    beneficiary: '',
    usagePlan: '',
    imageUrl: '',
    goalAmount: 1_000_000,
    startsOn: plusDays(-1),
    endsOn: plusDays(30),
    featured: false,
    resultReport: '',
    ...over,
  };
}

beforeEach(async () => {
  await resetDb();
  clearMockOutbox();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await seedContextualTerms();
});

// ---------------------------------------------------------------------------
describe('캠페인', () => {
  it('[1] 같은 기관 안에서 문자 키워드는 겹칠 수 없고, 기호·대소문자 차이는 같은 키워드로 본다', async () => {
    await saveCampaign(fx.merchantId, campaignInput({ code: 'kim-jang' }));
    await expect(saveCampaign(fx.merchantId, campaignInput({ code: 'KIMJANG', title: '다른 제목' }))).rejects.toBeInstanceOf(CampaignCodeTakenError);
  });

  it('[2] 모금 중(ACTIVE·기간 안) 캠페인의 키워드가 문자 맨 앞에 오면 지정후원으로 잡히고 키워드는 메시지에서 빠진다', async () => {
    const c = await saveCampaign(fx.merchantId, campaignInput());
    // DRAFT 는 키워드를 받지 않는다.
    expect((await matchCampaignKeyword(fx.merchantId, '김장 응원합니다')).campaign).toBeNull();
    await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
    const hit = await matchCampaignKeyword(fx.merchantId, '김장 응원합니다');
    expect(hit.campaign?.id).toBe(c.id);
    expect(hit.rest).toBe('응원합니다');
    // 키워드만 보낸 문자도 잡힌다.
    expect((await matchCampaignKeyword(fx.merchantId, '김장')).campaign?.id).toBe(c.id);
    // 기간이 끝난 캠페인은 잡히지 않는다.
    await prisma.campaign.update({ where: { id: c.id }, data: { endsOn: new Date(`${plusDays(-2)}T00:00:00Z`) } });
    expect((await matchCampaignKeyword(fx.merchantId, '김장 응원')).campaign).toBeNull();
  });

  it('[3] MO 문자로 들어온 지정후원이 결제되면 캠페인 모금액·후원자 수에 집계되고, 미결제 건은 집계되지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const c = await saveCampaign(fx.merchantId, campaignInput());
    await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');

    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '김장 따뜻한 겨울 되세요' }), fx.merchantId);
    expect(PAID_STATUSES).toContain(paid.status);
    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: paid.chargeId! } });
    expect(charge.campaignId).toBe(c.id);
    expect(charge.message).toBe('따뜻한 겨울 되세요');

    // 두 번째 문자는 결제 전 단계(금액 선택 대기)로만 둔다.
    const { handleMoInbound } = await import('@/server/services/charge-flow');
    const { mockMoAdapter } = await import('@/server/adapters/mo');
    const pending = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '김장' })));
    expect(pending.status).toBe('PENDING_AMOUNT');

    const stats = (await campaignStats([c.id])).get(c.id)!;
    expect(stats.raised).toBe(charge.amount);
    expect(stats.chargeCount).toBe(1);
    expect(stats.donorCount).toBe(1);

    const listed = await listCampaigns(fx.merchantId);
    expect(listed[0].stats.raised).toBe(charge.amount);
    expect(listed[0].open).toBe(true);

    const summary = await merchantDonationSummary(fx.merchantId);
    expect(summary.totalRaised).toBe(charge.amount);
    expect(summary.totalDonors).toBe(1);

    const donors = await recentDonors(fx.merchantId);
    expect(donors).toHaveLength(1);
    expect(donors[0].campaignTitle).toBe('김장 나눔');
    // 공개용 이름은 마스킹된다.
    expect(donors[0].name).not.toBe('테스트후원자');
    expect(donors[0].name).toContain('*');
  });

  it('[4] 상태 전이표 밖의 전이는 거절한다 (ARCHIVED → ACTIVE 불가, DRAFT 로만 복원)', async () => {
    const c = await saveCampaign(fx.merchantId, campaignInput());
    await setCampaignStatus(fx.merchantId, c.id, 'ARCHIVED');
    await expect(setCampaignStatus(fx.merchantId, c.id, 'ACTIVE')).rejects.toThrow();
    await setCampaignStatus(fx.merchantId, c.id, 'DRAFT');
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('DRAFT');
  });
});

// ---------------------------------------------------------------------------
describe('정기후원', () => {
  it('[5] 다음 출금일 계산 — 출금일이 지났으면 다음 달, 2월 말 보정 없이 1~28일만 허용', () => {
    expect(firstChargeDate(15, new Date('2026-03-10T03:00:00+09:00'))).toBe('2026-03-15');
    expect(firstChargeDate(5, new Date('2026-03-10T03:00:00+09:00'))).toBe('2026-04-05');
    expect(firstChargeDate(10, new Date('2026-03-10T03:00:00+09:00'))).toBe('2026-04-10');
    expect(nextMonthDate(28, '2026-01-31')).toBe('2026-02-28');
    expect(nextMonthDate(1, '2026-12-05')).toBe('2027-01-01');
  });

  it('[6] 약정은 결제수단 등록·동의가 있어야 만들어지고, 같은 기관에 두 번 만들 수 없다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const bad = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 500n, dayOfMonth: 10 });
    expect(bad.ok).toBe(false);

    const ok = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10, message: '매달 응원' });
    expect(ok.ok).toBe(true);
    const consent = await prisma.consentRecord.findFirst({ where: { phoneHash: payer.phoneHash, type: 'RECURRING_DEBIT' } });
    expect(consent?.agreed).toBe(true);
    expect(readMockOutbox(5).some((m) => m.template === 'RECURRING_STARTED')).toBe(true);

    const dup = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 20000n, dayOfMonth: 5 });
    expect(dup.ok).toBe(false);
  });

  it('[7] 배치는 출금일이 지난 약정만 결제하고, 같은 달에 다시 돌아도 두 번 결제하지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
    if (!made.ok) throw new Error(made.message);
    // 출금일을 오늘로 당긴다.
    await prisma.recurringDonation.update({ where: { id: made.recurring.id }, data: { nextChargeOn: new Date(`${today()}T00:00:00Z`), cycleMonth: today().slice(0, 7) } });

    const first = await runRecurringDonations();
    expect(first.succeeded).toBe(1);
    const charge = await prisma.charge.findFirstOrThrow({ where: { recurringId: made.recurring.id } });
    expect(PAID_STATUSES).toContain(charge.status);
    expect(charge.channel).toBe('RECURRING');

    const after = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: made.recurring.id } });
    expect(after.successCount).toBe(1);
    expect(after.totalAmount).toBe(10000n);
    expect(after.nextChargeOn.toISOString().slice(0, 7)).not.toBe(today().slice(0, 7));

    // 누군가 날짜를 되돌려도(또는 배치가 겹쳐도) 이달 멱등키에 걸려 결제가 또 만들어지지 않는다.
    await prisma.recurringDonation.update({ where: { id: made.recurring.id }, data: { nextChargeOn: new Date(`${today()}T00:00:00Z`), cycleMonth: today().slice(0, 7) } });
    const second = await runRecurringDonations();
    expect(second.succeeded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await prisma.charge.count({ where: { recurringId: made.recurring.id } })).toBe(1);
  });

  it('[8] 출금이 연속 실패하면 재시도 후 정지되고 안내 문자가 나간다; 일시정지된 약정은 건너뛴다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    // mock 결제사는 금액 끝자리 999 를 거절한다.
    const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10999n, dayOfMonth: 10 });
    if (!made.ok) throw new Error(made.message);
    const id = made.recurring.id;
    const dueToday = async () => prisma.recurringDonation.update({ where: { id }, data: { nextChargeOn: new Date(`${today()}T00:00:00Z`), cycleMonth: today().slice(0, 7) } });

    for (let i = 1; i <= RECURRING_MAX_ATTEMPTS; i += 1) {
      await dueToday();
      const r = await runRecurringDonations();
      expect(r.failed).toBe(1);
      const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id } });
      if (i < RECURRING_MAX_ATTEMPTS) {
        expect(row.status).toBe('ACTIVE');
        expect(row.failCount).toBe(i);
        expect(readMockOutbox(3).some((m) => m.template === 'RECURRING_FAILED')).toBe(true);
      } else {
        expect(row.status).toBe('SUSPENDED');
        expect(readMockOutbox(3).some((m) => m.template === 'RECURRING_SUSPENDED')).toBe(true);
      }
    }
    expect(await prisma.recurringRun.count({ where: { recurringId: id, status: 'FAILED' } })).toBe(RECURRING_MAX_ATTEMPTS);

    // 재개하면 실패 카운터가 초기화되고 다음 출금일이 잡힌다.
    await setRecurringStatus(payer.id, id, 'RESUME');
    const resumed = await prisma.recurringDonation.findUniqueOrThrow({ where: { id } });
    expect(resumed.status).toBe('ACTIVE');
    expect(resumed.failCount).toBe(0);

    // 일시정지는 배치가 건드리지 않는다.
    await setRecurringStatus(payer.id, id, 'PAUSE');
    await dueToday();
    const paused = await runRecurringDonations();
    expect(paused.checked).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('기부금영수증', () => {
  it('[9] 후원자 영수증 정보는 암호화·해시·마스킹으로만 저장되고 체크섬이 틀린 주민번호는 거절한다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const bad = await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: '900101-1234567', hometaxOptIn: true });
    expect(bad.ok).toBe(false);
    // 체크섬이 맞는 테스트 번호
    const ok = await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    expect(ok.ok).toBe(true);
    const row = await prisma.payerReceiptProfile.findUniqueOrThrow({ where: { payerId: payer.id } });
    expect(row.residentNoEnc).not.toContain('9001011234568');
    expect(decrypt(row.residentNoEnc)).toBe('9001011234568');
    expect(row.residentNoMasked).toBe('900101-1******');
    expect(await prisma.consentRecord.count({ where: { phoneHash: payer.phoneHash, type: 'RECEIPT_ISSUANCE' } })).toBe(1);
  });

  it('[10] 영수증은 결제 성공 건만 합산해 연도·기관별 일련번호로 발급되고, 발급된 건은 다시 포함되지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await makeIssuerReady(fx.merchantId);
    const year = new Date().getFullYear();

    // 기관 정보가 준비됐어도 후원자 정보가 없으면 발급할 수 없다.
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '첫 후원' }), fx.merchantId);
    await expect(issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 'test' })).rejects.toBeInstanceOf(ReceiptError);

    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: '900101-1234568', address: '서울', hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '두 번째 후원' }), fx.merchantId);
    const eligible = await eligibleCharges(fx.merchantId, payer.id, year);
    expect(eligible).toHaveLength(2);
    const expected = eligible.reduce((s, c) => s + c.amount, 0n);

    const candidates = await receiptCandidates(fx.merchantId, year);
    expect(candidates[0].ready).toBe(true);
    expect(candidates[0].amount).toBe(expected);

    clearMockOutbox();
    const { receipt, viewToken } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 'test' });
    expect(receipt.seq).toBe(1);
    expect(receipt.receiptNo).toMatch(new RegExp(`-${year}-000001$`));
    expect(receipt.totalAmount).toBe(expected);
    expect(receipt.chargeCount).toBe(2);
    expect(readMockOutbox(3).some((m) => m.template === 'RECEIPT_ISSUED')).toBe(true);
    // 열람 토큰으로 조회된다. 스냅샷에는 마스킹 주민번호만 있다.
    const viewed = await receiptByToken(viewToken);
    expect(viewed?.id).toBe(receipt.id);
    expect(JSON.stringify(viewed?.donorSnapshot)).not.toContain('1234568');

    // 발급된 건은 더 이상 대상이 아니다.
    expect(await eligibleCharges(fx.merchantId, payer.id, year)).toHaveLength(0);
    await expect(issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 'test' })).rejects.toBeInstanceOf(ReceiptError);

    // 새 후원이 생기면 2번 영수증으로 따로 발급된다(번호 재사용 없음).
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '세 번째' }), fx.merchantId);
    const bulk = await issueReceiptsBulk(fx.merchantId, year, 'test');
    expect(bulk.issued).toBe(1);
    expect(bulk.details[0].receiptNo).toMatch(/-000002$/);
  });

  it('[11] 환불이 승인되면 그 건이 들어간 영수증은 무효화되고, 남은 건으로 재발급하면 새 번호가 나온다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await makeIssuerReady(fx.merchantId);
    await upsertReceiptProfile(payer.id, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    const year = new Date().getFullYear();
    const a = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: 'A' }), fx.merchantId);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: 'B' }), fx.merchantId);
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: payer.id, taxYear: year, issuedBy: 'test' });
    expect(receipt.chargeCount).toBe(2);

    const refund = await requestRefund({ chargeId: a.chargeId!, reason: '테스트 환불' });
    await approveRefund(refund.id);
    const voided = await prisma.donationReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(voided.status).toBe('VOID');
    // 환불 건도, 남은 건도 영수증에서 풀린다.
    expect(await prisma.charge.count({ where: { receiptId: receipt.id } })).toBe(0);
    // 이미 풀린 건으로 다시 불러도 아무 일도 하지 않는다(멱등).
    expect(await voidReceiptForRefundedCharge(a.chargeId!)).toBeNull();

    const re = await reissueReceipt(receipt.id, 'test');
    expect(re.receipt.seq).toBe(2);
    expect(re.receipt.chargeCount).toBe(1);
    const old = await prisma.donationReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(old.supersededById).toBe(re.receipt.id);
  });

  it('[12] 홈택스 명세 파일은 발급(ISSUED) 영수증만 담고, 간소화 제출을 끈 후원자는 제외하며, 수식 주입을 막는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const other = await seedRegisteredPayer('01099990001');
    await makeIssuerReady(fx.merchantId);
    const year = new Date().getFullYear();
    await upsertReceiptProfile(payer.id, { legalName: '=홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    await upsertReceiptProfile(other.id, { legalName: '김철수', residentNo: '850505-1012344', hometaxOptIn: false });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: 'A' }), fx.merchantId);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: '01099990001', text: 'B' }), fx.merchantId);
    const bulk = await issueReceiptsBulk(fx.merchantId, year, 'test');
    expect(bulk.issued).toBe(2);

    const out = await buildHometaxExport(fx.merchantId, year, 'test');
    expect(out.rows).toBe(1);
    expect(out.skipped).toHaveLength(1);
    expect(out.content).toContain('9001011234568');
    expect(out.content).not.toContain('8505051012344');
    expect(out.content).toContain("'=홍길동");
    expect(await prisma.receiptExport.count({ where: { merchantId: fx.merchantId } })).toBe(1);
  });
});
