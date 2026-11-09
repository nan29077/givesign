import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, phoneHash, maskPhone } from '@/lib/crypto';
import { campaignSchema } from '@/lib/fundraising';
import { goalOutlook, kstWeekStartKey, seasonalHints, dateColumn } from '@/lib/weekly-plan';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import { approveContent, connectSocialChannel, getContentSetting, requestContent, saveContentSetting } from '@/server/services/content';
import { rejectContent } from '@/server/services/content-review';
import { decideApproval, runQueuedApprovals } from '@/server/services/approvals';
import { goalProgress, saveGoal, GoalError } from '@/server/services/goals';
import {
  evaluationLines,
  generateWeeklyPlan,
  numbersPreserved,
  polishWeeklyText,
  runWeeklyPlanJob,
  setWeeklyReportEnabled,
  weeklyMetrics,
  weeklyApprovalKey,
  type StoredSuggestion,
} from '@/server/services/weekly-plan';
import { contentOutcomes, firstLineBucket, winHintsFrom, type ContentOutcome } from '@/server/services/content-performance';
import { createVariantB, variantCaptionB } from '@/server/services/content-variants';
import {
  assetUsability,
  attachAssetToContent,
  linkPortraitConsent,
  sniffAsset,
  uploadContentAsset,
} from '@/server/services/content-assets';
import { ALIMTALK_TEMPLATES } from '@/server/services/alimtalk';
import { isStaffInfoTemplate, kindOfTemplate } from '@/server/services/outbound/classify';
import { DOCUMENT_PURPOSES, MANUAL_ONLY_PURPOSES } from '@/server/services/purpose-documents';
import { ensureDefaultPurposeTemplates, purposeNeedsSignature } from '@/server/services/purpose-templates';
import { CRON_JOBS } from '@/server/cron-registry';
import { buildScriptPrompt } from '@/server/adapters/content/llm-script';
import type { ContentBrief } from '@/server/adapters/content';
import { resetDb, seedBasics, type Fixture } from './helpers';

/**
 * 2026-11-11 G — 주간 운영 계획·보고 + 콘텐츠 성과 폐루프.
 *  주간 계획 1회(동시 배치) · 수치가 원천과 일치 · 계획 승인이 게시·발송을 만들지 않음 · 보고 발송 1회·끄기 ·
 *  귀속 집계(미확인 비배정) · 2안 승인 규칙 · 동의서 없는 얼굴 소재 사용 거절.
 */

let fx: Fixture;

/** 2026-11-16(월) 09:30 KST */
const MONDAY_0930 = new Date('2026-11-16T00:30:00Z');
const MONDAY_0800 = new Date('2026-11-15T23:00:00Z');
const MONDAY_0600 = new Date('2026-11-15T21:00:00Z');
/** 지난주 수요일 12:00 KST */
const LAST_WED = new Date('2026-11-11T03:00:00Z');

async function seedCampaign(code = 'KIMJANG', goal = 3000000) {
  const c = await saveCampaign(fx.merchantId, campaignSchema.parse({
    code, title: `김장 나눔 ${code}`, summary: '홀몸 어르신 김장 나눔', story: '올겨울 300가구에 김장김치를 전합니다.',
    beneficiary: '홀몸 어르신 300가구', usagePlan: '김장 재료비', goalAmount: goal, startsOn: '2026-01-01', endsOn: '2099-12-31',
  }));
  await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
  return c;
}

async function withRegNo() {
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { fundraisingRegNo: '2026-서울-00999' } });
}

let phoneSeq = 0;
async function payer() {
  const phone = `0107${String(++phoneSeq).padStart(7, '0')}`;
  return prisma.payerProfile.create({ data: { id: newId(), phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), ageVerified: true, onboardingStatus: 'REGISTERED' } });
}

async function charge(input: { payerId: string; amount: bigint; paidAt: Date; status?: string; recurring?: boolean; isTest?: boolean; contentItemId?: string | null; campaignId?: string | null; recurringId?: string | null }) {
  return prisma.charge.create({
    data: {
      id: newId(), transactionNo: `TRD-${newId()}`, merchantId: fx.merchantId, payerId: input.payerId, amount: input.amount, displayName: '후원자', message: '',
      status: (input.status ?? 'PAYMENT_SUCCESS') as never, paymentMode: input.recurring ? 'RECURRING' : 'CONFIRM_LINK', paidAt: input.paidAt,
      isTest: input.isTest ?? false, contentItemId: input.contentItemId ?? null, campaignId: input.campaignId ?? null, recurringId: input.recurringId ?? null,
    },
  });
}

