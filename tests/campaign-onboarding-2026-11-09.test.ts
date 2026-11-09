import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, phoneHash } from '@/lib/crypto';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import { PAID_STATUSES } from '@/components/studio/shared';
import { merchantDonationSummary, CampaignCodeTakenError } from '@/server/services/fundraising';
import { receiptCandidates } from '@/server/services/receipts';
import {
  CampaignSetupError,
  applyCampaignChange,
  approveGoalFollowup,
  campaignChangeImpact,
  campaignPaceSuggestions,
  campaignPlanFromForm,
  createCampaignFromPlan,
  elapsedRatio,
  generatePlannedSlots,
  handleCampaignGoalFollowup,
  paceBehind,
  plannedSlotTimes,
  previewCampaignPlan,
  resultReportInboxGroup,
  runCampaignPaceCheck,
  type CampaignPlanInput,
} from '@/server/services/campaign-setup';
import { endedCampaignRejecting } from '@/server/services/campaign-after-end';
import { autoScheduleSlotItem } from '@/server/services/content';
import { decideApproval } from '@/server/services/approvals';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { maskResidentNumbers, parseOrgDocument } from '@/lib/org-doc-parse';
import { mockOcrAdapter, parseOcrJson, type OcrAdapter } from '@/server/adapters/ocr';
import { OnboardingError, dismissOnboarding, onboardingChecklist, runOnboardingTest, scanCandidates, scanOrgDocument, setOnboardingSkip } from '@/server/services/onboarding';
import { deletePrivateObject, getPrivateObject } from '@/server/uploads';
import { commitSupporterImport, previewSupporterImport } from '@/server/services/supporters';
import { checkEdocRunway, checkMoDrop, checkSocialExpiry, edocRunwayDays, moDropped } from '@/server/services/self-check';
import { operationChecks, readinessWithChecks } from '@/server/services/readiness-checks';

/**
 * 2026-11-12 4차 과제 I — 캠페인 전 과정 연결 + 기관 도입 자동.
 * 마법사 원자성·재실행 안전, 종료 후 방침, 영향 미리보기 숫자, 70% 규칙 1회, 시험 거래 집계 제외, 진단 알림 조건,
 * 서류 읽기(가림·mock), 명단 중복 후보, 작동 점검.
 */

let fx: Fixture;
const DAY = 86_400_000;
const kstKey = (ms: number) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const plusDays = (n: number) => kstKey(Date.now() + n * DAY);
const dcol = (k: string) => new Date(`${k}T00:00:00Z`);
let keySeq = 0;
const setupKey = () => `setup${Date.now()}${++keySeq}abcdef`;

function planInput(over: Partial<CampaignPlanInput> & { code?: string; startsOn?: string; endsOn?: string; goal?: number } = {}): CampaignPlanInput {
  return {
    setupKey: over.setupKey ?? setupKey(),
    campaign: {
      code: over.code ?? '김장',
      title: '김장 나눔',
      summary: '어르신께 김장을 전합니다',
      story: '',
      beneficiary: '',
      usagePlan: '김장 재료',
      imageUrl: '',
      goalAmount: over.goal ?? 1_000_000,
      startsOn: over.startsOn ?? plusDays(0),
      endsOn: over.endsOn ?? plusDays(28),
      featured: false,
      resultReport: '',
    },
    startNow: over.startNow ?? true,
    afterEndPolicy: over.afterEndPolicy ?? 'GENERAL',
    content: over.content === undefined ? { weeklyCount: 2, postHour: 19 } : over.content,
    thanksMessage: over.thanksMessage ?? null,
    resultReportDueOn: over.resultReportDueOn ?? null,
  };
}

async function truncateMine() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "org_doc_scan", "onboarding_test_run", "self_check_alert", "sandbox_charge", "sandbox_message", "impact_update", "supporter_import", "supporter_contact", "social_channel", "content_item", "content_publish", "merchant_content_setting", "edoc_ledger", "edoc_wallet" CASCADE');
}

beforeEach(async () => {
  await resetDb();
  await truncateMine();
  clearMockOutbox();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  registerDefaultConsumers();
});

afterAll(async () => {
  await truncateMine();
});

