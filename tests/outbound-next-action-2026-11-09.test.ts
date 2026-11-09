import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt } from '@/lib/crypto';
import { readMockOutbox, setMockMtFailure } from '@/server/adapters/mt';
import { sendMtDetailed, sendMtForPayer } from '@/server/services/charge-flow';
import * as tpl from '@/server/services/mt-templates';
import { saveAlimtalkChannel, setAlimtalkChannelStatus } from '@/server/services/alimtalk';
import { processAlimtalkReports, ALIMTALK_REPORT_TIMEOUT_MS } from '@/server/services/alimtalk-reports';
import { runMerchantNoticeDetailed } from '@/server/services/monthly-notice';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { advanceDueJourneyRuns } from '@/server/services/journeys';
import { flushDueOutbound, relationalCapCount, sendRelational, splitBundles } from '@/server/services/outbound/coordinator';
import { isRelationalTemplate, kindOfDocumentPurpose, kindOfJourneyStep, lmsBytes, OUTBOUND_BUNDLE_MAX_BYTES, OUTBOUND_BUNDLE_TEMPLATE } from '@/server/services/outbound/classify';
import { resendUnknownAsSms, listUnknownAlimtalk } from '@/server/services/outbound/unknown-resend';
import { noticeStageStats } from '@/server/services/outbound/stage-stats';
import { autoPauseReason } from '@/server/services/outbound/pause';
import { decideNextAction, nextActionForPayer, nextActionOrder, nextActionsForMerchant, needsStaff, type NextActionFacts } from '@/server/services/next-action';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, setChargeAmount, type Fixture } from './helpers';

/**
 * 2026-11-09 2차 D — 후원자별 다음 업무 판단 + 통합 발송 관리(발송 대기열·합치기·상한·야간·선호 채널·결과 미확인 수동 재발송).
 */

const singleBackend = process.env.PGLITE === '1' || (process.env.DATABASE_URL ?? '').includes(`:${process.env.PGLITE_PORT ?? '5463'}/`);
const DAY = 86_400_000;
const MIN = 60_000;
let fx: Fixture;
let payerId: string;

const ENV_KEYS = ['OUTBOUND_COORDINATOR', 'OUTBOUND_COALESCE_MINUTES', 'JOURNEY_QUIET_HOURS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // 이 파일은 통합 발송 관리가 켜진 상태를 기준으로 검증한다(off 검증은 해당 테스트에서 명시적으로 끈다). 전체를 OUTBOUND_COORDINATOR=off 로 돌려도 같은 결과.
  process.env.OUTBOUND_COORDINATOR = 'on';
  await resetDb();
  fx = await seedBasics();
  registerDefaultConsumers();
  payerId = (await seedRegisteredPayer(fx.payerPhone)).id;
  await prisma.payerMerchantLink.create({ data: { id: newId(), payerId, merchantId: fx.merchantId } });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setMockMtFailure(null);
});

/** 낮 12시(KST) 기준 시각 — 야간 보류에 걸리지 않게 */
function noonKst(offsetDays = 0) {
  const d = new Date();
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate() + offsetDays, 3, 0, 0));
}

async function journeyLog(stepKey: string, opts: { sent?: boolean; at?: Date } = {}) {
  const run = await prisma.journeyRun.create({
    data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'donation-thanks', triggerKey: `t:${newId()}`, payerId, status: 'DONE' },
  });
  const key = `journey:${run.id}:${stepKey}`;
  await prisma.journeyStepLog.create({
    data: { id: newId(), runId: run.id, stepIndex: 2, stepKey, outcome: 'DONE', sent: opts.sent ?? true, dedupeKey: key, merchantId: fx.merchantId, payerId, at: opts.at ?? new Date() },
  });
  return { runId: run.id, key };
}

async function issuedDoc(purpose = 'THANKS_LETTER') {
  return prisma.issuedDocument.create({
    data: {
      id: newId(), merchantId: fx.merchantId, payerId, purpose, templateId: 'tpl', templateRevision: 'rev', title: '감사장',
      snapshotEnc: encrypt('{}'), contentHash: 'h', dedupeKey: `doc:${newId()}`, status: 'ISSUED',
    },
  });
}

const merchantName = async () => (await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId } })).displayName;

