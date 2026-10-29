import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { readMockOutbox } from '@/server/adapters/mt';
import { completeRegistration, revokePaymentMethod, startRegistration } from '@/server/services/payer-registration';
import { generateToken, tokenHash } from '@/lib/crypto';
import { inboundAndPay, moPayload, resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';

let fx: Fixture;

async function inbound(payload: Record<string, unknown>) {
  return inboundAndPay(payload, fx.merchantId);
}

describe('전화번호별 내통장결제 가입 상태', () => {
  beforeEach(async () => {
    await resetDb();
    fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  });

  it('가입 전 MO가 겹쳐도 가입 링크 MT는 최초 1건만 발송한다', async () => {
    const results = await Promise.all([
      inbound(moPayload({ to: fx.moNumber, messageId: 'MO-ONBOARD-FIRST-1' })),
      inbound(moPayload({ to: fx.moNumber, messageId: 'MO-ONBOARD-FIRST-2' })),
      inbound(moPayload({ to: fx.moNumber, messageId: 'MO-ONBOARD-FIRST-3' })),
    ]);

    expect(results.every((result) => result.result === 'UNREGISTERED_DONOR')).toBe(true);
    expect(await prisma.payerProfile.count()).toBe(1);
    expect(await prisma.charge.count()).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);
    expect(await prisma.secureLink.count({ where: { purpose: 'REGISTER_ACCOUNT' } })).toBe(1);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'REGISTER_GUIDE' } })).toBe(1);
    expect(readMockOutbox(10).filter((message) => message.text.includes('계좌 등록과 이용 동의')).length).toBe(1);

    const payer = await prisma.payerProfile.findFirstOrThrow();
    expect(payer.onboardingStatus).toBe('LINK_SENT');
    expect(payer.registrationLinkSentAt).not.toBeNull();
  });

  it('최초 안내 후 가입을 마치면 다음 MO만 결제하고 성공 감사 MT를 발송한다', async () => {
    await inbound(moPayload({ to: fx.moNumber, messageId: 'MO-ONBOARD-GUIDE' }));
    await inbound(moPayload({ to: fx.moNumber, messageId: 'MO-ONBOARD-WAIT', text: '가입 대기 중 문자' }));
    expect(await prisma.charge.count()).toBe(0);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'REGISTER_GUIDE' } })).toBe(1);

    const rawToken = generateToken(16);
    const link = await prisma.secureLink.findFirstOrThrow({ where: { purpose: 'REGISTER_ACCOUNT' } });
    await prisma.secureLink.update({ where: { id: link.id }, data: { tokenHash: tokenHash(rawToken) } });
    const consents = (['TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM'] as const).map(
      (type) => ({ type, agreed: true }),
    );
    const registration = await startRegistration({ token: rawToken, consents });
    await completeRegistration({
      token: rawToken,
      registrationId: registration.registrationId,
      providerPayload: {
        tid: 'MOCK-ONBOARD-REG',
        bankCode: '004',
        bankName: 'KB국민은행',
        account: '11122233344455',
      },
    });

    const payer = await prisma.payerProfile.findFirstOrThrow();
    expect(payer.onboardingStatus).toBe('REGISTERED');

    const paid = await inbound(moPayload({ to: fx.moNumber, messageId: 'MO-ONBOARD-PAID', text: '가입 후 결제' }));
    const charge = await prisma.charge.findUniqueOrThrow({ where: { id: paid.chargeId } });
    expect(charge.paidAt).not.toBeNull();
    expect(await prisma.paymentTransaction.count({ where: { chargeId: charge.id, status: 'APPROVED' } })).toBe(1);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'REGISTER_GUIDE' } })).toBe(1);

    const success = await prisma.mtOutboundMessage.findFirstOrThrow({
      where: { chargeId: charge.id, templateCode: 'CHARGE_SUCCESS', status: 'SENT' },
    });
    // 닉네임을 정하지 않은 후원자는 번호 끝 4자리로 만든 기본 이름으로 표시된다.
    // (예전에는 마스킹 번호 010-****-5678 을 그대로 썼다)
    expect(success.bodyMasked).toContain('후원자5678님, 테스트사회복지기관 사회복지기관에 3,000원이 후원되었습니다.');
    expect(success.bodyMasked).not.toContain('010-');
  });

  it('결제수단 해지 후에는 가입 링크를 재발송하거나 결제하지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    expect(await revokePaymentMethod(payer.id)).toBe(true);
    expect((await prisma.payerProfile.findUniqueOrThrow({ where: { id: payer.id } })).onboardingStatus).toBe('SUSPENDED');

    await inbound(moPayload({ to: fx.moNumber, messageId: 'MO-ONBOARD-SUSPENDED' }));
    expect(await prisma.charge.count()).toBe(0);
    expect(await prisma.paymentTransaction.count()).toBe(0);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'REGISTER_GUIDE' } })).toBe(0);
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'ACCOUNT_INACTIVE' } })).toBe(1);
  });
});