// ---------------------------------------------------------------------------
describe('I1-1 개설 마법사', () => {
  it('[1] 캠페인·콘텐츠 일정 슬롯(PLANNED)·방침·감사 문구·결과 보고 예정일이 한 번에 생기고, 같은 제출 키는 두 번 처리하지 않는다', async () => {
    const input = planInput({ afterEndPolicy: 'REJECT', thanksMessage: '{후원자}님 김장 후원 고맙습니다', resultReportDueOn: plusDays(60) });
    const expected = plannedSlotTimes(input.content!, input.campaign.startsOn, input.campaign.endsOn);
    expect(expected.length).toBeGreaterThanOrEqual(7);
    const r = await createCampaignFromPlan(fx.merchantId, input);
    expect(r.created).toBe(true);
    expect(r.slotsCreated).toBe(expected.length);
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id: r.campaignId } });
    expect(c.status).toBe('ACTIVE');
    expect(c.afterEndPolicy).toBe('REJECT');
    expect(c.thanksMessage).toContain('{후원자}');
    expect(c.resultReportDueOn?.toISOString().slice(0, 10)).toBe(plusDays(60));
    const slots = await prisma.contentSlot.findMany({ where: { campaignId: r.campaignId } });
    expect(slots.every((s) => s.status === 'PLANNED' && s.itemId === null)).toBe(true);
    // 콘텐츠는 아직 하나도 만들지 않는다(승인 대기 콘텐츠는 배치가 만든다)
    expect(await prisma.contentItem.count()).toBe(0);

    const again = await createCampaignFromPlan(fx.merchantId, input);
    expect(again).toMatchObject({ campaignId: r.campaignId, created: false, slotsCreated: 0 });
    expect(await prisma.campaign.count()).toBe(1);
    expect(await prisma.contentSlot.count()).toBe(expected.length);
  });

  it('[2] 원자성 — 같은 키워드로 동시에 두 번 만들면 하나만 생기고, 실패한 쪽 슬롯은 하나도 남지 않는다', async () => {
    const a = planInput({ code: 'KIMJANG' });
    const b = planInput({ code: 'kim-jang', content: { weeklyCount: 7, postHour: 9 } });
    const rs = await Promise.allSettled([createCampaignFromPlan(fx.merchantId, a), createCampaignFromPlan(fx.merchantId, b)]);
    const ok = rs.filter((r) => r.status === 'fulfilled');
    const bad = rs.filter((r) => r.status === 'rejected');
    expect(ok.length).toBe(1);
    expect(bad.length).toBe(1);
    expect((bad[0] as PromiseRejectedResult).reason).toBeInstanceOf(CampaignCodeTakenError);
    const winner = (ok[0] as PromiseFulfilledResult<{ campaignId: string; slotsCreated: number }>).value;
    expect(await prisma.campaign.count()).toBe(1);
    // 진 쪽 슬롯이 남지 않는다(캠페인 없는 슬롯 0, 전체 = 이긴 쪽)
    expect(await prisma.contentSlot.count({ where: { campaignId: { not: winner.campaignId } } })).toBe(0);
    expect(await prisma.contentSlot.count()).toBe(winner.slotsCreated);
  });

  it('[3] 같은 제출 키 동시 두 번 = 캠페인 1개', async () => {
    const input = planInput();
    const rs = await Promise.allSettled([createCampaignFromPlan(fx.merchantId, input), createCampaignFromPlan(fx.merchantId, input)]);
    expect(rs.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.campaign.count()).toBe(1);
  });

  it('[4] 예약어·중복 키워드·감사 문구 규칙·결과 보고 예정일 검사, 체크로 뺀 항목은 만들지 않는다', async () => {
    const form = { setupKey: setupKey(), code: '정기', title: 't', summary: '', usagePlan: '', imageUrl: '', goalAmount: '100000', startsOn: plusDays(0), endsOn: plusDays(10), startNow: false, featured: false, afterEndPolicy: 'GENERAL', includeContent: false, weeklyCount: '2', postHour: '19', includeThanks: false, thanksMessage: '', includeReport: true, resultReportDueOn: '' };
    expect(campaignPlanFromForm(form).ok).toBe(false);
    const okForm = campaignPlanFromForm({ ...form, code: '나눔' });
    expect(okForm.ok).toBe(true);
    if (!okForm.ok) return;
    // 결과 보고 예정일을 비우면 종료일 + 30일
    expect(okForm.input.resultReportDueOn).toBe(new Date(Date.parse(`${plusDays(10)}T00:00:00Z`) + 30 * DAY).toISOString().slice(0, 10));
    expect(okForm.input.content).toBeNull();
    const r = await createCampaignFromPlan(fx.merchantId, okForm.input);
    expect(await prisma.contentSlot.count({ where: { campaignId: r.campaignId } })).toBe(0);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: r.campaignId } })).status).toBe('DRAFT');
    // 같은 키워드(정규화) 다시
    const dup = campaignPlanFromForm({ ...form, setupKey: setupKey(), code: '나 눔' });
    expect(dup.ok).toBe(true);
    if (dup.ok) {
      const p = await previewCampaignPlan(fx.merchantId, dup.input);
      expect(p.keyword.ok).toBe(false);
      await expect(createCampaignFromPlan(fx.merchantId, dup.input)).rejects.toBeInstanceOf(CampaignCodeTakenError);
    }
    await expect(createCampaignFromPlan(fx.merchantId, planInput({ code: '감사', thanksMessage: '감사합니다' }))).rejects.toBeInstanceOf(CampaignSetupError);
    await expect(createCampaignFromPlan(fx.merchantId, planInput({ code: '보고', resultReportDueOn: plusDays(1) }))).rejects.toThrow('종료일 이후');
  });

  it('[5] 미리보기는 저장하지 않고, 이미 다른 콘텐츠가 있는 시각은 겹침으로 세서 빼고 만든다', async () => {
    const input = planInput({ code: '겹침' });
    const times = plannedSlotTimes(input.content!, input.campaign.startsOn, input.campaign.endsOn);
    await prisma.contentSlot.create({ data: { id: newId(), merchantId: fx.merchantId, slotAt: times[0]!, kind: 'SHORTFORM', status: 'REVIEW' } });
    const p = await previewCampaignPlan(fx.merchantId, input);
    expect(p.content?.taken).toBe(1);
    expect(p.content?.willCreate).toBe(times.length - 1);
    expect(await prisma.campaign.count()).toBe(0);
    const r = await createCampaignFromPlan(fx.merchantId, input);
    expect(r.slotsCreated).toBe(times.length - 1);
    expect(r.slotsSkipped).toBe(1);
  });

  it('[6] 배치가 7일 안의 PLANNED 슬롯만 콘텐츠로 만든다 — 검토 대기(자동 승인·게시 없음), 작성 중 캠페인은 기다림, 겹친 실행도 1건', async () => {
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { fundraisingRegNo: '2026-서울-0001' } });
    const r = await createCampaignFromPlan(fx.merchantId, planInput({ code: '콘텐츠' }));
    const within = await prisma.contentSlot.count({ where: { campaignId: r.campaignId, slotAt: { lte: new Date(Date.now() + 7 * DAY) } } });
    expect(within).toBeGreaterThan(0);
    const [a, b] = await Promise.all([generatePlannedSlots(), generatePlannedSlots()]);
    expect(a.created + b.created).toBe(within);
    const items = await prisma.contentItem.findMany({ where: { campaignId: r.campaignId } });
    expect(items.length).toBe(within);
    expect(items.every((i) => i.status === 'REVIEW' && !i.approvedAt)).toBe(true);
    expect(await prisma.contentPublish.count()).toBe(0);
    expect(await prisma.contentSlot.count({ where: { campaignId: r.campaignId, status: 'PLANNED' } })).toBe((await prisma.contentSlot.count({ where: { campaignId: r.campaignId } })) - within);

    const d = await createCampaignFromPlan(fx.merchantId, planInput({ code: '대기', startNow: false }));
    const res = await generatePlannedSlots();
    expect(res.created).toBe(0);
    expect(await prisma.contentItem.count({ where: { campaignId: d.campaignId } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('I1-2 종료 후 들어온 후원 처리 방침', () => {
  async function endedCampaign(policy: 'GENERAL' | 'REJECT') {
    const r = await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장', afterEndPolicy: policy, content: null, startsOn: plusDays(-10), endsOn: plusDays(-1) }));
    return r.campaignId;
  }

  it('[7] GENERAL(기본) — 끝난 캠페인 키워드 문자는 예전처럼 기관 일반 후원으로 결제된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await endedCampaign('GENERAL');
    expect(await endedCampaignRejecting(fx.merchantId, '김장 응원')).toBeNull();
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '김장 응원합니다' }), fx.merchantId);
    expect(PAID_STATUSES).toContain(paid.status);
    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: paid.chargeId! } });
    expect(charge.campaignId).toBeNull();
  });

  it('[8] REJECT — 결제 건을 만들지 않고 종료 안내 문자만 보낸다. 다른 캠페인으로 옮기지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const id = await endedCampaign('REJECT');
    // 모금 중인 다른 캠페인이 있어도 그쪽으로 옮기지 않는다
    await createCampaignFromPlan(fx.merchantId, planInput({ code: '나눔', content: null }));
    expect((await endedCampaignRejecting(fx.merchantId, '김장 응원'))?.id).toBe(id);
    const { handleMoInbound } = await import('@/server/services/charge-flow');
    const { mockMoAdapter } = await import('@/server/adapters/mo');
    const before = await prisma.charge.count();
    const r = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '김장 응원합니다' })));
    expect(r.chargeId ?? null).toBeNull();
    expect(await prisma.charge.count()).toBe(before);
    const mo = await prisma.moInboundMessage.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
    expect(mo.result).toBe('BLOCKED');
    expect(mo.resultDetail).toContain('CAMPAIGN_ENDED');
    expect(readMockOutbox(5).some((m) => m.template === 'CAMPAIGN_ENDED')).toBe(true);
    // 키워드 없는 문자는 그대로 일반 후원
    const plain = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '응원합니다' })));
    expect(plain.chargeId).toBeTruthy();
  });

  it('[9] 모금 중 캠페인 감사 문구가 그 캠페인 후원의 감사 문자로 나간다(없으면 기관 기본)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await createCampaignFromPlan(fx.merchantId, planInput({ code: '김장', content: null, thanksMessage: '{후원자}님 김장 후원 정말 고맙습니다' }));
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '김장 힘내세요' }), fx.merchantId);
    expect(PAID_STATUSES).toContain(paid.status);
    const success = readMockOutbox(10).find((m) => m.template === 'CHARGE_SUCCESS');
    expect(success?.text).toContain('김장 후원 정말 고맙습니다');
  });
});