async function pledge(payerId: string, opts: { createdAt?: Date; status?: 'ACTIVE' | 'CANCELED' | 'SUSPENDED'; canceledAt?: Date; contentItemId?: string | null } = {}) {
  return prisma.recurringDonation.create({
    data: {
      id: newId(), merchantId: fx.merchantId, payerId, amount: 10000n, dayOfMonth: 10, status: opts.status ?? 'ACTIVE', nextChargeOn: new Date('2026-12-10'), cycleMonth: '2026-11',
      createdAt: opts.createdAt ?? new Date(), canceledAt: opts.canceledAt ?? null, contentItemId: opts.contentItemId ?? null,
    },
  });
}

/** 게시된 콘텐츠 한 건(직접 행으로) */
async function publishedItem(input: { publishedAt: Date; clicks: number; kind?: 'IMAGE_FEED' | 'CARD_NEWS'; caption?: string; campaignId?: string | null }) {
  const item = await prisma.contentItem.create({
    data: {
      id: newId(), merchantId: fx.merchantId, campaignId: input.campaignId ?? null, kind: input.kind ?? 'IMAGE_FEED', status: 'PUBLISHED', title: '게시물',
      caption: input.caption ?? '짧은 제목\n소개\n후원하기: {링크}\nAI 생성 콘텐츠', provider: 'mock', createdBy: 'test', createdAt: new Date('2026-09-01T00:00:00Z'),
    },
  });
  await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'INSTAGRAM', status: 'PUBLISHED', scheduledAt: input.publishedAt, publishedAt: input.publishedAt, clicks: input.clicks } });
  return item;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('순수 함수', () => {
  it('주 시작(KST 월요일)·시기 캘린더·목표 판단', () => {
    expect(kstWeekStartKey(MONDAY_0930)).toBe('2026-11-16');
    expect(kstWeekStartKey(new Date('2026-11-15T14:59:00Z'))).toBe('2026-11-09'); // 일요일 23:59 KST
    expect(seasonalHints('2027-01-11').map((h) => h.key)).toContain('season:tax-2027');
    expect(seasonalHints('2026-09-14').map((h) => h.key)).toEqual(['season:chuseok-2026']);
    expect(seasonalHints('2026-08-31').map((h) => h.key)).toEqual(['season:welfare-day-2026']);
    expect(seasonalHints('2026-12-07').map((h) => h.key)).toContain('season:year-end-2026');
    expect(seasonalHints('2026-06-08')).toEqual([]);
    // DB 공휴일이 있으면 그 날짜를 쓴다
    expect(seasonalHints('2026-02-02', { holidays: [{ date: '2026-02-10', name: '설날' }] }).find((h) => h.key.startsWith('season:seollal'))?.title).toContain('2월 10일');
    expect(goalOutlook({ remaining: 10, weeklyPace: 1, weeksLeft: 5 })).toBe('AT_RISK');
    expect(goalOutlook({ remaining: 10, weeklyPace: 3, weeksLeft: 5 })).toBe('ON_TRACK');
    expect(goalOutlook({ remaining: 0, weeklyPace: 0, weeksLeft: 1 })).toBe('DONE');
    expect(goalOutlook({ remaining: 5, weeklyPace: 0, weeksLeft: null })).toBeNull();
  });

  it('AI 문장 검증 — 입력에 없는 숫자가 있으면 거절, mock 공급자는 규칙 문장', async () => {
    expect(numbersPreserved(['지난주 후원 12건 · 345,000원'], ['후원이 12건, 345,000원 들어왔어요'])).toBe(true);
    expect(numbersPreserved(['지난주 후원 12건'], ['후원이 13건 들어왔어요'])).toBe(false);
    const r = await polishWeeklyText(fx.merchantId, ['a'], []);
    expect(r).toEqual({ by: 'RULES', lines: null, suggestionTexts: null });
  });

  it('2안 캡션·소재 형식 판정·첫 문장 길이·잘된 것 최소 건수', () => {
    const cap = '제목\n한 줄 소개\n\n후원하기: {링크}\n\nAI 생성 콘텐츠';
    const b = variantCaptionB(cap);
    expect(b.startsWith('한 줄 소개\n제목')).toBe(true);
    expect(b).toContain('{링크}');
    expect(b).toContain('AI 생성 콘텐츠');
    expect(sniffAsset(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.kind).toBe('IMAGE');
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(8)]);
    expect(sniffAsset(mp4)).toMatchObject({ kind: 'VIDEO', ext: 'mp4' });
    expect(sniffAsset(Buffer.from('%PDF-1.7 hello world'))).toBeNull();
    expect(firstLineBucket('열 글자 제목입니다')).toBe('SHORT');
    expect(firstLineBucket('가'.repeat(45))).toBe('LONG');
    const o = (i: number): ContentOutcome => ({ itemId: String(i), title: 't', kind: i % 2 ? 'CARD_NEWS' : 'IMAGE_FEED', topic: 'CAMPAIGN', firstLine: 'SHORT', variantGroupId: null, variantLabel: null, publishes: 1, firstPublishedAt: null, weekday: i % 2 ? 5 : 1, hour: 19, clicks: i % 2 ? 50 : 5, donations: 0, amount: 0n, newPledges: 0, retainedPledges: 0, volunteers: 0 });
    expect(winHintsFrom(Array.from({ length: 9 }, (_, i) => o(i)))).toEqual([]);
    const hints = winHintsFrom(Array.from({ length: 10 }, (_, i) => o(i)));
    expect(hints.some((h) => h.includes('카드뉴스'))).toBe(true);
    expect(hints.some((h) => h.includes('금요일'))).toBe(true);
  });

  it('LLM 프롬프트에 "잘된 것" 이 들어간다(있을 때만)', () => {
    const brief = { merchantName: '해오름', campaignTitle: '김장', summary: 's', story: null, usagePlan: null, goalAmount: 1n, raisedAmount: 0n, daysLeft: 1, keyword: 'K', moNumber: null, tone: 'WARM', color: '#000', regNo: 'R', bannedWords: [], merchantIntro: null, merchantBusiness: null } as unknown as ContentBrief;
    expect(buildScriptPrompt(brief, 'IMAGE_FEED').user).not.toContain('[잘된 것');
    expect(buildScriptPrompt({ ...brief, wins: ['형식: 카드뉴스 게시물의 평균 클릭이 가장 높았음'] }, 'IMAGE_FEED').user).toContain('[잘된 것');
  });
});

