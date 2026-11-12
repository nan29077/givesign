import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'user-agent': 'vitest' }),
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { name: k, value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, phoneHash } from '@/lib/crypto';
import { kstStartOfDay } from '@/lib/datetime';
import { mockMoAdapter } from '@/server/adapters/mo';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import { PAID_STATUSES } from '@/components/studio/shared';
import { handleMoInbound } from '@/server/services/charge-flow';
import { completePinAuthorization } from '@/server/services/pin-authorization';
import { recordFunnelLinkOpened } from '@/server/services/funnel';
import { campaignStats } from '@/server/services/fundraising';
import { createCampaignFromPlan, type CampaignPlanInput } from '@/server/services/campaign-setup';
import { createPromo } from '@/server/services/promo-codes';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { advanceDueJourneyRuns } from '@/server/services/journeys';
import { flushDueOutbound } from '@/server/services/outbound/coordinator';
import { createRecurringDonation, runRecurringDonations } from '@/server/services/recurring';
import { recurringRecoveryInboxGroup, startRecoveryRegistration, changeFromRecovery } from '@/server/services/recurring-recovery';
import { completeRegistration, startRegistration } from '@/server/services/payer-registration';
import { loadInboxGroups, resetInboxGroupProviders } from '@/server/services/inbox-groups';
import { confirmDeposits, depositsInboxGroup, importBankStatement, offlineReceiptCorrections, revertOfflineDonation, saveOfflinePledge, setReceiptIncludeOffline } from '@/server/services/deposits';
import { donorDonationHistory } from '@/server/services/donor-history';
import { issueReceipt, receiptCandidates, upsertReceiptProfile } from '@/server/services/receipts';
import { incomeStatement } from '@/server/services/legal-reports';
import { approveRefund, requestRefund } from '@/server/services/refund';
import { saveJourneySetting } from '@/server/services/journeys/engine';
import { decideApproval, runQueuedApprovals } from '@/server/services/approvals';
import { funnelReport } from '@/server/services/funnel-report';
import { setMarketingConsent } from '@/server/services/marketing-consent';
import {
  proposeWeeklyBatch, relationshipCandidates, runRelationshipCron, saveRelationshipSetting, sendApprovedRelationshipMessages, setRelationshipGloballyEnabled,
} from '@/server/services/relationship-messages';
import { approveImpactUpdate, generateImpactReport, impactRecipients, saveImpactUpdate } from '@/server/services/impact-reports';
import { smsReplyLinkScope } from '@/server/services/mo-command-scope';
import { bindReplyLinkCookie } from '@/server/services/mo-link-cookie';
import { confirmStepUp, requestStepUp } from '@/server/services/self-service-stepup';
import { recurringApplyAction } from '@/app/actions/self-service';
import { contractIntegrations } from '@/lib/env';
import { loadSelectAmountContext } from '@/server/services/charge-select';
import { calculateFees } from '@/server/services/settlement';
import { syncBankFeeds } from '@/server/services/bank-feed';
import { cardOptionAvailable } from '@/server/services/card-payment';
import { quickRepeatFor } from '@/server/services/quick-repeat';
import { approveContent, connectSocialChannel, processContentQueue, saveContentSetting } from '@/server/services/content';
import { fillNextSlot } from '@/server/services/content-calendar';
import { generatePlannedSlots } from '@/server/services/campaign-setup';
import { generateWeeklyPlan, weeklyApprovalKey, type StoredSuggestion } from '@/server/services/weekly-plan';
import { campaignSchema } from '@/lib/fundraising';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lastSelectAmountToken, moPayload, resetDb, seedBasics, seedRegisteredPayer, selectChargeAmount, setChargeAmount, type Fixture } from './helpers';

/**
 * 2026-11-09 최종 시뮬레이션 — 1~5차 고도화가 이어지는 업무 시나리오.
 *
 * 각 시나리오는 실제 서비스 함수·배치 함수(cron 이 부르는 함수)를 차례로 불러 하루·한 달을 흉내 내고,
 * 매 단계에서 원천 테이블(charge·payment_transaction·settlement_ledger·domain_event·funnel_step·outbound_queue·
 * mt_outbound_message·journey_run …) 숫자로 불변식을 검증한다. 외부 연동은 모두 mock(tests/setup.ts).
 */

const DAY = 86_400_000;
const MIN = 60_000;
const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0';
const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
const kstKey = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 10);
const plusDays = (n: number) => kstKey(Date.now() + n * DAY);
/** 오늘 KST 12시(낮) — 야간 보류에 걸리지 않는 기준 시각 */
const noon = (offsetDays = 0) => new Date(kstStartOfDay(new Date()).getTime() + 12 * 3_600_000 + offsetDays * DAY);

let fx: Fixture;
let keySeq = 0;

const ENV_KEYS = [
  'OUTBOUND_COORDINATOR', 'OUTBOUND_COALESCE_MINUTES', 'JOURNEY_QUIET_HOURS',
  'CARD_PAYMENT_ENABLED', 'BANK_FEED_ENABLED', 'IDENTITY_REQUIRED_FOR_RECEIPT', 'IDENTITY_REQUIRED_FOR_ESIGN', 'IDENTITY_REQUIRED_FOR_RECURRING', 'MO_QUICK_REPEAT_ENABLED',
] as const;
const savedEnv: Record<string, string | undefined> = {};

async function truncateExtra() {
  // resetDb 가 비우지 않는(기관 FK CASCADE 로만 지워지는) 표 중 이 파일이 쓰는 것
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "impact_update", "fund_expense", "legal_notice_delivery", "legal_report_setting", "content_item", "content_publish", "merchant_content_setting", "social_channel", "supporter_contact", "weekly_plan" CASCADE',
  );
}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.OUTBOUND_COORDINATOR = 'on';
  await resetDb();
  await truncateExtra();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  registerDefaultConsumers();
  clearMockOutbox();
  jar.clear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setChargeAmount(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 공통 도우미
// ---------------------------------------------------------------------------

function mo(text: string, opts: { from?: string; messageId?: string } = {}) {
  return handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, from: opts.from ?? fx.payerPhone, text, messageId: opts.messageId })));
}

/** 금액 선택 → PIN 승인까지(후원자가 링크를 열어 누른 것과 같은 경로) */
async function selectAndPay(chargeId: string, amount?: bigint) {
  await recordFunnelLinkOpened(chargeId, HUMAN_UA);
  const sel = await selectChargeAmount(fx.merchantId, amount);
  expect(sel.ok, sel.message).toBe(true);
  const session = await prisma.paymentPinSession.findUniqueOrThrow({ where: { chargeId } });
  await completePinAuthorization({ sessionId: session.sessionId });
  return prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
}

async function moPay(text: string, opts: { from?: string; amount?: bigint } = {}) {
  const r = await mo(text, { from: opts.from });
  expect(r.status).toBe('PENDING_AMOUNT');
  return selectAndPay(r.chargeId!, opts.amount);
}

function planInput(over: { code?: string; content?: CampaignPlanInput['content']; startNow?: boolean } = {}): CampaignPlanInput {
  return {
    setupKey: `sim${Date.now()}${++keySeq}abcdef`,
    campaign: {
      code: over.code ?? '김장', title: '김장 나눔', summary: '어르신께 김장을 전합니다', story: '', beneficiary: '', usagePlan: '김장 재료',
      imageUrl: '', goalAmount: 1_000_000, startsOn: plusDays(0), endsOn: plusDays(28), featured: false, resultReport: '',
    },
    startNow: over.startNow ?? true,
    afterEndPolicy: 'GENERAL',
    content: over.content === undefined ? null : over.content,
    thanksMessage: null,
    resultReportDueOn: null,
  };
}

