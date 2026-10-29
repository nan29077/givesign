import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { readMockOutbox } from '@/server/adapters/mt';
import { startRegistration, completeRegistration } from '@/server/services/payer-registration';
import { computeFees, getSettlementSummary, resolveFeePolicy } from '@/server/services/settlement';
import { percentToDecimalString } from '@/app/actions/admin/shared';
import { newId } from '@/lib/id';
import { tplChargeSuccess, tplRegisterGuide } from '@/server/services/mt-templates';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { generateToken, tokenHash } from '@/lib/crypto';

let fx: Fixture;

async function inbound(payload: Record<string, unknown>) {
  return inboundAndPay(payload, fx.merchantId);
}

/** 전역 수수료 정책을 이 테스트에서 쓰는 값으로 바꾼다. */
async function setGlobalFee(input: { pg: string; platform: string; vatIncluded: boolean }) {
  await prisma.feePolicy.updateMany({
    where: { scope: 'GLOBAL' },
    data: { pgFeeRate: input.pg, platformFeeRate: input.platform, vatIncluded: input.vatIncluded },
  });
}

const CONSENTS = (['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const).map(
  (type) => ({ type, agreed: true }),
);

/** 발송된 등록 링크의 토큰을 테스트가 아는 값으로 바꿔 돌려준다. */
async function takeRegisterToken() {
  const raw = generateToken(16);
  const link = await prisma.secureLink.findFirstOrThrow({ where: { purpose: 'REGISTER_ACCOUNT' } });
  await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(raw) } });
  return raw;
}

describe('수수료 부가세 계산', () => {
  it('부가세 별도(vatIncluded=false)면 수수료의 10% 가 추가로 차감된다', () => {
    const fees = computeFees(3_000n, { pgFeeRate: '0', platformFeeRate: '0.10', vatIncluded: false });

    expect(fees.platformFeeSupply).toBe(300n); // 3,000 x 10%
    expect(fees.platformFeeVat).toBe(30n); // 300 x 10%
    expect(fees.platformFee).toBe(330n); // 총 차감
    expect(fees.vat).toBe(30n);
    expect(fees.net).toBe(2_670n); // 사회복지기관 정산금
  });

  it('부가세 포함(vatIncluded=true)이면 요율만큼만 차감하되 공급가액과 부가세를 분리 기록한다', () => {
    const fees = computeFees(3_000n, { pgFeeRate: '0', platformFeeRate: '0.10', vatIncluded: true });

    // 차감 총액과 정산금은 요율 그대로다(부가세를 더 떼지 않는다).
    expect(fees.platformFee).toBe(300n);
    expect(fees.net).toBe(2_700n);
    // 그 300원 안에서 공급가액과 부가세를 역산해 기록한다. 세금계산서 발행 근거가 된다.
    expect(fees.platformFeeSupply).toBe(272n); // 300 / 1.1 = 272.7 -> 272 (원 미만 버림)
    expect(fees.platformFeeVat).toBe(28n); // 300 - 272
    expect(fees.platformFeeSupply + fees.platformFeeVat).toBe(fees.platformFee);
    expect(fees.vat).toBe(28n);
  });

  it('부가세 포함 5.5% 와 부가세 별도 5% 는 차감액·정산금·부가세가 모두 같다', () => {
    const included = computeFees(3_000n, { pgFeeRate: '0', platformFeeRate: '0.055', vatIncluded: true });
    const separate = computeFees(3_000n, { pgFeeRate: '0', platformFeeRate: '0.05', vatIncluded: false });

    expect(included.platformFee).toBe(165n);
    expect(included.platformFeeSupply).toBe(150n);
    expect(included.platformFeeVat).toBe(15n);

    expect(separate.platformFee).toBe(included.platformFee);
    expect(separate.platformFeeSupply).toBe(included.platformFeeSupply);
    expect(separate.platformFeeVat).toBe(included.platformFeeVat);
    expect(separate.net).toBe(included.net);
  });

  it('부가세 포함 요율에서도 공급가액 + 부가세 = 차감액 이 항상 성립한다', () => {
    for (const amount of [1_000n, 3_000n, 7_777n, 10_000n, 33_333n, 50_000n]) {
      const fees = computeFees(amount, { pgFeeRate: '0.018', platformFeeRate: '0.15', vatIncluded: true });
      expect(fees.pgFeeSupply + fees.pgFeeVat).toBe(fees.pgFee);
      expect(fees.platformFeeSupply + fees.platformFeeVat).toBe(fees.platformFee);
      expect(fees.vat).toBe(fees.pgFeeVat + fees.platformFeeVat);
      expect(fees.net).toBe(amount - fees.pgFee - fees.platformFee);
    }
  });

  it('결제수수료에도 같은 규칙이 적용되고 정산금은 두 수수료의 차액이다', () => {
    const fees = computeFees(10_000n, { pgFeeRate: '0.018', platformFeeRate: '0.15', vatIncluded: false });

    expect(fees.pgFeeSupply).toBe(180n);
    expect(fees.pgFeeVat).toBe(18n);
    expect(fees.platformFeeSupply).toBe(1_500n);
    expect(fees.platformFeeVat).toBe(150n);
    expect(fees.vat).toBe(168n);
    expect(fees.net).toBe(10_000n - 198n - 1_650n);
  });

  it('고정비(pgFixedFee)도 공급가액에 포함해 부가세를 계산한다', () => {
    const fees = computeFees(3_000n, {
      pgFeeRate: '0',
      pgFixedFee: 100n,
      platformFeeRate: '0',
      vatIncluded: false,
    });

    expect(fees.pgFeeSupply).toBe(100n);
    expect(fees.pgFeeVat).toBe(10n);
    expect(fees.net).toBe(2_890n);
  });
});