// ---------------------------------------------------------------------------
describe('기관 목표', () => {
  it('진행률은 원천에서 계산 — 정기후원자(ACTIVE)·캠페인 모금액(charge 기준)·월 후원액', async () => {
    const c = await seedCampaign('GOALC', 100000);
    const [p1, p2, p3] = [await payer(), await payer(), await payer()];
    await pledge(p1.id);
    await pledge(p2.id);
    await pledge(p3.id, { status: 'CANCELED', canceledAt: new Date() });
    await charge({ payerId: p1.id, amount: 30000n, paidAt: new Date(), campaignId: c.id });
    await charge({ payerId: p2.id, amount: 99999n, paidAt: new Date(), campaignId: c.id, isTest: true });
    await charge({ payerId: p2.id, amount: 5000n, paidAt: new Date(), campaignId: c.id, status: 'REFUNDED' });
    await saveGoal(fx.merchantId, fx.merchantUserId, { kind: 'RECURRING_DONORS', target: '10', dueOn: '2099-12-31' });
    await saveGoal(fx.merchantId, fx.merchantUserId, { kind: 'CAMPAIGN_AMOUNT', campaignId: c.id });
    await saveGoal(fx.merchantId, fx.merchantUserId, { kind: 'MONTHLY_AMOUNT', target: '1000000' });
    const g = await goalProgress(fx.merchantId);
    expect(g.find((x) => x.kind === 'RECURRING_DONORS')).toMatchObject({ current: 2n, target: 10n, remaining: 8n });
    expect(g.find((x) => x.kind === 'CAMPAIGN_AMOUNT')).toMatchObject({ current: 30000n, target: 100000n });
    expect(g.find((x) => x.kind === 'MONTHLY_AMOUNT')!.current).toBe(30000n);
    expect(g.find((x) => x.kind === 'RECURRING_DONORS')!.sentence).toContain('목표까지 8명 남음');
    await expect(saveGoal(fx.merchantId, fx.merchantUserId, { kind: 'RECURRING_DONORS', target: '0', dueOn: '2099-01-01' })).rejects.toBeInstanceOf(GoalError);
    await expect(saveGoal(fx.merchantId, fx.merchantUserId, { kind: 'NOPE', target: '1' })).rejects.toBeInstanceOf(GoalError);
  });
});