async function makeIssuer() {
  await prisma.merchantProfile.update({
    where: { id: fx.merchantId },
    data: { businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION' },
  });
}

async function ledgerSum(where: Record<string, unknown> = {}) {
  const r = await prisma.settlementLedger.aggregate({ where: { merchantId: fx.merchantId, ...where }, _sum: { amount: true } });
  return r._sum.amount ?? 0n;
}

const outTemplates = () => readMockOutbox(200).map((m) => m.template ?? '');
const countTpl = (code: string) => outTemplates().filter((t) => t === code).length;

// ===========================================================================
// 시나리오 1 — 캠페인 개설 → 홍보물 MO → 결제 → 원장·이벤트·단계 → 감사 저니 1통 → 멱등
// ===========================================================================

describe('시나리오 1: 캠페인 개설 마법사 → 홍보물 키워드 MO → 결제 → 감사 저니', () => {
  it('결제 1건에 캠페인·홍보물·단계·정산 원장·charge.paid 가 맞고, 감사 안내는 발송 대기열로 1통, 재수신·동시 처리에도 결제 1건', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    // [1] 마법사로 캠페인 개설(콘텐츠 일정 없이) → 홍보물(현수막) 키워드
    const setup = await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장' }));
    expect(setup.created).toBe(true);
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: setup.campaignId } });
    expect(campaign.status).toBe('ACTIVE');
    const promo = await createPromo(fx.merchantId, campaign.id, { name: '현수막 A', keyword: '김장A' }, fx.merchantUserId);

    // [2] 현수막을 본 후원자가 문자 → 금액 선택 링크
    const payload = moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '김장A 힘내세요' });
    const first = await handleMoInbound(mockMoAdapter.parse(payload));
    expect(first.status).toBe('PENDING_AMOUNT');
    const chargeId = first.chargeId!;
    let charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(charge).toMatchObject({ campaignId: campaign.id, promoId: promo.id, message: '힘내세요', amount: 0n });
    expect(countTpl('SELECT_AMOUNT')).toBe(1);

    // [3] 같은 MO 재수신(통신사 재전송) → 중복, 결제 건 그대로
    const dup = await handleMoInbound(mockMoAdapter.parse(payload));
    expect(dup.result).toBe('DUPLICATE');
    expect(await prisma.charge.count()).toBe(1);
    expect(await prisma.moInboundMessage.count()).toBe(1);

    // [4] 금액 선택 → PIN 승인. PIN 콜백이 겹쳐 두 번 와도 승인 1건
    await recordFunnelLinkOpened(chargeId, HUMAN_UA);
    const sel = await selectChargeAmount(fx.merchantId, 30000n);
    expect(sel.ok).toBe(true);
    const session = await prisma.paymentPinSession.findUniqueOrThrow({ where: { chargeId } });
    await Promise.allSettled([completePinAuthorization({ sessionId: session.sessionId }), completePinAuthorization({ sessionId: session.sessionId })]);
    charge = await prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
    expect(PAID_STATUSES).toContain(charge.status);
    expect(charge.amount).toBe(30000n);
    expect(charge.campaignId).toBe(campaign.id);
    expect(charge.promoId).toBe(promo.id);

    // 불변식: 결제 거래 승인 1건, 원장(총액·PG·플랫폼 수수료) 결제당 한 벌, 합계 = 순수취
    expect(await prisma.paymentTransaction.count({ where: { chargeId, status: 'APPROVED' } })).toBe(1);
    expect(await prisma.settlementLedger.count({ where: { chargeId, entryType: 'CHARGE_GROSS' } })).toBe(1);
    expect(await ledgerSum({ chargeId, entryType: 'CHARGE_GROSS' })).toBe(30000n);
    const fees = await prisma.settlementLedger.findMany({ where: { chargeId, entryType: { in: ['PG_FEE', 'PLATFORM_FEE'] } } });
    expect(fees.every((f) => f.amount < 0n)).toBe(true);
    expect(await ledgerSum({ chargeId })).toBe(30000n + fees.reduce((a, f) => a + f.amount, 0n));

    // 불변식: charge.paid 이벤트 1건(캠페인 포함, 개인정보 원문 없음)
    const paidEv = await prisma.domainEvent.findMany({ where: { type: 'charge.paid', subjectId: chargeId } });
    expect(paidEv).toHaveLength(1);
    expect((paidEv[0]!.payload as Record<string, unknown>).campaignId).toBe(campaign.id);
    expect(JSON.stringify(paidEv[0]!.payload)).not.toContain(fx.payerPhone);

    // 불변식: 단계 기록 6단계(처음 도달만) 모두 홍보물 id
    const steps = await prisma.funnelStep.findMany({ where: { flowKey: `mo:${first.moMessageId}` }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
    expect(steps.map((s) => s.step)).toEqual(['MO_RECEIVED', 'REPLY_SENT', 'LINK_OPENED', 'AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID']);
    expect(steps.every((s) => s.promoId === promo.id)).toBe(true);

    // 불변식: 캠페인 모금액 = charge.campaign_id 기준
    expect((await campaignStats([campaign.id])).get(campaign.id)).toMatchObject({ raised: 30000n, chargeCount: 1, donorCount: 1 });
    expect(countTpl('CHARGE_SUCCESS')).toBe(1);

    // [5] 이벤트 배치 → 감사 저니 → 감사장 안내가 발송 대기열로 1통
    clearMockOutbox();
    await processDomainEvents();
    await processDomainEvents();
    const runs = await prisma.journeyRun.findMany({ where: { journeyKey: 'donation-thanks' } });
    expect(runs).toHaveLength(1);
    await flushDueOutbound({ now: new Date(Date.now() + MIN) });
    // 하루 뒤(영수증 안내 단계): 기관이 영수증 발급 준비가 안 됐으므로 생략
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + MIN) });
    await flushDueOutbound({ now: new Date(Date.now() + DAY + 2 * MIN) });
    const queue = await prisma.outboundQueue.findMany({ where: { merchantId: fx.merchantId } });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ kind: 'THANKS_LETTER', status: 'SENT' });
    expect(readMockOutbox(50).filter((m) => m.template === 'DOCUMENT_ISSUED')).toHaveLength(1);
    expect(await prisma.issuedDocument.count({ where: { purpose: 'THANKS_LETTER', payerId: charge.payerId! } })).toBe(1);
    const run = await prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: 'donation-thanks' }, include: { logs: true } });
    expect(run.status).toBe('DONE');
    expect(run.logs.filter((l) => l.sent).map((l) => l.stepKey)).toEqual(['thanks-letter']);

    // [6] 같은 MO 를 결제 뒤 다시 받아도(재전송) 결제 1건, 이벤트를 다시 돌려도 저니·안내 그대로
    expect((await handleMoInbound(mockMoAdapter.parse(payload))).result).toBe('DUPLICATE');
    await processDomainEvents();
    await flushDueOutbound({ now: new Date(Date.now() + 2 * DAY) });
    expect(await prisma.charge.count()).toBe(1);
    expect(await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'charge.paid' } })).toBe(1);
    expect(await prisma.journeyRun.count()).toBe(1);
    expect(await prisma.outboundQueue.count()).toBe(1);
  });

  it.skipIf(singleBackend)('같은 MO 가 동시에 세 번 들어와도 결제 건·수신 기록·금액 선택 문자는 하나', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const setup = await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장' }));
    await createPromo(fx.merchantId, setup.campaignId, { name: '현수막 A', keyword: '김장A' }, fx.merchantUserId);
    const payload = moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '김장A', messageId: `MO-SIM-CONC-${newId()}` });
    const rs = await Promise.allSettled([1, 2, 3].map(() => handleMoInbound(mockMoAdapter.parse(payload))));
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await prisma.moInboundMessage.count()).toBe(1);
    expect(await prisma.charge.count()).toBe(1);
    expect(countTpl('SELECT_AMOUNT')).toBe(1);
    expect(await prisma.funnelStep.count({ where: { step: 'MO_RECEIVED' } })).toBe(1);
    // 그 결제 건을 끝까지 진행하면 승인 1건
    const c = await prisma.charge.findFirstOrThrow();
    expect(lastSelectAmountToken()).toBeTruthy();
    await selectAndPay(c.id, 10000n);
    expect(await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'charge.paid' } })).toBe(1);
  });
});

// ===========================================================================
// 시나리오 2 — 정기후원 출금 실패(계좌 문제) → 조치 필요 → 복구 → 다음 배치 성공
// ===========================================================================

const todayKst = () => kstKey(Date.now());
const dayCol = (key: string) => new Date(`${key}T00:00:00Z`);

