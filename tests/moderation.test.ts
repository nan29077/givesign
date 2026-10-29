import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { inboundAndPay, resetDb, seedBasics, seedRegisteredPayer, moPayload, type Fixture } from './helpers';
import { loadBannedWords } from '@/server/services/charge-flow';
import { filterContent } from '@/server/services/content-filter';

/** 사회복지기관 금칙어·차단 기능 검수 */

let fx: Fixture;
const inbound = (p: Record<string, unknown>) => inboundAndPay(p, fx.merchantId);

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await seedRegisteredPayer(fx.payerPhone);
});

async function addWord(word: string, action: 'BLOCK' | 'MASK' | 'FLAG', merchantId: string | null) {
  return prisma.bannedWord.create({
    data: {
      id: newId(),
      scope: merchantId ? 'MERCHANT' : 'GLOBAL',
      merchantId,
      word,
      action,
      active: true,
    },
  });
}

describe('사회복지기관 금칙어', () => {
  it('BLOCK 단어가 남아 있어도 결제를 막지 않고 마스킹만 한다', async () => {
    await addWord('검수차단어', 'BLOCK', fx.merchantId);

    const res = await inbound(moPayload({ to: fx.moNumber, text: '검수차단어 포함된 문자' }));
    expect(res.status).not.toBe('CONTENT_BLOCKED');

    const d = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(d.message).not.toContain('검수차단어');
    expect(d.message).toContain('*****');
  });

  it('MASK 단어는 별표로 가려서 노출하고 원문은 암호화 보관한다', async () => {
    await addWord('검수마스킹어', 'MASK', fx.merchantId);

    const res = await inbound(moPayload({ to: fx.moNumber, text: '검수마스킹어 캐시 충전합니다' }));
    expect(res.status).not.toBe('CONTENT_BLOCKED');

    const d = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(d.message).not.toContain('검수마스킹어');
    expect(d.message).toContain('******');
    expect(d.message).toContain('캐시 충전합니다');
    // 분쟁 대응용 원문은 암호화해 보관한다
    expect(d.messageRawEnc).toBeTruthy();
  });

  it('FLAG 단어는 노출은 그대로 두고 기록만 남긴다', async () => {
    await addWord('검수표시어', 'FLAG', fx.merchantId);

    const res = await inbound(moPayload({ to: fx.moNumber, text: '검수표시어 화이팅' }));
    const d = await prisma.charge.findUniqueOrThrow({ where: { id: res.chargeId! } });
    expect(d.message).toContain('검수표시어');
  });

  it('사용 중지(active=false)한 단어는 적용되지 않는다', async () => {
    const w = await addWord('검수차단어', 'BLOCK', fx.merchantId);
    await prisma.bannedWord.update({ where: { id: w.id }, data: { active: false } });

    const res = await inbound(moPayload({ to: fx.moNumber, text: '검수차단어 다시 보냅니다' }));
    expect(res.status).not.toBe('CONTENT_BLOCKED');
  });

  it('내 금칙어는 다른 사회복지기관에 적용되지 않는다 (스코프 격리)', async () => {
    await addWord('내단어만', 'BLOCK', fx.merchantId);

    const otherUser = await prisma.user.create({
      data: { id: newId(), email: `other-${newId()}@test.kr`, name: '다른사회복지기관', role: 'MERCHANT' },
    });
    const other = await prisma.merchantProfile.create({
      data: { id: newId(), userId: otherUser.id, displayName: '다른채널', code: `GIV-${newId().slice(-4)}`, status: 'APPROVED' },
    });

    const mine = await loadBannedWords(fx.merchantId);
    const theirs = await loadBannedWords(other.id);
    expect(mine.some((r) => r.word === '내단어만')).toBe(true);
    expect(theirs.some((r) => r.word === '내단어만')).toBe(false);
  });

  it('전역 금칙어와 내 금칙어가 함께 적용된다', async () => {
    await addWord('전역차단어', 'BLOCK', null);
    await addWord('내차단어', 'BLOCK', fx.merchantId);

    const rules = await loadBannedWords(fx.merchantId);
    expect(rules.some((r) => r.word === '전역차단어')).toBe(true);
    expect(rules.some((r) => r.word === '내차단어')).toBe(true);
  });

  it('대소문자·부분일치로도 잡히고, 정규식 특수문자는 문자 그대로 처리한다', () => {
    const r1 = filterContent('This is BadWord inside', { bannedWords: [{ word: 'badword', action: 'BLOCK' }] });
    expect(r1.action).toBe('BLOCK');

    // 특수문자가 정규식으로 해석되면 엉뚱한 문자가 걸린다
    const r2 = filterContent('안전한 문장입니다', { bannedWords: [{ word: 'a.c', action: 'BLOCK' }] });
    expect(r2.action).toBe('ALLOW');
  });

  it('개인정보와 링크는 금칙어와 무관하게 항상 마스킹된다', () => {
    const r = filterContent('연락처 010-1234-5678 메일 a@b.com https://spam.kr 확인', { maxLength: 200 });
    expect(r.clean).not.toContain('1234-5678');
    expect(r.clean).not.toContain('a@b.com');
    expect(r.clean).toContain('[링크 차단]');
    expect(r.containsPersonalInfo).toBe(true);
  });
});

describe('후원자 차단', () => {
  it('차단한 후원자의 문자는 접수되지 않는다', async () => {
    const payer = await prisma.payerProfile.findFirstOrThrow();
    await prisma.blockedPayer.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, reason: '검수' },
    });

    const res = await inbound(moPayload({ to: fx.moNumber, text: '차단된 후원자 메시지' }));
    expect(res.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });

  it('후원자가 건 차단은 사회복지기관 차단과 분리되어 있다', async () => {
    const payer = await prisma.payerProfile.findFirstOrThrow();
    // 후원자 -> 사회복지기관 방향 차단 (내 정보 > 차단 관리)
    await prisma.payerMerchantLink.create({
      data: { id: newId(), payerId: payer.id, merchantId: fx.merchantId, payerBlockedAt: new Date() },
    });

    const res = await inbound(moPayload({ to: fx.moNumber, text: '후원자가 차단한 사회복지기관' }));
    expect(res.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);

    // 사회복지기관이 차단했다가 해제해도(blocked_payer 행 생성 후 삭제)
    // 후원자가 건 차단은 그대로 남아야 한다. 예전에는 한 컬럼을 공유해 함께 풀렸다.
    await prisma.blockedPayer.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, reason: '검수' },
    });
    await prisma.blockedPayer.deleteMany({ where: { merchantId: fx.merchantId, payerId: payer.id } });

    const link = await prisma.payerMerchantLink.findUniqueOrThrow({
      where: { payerId_merchantId: { payerId: payer.id, merchantId: fx.merchantId } },
    });
    expect(link.payerBlockedAt).not.toBeNull();

    const after = await inbound(moPayload({ to: fx.moNumber, text: '해제 후에도 차단 유지' }));
    expect(after.status).toBe('LIMIT_BLOCKED');
    expect(await prisma.paymentTransaction.count()).toBe(0);
  });
});
