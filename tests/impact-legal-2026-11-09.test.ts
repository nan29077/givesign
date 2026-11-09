import { beforeEach, describe, expect, it, vi } from 'vitest';

// 감사로그(writeAudit)는 요청 헤더를 읽는다. 테스트에서는 빈 요청으로 대체한다.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, phoneHash } from '@/lib/crypto';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { PAID_STATUSES } from '@/components/studio/shared';
import type { LlmAdapter } from '@/server/adapters/llm';
import { personalAllocationHit, solicitationHit, numbersOutside, allowedNumberSet, extractNumbers } from '@/lib/solicitation';
import { runPreflight } from '@/lib/document-preflight';
import { DOCUMENT_PRESETS } from '@/server/services/documents';
import { kindOfDocumentPurpose } from '@/server/services/outbound/classify';
import {
  ImpactError,
  addExpense,
  approveImpactUpdate,
  donorImpactEntries,
  generateImpactReport,
  impactDraftViolation,
  impactRecipients,
  publicImpactUpdates,
  reopenImpactUpdate,
  ruleReport,
  saveImpactReportText,
  saveImpactUpdate,
  setImpactPublic,
} from '@/server/services/impact-reports';
import {
  designationWarnings,
  incomeStatement,
  legalDocsInboxGroup,
  markLegalPrepared,
  saveLegalSetting,
  usageStatement,
} from '@/server/services/legal-reports';
import { buildLegalCsv, buildLegalPdf } from '@/server/services/legal-report-files';
import { infoSendPreview, requestAnnualNotice, requestImpactSend } from '@/server/services/impact-legal-approvals';
import { decideApproval, runQueuedApprovals } from '@/server/services/approvals';
import { readIssuedSnapshot } from '@/server/services/issued-documents';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { loadInboxGroups, resetInboxGroupProviders } from '@/server/services/inbox-groups';

/**
 * 2026-11-09 3차 과제 H — 후원금 사용 결과 보고 + 법정 서류.
 * 수입 합계 = 원천(환불 제외·계좌이체 포함·현물 포함), 공개판 이름 없음, 용도 외 사용 경고, 연 1회 통보 유일성,
 * AI 초안 숫자 검증 거절, 개인별 사용처 문구 없음, 정보성 권유 문구 경고(다른 용도는 그대로).
 */

let fx: Fixture;
const YEAR = new Date().getFullYear() - 1;
const at = (md: string) => new Date(`${YEAR}-${md}T03:00:00+09:00`);

async function truncateMine() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "impact_update", "fund_expense", "legal_notice_delivery", "legal_report_setting" CASCADE');
}

async function payer(phone: string, name: string | null = null) {
  return prisma.payerProfile.create({
    data: { id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), displayName: name, onboardingStatus: 'REGISTERED', registeredAt: new Date() },
  });
}

let seq = 0;
async function charge(payerId: string | null, amount: bigint, opts: { campaignId?: string | null; status?: (typeof PAID_STATUSES)[number] | 'REFUNDED'; paidAt?: Date; isTest?: boolean; name?: string; anonymous?: boolean } = {}) {
  seq += 1;
  return prisma.charge.create({
    data: {
      id: newId(), transactionNo: `TRD-H-${Date.now()}-${seq}`, merchantId: fx.merchantId, payerId, amount, displayName: opts.name ?? '홍길동', message: '',
      status: opts.status ?? 'SETTLED', paidAt: opts.paidAt ?? at('03-10'), campaignId: opts.campaignId ?? null, isTest: opts.isTest ?? false, anonymous: opts.anonymous ?? false, channel: 'WEB',
    },
  });
}

async function offline(payerId: string, amount: bigint, opts: { campaignId?: string | null; status?: 'CONFIRMED' | 'REVERTED'; donatedAt?: Date } = {}) {
  return prisma.offlineDonation.create({
    data: { id: newId(), merchantId: fx.merchantId, payerId, amount, donatedAt: opts.donatedAt ?? at('04-01'), campaignId: opts.campaignId ?? null, status: opts.status ?? 'CONFIRMED', createdBy: fx.merchantUserId, source: 'MANUAL' },
  });
}

