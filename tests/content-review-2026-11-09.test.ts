import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { campaignSchema } from '@/lib/fundraising';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import {
  approveContent,
  connectSocialChannel,
  contentAvoidHints,
  getContentSetting,
  processContentQueue,
  requestContent,
  saveContentSetting,
} from '@/server/services/content';
import { calendarSlots, fillNextSlot } from '@/server/services/content-calendar';
import {
  approveContentBatch,
  cleanReviewNote,
  contentPrecheck,
  kstWeekStart,
  rejectContent,
  requestContentRevision,
  reviewEntries,
  reviewWeeks,
  runContentReviewAlerts,
} from '@/server/services/content-review';
import { buildScriptPrompt } from '@/server/adapters/content/llm-script';
import type { ContentBrief } from '@/server/adapters/content';
import { CRON_JOBS } from '@/server/cron-registry';
import { CONTENT_REVISIONS_PER_DAY } from '@/lib/content-review';
import { resetDb, seedBasics, type Fixture } from './helpers';

/**
 * 2026-11-09 B2 — 콘텐츠 "자동 작성 + 항상 사람 승인 후 게시"(대표 결정)와 승인 편의.
 *  자동 승인 경로 없음 · 동시 승인 1회 · 슬롯 지난 콘텐츠의 승인 선택 · 주간 묶음 · 일괄 승인(건너뛰기 이유) ·
 *  반려·수정 요청(개인정보 검사·하루 5회·이전 판 보존) · 반려 이유 학습 · 사전 점검 · 알림 1회.
 */

let fx: Fixture;

async function seedCampaign(code = 'KIMJANG') {
  const c = await saveCampaign(fx.merchantId, campaignSchema.parse({
    code, title: '김장 나눔', summary: '홀몸 어르신 김장 나눔', story: '올겨울 300가구에 김장김치를 전합니다.',
    beneficiary: '홀몸 어르신 300가구', usagePlan: '김장 재료비', goalAmount: 3000000, startsOn: '2026-01-01', endsOn: '2099-12-31',
  }));
  await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
  return c;
}

async function withRegNo() {
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { fundraisingRegNo: '2026-서울-00999' } });
}

async function makeItem(kind: 'IMAGE_FEED' | 'CARD_NEWS' | 'IMAGE_SQUARE' = 'IMAGE_FEED', campaignId?: string) {
  const c = campaignId ?? (await seedCampaign(`C${newId().slice(-5)}`)).id;
  return requestContent({ merchantId: fx.merchantId, campaignId: c, kind, userId: fx.merchantUserId });
}

