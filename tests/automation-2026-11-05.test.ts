import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { kv } from '@/server/redis';
import { readMockOutbox } from '@/server/adapters/mt';
import { mockMoAdapter } from '@/server/adapters/mo';
import { campaignSchema } from '@/lib/fundraising';
import { handleMoInbound } from '@/server/services/charge-flow';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import { createRecurringDonation } from '@/server/services/recurring';
import { pendingPledgeRequests, sendPledgeReminders } from '@/server/services/supporters';
import { ALIMTALK_TEMPLATES } from '@/server/services/alimtalk';
import { expireStaleESignRequests, maskedIssuerContact, ESIGN_REQUEST_TTL_DAYS } from '@/server/services/agreements';
import { monthRange, NOTICE_RUN_LOCK_TTL_MS, previousMonthKey, runMerchantNoticeDetailed } from '@/server/services/monthly-notice';
import {
  connectSocialChannel,
  contentDraftViolation,
  monthlyUsage,
  processContentQueue,
  PUBLISHING_STALE_MS,
  requestContent,
  runContentPipeline,
  SOCIAL_OAUTH_NOT_READY,
  type Scene,
} from '@/server/services/content';
import { ownedContentItemId } from '@/server/services/attribution';
import { contentPrecheck } from '@/server/services/content-review';
import { GET as cleanupGET } from '@/app/api/cron/cleanup/route';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';

/**
 * 점검 2026-11-05 C(자동화) 조치 회귀 테스트.
 *  - H: 월간 안내가 수동 실행·배치·더블클릭이 겹쳐도 한 사람에 한 번만 나간다.
 *  - 콘텐츠 생성 재개 선점·게시 중 고착 복구·자동 승인 검사·실연동 SNS 연결 거절·한도·수혜자 문구.
 *  - 약정 재안내 간격·차단 제외, 약정 중인 사람 제외, 약정 링크 알림톡 제외.
 *  - cleanup 배치 잠금 소유자 확인, 전자서명 요청 만료, 유입 콘텐츠 소속 확인, 약정서 문의처 마스킹.
 */

const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  for (const t of ['RECEIPT_ISSUANCE', 'RECURRING_DEBIT', 'VOLUNTEER_PRIVACY'] as const) {
    await prisma.termsVersion.create({
      data: { id: newId(), type: t, version: '1.0', title: `${t} 동의`, content: `${t} 테스트 본문`, required: false, effectiveFrom: new Date('2026-01-01') },
    });
  }
});

async function seedCampaign(code = 'KIMJANG') {
  const today = new Date().toISOString().slice(0, 10);
  const c = await saveCampaign(fx.merchantId, campaignSchema.parse({
    code, title: '김장 나눔', summary: '홀몸 어르신 김장 나눔', story: '올겨울 300가구에 김장김치를 전합니다. 함께해 주세요.',
    beneficiary: '김철수 어르신(82세, 행복동 101호)', usagePlan: '김장 재료비와 배송비', goalAmount: 3000000, startsOn: today, endsOn: '2099-12-31',
  }));
  await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
  return c;
}

async function seedLastMonthDonors(phones: string[]) {
  const payers = [];
  for (const phone of phones) {
    payers.push(await seedRegisteredPayer(phone));
    await inboundAndPay(moPayload({ to: fx.moNumber, from: phone, text: '응원' }), fx.merchantId);
  }
  const month = previousMonthKey();
  await prisma.charge.updateMany({ where: { merchantId: fx.merchantId }, data: { paidAt: new Date(monthRange(month).start.getTime() + 3 * 86_400_000) } });
  return { payers, month };
}

const monthlyNotices = () => readMockOutbox(100).filter((m) => m.template === 'MONTHLY_NOTICE');