describe('시나리오 2: 정기후원 계좌 문제 → 승인 대기함 복구 묶음 → 복구 링크 → 재등록 → 다음 배치 성공', () => {
  it('조치 필요·복구 묶음·결제수단 재등록 이벤트·복구 기록이 이어지고, 같은 주기 결제 성공은 1건, 후원자 변경 이력이 남는다', async () => {
    resetInboxGroupProviders();
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 1_000_000n } });
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') } });
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10991n, dayOfMonth: 10 });
    if (!made.ok) throw new Error(made.message);
    const rid = made.recurring.id;
    // 오늘이 출금일이라고 둔다(배치 하루치)
    await prisma.recurringDonation.update({ where: { id: rid }, data: { nextChargeOn: dayCol(todayKst()), cycleMonth: todayKst().slice(0, 7) } });
    clearMockOutbox();

    // [1] 오늘 배치: mock 금액 끝자리 991 = 계좌 문제 → 자동 재시도 없이 조치 필요
    const r1 = await runRecurringDonations();
    expect(r1.failed).toBe(1);
    let rec = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: rid } });
    expect(rec).toMatchObject({ status: 'ACTIVE', recoveryState: 'ACTION_REQUIRED', lastFailureClass: 'ACCOUNT_PROBLEM' });
    const cycle = rec.cycleMonth;
    expect(await prisma.charge.count({ where: { recurringId: rid } })).toBe(1);
    expect(await prisma.charge.count({ where: { recurringId: rid, status: { in: PAID_STATUSES } } })).toBe(0);
    expect(await prisma.settlementLedger.count()).toBe(0); // 실패한 출금은 원장이 없다
    const failMsg = readMockOutbox(10).find((m) => m.template === 'RECURRING_ACCOUNT_PROBLEM');
    expect(failMsg).toBeTruthy();
    const token = failMsg!.text.match(/\/r\/recover\/([A-Za-z0-9_-]+)/)![1]!;

    // [2] 같은 날 배치를 다시 돌려도 출금 시도 없음(결제수단을 바꾸지 않았으므로)
    await runRecurringDonations();
    expect(await prisma.charge.count({ where: { recurringId: rid } })).toBe(1);

    // [3] 승인 대기함에 정기후원 복구 묶음(high)
    const groups = await loadInboxGroups(fx.merchantId);
    const g = groups.find((x) => x.provider === 'recurring-recovery')?.group;
    expect(g).toMatchObject({ kind: 'RECURRING_ACTION_REQUIRED', affectedCount: 1, severity: 'high' });

    // [4] 후원자가 복구 링크에서 금액을 바꾸고(셀프서비스 변경 이력) 새 계좌를 등록
    const sentence = await changeFromRecovery(token, { amount: 10000n });
    expect(sentence).toContain('결제수단을 다시 등록해야');
    const href = await startRecoveryRegistration(token);
    const regToken = href.slice(3);
    const consents = (['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const).map((type) => ({ type, agreed: true }));
    const reg = await startRegistration({ token: regToken, consents });
    await completeRegistration({ token: regToken, registrationId: reg.registrationId, providerPayload: { tid: 'MOCK-SIM-RECOVER', bankCode: '088', bankName: '신한은행', account: '11022233344' } });
    expect(await prisma.domainEvent.count({ where: { type: 'payment_method.registered', payerId: payer.id } })).toBe(1);
    // 아직 배치 전: 결제는 없다(등록 함수가 정기후원 출금을 하지 않음)
    expect(await prisma.charge.count({ where: { recurringId: rid } })).toBe(1);

    // [5] 이벤트 배치(소비자 recurring-recovery) → 다음 출금일이 오늘로
    await processDomainEvents();
    rec = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: rid } });
    expect(rec.nextChargeOn.toISOString().slice(0, 10)).toBe(todayKst());

    // [6] 다음 정기후원 배치 → 성공, 복구 기록, 원장 한 벌
    const r2 = await runRecurringDonations();
    expect(r2.succeeded).toBe(1);
    rec = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: rid } });
    expect(rec).toMatchObject({ recoveryState: 'NONE', failCount: 0, lastFailureClass: null, actionDeadlineOn: null });
    const runs = await prisma.recurringRun.findMany({ where: { recurringId: rid }, orderBy: { ranAt: 'asc' } });
    const success = runs.filter((x) => x.status === 'SUCCESS');
    expect(success).toHaveLength(1);
    expect(success[0]!.recovered).toBe(true);
    expect(success[0]!.monthKey).toBe(cycle);
    const recovered = await prisma.domainEvent.findMany({ where: { type: 'recurring.recovered', subjectId: rid } });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.dedupeKey).toBe(`recurring.recovered:${rid}:${cycle}`);
    const paid = await prisma.charge.findMany({ where: { recurringId: rid, status: { in: PAID_STATUSES } } });
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ amount: 10000n, paymentMode: 'RECURRING', channel: 'RECURRING' });
    expect(await prisma.settlementLedger.count({ where: { chargeId: paid[0]!.id, entryType: 'CHARGE_GROSS' } })).toBe(1);
    // 정기 결제는 문자 후원 단계 측정에 들어가지 않는다
    expect(await prisma.funnelStep.count()).toBe(0);

    // [7] 같은 날·같은 주기에 배치를 몇 번 더 돌려도(재실행·겹침) 결제 성공은 1건
    await Promise.all([runRecurringDonations(), runRecurringDonations()]);
    await runRecurringDonations(new Date(Date.now() + 3_600_000));
    expect(await prisma.charge.count({ where: { recurringId: rid, status: { in: PAID_STATUSES } } })).toBe(1);
    expect(await prisma.paymentTransaction.count({ where: { charge: { recurringId: rid }, status: 'APPROVED' } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'recurring.recovered' } })).toBe(1);
    // 복구 묶음은 사라진다
    expect(await recurringRecoveryInboxGroup(fx.merchantId)).toBeNull();

    // [8] 후원자 셀프서비스 변경 이력(복구 링크에서 본인이 바꿈)
    const logs = await prisma.recurringChangeLog.findMany({ where: { recurringId: rid } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: 'DONOR', via: 'RECOVER_LINK', kind: 'CHANGE' });
    expect(JSON.stringify(logs[0]!.after)).toContain('10000');
  });
});

// ===========================================================================
// 시나리오 3 — 은행 CSV 업로드 → 분류 → 확정 → 원장 불변 → 후원 내역 → 영수증 끔/켬 → 되돌리기 → 법정 서류
// ===========================================================================

async function relatedPayer(phone: string, name: string) {
  const payer = await seedRegisteredPayer(phone);
  await prisma.supporterContact.create({
    data: { id: newId(), merchantId: fx.merchantId, name, phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), role: 'DONOR', payerId: payer.id },
  });
  return payer;
}

const kbFile = () => new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', 'bank-kb-2026-11-09.csv')));

async function inKindReceipt(amount: bigint, year: number) {
  const user = await prisma.user.create({ data: { id: newId(), email: `giver-${newId()}@test.kr`, name: '기부자', role: 'GIVER' } });
  const donor = await prisma.inKindDonor.create({
    data: { id: newId(), userId: user.id, donorType: 'CORPORATE', displayName: '주식회사 나눔상사', contactName: '담당', phoneEnc: encrypt('01099990000'), phoneHash: phoneHash('01099990000'), phoneMasked: '010-****-0000' },
  });
  const donation = await prisma.inKindDonation.create({
    data: { id: newId(), donationNo: `IKD-${newId().slice(-8)}`, donorId: donor.id, merchantId: fx.merchantId, status: 'RECEIPTED', title: '생필품', matchMode: 'DIRECT', unsoldAction: 'DONATE', deliveryMethod: 'PARCEL', declaredTotal: amount },
  });
  return prisma.inKindReceipt.create({
    data: {
      id: newId(), merchantId: fx.merchantId, donationId: donation.id, donorId: donor.id, taxYear: year, seq: 1, receiptNo: `SIM-${year}-H000001`,
      totalAmount: amount, donationCode: '40', donorType: 'CORPORATE', donorSnapshot: { name: '주식회사 나눔상사' }, issuerSnapshot: {}, items: [],
      donatedAt: new Date(`${year}-05-01T03:00:00+09:00`), status: 'ISSUED', issuedBy: 'test',
    },
  });
}