async function slotFor(itemId: string, slotAt: Date, kind: 'IMAGE_FEED' | 'CARD_NEWS' = 'IMAGE_FEED') {
  return prisma.contentSlot.create({ data: { id: newId(), merchantId: fx.merchantId, slotAt, kind, itemId, status: 'REVIEW' } });
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('자동 승인 없음', () => {
  it('설정에 자동 승인 값이 와도 저장하지 않고, DB 에 켜져 있어도 생성 결과는 검토 대기 — approvedBy=AUTO 경로가 코드에 없다', async () => {
    await withRegNo();
    const saved = await saveContentSetting(fx.merchantId, { tone: 'WARM', bannedWords: [], autoApprove: true, hashtags: [] });
    expect(saved.autoApprove).toBe(false);
    await prisma.merchantContentSetting.update({ where: { merchantId: fx.merchantId }, data: { autoApprove: true } });
    const item = await makeItem();
    expect(item.status).toBe('REVIEW');
    expect(item.approvedBy).toBeNull();
    expect(item.approvedAt).toBeNull();
    expect(await prisma.domainEvent.count({ where: { type: 'content.approved' } })).toBe(0);
    // 시스템 이름으로는 승인할 수 없다
    await expect(approveContent(fx.merchantId, item.id, 'AUTO')).rejects.toThrow(/담당자/);
    await expect(approveContent(fx.merchantId, item.id, 'CALENDAR')).rejects.toThrow(/담당자/);
    // 코드에 자동 승인 대입이 다시 생기지 않게
    for (const f of ['src/server/services/content.ts', 'src/server/services/content-calendar.ts', 'src/server/services/content-review.ts']) {
      const src = readFileSync(path.resolve(__dirname, '..', f), 'utf8');
      expect(src).not.toMatch(/approvedBy:\s*[^,}\n]*'AUTO'/);
      expect(src).not.toMatch(/setting\.autoApprove/);
    }
  });

  it('캘린더가 만든 콘텐츠도 검토 대기이고, 승인 전에는 슬롯 시각이 지나도 게시되지 않는다', async () => {
    await withRegNo();
    await seedCampaign();
    await connectSocialChannel(fx.merchantId, 'INSTAGRAM', '@welfare', fx.merchantUserId);
    await prisma.merchantContentSetting.create({
      data: { merchantId: fx.merchantId, calendarEnabled: true, weeklyCount: 7, days: [], postHour: 23, kinds: ['IMAGE_FEED'], platforms: ['INSTAGRAM'], autoApprove: true, autoSchedule: true },
    });
    const r = await fillNextSlot(fx.merchantId);
    expect(r.slot!.status).toBe('REVIEW');
    await prisma.contentSlot.update({ where: { id: r.slot!.id }, data: { slotAt: new Date(Date.now() - 60_000) } });
    await processContentQueue(new Date(Date.now() + 3600_000));
    expect(await prisma.contentPublish.count()).toBe(0);
    const entries = await reviewEntries(fx.merchantId);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.pastDue).toBe(true);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: r.slot!.itemId! } })).status).toBe('REVIEW');
  });
});

describe('승인', () => {
  it('두 사람이 동시에 승인을 눌러도 한 번만 승인된다(이벤트 1건)', async () => {
    await withRegNo();
    const item = await makeItem();
    const r = await Promise.allSettled([
      approveContent(fx.merchantId, item.id, fx.merchantUserId),
      approveContent(fx.merchantId, item.id, fx.merchantUserId),
      approveContent(fx.merchantId, item.id, fx.merchantUserId),
    ]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.domainEvent.count({ where: { type: 'content.approved', subjectId: item.id } })).toBe(1);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } })).approvedBy).toBe(fx.merchantUserId);
  });

  it('슬롯 시각이 지난 뒤 승인: 다음 빈 슬롯(캘린더 기준)으로 옮겨 예약 / 지금 게시 예약 / 승인만', async () => {
    await withRegNo();
    await connectSocialChannel(fx.merchantId, 'INSTAGRAM', '@welfare', fx.merchantUserId);
    await prisma.merchantContentSetting.create({
      data: { merchantId: fx.merchantId, weeklyCount: 7, days: [], postHour: 20, platforms: ['INSTAGRAM'], autoSchedule: true },
    });
    const now = new Date();
    const setting = await getContentSetting(fx.merchantId);
    const future = calendarSlots(setting, now, 28);
    // 가장 가까운 슬롯은 다른 콘텐츠가 이미 차지 → 그다음 슬롯으로 가야 한다
    const busy = await makeItem();
    await slotFor(busy.id, future[0]!);

    const a = await makeItem();
    const slotA = await slotFor(a.id, new Date(now.getTime() - 3600_000));
    await approveContent(fx.merchantId, a.id, fx.merchantUserId, { whenPast: 'NEXT_SLOT', now });
    const movedA = await prisma.contentSlot.findUniqueOrThrow({ where: { id: slotA.id } });
    expect(movedA.slotAt.getTime()).toBe(future[1]!.getTime());
    const pubA = await prisma.contentPublish.findFirstOrThrow({ where: { itemId: a.id } });
    expect(pubA.scheduledAt.getTime()).toBe(future[1]!.getTime());
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('SCHEDULED');

    const b = await makeItem();
    await slotFor(b.id, new Date(now.getTime() - 7200_000));
    await approveContent(fx.merchantId, b.id, fx.merchantUserId, { whenPast: 'NOW', now });
    const pubB = await prisma.contentPublish.findFirstOrThrow({ where: { itemId: b.id } });
    expect(pubB.scheduledAt.getTime()).toBe(now.getTime());

    const c = await makeItem();
    await slotFor(c.id, new Date(now.getTime() - 10_800_000));
    await approveContent(fx.merchantId, c.id, fx.merchantUserId, { whenPast: 'APPROVE_ONLY', now });
    expect(await prisma.contentPublish.count({ where: { itemId: c.id } })).toBe(0);
    expect((await prisma.contentItem.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('APPROVED');
  });
});