// ---------------------------------------------------------------------------
describe('[D2-1] 발송 분류표', () => {
  it('관계·정보형만 조정 대상이고, 결제·인증·서명·복구 안내는 거래·요청형이다', () => {
    expect(isRelationalTemplate('MONTHLY_NOTICE')).toBe(true);
    expect(isRelationalTemplate('RECEIPT_INFO_REQUEST')).toBe(true);
    expect(isRelationalTemplate('VOLUNTEER_THANKS')).toBe(true);
    for (const t of ['CHARGE_SUCCESS', 'PIN_REQUEST', 'SELECT_AMOUNT', 'EDOC_SIGN_REQUEST', 'EDOC_SIGN_VERIFY', 'RECURRING_FAILED', 'RECURRING_ACCOUNT_PROBLEM', 'RECURRING_RESUME_GUIDE', 'VOLUNTEER_REMINDER', 'PLEDGE_LINK', 'PAYMENT_VERIFY']) {
      expect(isRelationalTemplate(t)).toBe(false);
    }
    expect(kindOfDocumentPurpose('THANKS_LETTER')).toBe('THANKS_LETTER');
    expect(kindOfDocumentPurpose('SUPPORT_AGREEMENT')).toBeNull();
    expect(kindOfJourneyStep('receipt-info')).toBe('RECEIPT_INFO');
    expect(kindOfJourneyStep('reminder')).toBeNull();
    expect(kindOfJourneyStep('resume-guide')).toBeNull();
  });
});

describe('[D2-2] 합치기', () => {
  it('같은 후원자의 정보성 안내 2건(감사장 링크 + 영수증 정보 안내)이 대기 시간 안이면 한 통으로 나가고, 결과가 원래 기록에 연결된다', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    const now = noonKst();
    const name = await merchantName();
    const j = await journeyLog('receipt-info');
    const doc = await issuedDoc();
    const a = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/my/receipts' }), sendKey: j.key, source: 'journey', sourceId: j.runId, precounted: true, now });
    const b = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'THANKS_LETTER', template: tpl.tplDocumentIssued({ merchantName: name, title: '감사장', link: 'http://localhost/l/abcdefghijklmnopqrstuvwxyz' }), sendKey: `issued:${doc.id}`, source: 'issued_document', sourceId: doc.id, precounted: true, now: new Date(now.getTime() + 3 * MIN) });
    expect(a.mode).toBe('queued');
    expect(b.mode).toBe('queued');
    expect(readMockOutbox(10)).toHaveLength(0);

    // 대기 시간 전에는 보내지 않는다
    expect((await flushDueOutbound({ now: new Date(now.getTime() + 5 * MIN) })).messages).toBe(0);
    const r = await flushDueOutbound({ now: new Date(now.getTime() + 14 * MIN) });
    expect(r.messages).toBe(1);
    const out = readMockOutbox(10);
    expect(out).toHaveLength(1);
    expect(out[0]!.template).toBe(OUTBOUND_BUNDLE_TEMPLATE);
    expect(out[0]!.text).toContain('안내 2건');
    expect(out[0]!.text).toContain('주민등록번호 등록');
    expect(out[0]!.text).toContain('감사장');
    // 우선순위 높은 영수증 안내가 먼저
    expect(out[0]!.text.indexOf('주민등록번호')).toBeLessThan(out[0]!.text.indexOf('감사장을'));

    const items = await prisma.outboundQueue.findMany({ orderBy: { priority: 'desc' } });
    expect(items.map((i) => i.status)).toEqual(['SENT', 'SENT']);
    expect(items[0]!.mtMessageId).toBeTruthy();
    expect(items[0]!.mtMessageId).toBe(items[1]!.mtMessageId);
    expect(items[0]!.bundleId).toBe(items[1]!.bundleId);
    expect(items.every((i) => i.templateEnc === null)).toBe(true);
    const mt = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id: items[0]!.mtMessageId! } });
    expect(mt.templateCode).toBe(OUTBOUND_BUNDLE_TEMPLATE);
    expect(mt.bodyMasked).not.toContain('abcdefghijklmnopqrstuvwxyz'); // 링크 토큰은 마스킹
    // 원천 연결: 저니 단계 기록 · 발급 문서
    const log = await prisma.journeyStepLog.findUniqueOrThrow({ where: { dedupeKey: j.key } });
    expect(log).toMatchObject({ outcome: 'DONE', sent: true });
    expect(log.detail).toMatch(/묶음 발송\(2건/);
    const d = await prisma.issuedDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(d.sentAt).not.toBeNull();
    expect(d.sendCount).toBe(1);
    // 다시 돌려도 더 보내지 않는다
    expect((await flushDueOutbound({ now: new Date(now.getTime() + 30 * MIN) })).messages).toBe(0);
    expect(readMockOutbox(10)).toHaveLength(1);
  });

  it('같은 발송 키는 한 번만 쌓이고, 대기 0 이면 안내 1건은 원래 템플릿 그대로 바로 나간다', async () => {
    const name = await merchantName();
    const t = tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/my/receipts' });
    const r1 = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: t, sendKey: 'k1', source: 'journey', precounted: true });
    const r2 = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: t, sendKey: 'k1', source: 'journey', precounted: true });
    expect(r1).toMatchObject({ mode: 'direct', ok: true });
    expect(r2).toMatchObject({ mode: 'direct', ok: true });
    const out = readMockOutbox(10);
    expect(out).toHaveLength(1);
    expect(out[0]!.template).toBe('RECEIPT_INFO_REQUEST');
    expect(out[0]!.text).toBe(t.text);
    expect(await prisma.outboundQueue.count()).toBe(1);
  });

  it('묶음 본문이 LMS 길이를 넘으면 둘로 나눈다', () => {
    const long = (i: number) => ({ template: { code: 'MONTHLY_NOTICE' as const, text: `[기브싸인] ${'가'.repeat(380)} ${i}`, masked: 'x' } });
    const groups = splitBundles('햇살복지관', [long(1), long(2), long(3), long(4)]);
    expect(groups.length).toBeGreaterThanOrEqual(2);
    expect(groups.flat()).toHaveLength(4);
    for (const g of groups) {
      if (g.length < 2) continue;
      const text = ['[기브싸인] 햇살복지관 안내', ...g.map((x) => x.template.text)].join('\n');
      expect(lmsBytes(text)).toBeLessThanOrEqual(OUTBOUND_BUNDLE_MAX_BYTES + 40);
    }
  });

  it('대기 0 에서 발송이 실패하면 호출부가 재시도할 수 있게 실패를 돌려주고, 다시 부르면 같은 행으로 보낸다', async () => {
    const name = await merchantName();
    const t = tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/my/receipts' });
    setMockMtFailure('장애');
    const r1 = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: t, sendKey: 'retry-key', source: 'journey', precounted: true });
    expect(r1).toMatchObject({ mode: 'direct', ok: false });
    setMockMtFailure(null);
    const r2 = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: t, sendKey: 'retry-key', source: 'journey', precounted: true });
    expect(r2).toMatchObject({ mode: 'direct', ok: true });
    expect(await prisma.outboundQueue.count()).toBe(1);
    expect(readMockOutbox(10)).toHaveLength(1);
  });
});