describe('퍼센트 요율 입력 변환', () => {
  it('퍼센트 문자열을 부동소수 오차 없이 소수 문자열로 바꾼다', () => {
    expect(percentToDecimalString('5.5')).toBe('0.055');
    expect(percentToDecimalString('1.8')).toBe('0.018');
    expect(percentToDecimalString('15')).toBe('0.15');
    expect(percentToDecimalString('0.5')).toBe('0.005');
    expect(percentToDecimalString('100')).toBe('1');
    expect(percentToDecimalString('0')).toBe('0');
    // Decimal(10,6) 한계인 퍼센트 소수점 4자리까지 정확히 보존한다.
    expect(percentToDecimalString('0.0001')).toBe('0.000001');
  });

  it('Number 나눗셈과 달리 이진 부동소수 오차가 섞이지 않는다', () => {
    // 1.8 / 100 === 0.018000000000000002 (Decimal 컬럼에 그대로 들어가면 요율이 틀어진다)
    expect(String(1.8 / 100)).not.toBe('0.018');
    expect(percentToDecimalString('1.8')).toBe('0.018');
    expect(String(0.7 / 100)).not.toBe('0.007');
    expect(percentToDecimalString('0.7')).toBe('0.007');
  });
});

describe('수수료 정책 시행 기간', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics();
  });

  /**
   * 시행일을 미래로 잡은 정책을 등록하면, 기존 정책은 그 시행일까지 살아 있어야 한다.
   *
   * 예전에는 새 정책을 등록하는 순간 기존 정책의 active 를 false 로 내렸다. 그래서
   * 오늘~시행일 사이에는 적용 가능한 정책이 하나도 없었고, resolveFeePolicy 가 null 을
   * 돌려주면서 코드 기본 요율(1.8% / 15%)이 조용히 적용됐다.
   */
  it('시행 예정 정책은 시행일 전까지 적용되지 않고, 기존 정책이 그때까지 유지된다', async () => {
    const now = new Date();
    const startsAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    // 기존 전역 정책 — active 를 유지한 채 종료일만 새 정책 시행일로 맞춘다.
    await prisma.feePolicy.updateMany({
      where: { scope: 'GLOBAL' },
      data: { platformFeeRate: '0.15', active: true, effectiveTo: startsAt },
    });
    // 새 정책 — 아직 시행 전.
    await prisma.feePolicy.create({
      data: {
        id: newId(),
        scope: 'GLOBAL',
        pgFeeRate: '0.018',
        platformFeeRate: '0.055',
        vatIncluded: true,
        settlementDays: 5,
        active: true,
        effectiveFrom: startsAt,
      },
    });

    const today = await resolveFeePolicy(fx.merchantId, now);
    expect(today).not.toBeNull();
    expect(Number(today!.platformFeeRate)).toBe(0.15);

    const afterStart = await resolveFeePolicy(fx.merchantId, new Date(startsAt.getTime() + 60_000));
    expect(afterStart).not.toBeNull();
    expect(Number(afterStart!.platformFeeRate)).toBe(0.055);
  });

  it('사회복지기관 개별 정책이 전역 정책보다 우선한다', async () => {
    const now = new Date();
    await prisma.feePolicy.updateMany({
      where: { scope: 'GLOBAL' },
      data: { platformFeeRate: '0.15', active: true, effectiveTo: null },
    });
    await prisma.feePolicy.create({
      data: {
        id: newId(),
        scope: 'MERCHANT',
        merchantId: fx.merchantId,
        pgFeeRate: '0.018',
        platformFeeRate: '0.055',
        vatIncluded: true,
        settlementDays: 5,
        active: true,
        effectiveFrom: new Date(now.getTime() - 60_000),
      },
    });

    const resolved = await resolveFeePolicy(fx.merchantId, now);
    expect(resolved?.scope).toBe('MERCHANT');
    expect(Number(resolved!.platformFeeRate)).toBe(0.055);
  });
});

