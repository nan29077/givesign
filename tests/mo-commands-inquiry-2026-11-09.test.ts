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
import { phoneHash, tokenHash } from '@/lib/crypto';
import { mockMoAdapter } from '@/server/adapters/mo';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import type { LlmAdapter, LlmRequest } from '@/server/adapters/llm';
import { handleMoInbound } from '@/server/services/charge-flow';
import { loadSelectAmountContext } from '@/server/services/charge-select';
import { createWebCharge } from '@/server/services/web-charge';
import { CampaignCodeReservedError, saveCampaign } from '@/server/services/fundraising';
import { createRecurringDonation } from '@/server/services/recurring';
import { applyRecurringChange } from '@/server/services/donor-self-service';
import { confirmStepUp, hasStepUp, requestStepUp } from '@/server/services/self-service-stepup';
import { CRON_JOBS } from '@/server/cron-registry';
import { itemStillOpen } from '@/server/services/inbox-assignments';
import { loadInboxGroups, resetInboxGroupProviders } from '@/server/services/inbox-groups';
import {
  PROMO_LIMIT_PER_CAMPAIGN,
  PromoError,
  archivePromo,
  createPromo,
  promoPerformance,
  promoSmsTarget,
  setCampaignAliases,
} from '@/server/services/promo-codes';
import { commandCounts, findIntentCandidates, resolveReplyLink } from '@/server/services/mo-commands';
import { smsReplyLinkScope } from '@/server/services/mo-command-scope';
import { bindReplyLinkCookie, MO_LINK_COOKIE } from '@/server/services/mo-link-cookie';
import {
  classifyInquiry,
  classifyInquiryText,
  inquiryDueAt,
  processInquiryTriage,
  saveInquiryAutoSetting,
  submitMerchantInquiry,
  triageInquiry,
  validateAutoTemplate,
} from '@/server/services/inquiry-auto';
import { compactText, editDistance, extractAmount, matchIntent, uniqueBest } from '@/lib/mo-intent';
import { moCommandKind } from '@/lib/mo-commands';
import { smsHref, smsPlatform } from '@/lib/sms-link';
import { decodeAttribution, encodeAttribution, parseSourceParam } from '@/lib/attribution';
import { recurringApplyAction } from '@/app/actions/self-service';
import { moPayload, resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';

/**
 * 2026-11-12 4차 K — 홍보물별 식별(K1) · 의도 해석(K2) · 문자 명령 창구(K3) · 문의 자동 응대(K4).
 * 기존 키워드·예약어·MO 결제 멱등은 그대로(회귀), 해석 결과로 결제 건을 만들지 않는다.
 */

let fx: Fixture;

async function makeCampaign(merchantId: string, code: string, over: Partial<{ status: 'ACTIVE' | 'CLOSED' | 'DRAFT'; aliases: string[] }> = {}) {
  return prisma.campaign.create({
    data: {
      id: newId(), merchantId, code, title: `${code} 캠페인`, summary: '요약', goalAmount: 1_000_000n,
      startsOn: new Date('2026-01-01T00:00:00Z'), endsOn: new Date('2099-12-31T00:00:00Z'), status: over.status ?? 'ACTIVE', aliases: over.aliases ?? [],
    },
  });
}

async function mo(text: string, to = fx.moNumber, from = fx.payerPhone) {
  return handleMoInbound(mockMoAdapter.parse(moPayload({ to, from, text })));
}

async function makeMerchant(name: string) {
  const u = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name, role: 'MERCHANT' } });
  return prisma.merchantProfile.create({ data: { id: newId(), userId: u.id, code: `GIV-${newId().slice(-4)}`, displayName: name, status: 'APPROVED' } });
}

function lastLinkToken(template: string, path: string) {
  const m = readMockOutbox(20).find((x) => x.template === template);
  if (!m) return null;
  const r = m.text.match(new RegExp(`${path}/([A-Za-z0-9_-]+)`));
  return r ? r[1]! : null;
}