// ---------------------------------------------------------------------------
describe('주간 계획', () => {
  it('수치가 원천과 일치한다(테스트·환불 결제 제외, 신규 후원자, 정기 신규·해지, 전주 비교)', async () => {
    const [old, fresh, fresh2] = [await payer(), await payer(), await payer()];
    await charge({ payerId: old.id, amount: 10000n, paidAt: new Date('2026-10-01T03:00:00Z') }); // 예전 후원자
    await charge({ payerId: old.id, amount: 20000n, paidAt: LAST_WED });
    await charge({ payerId: fresh.id, amount: 5000n, paidAt: LAST_WED });
    await charge({ payerId: fresh2.id, amount: 7000n, paidAt: LAST_WED, recurring: true });
    await charge({ payerId: fresh.id, amount: 99999n, paidAt: LAST_WED, isTest: true });
    await charge({ payerId: fresh.id, amount: 3000n, paidAt: LAST_WED, status: 'REFUNDED' });
    await charge({ payerId: old.id, amount: 1000n, paidAt: new Date('2026-11-04T03:00:00Z') }); // 전주
    await pledge(fresh.id, { createdAt: LAST_WED });
    await pledge(old.id, { createdAt: new Date('2026-09-01T00:00:00Z'), status: 'CANCELED', canceledAt: LAST_WED });

    const m = await weeklyMetrics(fx.merchantId, '2026-11-16', MONDAY_0930);
    // 원천 직접 집계와 같다
    const direct = await prisma.charge.aggregate({ where: { merchantId: fx.merchantId, isTest: false, status: { in: ['PAYMENT_SUCCESS'] }, paidAt: { gte: new Date('2026-11-08T15:00:00Z'), lt: new Date('2026-11-15T15:00:00Z') } }, _sum: { amount: true }, _count: { _all: true } });
    expect(m.donations.count).toBe(direct._count._all);
    expect(m.donations.amount).toBe(String(direct._sum.amount));
    expect(m.donations).toMatchObject({ count: 3, amount: '32000', oneOffCount: 2, recurringCount: 1, recurringAmount: '7000' });
    expect(m.previous).toEqual({ count: 1, amount: '1000' });
    expect(m.newDonors).toBe(2);
    expect(m.recurring).toMatchObject({ newPledges: 1, canceled: 1, suspended: 0 });
    expect(m.from).toBe('2026-11-09');
    expect(m.to).toBe('2026-11-15');
    const lines = evaluationLines(m);
    expect(lines[0]).toContain('지난주 후원 3건 · 32,000원 (전주보다 2건 많음)');
    // 계획에 저장된 수치도 같다. 후원자 이름·연락처가 저장 값에 없다.
    const { plan } = await generateWeeklyPlan(fx.merchantId, MONDAY_0930);
    const json = JSON.stringify(plan.evaluation) + JSON.stringify(plan.suggestions);
    expect(json).not.toContain('010');
    expect((plan.evaluation as { metrics: { donations: { count: number } } }).metrics.donations.count).toBe(3);
    expect(plan.generatedBy).toBe('RULES');
  });

  it('(기관, 주) 1건 — 동시 배치 4번에도 계획 1건, 승인 요청도 중복 없음', async () => {
    await withRegNo();
    await seedCampaign('ONCE');
    const rs = await Promise.all([1, 2, 3, 4].map(() => generateWeeklyPlan(fx.merchantId, MONDAY_0930)));
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    expect(await prisma.weeklyPlan.count()).toBe(1);
    const plan = await prisma.weeklyPlan.findFirstOrThrow();
    const approvals = await prisma.approvalRequest.findMany({ where: { subjectId: plan.id } });
    expect(new Set(approvals.map((a) => a.dedupeKey)).size).toBe(approvals.length);
    // 배치도 같은 주에 다시 만들지 않는다
    await Promise.all([runWeeklyPlanJob(MONDAY_0800), runWeeklyPlanJob(MONDAY_0800)]);
    expect(await prisma.weeklyPlan.count()).toBe(1);
  });

  it('월요일 07시 전에는 만들지 않고, 07~09시는 만들기만 하고 보고는 09시 이후', async () => {
    expect((await runWeeklyPlanJob(MONDAY_0600)).generated).toBe(0);
    expect(await prisma.weeklyPlan.count()).toBe(0);
    const r = await runWeeklyPlanJob(MONDAY_0800);
    expect(r).toMatchObject({ generated: 1, reports: 0 });
    expect((await prisma.weeklyPlan.findFirstOrThrow()).reportClaimedAt).toBeNull();
  });

  it('계획 승인은 게시·발송을 직접 만들지 않는다 — 슬롯 추가는 캘린더 설정만, 주제는 검토 대기 콘텐츠만', async () => {
    await withRegNo();
    const used = await seedCampaign('USED');
    const fresh = await seedCampaign('FRESH', 9000000);
    await connectSocialChannel(fx.merchantId, 'INSTAGRAM', '@welfare', fx.merchantUserId);
    await saveContentSetting(fx.merchantId, { tone: 'WARM', bannedWords: [], hashtags: [], calendar: { calendarEnabled: true, weeklyCount: 2, days: [1, 3], postHour: 19, kinds: ['IMAGE_FEED'], platforms: ['INSTAGRAM'], autoSchedule: true } });
    // 최근 90일 게시 12건: 금요일 19시 게시 클릭이 높다(캘린더 요일은 월·수)
    for (let i = 0; i < 6; i++) await publishedItem({ publishedAt: new Date(Date.UTC(2026, 9, 2 + i * 7, 10)), clicks: 80, campaignId: used.id }); // 금 19시 KST
    for (let i = 0; i < 6; i++) await publishedItem({ publishedAt: new Date(Date.UTC(2026, 9, 5 + i * 7, 10)), clicks: 3, campaignId: used.id }); // 월
    // USED 캠페인은 최근 2주 콘텐츠가 있다 — 주제 제안은 FRESH
    await prisma.contentItem.create({ data: { id: newId(), merchantId: fx.merchantId, campaignId: used.id, kind: 'IMAGE_FEED', status: 'ARCHIVED', title: 'x', provider: 'mock', createdBy: 't', createdAt: new Date('2026-11-12T00:00:00Z') } });

    const { plan } = await generateWeeklyPlan(fx.merchantId, MONDAY_0930);
    const sugg = plan.suggestions as unknown as StoredSuggestion[];
    const slot = sugg.find((s) => s.type === 'CONTENT_SLOT_ADD')!;
    const topic = sugg.find((s) => s.type === 'CONTENT_TOPIC')!;
    expect(slot.title).toContain('금요일 게시 클릭이 가장 높았음');
    expect(slot.params).toEqual({ day: 5 });
    expect(topic.params).toEqual({ campaignId: fresh.id });
    expect(sugg.some((s) => s.key === 'content:slots')).toBe(true);
    // INFO 제안은 승인 요청이 없다
    expect(await prisma.approvalRequest.count({ where: { subjectId: plan.id } })).toBe(2);

    const publishesBefore = await prisma.contentPublish.count();
    const mtBefore = await prisma.mtOutboundMessage.count();
    const slotReq = await prisma.approvalRequest.findUniqueOrThrow({ where: { dedupeKey: weeklyApprovalKey(plan.id, slot.key) } });
    const topicReq = await prisma.approvalRequest.findUniqueOrThrow({ where: { dedupeKey: weeklyApprovalKey(plan.id, topic.key) } });
    expect((await decideApproval({ merchantId: fx.merchantId, id: slotReq.id, decision: 'APPROVE', userId: fx.merchantUserId })).ok).toBe(true);
    expect((await getContentSetting(fx.merchantId)).days).toEqual([1, 3, 5]);
    expect((await getContentSetting(fx.merchantId)).weeklyCount).toBe(3);
    const t = await decideApproval({ merchantId: fx.merchantId, id: topicReq.id, decision: 'APPROVE', userId: fx.merchantUserId });
    expect(t.ok).toBe(true);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: topicReq.id } })).status).toBe('QUEUED');
    await runQueuedApprovals();
    await runQueuedApprovals(); // 다시 돌아도 콘텐츠는 1건
    const made = await prisma.contentItem.findMany({ where: { createdBy: `WEEKLY_PLAN:${topicReq.id}` } });
    expect(made).toHaveLength(1);
    expect(made[0]!.status).toBe('REVIEW');
    expect(made[0]!.approvedBy).toBeNull();
    // 게시·발송·대기열이 생기지 않았다
    expect(await prisma.contentPublish.count()).toBe(publishesBefore);
    expect(await prisma.mtOutboundMessage.count()).toBe(mtBefore);
    expect(await prisma.outboundQueue.count()).toBe(0);
  });

  it('월요일 보고는 동시 실행에도 1통, 수신을 끄면 보내지 않는다(콘솔 알림은 남김)', async () => {
    await prisma.user.update({ where: { id: fx.merchantUserId }, data: { phoneEnc: encrypt('01099998888') } });
    const p = await payer();
    await charge({ payerId: p.id, amount: 10000n, paidAt: LAST_WED });
    await Promise.all([runWeeklyPlanJob(MONDAY_0930), runWeeklyPlanJob(MONDAY_0930), runWeeklyPlanJob(MONDAY_0930)]);
    const msgs = await prisma.mtOutboundMessage.findMany({ where: { templateCode: 'WEEKLY_REPORT' } });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.bodyMasked).toContain('지난주 후원 1건');
    expect(msgs[0]!.bodyMasked).not.toContain('http');
    const plan = await prisma.weeklyPlan.findFirstOrThrow();
    expect(plan).toMatchObject({ status: 'SENT', reportChannel: 'SMS' });
    await runWeeklyPlanJob(new Date('2026-11-16T03:00:00Z'));
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'WEEKLY_REPORT' } })).toBe(1);
    // 21시 이후엔 보내지 않는다(다음 주 다른 기관 상황 재현은 아래)

    await resetDb();
    fx = await seedBasics();
    await prisma.user.update({ where: { id: fx.merchantUserId }, data: { phoneEnc: encrypt('01099998888') } });
    await setWeeklyReportEnabled(fx.merchantId, false);
    await runWeeklyPlanJob(MONDAY_0930);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'WEEKLY_REPORT' } })).toBe(0);
    expect(await prisma.weeklyPlan.findFirstOrThrow()).toMatchObject({ reportChannel: 'NONE', status: 'DRAFT' });
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId, title: { contains: '운영 보고' } } })).toBe(1);
  });

  it('밤 21시 이후에는 보고를 보내지 않는다(다음 날 09시 이후 실행이 보낸다)', async () => {
    await prisma.user.update({ where: { id: fx.merchantUserId }, data: { phoneEnc: encrypt('01099998888') } });
    await runWeeklyPlanJob(new Date('2026-11-16T12:30:00Z')); // 월 21:30 KST
    expect(await prisma.weeklyPlan.count()).toBe(1);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'WEEKLY_REPORT' } })).toBe(0);
    await runWeeklyPlanJob(new Date('2026-11-17T00:10:00Z')); // 화 09:10 KST
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'WEEKLY_REPORT' } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('콘텐츠 성과 귀속', () => {
  it('클릭·후원·신규/유지 약정은 콘텐츠별로, 출처 미확인 후원은 배정하지 않는다', async () => {
    const now = new Date('2026-11-16T00:00:00Z');
    const item = await publishedItem({ publishedAt: new Date('2026-11-01T10:00:00Z'), clicks: 30 });
    const [a, b, c] = [await payer(), await payer(), await payer()];
    await charge({ payerId: a.id, amount: 10000n, paidAt: new Date('2026-11-02T00:00:00Z'), contentItemId: item.id });
    await charge({ payerId: b.id, amount: 20000n, paidAt: new Date('2026-11-03T00:00:00Z'), contentItemId: item.id });
    await charge({ payerId: b.id, amount: 99999n, paidAt: new Date('2026-11-03T00:00:00Z'), contentItemId: item.id, isTest: true });
    await charge({ payerId: b.id, amount: 5000n, paidAt: new Date('2026-11-03T00:00:00Z'), contentItemId: item.id, status: 'REFUNDED' });
    await charge({ payerId: c.id, amount: 7000n, paidAt: new Date('2026-11-04T00:00:00Z') }); // 출처 미확인
    // 유지 약정: 100일 전 + ACTIVE + 성공 출금 2회 / 성공 1회 / 해지
    const old = new Date(now.getTime() - 100 * 86_400_000);
    const keep = await pledge(a.id, { createdAt: old, contentItemId: item.id });
    const weak = await pledge(b.id, { createdAt: old, contentItemId: item.id });
    await pledge(c.id, { createdAt: old, contentItemId: item.id, status: 'CANCELED', canceledAt: new Date() });
    for (const [r, n] of [[keep, 2], [weak, 1]] as const) {
      for (let i = 0; i < n; i++) await prisma.recurringRun.create({ data: { id: newId(), recurringId: r.id, monthKey: `2026-0${8 + i}`, status: 'SUCCESS' } });
    }
    const rep = await contentOutcomes(fx.merchantId, { now });
    expect(rep.items).toHaveLength(1);
    expect(rep.items[0]).toMatchObject({ clicks: 30, donations: 2, amount: 30000n, newPledges: 3, retainedPledges: 1 });
    expect(rep.unattributed).toEqual({ donations: 1, amount: 7000n });
    expect(rep.attributed).toEqual({ donations: 2, amount: 30000n });
  });
});