describe('주간 묶음 · 일괄 승인', () => {
  it('KST 월요일 기준으로 이번 주(지난 대기 포함)·다음 주로 나누고 날짜별로 묶는다', async () => {
    expect(kstWeekStart(new Date('2026-11-11T03:00:00Z')).toISOString()).toBe('2026-11-08T15:00:00.000Z'); // 수 → 월 00:00 KST
    expect(kstWeekStart(new Date('2026-11-15T14:00:00Z')).toISOString()).toBe('2026-11-08T15:00:00.000Z'); // 일 23시 KST
    expect(kstWeekStart(new Date('2026-11-15T15:00:00Z')).toISOString()).toBe('2026-11-15T15:00:00.000Z'); // 월 00시 KST

    await withRegNo();
    const now = new Date('2026-11-11T03:00:00Z'); // 수요일
    const old = await makeItem();
    await slotFor(old.id, new Date('2026-11-05T10:00:00Z')); // 지난주 — 게시 시각 지남
    const thisWeek = await makeItem();
    await slotFor(thisWeek.id, new Date('2026-11-13T10:00:00Z'));
    const nextWeek = await makeItem();
    await slotFor(nextWeek.id, new Date('2026-11-17T10:00:00Z'));
    const far = await makeItem();
    await slotFor(far.id, new Date('2026-12-01T10:00:00Z'));
    const { weeks, later, total } = await reviewWeeks(fx.merchantId, now);
    expect(total).toBe(4);
    expect(later).toBe(1);
    expect(weeks[0]!.count).toBe(2);
    expect(weeks[0]!.days.map((d) => d.dayKey)).toEqual(['2026-11-05', '2026-11-13']);
    expect(weeks[0]!.days[0]!.entries[0]!.pastDue).toBe(true);
    expect(weeks[1]!.days.map((d) => d.dayKey)).toEqual(['2026-11-17']);
  });

  it('일괄 승인은 항목마다 단건 승인 — 모집등록번호 없는 건은 이유와 함께 건너뛰고, 겹쳐 눌러도 각 항목 1회', async () => {
    const noReg = await makeItem(); // 모집등록번호 없이 만든 콘텐츠
    await withRegNo();
    const a = await makeItem();
    const b = await makeItem();
    const r = await approveContentBatch(fx.merchantId, [a.id, b.id, noReg.id, a.id], fx.merchantUserId);
    expect(r.approved.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.id).toBe(noReg.id);
    expect(r.skipped[0]!.reason).toMatch(/모집등록번호/);

    const c = await makeItem();
    const d = await makeItem();
    const [x, y] = await Promise.all([
      approveContentBatch(fx.merchantId, [c.id, d.id], fx.merchantUserId),
      approveContentBatch(fx.merchantId, [d.id, c.id], fx.merchantUserId),
    ]);
    expect(x.approved.length + y.approved.length).toBe(2);
    expect(await prisma.domainEvent.count({ where: { type: 'content.approved', subjectId: { in: [c.id, d.id] } } })).toBe(2);
    await expect(approveContentBatch(fx.merchantId, [], fx.merchantUserId)).rejects.toThrow(/골라/);
    await expect(approveContentBatch(fx.merchantId, Array.from({ length: 51 }, () => newId()), fx.merchantUserId)).rejects.toThrow(/50건/);
  });
});