describe('부가세가 실제 결제·정산에 반영된다', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('부가세 별도 정책이면 결제 1건의 정산금과 원장 잔액이 2,670원이 된다', async () => {
    await setGlobalFee({ pg: '0', platform: '0.10', vatIncluded: false });
    await seedRegisteredPayer(fx.payerPhone);

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });

    expect(charge.platformFee).toBe(330n); // 300 + 부가세 30
    expect(charge.feeVat).toBe(30n);
    expect(charge.netAmount).toBe(2_670n);

    const summary = await getSettlementSummary(fx.merchantId);
    expect(summary.totalGross).toBe(3_000n);
    expect(summary.totalPlatformFee).toBe(330n);
    expect(summary.balance).toBe(2_670n);

    // 부가세 금액은 수수료 분개 메모에 남아 사후 대사가 가능하다.
    const platformEntry = await prisma.settlementLedger.findFirstOrThrow({
      where: { chargeId: charge.id, entryType: 'PLATFORM_FEE' },
    });
    expect(platformEntry.memo).toContain('부가세 30원');
  });

  it('부가세 포함 정책이면 요율만큼만 차감하되 그 안의 부가세가 결제 건에 기록된다', async () => {
    await setGlobalFee({ pg: '0', platform: '0.10', vatIncluded: true });
    await seedRegisteredPayer(fx.payerPhone);

    const res = await inbound(moPayload({ to: fx.moNumber }));
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: res.chargeId } });

    // 차감액과 정산금은 부가세 별도 정책과 달리 요율 그대로다.
    expect(charge.platformFee).toBe(300n);
    expect(charge.netAmount).toBe(2_700n);
    // 그 300원 안에 들어 있는 부가세를 역산해 기록한다(세금계산서 근거).
    expect(charge.feeVat).toBe(28n);

    const platformEntry = await prisma.settlementLedger.findFirstOrThrow({
      where: { chargeId: charge.id, entryType: 'PLATFORM_FEE' },
    });
    expect(platformEntry.memo).toContain('부가세 28원');
  });
});

describe('사회복지기관 감사 문자 커스터마이즈', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('설정이 없으면 기본 문구로 발송된다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inbound(moPayload({ to: fx.moNumber, text: '화이팅' }));

    const success = readMockOutbox(10).find((m) => m.text.includes('후원되었습니다'));
    expect(success?.text).toContain('누적 후원');
  });

  it('설정한 본문의 치환자가 실제 값으로 바뀌어 발송된다', async () => {
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { thanksMtMessage: '{후원자}님 고마워요! {금액} 잘 받았습니다. 남겨주신 말: {메시지}' },
    });
    await seedRegisteredPayer(fx.payerPhone);
    await inbound(moPayload({ to: fx.moNumber, text: '오늘도 화이팅' }));

    const success = readMockOutbox(10).find((m) => m.text.includes('고마워요'));
    expect(success).toBeDefined();
    expect(success!.text).toBe(
      '[기브싸인] 테스트후원자님 고마워요! 3,000원 잘 받았습니다. 남겨주신 말: 오늘도 화이팅',
    );
    // 발신 주체 표기는 설정과 무관하게 항상 붙는다.
    expect(success!.text.startsWith('[기브싸인] ')).toBe(true);
    // 기본 문구는 더 이상 쓰이지 않는다.
    expect(success!.text).not.toContain('누적 후원');
  });

  it('치환값에 정규식 특수문자가 있어도 본문이 깨지지 않는다', () => {
    const dollar = '$';
    const out = tplChargeSuccess({
      payerName: `${dollar}&test`,
      merchantName: '기브싸인',
      amount: 3_000n,
      message: `${dollar}1`,
      cumulative: 3_000n,
      custom: '{후원자} / {메시지}',
    });
    expect(out.text).toBe(`[기브싸인] ${dollar}&test / ${dollar}1`);
  });

  it('설정이 공백뿐이면 기본 문구로 되돌아간다', () => {
    const out = tplChargeSuccess({
      payerName: '홍길동',
      merchantName: '기브싸인',
      amount: 3_000n,
      message: '안녕',
      cumulative: 3_000n,
      custom: '   ',
    });
    expect(out.text).toContain('누적 후원');
  });
});