describe('[H] 월간 안내 동시 실행', () => {
  it.skipIf(singleBackend)('수동 실행 두 번(더블클릭)·배치가 동시에 돌아도 한 사람에 한 번만 나간다', async () => {
    const { payers, month } = await seedLastMonthDonors(['01011112222', '01033334444', '01055556666']);
    const before = monthlyNotices().length;
    const results = await Promise.all([
      runMerchantNoticeDetailed(fx.merchantId, month),
      runMerchantNoticeDetailed(fx.merchantId, month),
      runMerchantNoticeDetailed(fx.merchantId, month),
    ]);
    expect(results.filter((r) => r.outcome === 'RAN')).toHaveLength(1);
    expect(results.every((r) => ['RAN', 'BUSY', 'ALREADY_DONE'].includes(r.outcome))).toBe(true);
    expect(monthlyNotices().length - before).toBe(payers.length);
    const run = await prisma.noticeRun.findUniqueOrThrow({ where: { merchantId_monthKey: { merchantId: fx.merchantId, monthKey: month } } });
    expect(run.status).toBe('DONE');
    expect(run.sentCount).toBe(payers.length);
    expect(run.recipientCount).toBe(payers.length);
    expect(run.lockedBy).toBeNull();
    const deliveries = await prisma.noticeDelivery.findMany({ where: { noticeRunId: run.id } });
    expect(deliveries).toHaveLength(payers.length);
    expect(deliveries.every((d) => d.status === 'SENT')).toBe(true);

    // 끝난 뒤 다시 눌러도 보내지 않는다
    expect((await runMerchantNoticeDetailed(fx.merchantId, month)).outcome).toBe('ALREADY_DONE');
    expect(monthlyNotices().length - before).toBe(payers.length);
  });

  it('다른 실행이 선점 중이면 보내지 않고, 선점이 TTL 을 넘기면 이어받는다', async () => {
    const { payers, month } = await seedLastMonthDonors(['01011112222']);
    const run = await prisma.noticeRun.create({ data: { id: newId(), merchantId: fx.merchantId, monthKey: month, lockedAt: new Date(), lockedBy: 'other' } });
    const before = monthlyNotices().length;
    expect((await runMerchantNoticeDetailed(fx.merchantId, month)).outcome).toBe('BUSY');
    expect(monthlyNotices().length).toBe(before);

    await prisma.noticeRun.update({ where: { id: run.id }, data: { lockedAt: new Date(Date.now() - NOTICE_RUN_LOCK_TTL_MS - 1000) } });
    const r = await runMerchantNoticeDetailed(fx.merchantId, month);
    expect(r.outcome).toBe('RAN');
    expect(monthlyNotices().length - before).toBe(payers.length);
  });

  it('발송 기록(SENDING)이 먼저 생긴 사람은 다시 보내지 않는다 — 발송 중 멈춘 실행을 이어도 두 번 가지 않는다', async () => {
    const { payers, month } = await seedLastMonthDonors(['01011112222', '01033334444']);
    const run = await prisma.noticeRun.create({ data: { id: newId(), merchantId: fx.merchantId, monthKey: month } });
    await prisma.noticeDelivery.create({ data: { id: newId(), noticeRunId: run.id, payerId: payers[0]!.id, status: 'SENDING' } });
    const before = monthlyNotices().length;
    const r = await runMerchantNoticeDetailed(fx.merchantId, month);
    expect(r.outcome).toBe('RAN');
    expect(monthlyNotices().length - before).toBe(1);
    expect(r.run!.recipientCount).toBe(1);
  });
});

