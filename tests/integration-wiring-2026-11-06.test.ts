import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { readMockOutbox } from '@/server/adapters/mt';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { emitShiftReminders } from '@/server/services/journeys/reminders';
import { renderPlatformPost } from '@/server/services/content';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';

/**
 * 단계 간 연결(병합 후):
 *  - 봉사 회차(6단계) → 전날 안내 이벤트 → 저니(3단계)가 일정 안내 문자 발송
 *  - 실제 게시 캡션은 /go 짧은 링크(6단계)로, 미리보기는 후원페이지 주소 그대로(5단계)
 */
let fx: Fixture;
beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  registerDefaultConsumers();
});

describe('[1] 봉사 전날 안내', () => {
  it('내일 시작 회차의 승인된 신청자에게 한 번만 일정 안내가 나간다(9시 이후)', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    // 내일 11:00 KST 에 배치가 돈다고 보고, 그 다음 날 10:00 KST 회차(실제 시각보다 미래 — 발송 직전 "시작 전" 재확인을 통과).
    const kstToday = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const dayAfter = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    const runDay = dayAfter(kstToday, 1);
    const shiftDay = dayAfter(kstToday, 2);
    const now = new Date(`${runDay}T02:00:00Z`); // 11:00 KST
    const posting = await prisma.volunteerPosting.create({
      data: {
        id: newId(), merchantId: fx.merchantId, title: '김장 나눔 봉사', interest: '돌봄·말벗', description: '김장 담그기', place: '복지관 1층',
        recruitFrom: new Date('2026-11-01'), recruitTo: new Date('2026-11-20'), status: 'OPEN', createdBy: fx.merchantUserId,
      },
    });
    const shift = await prisma.volunteerShift.create({
      data: {
        id: newId(), postingId: posting.id, merchantId: fx.merchantId, shiftDate: new Date(shiftDay), startTime: '10:00', endTime: '12:00',
        startsAt: new Date(`${shiftDay}T01:00:00Z`), endsAt: new Date(`${shiftDay}T03:00:00Z`), capacity: 5, appliedCount: 1,
      },
    });
    await prisma.volunteerApplication.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, status: 'APPROVED', postingId: posting.id, shiftId: shift.id, assignment: '11/7(토) 10:00~12:00 · 복지관 1층' },
    });

    expect((await emitShiftReminders(new Date(`${kstToday}T22:00:00Z`))).emitted).toBe(0); // 다음 날 07:00 KST — 9시 전
    expect((await emitShiftReminders(now)).emitted).toBe(1);
    await emitShiftReminders(now); // 다시 불러도 이벤트는 한 건
    expect(await prisma.domainEvent.count({ where: { type: 'volunteer.shift_reminder_due' } })).toBe(1);

    await processDomainEvents();
    const msgs = readMockOutbox(10).filter((m) => m.template === 'VOLUNTEER_REMINDER');
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain('복지관 1층');
    expect((await prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: 'volunteer-reminder' } })).status).toBe('DONE');
  });
});

describe('[2] 게시 캡션 링크', () => {
  it('게시 행이 있으면 /go 링크, 없으면 후원페이지 주소', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const c = await prisma.campaign.create({
      data: { id: newId(), merchantId: fx.merchantId, code: 'GO1', title: '캠페인', summary: '요약', goalAmount: 100000n, startsOn: new Date(today), endsOn: new Date('2099-12-31'), status: 'ACTIVE' },
    });
    const item = { id: 'ITEM1', merchantId: fx.merchantId, campaignId: c.id, title: '제목', caption: '함께해요 {링크}', platformCaptions: null };
    const preview = await renderPlatformPost(item as never, 'INSTAGRAM');
    expect(preview.text).toContain('/donate/');
    expect(preview.text).not.toContain('/go/');
    const published = await renderPlatformPost(item as never, 'INSTAGRAM', { publishId: 'PUB1' });
    expect(published.text).toContain('/go/PUB1');
  });
});