describe('반려 · 수정 요청 · 학습', () => {
  it('반려: 이유·메모(가린 값)를 기관별로 남기고 보관한다. 실명 메모는 거절, 두 번째 반려는 막힌다', async () => {
    await withRegNo();
    const item = await makeItem();
    await expect(rejectContent(fx.merchantId, item.id, fx.merchantUserId, { reasonCode: 'NOPE' })).rejects.toThrow(/이유/);
    await expect(rejectContent(fx.merchantId, item.id, fx.merchantUserId, { reasonCode: 'PRIVACY', note: '김영희할머니 이야기 빼 주세요' })).rejects.toThrow(/실명/);
    await rejectContent(fx.merchantId, item.id, fx.merchantUserId, { reasonCode: 'FACT', note: '목표액 표현 과장 계좌 110-123-456789 확인' });
    const after = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.status).toBe('ARCHIVED');
    expect(after.error).toMatch(/반려: 사실과 다른 내용/);
    const fb = await prisma.contentFeedback.findFirstOrThrow({ where: { itemId: item.id } });
    expect(fb).toMatchObject({ kind: 'REJECT', reasonCode: 'FACT', merchantId: fx.merchantId });
    expect(fb.note).not.toContain('110-123-456789');
    await expect(rejectContent(fx.merchantId, item.id, fx.merchantUserId, { reasonCode: 'FACT' })).rejects.toThrow(/이미 처리/);
    await expect(approveContent(fx.merchantId, item.id, fx.merchantUserId)).rejects.toThrow();
  });

  it('수정 요청: 같은 캠페인·형식·슬롯으로 새 판(검토 대기), 이전 판은 보관으로 보존. mock 이면 요청은 메모로만', async () => {
    await withRegNo();
    const item = await makeItem('CARD_NEWS');
    const slot = await slotFor(item.id, new Date(Date.now() + 86_400_000), 'CARD_NEWS');
    const fresh = await requestContentRevision(fx.merchantId, item.id, fx.merchantUserId, '  첫 문장을   짧게 ');
    expect(fresh.status).toBe('REVIEW');
    expect(fresh).toMatchObject({ campaignId: item.campaignId, kind: 'CARD_NEWS', revisionOf: item.id, revisionRootId: item.id, revisionRequest: '첫 문장을 짧게', provider: 'mock' });
    expect(fresh.script ?? '').not.toContain('첫 문장을 짧게'); // mock 은 문장에 반영한 척하지 않는다
    const old = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(old.status).toBe('ARCHIVED');
    expect(old.caption).toBe(item.caption); // 이전 판 그대로 보존
    expect((await prisma.contentSlot.findUniqueOrThrow({ where: { id: slot.id } })).itemId).toBe(fresh.id);
    expect(await prisma.contentFeedback.count({ where: { kind: 'REVISE' } })).toBe(1);

    await expect(requestContentRevision(fx.merchantId, fresh.id, fx.merchantUserId, '연락처 010-1234-5678 넣어 주세요')).rejects.toThrow(/전화번호/);
    await expect(requestContentRevision(fx.merchantId, fresh.id, fx.merchantUserId, '박철수씨 사연으로 바꿔 주세요')).rejects.toThrow(/실명/);
    await expect(requestContentRevision(fx.merchantId, item.id, fx.merchantUserId, '다시')).rejects.toThrow(/검토 대기/); // 보관된 판
  });

  it(`수정 요청은 콘텐츠당 하루 ${CONTENT_REVISIONS_PER_DAY}회, 동시에 눌러도 한 번만 통과한다`, async () => {
    await withRegNo();
    let cur = await makeItem();
    const both = await Promise.allSettled([
      requestContentRevision(fx.merchantId, cur.id, fx.merchantUserId, '더 밝게'),
      requestContentRevision(fx.merchantId, cur.id, fx.merchantUserId, '더 밝게'),
    ]);
    expect(both.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    cur = (both.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<typeof cur>).value;
    for (let i = 1; i < CONTENT_REVISIONS_PER_DAY; i++) cur = await requestContentRevision(fx.merchantId, cur.id, fx.merchantUserId, `요청 ${i}`);
    await expect(requestContentRevision(fx.merchantId, cur.id, fx.merchantUserId, '한 번 더')).rejects.toThrow(/하루/);
    expect(await prisma.contentItem.count({ where: { status: 'REVIEW' } })).toBe(1);
  });

  it('반려·수정 요청 이유(최근 20개)를 "피해야 할 것" 으로 요약해 LLM 프롬프트에 넣는다', async () => {
    for (let i = 0; i < 25; i++) {
      await prisma.contentFeedback.create({
        data: { id: newId(), merchantId: fx.merchantId, itemId: newId(), kind: i % 2 ? 'REJECT' : 'REVISE', reasonCode: i % 2 ? 'TONE' : null, note: i < 5 ? `오래된 메모 ${i}` : `메모 ${i % 3}`, createdBy: fx.merchantUserId, createdAt: new Date(Date.now() - (25 - i) * 60_000) },
      });
    }
    await prisma.contentFeedback.create({ data: { id: newId(), merchantId: 'other', itemId: newId(), kind: 'REJECT', reasonCode: 'FACT', note: '다른 기관', createdBy: 'x' } });
    const hints = await contentAvoidHints(fx.merchantId);
    expect(hints[0]).toMatch(/표현·분위기가 맞지 않음 때문에 반려된 적이 있음\(10회\)/);
    expect(hints.join(' ')).not.toContain('오래된 메모'); // 최근 20개만
    expect(hints.join(' ')).not.toContain('다른 기관');

    const brief = { merchantName: '복지관', campaignTitle: '김장', summary: '요약', story: null, usagePlan: null, goalAmount: 1n, raisedAmount: 0n, daysLeft: null, keyword: null, moNumber: null, tone: 'WARM', color: '#000', regNo: null, bannedWords: [] } as ContentBrief;
    expect(buildScriptPrompt(brief, 'IMAGE_FEED').user).not.toContain('피해야 할 것');
    const p = buildScriptPrompt({ ...brief, avoid: hints, revisionRequest: '첫 문장을 짧게' }, 'IMAGE_FEED').user;
    expect(p).toContain('[피해야 할 것');
    expect(p).toContain('표현·분위기가 맞지 않음');
    expect(p).toContain('[담당자 수정 요청 — 이번 판에 반영] 첫 문장을 짧게');

    expect(cleanReviewNote('  ')).toBeNull();
    expect(() => cleanReviewNote('', { required: true })).toThrow(/적어/);
    expect(() => cleanReviewNote('가'.repeat(201))).toThrow(/200자/);
  });
});