async function campaign(title = '겨울나기 연탄') {
  return prisma.campaign.create({
    data: { id: newId(), merchantId: fx.merchantId, code: `C${(seq++).toString().padStart(3, '0')}`, title, summary: '요약', goalAmount: 1_000_000n, startsOn: new Date(`${YEAR}-01-01`), endsOn: new Date(`${YEAR}-12-31`), status: 'ACTIVE' },
  });
}

async function inKind(amount: bigint, opts: { status?: 'ISSUED' | 'VOID'; donorType?: 'CORPORATE' | 'INDIVIDUAL' } = {}) {
  const user = await prisma.user.create({ data: { id: newId(), email: `giver-${newId()}@test.kr`, name: '기부자', role: 'GIVER' } });
  const donor = await prisma.inKindDonor.create({
    data: { id: newId(), userId: user.id, donorType: opts.donorType ?? 'CORPORATE', displayName: '주식회사 나눔상사', contactName: '담당', phoneEnc: encrypt('01099990000'), phoneHash: phoneHash('01099990000'), phoneMasked: '010-****-0000' },
  });
  const donation = await prisma.inKindDonation.create({
    data: { id: newId(), donationNo: `IKD-${newId().slice(-8)}`, donorId: donor.id, merchantId: fx.merchantId, status: 'RECEIPTED', title: '생필품', matchMode: 'DIRECT', unsoldAction: 'DONATE', deliveryMethod: 'PARCEL', declaredTotal: amount },
  });
  seq += 1;
  return prisma.inKindReceipt.create({
    data: {
      id: newId(), merchantId: fx.merchantId, donationId: donation.id, donorId: donor.id, taxYear: YEAR, seq, receiptNo: `${fx.merchantId.slice(-4)}-${YEAR}-H${String(seq).padStart(6, '0')}`,
      totalAmount: amount, donationCode: '40', donorType: opts.donorType ?? 'CORPORATE', donorSnapshot: { name: '주식회사 나눔상사' }, issuerSnapshot: {}, items: [], donatedAt: at('05-01'),
      status: opts.status ?? 'ISSUED', issuedBy: 'test',
    },
  });
}

function fakeAdapter(reports: string[]): LlmAdapter & { calls: number } {
  const a = {
    calls: 0,
    info: () => ({ provider: 'fake', mode: 'live' as const, missingCredentials: [], model: 'fake' }),
    async complete() {
      const text = reports[Math.min(a.calls, reports.length - 1)]!;
      a.calls += 1;
      return { text: JSON.stringify({ report: text }), usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return a;
}

beforeEach(async () => {
  await resetDb();
  await truncateMine();
  resetInboxGroupProviders();
  registerDefaultConsumers();
  fx = await seedBasics();
});

// ---------------------------------------------------------------------------

describe('[H2-1] 수입 명세 = 원천', () => {
  it('결제(PAID, 환불·테스트 제외) + 계좌이체 확정분(영수증 설정 꺼짐이어도) + 현물(ISSUED) 합계', async () => {
    const p = await payer('01011110001', '김후원');
    const c = await campaign();
    await charge(p.id, 30_000n, { campaignId: c.id });
    await charge(p.id, 20_000n);
    await charge(p.id, 99_000n, { status: 'REFUNDED' });
    await charge(p.id, 77_000n, { isTest: true });
    await charge(p.id, 55_000n, { paidAt: new Date(`${YEAR + 1}-01-01T00:30:00+09:00`) }); // 다음 해(KST)
    await offline(p.id, 10_000n, { campaignId: c.id });
    await offline(p.id, 40_000n, { status: 'REVERTED' });
    await inKind(100_000n);
    await inKind(500_000n, { status: 'VOID' });
    const m = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId }, select: { receiptIncludeOffline: true } });
    expect(m.receiptIncludeOffline).toBe(false);

    const s = await incomeStatement(fx.merchantId, YEAR);
    expect(s.total).toBe(160_000n);
    expect(s.bySource.CHARGE).toEqual({ count: 2, amount: 50_000n });
    expect(s.bySource.OFFLINE).toEqual({ count: 1, amount: 10_000n });
    expect(s.bySource.IN_KIND).toEqual({ count: 1, amount: 100_000n });
    expect(s.designated).toBe(40_000n);
    expect(s.undesignated).toBe(120_000n);
    expect(s.rows.find((r) => r.source === 'IN_KIND')?.donorKind).toBe('법인');
    // 원천 직접 합계와 같다
    const direct = await prisma.charge.aggregate({ where: { merchantId: fx.merchantId, isTest: false, status: { in: PAID_STATUSES }, paidAt: { gte: new Date(`${YEAR}-01-01T00:00:00+09:00`), lt: new Date(`${YEAR + 1}-01-01T00:00:00+09:00`) } }, _sum: { amount: true } });
    expect(s.bySource.CHARGE.amount).toBe(direct._sum.amount);
  });

  it('바자회 스위치가 꺼져 있어도 발급된 현물 영수증은 포함한다', async () => {
    await inKind(70_000n, { donorType: 'INDIVIDUAL' });
    const s = await incomeStatement(fx.merchantId, YEAR);
    expect(s.bySource.IN_KIND.amount).toBe(70_000n);
    expect(s.rows[0]!.donorKind).toBe('개인');
  });
});

