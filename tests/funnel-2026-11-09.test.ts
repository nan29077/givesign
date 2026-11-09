import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { phoneHash } from '@/lib/crypto';
import { mockMoAdapter } from '@/server/adapters/mo';
import { campaignSchema } from '@/lib/fundraising';
import { handleMoInbound } from '@/server/services/charge-flow';
import { completePinAuthorization, expireStalePinSessions } from '@/server/services/pin-authorization';
import { createWebCharge } from '@/server/services/web-charge';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import { confirmChargeAmount } from '@/server/services/charge-select';
import { failureReasonOf, recordFunnelLinkOpened, recordFunnelStep } from '@/server/services/funnel';
import { funnelReport } from '@/server/services/funnel-report';
import {
  inboundAndPay,
  lastSelectAmountToken,
  moPayload,
  resetDb,
  seedBasics,
  seedRegisteredPayer,
  selectChargeAmount,
  setChargeAmount,
  type Fixture,
} from './helpers';

/**
 * 2026-11-09 B1 — MO 문자후원 단계별 이탈 측정.
 *  단계 순서 · 처음 도달만(중복 미계산) · 링크 미리보기 봇 제외 · 기록 실패에도 결제 정상 · 끝 상태 이유 · 웹 채널 · 집계 전환율.
 */

let fx: Fixture;
const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0';
const since = () => new Date(Date.now() - 86_400_000);