describe('사전 점검', () => {
  it('실명·사진·모집등록번호·문구 검사·플랫폼별 캡션 길이를 이미 있는 검사로 보여 준다', async () => {
    const noReg = await makeItem();
    const rows0 = await contentPrecheck(noReg);
    expect(rows0.find((r) => r.key === 'REG_NO')).toMatchObject({ ok: false, blocking: true });

    await withRegNo();
    await prisma.merchantContentSetting.create({ data: { merchantId: fx.merchantId, platforms: ['INSTAGRAM', 'KAKAO_CHANNEL'] } });
    const item = await makeItem();
    const rows = await contentPrecheck(item);
    expect(rows.map((r) => r.key)).toEqual(['PRIVACY', 'PHOTO', 'REG_NO', 'DRAFT', 'CAPTION:INSTAGRAM', 'CAPTION:KAKAO_CHANNEL']);
    expect(rows.every((r) => r.ok)).toBe(true);

    const bad = await prisma.contentItem.update({ where: { id: item.id }, data: { caption: `${item.caption}\n김영희할머니께 전합니다` } });
    const rows2 = await contentPrecheck(bad);
    expect(rows2.find((r) => r.key === 'PRIVACY')!.ok).toBe(false);
    const noLink = await prisma.contentItem.update({ where: { id: item.id }, data: { caption: 'AI 생성 콘텐츠' } });
    expect((await contentPrecheck(noLink)).find((r) => r.key === 'DRAFT')!.detail).toMatch(/링크/);
  });
});