describe('[H2-2] 공개판에 후원자 이름 없음', () => {
  it('공개용·보고서 CSV/PDF 에는 이름이 없고, 내부용에는 마스킹 이름만', async () => {
    const p = await payer('01011110002', '박정희망');
    await charge(p.id, 30_000n, { name: '박정희망' });
    await offline(p.id, 10_000n);
    await inKind(50_000n);
    for (const kind of ['report-csv', 'public-csv'] as const) {
      const out = await buildLegalCsv(fx.merchantId, YEAR, kind);
      expect(out.content).not.toContain('박정희망');
      expect(out.content).not.toContain('박*');
      expect(out.content).not.toContain('나눔상사');
      expect(out.content).toContain('법령 서식과 대조 필요');
      expect(out.content.startsWith('﻿')).toBe(true);
    }
    const internal = await buildLegalCsv(fx.merchantId, YEAR, 'income-internal-csv');
    expect(internal.content).not.toContain('박정희망');
    expect(internal.content).toContain('박**망');
    const pdf = await buildLegalPdf(fx.merchantId, YEAR, 'public-pdf');
    expect(Buffer.from(pdf.bytes).subarray(0, 4).toString()).toBe('%PDF');
    expect(Buffer.from(pdf.bytes).toString('latin1')).not.toContain('박정희망');
    const ledger = await buildLegalCsv(fx.merchantId, YEAR, 'receipt-ledger-csv');
    expect(ledger.content).not.toContain('01099990000');
  });

  it('공개 statement 행에는 maskedName 필드 자체가 없다', async () => {
    const p = await payer('01011110003', '이름있음');
    await charge(p.id, 5_000n, { name: '이름있음' });
    const s = await incomeStatement(fx.merchantId, YEAR, 'public');
    expect(s.rows.every((r) => r.maskedName === undefined)).toBe(true);
  });
});