describe('시나리오 3: 은행 CSV 입금 대사 → 확정 → 영수증·법정 서류', () => {
  it('계좌이체 확정분은 offline_donation 에만, 결제·캠페인·원장은 그대로, 영수증은 설정을 따르고, 법정 서류 수입 = 결제 PAID + 계좌이체 확정 + 현물', async () => {
    resetInboxGroupProviders();
    await makeIssuer();
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') } });
    const camp = await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장' }));
    // 홍길동: 문자 후원(캠페인) 1건 + 계좌이체 약정 30,000원 / 김영희: 문자 후원 1건(나중에 환불)
    const hong = await relatedPayer('01022223333', '홍길동');
    const kim = await relatedPayer('01033334444', '김영희');
    const hongCharge = await moPay('김장 응원합니다', { from: '01022223333', amount: 10000n });
    expect(hongCharge.campaignId).toBe(camp.campaignId);
    const kimCharge = await moPay('응원', { from: '01033334444', amount: 20000n });
    await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: hong.id, amount: 30000n, dayOfMonth: 5 });
    await upsertReceiptProfile(hong.id, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    const year = Number(kstKey(hongCharge.paidAt!.getTime()).slice(0, 4));

    const snapshot = async () => ({
      charges: await prisma.charge.count(),
      paidSum: (await prisma.charge.aggregate({ where: { status: { in: PAID_STATUSES } }, _sum: { amount: true } }))._sum.amount ?? 0n,
      ledgerRows: await prisma.settlementLedger.count(),
      ledger: await ledgerSum(),
      raised: (await campaignStats([camp.campaignId])).get(camp.campaignId)!.raised,
    });
    const before = await snapshot();
    const candBefore = await receiptCandidates(fx.merchantId, year);

    // [1] 은행 CSV 업로드 → 자동 확정(이름 1명 + 같은 금액 계좌이체 약정) 1 · 확인 필요(김영희, 이름만 일치) 1 · 모름(행복상사) 1
    const imp = await importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'kb.csv', bytes: kbFile() });
    expect(imp).toMatchObject({ status: 'DONE', rowCount: 3, autoMatched: 1, suggested: 1, unmatched: 1 });
    const deps = await prisma.bankDeposit.findMany({ where: { merchantId: fx.merchantId } });
    const byKey = (k: string) => deps.find((d) => d.depositorKey === k)!;
    expect(byKey('홍길동')).toMatchObject({ status: 'MATCHED', payerId: hong.id, autoMatched: true });
    expect(byKey('김영희').status).toBe('SUGGESTED');
    expect(byKey('행복상사').status).toBe('UNMATCHED');
    expect((await depositsInboxGroup(fx.merchantId))?.affectedCount).toBe(2);

    // [2] 담당자가 확인 필요 1건 확정(동시에 두 번 눌러도 1건)
    await Promise.all([1, 2].map(() => confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: byKey('김영희').id, candidateKey: `p:${kim.id}` }])));
    expect(await prisma.offlineDonation.count({ where: { status: 'CONFIRMED' } })).toBe(2);
    expect(await prisma.offlineDonation.count({ where: { depositId: byKey('김영희').id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'offline.received' } })).toBe(2);
    await processDomainEvents();

    // 불변식: 결제 건·결제 합계·정산 원장·캠페인 모금액(charge 기준)이 하나도 바뀌지 않는다
    expect(await snapshot()).toEqual(before);
    // 계좌이체 확정에는 감사 저니가 돌지 않는다(기본 끔)
    expect(await prisma.journeyRun.count({ where: { subjectType: 'offline_donation' } })).toBe(0);

    // [3] 후원자 후원 내역: 결제 + "계좌이체"
    const hist = await donorDonationHistory(hong.id, { merchantId: fx.merchantId, year });
    const offlineEntries = hist.entries.filter((e) => e.source === 'OFFLINE');
    expect(offlineEntries).toHaveLength(1);
    expect(offlineEntries[0]).toMatchObject({ sourceLabel: '계좌이체', amount: 30000n });
    expect(hist.entries.some((e) => e.source !== 'OFFLINE' && e.amount === 10000n)).toBe(true);
    expect(hist.yearTotal).toBe(40000n);

    // [4] 영수증 설정 끔(기본): 후보는 계좌이체 확정 전과 완전히 같다
    expect(await receiptCandidates(fx.merchantId, year)).toEqual(candBefore);
    // 켬: 홍길동 후보에 계좌이체 포함
    await setReceiptIncludeOffline(fx.merchantId, fx.merchantUserId, true);
    const hongCand = (await receiptCandidates(fx.merchantId, year)).find((c) => c.payerId === hong.id);
    expect(hongCand).toMatchObject({ amount: 40000n, count: 2, ready: true });
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: hong.id, taxYear: year, issuedBy: 't', silent: true });
    expect(receipt.totalAmount).toBe(40000n);

    // [5] 확정 되돌리기(영수증에 묶인 계좌이체) → 자동 무효 없이 정정 필요 표시, 입금은 다시 확인 필요
    const hongOffline = await prisma.offlineDonation.findFirstOrThrow({ where: { payerId: hong.id, status: 'CONFIRMED' } });
    const rv = await revertOfflineDonation(fx.merchantId, fx.merchantUserId, hongOffline.id, '다른 사람 입금');
    expect(rv.receiptCorrection).toBe(receipt.receiptNo);
    expect((await prisma.donationReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe('ISSUED');
    expect(await offlineReceiptCorrections(fx.merchantId, year)).toEqual([{ receiptId: receipt.id, receiptNo: receipt.receiptNo, totalAmount: 40000n, revertedAmount: 30000n }]);
    expect((await prisma.bankDeposit.findUniqueOrThrow({ where: { id: byKey('홍길동').id } })).status).toBe('SUGGESTED');
    await processDomainEvents();
    expect(await prisma.domainEvent.count({ where: { type: 'offline.reverted' } })).toBe(1);
    expect(await snapshot()).toEqual(before);

    // [6] 김영희 결제 환불 + 현물 영수증 → 법정 서류 수입 명세 = 결제 PAID(환불 제외) + 계좌이체 확정분 + 현물
    const rf = await requestRefund({ chargeId: kimCharge.id, reason: '단순 변심' });
    await approveRefund(rf.id, 'admin');
    await inKindReceipt(100_000n, year);
    const inc = await incomeStatement(fx.merchantId, year);
    const paidCharges = (await prisma.charge.aggregate({ where: { merchantId: fx.merchantId, isTest: false, status: { in: PAID_STATUSES } }, _sum: { amount: true } }))._sum.amount ?? 0n;
    const confirmedOffline = (await prisma.offlineDonation.aggregate({ where: { merchantId: fx.merchantId, status: 'CONFIRMED' }, _sum: { amount: true } }))._sum.amount ?? 0n;
    expect(paidCharges).toBe(10000n); // 홍길동 1건(김영희 환불 제외)
    expect(confirmedOffline).toBe(10000n); // 김영희 계좌이체(홍길동 것은 되돌림)
    expect(inc.bySource.CHARGE).toEqual({ count: 1, amount: 10000n });
    expect(inc.bySource.OFFLINE).toEqual({ count: 1, amount: 10000n });
    expect(inc.bySource.IN_KIND).toEqual({ count: 1, amount: 100_000n });
    expect(inc.total).toBe(paidCharges + confirmedOffline + 100_000n);
  });
});

// ===========================================================================
// 시나리오 4 — 결제 → 환불 → 감사 저니·관계 안내·결과 보고 대상에서 빠짐, 영수증 합산 제외, 단계 측정 불변
// ===========================================================================

describe('시나리오 4: 환불이 이어지는 일에서 빠진다', () => {
  it('환불된 결제는 감사 저니(승인 대기 취소)·관계 안내 대상·결과 보고 대상·영수증 합산에서 빠지고, 단계 측정 숫자는 그대로다', async () => {
    await makeIssuer();
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: true, approvals: { 'thanks-letter': true }, params: { minAmount: 0, receiptInfoDelayDays: 1 } }, fx.merchantUserId);
    const camp = await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장' }));
    const a = await seedRegisteredPayer('01011112222'); // 환불할 후원자
    const b = await seedRegisteredPayer('01033335555'); // 비교군
    // 두 달 전에 가입한 후원자(신규 후원자 첫날 한도에 걸리지 않게)
    await prisma.payerProfile.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { registeredAt: new Date(Date.now() - 60 * DAY), firstSeenAt: new Date(Date.now() - 60 * DAY) } });
    await upsertReceiptProfile(a.id, { legalName: '홍길동', residentNo: '900101-1234568', hometaxOptIn: true });
    // a: 캠페인 30,000(나중에 환불) + 일반 10,000 / b: 캠페인 20,000 + 일반 10,000
    const aCamp = await moPay('김장 힘내세요', { from: '01011112222', amount: 30000n });
    const aGen = await moPay('응원', { from: '01011112222', amount: 10000n });
    await moPay('김장 응원', { from: '01033335555', amount: 20000n });
    await moPay('응원', { from: '01033335555', amount: 10000n });
    // 관계 안내(일시 → 정기 권유) 조건: 두 번째 일시후원이 14일 넘게 지남 — 결제 시각만 과거로 옮긴다
    for (const c of await prisma.charge.findMany({ orderBy: { createdAt: 'asc' } })) {
      await prisma.charge.update({ where: { id: c.id }, data: { paidAt: new Date(c.paidAt!.getTime() - 20 * DAY) } });
    }
    for (const p of [a, b]) await setMarketingConsent({ payerId: p.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    await setRelationshipGloballyEnabled(true, 'admin');
    await saveRelationshipSetting(fx.merchantId, { enabled: true, kinds: ['ONE_TIME_TO_RECURRING'] }, fx.merchantUserId);

    await processDomainEvents();
    const runsFor = (chargeId: string) => prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: 'donation-thanks', subjectId: chargeId } });
    expect((await runsFor(aCamp.id)).status).toBe('AWAITING_APPROVAL');
    expect((await relationshipCandidates(fx.merchantId, ['ONE_TIME_TO_RECURRING'])).map((c) => c.payerId).sort()).toEqual([a.id, b.id].sort());
    const year = Number(kstKey(Date.now()).slice(0, 4));
    const candA = async () => (await receiptCandidates(fx.merchantId, year)).find((c) => c.payerId === a.id);
    expect(await candA()).toMatchObject({ amount: 40000n, count: 2 });
    const funnelBefore = await funnelReport({ merchantId: fx.merchantId, since: new Date(Date.now() - 60 * DAY) });
    const ledgerBefore = await ledgerSum();

    // [1] 환불(기관 요청 → 관리자 승인)
    const rf = await requestRefund({ chargeId: aCamp.id, reason: '중복 후원' });
    await approveRefund(rf.id, 'admin');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: aCamp.id } })).status).toBe('REFUNDED');
    // 원장은 반대분개로만(append-only): 원래 행 그대로 + REFUND 행
    expect(await prisma.settlementLedger.count({ where: { chargeId: aCamp.id, entryType: 'CHARGE_GROSS' } })).toBe(1);
    expect(await prisma.settlementLedger.count({ where: { chargeId: aCamp.id, entryType: 'REFUND' } })).toBe(1);
    expect(await ledgerSum()).toBeLessThan(ledgerBefore);
    expect(await prisma.domainEvent.count({ where: { type: 'charge.refunded', subjectId: aCamp.id } })).toBe(1);

    // [2] 이벤트 배치 → 환불 건 감사 저니·승인 요청 취소, 다른 결제 건 저니는 그대로
    await processDomainEvents();
    expect((await runsFor(aCamp.id)).status).toBe('CANCELED');
    const reqA = await prisma.approvalRequest.findFirstOrThrow({ where: { kind: 'JOURNEY_STEP', dedupeKey: `journey:${(await runsFor(aCamp.id)).id}:thanks-letter` } });
    expect(reqA.status).not.toBe('PENDING');
    expect((await runsFor(aGen.id)).status).toBe('AWAITING_APPROVAL');
    // 남은 승인 요청을 모두 승인해도 환불 건 감사장은 나가지 않는다
    for (const req of await prisma.approvalRequest.findMany({ where: { kind: 'JOURNEY_STEP', status: 'PENDING' } })) {
      await decideApproval({ merchantId: fx.merchantId, id: req.id, decision: 'APPROVE', userId: fx.merchantUserId });
    }
    await advanceDueJourneyRuns({ now: new Date(Date.now() + 2 * DAY) });
    await flushDueOutbound({ now: new Date(Date.now() + 2 * DAY + MIN) });
    const letters = await prisma.issuedDocument.findMany({ where: { purpose: 'THANKS_LETTER' } });
    expect(letters.some((d) => d.subjectId === aCamp.id)).toBe(false);
    expect(letters.filter((d) => d.payerId === b.id)).toHaveLength(2);

    // [3] 관계 안내 대상에서 빠짐(환불 180일)
    expect((await relationshipCandidates(fx.merchantId, ['ONE_TIME_TO_RECURRING'])).map((c) => c.payerId)).toEqual([b.id]);

    // [4] 결과 보고(캠페인) 대상에서 빠짐 — a 의 캠페인 결제는 환불뿐
    const impactId = await saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: camp.campaignId, title: '김장 전달', body: '김장을 전달했습니다.', photos: [], photoRuleAck: false });
    await generateImpactReport(fx.merchantId, impactId);
    await approveImpactUpdate(fx.merchantId, impactId, fx.merchantUserId);
    const rec = await impactRecipients(await prisma.impactUpdate.findUniqueOrThrow({ where: { id: impactId } }));
    expect(rec.recipients.map((r) => r.payerId)).toEqual([b.id]);

    // [5] 영수증 합산에서 제외, 캠페인 모금액(charge 기준)에서도 빠짐
    expect(await candA()).toMatchObject({ amount: 10000n, count: 1 });
    expect((await campaignStats([camp.campaignId])).get(camp.campaignId)).toMatchObject({ raised: 20000n, chargeCount: 1, donorCount: 1 });

    // [6] 단계 측정은 환불로 바뀌지 않는다(처음 도달만 기록 — 끝 상태를 거꾸로 바꾸지 않음)
    const funnelAfter = await funnelReport({ merchantId: fx.merchantId, since: new Date(Date.now() - 60 * DAY) });
    expect(funnelAfter.steps.map((s) => s.count)).toEqual(funnelBefore.steps.map((s) => s.count));
    expect(funnelAfter.total).toBe(funnelBefore.total);
    expect(await prisma.funnelStep.count({ where: { chargeId: aCamp.id, step: 'PAID' } })).toBe(1);
  });
});