async function otpFor(linkId: string) {
  clearMockOutbox();
  const sent = await requestStepUp({ kind: 'SMS_LINK', linkId });
  const code = sent.devCode ?? readMockOutbox(5)[0]!.text.match(/\d{6}/)![0];
  await confirmStepUp({ kind: 'SMS_LINK', linkId }, code);
}

beforeEach(async () => {
  await resetDb();
  resetInboxGroupProviders();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  clearMockOutbox();
  jar.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// K1 홍보물
// ---------------------------------------------------------------------------

describe('K1 홍보물 코드', () => {
  it('캠페인당 20개 상한(동시 생성에도 넘지 않음)·보관하면 다시 만들 수 있다', async () => {
    const c = await makeCampaign(fx.merchantId, '김장');
    const results = await Promise.allSettled(Array.from({ length: PROMO_LIMIT_PER_CAMPAIGN + 3 }, (_, i) => createPromo(fx.merchantId, c.id, { name: `현수막 ${i}` }, 'u')));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(PROMO_LIMIT_PER_CAMPAIGN);
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason instanceof PromoError)).toBe(true);
    const one = await prisma.campaignPromo.findFirstOrThrow({ where: { campaignId: c.id } });
    await archivePromo(fx.merchantId, one.id);
    await expect(createPromo(fx.merchantId, c.id, { name: '새 현수막' }, 'u')).resolves.toBeTruthy();
  });

  it('키워드: 예약어·명령어·캠페인 키워드·다른 홍보물과 겹치면 거절, 정규화해 저장', async () => {
    const c = await makeCampaign(fx.merchantId, '김장');
    await expect(createPromo(fx.merchantId, c.id, { name: 'a', keyword: '정기' }, 'u')).rejects.toThrow(PromoError);
    await expect(createPromo(fx.merchantId, c.id, { name: 'a', keyword: '영수증' }, 'u')).rejects.toThrow(PromoError);
    await expect(createPromo(fx.merchantId, c.id, { name: 'a', keyword: '김장' }, 'u')).rejects.toThrow(/캠페인 키워드/);
    const p = await createPromo(fx.merchantId, c.id, { name: '현수막', keyword: '김장 a' }, 'u');
    expect(p.keyword).toBe('김장A');
    await expect(createPromo(fx.merchantId, c.id, { name: '중복', keyword: '김장a' }, 'u')).rejects.toThrow(/같은 키워드/);
    // 새 캠페인 키워드가 홍보물 키워드와 겹치면 거절
    await expect(saveCampaign(fx.merchantId, { code: '김장A', title: 't', summary: 's', story: '', beneficiary: '', usagePlan: '', imageUrl: '', goalAmount: 10000, startsOn: '2026-01-01', endsOn: '2099-01-01', featured: false, resultReport: '' })).rejects.toThrow(/홍보물/);
  });

  it('MO 홍보물 키워드 → 결제 건·단계 기록에 홍보물 id, 캠페인 키워드 MO 는 그대로(홍보물 없음)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const c = await makeCampaign(fx.merchantId, '김장');
    const p = await createPromo(fx.merchantId, c.id, { name: '현수막 A', keyword: '김장A' }, 'u');

    const viaPromo = await mo('김장A 힘내세요');
    expect(viaPromo.status).toBe('PENDING_AMOUNT');
    const ch = await prisma.charge.findUniqueOrThrow({ where: { id: viaPromo.chargeId! } });
    expect(ch.campaignId).toBe(c.id);
    expect(ch.promoId).toBe(p.id);
    expect(ch.message).toBe('힘내세요');
    const steps = await prisma.funnelStep.findMany({ where: { flowKey: `mo:${viaPromo.moMessageId}` } });
    expect(steps.length).toBeGreaterThanOrEqual(2);
    expect(steps.every((s) => s.promoId === p.id)).toBe(true);

    const viaCode = await mo('김장 응원합니다', fx.moNumber, '01022223333');
    // 미등록 번호도 수신은 센다(홍보물 아님)
    expect(viaCode.result).toBe('UNREGISTERED_DONOR');
    await seedRegisteredPayer('01044445555');
    const viaCode2 = await mo('김장 응원합니다', fx.moNumber, '01044445555');
    const ch2 = await prisma.charge.findUniqueOrThrow({ where: { id: viaCode2.chargeId! } });
    expect(ch2.campaignId).toBe(c.id);
    expect(ch2.promoId).toBeNull();
    expect(ch2.message).toBe('응원합니다');

    // 미등록 번호의 홍보물 문자도 홍보물별 수신에 들어간다
    await mo('김장A', fx.moNumber, '01077778888');
    const perf = await promoPerformance([p.id]);
    expect(perf.get(p.id)!.moReceived).toBe(2);
  });

  it('만료·보관된 홍보물 키워드는 예전처럼 일반 후원(캠페인 미지정) — 금액 화면에만 캠페인을 미리 골라 둔다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const c = await makeCampaign(fx.merchantId, '김장');
    const p = await createPromo(fx.merchantId, c.id, { name: '지난 현수막', keyword: '김장B', expiresOn: '2026-01-31' }, 'u');
    const r = await mo('김장B');
    const ch = await prisma.charge.findUniqueOrThrow({ where: { id: r.chargeId! } });
    expect(ch.campaignId).toBeNull();
    expect(ch.promoId).toBeNull();
    const link = await prisma.secureLink.findFirstOrThrow({ where: { chargeId: ch.id } });
    expect((link.payload as { intent?: { campaignId?: string } }).intent?.campaignId).toBe(c.id);
    expect(p.id).toBeTruthy();
  });

  it('QR·링크: ?src=promo:<id> → 쿠키 → 웹 후원에 홍보물(이 기관 것만)', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    const c = await makeCampaign(fx.merchantId, '김장');
    const p = await createPromo(fx.merchantId, c.id, { name: '행사장 QR' }, 'u');
    const parsed = parseSourceParam(`promo:${p.id}`)!;
    expect(parsed).toEqual({ source: 'QR', promoId: p.id });
    expect(parseSourceParam('promo:../../x')).toBeNull();
    const cookie = encodeAttribution({ source: 'QR', contentItemId: null, promoId: p.id });
    expect(decodeAttribution(cookie)).toEqual({ source: 'QR', contentItemId: null, promoId: p.id });
    expect(decodeAttribution('YOUTUBE')).toEqual({ source: 'YOUTUBE', contentItemId: null }); // 예전 형식 그대로

    const other = await makeMerchant('다른기관');
    const otherCampaign = await makeCampaign(other.id, '연탄');
    const otherPromo = await createPromo(other.id, otherCampaign.id, { name: '남의 것' }, 'u');
    const mine = await createWebCharge({ phoneHash: payer.phoneHash, merchantId: fx.merchantId, amount: 10000n, message: '응원', requestId: newId(), campaignId: c.id, source: 'QR', promoId: p.id });
    const foreign = await createWebCharge({ phoneHash: payer.phoneHash, merchantId: fx.merchantId, amount: 10000n, message: '응원', requestId: newId(), source: 'QR', promoId: otherPromo.id });
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: mine.chargeId! } })).promoId).toBe(p.id);
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: foreign.chargeId! } })).promoId).toBeNull();
  });

  it('중간 페이지 값: 전용번호면 홍보물 키워드만, 문자 링크는 iOS(&body=)·안드로이드(?body=)', async () => {
    const c = await makeCampaign(fx.merchantId, '김장');
    const p = await createPromo(fx.merchantId, c.id, { name: '소식지', keyword: '김장C' }, 'u');
    const t = (await promoSmsTarget(p.id))!;
    expect(t.number).toBe(fx.moNumber);
    expect(t.body).toBe('김장C ');
    expect(t.inactive).toBe(false);
    expect(t.donateUrl).toContain(`src=promo:${p.id}`);
    expect(smsPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('ios');
    expect(smsPlatform('Mozilla/5.0 (Linux; Android 15)')).toBe('android');
    expect(smsHref('1588-1001', '김장C ', 'ios')).toBe('sms:15881001&body=%EA%B9%80%EC%9E%A5C%20');
    expect(smsHref('15881001', '김장C', 'android')).toBe('sms:15881001?body=%EA%B9%80%EC%9E%A5C');
    expect(await promoSmsTarget('not-an-id')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// K2 의도 해석
// ---------------------------------------------------------------------------

describe('K2 보완 해석(규칙 + 편집거리, 결제 건 미생성)', () => {
  it('금액 표현 추출', () => {
    expect(extractAmount('3만')?.amount).toBe(30000);
    expect(extractAmount('김장 3만원 보냅니다')?.amount).toBe(30000);
    expect(extractAmount('삼만원')?.amount).toBe(30000);
    expect(extractAmount('30000')?.amount).toBe(30000);
    expect(extractAmount('30,000원')?.amount).toBe(30000);
    expect(extractAmount('1만5천원')?.amount).toBe(15000);
    expect(extractAmount('만원')?.amount).toBe(10000);
    expect(extractAmount('오천원')?.amount).toBe(5000);
    expect(extractAmount('이 캠페인')).toBeNull();
    expect(extractAmount('100')).toBeNull();
    expect(extractAmount('김장 3만')?.rest).toBe('김장');
  });

  it('띄어쓰기·접미사·별칭·오타(키 길이별 허용치)', () => {
    const entries = [{ key: '김장', ref: 'A' }, { key: '크리스마스', ref: 'B' }, { key: '김치', alias: true, ref: 'A' }];
    expect(uniqueBest(matchIntent('김 장', entries))?.ref).toBe('A');
    expect(uniqueBest(matchIntent('김장후원합니다', entries))?.ref).toBe('A');
    expect(matchIntent('김치 나눔', entries)[0]).toMatchObject({ ref: 'A', via: 'ALIAS' });
    expect(uniqueBest(matchIntent('크리스마수 선물', entries))).toMatchObject({ ref: 'B', via: 'TYPO', distance: 1 });
    expect(matchIntent('김잔', entries)).toEqual([]); // 2자 키는 오타 허용 안 함
    expect(editDistance('크리스마스', '크리스마수')).toBe(1);
    expect(compactText(' 김-장 ')).toBe('김장');
  });

  it('기관이 정해진 문자: 일반 후원 링크 그대로 + 금액 화면에 캠페인·금액 미리 선택(결제 건 1건, 캠페인 미확정)', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const c = await makeCampaign(fx.merchantId, '김장');
    const r = await mo('김장후원 3만');
    expect(r.status).toBe('PENDING_AMOUNT');
    expect(await prisma.charge.count()).toBe(1);
    const ch = await prisma.charge.findUniqueOrThrow({ where: { id: r.chargeId! } });
    expect(ch.campaignId).toBeNull();
    expect(ch.amount).toBe(0n);
    const token = lastLinkToken('SELECT_AMOUNT', '/r');
    const ctx = await loadSelectAmountContext(token!);
    expect(ctx.ok && ctx.ctx.suggestion).toMatchObject({ campaignId: c.id, amount: 30000n });
  });

  it('회귀: 캠페인 키워드 MO·일반 메시지·예약어는 지금과 같다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const c = await makeCampaign(fx.merchantId, '김장');
    const kw = await mo('김장 응원합니다');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: kw.chargeId! } })).campaignId).toBe(c.id);
    const plain = await mo('응원합니다', fx.moNumber, fx.payerPhone);
    // 직전 금액 선택 링크가 아직 유효하므로 속도 제한(기존 동작)
    expect(plain.result).toBe('BLOCKED');
    const pledge = await mo('정기 김장', fx.moNumber, '01099990000');
    expect(pledge.message).toContain('정기후원 약정 링크');
    expect(await prisma.charge.count()).toBe(1);
    const link = await prisma.secureLink.findFirstOrThrow({ where: { chargeId: kw.chargeId! } });
    expect(link.payload).toEqual({}); // 금액 표현이 없으면 미리 선택 없음
  });

  it('대표번호 공유: 기관 키워드 오타 → 고르기 링크(결제 건 없음), 후보가 없으면 예전 안내', async () => {
    const m2 = await makeMerchant('행복복지관');
    await prisma.merchantMoNumber.create({ data: { id: newId(), phoneNumber: '15882000', mode: 'SHARED_PREFIX', keyword: 'HAPPY', status: 'ASSIGNED', merchantId: m2.id, providerId: 'mock', assignedAt: new Date() } });
    const camp = await makeCampaign(m2.id, '연탄나눔');
    const r = await mo('HAPY 연탄나눔 3만', '15882000');
    expect(r.result).toBe('UNKNOWN_ROUTE');
    expect(r.chargeId).toBeUndefined();
    expect(await prisma.charge.count()).toBe(0);
    const token = lastLinkToken('MO_INTENT_LINK', '/mo');
    expect(token).toBeTruthy();
    const link = await resolveReplyLink(token!);
    expect(link.ok && link.link.kind).toBe('INTENT');
    const payload = link.ok ? (link.link.payload as { candidates: Array<{ campaignId: string }>; amount: number }) : null;
    expect(payload?.candidates[0]?.campaignId).toBe(camp.id);
    expect(payload?.amount).toBe(30000);

    clearMockOutbox();
    const none = await mo('아무말 대잔치', '15882000');
    expect(none.result).toBe('UNKNOWN_ROUTE');
    expect(readMockOutbox(5)[0]!.template).toBe('UNKNOWN_ROUTE');
    // 전용번호가 걸린 번호는 보지 않는다
    expect((await findIntentCandidates(fx.moNumber, 'HAPY')).candidates).toEqual([]);
  });

  it('별칭은 예약어·다른 캠페인 키워드와 겹칠 수 없다', async () => {
    const a = await makeCampaign(fx.merchantId, '김장');
    await makeCampaign(fx.merchantId, '연탄');
    await expect(setCampaignAliases(fx.merchantId, a.id, ['연탄'])).rejects.toThrow(PromoError);
    await expect(setCampaignAliases(fx.merchantId, a.id, ['해지'])).rejects.toThrow(PromoError);
    expect(await setCampaignAliases(fx.merchantId, a.id, ['김치', '김치', '김장'])).toEqual(['김치']);
  });
});