describe('알림', () => {
  it('월요일 09시 이후 그 주 검토 대기 건수를 기관·주 1회 알린다(다른 요일·대기 없음은 알리지 않음)', async () => {
    await withRegNo();
    const monday = new Date('2026-11-09T00:30:00Z'); // 월 09:30 KST
    expect((await runContentReviewAlerts(monday)).weekly).toBe(0); // 대기 없음
    const item = await makeItem();
    await slotFor(item.id, new Date('2026-11-12T10:00:00Z'));
    expect((await runContentReviewAlerts(new Date('2026-11-08T23:30:00Z'))).weekly).toBe(0); // 월 08:30 — 아직
    expect((await runContentReviewAlerts(monday)).weekly).toBe(1);
    expect((await runContentReviewAlerts(new Date(monday.getTime() + 15 * 60_000))).weekly).toBe(0);
    expect((await runContentReviewAlerts(new Date('2026-11-10T00:30:00Z'))).weekly).toBe(0); // 화요일
    const n = await prisma.notification.findMany({ where: { userId: fx.merchantUserId } });
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe('이번 주 콘텐츠 1건 승인을 기다립니다');
    expect(n[0]!.linkUrl).toBe('/studio/content/review');
  });

  it('게시 시각 하루 전·3시간 전 미승인 건을 (슬롯·시점) 1회씩 알리고, 승인된 건은 알리지 않는다', async () => {
    await withRegNo();
    const now = new Date('2026-11-10T03:00:00Z'); // 화요일
    const soon = await makeItem();
    await slotFor(soon.id, new Date(now.getTime() + 2 * 3600_000));
    const tomorrow = await makeItem();
    const tSlot = await slotFor(tomorrow.id, new Date(now.getTime() + 20 * 3600_000));
    const approved = await makeItem();
    await slotFor(approved.id, new Date(now.getTime() + 3600_000));
    await approveContent(fx.merchantId, approved.id, fx.merchantUserId, { now });
    const far = await makeItem();
    await slotFor(far.id, new Date(now.getTime() + 30 * 3600_000));

    const r1 = await runContentReviewAlerts(now);
    expect(r1).toMatchObject({ due3: 1, due24: 1 });
    const r2 = await runContentReviewAlerts(new Date(now.getTime() + 15 * 60_000));
    expect(r2).toMatchObject({ due3: 0, due24: 0 });
    // 17시간 뒤: 내일 슬롯이 3시간 안으로 들어오면 3시간 알림이 한 번 더
    // (그때 30시간 뒤였던 슬롯은 하루 안으로 들어와 하루 전 알림이 처음 나간다)
    const r3 = await runContentReviewAlerts(new Date(tSlot.slotAt.getTime() - 2 * 3600_000));
    expect(r3).toMatchObject({ due3: 1, due24: 1 });
    const alerts = await prisma.contentReviewAlert.findMany();
    expect(alerts.map((a) => a.kind).sort()).toEqual(['DUE_24H', 'DUE_24H', 'DUE_3H', 'DUE_3H']);
    expect(alerts.filter((a) => a.itemId === far.id).map((a) => a.kind)).toEqual(['DUE_24H']);
    expect(alerts.some((a) => a.itemId === approved.id)).toBe(false);
  });

  it('배치는 cron-registry 에 15분 주기로 등록되어 있다', () => {
    const def = CRON_JOBS.find((j) => j.name === 'content-review');
    expect(def).toMatchObject({ path: '/api/cron/content-review', intervalSec: 900 });
  });
});