describe('[H2-3] 지정 용도 외 사용 경고', () => {
  it('캠페인 사용 > 지정 수입, 비지정 사용 > 비지정 수입, 진행 기록과 다른 용도', async () => {
    const p = await payer('01011110004');
    const a = await campaign('A 캠페인');
    const b = await campaign('B 캠페인');
    await charge(p.id, 10_000n, { campaignId: a.id });
    await offline(p.id, 5_000n, { campaignId: a.id });
    await charge(p.id, 100_000n, { campaignId: b.id });
    await addExpense(fx.merchantId, fx.merchantUserId, { campaignId: a.id, usedOn: `${YEAR}-06-01`, description: '물품 구입', amount: 20_000n });
    await addExpense(fx.merchantId, fx.merchantUserId, { campaignId: null, usedOn: `${YEAR}-06-02`, description: '운영비', amount: 3_000n });
    let w = await designationWarnings(fx.merchantId, YEAR);
    expect(w.map((x) => x.kind).sort()).toEqual(['GENERAL_OVERSPENT', 'OVERSPENT']);
    expect(w.find((x) => x.kind === 'OVERSPENT')!.income).toBe(15_000n);

    // 진행 기록(B 캠페인)에 붙은 집행의 용도가 다르면 MISMATCH
    const id = await saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: b.id, title: 'B 진행', body: '진행했습니다.', photos: [], photoRuleAck: false });
    const eid = await addExpense(fx.merchantId, fx.merchantUserId, { impactUpdateId: id, usedOn: `${YEAR}-07-01`, description: '배송', amount: 1_000n });
    await prisma.fundExpense.update({ where: { id: eid }, data: { campaignId: a.id } });
    w = await designationWarnings(fx.merchantId, YEAR);
    expect(w.some((x) => x.kind === 'MISMATCH')).toBe(true);
  });

  it('용도에 맞게 쓰면 경고가 없다', async () => {
    const p = await payer('01011110005');
    const a = await campaign();
    await charge(p.id, 50_000n, { campaignId: a.id });
    await addExpense(fx.merchantId, fx.merchantUserId, { campaignId: a.id, usedOn: `${YEAR}-06-01`, description: '연탄', amount: 50_000n });
    expect(await designationWarnings(fx.merchantId, YEAR)).toEqual([]);
    const u = await usageStatement(fx.merchantId, YEAR);
    expect(u.total).toBe(50_000n);
    expect(u.designated).toBe(50_000n);
  });
});