// ---------------------------------------------------------------------------
describe('2안 비교(A/B)', () => {
  async function abSetup() {
    await withRegNo();
    const c = await seedCampaign(`AB${newId().slice(-4)}`);
    await connectSocialChannel(fx.merchantId, 'INSTAGRAM', '@welfare', fx.merchantUserId);
    await connectSocialChannel(fx.merchantId, 'FACEBOOK', 'welfare', fx.merchantUserId);
    await saveContentSetting(fx.merchantId, { tone: 'WARM', bannedWords: [], hashtags: [], calendar: { calendarEnabled: true, weeklyCount: 3, days: [1, 3, 5], postHour: 19, kinds: ['IMAGE_FEED'], platforms: ['INSTAGRAM', 'FACEBOOK'], autoSchedule: true, abTestEnabled: true } });
    const a = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_FEED', userId: 'CALENDAR' });
    const slotAt = new Date(Date.now() + 3 * 86_400_000);
    await prisma.contentSlot.create({ data: { id: newId(), merchantId: fx.merchantId, slotAt, kind: 'IMAGE_FEED', itemId: a.id, campaignId: c.id, status: 'REVIEW' } });
    const made = await Promise.all([createVariantB(a.id), createVariantB(a.id), createVariantB(a.id)]);
    const bs = made.filter(Boolean);
    expect(bs).toHaveLength(1);
    return { a: await prisma.contentItem.findUniqueOrThrow({ where: { id: a.id } }), b: bs[0]!, slotAt };
  }

  it('B안은 한 번만, 장면은 같고 캡션만 다르며 검토 대기 — 꺼져 있으면 만들지 않는다', async () => {
    const { a, b } = await abSetup();
    expect(a).toMatchObject({ variantGroupId: a.id, variantLabel: 'A' });
    expect(b).toMatchObject({ variantGroupId: a.id, variantLabel: 'B', status: 'REVIEW', approvedBy: null, costKrw: 0 });
    expect(b.caption).not.toBe(a.caption);
    expect(JSON.stringify(b.scenes)).toBe(JSON.stringify(a.scenes));
    await saveContentSetting(fx.merchantId, { tone: 'WARM', bannedWords: [], hashtags: [], calendar: { calendarEnabled: true, weeklyCount: 3, days: [1, 3, 5], postHour: 19, kinds: ['IMAGE_FEED'], platforms: ['INSTAGRAM'], autoSchedule: true, abTestEnabled: false } });
    const c2 = await seedCampaign('NOAB');
    const solo = await requestContent({ merchantId: fx.merchantId, campaignId: c2.id, kind: 'IMAGE_FEED', userId: 'CALENDAR' });
    expect(await createVariantB(solo.id)).toBeNull();
  });

  it('승인 전에는 어느 안도 게시 예약되지 않는다 · 한 안만 승인(다른 안 대기)이면 그 안만', async () => {
    const { a, b } = await abSetup();
    expect(await prisma.contentPublish.count()).toBe(0);
    await approveContent(fx.merchantId, b.id, fx.merchantUserId);
    // A안이 아직 검토 대기 — B안은 슬롯이 없어 예약되지 않고, A안도 예약되지 않는다
    expect(await prisma.contentPublish.count()).toBe(0);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('REVIEW');
  });

  it('둘 다 승인 → 두 플랫폼으로 나눠 같은 시각에 예약', async () => {
    const { a, b, slotAt } = await abSetup();
    await approveContent(fx.merchantId, a.id, fx.merchantUserId);
    expect(await prisma.contentPublish.count({ where: { itemId: a.id, status: 'SCHEDULED' } })).toBe(2);
    await approveContent(fx.merchantId, b.id, fx.merchantUserId);
    const aPubs = await prisma.contentPublish.findMany({ where: { itemId: a.id } });
    const bPubs = await prisma.contentPublish.findMany({ where: { itemId: b.id } });
    expect(aPubs.filter((p) => p.status === 'SCHEDULED')).toHaveLength(1);
    expect(aPubs.filter((p) => p.status === 'CANCELED')).toHaveLength(1);
    expect(bPubs).toHaveLength(1);
    expect(bPubs[0]!.status).toBe('SCHEDULED');
    expect(bPubs[0]!.scheduledAt.getTime()).toBe(slotAt.getTime());
    expect(bPubs[0]!.platform).not.toBe(aPubs.find((p) => p.status === 'SCHEDULED')!.platform);
  });

  it('A안 반려 + B안 승인 → B안만 슬롯 시각으로 게시 예약(A안은 없음)', async () => {
    const { a, b, slotAt } = await abSetup();
    await rejectContent(fx.merchantId, a.id, fx.merchantUserId, { reasonCode: 'TONE' });
    expect(await prisma.contentPublish.count()).toBe(0);
    await approveContent(fx.merchantId, b.id, fx.merchantUserId);
    const slot = await prisma.contentSlot.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    expect(slot.itemId).toBe(b.id);
    const pubs = await prisma.contentPublish.findMany();
    expect(pubs.every((p) => p.itemId === b.id)).toBe(true);
    expect(pubs.length).toBeGreaterThan(0);
    expect(pubs[0]!.scheduledAt.getTime()).toBe(slotAt.getTime());
  });
});