// ---------------------------------------------------------------------------
describe('I1-3 변경 영향 미리보기', () => {
  async function campaignWithReviewSlots() {
    const input = planInput({ code: '영향', content: { weeklyCount: 7, postHour: 10 }, endsOn: plusDays(20), resultReportDueOn: plusDays(50) });
    const r = await createCampaignFromPlan(fx.merchantId, input);
    const slots = await prisma.contentSlot.findMany({ where: { campaignId: r.campaignId }, orderBy: { slotAt: 'asc' } });
    // 마지막 3개 슬롯에 콘텐츠: 2개는 검토 대기, 1개는 승인 + 예약 게시
    const tail = slots.slice(-3);
    for (const [i, s] of tail.entries()) {
      const itemId = newId();
      await prisma.contentItem.create({ data: { id: itemId, merchantId: fx.merchantId, campaignId: r.campaignId, kind: 'SHORTFORM', title: '콘텐츠', provider: 'mock', status: i < 2 ? 'REVIEW' : 'SCHEDULED', aiLabeled: true, regNoIncluded: true, createdBy: 'T' } });
      await prisma.contentSlot.update({ where: { id: s.id }, data: { itemId, status: i < 2 ? 'REVIEW' : 'SCHEDULED' } });
      if (i === 2) await prisma.contentPublish.create({ data: { id: newId(), itemId, platform: 'YOUTUBE', status: 'SCHEDULED', scheduledAt: s.slotAt } });
    }
    return { id: r.campaignId, slots };
  }

  it('[10] 기간 단축 — 미리보기 숫자(예약 N·승인 대기 M·보류 K)와 반영 결과가 같고, 보류 콘텐츠는 지우지 않고 예약만 취소한다', async () => {
    const { id, slots } = await campaignWithReviewSlots();
    const newEnd = plusDays(10);
    const cut = Date.parse(`${newEnd}T23:59:59.999+09:00`);
    const expectHold = slots.filter((s) => s.slotAt.getTime() > cut).length;
    const impact = await campaignChangeImpact(fx.merchantId, id, { endsOn: newEnd });
    expect(impact.content.upcoming).toBe(slots.length);
    expect(impact.content.review).toBe(2);
    expect(impact.content.hold).toBe(expectHold);
    expect(impact.content.holdReview).toBe(2);
    expect(impact.resultReport).toContain('→');
    expect(impact.after.resultReportDueOn).toBe(kstKey(Date.parse(`${plusDays(50)}T00:00:00Z`) - 10 * DAY - 9 * 3600_000 + 9 * 3600_000));
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    const { impact: applied } = await applyCampaignChange(fx.merchantId, id, { endsOn: newEnd }, c.updatedAt.toISOString());
    expect(applied.content.hold).toBe(expectHold);
    expect(await prisma.contentSlot.count({ where: { campaignId: id, status: 'HELD' } })).toBe(expectHold);
    expect(await prisma.contentItem.count({ where: { campaignId: id } })).toBe(3);
    expect(await prisma.contentPublish.count({ where: { status: 'SCHEDULED' } })).toBe(0);
    expect(await prisma.contentItem.count({ where: { campaignId: id, status: 'APPROVED' } })).toBe(1);
    // 보류 슬롯 콘텐츠는 승인돼도 자동 예약하지 않는다
    const held = await prisma.contentSlot.findFirstOrThrow({ where: { campaignId: id, status: 'HELD', itemId: { not: null } } });
    expect(await autoScheduleSlotItem(held.itemId!)).toEqual([]);
    expect((await prisma.contentSlot.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('HELD');
  });

  it('[11] 기간 연장 — 보류 해제 + 늘어난 기간 일정 추가, 화면이 본 판이 아니면 거절', async () => {
    const { id } = await campaignWithReviewSlots();
    let c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    await applyCampaignChange(fx.merchantId, id, { endsOn: plusDays(10) }, c.updatedAt.toISOString());
    const held = await prisma.contentSlot.count({ where: { campaignId: id, status: 'HELD' } });
    c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    await expect(applyCampaignChange(fx.merchantId, id, { endsOn: plusDays(30) }, new Date(0).toISOString())).rejects.toThrow('다시 확인');
    const impact = await campaignChangeImpact(fx.merchantId, id, { endsOn: plusDays(30) });
    expect(impact.content.restore).toBe(held);
    expect(impact.content.add).toBe(plannedSlotTimes({ weeklyCount: 7, postHour: 10 }, plusDays(21), plusDays(30)).length);
    const { added } = await applyCampaignChange(fx.merchantId, id, { endsOn: plusDays(30) }, c.updatedAt.toISOString());
    expect(added).toBe(impact.content.add);
    expect(await prisma.contentSlot.count({ where: { campaignId: id, status: 'HELD' } })).toBe(0);
    expect(await prisma.contentSlot.count({ where: { campaignId: id, status: 'REVIEW' } })).toBe(2);
  });

  it('[12] 종료 — 미래 미게시 슬롯 전부 보류, 결과 보고 예정일 유지, 목표 상향은 목표 달성 표시를 지운다', async () => {
    const { id, slots } = await campaignWithReviewSlots();
    const impact = await campaignChangeImpact(fx.merchantId, id, { close: true });
    expect(impact.content.hold).toBe(slots.length);
    expect(impact.keyword.join(' ')).toContain('기관 일반 후원');
    const c = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    await applyCampaignChange(fx.merchantId, id, { close: true }, c.updatedAt.toISOString());
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('CLOSED');
    expect(after.resultReportDueOn?.toISOString().slice(0, 10)).toBe(plusDays(50));
    expect(await prisma.contentSlot.count({ where: { campaignId: id, status: 'HELD' } })).toBe(slots.length);
    // 종료된 캠페인은 다시 종료할 수 없다
    await expect(applyCampaignChange(fx.merchantId, id, { close: true }, after.updatedAt.toISOString())).rejects.toThrow('모금 중인');

    const g = await createCampaignFromPlan(fx.merchantId, planInput({ code: '목표', content: null, goal: 100_000 }));
    await prisma.campaign.update({ where: { id: g.campaignId }, data: { goalReachedAt: new Date() } });
    const gi = await campaignChangeImpact(fx.merchantId, g.campaignId, { goalAmount: 500_000 });
    expect(gi.goalReset).toBe(true);
    const gc = await prisma.campaign.findUniqueOrThrow({ where: { id: g.campaignId } });
    await applyCampaignChange(fx.merchantId, g.campaignId, { goalAmount: 500_000 }, gc.updatedAt.toISOString());
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: g.campaignId } })).goalReachedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('I1-4·5 목표 달성 · 진행 속도 · 결과 보고', () => {
  it('[13] 70% 규칙 — 경계값, 캠페인당 1회 알림, 주간 보고 제안', async () => {
    expect(paceBehind({ raised: 0n, goal: 100n, elapsed: 0.69 })).toBe(false);
    expect(paceBehind({ raised: 41n, goal: 100n, elapsed: 0.7 })).toBe(true);
    expect(paceBehind({ raised: 42n, goal: 100n, elapsed: 0.7 })).toBe(false);
    expect(elapsedRatio(dcol(plusDays(-6)), dcol(plusDays(3)))).toBeCloseTo(0.7, 5);

    const slow = await createCampaignFromPlan(fx.merchantId, planInput({ code: '느림', content: null, startsOn: plusDays(-8), endsOn: plusDays(1) }));
    const fast = await createCampaignFromPlan(fx.merchantId, planInput({ code: '빠름', content: null, startsOn: plusDays(-8), endsOn: plusDays(1), goal: 10_000 }));
    // 빠른 캠페인은 목표를 넘긴 결제 1건
    await prisma.charge.create({ data: { id: newId(), transactionNo: `TRD-${newId()}`, merchantId: fx.merchantId, amount: 20_000n, displayName: 'a', message: '', status: 'PAYMENT_SUCCESS', paidAt: new Date(), campaignId: fast.campaignId } });
    const [r1, r2] = await Promise.all([runCampaignPaceCheck(), runCampaignPaceCheck()]);
    expect(r1.alerted + r2.alerted).toBe(1);
    expect((await runCampaignPaceCheck()).alerted).toBe(0);
    expect(await prisma.notification.count({ where: { title: '캠페인 진행 속도 점검' } })).toBe(1);
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: slow.campaignId } })).paceAlertAt).not.toBeNull();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: fast.campaignId } })).paceAlertAt).toBeNull();
    const sug = await campaignPaceSuggestions(fx.merchantId);
    expect(sug.map((s) => s.key)).toEqual([`campaign:pace:${slow.campaignId}`]);
  });

  it('[14] 목표 달성 → 승인 요청 1건(자동 발송 없음), 승인 → 결과 보고 초안(DRAFT) 1건', async () => {
    const r = await createCampaignFromPlan(fx.merchantId, planInput({ code: '달성', content: null }));
    await prisma.campaign.update({ where: { id: r.campaignId }, data: { goalReachedAt: new Date() } });
    const ev = { id: newId(), merchantId: fx.merchantId, type: 'campaign.goal_reached', subjectType: 'campaign', subjectId: r.campaignId, payerId: null, payload: {} } as never;
    await handleCampaignGoalFollowup(ev);
    await handleCampaignGoalFollowup(ev);
    const reqs = await prisma.approvalRequest.findMany({ where: { kind: 'CAMPAIGN_GOAL_FOLLOWUP' } });
    expect(reqs.length).toBe(1);
    const outboxBefore = readMockOutbox(50).length;
    const d = await decideApproval({ merchantId: fx.merchantId, id: reqs[0]!.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(d.ok).toBe(true);
    const drafts = await prisma.impactUpdate.findMany({ where: { campaignId: r.campaignId } });
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.status).toBe('DRAFT');
    // 다시 불러도 같은 초안
    await approveGoalFollowup({ ...reqs[0]!, payload: reqs[0]!.payload as Record<string, unknown> } as never);
    expect(await prisma.impactUpdate.count({ where: { campaignId: r.campaignId } })).toBe(1);
    expect(readMockOutbox(50).length).toBe(outboxBefore);
  });

  it('[15] 결과 보고 예정일이 된 끝난 캠페인 → 승인 대기함 묶음, 결과 보고 승인 뒤 빠짐', async () => {
    const r = await createCampaignFromPlan(fx.merchantId, planInput({ code: '보고', content: null, startsOn: plusDays(-20), endsOn: plusDays(-5), resultReportDueOn: plusDays(-1) }));
    const live = await createCampaignFromPlan(fx.merchantId, planInput({ code: '진행', content: null, resultReportDueOn: plusDays(40) }));
    void live;
    const g = await resultReportInboxGroup(fx.merchantId);
    expect(g?.affectedCount).toBe(1);
    expect(g?.severity).toBe('high');
    expect(g?.href).toBe('/studio/impact');
    await prisma.impactUpdate.create({ data: { id: newId(), merchantId: fx.merchantId, campaignId: r.campaignId, title: '결과', body: '내용', status: 'APPROVED', createdBy: 'T' } });
    expect(await resultReportInboxGroup(fx.merchantId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('I2 기관 도입 자동', () => {
  it('[16] 체크리스트는 원천에서 계산 — 캠페인을 만들면 완료, 건너뛰기·숨기기만 저장', async () => {
    let list = await onboardingChecklist(fx.merchantId);
    expect(list.steps.find((s) => s.key === 'campaign')?.done).toBe(false);
    expect(list.showPrompt).toBe(true);
    await createCampaignFromPlan(fx.merchantId, planInput({ code: '첫캠페인', content: null }));
    await setOnboardingSkip(fx.merchantId, fx.merchantUserId, 'supporters', true);
    await expect(setOnboardingSkip(fx.merchantId, fx.merchantUserId, 'campaign', true)).rejects.toBeInstanceOf(OnboardingError);
    list = await onboardingChecklist(fx.merchantId);
    expect(list.steps.find((s) => s.key === 'campaign')?.done).toBe(true);
    expect(list.steps.find((s) => s.key === 'supporters')?.skipped).toBe(true);
    await dismissOnboarding(fx.merchantId, fx.merchantUserId);
    expect((await onboardingChecklist(fx.merchantId)).showPrompt).toBe(false);
  });

  it('[17] 시험 후원·시험 문서는 집계·정산·영수증·후원 내역 숫자를 바꾸지 않는다(샌드박스) — 1분 안 재실행은 재사용', async () => {
    const before = {
      summary: await merchantDonationSummary(fx.merchantId),
      charges: await prisma.charge.count(),
      ledger: await prisma.settlementLedger.count(),
      receipts: await receiptCandidates(fx.merchantId, Number(kstKey(Date.now()).slice(0, 4))),
      mt: await prisma.mtOutboundMessage.count(),
      outbox: readMockOutbox(50).length,
    };
    await expect(runOnboardingTest({ merchantId: fx.merchantId, userId: fx.merchantUserId, phone: '0212345678' })).rejects.toBeInstanceOf(OnboardingError);
    const r = await runOnboardingTest({ merchantId: fx.merchantId, userId: fx.merchantUserId, phone: '010-9999-8888', staffName: '김담당' });
    expect(r.reused).toBe(false);
    expect(r.run.moOk).toBe(true);
    expect(r.run.paymentOk).toBe(true);
    expect(r.run.phoneMasked).toBe(maskPhone('01099998888'));
    expect(r.run.transactionNo?.startsWith('TEST')).toBe(true);
    expect(await prisma.sandboxCharge.count({ where: { merchantId: fx.merchantId, status: 'PAYMENT_SUCCESS' } })).toBe(1);
    const after = {
      summary: await merchantDonationSummary(fx.merchantId),
      charges: await prisma.charge.count(),
      ledger: await prisma.settlementLedger.count(),
      receipts: await receiptCandidates(fx.merchantId, Number(kstKey(Date.now()).slice(0, 4))),
      mt: await prisma.mtOutboundMessage.count(),
      outbox: readMockOutbox(50).length,
    };
    expect(after).toEqual(before);
    expect(await prisma.eDocLedger.count()).toBe(0);
    expect(await prisma.issuedDocument.count()).toBe(0);
    const again = await runOnboardingTest({ merchantId: fx.merchantId, userId: fx.merchantUserId, phone: '01099998888' });
    expect(again.reused).toBe(true);
    expect(await prisma.onboardingTestRun.count()).toBe(1);
    const list = await onboardingChecklist(fx.merchantId);
    expect(list.steps.find((s) => s.key === 'testDonation')?.done).toBe(true);
    // 시험은 작동 확인으로 치지 않는다
    const checks = await operationChecks(fx.merchantId);
    expect(checks.find((c) => c.key === 'PAYMENT')?.verifiedAt).toBeNull();
  });

  it('[18] 서류 읽기 — 후보 추출·주민번호 가림, mock 이면 저장 없이 거절, 실연동 결과는 비공개 저장소 + 가린 후보', async () => {
    expect(maskResidentNumbers('대표 900101-1234567 / 8501012345678')).toBe('대표 900101-1****** / 850101-2******');
    const lines = [
      { text: '고유번호증', confidence: 0.99 },
      { text: '고유번호 : 123-82-00001', confidence: 0.97 },
      { text: '단체명 : 사회복지법인 햇살나눔', confidence: 0.95 },
      { text: '대표자 : 홍길동 생년월일 900101-1234567', confidence: 0.9 },
      { text: '소재지 : 서울특별시 중구 세종대로 1', confidence: 0.88 },
    ];
    const c = parseOrgDocument(lines);
    expect(c.businessNo?.value).toBe('123-82-00001');
    expect(c.name?.value).toBe('사회복지법인 햇살나눔');
    expect(c.representative?.value).toBe('홍길동');
    expect(c.address?.value).toBe('서울특별시 중구 세종대로 1');
    expect(parseOcrJson('```json\n{"lines":[{"text":"a","page":1,"x":2,"confidence":0.5}]}\n```')?.[0]?.box.x).toBe(1);

    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    await expect(scanOrgDocument({ merchantId: fx.merchantId, userId: fx.merchantUserId, buffer: png, mime: 'image/png', adapter: mockOcrAdapter })).rejects.toThrow('연결한 뒤');
    expect(await prisma.orgDocScan.count()).toBe(0);

    const fake: OcrAdapter = {
      info: () => ({ provider: 'anthropic', mode: 'live', missingCredentials: [], model: 'test' }),
      recognize: async () => ({ lines: lines.map((l) => ({ text: l.text, confidence: l.confidence, box: { page: 1, x: 0, y: 0, w: 0, h: 0 } })), usage: { inputTokens: 0, outputTokens: 0 } }),
    };
    await expect(scanOrgDocument({ merchantId: fx.merchantId, userId: fx.merchantUserId, buffer: Buffer.from('not an image'), mime: 'image/png', adapter: fake })).rejects.toBeInstanceOf(OnboardingError);
    const r = await scanOrgDocument({ merchantId: fx.merchantId, userId: fx.merchantUserId, buffer: png, mime: 'image/png', adapter: fake });
    expect(r.found).toBe(true);
    const row = await prisma.orgDocScan.findUniqueOrThrow({ where: { id: r.scanId } });
    expect(JSON.stringify(row.candidates)).not.toContain('1234567');
    expect(await getPrivateObject(row.objectName)).not.toBeNull();
    const cands = await scanCandidates(fx.merchantId, r.scanId);
    expect(cands?.representative?.value).toBe('홍길동');
    // 다른 기관은 못 읽는다
    expect(await scanCandidates('other', r.scanId)).toBeNull();
    // 저장은 담당자 몫 — 기관 정보는 그대로
    expect((await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId } })).businessNo).toBeNull();
    await deletePrivateObject(row.objectName);
  });

  it('[19] 명단 가져오기 — 이름+뒷자리가 같은 다른 번호는 중복 후보, 체크한 줄만 등록, 발송 없음', async () => {
    await prisma.supporterContact.create({ data: { id: newId(), merchantId: fx.merchantId, name: '홍길동', phoneHash: phoneHash('01011112222'), phoneEnc: encrypt('01011112222'), phoneMasked: maskPhone('01011112222'), role: 'DONOR', tags: [] } });
    const csv = '이름,휴대폰\n홍길동,010-3333-2222\n김철수,010-4444-5555\n홍길동,010-1111-2222\n';
    const p = await previewSupporterImport(fx.merchantId, csv);
    expect(p.rows.find((r) => r.line === 2)?.status).toBe('CANDIDATE');
    expect(p.rows.find((r) => r.line === 2)?.candidateOf).toContain('010-****-2222');
    expect(p.rows.find((r) => r.line === 4)?.status).toBe('DUPLICATE');
    expect(p.candidateCount).toBe(1);
    const base = { merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'a.csv', csv, consentConfirmed: true, consentBasis: '2025 후원의 밤 신청서' };
    const skip = await commitSupporterImport({ ...base, candidateLines: [] });
    expect(skip).toMatchObject({ accepted: 1, candidatesSkipped: 1, sameNumber: 1 });
    expect(await prisma.supporterContact.count({ where: { merchantId: fx.merchantId } })).toBe(2);
    const add = await commitSupporterImport({ ...base, candidateLines: [2] });
    expect(add).toMatchObject({ accepted: 1, candidatesAdded: 1 });
    expect(await prisma.supporterContact.count({ where: { merchantId: fx.merchantId } })).toBe(3);
    expect(readMockOutbox(50).length).toBe(0);
    expect(await prisma.mtOutboundMessage.count()).toBe(0);
  });

  it('[20] 명단 가져오기 — 후보 줄 지정이 없으면 예전 동작(같은 번호만 건너뜀)', async () => {
    await prisma.supporterContact.create({ data: { id: newId(), merchantId: fx.merchantId, name: '홍길동', phoneHash: phoneHash('01011112222'), phoneEnc: encrypt('01011112222'), phoneMasked: maskPhone('01011112222'), role: 'DONOR', tags: [] } });
    const r = await commitSupporterImport({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'a.csv', csv: '홍길동,01033332222\n', consentConfirmed: true, consentBasis: '근거 문서' });
    expect(r.accepted).toBe(1);
    expect(r.duplicates).toBe(0);
  });

  it('[21] 작동 점검 — 설정됨과 작동 확인됨을 나눈다(실제 문자 회신 기록·mock 결제는 mock 표시)', async () => {
    let checks = await operationChecks(fx.merchantId);
    expect(checks.find((c) => c.key === 'MO_REPLY')?.verifiedAt).toBeNull();
    await prisma.funnelStep.create({ data: { id: newId(), flowKey: 'mo:x', step: 'REPLY_SENT', merchantId: fx.merchantId, channel: 'MO' } });
    await seedRegisteredPayer(fx.payerPhone);
    const paid = await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '응원' }), fx.merchantId);
    expect(PAID_STATUSES).toContain(paid.status);
    checks = await operationChecks(fx.merchantId);
    expect(checks.find((c) => c.key === 'MO_REPLY')?.verifiedAt).not.toBeNull();
    const pay = checks.find((c) => c.key === 'PAYMENT')!;
    expect(pay.verifiedAt).not.toBeNull();
    expect(pay.mock).toBe(true);
    const r = await readinessWithChecks(fx.merchantId);
    const mo = r.items.find((i) => i.key === 'mo')!;
    expect(mo.ok).toBe(true);
    // mock 결제라 "작동 확인됨" 은 아니다
    expect(mo.verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('I2-6 자가 진단', () => {
  it('[22] SNS 만료 7일 전 안내 — 실연동만, 같은 만료 시각 1회', async () => {
    const soon = new Date(Date.now() + 5 * DAY);
    await prisma.socialChannel.create({ data: { id: newId(), merchantId: fx.merchantId, platform: 'INSTAGRAM', accountName: 'acc', status: 'CONNECTED', mock: false, expiresAt: soon, connectedBy: 'u' } });
    await prisma.socialChannel.create({ data: { id: newId(), merchantId: fx.merchantId, platform: 'YOUTUBE', accountName: 'mock', status: 'CONNECTED', mock: true, expiresAt: soon, connectedBy: 'u' } });
    await prisma.socialChannel.create({ data: { id: newId(), merchantId: fx.merchantId, platform: 'TIKTOK', accountName: 'far', status: 'CONNECTED', mock: false, expiresAt: new Date(Date.now() + 30 * DAY), connectedBy: 'u' } });
    const [a, b] = await Promise.all([checkSocialExpiry(), checkSocialExpiry()]);
    expect(a + b).toBe(1);
    expect(await checkSocialExpiry()).toBe(0);
    expect(await prisma.notification.count({ where: { title: { contains: '만료됩니다' } } })).toBe(1);
  });

  it('[23] 전자문서 잔액 소진 예상 — 지난 30일 사용량 기준 7일 안이면 1회', async () => {
    expect(edocRunwayDays(10, 0)).toBeNull();
    expect(edocRunwayDays(6, 30)).toBe(6);
    expect(edocRunwayDays(7, 30)).toBe(7);
    const { ensureWallet } = await import('@/server/services/edoc-billing');
    await ensureWallet(fx.merchantId);
    await prisma.eDocWallet.update({ where: { merchantId: fx.merchantId }, data: { trialRemaining: 2, balance: 0 } });
    for (let i = 0; i < 30; i++) {
      await prisma.eDocLedger.create({ data: { id: newId(), merchantId: fx.merchantId, kind: 'USE', units: -1, source: 'TRIAL', balanceAfter: 0, trialAfter: 2, idempotencyKey: `use:t${i}`, createdAt: new Date(Date.now() - i * DAY / 2) } });
    }
    expect(await checkEdocRunway()).toBe(1);
    expect(await checkEdocRunway()).toBe(0);
    expect(await prisma.notification.count({ where: { title: '전자문서 이용 잔액이 곧 바닥납니다' } })).toBe(1);
  });

  it('[24] MO 수신 급감 — 평균 20건 이상이고 30% 미만일 때만, 기관·관리자 1회', async () => {
    expect(moDropped(5, [25, 25, 25, 25]).dropped).toBe(true);
    expect(moDropped(8, [25, 25, 25, 25]).dropped).toBe(false);
    expect(moDropped(0, [19, 19, 19, 19]).dropped).toBe(false);
    const admin = await prisma.user.create({ data: { id: newId(), email: `adm-${newId()}@t.kr`, name: '관리자', role: 'ADMIN' } });
    await prisma.adminProfile.create({ data: { id: newId(), userId: admin.id, permission: 'SUPER_ADMIN' } });
    const yKey = kstKey(Date.now() - DAY);
    const at = (key: string, i: number) => new Date(Date.parse(`${key}T10:00:00+09:00`) + i * 1000);
    let n = 0;
    const mk = async (key: string, count: number) => {
      for (let i = 0; i < count; i++) {
        n += 1;
        await prisma.moInboundMessage.create({ data: { id: newId(), providerMessageId: `drop-${n}`, providerCode: 'mock', receivedNumber: fx.moNumber, phoneHash: phoneHash('01012345678'), phoneEnc: encrypt('01012345678'), phoneMasked: '010-****-5678', contentEnc: encrypt('x'), merchantId: fx.merchantId, receivedAt: at(key, i) } });
      }
    };
    for (const w of [7, 14, 21, 28]) await mk(new Date(Date.parse(`${yKey}T00:00:00Z`) - w * DAY).toISOString().slice(0, 10), 22);
    await mk(yKey, 3);
    expect(await checkMoDrop()).toBe(1);
    expect(await checkMoDrop()).toBe(0);
    expect(await prisma.notification.count({ where: { title: '문자 후원 수신이 크게 줄었습니다' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: admin.id } })).toBe(1);
  });
});