async function steps(flowKey?: string) {
  return prisma.funnelStep.findMany({ where: flowKey ? { flowKey } : {}, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
});

afterEach(() => {
  vi.restoreAllMocks();
  setChargeAmount(null);
});

describe('단계 기록', () => {
  it('문자 수신 → 회신 → 링크 열람 → 금액 선택 → 인증 시작 → 완료를 순서대로 한 흐름으로 남긴다(개인정보 없음)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const mo = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber, text: '응원합니다 010-9999-8888' })));
    expect(mo.status).toBe('PENDING_AMOUNT');
    const flowKey = `mo:${mo.moMessageId}`;
    expect((await steps(flowKey)).map((s) => s.step)).toEqual(['MO_RECEIVED', 'REPLY_SENT']);

    expect(await recordFunnelLinkOpened(mo.chargeId!, HUMAN_UA)).toBe(true);
    expect(await recordFunnelLinkOpened(mo.chargeId!, HUMAN_UA)).toBe(false); // 다시 열어도 세지 않는다
    const sel = await selectChargeAmount(fx.merchantId);
    expect(sel.ok).toBe(true);
    const session = await prisma.paymentPinSession.findUniqueOrThrow({ where: { chargeId: mo.chargeId! } });
    await completePinAuthorization({ sessionId: session.sessionId });

    const rows = await steps(flowKey);
    expect(rows.map((s) => s.step)).toEqual(['MO_RECEIVED', 'REPLY_SENT', 'LINK_OPENED', 'AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID']);
    expect(rows.every((r) => r.channel === 'MO' && r.merchantId === fx.merchantId && r.chargeId === mo.chargeId)).toBe(true);
    // 개인정보 원문(전화·본문)이 어디에도 없다
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('9999');
    expect(dump).not.toContain('01012345678');
    expect(dump).not.toContain(phoneHash(fx.payerPhone));

    const report = await funnelReport({ merchantId: fx.merchantId, since: since() });
    expect(report.steps.map((s) => s.count)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(report.steps.every((s) => s.rateFromStart === 100)).toBe(true);
    expect(report.biggestDrop).toBeNull();
    expect(report.sentence).toBeNull();
  });

  it('링크 미리보기 수집기(카카오·네이버·빈 UA)는 링크 열람으로 세지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const mo = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber })));
    for (const ua of ['kakaotalk-scrap/1.0; +https://devtalk.kakao.com/', 'Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)', 'facebookexternalhit/1.1', '', null]) {
      expect(await recordFunnelLinkOpened(mo.chargeId!, ua)).toBe(false);
    }
    expect(await prisma.funnelStep.count({ where: { step: 'LINK_OPENED' } })).toBe(0);
    expect(await recordFunnelLinkOpened(mo.chargeId!, HUMAN_UA)).toBe(true);
  });

  it('같은 단계를 동시에 여러 번 기록해도 한 행이다 / 중복 수신 문자는 새 흐름을 만들지 않는다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const payload = moPayload({ to: fx.moNumber, messageId: 'MO-FUNNEL-DUP' });
    const mo = await handleMoInbound(mockMoAdapter.parse(payload));
    const results = await Promise.all(Array.from({ length: 6 }, () => recordFunnelLinkOpened(mo.chargeId!, HUMAN_UA)));
    expect(results.filter(Boolean)).toHaveLength(1);
    const dup = await handleMoInbound(mockMoAdapter.parse(payload));
    expect(dup.result).toBe('DUPLICATE');
    expect(await prisma.funnelStep.count({ where: { step: 'MO_RECEIVED' } })).toBe(1);
    expect(await prisma.funnelStep.count({ where: { step: 'LINK_OPENED' } })).toBe(1);
  });

  it('미등록 번호는 문자 수신 → 끝(결제수단 미등록)으로 남고, 문장이 가장 많이 끊기는 곳을 알려 준다', async () => {
    const mo = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber })));
    expect(mo.result).toBe('UNREGISTERED_DONOR');
    const rows = await steps(`mo:${mo.moMessageId}`);
    expect(rows.map((r) => [r.step, r.reason])).toEqual([['MO_RECEIVED', null], ['BLOCKED', 'UNREGISTERED']]);
    const report = await funnelReport({ merchantId: fx.merchantId, since: since() });
    expect(report.total).toBe(1);
    expect(report.ends).toEqual([{ step: 'BLOCKED', reason: 'UNREGISTERED', label: '결제수단 미등록', count: 1 }]);
    expect(report.sentence).toBe('문자를 보낸 사람의 100%가 안내 문자를 받기 전에 나갔습니다.');
  });

  it('끝 상태 이유: 결제 실패 · 한도(차단) · PIN 시간 만료를 나눠 남긴다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    // 결제 실패 (mock: 끝자리 999 거절)
    setChargeAmount(10999n);
    const failed = await inboundAndPay(moPayload({ to: fx.moNumber }), fx.merchantId);
    expect(failed.status).toBe('PAYMENT_FAILED');
    expect((await prisma.funnelStep.findFirstOrThrow({ where: { chargeId: failed.chargeId!, step: 'FAILED' } })).reason).toBe('PAYMENT_FAILED');
    setChargeAmount(null);

    // PIN 시간 만료
    const pending = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber })));
    await selectChargeAmount(fx.merchantId);
    await expireStalePinSessions(new Date(Date.now() + 3600_000));
    expect((await prisma.funnelStep.findFirstOrThrow({ where: { chargeId: pending.chargeId!, step: 'FAILED' } })).reason).toBe('EXPIRED');

    // 기관이 차단한 후원자 → 한도·차단
    await prisma.blockedPayer.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, reason: '테스트' } });
    const blocked = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber })));
    expect(blocked.status).toBe('LIMIT_BLOCKED');
    expect((await prisma.funnelStep.findFirstOrThrow({ where: { chargeId: blocked.chargeId!, step: 'BLOCKED' } })).reason).toBe('LIMIT');

    expect(failureReasonOf('PAYMENT_FAILED', '금액 선택 시간 초과로 자동 취소')).toEqual({ step: 'FAILED', reason: 'EXPIRED' });
    expect(failureReasonOf('UNREGISTERED', null)).toEqual({ step: 'BLOCKED', reason: 'UNREGISTERED' });
    expect(failureReasonOf('CONTENT_BLOCKED', null)).toEqual({ step: 'BLOCKED', reason: 'CONTENT_BLOCKED' });
    expect(failureReasonOf('PENDING_PAYMENT', null)).toBeNull();

    const report = await funnelReport({ merchantId: fx.merchantId, since: since() });
    const byReason = Object.fromEntries(report.ends.map((e) => [e.reason, e.count]));
    expect(byReason).toMatchObject({ PAYMENT_FAILED: 1, EXPIRED: 1, LIMIT: 1 });
  });

  it('기록이 실패해도(DB 순단) 결제 흐름은 그대로 끝까지 간다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    vi.spyOn(prisma.funnelStep, 'createMany').mockRejectedValue(new Error('DB 순단'));
    const res = await inboundAndPay(moPayload({ to: fx.moNumber }), fx.merchantId);
    expect(['PAYMENT_SUCCESS', 'SETTLEMENT_PENDING']).toContain(res.status);
    expect(await prisma.paymentTransaction.count({ where: { status: 'APPROVED' } })).toBe(1);
    await expect(recordFunnelStep({ step: 'PAID', chargeId: res.chargeId! })).resolves.toBe(false);
    vi.restoreAllMocks();
    expect(await prisma.funnelStep.count()).toBe(0);
  });

  it('금액 선택 화면에서 캠페인을 바꾸면 흐름 전체의 캠페인이 바뀐다(캠페인별 집계가 흐름 단위로 맞는다)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const c = await saveCampaign(fx.merchantId, campaignSchema.parse({
      code: 'WINTER', title: '겨울 나눔', summary: '겨울 나눔', story: '이야기', beneficiary: '이웃', usagePlan: '난방비', goalAmount: 1000000, startsOn: '2026-01-01', endsOn: '2099-12-31',
    }));
    await setCampaignStatus(fx.merchantId, c.id, 'ACTIVE');
    const mo = await handleMoInbound(mockMoAdapter.parse(moPayload({ to: fx.moNumber })));
    const product = await prisma.chargeProduct.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    const r = await confirmChargeAmount({ token: lastSelectAmountToken()!, productId: product.id, campaignId: c.id });
    expect(r.ok).toBe(true);
    const rows = await steps(`mo:${mo.moMessageId}`);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.every((x) => x.campaignId === c.id)).toBe(true);
    const report = await funnelReport({ merchantId: fx.merchantId, campaignId: c.id, since: since() });
    expect(report.total).toBe(1);
    expect((await funnelReport({ merchantId: fx.merchantId, campaignId: newId(), since: since() })).total).toBe(0);
  });

  it('웹 후원은 같은 표에 채널 WEB(QR 유입은 QR)로, 금액 제출부터 남긴다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const web = await createWebCharge({ phoneHash: phoneHash(fx.payerPhone), merchantId: fx.merchantId, amount: 10000n, message: '응원', requestId: 'req-1' });
    expect(web.ok).toBe(true);
    const session = await prisma.paymentPinSession.findUniqueOrThrow({ where: { chargeId: web.chargeId! } });
    await completePinAuthorization({ sessionId: session.sessionId });
    const rows = await steps(`charge:${web.chargeId}`);
    expect(rows.map((r) => r.step)).toEqual(['AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID']);
    expect(rows.every((r) => r.channel === 'WEB' && r.moMessageId === null)).toBe(true);

    const qr = await createWebCharge({ phoneHash: phoneHash(fx.payerPhone), merchantId: fx.merchantId, amount: 10000n, message: '', requestId: 'req-2', source: 'QR' });
    expect((await steps(`charge:${qr.chargeId}`))[0]!.channel).toBe('QR');

    const report = await funnelReport({ merchantId: fx.merchantId, channel: 'WEB', since: since() });
    expect(report.steps.map((s) => s.step)).toEqual(['AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID']);
    expect(report.steps.map((s) => s.count)).toEqual([1, 1, 1]);
    expect((await funnelReport({ merchantId: fx.merchantId, channel: 'MO', since: since() })).total).toBe(0);
  });
});