// ===========================================================================
// 시나리오 5 — 문자 명령 "해지" → 링크 → 재확인 → 해지 → 결과 문자 / 같은 단어 캠페인이 있으면 기존 결제 흐름
// ===========================================================================

describe('시나리오 5: 문자 명령 해지', () => {
  it('"해지" MO 는 결제 건을 만들지 않고 링크 → 본인 재확인 → 정기 해지 → 결과 문자 1통', async () => {
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') } });
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 25 });
    if (!made.ok) throw new Error(made.message);
    clearMockOutbox();

    const r = await mo('해지');
    expect(r.result).toBe('ROUTED');
    expect(r.chargeId).toBeUndefined();
    expect(await prisma.charge.count()).toBe(0);
    expect(await prisma.idempotencyKey.count()).toBe(0);
    expect(await prisma.funnelStep.count({ where: { step: 'MO_RECEIVED' } })).toBe(0);
    const linkMsg = readMockOutbox(10).filter((m) => m.template === 'MO_COMMAND_LINK');
    expect(linkMsg).toHaveLength(1);
    const token = linkMsg[0]!.text.match(/\/mo\/([A-Za-z0-9_-]+)/)![1]!;
    const scope = (await smsReplyLinkScope(token))!;
    expect(scope).toMatchObject({ via: 'SMS', merchantId: fx.merchantId, payerId: payer.id });

    const form = () => {
      const f = new FormData();
      f.set('code', `sms:${token}`);
      f.set('id', made.recurring.id);
      f.set('action', 'CANCEL');
      return f;
    };
    // 재확인 전에는 바꾸지 않는다
    const pre = await recurringApplyAction({ ok: false }, form());
    expect(pre).toMatchObject({ ok: false, needStepUp: true });
    expect((await prisma.recurringDonation.findUniqueOrThrow({ where: { id: made.recurring.id } })).status).toBe('ACTIVE');

    // 링크 받은 번호로 인증번호 → 확인 → 브라우저 표시
    clearMockOutbox();
    const sent = await requestStepUp({ kind: 'SMS_LINK', linkId: scope.linkId });
    const code = sent.devCode ?? readMockOutbox(5)[0]!.text.match(/\d{6}/)![0];
    await confirmStepUp({ kind: 'SMS_LINK', linkId: scope.linkId }, code);
    await bindReplyLinkCookie(scope.linkId);
    clearMockOutbox();
    const done = await recurringApplyAction({ ok: false }, form());
    expect(done.ok).toBe(true);
    expect((await prisma.recurringDonation.findUniqueOrThrow({ where: { id: made.recurring.id } })).status).toBe('CANCELED');
    expect(readMockOutbox(10).filter((m) => m.template === 'RECURRING_SELF_RESULT')).toHaveLength(1);
    expect(readMockOutbox(10)).toHaveLength(1);
    expect((await prisma.recurringChangeLog.findFirstOrThrow({ where: { recurringId: made.recurring.id } })).via).toBe('SMS');
    // 한 번 더 눌러도 결과 문자는 늘지 않는다(이미 해지)
    await recurringApplyAction({ ok: false }, form());
    expect(readMockOutbox(10).filter((m) => m.template === 'RECURRING_SELF_RESULT')).toHaveLength(1);
    expect(await prisma.charge.count()).toBe(0);
  });

  it('같은 단어(해지)를 키워드로 쓰는 기존 캠페인이 있으면 명령이 아니라 캠페인 결제 흐름(기존 동작)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    // 명령어가 생기기 전부터 쓰던 캠페인(새로 만들 수는 없으므로 행을 직접 둔다)
    const legacy = await prisma.campaign.create({
      data: { id: newId(), merchantId: fx.merchantId, code: '해지', title: '해지 캠페인', summary: '요약', goalAmount: 1_000_000n, startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2099-12-31T00:00:00Z'), status: 'ACTIVE' },
    });
    const r = await mo('해지 응원합니다');
    expect(r.status).toBe('PENDING_AMOUNT');
    expect(await prisma.moReplyLink.count()).toBe(0);
    expect(countTpl('MO_COMMAND_LINK')).toBe(0);
    const paid = await selectAndPay(r.chargeId!, 10000n);
    expect(PAID_STATUSES).toContain(paid.status);
    expect(paid.campaignId).toBe(legacy.id);
    expect((await campaignStats([legacy.id])).get(legacy.id)!.raised).toBe(10000n);
    expect(await prisma.funnelStep.count({ where: { step: 'PAID' } })).toBe(1);
  });
});

// ===========================================================================
// 시나리오 6 — 스위치 모두 꺼짐: 기존 계좌 MO 결제 흐름 결과가 고도화 전 기대와 같다
// ===========================================================================