describe('[H2-4] 연 1회 통보 유일성', () => {
  it('승인 → 배치 발송 → 후원자당 한 번, 다시 요청하면 거절', async () => {
    const p1 = await payer('01011110006', '하나');
    const p2 = await payer('01011110007', '둘');
    const p3 = await payer('01011110008', '셋');
    await charge(p1.id, 30_000n);
    await charge(p1.id, 20_000n);
    await offline(p2.id, 15_000n);
    await charge(p3.id, 10_000n);
    await prisma.payerMerchantLink.create({ data: { id: newId(), payerId: p3.id, merchantId: fx.merchantId, noticeOptOutAt: new Date() } });

    const r = await requestAnnualNotice(fx.merchantId, YEAR);
    expect(r.targetCount).toBe(2);
    const preview = await infoSendPreview(fx.merchantId, r.approvalId);
    expect(preview!.targetCount).toBe(2);
    expect(preview!.samples.length).toBeGreaterThan(0);
    expect(preview!.excluded.find((e) => e.reason === 'OPTED_OUT')?.count).toBe(1);
    expect(preview!.cost.edocAmount).toBe(0n);

    const d = await decideApproval({ merchantId: fx.merchantId, id: r.approvalId, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(d.ok).toBe(true);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.approvalId } })).status).toBe('QUEUED');
    await runQueuedApprovals();
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: r.approvalId } })).status).toBe('APPROVED');

    const docs = await prisma.issuedDocument.findMany({ where: { merchantId: fx.merchantId, purpose: 'ANNUAL_DONATION_NOTICE' } });
    expect(docs.map((x) => x.payerId).sort()).toEqual([p1.id, p2.id].sort());
    const snap = readIssuedSnapshot(docs.find((x) => x.payerId === p1.id)!).snapshot!;
    expect(snap.body).toContain(`${YEAR}년 보내 주신 후원 2회 · 합계 50,000원`);
    expect(snap.body).toContain('후원금 수입 75,000원'); // 수신 거부자 수입도 기관 수입에는 들어간다
    expect(solicitationHit(snap.body)).toBeNull();
    const deliveries = await prisma.legalNoticeDelivery.findMany({ where: { merchantId: fx.merchantId, taxYear: YEAR } });
    expect(deliveries.every((x) => x.status === 'SENT')).toBe(true);
    expect(deliveries).toHaveLength(2);

    await expect(requestAnnualNotice(fx.merchantId, YEAR)).rejects.toThrow(/이미 보냈습니다/);
    await expect(
      prisma.legalNoticeDelivery.create({ data: { id: newId(), merchantId: fx.merchantId, taxYear: YEAR, payerId: p1.id } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('진행 중인 해와 미래 연도는 거절, 대기 중 요청이 있으면 새로 쌓지 않음', async () => {
    const p = await payer('01011110009');
    await charge(p.id, 10_000n);
    await expect(requestAnnualNotice(fx.merchantId, YEAR + 1)).rejects.toThrow(/끝난 해/);
    await requestAnnualNotice(fx.merchantId, YEAR);
    await expect(requestAnnualNotice(fx.merchantId, YEAR)).rejects.toThrow(/승인 대기함/);
  });

  it('같은 요청을 두 배치가 동시에 돌려도 후원자당 문서는 1건', async () => {
    const p = await payer('01011110010');
    await charge(p.id, 10_000n);
    const r = await requestAnnualNotice(fx.merchantId, YEAR);
    await decideApproval({ merchantId: fx.merchantId, id: r.approvalId, decision: 'APPROVE', userId: fx.merchantUserId });
    await Promise.all([runQueuedApprovals(), runQueuedApprovals()]);
    expect(await prisma.issuedDocument.count({ where: { purpose: 'ANNUAL_DONATION_NOTICE', payerId: p.id } })).toBe(1);
  });
});

describe('[H1] 숫자 검증으로 AI 초안 거절 · 개인별 사용처 문구 없음', () => {
  async function draftUpdate() {
    const p = await payer('01011110011');
    const c = await campaign('연탄 나눔');
    await charge(p.id, 30_000n, { campaignId: c.id });
    await offline(p.id, 20_000n, { campaignId: c.id });
    const id = await saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: c.id, title: '연탄 1차 전달', body: '어르신 가구에 연탄을 전달했습니다.', photos: [], photoRuleAck: false });
    await addExpense(fx.merchantId, fx.merchantUserId, { impactUpdateId: id, usedOn: `${YEAR}-12-01`, description: '연탄 구입', amount: 45_000n });
    return { id, campaignId: c.id, payerId: p.id };
  }

  it('입력에 없는 숫자를 쓴 AI 초안은 두 번 거절 → 규칙 문안', async () => {
    const { id } = await draftUpdate();
    const a = fakeAdapter(['연탄 1,234장을 전달했습니다. 모인 후원금 50,000원으로 진행했습니다.']);
    const r = await generateImpactReport(fx.merchantId, id, { adapter: a });
    expect(a.calls).toBe(2);
    expect(r.source).toBe('RULE');
    expect(r.reason).toMatch(/입력 자료에 없는 숫자/);
    const row = await prisma.impactUpdate.findUniqueOrThrow({ where: { id } });
    expect(row.reportSource).toBe('RULE');
    expect(row.report).not.toContain('1,234');
    expect(row.report).toContain('집행 합계 45,000원');
  });

  it('개인별 사용처 문구·권유 문구 AI 초안도 거절, 규칙을 지킨 초안은 받는다', async () => {
    const { id } = await draftUpdate();
    const bad = fakeAdapter(['회원님이 보내 주신 30,000원이 연탄 구입에 쓰였습니다.', '연탄을 잘 전달했습니다. 더 후원해 주세요.']);
    expect((await generateImpactReport(fx.merchantId, id, { adapter: bad })).source).toBe('RULE');
    const good = fakeAdapter(['모인 후원금 50,000원 가운데 45,000원으로 연탄을 구입해 어르신 가구에 전달했습니다.']);
    const r = await generateImpactReport(fx.merchantId, id, { adapter: good });
    expect(r.source).toBe('AI');
    expect(r.report).toContain('45,000원으로 연탄');
  });

  it('mock 공급자면 AI 를 부르지 않고 규칙 문안', async () => {
    const { id } = await draftUpdate();
    const r = await generateImpactReport(fx.merchantId, id);
    expect(r.source).toBe('RULE');
    expect(personalAllocationHit(r.report)).toBeNull();
    expect(solicitationHit(r.report)).toBeNull();
  });

  it('순수 판정: 개인별 사용처·권유·숫자', () => {
    expect(personalAllocationHit('당신의 3만 원이 연탄에 쓰였습니다')).not.toBeNull();
    expect(personalAllocationHit('보내 주신 30,000원이 급식비로 사용되었습니다')).not.toBeNull();
    expect(personalAllocationHit('모인 후원금 1,200,000원으로 연탄을 전달했습니다')).toBeNull();
    expect(personalAllocationHit('함께해 주셔서 고맙습니다')).toBeNull();
    expect(solicitationHit('정기후원으로 전환해 주세요')).not.toBeNull();
    expect(solicitationHit('https://givesign.kr/donate/GIV-1')).not.toBeNull();
    expect(solicitationHit('함께해 주셔서 감사합니다')).toBeNull();
    expect(extractNumbers('2026-03-05 1,200,000원 3회')).toEqual(['2026', '3', '5', '1200000', '3']);
    const allowed = allowedNumberSet([45_000n, '2026-12-01']);
    expect(numbersOutside('2026년 12월 1일 45,000원', allowed)).toEqual([]);
    expect(numbersOutside('46,000원', allowed)).toEqual(['46000']);
    expect(impactDraftViolation('보내 주신 45,000원이 쓰였습니다', allowed)).toMatch(/개인별 사용처/);
  });

  it('기본 서식·규칙 문안에 개인별 사용처·권유 문구가 없다', () => {
    for (const key of ['IMPACT_REPORT', 'ANNUAL_DONATION_NOTICE']) {
      const p = DOCUMENT_PRESETS.find((x) => x.key === key)!;
      expect(p.purpose).toBe(key);
      expect(p.requireSignature).toBe(false);
      expect(personalAllocationHit(p.body)).toBeNull();
      expect(solicitationHit(p.body)).toBeNull();
    }
    const text = ruleReport({ title: 't', body: '진행했습니다.', scopeLabel: '「A」', facts: { chargeTotal: 1n, chargeCount: 1, offlineTotal: 0n, offlineCount: 0, expenseTotal: 1n, expenseCount: 1, expenses: [{ usedOn: '2026-01-01', description: 'x', amount: 1n }] } });
    expect(personalAllocationHit(text)).toBeNull();
  });

  it('담당자 수정 보고서에 권유 문구·개인별 사용처를 넣으면 거절', async () => {
    const { id } = await draftUpdate();
    await expect(saveImpactReportText(fx.merchantId, id, '잘 마쳤습니다. 더 후원해 주세요.')).rejects.toThrow(ImpactError);
    await expect(saveImpactReportText(fx.merchantId, id, '후원자님의 3만 원이 연탄으로 전달되었습니다.')).rejects.toThrow(/개인별 사용처/);
    await saveImpactReportText(fx.merchantId, id, '연탄을 잘 전달했습니다.');
    expect((await prisma.impactUpdate.findUniqueOrThrow({ where: { id } })).reportSource).toBe('EDITED');
  });
});