describe('집계', () => {
  async function flow(key: string, reached: string[], opts: { at?: Date; channel?: string; merchantId?: string; campaignId?: string | null } = {}) {
    const base = opts.at ?? new Date(Date.now() - 3600_000);
    await prisma.funnelStep.createMany({
      data: reached.map((step, i) => ({
        id: newId(), flowKey: key, step, merchantId: opts.merchantId ?? fx.merchantId, channel: opts.channel ?? 'MO',
        campaignId: opts.campaignId ?? null, occurredAt: new Date(base.getTime() + i * 1000), reason: step === 'BLOCKED' ? 'UNREGISTERED' : null,
      })),
    });
  }
  const ALL = ['MO_RECEIVED', 'REPLY_SENT', 'LINK_OPENED', 'AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID'];

  it('단계 수(그 단계 이상 도달)·앞 단계 대비 전환율·가장 많이 끊기는 단계 문장을 낸다 — 측정 전·기간 밖 흐름은 넣지 않는다', async () => {
    // 10명 문자 → 9 회신 → 7 열람 → 3 금액 → 3 인증 → 1 완료
    const plan = [5, 4, 4, 2, 2, 2, 2, 1, 1, 0]; // 흐름별 도달한 마지막 단계 index
    for (const [i, last] of plan.entries()) await flow(`mo:F${i}`, ALL.slice(0, last + 1));
    await flow('mo:F0-extra', ['MO_RECEIVED', 'BLOCKED']); // 끝 상태
    // 가운데 단계가 빠진 흐름도 뒤 단계가 있으면 앞 단계까지 센다(흐름별 최고 단계 기준)
    await flow('mo:GAP', ['MO_RECEIVED', 'REPLY_SENT', 'AMOUNT_SELECTED']);
    // 측정 시작 전에 시작된 흐름(시작 단계 기록 없음)은 넣지 않는다
    await flow('mo:OLD-PRE', ['AMOUNT_SELECTED', 'AUTH_STARTED', 'PAID']);
    // 기간 밖
    await flow('mo:OLD-OUT', ALL, { at: new Date(Date.now() - 40 * 86_400_000) });
    // 다른 기관
    await flow('mo:OTHER', ALL, { merchantId: 'other-merchant' });

    const r = await funnelReport({ merchantId: fx.merchantId, since: new Date(Date.now() - 30 * 86_400_000) });
    // 12개 흐름(10 + 끝 상태 1 + 가운데 빠진 1)
    expect(r.total).toBe(12);
    expect(r.steps.map((s) => s.count)).toEqual([12, 10, 8, 4, 3, 1]);
    expect(r.steps.map((s) => s.rateFromPrev)).toEqual([null, 83.3, 80, 50, 75, 33.3]);
    expect(r.steps[5]!.rateFromStart).toBe(8.3);
    const drop = r.biggestDrop!;
    expect(drop.from).toBe('LINK_OPENED');
    expect(drop.to).toBe('AMOUNT_SELECTED');
    expect(drop.lost).toBe(4);
    expect(r.sentence).toBe('링크를 연 사람의 50%가 금액 선택 전에 나갔습니다.');
    expect(r.open).toBe(12 - 1 - 1);
    expect(r.ends).toEqual([{ step: 'BLOCKED', reason: 'UNREGISTERED', label: '결제수단 미등록', count: 1 }]);

    // 전 기관 합계(관리자)는 다른 기관 흐름도 센다
    const all = await funnelReport({ since: new Date(Date.now() - 30 * 86_400_000) });
    expect(all.total).toBe(13);
    // 최근 7일 기간 필터
    expect((await funnelReport({ merchantId: fx.merchantId, since: new Date(Date.now() - 7 * 86_400_000) })).total).toBe(12);
    expect(r.measuredSince).not.toBeNull();
  });

  it('흐름이 없으면 0건·문장 없음', async () => {
    const r = await funnelReport({ merchantId: fx.merchantId, since: since() });
    expect(r.total).toBe(0);
    expect(r.steps.every((s) => s.count === 0)).toBe(true);
    expect(r.sentence).toBeNull();
    expect(r.measuredSince).toBeNull();
  });
});