describe('시나리오 6: 계약 연동·관계 안내 스위치 꺼짐 = 무변화', () => {
  it('카드·계좌 조회·본인인증·지난번 방법·관계 안내가 모두 꺼지면 MO 결제의 상태·원장·문자 수가 예전과 같고, 관계 안내는 대상 0·발송 0', async () => {
    for (const k of ['CARD_PAYMENT_ENABLED', 'BANK_FEED_ENABLED', 'IDENTITY_REQUIRED_FOR_RECEIPT', 'IDENTITY_REQUIRED_FOR_ESIGN', 'IDENTITY_REQUIRED_FOR_RECURRING', 'MO_QUICK_REPEAT_ENABLED']) delete process.env[k];
    const flags = contractIntegrations();
    expect(flags).toMatchObject({ cardEnabled: false, bankFeedEnabled: false, moQuickRepeat: false, identityRequired: { receipt: false, esign: false, recurring: false } });
    expect(await cardOptionAvailable(fx.merchantId)).toBe(false);

    const payer = await seedRegisteredPayer(fx.payerPhone);
    // 지난번 후원이 있어도(지난번 방법 바로가기 조건) 꺼져 있으면 화면에 나오지 않는다
    await moPay('응원합니다', { amount: 10000n });
    clearMockOutbox();

    const r = await mo('후원합니다');
    expect(r.status).toBe('PENDING_AMOUNT');
    const ctx = await loadSelectAmountContext(lastSelectAmountToken()!);
    expect(ctx.ok).toBe(true);
    // 금액 선택 화면(/r/[token])이 부르는 판단 함수 그대로: 카드 선택지 없음 · 지난번 방법 바로가기 없음
    if (!ctx.ok) throw new Error('금액 선택 화면을 열지 못함');
    expect(await quickRepeatFor(ctx.ctx)).toBeNull();
    expect(await cardOptionAvailable(fx.merchantId)).toBe(false);
    // 대조: 스위치를 켜면 같은 화면에 바로가기가 생긴다(위 null 이 스위치 때문임을 확인) — 그리고 다시 끈다
    process.env.MO_QUICK_REPEAT_ENABLED = 'true';
    expect(await quickRepeatFor(ctx.ctx)).not.toBeNull();
    delete process.env.MO_QUICK_REPEAT_ENABLED;
    const charge = await selectAndPay(r.chargeId!, 3000n);

    // 상태: 예전 계좌 결제와 같다(결제 방법 비어 있음 = 계좌, 카드 세션·본인인증·계좌 조회 행 없음)
    expect(PAID_STATUSES).toContain(charge.status);
    expect(charge.paymentMethod ?? null).toBeNull();
    expect(charge.paymentMode).toBe('CONFIRM_LINK');
    const txs = await prisma.paymentTransaction.findMany({ where: { chargeId: charge.id } });
    expect(txs.map((t) => [t.provider, t.status])).toEqual([['mock', 'APPROVED']]);
    expect(await prisma.cardCheckoutSession.count()).toBe(0);
    expect(await prisma.identityVerification.count()).toBe(0);
    expect(await prisma.bankFeedLink.count()).toBe(0);
    expect(await syncBankFeeds()).toMatchObject({ skipped: 'DISABLED' });
    expect(await prisma.bankDeposit.count()).toBe(0);

    // 원장: 결제 한 건에 총액(+)·PG 수수료(-)·플랫폼 수수료(-) 세 줄, 합계 = 계좌 수수료 정책 계산
    const rows = await prisma.settlementLedger.findMany({ where: { chargeId: charge.id }, orderBy: { entryType: 'asc' } });
    const fees = await calculateFees(fx.merchantId, 3000n);
    expect(rows.map((x) => x.entryType).sort()).toEqual(['CHARGE_GROSS', 'PG_FEE', 'PLATFORM_FEE']);
    expect(rows.find((x) => x.entryType === 'CHARGE_GROSS')!.amount).toBe(3000n);
    expect(rows.find((x) => x.entryType === 'PG_FEE')!.amount).toBe(-fees.pgFee);
    expect(rows.find((x) => x.entryType === 'PLATFORM_FEE')!.amount).toBe(-fees.platformFee);

    // 문자: 금액 선택 안내 1 + 결제 완료 1 = 2통(카드·본인인증·관계 안내 문자 없음)
    expect(outTemplates().sort()).toEqual(['CHARGE_SUCCESS', 'SELECT_AMOUNT']);
    expect(await prisma.mtOutboundMessage.count({ where: { chargeId: charge.id } })).toBe(2);

    // 관계 안내 꺼짐(기본): 동의자가 있어도 대상 계산·승인 요청·발송 0
    await setMarketingConsent({ payerId: payer.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    expect((await proposeWeeklyBatch(fx.merchantId, noon())).reason).toBe('DISABLED');
    expect((await runRelationshipCron(noon())).skipped).toBe('DISABLED');
    expect((await sendApprovedRelationshipMessages(noon())).skipped).toBe('DISABLED');
    expect(await prisma.relationshipMessage.count()).toBe(0);
    expect(await prisma.approvalRequest.count({ where: { kind: 'RELATIONSHIP_MESSAGE_BATCH' } })).toBe(0);
    expect(countTpl('RELATIONSHIP_MESSAGE')).toBe(0);
  });
});

// ===========================================================================
// 시나리오 7 — 콘텐츠: 어느 경로로 생겨도 승인 전에는 게시 예약 0
// ===========================================================================

describe('시나리오 7: 콘텐츠는 사람이 승인해야만 게시 예약된다', () => {
  it('캘린더·개설 마법사·주간 계획 주제 승인으로 생긴 콘텐츠 모두 검토 대기, content_publish 0 → 승인한 것만 예약', async () => {
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { fundraisingRegNo: '2026-서울-00999' } });
    await connectSocialChannel(fx.merchantId, 'INSTAGRAM', '@welfare', fx.merchantUserId);
    // 자동 승인 값을 보내도 저장되지 않는다. 자동 예약은 켬
    await saveContentSetting(fx.merchantId, { tone: 'WARM', bannedWords: [], hashtags: [], autoApprove: true, calendar: { calendarEnabled: true, weeklyCount: 7, days: [], postHour: 19, kinds: ['IMAGE_FEED'], platforms: ['INSTAGRAM'], autoSchedule: true } } as never);
    await prisma.merchantContentSetting.update({ where: { merchantId: fx.merchantId }, data: { autoApprove: true } }); // DB 에 켜져 있어도 읽지 않는다

    // [경로 1] 개설 마법사 → 콘텐츠 일정 슬롯 → 배치(campaign-ops)
    const wiz = await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장', content: { weeklyCount: 3, postHour: 19 } }));
    const gen = await generatePlannedSlots();
    expect(gen.created).toBeGreaterThan(0);
    // [경로 2] 콘텐츠 캘린더 배치
    const cal = await fillNextSlot(fx.merchantId);
    expect(cal.slot).toBeTruthy();
    // [경로 3] 주간 계획 → 주제 제안 승인 → 배치가 콘텐츠 생성
    const fresh = await saveCampaign(fx.merchantId, campaignSchema.parse({
      code: 'FRESH', title: '겨울 이불', summary: '이불 나눔', story: '이불을 전합니다.', beneficiary: '어르신', usagePlan: '이불', goalAmount: 3000000, startsOn: '2026-01-01', endsOn: '2099-12-31',
    }));
    await setCampaignStatus(fx.merchantId, fresh.id, 'ACTIVE');
    const { plan } = await generateWeeklyPlan(fx.merchantId, new Date('2026-11-16T00:30:00Z'));
    const topic = (plan.suggestions as unknown as StoredSuggestion[]).find((s) => s.type === 'CONTENT_TOPIC');
    expect(topic).toBeTruthy();
    const topicReq = await prisma.approvalRequest.findUniqueOrThrow({ where: { dedupeKey: weeklyApprovalKey(plan.id, topic!.key) } });
    await decideApproval({ merchantId: fx.merchantId, id: topicReq.id, decision: 'APPROVE', userId: fx.merchantUserId });
    await runQueuedApprovals();
    await runQueuedApprovals();

    const items = await prisma.contentItem.findMany({ where: { merchantId: fx.merchantId } });
    const wizSlotItems = new Set((await prisma.contentSlot.findMany({ where: { campaignId: wiz.campaignId, itemId: { not: null } } })).map((x) => x.itemId!));
    const wizItems = items.filter((i) => wizSlotItems.has(i.id) && i.id !== cal.slot!.itemId);
    const planItems = items.filter((i) => i.createdBy === `WEEKLY_PLAN:${topicReq.id}`);
    expect(wizItems.length).toBeGreaterThan(0);
    expect(planItems).toHaveLength(1);
    expect(items.some((i) => i.id === cal.slot!.itemId)).toBe(true);
    // 불변식: 모두 검토 대기·승인자 없음, 게시 예약 0 — 게시 배치를 여러 번 돌려도
    expect(items.every((i) => i.status === 'REVIEW' && i.approvedBy === null && i.approvedAt === null)).toBe(true);
    for (const h of [1, 24, 24 * 8]) await processContentQueue(new Date(Date.now() + h * 3_600_000));
    expect(await prisma.contentPublish.count()).toBe(0);
    expect(await prisma.domainEvent.count({ where: { type: 'content.approved' } })).toBe(0);

    // [승인] 캘린더 콘텐츠(미래 슬롯)만 승인 → 그 콘텐츠만 예약
    await approveContent(fx.merchantId, cal.slot!.itemId!, fx.merchantUserId);
    const pubs = await prisma.contentPublish.findMany();
    expect(pubs.length).toBeGreaterThan(0);
    expect(pubs.every((p) => p.itemId === cal.slot!.itemId)).toBe(true);
    // 주간 계획 콘텐츠는 슬롯이 없어 승인만(예약 없음), 승인하지 않은 마법사 콘텐츠는 계속 0
    await approveContent(fx.merchantId, planItems[0]!.id, fx.merchantUserId);
    expect(await prisma.contentPublish.count({ where: { itemId: planItems[0]!.id } })).toBe(0);
    expect(await prisma.contentPublish.count({ where: { itemId: { in: wizItems.map((i) => i.id) } } })).toBe(0);
    expect(await prisma.domainEvent.count({ where: { type: 'content.approved' } })).toBe(2);
  });
});