describe('[H1] 승인 → 승인 대기함 확인 → 배치 발송 · 후원자 화면 · 공개', () => {
  it('참여 후원자(결제·약정·계좌이체, 탈퇴·수신 거부 제외)에게 한 번씩, 본인 참여 합계는 따로', async () => {
    const c = await campaign('따뜻한 겨울');
    const a = await payer('01022220001', '가나');
    const b = await payer('01022220002', '다라');
    const pledge = await payer('01022220003', '마바');
    const gone = await payer('01022220004', '탈퇴');
    const opt = await payer('01022220005', '거부');
    await charge(a.id, 30_000n, { campaignId: c.id });
    await charge(a.id, 30_000n, { campaignId: c.id });
    await charge(a.id, 30_000n, { campaignId: c.id, status: 'REFUNDED' });
    await offline(b.id, 20_000n, { campaignId: c.id });
    await prisma.recurringDonation.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: pledge.id, amount: 10_000n, dayOfMonth: 10, campaignId: c.id, status: 'ACTIVE', nextChargeOn: new Date(), cycleMonth: '2026-01' } });
    await charge(gone.id, 10_000n, { campaignId: c.id });
    await prisma.payerProfile.update({ where: { id: gone.id }, data: { onboardingStatus: 'WITHDRAWN' } });
    await charge(opt.id, 10_000n, { campaignId: c.id });
    await prisma.payerMerchantLink.create({ data: { id: newId(), payerId: opt.id, merchantId: fx.merchantId, noticeOptOutAt: new Date() } });

    const id = await saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: c.id, title: '겨울 이불 전달', body: '이불을 전달했습니다.', photos: [], photoRuleAck: false });
    await addExpense(fx.merchantId, fx.merchantUserId, { impactUpdateId: id, usedOn: `${YEAR}-11-20`, description: '이불', amount: 50_000n });
    await expect(approveImpactUpdate(fx.merchantId, id, fx.merchantUserId)).rejects.toThrow(/보고서를 먼저/);
    await expect(requestImpactSend(fx.merchantId, id)).rejects.toThrow(/승인한 기록만/);
    await generateImpactReport(fx.merchantId, id);
    await approveImpactUpdate(fx.merchantId, id, fx.merchantUserId);

    const rec = await impactRecipients((await prisma.impactUpdate.findUniqueOrThrow({ where: { id } })));
    expect(rec.recipients.map((r) => r.payerId).sort()).toEqual([a.id, b.id, pledge.id].sort());
    expect(rec.excluded).toEqual({ WITHDRAWN: 1, BLOCKED: 0, OPTED_OUT: 1 });

    const req = await requestImpactSend(fx.merchantId, id);
    await expect(reopenImpactUpdate(fx.merchantId, id)).rejects.toThrow(/발송 승인 대기/);
    const preview = await infoSendPreview(fx.merchantId, req.approvalId);
    expect(preview!.targetCount).toBe(3);
    expect(preview!.samples.length).toBeGreaterThan(0);
    expect(preview!.samples.every((s) => !s.issues.some((m) => m.includes('권유')))).toBe(true);

    await decideApproval({ merchantId: fx.merchantId, id: req.approvalId, decision: 'APPROVE', userId: fx.merchantUserId });
    await runQueuedApprovals();
    expect((await prisma.impactUpdate.findUniqueOrThrow({ where: { id } })).status).toBe('SENT');

    const docs = await prisma.issuedDocument.findMany({ where: { purpose: 'IMPACT_REPORT', subjectId: id } });
    expect(docs).toHaveLength(3);
    const bodyA = readIssuedSnapshot(docs.find((x) => x.payerId === a.id)!).snapshot!.body;
    expect(bodyA).toContain('이 사업에 함께하신 후원 2회 · 합계 60,000원');
    expect(bodyA).toContain('집행 합계 50,000원');
    expect(personalAllocationHit(bodyA)).toBeNull();
    expect(solicitationHit(bodyA)).toBeNull();
    const bodyP = readIssuedSnapshot(docs.find((x) => x.payerId === pledge.id)!).snapshot!.body;
    expect(bodyP).toContain('정기후원 약정으로 함께하고 계십니다');
    // 안내는 통합 발송 대기열(관계·정보형)
    const q = await prisma.outboundQueue.findMany({ where: { merchantId: fx.merchantId, kind: 'IMPACT_REPORT' } });
    expect(q).toHaveLength(3);
    expect(q.every((x) => x.precounted === false)).toBe(true);

    // 다시 보내기: 새로 참여한 분이 없으면 거절
    await expect(requestImpactSend(fx.merchantId, id)).rejects.toThrow(/새로 참여한 후원자가 없습니다/);

    // 후원자 화면
    const entries = await donorImpactEntries(a.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.participation).toContain('2회');
    expect(await donorImpactEntries(a.id, { merchantId: 'other' })).toEqual([]);

    // 공개: 기본 안 보임 → 공개로 바꾸면 보임
    expect(await publicImpactUpdates(fx.merchantId, c.id)).toEqual([]);
    await setImpactPublic(fx.merchantId, id, true);
    expect(await publicImpactUpdates(fx.merchantId, c.id)).toHaveLength(1);

  });

  it('사진은 자체 저장소 주소 + 수혜자 실사진 금지 확인이 있어야 저장', async () => {
    await expect(saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: null, title: '일반', body: '진행', photos: ['https://example.com/a.jpg'], photoRuleAck: true })).rejects.toThrow(/직접 올린 파일/);
    await expect(saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: null, title: '일반', body: '진행', photos: ['/api/media/0123456789abcdef0123456789abcdef.jpg'], photoRuleAck: false })).rejects.toThrow(/확인에 체크/);
    const id = await saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: null, title: '일반', body: '진행', photos: ['/api/media/0123456789abcdef0123456789abcdef.jpg'], photoRuleAck: true });
    const row = await prisma.impactUpdate.findUniqueOrThrow({ where: { id } });
    expect(row.photoRuleAckAt).not.toBeNull();
    expect(row.periodFrom).not.toBeNull();
  });

  it('승인된 기록의 집행 내역은 바꿀 수 없다(보고서 숫자 근거)', async () => {
    const c = await campaign();
    const id = await saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: c.id, title: '진행', body: '진행', photos: [], photoRuleAck: false });
    await saveImpactReportText(fx.merchantId, id, '진행했습니다.');
    await approveImpactUpdate(fx.merchantId, id, fx.merchantUserId);
    await expect(addExpense(fx.merchantId, fx.merchantUserId, { impactUpdateId: id, usedOn: `${YEAR}-01-01`, description: 'x', amount: 1n })).rejects.toThrow(/승인된 기록/);
    await expect(approveImpactUpdate(fx.merchantId, id, fx.merchantUserId)).rejects.toThrow(/이미 승인/);
  });
});

