import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { phoneHash, encrypt, maskPhone } from '@/lib/crypto';
import { readMockOutbox } from '@/server/adapters/mt';
import { campaignSchema } from '@/lib/fundraising';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import {
  emitDomainEvent,
  processDomainEvents,
  registerConsumer,
  unregisterConsumer,
  EVENT_MAX_ATTEMPTS,
} from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { executePayment } from '@/server/services/charge-flow';
import { applyVolunteer, decideVolunteer, recordVolunteerActivity } from '@/server/services/volunteers';
import { createRecurringDonation } from '@/server/services/recurring';
import { GET as eventsGET } from '@/app/api/cron/events/route';
import { GET as webhooksGET } from '@/app/api/cron/webhooks/route';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, setChargeAmount, type Fixture } from './helpers';

/**
 * 고도화 1단계: 도메인 이벤트(아웃박스) · 기본 소비자 · 배치 실행 기록.
 */

const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
let fx: Fixture;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  registerDefaultConsumers();
  for (const t of ['RECEIPT_ISSUANCE', 'RECURRING_DEBIT', 'VOLUNTEER_PRIVACY'] as const) {
    await prisma.termsVersion.create({
      data: { id: newId(), type: t, version: '1.0', title: `${t} 동의`, content: `${t} 테스트 본문`, required: false, effectiveFrom: new Date('2026-01-01') },
    });
  }
});

afterEach(() => {
  unregisterConsumer('test-counter');
  unregisterConsumer('test-flaky');
});