// ===========================================================================
// 시나리오 8 — 한 주에 안내가 몰릴 때: 정보성 7일 3건 상한·야간 금지·묶음 1통, 광고성(관계 안내)은 별도로 월 1회
// ===========================================================================

describe('시나리오 8: 발송 상한(한 후원자에게 같은 주에 안내가 몰릴 때)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('감사장·영수증 안내·월간 안내·결과 보고가 몰려도 정보성은 7일 3건·야간 금지·묶음 1통, 관계 안내는 상한과 따로 월 1회·정보성과 다른 날·야간 금지', async () => {
    const { runMerchantNoticeDetailed } = await import('@/server/services/monthly-notice');
    const { requestImpactSend } = await import('@/server/services/impact-legal-approvals');
    const { relationalCapCount } = await import('@/server/services/outbound/coordinator');
    const { informationalTemplateCodes, OUTBOUND_BUNDLE_TEMPLATE, RELATIONAL_WEEKLY_CAP } = await import('@/server/services/outbound/classify');
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    process.env.JOURNEY_QUIET_HOURS = 'on';
    // 시계만 바꾼다(타이머·DB 입출력은 실제 그대로). 오늘 KST 12시를 T0 로.
    const T0 = noon().getTime();
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const at = (ms: number) => vi.setSystemTime(new Date(ms));
    const H = 3_600_000;

    await makeIssuer();
    const p1 = await seedRegisteredPayer('01011110001');
    const p2 = await seedRegisteredPayer('01011110002');
    await prisma.payerProfile.updateMany({ where: { id: { in: [p1.id, p2.id] } }, data: { registeredAt: new Date(T0 - 60 * DAY), firstSeenAt: new Date(T0 - 60 * DAY) } });
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: false, approvals: {}, params: {} }, fx.merchantUserId);

    // ---- 지난달: 일시후원 이력(P1 2회, P2 1회). 그때는 감사 저니를 꺼 둔 기관이다.
    at(T0 - 25 * DAY);
    await moPay('응원', { from: '01011110001', amount: 10000n });
    await moPay('응원', { from: '01011110002', amount: 10000n });
    at(T0 - 20 * DAY);
    await moPay('응원', { from: '01011110001', amount: 10000n });
    await processDomainEvents();
    await setMarketingConsent({ payerId: p1.id, merchantId: fx.merchantId, agree: true, source: 'DONATE' });
    const noticeMonth = kstKey(T0 - 25 * DAY).slice(0, 7);

    // ---- T0(낮 12시): 캠페인 후원 → 감사장 + 영수증 정보 안내(저니), 월간 안내, 결과 보고가 같은 날 몰린다
    at(T0);
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: true, approvals: {}, params: { minAmount: 0, receiptInfoDelayDays: 0 } }, fx.merchantUserId);
    await setRelationshipGloballyEnabled(true, 'admin');
    await saveRelationshipSetting(fx.merchantId, { enabled: true, kinds: ['ONE_TIME_TO_RECURRING'] }, fx.merchantUserId);
    const camp = await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장' }));
    clearMockOutbox();
    await moPay('김장 응원합니다', { from: '01011110001', amount: 50000n });
    await processDomainEvents();
    at(T0 + 1 * MIN);
    await advanceDueJourneyRuns();
    at(T0 + 2 * MIN);
    const notice = await runMerchantNoticeDetailed(fx.merchantId, noticeMonth);
    expect(notice.run!.recipientCount).toBe(2);
    at(T0 + 3 * MIN);
    const impactId = await saveImpactUpdate(fx.merchantId, fx.merchantUserId, { campaignId: camp.campaignId, title: '김장 전달', body: '김장을 전달했습니다.', photos: [], photoRuleAck: false });
    await generateImpactReport(fx.merchantId, impactId);
    await approveImpactUpdate(fx.merchantId, impactId, fx.merchantUserId);
    const send = await requestImpactSend(fx.merchantId, impactId);
    await decideApproval({ merchantId: fx.merchantId, id: send.approvalId, decision: 'APPROVE', userId: fx.merchantUserId });
    await runQueuedApprovals();

    // 아직 묶음 대기 중: 정보성 안내는 한 통도 나가지 않았다(결제 완료 안내 같은 거래형만)
    const infoCodes = new Set(informationalTemplateCodes());
    const infoOut = () => readMockOutbox(500).filter((m) => infoCodes.has(m.template ?? ''));
    expect(infoOut()).toHaveLength(0);
    const p1Queue = async () => prisma.outboundQueue.findMany({ where: { payerId: p1.id }, orderBy: { priority: 'desc' } });
    expect((await p1Queue()).map((q) => q.kind).sort()).toEqual(['IMPACT_REPORT', 'MONTHLY_NOTICE', 'RECEIPT_INFO', 'THANKS_LETTER']);

    // 관계 안내 묶음(주 1회) → 기관 승인
    const batch = await proposeWeeklyBatch(fx.merchantId, new Date(T0 + 4 * MIN));
    expect(batch).toMatchObject({ created: true, total: 1 });
    await decideApproval({ merchantId: fx.merchantId, id: batch.approvalId!, decision: 'APPROVE', userId: fx.merchantUserId });

    // ---- T0+14분(마지막 안내가 쌓이고 10분 묶음 대기가 지난 뒤): 발송 대기열 배치 → P1 은 한 통(묶음), 상한 3건(저니 2 + 결과 보고 1), 월간 안내는 하루 보류
    at(T0 + 14 * MIN);
    await flushDueOutbound();
    const p1Phone = phoneHash('01011110001');
    const p1Mts = async () => prisma.mtOutboundMessage.findMany({ where: { phoneHash: p1Phone, templateCode: { in: [...infoCodes] } } });
    let mts = await p1Mts();
    expect(mts).toHaveLength(1);
    expect(mts[0]!.templateCode).toBe(OUTBOUND_BUNDLE_TEMPLATE);
    expect(mts[0]!.bodyMasked).toContain('안내 3건');
    let q = await p1Queue();
    expect(Object.fromEntries(q.map((x) => [x.kind, x.status]))).toEqual({ IMPACT_REPORT: 'SENT', THANKS_LETTER: 'SENT', RECEIPT_INFO: 'SENT', MONTHLY_NOTICE: 'QUEUED' });
    expect(q.find((x) => x.kind === 'MONTHLY_NOTICE')!.lastReason).toMatch(/7일 3건/);
    expect(await relationalCapCount(prisma, fx.merchantId, p1.id, new Date())).toBe(RELATIONAL_WEEKLY_CAP);
    // P2 는 월간 안내 한 건 → 원래 템플릿 그대로 한 통
    expect((await prisma.mtOutboundMessage.findMany({ where: { phoneHash: phoneHash('01011110002'), templateCode: { in: [...infoCodes] } } })).map((m) => m.templateCode)).toEqual(['MONTHLY_NOTICE']);

    // 관계 안내: 같은 날 정보성 안내가 나갔으므로 다음 날로(상한·대기열과는 따로 센다)
    at(T0 + 20 * MIN);
    const ad0 = await sendApprovedRelationshipMessages();
    expect(ad0).toMatchObject({ sent: 0, deferred: 1 });

    // ---- 같은 날 22시: P2 가 문자 후원 → 결제 완료 문자(거래형)는 바로, 감사장(정보성)은 다음 날 9시 이후. 관계 안내도 야간 금지
    at(T0 + 10 * H);
    clearMockOutbox();
    await moPay('응원', { from: '01011110002', amount: 10000n });
    expect(countTpl('CHARGE_SUCCESS')).toBe(1);
    await processDomainEvents();
    await advanceDueJourneyRuns();
    await flushDueOutbound();
    expect((await sendApprovedRelationshipMessages()).skipped).toBe('QUIET_HOURS');
    expect(infoOut()).toHaveLength(0);
    const p2Run = await prisma.journeyRun.findFirstOrThrow({ where: { payerId: p2.id, journeyKey: 'donation-thanks' } });
    expect(new Date(p2Run.dueAt.getTime() + 9 * H).getUTCHours()).toBe(9);

    // ---- 다음 날 9시: P2 감사장이 나간다
    at(T0 + DAY - 3 * H + MIN); // KST 09:01
    await advanceDueJourneyRuns();
    at(T0 + DAY - 3 * H + 12 * MIN);
    await flushDueOutbound();
    // 밤사이 미뤄진 P2 감사장 + 영수증 정보 안내가 아침에 한 통으로
    const morning = infoOut();
    expect(morning).toHaveLength(1);
    expect(morning[0]!.template).toBe(OUTBOUND_BUNDLE_TEMPLATE);
    expect(morning[0]!.text).toContain('감사장');
    expect(morning[0]!.text).toContain('주민등록번호 등록');

    // ---- 1~3일 뒤 낮: P1 월간 안내는 상한 때문에 계속 보류 → 3번 보류 뒤 건너뜀. 관계 안내는 1일째에 나간다(정보성 없는 날)
    for (let d = 1; d <= 3; d += 1) {
      // 보류 기한은 "보류한 순간 + 하루"다. 가짜 시계가 실제 시간만큼 흐르므로(shouldAdvanceTime) 매일 같은 분에 돌리면
      // 몇 ms 차이로 기한 전이 되어 보류 횟수가 모자랄 수 있다(전체 실행에서만 간헐 실패 — 2026-11-12 점검). 날마다 1분씩 늦춘다.
      at(T0 + d * DAY + (20 + d) * MIN);
      await advanceDueJourneyRuns();
      await flushDueOutbound();
      at(T0 + d * DAY + 40 * MIN);
      await sendApprovedRelationshipMessages();
    }
    q = await p1Queue();
    const monthly = q.find((x) => x.kind === 'MONTHLY_NOTICE')!;
    expect(monthly.status).toBe('SKIPPED');
    expect(monthly.lastReason).toMatch(/3번 보류되어 건너뜀/);
    // 원천(월간 안내 기록·실행 집계)에도 결과가 되돌려 적힌다
    expect((await prisma.noticeDelivery.findUniqueOrThrow({ where: { id: monthly.sourceId! } })).status).toBe('SKIPPED');
    expect(await prisma.noticeRun.findUniqueOrThrow({ where: { id: notice.run!.id } })).toMatchObject({ recipientCount: 2, sentCount: 1, skippedCount: 1 });
    mts = await p1Mts();
    expect(mts).toHaveLength(1); // 7일 동안 P1 이 받은 정보성 문자는 묶음 한 통
    const ads = await prisma.relationshipMessage.findMany({ where: { payerId: p1.id } });
    expect(ads.map((a) => a.status)).toEqual(['SENT']);
    const adSentKst = new Date(ads[0]!.sentAt!.getTime() + 9 * H);
    expect(adSentKst.toISOString().slice(0, 10)).toBe(kstKey(T0 + DAY)); // 정보성 묶음과 다른 날
    expect(adSentKst.getUTCHours()).toBeGreaterThanOrEqual(8);
    expect(adSentKst.getUTCHours()).toBeLessThan(21);
    const adMt = await prisma.mtOutboundMessage.findMany({ where: { phoneHash: p1Phone, templateCode: 'RELATIONSHIP_MESSAGE' } });
    expect(adMt).toHaveLength(1);
    expect(adMt[0]!.channel).toBe('SMS');
    // 광고성은 정보성 상한·대기열에 들어가지 않는다
    expect(await prisma.outboundQueue.count({ where: { templateCode: 'RELATIONSHIP_MESSAGE' } })).toBe(0);
    expect(await relationalCapCount(prisma, fx.merchantId, p1.id, new Date(T0 + DAY))).toBe(RELATIONAL_WEEKLY_CAP);

    // 불변식: P1 의 7일 정보성 발송 = 저니 기록(sent) + 대기열 SENT(저니가 세지 않은 것) ≤ 3
    const since = new Date(T0 - 1 * MIN);
    const journeySent = await prisma.journeyStepLog.count({ where: { merchantId: fx.merchantId, payerId: p1.id, sent: true, at: { gte: since } } });
    const queueSent = await prisma.outboundQueue.count({ where: { merchantId: fx.merchantId, payerId: p1.id, precounted: false, status: 'SENT' } });
    expect(journeySent + queueSent).toBe(RELATIONAL_WEEKLY_CAP);
    // 불변식: 정보성 문자는 낮(9~21시 KST)에만
    const allInfo = await prisma.mtOutboundMessage.findMany({ where: { templateCode: { in: [...infoCodes] } } });
    for (const m of allInfo) {
      const h = new Date(m.createdAt.getTime() + 9 * H).getUTCHours();
      expect(h >= 9 && h < 21, `${m.templateCode} ${m.createdAt.toISOString()}`).toBe(true);
    }

    // 같은 달 다른 관계 안내(예: 다른 기관 승인분)는 월 1회로 건너뛴다
    await prisma.relationshipMessage.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: p1.id, kind: 'ONE_TIME_TO_RECURRING', periodKey: 'X', dedupeKey: `sim:${newId()}`, status: 'APPROVED' } });
    at(T0 + 4 * DAY);
    const again = await sendApprovedRelationshipMessages();
    if (kstKey(T0 + 4 * DAY).slice(0, 7) === kstKey(T0 + DAY).slice(0, 7)) {
      expect(again).toMatchObject({ sent: 0, dropped: 1 });
      expect(await prisma.mtOutboundMessage.count({ where: { phoneHash: p1Phone, templateCode: 'RELATIONSHIP_MESSAGE' } })).toBe(1);
    }
  });
});