describe('[D2-2] 거래·요청형은 대기열을 거치지 않는다', () => {
  it('묶음 대기를 켜도 결제 완료 안내는 바로 나가고 대기열에 쌓이지 않는다', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    setChargeAmount(10000n);
    await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: '후원' }), fx.merchantId);
    setChargeAmount(null);
    expect(readMockOutbox(20).some((m) => m.template === 'CHARGE_SUCCESS')).toBe(true);
    expect(await prisma.outboundQueue.count()).toBe(0);
    // 결제 실패·복구 같은 거래형 직접 발송도 마찬가지
    await sendMtForPayer(payerId, tpl.tplRecurringFailed({ merchantName: '기관', amount: 10000n, retryDate: '2026-11-12' }), null, fx.merchantId).catch(() => undefined);
    expect(await prisma.outboundQueue.count()).toBe(0);
  });
});

describe('[D2-3] 7일 상한·우선순위', () => {
  it('상한에 한 자리만 남으면 우선순위 높은 안내만 보내고 낮은 것(월간 안내)은 하루 보류, 3번 보류되면 건너뛰고 기록한다', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    const now = noonKst();
    await journeyLog('thanks-letter');
    await journeyLog('volunteer-thanks-msg');
    expect(await relationalCapCount(prisma, fx.merchantId, payerId, now)).toBe(2);
    const name = await merchantName();
    await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'MONTHLY_NOTICE', template: tpl.tplMonthlyNotice({ merchantName: name, month: '2026-10', amount: 1000n, count: 1, yearTotal: 1000n, link: 'http://localhost/my/receipts' }), sendKey: 'notice:x', source: 'notice', precounted: false, now });
    await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/my/receipts' }), sendKey: 'ri:x', source: 'journey', precounted: false, now });
    await flushDueOutbound({ now: new Date(now.getTime() + 11 * MIN) });
    const out = readMockOutbox(10);
    expect(out).toHaveLength(1);
    expect(out[0]!.template).toBe('RECEIPT_INFO_REQUEST');
    let monthly = await prisma.outboundQueue.findUniqueOrThrow({ where: { sendKey: 'notice:x' } });
    expect(monthly).toMatchObject({ status: 'QUEUED', deferrals: 1 });
    expect(monthly.lastReason).toMatch(/7일 3건/);
    expect(monthly.dueAt.getTime()).toBeGreaterThan(now.getTime() + DAY - MIN);
    // 이제 3건 — 보낸 안내도 상한에 센다(저니 상한 함수와 통합)
    expect(await relationalCapCount(prisma, fx.merchantId, payerId, new Date(now.getTime() + 12 * MIN))).toBe(3);
    for (let d = 1; d <= 3; d += 1) await flushDueOutbound({ now: new Date(now.getTime() + d * DAY + 12 * MIN) });
    monthly = await prisma.outboundQueue.findUniqueOrThrow({ where: { sendKey: 'notice:x' } });
    expect(monthly.status).toBe('SKIPPED');
    expect(monthly.lastReason).toMatch(/3번 보류되어 건너뜀/);
    expect(readMockOutbox(10)).toHaveLength(1);
  });

  it('저니 발송 예약도 대기열에서 보낸 정보성 안내(월간 안내)를 7일 상한에 함께 센다', async () => {
    await prisma.outboundQueue.createMany({
      data: [1, 2, 3].map((i) => ({
        id: newId(), merchantId: fx.merchantId, payerId, kind: 'MONTHLY_NOTICE', priority: 1, sendKey: `n:${i}`, source: 'notice', precounted: false,
        templateCode: 'MONTHLY_NOTICE', bodyMasked: 'x', status: 'SENT', dueAt: new Date(), sentAt: new Date(),
      })),
    });
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION' },
    });
    setChargeAmount(10000n);
    await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: '후원' }), fx.merchantId);
    setChargeAmount(null);
    await processDomainEvents();
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + MIN) });
    const run = await prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: 'donation-thanks' }, include: { logs: true } });
    expect(run.logs.some((l) => l.outcome === 'BLOCKED' && /7일 3건/.test(l.detail ?? ''))).toBe(true);
    expect(readMockOutbox(20).some((m) => m.template === 'RECEIPT_INFO_REQUEST')).toBe(false);
  });
});