function cronReq(path: string) {
  return new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ''}` } });
}

async function payOnce(amount = 10000n) {
  await seedRegisteredPayer(fx.payerPhone);
  setChargeAmount(amount);
  const res = await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: '후원' }), fx.merchantId);
  setChargeAmount(null);
  return res;
}

describe('[1] 결제 성공은 승인 트랜잭션 안에서 charge.paid 를 한 번만 남긴다', () => {
  it('결제 완료 → 이벤트 1건, 같은 건을 다시 실행해도 1건', async () => {
    const res = await payOnce();
    expect(res.chargeId).toBeTruthy();
    const evs = await prisma.domainEvent.findMany({ where: { type: 'charge.paid' } });
    expect(evs).toHaveLength(1);
    expect(evs[0]!.subjectId).toBe(res.chargeId);
    expect(evs[0]!.payerId).toBeTruthy();
    // payload 에 전화번호 원문이 없다
    expect(JSON.stringify(evs[0]!.payload)).not.toContain(fx.payerPhone);
    await executePayment(res.chargeId!);
    expect(await prisma.domainEvent.count({ where: { type: 'charge.paid' } })).toBe(1);
  });

  it('같은 dedupeKey 로 두 번 기록해도 한 행이고 예외가 없다', async () => {
    const input = { merchantId: fx.merchantId, type: 'charge.paid' as const, subjectType: 'charge', subjectId: 'X1', payload: { amount: 1n } };
    await emitDomainEvent(input);
    await emitDomainEvent(input);
    expect(await prisma.domainEvent.count()).toBe(1);
  });
});

describe('[2] 처리 배치', () => {
  it('기본 소비자: 기관 알림 + 명단 사후 연결, 두 번 돌려도 다시 하지 않는다', async () => {
    // 명단에만 있던 번호
    await prisma.supporterContact.create({
      data: {
        id: newId(), merchantId: fx.merchantId, name: '명단 홍길동', phoneHash: phoneHash(fx.payerPhone),
        phoneEnc: encrypt(fx.payerPhone), phoneMasked: maskPhone(fx.payerPhone), role: 'DONOR',
      },
    });
    await payOnce();
    const r1 = await processDomainEvents();
    expect(r1.done).toBeGreaterThanOrEqual(1);
    const contact = await prisma.supporterContact.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    expect(contact.payerId).toBeTruthy();
    const notes = await prisma.notification.findMany({ where: { userId: fx.merchantUserId, title: { startsWith: '새 후원' } } });
    expect(notes).toHaveLength(1);
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'charge.paid' } });
    expect(ev.status).toBe('DONE');

    await prisma.domainEvent.update({ where: { id: ev.id }, data: { status: 'PENDING' } });
    await processDomainEvents();
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId, title: { startsWith: '새 후원' } } })).toBe(1);
  });

  it('한 소비자가 실패하면 그 소비자만 백오프로 다시 돌고, 재시도를 다 쓰면 FAILED', async () => {
    let counter = 0;
    let flaky = 0;
    registerConsumer({ name: 'test-counter', types: ['charge.paid'], handle: async () => { counter += 1; } });
    registerConsumer({ name: 'test-flaky', types: ['charge.paid'], handle: async () => { flaky += 1; throw new Error('일부러 실패'); } });
    await emitDomainEvent({ merchantId: fx.merchantId, type: 'charge.paid', subjectType: 'charge', subjectId: 'C1', payload: { amount: 1000n } });

    const first = await processDomainEvents();
    expect(first.retry).toBe(1);
    const ev = await prisma.domainEvent.findFirstOrThrow();
    expect(ev.status).toBe('PENDING');
    expect(ev.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    for (let i = 1; i < EVENT_MAX_ATTEMPTS; i += 1) {
      await prisma.domainEvent.update({ where: { id: ev.id }, data: { nextAttemptAt: new Date(0) } });
      await processDomainEvents();
    }
    expect(counter).toBe(1);
    expect(flaky).toBe(EVENT_MAX_ATTEMPTS);
    const after = await prisma.domainEvent.findFirstOrThrow();
    expect(after.status).toBe('FAILED');
    expect(after.lastError).toContain('test-flaky');
    const d = await prisma.domainEventDelivery.findMany({ where: { eventId: ev.id } });
    expect(d.find((x) => x.consumer === 'test-counter')?.status).toBe('DONE');
    expect(d.find((x) => x.consumer === 'test-flaky')?.status).toBe('FAILED');
  });

  it.skipIf(singleBackend)('두 배치가 겹쳐도 같은 이벤트를 두 번 처리하지 않는다', async () => {
    let counter = 0;
    registerConsumer({
      name: 'test-counter', types: ['charge.paid'],
      handle: async () => { counter += 1; await new Promise((r) => setTimeout(r, 30)); },
    });
    for (let i = 0; i < 10; i += 1) {
      await emitDomainEvent({ merchantId: fx.merchantId, type: 'charge.paid', subjectType: 'charge', subjectId: `C${i}`, payload: {} });
    }
    await Promise.all([processDomainEvents(), processDomainEvents(), processDomainEvents()]);
    expect(counter).toBe(10);
  });
});

describe('[3] 캠페인 목표 달성', () => {
  it('모금액이 목표에 처음 닿을 때 한 번만 기록·알림한다', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const c = await saveCampaign(fx.merchantId, campaignSchema.parse({
      code: 'GOAL', title: '목표 캠페인', summary: '요약', goalAmount: 15000, startsOn: today, endsOn: '2099-12-31',
    }));
    await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
    await seedRegisteredPayer(fx.payerPhone);
    setChargeAmount(10000n);
    await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: 'GOAL' }), fx.merchantId);
    await processDomainEvents();
    expect((await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } })).goalReachedAt).toBeNull();

    await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: 'GOAL', messageId: 'mo-2' }), fx.merchantId);
    setChargeAmount(null);
    await processDomainEvents();
    await processDomainEvents(); // goal_reached 이벤트 자체도 처리
    const after = await prisma.campaign.findUniqueOrThrow({ where: { id: c.id } });
    expect(after.goalReachedAt).not.toBeNull();
    expect(await prisma.domainEvent.count({ where: { type: 'campaign.goal_reached' } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId, title: '캠페인 목표 달성' } })).toBe(1);
  });
});

describe('[4] 봉사·정기후원 이벤트, 봉사 신청서 안내', () => {
  const base = { interests: ['돌봄·말벗'], availableDays: ['SAT'], timeSlot: 'WEEKEND', safetyPledge: true, agree: true };

  it('봉사 신청 → 신청서 열람 링크 문자가 나가고(예전 누락), 신청·승인·활동·이정표 이벤트가 남는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const id = await applyVolunteer({ ...base, payerId: payer.id, merchantId: fx.merchantId });
    expect(readMockOutbox(10).some((m) => m.template === 'AGREEMENT_ISSUED')).toBe(true);
    await decideVolunteer({ merchantId: fx.merchantId, applicationId: id, decision: 'APPROVE', assignment: '토 10시', userId: fx.merchantUserId });
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    await recordVolunteerActivity({ merchantId: fx.merchantId, payerId: payer.id, activityDate: today, minutes: 600, title: '말벗', userId: fx.merchantUserId });
    const types = (await prisma.domainEvent.findMany({ orderBy: { occurredAt: 'asc' } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['volunteer.applied', 'volunteer.approved', 'volunteer.activity_recorded', 'volunteer.milestone']));
    const ms = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'volunteer.milestone' } });
    expect((ms.payload as { hours: number }).hours).toBe(10);
  });

  it('정기 약정 → recurring.pledged (약정 트랜잭션 안)', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const r = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 3 });
    if (!r.ok) throw new Error(r.message);
    const ev = await prisma.domainEvent.findFirstOrThrow({ where: { type: 'recurring.pledged' } });
    expect(ev.subjectId).toBe(r.recurring.id);
  });
});

describe('[5] 배치 공용 실행기', () => {
  it('events·webhooks 배치는 실행 기록을 남기고, 인증 없으면 거절한다', async () => {
    // 비밀이 설정된 환경에서만 거절을 확인한다(로컬은 비밀 없이 통과하는 것이 정책).
    if (process.env.CRON_SECRET) {
      const bad = await eventsGET(new Request('http://localhost/api/cron/events', { headers: { authorization: 'Bearer wrong' } }));
      expect(bad.status).toBe(401);
    }
    const ok = await eventsGET(cronReq('/api/cron/events'));
    expect(ok.status).toBe(200);
    const wh = await webhooksGET(cronReq('/api/cron/webhooks'));
    expect(wh.status).toBe(200);
    const beats = await prisma.cronHeartbeat.findMany({ orderBy: { name: 'asc' } });
    expect(beats.map((b) => b.name)).toEqual(['events', 'webhooks']);
    expect(beats.every((b) => b.lastOk === true && b.runCount === 1)).toBe(true);
  });
});