// ===========================================================================
// 최종 시뮬레이션에서 찾은 버그의 회귀 테스트(수정: outbound/coordinator.ts queuedSourceProblem — 보내기 직전 원천 재확인).
// ===========================================================================

describe('발견한 버그(재현)', () => {
  // BUG: 발송 대기열(outbound/coordinator.ts flushPayer)은 저니가 예약한 안내(precounted)를 보내기 직전에 원천 상태를 다시 보지 않는다.
  //  저니 엔진은 "발송 직전" 결제가 PAID_STATUSES 인지 확인하지만(engine.ts, 점검 A-M3) 그 확인은 대기열에 쌓는 순간이고,
  //  운영 기본 묶음 대기(OUTBOUND_COALESCE_MINUTES=10) 동안 환불이 끝나면 journey-refund 소비자는 실행만 취소하고
  //  outbound_queue 의 QUEUED 행은 그대로 둔다 → 환불된 후원에 감사장 안내 문자가 나간다.
  //  (진행 중 환불 멈춤 autoPauseReason 도 precounted 안내는 건너뛴다.) 기대: 0통 / 실제: DOCUMENT_ISSUED 1통.
  it('(수정됨) 감사장 안내가 발송 대기열에 있는 동안 환불되면 그 안내는 나가지 않아야 한다', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    await seedRegisteredPayer(fx.payerPhone);
    const paid = await moPay('응원합니다', { amount: 30000n });
    clearMockOutbox();
    await processDomainEvents();
    const item = await prisma.outboundQueue.findFirstOrThrow({ where: { kind: 'THANKS_LETTER' } });
    expect(item.status).toBe('QUEUED');
    const rf = await requestRefund({ chargeId: paid.id, reason: '중복 결제' });
    await approveRefund(rf.id, 'admin');
    await processDomainEvents();
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe('REFUNDED');
    await flushDueOutbound({ now: new Date(Math.max(item.dueAt.getTime(), noon().getTime()) + MIN) });
    expect(readMockOutbox(20).filter((m) => m.template === 'DOCUMENT_ISSUED')).toHaveLength(0);
  });

  // BUG: 같은 원인 — 계좌이체 확정에서 시작한 감사 저니(includeOffline 켬)의 감사장 안내가 대기열에 있는 동안 확정을 되돌려도
  //  (journey-offline-revert 소비자가 실행은 취소) 대기열 행은 그대로 나간다. CLAUDE.md "발송 직전 context.offlineDonationId 가 CONFIRMED 인지 재확인" 위반.
  //  기대: 0통 / 실제: DOCUMENT_ISSUED 1통.
  it('(수정됨) 계좌이체 감사장 안내가 대기열에 있는 동안 확정을 되돌리면 그 안내는 나가지 않아야 한다', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    const hong = await relatedPayer('01022223333', '홍길동');
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: true, approvals: {}, params: { includeOffline: true, minAmount: 0 } }, fx.merchantUserId);
    await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: hong.id, amount: 30000n, dayOfMonth: 5 });
    await importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'kb.csv', bytes: kbFile() });
    await processDomainEvents();
    const item = await prisma.outboundQueue.findFirstOrThrow({ where: { kind: 'THANKS_LETTER' } });
    const od = await prisma.offlineDonation.findFirstOrThrow({ where: { payerId: hong.id } });
    await revertOfflineDonation(fx.merchantId, fx.merchantUserId, od.id, '다른 사람 입금');
    await processDomainEvents();
    await flushDueOutbound({ now: new Date(Math.max(item.dueAt.getTime(), noon().getTime()) + MIN) });
    expect(readMockOutbox(20).filter((m) => m.template === 'DOCUMENT_ISSUED')).toHaveLength(0);
  });
});