describe('[C] 콘텐츠', () => {
  it.skipIf(singleBackend)('멈춘 생성 재개는 선점하고, 겹친 실행은 같은 단계를 두 번 호출하지 않는다', async () => {
    const c = await seedCampaign();
    const item = await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, campaignId: c.id, kind: 'SHORTFORM', status: 'GENERATING', title: 't', provider: 'mock', createdBy: fx.merchantUserId },
    });
    const old = new Date(Date.now() - 10 * 60_000);
    await prisma.$executeRaw`UPDATE content_item SET updated_at = ${old} WHERE id = ${item.id}`;
    const [a, b] = await Promise.all([processContentQueue(), processContentQueue()]);
    expect(a.resumed + b.resumed).toBe(1);
    const jobs = await prisma.contentJob.findMany({ where: { itemId: item.id } });
    expect(jobs.filter((j) => j.step === 'SCRIPT')).toHaveLength(1);
    expect(jobs.every((j) => j.status === 'DONE')).toBe(true);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('REVIEW');

    // 다른 실행이 단계를 잡고 있으면(신선한 RUNNING) 물러나고 실패로 기록하지 않는다
    const item2 = await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_SQUARE', status: 'GENERATING', title: 't', provider: 'mock', createdBy: fx.merchantUserId },
    });
    await prisma.contentJob.create({ data: { id: newId(), itemId: item2.id, step: 'SCRIPT', status: 'RUNNING', provider: 'mock' } });
    await runContentPipeline(item2.id);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item2.id } })).status).toBe('GENERATING');
  });

  it('게시 중(PUBLISHING)에 멈춘 건은 자동 재게시하지 않고 결과 미확인(UNKNOWN)으로 닫는다 (2026-11-06 A-M9)', async () => {
    const c = await seedCampaign();
    const item = await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_SQUARE', status: 'SCHEDULED', title: 't', provider: 'mock', createdBy: fx.merchantUserId },
    });
    const p1 = await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'INSTAGRAM', scheduledAt: new Date(), status: 'PUBLISHING', attempts: 1 } });
    const p2 = await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'FACEBOOK', scheduledAt: new Date(), status: 'PUBLISHING', attempts: 3 } });
    const p3 = await prisma.contentPublish.create({ data: { id: newId(), itemId: item.id, platform: 'YOUTUBE', scheduledAt: new Date(), status: 'PUBLISHING', attempts: 1 } });
    const stale = new Date(Date.now() - PUBLISHING_STALE_MS - 60_000);
    await prisma.$executeRaw`UPDATE content_publish SET updated_at = ${stale} WHERE id IN (${p1.id}, ${p2.id})`;
    const r = await processContentQueue();
    expect(r.recovered).toBe(2);
    expect(r.published).toBe(0);
    const rows = new Map((await prisma.contentPublish.findMany({ where: { itemId: item.id } })).map((p) => [p.id, p]));
    expect(rows.get(p1.id)!.status).toBe('UNKNOWN');
    expect(rows.get(p2.id)!.status).toBe('UNKNOWN');
    expect(rows.get(p1.id)!.error).toMatch(/다시 게시/);
    expect(rows.get(p3.id)!.status).toBe('PUBLISHING'); // 아직 진행 중일 수 있는 건은 건드리지 않는다
  });

  // 2026-11-09 대표 결정으로 자동 승인이 없어졌다. 예전 이 테스트는 "자동 승인 켜짐 → APPROVED" 를 확인했는데,
  // 그 부분만 새 규칙(설정이 남아 있어도 검토 대기, approvedBy 없음)으로 바꾸고, 검증하던 다른 성질 —
  // 수혜자 문구를 장면에 넣지 않음 · 기관 해시태그의 금지어를 같은 검사(contentDraftViolation)가 잡음 — 은 그대로 둔다.
  it('자동 승인 설정이 남아 있어도 검토 대기로 만들고, 금지어는 사전 점검이 잡는다 / 수혜자 문구는 장면에 넣지 않는다', async () => {
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { fundraisingRegNo: '2026-서울-00999' } });
    const c = await seedCampaign();
    await prisma.merchantContentSetting.create({ data: { merchantId: fx.merchantId, autoApprove: true, bannedWords: [], hashtags: ['금지태그'] } });
    const ok = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'SHORTFORM', userId: fx.merchantUserId });
    expect(ok.status).toBe('REVIEW');
    expect(ok.approvedBy).toBeNull();
    const scenes = ok.scenes as unknown as Scene[];
    expect(scenes.some((s) => s.caption.includes('김철수'))).toBe(false);
    expect(ok.script ?? '').not.toContain('김철수');
    expect((await contentPrecheck(ok)).find((r) => r.key === 'DRAFT')!.ok).toBe(true);

    // 기관 해시태그에 금지어가 들어가면(공급자 산출물 검사와 같은 경로) 사전 점검이 사유를 보여 준다
    await prisma.merchantContentSetting.update({ where: { merchantId: fx.merchantId }, data: { bannedWords: ['금지태그'] } });
    const held = await requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_SQUARE', userId: fx.merchantUserId });
    expect(held.status).toBe('REVIEW');
    expect(held.approvedBy).toBeNull();
    const draft = (await contentPrecheck(held)).find((r) => r.key === 'DRAFT')!;
    expect(draft.ok).toBe(false);
    expect(draft.detail).toMatch(/금지어/);

    expect(contentDraftViolation({ bannedWords: [], captions: ['a'], caption: '{링크} AI 생성 콘텐츠' })).toBeNull();
    expect(contentDraftViolation({ bannedWords: [], captions: ['a'], caption: 'AI 생성 콘텐츠' })).toMatch(/링크/);
  });

  it('실연동 SNS 공급자에서는 OAuth 전 연결을 거절하고 자리표시자 토큰을 저장하지 않는다', async () => {
    const auto = env.automation as { socialProvider: string };
    const prev = auto.socialProvider;
    auto.socialProvider = 'youtube';
    try {
      await expect(connectSocialChannel(fx.merchantId, 'YOUTUBE', '햇살복지관 채널', fx.merchantUserId)).rejects.toThrow(SOCIAL_OAUTH_NOT_READY);
      expect(await prisma.socialChannel.count({ where: { merchantId: fx.merchantId } })).toBe(0);
    } finally {
      auto.socialProvider = prev;
    }
    const mock = await connectSocialChannel(fx.merchantId, 'YOUTUBE', '햇살복지관 채널', fx.merchantUserId);
    expect(mock.mock).toBe(true);
    expect(mock.accessTokenEnc).toBeNull();
  });

  it('생성 실패 건은 월 한도에 들지 않는다', async () => {
    const c = await seedCampaign();
    await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_SQUARE', status: 'FAILED', title: 't', provider: 'mock', createdBy: fx.merchantUserId },
    });
    expect((await monthlyUsage(fx.merchantId)).count).toBe(0);
    await prisma.merchantContentSetting.create({ data: { merchantId: fx.merchantId, monthlyLimit: 1 } });
    await expect(requestContent({ merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_STORY', userId: fx.merchantUserId })).resolves.toBeTruthy();
  });

  it('유입 콘텐츠 ID 는 이 기관 콘텐츠일 때만 기록한다', async () => {
    const c = await seedCampaign();
    const item = await prisma.contentItem.create({
      data: { id: newId(), merchantId: fx.merchantId, campaignId: c.id, kind: 'IMAGE_SQUARE', status: 'REVIEW', title: 't', provider: 'mock', createdBy: fx.merchantUserId },
    });
    expect(await ownedContentItemId(fx.merchantId, item.id)).toBe(item.id);
    expect(await ownedContentItemId(fx.merchantId, newId())).toBeNull();
    expect(await ownedContentItemId('other-merchant', item.id)).toBeNull();
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 3, source: 'INSTAGRAM', contentItemId: newId() });
    if (!r.ok) throw new Error(r.message);
    expect(r.recurring.contentItemId).toBeNull();
  });
});