describe('[D2-3] 야간 보류', () => {
  it('21~9시(KST)에는 보내지 않고 다음 날 9시로 미룬다(보류 횟수에 넣지 않음)', async () => {
    process.env.JOURNEY_QUIET_HOURS = 'on';
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    const name = await merchantName();
    const evening = new Date(noonKst().getTime() + 9 * 3_600_000 + 30 * MIN); // KST 21:30
    const r = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/x' }), sendKey: 'night', source: 'journey', precounted: true, now: evening });
    expect(r.mode).toBe('queued');
    const item = await prisma.outboundQueue.findUniqueOrThrow({ where: { sendKey: 'night' } });
    const kst = new Date(item.dueAt.getTime() + 9 * 3_600_000);
    expect(kst.getUTCHours()).toBe(9);
    // 억지로 기한을 당겨도 밤이면 보내지 않는다
    await prisma.outboundQueue.update({ where: { id: item.id }, data: { dueAt: evening } });
    await flushDueOutbound({ now: new Date(evening.getTime() + 20 * MIN) });
    const after = await prisma.outboundQueue.findUniqueOrThrow({ where: { id: item.id } });
    expect(after).toMatchObject({ status: 'QUEUED', deferrals: 0, lastReason: '야간 발송 보류' });
    expect(readMockOutbox(5)).toHaveLength(0);
    await flushDueOutbound({ now: new Date(after.dueAt.getTime() + MIN) });
    expect(readMockOutbox(5)).toHaveLength(1);
  });
});