describe('[H2-5] 결산 시기 알림 · 회귀', () => {
  it('결산 시기에만 "법정 서류 준비" 묶음, 보고서를 준비하면 닫힘', async () => {
    const feb = new Date(`${YEAR + 1}-02-15T03:00:00+09:00`);
    const g = await legalDocsInboxGroup(fx.merchantId, feb);
    expect(g?.kind).toBe('LEGAL_DOCS_PREP');
    expect(g?.title).toContain(`${YEAR}년`);
    expect(g?.reason).toContain('법령 서식과 대조 필요');
    expect(await legalDocsInboxGroup(fx.merchantId, new Date(`${YEAR + 1}-06-15T03:00:00+09:00`))).toBeNull();
    await markLegalPrepared(fx.merchantId, YEAR);
    expect(await legalDocsInboxGroup(fx.merchantId, feb)).toBeNull();
    await saveLegalSetting(fx.merchantId, fx.merchantUserId, 5, 6);
    expect(await legalDocsInboxGroup(fx.merchantId, new Date(`${YEAR + 2}-05-10T03:00:00+09:00`))).not.toBeNull();
    await expect(saveLegalSetting(fx.merchantId, fx.merchantUserId, 0, 13)).rejects.toThrow();
    // 승인 대기함 제공자 등록
    const loaded = await loadInboxGroups(fx.merchantId, new Date(`${YEAR + 2}-05-10T03:00:00+09:00`));
    expect(loaded.some((l) => l.group?.kind === 'LEGAL_DOCS_PREP')).toBe(true);
  });

  it('정보성 권유 문구 점검은 새 용도에만 경고하고 기존 용도 결과는 그대로', () => {
    const body = '{{후원자명}} 님께 결과를 알려 드립니다. 더 후원해 주세요. {{보고내용}}';
    const values = { 후원자명: '김', 기관명: '기관', 보고내용: '연탄 전달' };
    const info = runPreflight({ template: { purpose: 'IMPACT_REPORT', body }, values });
    expect(info.issues.some((i) => i.code === 'SOLICITATION_TEXT' && i.severity === 'warn')).toBe(true);
    const thanks = runPreflight({ template: { purpose: 'THANKS_LETTER', body }, values });
    expect(thanks.issues.some((i) => i.code === 'SOLICITATION_TEXT')).toBe(false);
    const empty = runPreflight({ template: { purpose: 'IMPACT_REPORT', body: '{{후원자명}} {{보고내용}}' }, values: { 후원자명: '김', 보고내용: '' } });
    expect(empty.level).toBe('block');
  });

  it('발송 분류: 새 용도는 관계·정보형, 서명 용도는 그대로 거래·요청형', () => {
    expect(kindOfDocumentPurpose('IMPACT_REPORT')).toBe('IMPACT_REPORT');
    expect(kindOfDocumentPurpose('ANNUAL_DONATION_NOTICE')).toBe('ANNUAL_NOTICE');
    expect(kindOfDocumentPurpose('SUPPORT_AGREEMENT')).toBeNull();
  });
});