describe('[C] 약정 재안내', () => {
  async function mo(text: string, from = fx.payerPhone) {
    return handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, from, text })));
  }

  it('같은 후원자에게는 간격 안에 다시 보내지 않고, 차단·이용 제한 후원자는 대상에서 뺀다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const blocked = await seedRegisteredPayer('01077778888');
    await mo('정기');
    await mo('정기', '01077778888');
    await prisma.blockedPayer.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: blocked.id } });
    expect((await pendingPledgeRequests(fx.merchantId)).map((p) => p.payerId)).toEqual([payer.id]);

    const count = () => readMockOutbox(100).filter((m) => m.template === 'PLEDGE_LINK').length;
    const before = count();
    const [a, b] = await Promise.all([sendPledgeReminders(fx.merchantId), sendPledgeReminders(fx.merchantId)]);
    expect(a.sent + b.sent).toBe(1);
    expect(a.suppressed + b.suppressed).toBe(1);
    expect(count() - before).toBe(1);
    const again = await sendPledgeReminders(fx.merchantId);
    expect(again.sent).toBe(0);
    await kv.del(`pledge:remind:${fx.merchantId}:${payer.id}`);
  });

  it('30일보다 오래된 진행 중 약정이 있으면 미완료 대상이 아니다 / 약정 링크는 알림톡으로 보내지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
    if (!r.ok) throw new Error(r.message);
    await prisma.recurringDonation.update({ where: { id: r.recurring.id }, data: { createdAt: new Date(Date.now() - 90 * 86_400_000) } });
    await mo('정기');
    expect(await pendingPledgeRequests(fx.merchantId)).toHaveLength(0);
    expect(ALIMTALK_TEMPLATES).not.toContain('PLEDGE_LINK');
  });
});

describe('[C] 배치·약정서', () => {
  it('cleanup 배치는 남의 잠금을 지우지 않고, 끝나면 내 잠금만 푼다', async () => {
    const key = 'cron:cleanup:lock';
    await kv.del(key);
    await kv.setnx(key, 'someone-else', 55);
    const skipped = await cleanupGET(new Request('http://localhost/api/cron/cleanup'));
    expect((await skipped.json()).skipped).toBe(true);
    expect(await kv.get(key)).toBe('someone-else');
    await kv.del(key);

    const res = await cleanupGET(new Request('http://localhost/api/cron/cleanup'));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.steps.staleESign.ok).toBe(true);
    expect(body.steps.orphanCharges).toBeTruthy(); // 1차 작업자가 넣은 단계 유지
    expect(body.__httpStatus).toBeUndefined();
    expect(await kv.get(key)).toBeNull();
  });

  it('오래된 전자서명 요청은 만료로 닫고, 최근 요청·결과가 난 요청은 그대로 둔다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 10 });
    if (!r.ok) throw new Error(r.message);
    const doc = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: r.recurring.id } });
    await prisma.agreementDocument.update({ where: { id: doc.id }, data: { esignStatus: 'REQUESTED', esignRequestId: 'req-1' } });
    expect(await expireStaleESignRequests()).toBe(0);
    await prisma.agreementDocument.update({ where: { id: doc.id }, data: { createdAt: new Date(Date.now() - (ESIGN_REQUEST_TTL_DAYS + 1) * 86_400_000) } });
    expect(await expireStaleESignRequests()).toBe(1);
    expect((await prisma.agreementDocument.findUniqueOrThrow({ where: { id: doc.id } })).esignStatus).toBe('EXPIRED');
  });

  it('약정서 기관 문의처는 휴대폰·이메일을 마스킹하고 대표번호는 그대로 둔다', () => {
    expect(maskedIssuerContact('김담당', '010-1234-5678', 'manager@welfare.or.kr')).toBe('김담당 · 010-****-5678 · ma***@welfare.or.kr');
    expect(maskedIssuerContact(null, '02-123-4567', null)).toBe('02-123-4567');
    expect(maskedIssuerContact(null, null, null)).toBeNull();
  });
});