describe('[D2-2] 동시 배치', () => {
  it.skipIf(singleBackend)('배치 두 개가 겹쳐 돌아도 같은 대기분은 한 번만 나간다', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    const now = noonKst();
    const name = await merchantName();
    await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/x' }), sendKey: 'c1', source: 'journey', precounted: true, now });
    await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'VOLUNTEER_THANKS', template: tpl.tplVolunteerThanks({ merchantName: name, totalHours: 3 }), sendKey: 'c2', source: 'journey', precounted: true, now });
    const later = new Date(now.getTime() + 11 * MIN);
    const [a, b] = await Promise.all([flushDueOutbound({ now: later }), flushDueOutbound({ now: later })]);
    expect(a.messages + b.messages).toBe(1);
    expect(readMockOutbox(10)).toHaveLength(1);
    expect(await prisma.outboundQueue.count({ where: { status: 'SENT' } })).toBe(2);
  });
});

async function paidInOctober() {
  setChargeAmount(10000n);
  await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: '후원' }), fx.merchantId);
  setChargeAmount(null);
  await prisma.charge.updateMany({ where: { payerId }, data: { paidAt: new Date(Date.UTC(2026, 9, 10, 3)) } });
  // 결제 완료 안내는 이 검증과 무관하다
  const { clearMockOutbox } = await import('@/server/adapters/mt');
  clearMockOutbox();
}

describe('[D2-2] OUTBOUND_COORDINATOR=off', () => {
  it('끄면 대기열 없이 지금 경로 그대로 바로 보낸다(저니·월간 안내 포함)', async () => {
    process.env.OUTBOUND_COORDINATOR = 'off';
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    const name = await merchantName();
    const r = await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/x' }), sendKey: 'off1', source: 'journey', precounted: true });
    expect(r).toMatchObject({ mode: 'direct', ok: true });
    // 월간 안내: 지난달 후원 1건
    await paidInOctober();
    const n = await runMerchantNoticeDetailed(fx.merchantId, '2026-10');
    expect(await prisma.outboundQueue.count()).toBe(0);
    expect(n.run!.recipientCount).toBe(1);
    expect(n.run!.sentCount).toBe(1);
    const d = await prisma.noticeDelivery.findFirstOrThrow({});
    expect(d.status).toBe('SENT');
  });

  it('켜져 있으면 월간 안내는 대기열에 쌓이고(QUEUED), 보낸 뒤 기록·실행 집계가 맞춰진다', async () => {
    process.env.OUTBOUND_COALESCE_MINUTES = '10';
    await paidInOctober();
    const n = await runMerchantNoticeDetailed(fx.merchantId, '2026-10');
    expect(n.outcome).toBe('RAN');
    const d = await prisma.noticeDelivery.findFirstOrThrow({});
    expect(d.status).toBe('QUEUED');
    expect(n.run!.sentCount).toBe(0);
    expect(readMockOutbox(5).some((m) => m.template === 'MONTHLY_NOTICE')).toBe(false);
    const item = await prisma.outboundQueue.findUniqueOrThrow({ where: { sendKey: `notice:${d.id}` } });
    await flushDueOutbound({ now: new Date(Math.max(item.dueAt.getTime(), noonKst().getTime()) + MIN) });
    const after = await prisma.noticeDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe('SENT');
    expect(after.mtMessageId).toBeTruthy();
    const run = await prisma.noticeRun.findUniqueOrThrow({ where: { id: d.noticeRunId } });
    expect(run.sentCount).toBe(1);
  });
});

describe('[D2-4] 선호 채널', () => {
  it('알림톡 우선이 기본이고, 문자만(SMS)을 고른 후원자에게는 알림톡 대신 문자로 보낸다', async () => {
    await saveAlimtalkChannel(fx.merchantId, { channelId: '@테스트복지관', senderKey: 'KA01PF2611060000000000ab', templateCodes: { RECEIPT_INFO_REQUEST: 'KA01TP_RI_01' } });
    await setAlimtalkChannelStatus(fx.merchantId, 'ACTIVE', 'admin');
    const t = tpl.tplReceiptInfoRequest({ merchantName: '기관', link: 'http://localhost/x' });
    const a = await sendMtDetailed({ phone: fx.payerPhone, template: t, merchantId: fx.merchantId });
    expect(a.channel).toBe('ALIMTALK');
    await prisma.payerProfile.update({ where: { id: payerId }, data: { preferredChannel: 'SMS' } });
    const b = await sendMtDetailed({ phone: fx.payerPhone, template: t, merchantId: fx.merchantId });
    expect(b).toMatchObject({ ok: true, channel: 'SMS', fallback: false });
  });
});