// ---------------------------------------------------------------------------
describe('콘텐츠 소재 · 초상권 동의서', () => {
  const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

  async function portraitEnvelope(status: 'SENT' | 'COMPLETED' | 'CANCELLED' = 'SENT', purpose: string | null = 'PORTRAIT_CONSENT') {
    const t = await prisma.documentTemplate.create({ data: { id: newId(), merchantId: fx.merchantId, name: `동의서 ${newId().slice(-5)}`, templateType: 'PRESET', presetKey: purpose, purpose } });
    return prisma.eDocEnvelope.create({ data: { id: newId(), merchantId: fx.merchantId, templateId: t.id, title: '초상권 이용 동의서', snapshotEnc: 'x', snapshotHash: 'x', expiresAt: new Date(Date.now() + 86_400_000), status } });
  }

  async function reviewItem() {
    await withRegNo();
    const c = await seedCampaign(`AS${newId().slice(-4)}`);
    return requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_FEED', userId: fx.merchantUserId });
  }

  it('동의서 없는 얼굴 소재는 콘텐츠에 연결·승인할 수 없다 — 동의서(보냄)를 연결하면 쓸 수 있고, 취소되면 승인 거절', async () => {
    const item = await reviewItem();
    const asset = await uploadContentAsset(fx.merchantId, fx.merchantUserId, { bytes: JPG, tags: ['VOLUNTEER'], people: 'STAFF_VOLUNTEER', hasFace: true });
    expect(asset.blurRequired).toBe(false);
    await expect(attachAssetToContent(fx.merchantId, item.id, asset.id)).rejects.toThrow(/초상권/);
    // 다른 용도 서식의 서명 요청은 연결할 수 없다
    const other = await portraitEnvelope('SENT', 'THANKS_LETTER');
    await expect(linkPortraitConsent(fx.merchantId, asset.id, other.id)).rejects.toThrow(/초상권/);
    const env = await portraitEnvelope('SENT');
    await linkPortraitConsent(fx.merchantId, asset.id, env.id);
    await attachAssetToContent(fx.merchantId, item.id, asset.id);
    const [u] = await assetUsability(fx.merchantId, [asset.id]);
    expect(u).toMatchObject({ consent: 'SENT', usable: true });
    expect(u!.warnings.join()).toContain('서명');
    // 동의서가 취소되면 승인할 수 없다(쓸 때마다 다시 확인)
    await prisma.eDocEnvelope.update({ where: { id: env.id }, data: { status: 'CANCELLED' } });
    await expect(approveContent(fx.merchantId, item.id, fx.merchantUserId)).rejects.toThrow(/초상권/);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('REVIEW');
    await prisma.eDocEnvelope.update({ where: { id: env.id }, data: { status: 'COMPLETED' } });
    expect((await approveContent(fx.merchantId, item.id, fx.merchantUserId)).status).toBe('APPROVED');
  });

  it('수혜자 소재는 쓸 수 없고, 아동 소재는 기본 가림 필요 · 이미지·영상이 아닌 파일은 거절', async () => {
    const item = await reviewItem();
    const ben = await uploadContentAsset(fx.merchantId, fx.merchantUserId, { bytes: JPG, tags: ['BENEFICIARY'], people: 'NONE', hasFace: false });
    await expect(attachAssetToContent(fx.merchantId, item.id, ben.id)).rejects.toThrow(/수혜자/);
    const child = await uploadContentAsset(fx.merchantId, fx.merchantUserId, { bytes: JPG, tags: ['EVENT'], people: 'CHILD', hasFace: true, blurRequired: false });
    expect(child.blurRequired).toBe(true);
    const fac = await uploadContentAsset(fx.merchantId, fx.merchantUserId, { bytes: JPG, tags: ['FACILITY'], people: 'NONE', hasFace: false });
    await attachAssetToContent(fx.merchantId, item.id, fac.id);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).assetIds).toEqual([fac.id]);
    await expect(uploadContentAsset(fx.merchantId, fx.merchantUserId, { bytes: Buffer.from('%PDF-1.7 ......'), tags: ['EVENT'], people: 'NONE', hasFace: false })).rejects.toThrow(/사진/);
    await expect(uploadContentAsset(fx.merchantId, fx.merchantUserId, { bytes: JPG, tags: [], people: 'NONE', hasFace: false })).rejects.toThrow(/태그/);
    await expect(uploadContentAsset(fx.merchantId, fx.merchantUserId, { bytes: JPG, tags: ['EVENT'], people: 'NONE', hasFace: false, note: '연락처 010-1234-5678' })).rejects.toThrow(/메모/);
  });

  it('초상권 이용 동의서 용도 — 기본 세트·서명 필요·자동 발송 없음', async () => {
    expect(DOCUMENT_PURPOSES).toContain('PORTRAIT_CONSENT');
    expect(purposeNeedsSignature('PORTRAIT_CONSENT')).toBe(true);
    expect(MANUAL_ONLY_PURPOSES).toContain('PORTRAIT_CONSENT');
    await ensureDefaultPurposeTemplates(fx.merchantId, ['PORTRAIT_CONSENT']);
    const t = await prisma.documentTemplate.findFirstOrThrow({ where: { merchantId: fx.merchantId, purpose: 'PORTRAIT_CONSENT' } });
    expect(t).toMatchObject({ presetKey: 'PORTRAIT_CONSENT', requireSignature: true, defaultSet: true });
  });
});

