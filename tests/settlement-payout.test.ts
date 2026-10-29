import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import {
  createSettlementRequest,
  markSettlementPaid,
  markSettlementPayoutFailed,
  fileWithholdingAndPurgeResident,
  buildPayoutRows,
  getSettlementSummary,
  calculateWithholding,
} from '@/server/services/settlement';
import { isValidResident, normalizeResident, maskResident, decrypt } from '@/lib/crypto';
import { filterContent } from '@/server/services/content-filter';

/** 기대 원천징수액 = 소득세 3%(10원절사) + 지방소득세 10%(10원절사), 소액부징수 적용 */
const expectedWithholding = (amount: bigint) => calculateWithholding(amount).total;

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => inboundAndPay(p, fx.merchantId);

// 정산 요청이 가능하도록 계좌를 인증 상태로 등록한다.
async function verifiedAccount(merchantId: string) {
  const { encrypt } = await import('@/lib/crypto');
  await prisma.settlementAccount.upsert({
    where: { merchantId },
    create: {
      id: newId(), merchantId, bankCode: '004', bankName: 'KB국민은행',
      accountEnc: encrypt('11122233344455'), accountTail4: '4455',
      holderNameEnc: encrypt('김도네'), holderMasked: '김*네', verified: true, verifiedAt: new Date(),
    },
    update: {
      verified: true, verifiedAt: new Date(), bankCode: '004', bankName: 'KB국민은행',
      accountEnc: encrypt('11122233344455'), accountTail4: '4455',
      holderNameEnc: encrypt('김도네'), holderMasked: '김*네',
    },
  });
}

async function fund(merchantId: string) {
  // 결제 완료 결제 몇 건으로 정산 잔액을 만든다.
  await seedRegisteredPayer(fx.payerPhone);
  for (let i = 0; i < 5; i += 1) {
    // 금액은 본문이 아니라 사회복지기관 고정 금액(3000원)으로 결정된다.
    await inbound(moPayload({ to: fx.moNumber, messageId: `FUND-${i}-${Date.now()}`, text: `응원 ${i}` }));
  }
  const s = await getSettlementSummary(merchantId);
  return s.available;
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await verifiedAccount(fx.merchantId);
});

describe('주민등록번호 유틸', () => {
  it('정규화·마스킹·검증이 동작한다', () => {
    expect(normalizeResident('901010-1234567')).toBe('9010101234567');
    expect(normalizeResident('9010101234')).toBeNull();
    expect(maskResident('9010101234567')).toBe('901010-1******');
    // 체크섬이 맞는 값은 통과해야 한다.
    // 음성 단언만 있으면 isValidResident 가 return false 로 퇴화해도 통과해서,
    // 모든 사회복지기관의 원천징수용 주민번호 등록이 조용히 막히는 회귀를 못 잡는다.
    expect(isValidResident('9010101234560')).toBe(true);
    expect(isValidResident('0001013000008')).toBe(true);
    // 체크섬이 틀리면 거절한다.
    expect(isValidResident('9010101234567')).toBe(false);
    expect(isValidResident('9010101234561')).toBe(false);
  });
});

describe('정산 요청 + 주민번호 저장', () => {
  it('주민번호는 암호화 저장되고 마스킹만 노출된다', async () => {
    const available = await fund(fx.merchantId);
    expect(available).toBeGreaterThan(0n);

    const req = await createSettlementRequest(fx.merchantId, available, { resident: '9010101234567' });
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.residentMasked).toBe('901010-1******');
    expect(row.residentEnc).toBeTruthy();
    expect(decrypt(row.residentEnc!)).toBe('9010101234567'); // 서버 내부에서만 복호화
    expect(row.withholding).toBe(expectedWithholding(available));
  });
});

describe('지급대행 흐름', () => {
  it('승인 건으로 이체 파일 행을 만들고 계좌를 복호화한다', async () => {
    const available = await fund(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, available, { resident: '9010101234567' });
    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });

    const rows = await buildPayoutRows([req.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].bankCode).toBe('004');
    expect(rows[0].account).toBe('11122233344455');
    expect(rows[0].holder).toBe('김도네');
    expect(rows[0].amount).toBe(req.payoutAmount);
  });

  it('미인증 계좌는 이체 파일에서 제외된다', async () => {
    const available = await fund(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, available, { resident: '9010101234567' });
    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });
    await prisma.settlementAccount.update({ where: { merchantId: fx.merchantId }, data: { verified: false } });

    expect(await buildPayoutRows([req.id])).toHaveLength(0);
  });

  it('지급 실패 시 지급·원천징수 분개가 잔액으로 환입된다', async () => {
    const available = await fund(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, available, { resident: '9010101234567' });
    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });

    await markSettlementPaid(req.id, 'admin');
    const afterPaid = await getSettlementSummary(fx.merchantId);
    expect(afterPaid.balance).toBe(0n);

    await markSettlementPayoutFailed(req.id, '계좌 오류', 'admin');
    const afterFail = await getSettlementSummary(fx.merchantId);
    // 환입되어 다시 요청 가능한 잔액이 살아난다.
    expect(afterFail.balance).toBe(available);
    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.status).toBe('PAYOUT_FAILED');
    expect(row.payoutFailReason).toContain('계좌 오류');
  });

  it('원천징수 신고 완료 시 주민번호만 파기하고 회계 기록은 유지한다', async () => {
    const available = await fund(fx.merchantId);
    const req = await createSettlementRequest(fx.merchantId, available, { resident: '9010101234567' });
    await prisma.settlementRequest.update({ where: { id: req.id }, data: { status: 'APPROVED' } });
    await markSettlementPaid(req.id, 'admin');

    const r = await fileWithholdingAndPurgeResident(req.id, 'admin');
    expect(r.purged).toBe(true);

    const row = await prisma.settlementRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(row.residentEnc).toBeNull(); // 원문 파기
    expect(row.residentMasked).toBe('901010-1******'); // 마스킹은 유지
    expect(row.residentPurgedAt).not.toBeNull();
    expect(row.withholdingFiledAt).not.toBeNull();
    expect(row.withholding).toBe(expectedWithholding(available)); // 회계 기록 유지
  });
});

describe('금칙어 우회 매칭', () => {
  it('글자 사이 공백·기호로 우회해도 잡는다', () => {
    const rules = [{ word: '바보', action: 'BLOCK' as const }];
    expect(filterContent('바보 멍청이', { bannedWords: rules }).action).toBe('BLOCK');
    expect(filterContent('바 보 야', { bannedWords: rules }).action).toBe('BLOCK');
    expect(filterContent('바.보', { bannedWords: rules }).action).toBe('BLOCK');
    expect(filterContent('바_보', { bannedWords: rules }).action).toBe('BLOCK');
  });

  it('다른 글자가 낀 경우는 오탐하지 않는다', () => {
    const rules = [{ word: '노출', action: 'BLOCK' as const }];
    // 노트북 출력 → 노와 출 사이에 글자가 있으므로 매칭 안 됨
    expect(filterContent('노트북 출력 좋아요', { bannedWords: rules }).action).toBe('ALLOW');
  });

  it('마스킹은 우회 구간까지 함께 가린다', () => {
    const r = filterContent('바 보 최고', { bannedWords: [{ word: '바보', action: 'MASK' }] });
    expect(r.action).toBe('MASK');
    expect(r.clean).not.toContain('바 보');
    expect(r.clean).toContain('최고');
  });
});