describe('카드 빌링키 구조', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('카드로 등록하면 카드 빌링키가 저장되고 이후 결제 흐름은 계좌와 동일하게 동작한다', async () => {
    // (1) 최초 문자 -> 등록 안내 링크 발송 (결제수단 종류와 무관하게 같은 경로)
    const first = await inbound(moPayload({ to: fx.moNumber }));
    expect(first.result).toBe('UNREGISTERED_DONOR');

    // (2) 카드로 등록
    const raw = await takeRegisterToken();
    const started = await startRegistration({ token: raw, consents: CONSENTS, method: 'CARD' });
    const registration = await prisma.paymentRegistration.findUniqueOrThrow({
      where: { id: started.registrationId },
    });
    expect(registration.method).toBe('CARD');

    const done = await completeRegistration({
      token: raw,
      registrationId: started.registrationId,
      providerPayload: { tid: 'MOCKREG-CARD', card: '4111111111119876', cardIssuer: '테스트카드' },
    });
    expect(done.method).toBe('CARD');
    expect(done.cardTail4).toBe('9876');

    const token = await prisma.paymentMethodToken.findFirstOrThrow({ where: { payerId: done.payerId } });
    expect(token.method).toBe('CARD');
    expect(token.cardIssuer).toBe('테스트카드');
    expect(token.cardTail4).toBe('9876');
    expect(token.accountTail4).toBeNull();
    // 카드번호 원문은 저장하지 않는다.
    expect(JSON.stringify(token)).not.toContain('4111111111119876');

    // (3) 등록 후 문자는 결제수단 종류와 무관하게 결제으로 접수·결제된다.
    const second = await inbound(moPayload({ to: fx.moNumber, text: '카드로 결제합니다' }));
    expect(second.result).toBe('ROUTED');
    const charge = await prisma.charge.findFirstOrThrow({ where: { id: second.chargeId } });
    expect(charge.paidAt).not.toBeNull();

    // (4) 감사 문자도 동일하게 발송된다.
    expect(readMockOutbox(10).some((m) => m.text.includes('후원되었습니다'))).toBe(true);
  });

  it('계좌로 등록하면 method 는 ACCOUNT 로 남는다 (기본값 유지)', async () => {
    await inbound(moPayload({ to: fx.moNumber }));
    const raw = await takeRegisterToken();
    const started = await startRegistration({ token: raw, consents: CONSENTS });

    const done = await completeRegistration({
      token: raw,
      registrationId: started.registrationId,
      providerPayload: { tid: 'MOCKREG-ACC', bankCode: '004', bankName: 'KB국민은행', account: '11122233344455' },
    });
    expect(done.method).toBe('ACCOUNT');
    expect(done.accountTail4).toBe('4455');

    const token = await prisma.paymentMethodToken.findFirstOrThrow({ where: { payerId: done.payerId } });
    expect(token.method).toBe('ACCOUNT');
    expect(token.cardTail4).toBeNull();
  });

  it('등록 안내 문자는 결제수단에 따라 문구만 달라진다', () => {
    expect(tplRegisterGuide('기브싸인', 'https://x.test/r/abc').text).toContain('계좌 등록과 이용 동의');
    expect(tplRegisterGuide('기브싸인', 'https://x.test/r/abc', 'CARD').text).toContain('카드 등록과 이용 동의');
  });
});