// ---------------------------------------------------------------------------
describe('연결 지점', () => {
  it('보고 안내는 정보성 알림톡 템플릿이고 후원자 대상 분류(7일 상한)에 들어가지 않는다 · 배치 등록', () => {
    expect(ALIMTALK_TEMPLATES).toContain('WEEKLY_REPORT');
    expect(isStaffInfoTemplate('WEEKLY_REPORT')).toBe(true);
    expect(kindOfTemplate('WEEKLY_REPORT')).toBeNull();
    expect(CRON_JOBS.find((j) => j.name === 'weekly-plan')).toMatchObject({ path: '/api/cron/weekly-plan', intervalSec: 3600 });
  });

  it('주간 계획 승인 대기 묶음이 승인 대기함에 보인다', async () => {
    await withRegNo();
    await seedCampaign('INBOX');
    await generateWeeklyPlan(fx.merchantId, MONDAY_0930);
    const { loadInboxGroups } = await import('@/server/services/inbox-groups');
    const groups = await loadInboxGroups(fx.merchantId, MONDAY_0930);
    const g = groups.find((x) => x.provider === 'weekly-plan');
    expect(g?.group?.kind).toBe('WEEKLY_PLAN');
    expect(g?.group?.affectedCount).toBeGreaterThan(0);
    void dateColumn;
  });
});