describe('[D2-5] 알림톡 결과 미확인 — 문자로 다시 보내기(수동 1회)', () => {
  async function unknownRow() {
    const id = newId();
    await prisma.mtOutboundMessage.create({
      data: {
        id, phoneHash: (await prisma.payerProfile.findUniqueOrThrow({ where: { id: payerId } })).phoneHash, phoneEnc: encrypt(fx.payerPhone), phoneMasked: '010-****-5678',
        fromNumber: '15880000', templateCode: 'RECEIPT_INFO_REQUEST', bodyMasked: '안내', merchantId: fx.merchantId, channel: 'ALIMTALK',
        status: 'ACCEPTED', acceptedAt: new Date(Date.now() - 3 * 3_600_000), bodyEnc: encrypt('[기브싸인] 영수증 정보 안내 원문'),
      },
    });
    await processAlimtalkReports(new Date(Date.now() + ALIMTALK_REPORT_TIMEOUT_MS));
    return id;
  }

  it('UNKNOWN 으로 닫을 때 원래 규칙(자동 재발송 없음·body_enc 삭제)은 그대로, 수동 재발송용 본문만 옮겨 둔다', async () => {
    const id = await unknownRow();
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'UNKNOWN', bodyEnc: null });
    expect(row.resendBodyEnc).toBeTruthy();
    expect(readMockOutbox(5)).toHaveLength(0);
    const list = await listUnknownAlimtalk(fx.merchantId);
    expect(list[0]).toMatchObject({ id, canResend: true });
  });

  it('담당자가 누르면 문자로 한 번만 보낸다(동시 클릭 1회, 다른 기관은 못 보냄)', async () => {
    const id = await unknownRow();
    await expect(resendUnknownAsSms('other-merchant', id)).rejects.toThrow();
    const results = await Promise.allSettled([resendUnknownAsSms(fx.merchantId, id), resendUnknownAsSms(fx.merchantId, id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const out = readMockOutbox(5);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('[기브싸인] 영수증 정보 안내 원문');
    const row = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('UNKNOWN');
    expect(row.resendBodyEnc).toBeNull();
    expect(row.manualResendId).toBeTruthy();
    const fresh = await prisma.mtOutboundMessage.findUniqueOrThrow({ where: { id: row.manualResendId! } });
    expect(fresh).toMatchObject({ status: 'SENT', channel: 'SMS', fallback: true });
    await expect(resendUnknownAsSms(fx.merchantId, id)).rejects.toThrow(/이미 다시 보냈/);
  });
});

describe('[D2-5] 상태 5단계 집계', () => {
  it('요청→접수→전달과 열람(문서 첫 열람)·완료(영수증 정보 등록)를 기존 기록에서 센다', async () => {
    const name = await merchantName();
    const doc = await issuedDoc();
    await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'THANKS_LETTER', template: tpl.tplDocumentIssued({ merchantName: name, title: '감사장', link: 'http://localhost/l/x' }), sendKey: `issued:${doc.id}`, source: 'issued_document', sourceId: doc.id, precounted: true });
    await prisma.issuedDocument.update({ where: { id: doc.id }, data: { sentAt: new Date(), firstViewedAt: new Date() } });
    await sendRelational({ merchantId: fx.merchantId, payerId, kind: 'RECEIPT_INFO', template: tpl.tplReceiptInfoRequest({ merchantName: name, link: 'http://localhost/x' }), sendKey: 'ri-stat', source: 'journey', precounted: true });
    await new Promise((r) => setTimeout(r, 5));
    await prisma.payerReceiptProfile.create({ data: { payerId, legalName: '홍길동', residentNoEnc: encrypt('9001011234567'), residentNoHash: newId(), residentNoMasked: '900101-1******' } });
    const s = await noticeStageStats(fx.merchantId);
    const docRow = s.rows.find((r) => r.key === 'DOCUMENT')!;
    expect(docRow).toMatchObject({ requested: 1, accepted: 1, delivered: 1, opened: 1, completed: null });
    const ri = s.rows.find((r) => r.key === 'RECEIPT_INFO')!;
    expect(ri).toMatchObject({ requested: 1, delivered: 1, opened: null, completed: 1, completionRate: 100 });
    expect(s.rows.find((r) => r.key === 'MONTHLY_NOTICE')!.completionRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('[D1] 다음 업무 판단 — 우선순위 표', () => {
  const base: NextActionFacts = {
    withdrawn: false, blocked: false, optOut: false, openInquiry: false, refundInProgress: false, paidCount: 3,
    firstPaidAt: new Date('2025-01-01'), lastPaidAt: new Date('2026-11-01T03:00:00Z'), recurring: null, signPending: null, receiptProfile: false,
    receiptInfoSentAt: null, thanksSent: true, volunteerPending: false, lastContactAt: null, runs: [],
  };
  const nov = new Date('2026-11-09T03:00:00Z');
  const jan = new Date('2027-01-15T03:00:00Z');

  it('환불·문의 > 정기 출금 조치 > 서명 > 영수증 정보 > 첫 후원 감사 > 없음', () => {
    const all: NextActionFacts = {
      ...base, refundInProgress: true, recurring: { status: 'ACTIVE', recoveryState: 'ACTION_REQUIRED', actionDeadlineOn: new Date('2026-11-20'), nextChargeOn: new Date('2026-11-20') },
      signPending: { since: new Date('2026-11-01') }, thanksSent: false, firstPaidAt: new Date('2026-11-01'),
    };
    const ctx = { issuer: true, now: nov };
    expect(decideNextAction(all, ctx).key).toBe('STAFF_CHECK');
    expect(decideNextAction({ ...all, refundInProgress: false }, ctx).key).toBe('RECURRING_ACTION');
    expect(decideNextAction({ ...all, refundInProgress: false, recurring: null }, ctx).key).toBe('SIGN_PENDING');
    expect(decideNextAction({ ...all, refundInProgress: false, recurring: null, signPending: null }, ctx).key).toBe('RECEIPT_INFO');
    expect(decideNextAction({ ...all, refundInProgress: false, recurring: null, signPending: null, receiptProfile: true }, ctx).key).toBe('FIRST_THANKS');
    expect(decideNextAction({ ...base, receiptProfile: true }, ctx).key).toBe('NONE');
    expect(decideNextAction({ ...base, openInquiry: true }, ctx)).toMatchObject({ key: 'STAFF_CHECK', autoHandled: false });
  });

  it('1~2월에는 영수증 정보 미등록이 서명 미완료보다 앞선다(가중), 지난해 후원자도 대상', () => {
    expect(nextActionOrder(nov).indexOf('SIGN_PENDING')).toBeLessThan(nextActionOrder(nov).indexOf('RECEIPT_INFO'));
    expect(nextActionOrder(jan).indexOf('RECEIPT_INFO')).toBeLessThan(nextActionOrder(jan).indexOf('SIGN_PENDING'));
    const f = { ...base, signPending: { since: new Date('2027-01-01') }, lastPaidAt: new Date('2026-12-20T03:00:00Z') };
    expect(decideNextAction(f, { issuer: true, now: jan }).key).toBe('RECEIPT_INFO');
    expect(decideNextAction(f, { issuer: true, now: nov }).key).toBe('SIGN_PENDING');
  });

  it('영수증 발급 기관이 아니거나 수신 거부면 영수증 안내·감사 판단을 하지 않는다', () => {
    expect(decideNextAction(base, { issuer: false, now: nov }).key).toBe('NONE');
    expect(decideNextAction({ ...base, optOut: true }, { issuer: true, now: nov }).key).toBe('NONE');
  });

  it('저니가 처리 중이면 "자동 처리 중(다음 실행 M/D)" 이고 담당자 할 일로 세지 않는다', () => {
    const due = new Date('2026-11-10T00:00:00Z');
    const a = decideNextAction({ ...base, runs: [{ handles: 'RECEIPT_INFO', dueAt: due, status: 'WAITING' }] }, { issuer: true, now: nov });
    expect(a).toMatchObject({ key: 'RECEIPT_INFO', autoHandled: true });
    expect(a.reason).toMatch(/자동 처리 중\(다음 실행 11\/10\)/);
    expect(needsStaff(a)).toBe(false);
    const sent = decideNextAction({ ...base, receiptInfoSentAt: new Date('2026-10-01T03:00:00Z') }, { issuer: true, now: nov });
    expect(sent).toMatchObject({ key: 'RECEIPT_INFO', autoHandled: true });
    const retry = decideNextAction({ ...base, receiptProfile: true, recurring: { status: 'ACTIVE', recoveryState: 'RETRYING', actionDeadlineOn: null, nextChargeOn: new Date('2026-11-11') } }, { issuer: true, now: nov });
    expect(retry).toMatchObject({ key: 'RECURRING_ACTION', autoHandled: true });
    expect(retry.reason).toMatch(/11\/11/);
  });

  it('탈퇴·차단 후원자는 할 일 없음', () => {
    expect(decideNextAction({ ...base, withdrawn: true, refundInProgress: true }, { issuer: true, now: nov }).key).toBe('NONE');
    expect(decideNextAction({ ...base, blocked: true }, { issuer: true, now: nov }).key).toBe('NONE');
  });
});

describe('[D1] 다음 업무 판단 — DB 연동', () => {
  async function pay() {
    setChargeAmount(10000n);
    await inboundAndPay(moPayload({ from: fx.payerPhone, to: fx.moNumber, text: '후원' }), fx.merchantId);
    setChargeAmount(null);
    return prisma.charge.findFirstOrThrow({ where: { payerId }, orderBy: { createdAt: 'desc' } });
  }

  it('진행 중 환불이 있으면 담당자 확인, 열린 문의도 담당자 확인 — 목록 계산과 상세 계산이 같다', async () => {
    const c = await pay();
    await prisma.refund.create({ data: { id: newId(), chargeId: c.id, amount: c.amount, status: 'REQUESTED' } });
    expect(await autoPauseReason(fx.merchantId, payerId)).toMatch(/환불/);
    const one = await nextActionForPayer(fx.merchantId, payerId);
    expect(one.key).toBe('STAFF_CHECK');

    // 다른 후원자: 열린 문의(결제 건으로 연결)
    const other = await seedRegisteredPayer('01099998888');
    setChargeAmount(10000n);
    await inboundAndPay(moPayload({ from: '01099998888', to: fx.moNumber, text: '후원' }), fx.merchantId);
    setChargeAmount(null);
    const oc = await prisma.charge.findFirstOrThrow({ where: { payerId: other.id } });
    await prisma.supportInquiry.create({ data: { id: newId(), merchantId: fx.merchantId, chargeId: oc.id, status: 'OPEN' } });
    const many = await nextActionsForMerchant(fx.merchantId, [payerId, other.id, 'missing']);
    expect(many.get(payerId)!.key).toBe('STAFF_CHECK');
    expect(many.get(other.id)!.key).toBe('STAFF_CHECK');
    expect(many.get(other.id)!.reason).toMatch(/문의/);
    expect(many.get('missing')!.key).toBe('NONE');
  });

  it('열린 문의·진행 중 환불이 있으면 정보성 저니 단계(영수증 정보 안내)를 하루씩 보류한다', async () => {
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION' },
    });
    const c = await pay();
    await processDomainEvents();
    await prisma.refund.create({ data: { id: newId(), chargeId: c.id, amount: 1000n, status: 'REQUESTED' } });
    await advanceDueJourneyRuns({ now: new Date(Date.now() + DAY + MIN) });
    const run = await prisma.journeyRun.findFirstOrThrow({ where: { journeyKey: 'donation-thanks' }, include: { logs: true } });
    expect(run.status).toBe('WAITING');
    expect(run.logs.some((l) => l.stepKey === 'receipt-info' && l.outcome === 'BLOCKED' && /담당자 확인 전 자동 안내 보류/.test(l.detail ?? ''))).toBe(true);
    expect(readMockOutbox(20).some((m) => m.template === 'RECEIPT_INFO_REQUEST')).toBe(false);
    // 환불이 끝나면(진행 중 아님) 다음 실행에서 나간다
    await prisma.refund.updateMany({ data: { status: 'REJECTED' } });
    await advanceDueJourneyRuns({ now: new Date(Date.now() + 2 * DAY + 2 * MIN) });
    expect(readMockOutbox(20).some((m) => m.template === 'RECEIPT_INFO_REQUEST')).toBe(true);
  });

  it('후원자가 많아도 기관 단위로 한꺼번에 계산한다(후원자 수와 무관한 쿼리 수)', async () => {
    const ids: string[] = [payerId];
    for (let i = 0; i < 15; i += 1) {
      const p = await seedRegisteredPayer(`0107000${String(1000 + i)}`);
      await prisma.payerMerchantLink.create({ data: { id: newId(), payerId: p.id, merchantId: fx.merchantId } });
      ids.push(p.id);
    }
    const spy = vi.spyOn(prisma.payerProfile, 'findMany');
    const res = await nextActionsForMerchant(fx.merchantId, ids);
    expect(res.size).toBe(ids.length);
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });
});