// ---------------------------------------------------------------------------
// K3 명령 창구
// ---------------------------------------------------------------------------

describe('K3 문자 명령어', () => {
  it('영수증 → 결제 건 없이 본인 확인 링크(30분, 번호 해시와 묶음), 10분 안 재요청은 링크 생략, 종류별 수 집계', async () => {
    const r = await mo('영수증');
    expect(r.result).toBe('ROUTED');
    expect(r.chargeId).toBeUndefined();
    expect(await prisma.charge.count()).toBe(0);
    const token = lastLinkToken('MO_COMMAND_LINK', '/mo');
    const link = await prisma.moReplyLink.findUniqueOrThrow({ where: { tokenHash: tokenHash(token!) } });
    expect(link).toMatchObject({ kind: 'RECEIPT', merchantId: fx.merchantId, phoneHash: phoneHash(fx.payerPhone) });
    expect(link.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60_000 + 1000);
    const again = await mo('영수증 발급해주세요');
    expect(again.message).toContain('다시 보내지 않았습니다');
    expect(await prisma.moReplyLink.count()).toBe(1);
    await mo('해지', fx.moNumber, '01033334444');
    await mo('정기', fx.moNumber, '01055556666');
    const counts = await commandCounts(fx.merchantId, new Date(Date.now() - 3600_000));
    expect(Object.fromEntries(counts.map((c) => [c.kind, c.count]))).toMatchObject({ RECEIPT: 2, CANCEL: 1, PLEDGE: 1 });
    // 명령 흐름은 결제 단계 집계에 들어가지 않는다(MO_RECEIVED 없음)
    expect(await prisma.funnelStep.count({ where: { step: 'MO_RECEIVED' } })).toBe(0);
    expect(moCommandKind('내 역')).toBe('HISTORY');
  });

  it('기존 캠페인이 명령어를 키워드로 쓰면 캠페인 키워드가 우선(기존 동작 유지) · 새 캠페인은 명령어 키워드 거절', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    const legacy = await makeCampaign(fx.merchantId, '내역');
    const r = await mo('내역 응원합니다');
    expect(r.status).toBe('PENDING_AMOUNT');
    expect((await prisma.charge.findUniqueOrThrow({ where: { id: r.chargeId! } })).campaignId).toBe(legacy.id);
    const input = { code: '해지', title: 't', summary: 's', story: '', beneficiary: '', usagePlan: '', imageUrl: '', goalAmount: 10000, startsOn: '2026-01-01', endsOn: '2099-01-01', featured: false, resultReport: '' };
    await expect(saveCampaign(fx.merchantId, input)).rejects.toThrow(CampaignCodeReservedError);
    // 이미 그 단어를 쓰던 캠페인은 그대로 저장된다
    await expect(saveCampaign(fx.merchantId, { ...input, code: '내역', title: '고친 제목' }, legacy.id)).resolves.toBeTruthy();
  });

  it('해지 링크: 본인 확인 전에는 처리 불가 → 인증 후 그 기관 약정만 해지 + 결과 문자, 만료 링크는 거절', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await prisma.termsVersion.create({
      data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') },
    });
    const made = await createRecurringDonation({ payerId: payer.id, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 25 });
    expect(made.ok).toBe(true);
    const recurringId = made.ok ? made.recurring.id : '';
    const other = await makeMerchant('다른기관');
    const otherRec = await createRecurringDonation({ payerId: payer.id, merchantId: other.id, amount: 10000n, dayOfMonth: 25 });

    await mo('해지');
    const token = lastLinkToken('MO_COMMAND_LINK', '/mo')!;
    const scope = (await smsReplyLinkScope(token))!;
    expect(scope).toMatchObject({ via: 'SMS', merchantId: fx.merchantId, payerId: payer.id });

    const form = (over: Record<string, string> = {}) => {
      const f = new FormData();
      f.set('code', `sms:${token}`);
      f.set('id', recurringId);
      f.set('action', 'CANCEL');
      for (const [k, v] of Object.entries(over)) f.set(k, v);
      return f;
    };
    const before = await recurringApplyAction({ ok: false }, form());
    expect(before.ok).toBe(false);
    expect(before.needStepUp).toBe(true);

    await otpFor(scope.linkId);
    expect(await hasStepUp({ kind: 'SMS_LINK', linkId: scope.linkId })).toBe(true);
    // 쿠키 표시가 없으면(다른 브라우저) 거절
    const noCookie = await recurringApplyAction({ ok: false }, form());
    expect(noCookie.ok).toBe(false);
    await bindReplyLinkCookie(scope.linkId);
    expect(jar.has(MO_LINK_COOKIE)).toBe(true);

    // 다른 기관 약정은 "찾을 수 없음"
    await expect(applyRecurringChange(scope, otherRec.ok ? otherRec.recurring.id : '', { action: 'CANCEL' })).rejects.toThrow(/찾을 수 없/);

    clearMockOutbox();
    const done = await recurringApplyAction({ ok: false }, form());
    expect(done.ok).toBe(true);
    expect((await prisma.recurringDonation.findUniqueOrThrow({ where: { id: recurringId } })).status).toBe('CANCELED');
    expect(readMockOutbox(10).some((m) => m.template === 'RECURRING_SELF_RESULT')).toBe(true);
    const log = await prisma.recurringChangeLog.findFirstOrThrow({ where: { recurringId } });
    expect(log.via).toBe('SMS');

    await prisma.moReplyLink.update({ where: { id: scope.linkId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await smsReplyLinkScope(token)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// K4 문의 자동 응대
// ---------------------------------------------------------------------------

describe('K4 문의 자동 응대', () => {
  async function inquiryFrom(phone: string, body: string) {
    const payer = await seedRegisteredPayer(phone);
    return { payer, ...(await submitMerchantInquiry({ merchantId: fx.merchantId, payerId: payer.id, phone, body })) };
  }

  it('분류 규칙: 사람 쪽(법적·환불·불만)이 우선', () => {
    expect(classifyInquiryText('영수증 언제 나오나요?')).toBe('RECEIPT');
    expect(classifyInquiryText('정기후원 금액 바꾸고 싶어요')).toBe('RECURRING');
    expect(classifyInquiryText('주소 변경하려고요')).toBe('CONTACT');
    expect(classifyInquiryText('작년 후원 내역 확인하고 싶어요')).toBe('HISTORY');
    expect(classifyInquiryText('영수증이 왜 이렇게 늦어요 짜증나네요')).toBe('COMPLAINT');
    expect(classifyInquiryText('두 번 출금됐어요 환불해 주세요')).toBe('REFUND');
    expect(classifyInquiryText('소비자원에 신고하겠습니다')).toBe('LEGAL');
    expect(classifyInquiryText('안녕하세요')).toBe('OTHER');
  });

  it('자동 답변은 기본 꺼짐 → 담당자에게(이력 요약·기한·대기함 묶음·담당 배정)', async () => {
    const { inquiryId } = await inquiryFrom('01020001000', '영수증 언제 나오나요?');
    const r = await processInquiryTriage();
    expect(r).toMatchObject({ checked: 1, toStaff: 1, autoAnswered: 0 });
    const inq = await prisma.supportInquiry.findUniqueOrThrow({ where: { id: inquiryId } });
    expect(inq).toMatchObject({ status: 'OPEN', autoCategory: 'RECEIPT', autoAnsweredAt: null });
    expect(inq.needsStaffAt).toBeTruthy();
    expect(inq.dueAt!.getTime()).toBeGreaterThan(Date.now());
    const summary = inq.historySummary as Record<string, unknown>;
    expect(summary).toMatchObject({ paidCount: 0, activeRecurring: 0 });
    expect(JSON.stringify(summary)).not.toContain('010');
    expect(await prisma.inboxAssignment.count({ where: { merchantId: fx.merchantId, itemKey: `inquiry:${inquiryId}` } })).toBe(1);
    expect(await itemStillOpen(fx.merchantId, `inquiry:${inquiryId}`)).toBe(true);
    const groups = await loadInboxGroups(fx.merchantId);
    expect(groups.find((g) => g.provider === 'inquiry-reply')?.group?.affectedCount).toBe(1);
    // 다시 돌려도 새 메시지가 없으면 처리하지 않는다
    expect((await processInquiryTriage()).checked).toBe(0);
  });

  it('켜면 1회 자동 답변(문자 안내) → 후원자가 다시 쓰면 담당자에게, 다시 자동 답변하지 않음', async () => {
    await saveInquiryAutoSetting(fx.merchantId, { autoCategories: ['RECEIPT'], templates: {}, dueBusinessDays: 2 }, 'u');
    const { inquiryId, payer } = await inquiryFrom('01020002000', '연말정산 영수증 어떻게 받나요');
    clearMockOutbox();
    expect((await processInquiryTriage()).autoAnswered).toBe(1);
    let inq = await prisma.supportInquiry.findUniqueOrThrow({ where: { id: inquiryId }, include: { messages: true } });
    expect(inq.status).toBe('CLOSED');
    expect(inq.autoAnsweredAt).toBeTruthy();
    const auto = inq.messages.find((m) => m.authorKind === 'AUTO')!;
    expect(auto.body).toContain('테스트사회복지기관');
    expect(auto.body).toContain('/my/receipts');
    expect(readMockOutbox(5).some((m) => m.template === 'INQUIRY_ANSWER')).toBe(true);

    await submitMerchantInquiry({ merchantId: fx.merchantId, payerId: payer.id, phone: '01020002000', body: '영수증 정보 등록했는데 또 확인 부탁드려요' });
    expect((await processInquiryTriage()).toStaff).toBe(1);
    inq = await prisma.supportInquiry.findUniqueOrThrow({ where: { id: inquiryId }, include: { messages: true } });
    expect(inq.status).toBe('OPEN');
    expect(inq.messages.filter((m) => m.authorKind === 'AUTO')).toHaveLength(1);
    expect(inq.needsStaffAt).toBeTruthy();
  });

  it('불만은 영수증 자동 답변이 켜져 있어도 자동 답변하지 않는다', async () => {
    await saveInquiryAutoSetting(fx.merchantId, { autoCategories: ['RECEIPT', 'HISTORY', 'RECURRING', 'CONTACT'], templates: {}, dueBusinessDays: 2 }, 'u');
    await inquiryFrom('01020003000', '영수증이 왜 이렇게 늦어요 짜증나네요');
    const r = await processInquiryTriage();
    expect(r).toMatchObject({ autoAnswered: 0, toStaff: 1 });
  });

  it('겹친 처리에도 자동 답변은 한 번', async () => {
    await saveInquiryAutoSetting(fx.merchantId, { autoCategories: ['HISTORY'], templates: {}, dueBusinessDays: 2 }, 'u');
    const { inquiryId } = await inquiryFrom('01020004000', '후원 내역 확인하고 싶어요');
    const outs = await Promise.all([triageInquiry(inquiryId), triageInquiry(inquiryId), triageInquiry(inquiryId)]);
    expect(outs.filter((o) => o === 'AUTO')).toHaveLength(1);
    expect(await prisma.supportMessage.count({ where: { inquiryId, authorKind: 'AUTO' } })).toBe(1);
  });

  it('LLM 보조 분류: 공급자로는 가린 본문만 보내고, LLM 분류만으로는 자동 답변하지 않는다', async () => {
    const seen: LlmRequest[] = [];
    const fake: LlmAdapter = {
      info: () => ({ provider: 'fake', mode: 'live', missingCredentials: [], model: 'fake-1' }),
      complete: async (req) => {
        seen.push(req);
        return { text: '{"category":"RECEIPT"}', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const c = await classifyInquiry('연락 주세요 010-1234-5678 hong@test.kr 901010-1234567', { adapter: fake });
    expect(c).toEqual({ category: 'RECEIPT', by: 'LLM' });
    expect(seen[0]!.user).not.toMatch(/010-1234-5678|hong@test\.kr|901010/);
    expect(seen[0]!.user).toContain('[전화번호]');

    await saveInquiryAutoSetting(fx.merchantId, { autoCategories: ['RECEIPT'], templates: {}, dueBusinessDays: 2 }, 'u');
    const { inquiryId } = await inquiryFrom('01020005000', '안녕하세요 확인 좀 해 주세요');
    expect(await triageInquiry(inquiryId, { adapter: fake })).toBe('STAFF');
    expect((await prisma.supportInquiry.findUniqueOrThrow({ where: { id: inquiryId } })).autoCategoryBy).toBe('LLM');
  });

  it('처리 기한은 영업일(주말·공휴일 제외), 서식은 정보성만', async () => {
    const fri = new Date('2026-11-13T03:00:00Z'); // 금요일 KST
    expect((await inquiryDueAt(fri, 2)).toISOString()).toBe(new Date('2026-11-17T23:59:59+09:00').toISOString());
    // public_holiday 는 resetDb 가 비우지 않는 기준 데이터라 이 테스트가 만든 행은 직접 지운다
    const h = await prisma.publicHoliday.create({ data: { id: newId(), date: '2026-11-16', name: '테스트 휴일' } });
    try {
      expect((await inquiryDueAt(fri, 2)).toISOString()).toBe(new Date('2026-11-18T23:59:59+09:00').toISOString());
    } finally {
      await prisma.publicHoliday.delete({ where: { id: h.id } });
    }
    expect(validateAutoTemplate('자세한 내용은 https://example.com 참고')).toMatch(/링크/);
    expect(validateAutoTemplate('{기관명}입니다. {링크}')).toBeNull();
  });

  it('배치는 cron-registry 에 등록되어 있다', () => {
    expect(CRON_JOBS.find((j) => j.name === 'inquiry-auto')).toMatchObject({ path: '/api/cron/inquiry-auto', intervalSec: 300 });
  });
});
