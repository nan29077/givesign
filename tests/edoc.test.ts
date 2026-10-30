import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
// 서명 이미지는 저장소에 쓰지 않고 주소만 돌려준다.
vi.mock('@/server/uploads', () => ({ newObjectName: (ext: string) => `test.${ext}`, putObject: vi.fn(async (name: string) => `/uploads/${name}`) }));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { tokenHash } from '@/lib/crypto';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { parseTopupBonusText, pickUseSource, splitVat, topupBonusFor } from '@/lib/edoc-billing';
import {
  adjustWallet,
  approveBillingRequest,
  createEDocPlan,
  ensureWallet,
  EDocBillingError,
  expireEDocSubscriptions,
  rejectBillingRequest,
  requestBilling,
  verifyWallet,
} from '@/server/services/edoc-billing';
import {
  accessProof,
  cancelEnvelope,
  createBulkEnvelopes,
  createEnvelope,
  declineAsSigner,
  expireEDocEnvelopes,
  loadSigner,
  parseRecipientLines,
  readSnapshot,
  remindSigner,
  signAsSigner,
  verifyEnvelopeChain,
} from '@/server/services/edoc';

/**
 * 전자문서(서명 요청 · 이용요금).
 *  - 차감 순서(정액 → 시범 → 충전), 같은 화면 두 번 제출 시 1회만 차감, 동시 발송에서도 잔액이 음수가 되지 않음
 *  - 원장 append-only, 원장 합계 = 지갑
 *  - 발송 시점 서식 고정, 순차 서명, 완료본 해시, 감사추적 해시 체인
 *  - 열람 전 취소만 환원, 거절, 만료
 */

// 1x1 PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

let fx: Fixture;
let templateId: string;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  const t = await prisma.documentTemplate.create({
    data: {
      id: newId(),
      merchantId: fx.merchantId,
      name: '후원약정서',
      templateType: 'EDITOR',
      body: '원래 본문',
      requireSignature: true,
      fields: [
        { id: 'name', label: '성명', type: 'TEXT', required: true },
        { id: 'amount', label: '약정 금액', type: 'NUMBER', required: true },
        { id: 'agree', label: '동의', type: 'CHECKBOX', required: true },
      ],
    },
  });
  templateId = t.id;
});

const one = (over: Partial<Parameters<typeof createEnvelope>[0]> = {}) =>
  createEnvelope({
    merchantId: fx.merchantId,
    actorId: fx.merchantUserId,
    nonce: newId(),
    templateId,
    signingOrder: 'PARALLEL',
    signers: [{ name: '홍길동', phone: '010-1111-2222', role: 'DONOR' }],
    ...over,
  });

/** 서명자 링크를 아는 값으로 바꾸고, 본인확인을 마친 증표를 만든다. */
async function tokenFor(signerId: string) {
  const token = `test-token-${signerId}-abcdefgh`;
  await prisma.eDocSigner.update({ where: { id: signerId }, data: { tokenHash: tokenHash(token) } });
  const proof = accessProof(signerId, tokenHash(token), Math.floor(Date.now() / 1000) + 600);
  return { token, proof };
}

describe('요금 계산', () => {
  it('정액 → 시범 → 충전 순서로 고르고, 모두 없으면 null', () => {
    const now = new Date('2026-10-30T00:00:00Z');
    const sub = { endsAt: new Date('2026-11-10T00:00:00Z'), quota: 2, used: 1 };
    expect(pickUseSource({ subscription: sub, trialRemaining: 1, balance: 1000, perDocument: 200, now })).toBe('MONTHLY');
    expect(pickUseSource({ subscription: { ...sub, used: 2 }, trialRemaining: 1, balance: 1000, perDocument: 200, now })).toBe('TRIAL');
    expect(pickUseSource({ subscription: { ...sub, endsAt: new Date('2026-10-01') }, trialRemaining: 0, balance: 200, perDocument: 200, now })).toBe('PREPAID');
    expect(pickUseSource({ subscription: null, trialRemaining: 0, balance: 199, perDocument: 200, now })).toBeNull();
  });
  it('부가세 분리·충전 보너스', () => {
    expect(splitVat(11000)).toEqual({ supply: 10000, vat: 1000 });
    expect(splitVat(-200)).toEqual({ supply: -182, vat: -18 });
    const rules = parseTopupBonusText('100000:5, 300000:10')!;
    expect(topupBonusFor(99000, rules)).toBe(0);
    expect(topupBonusFor(100000, rules)).toBe(5000);
    expect(topupBonusFor(500000, rules)).toBe(50000);
    expect(parseTopupBonusText('abc')).toBeNull();
  });
});

describe('지갑 · 원장', () => {
  it('지갑은 한 번만 만들고 시범 제공량도 한 번만 준다', async () => {
    await Promise.all([ensureWallet(fx.merchantId), ensureWallet(fx.merchantId), ensureWallet(fx.merchantId)]);
    const w = await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } });
    expect(w.trialRemaining).toBe(5);
    expect(await prisma.eDocLedger.count({ where: { kind: 'TRIAL_GRANT' } })).toBe(1);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('원장과 감사추적은 수정·삭제할 수 없다', async () => {
    const r = await one();
    await expect(prisma.$executeRawUnsafe(`UPDATE edoc_ledger SET memo = 'x'`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`DELETE FROM edoc_ledger`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`UPDATE edoc_event SET type = 'X' WHERE envelope_id = '${r.envelopeId}'`)).rejects.toThrow();
  });

  it('충전 신청만으로는 잔액이 늘지 않고, 입금 확인 체크 없이 승인할 수 없으며 두 번 승인되지 않는다', async () => {
    await createEDocPlan({ perDocument: 200, monthlyPrice: 30000, monthlyQuota: 200, trialQuota: 5, lowBalance: 2000, topupBonus: [{ min: 100000, percent: 5 }], effectiveFrom: new Date(), note: null, actorId: 'admin' });
    const id = newId();
    const a = await requestBilling({ merchantId: fx.merchantId, actorId: 'u', requestId: id, kind: 'TOPUP', amount: 110000, depositorName: '기관', wantsTaxInvoice: true });
    const b = await requestBilling({ merchantId: fx.merchantId, actorId: 'u', requestId: id, kind: 'TOPUP', amount: 110000, depositorName: '기관', wantsTaxInvoice: true });
    expect(a.duplicated).toBe(false);
    expect(b.duplicated).toBe(true);
    expect(a.request.bonus).toBe(5500);
    expect((await ensureWallet(fx.merchantId)).balance).toBe(0);

    await expect(approveBillingRequest({ requestId: id, actorId: 'admin', paymentConfirmed: false, taxInvoiceIssued: false })).rejects.toBeInstanceOf(EDocBillingError);
    const results = await Promise.allSettled([
      approveBillingRequest({ requestId: id, actorId: 'admin', paymentConfirmed: true, taxInvoiceIssued: true }),
      approveBillingRequest({ requestId: id, actorId: 'admin', paymentConfirmed: true, taxInvoiceIssued: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const w = await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } });
    expect(w.balance).toBe(115500);
    const topup = await prisma.eDocLedger.findUniqueOrThrow({ where: { idempotencyKey: `topup:${id}` } });
    expect(topup.supplyAmount + topup.vatAmount).toBe(110000);
    expect(topup.vatAmount).toBe(10000);
    const bonus = await prisma.eDocLedger.findUniqueOrThrow({ where: { idempotencyKey: `bonus:${id}` } });
    expect(bonus.supplyAmount).toBe(0);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
    await expect(rejectBillingRequest({ requestId: id, actorId: 'admin', reason: '중복' })).rejects.toThrow(/이미 처리/);
  });

  it('관리자 정정은 사유가 필요하고 결과가 음수가 되면 거절한다', async () => {
    await ensureWallet(fx.merchantId);
    await expect(adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: 1000, units: 0, reason: ' ', nonce: newId() })).rejects.toThrow(/사유/);
    await expect(adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: -1, units: 0, reason: '정정', nonce: newId() })).rejects.toThrow(/0보다/);
    await adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: 3000, units: -5, reason: '이벤트 정정', nonce: newId() });
    const w = await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } });
    expect([w.balance, w.trialRemaining]).toEqual([3000, 0]);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('30일 정액을 승인하면 정액에서 먼저 차감하고, 기간이 끝나면 남은 제공량을 소멸 기록으로 남긴다', async () => {
    const id = newId();
    await requestBilling({ merchantId: fx.merchantId, actorId: 'u', requestId: id, kind: 'MONTHLY', depositorName: null, wantsTaxInvoice: false });
    const r = await approveBillingRequest({ requestId: id, actorId: 'admin', paymentConfirmed: true, taxInvoiceIssued: false });
    expect(r.kind).toBe('MONTHLY');
    const grant = await prisma.eDocLedger.findUniqueOrThrow({ where: { idempotencyKey: `plan:${id}` } });
    expect(grant.amount).toBe(0);
    expect(grant.supplyAmount + grant.vatAmount).toBe(30000);

    const e = await one();
    expect(e.charge?.source).toBe('MONTHLY');
    expect((await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).trialRemaining).toBe(5);

    const expired = await expireEDocSubscriptions(new Date(Date.now() + 31 * 86400_000));
    expect(expired).toBe(1);
    const sub = await prisma.eDocSubscription.findFirstOrThrow();
    expect(sub.status).toBe('EXPIRED');
    const exp = await prisma.eDocLedger.findFirstOrThrow({ where: { kind: 'EXPIRE' } });
    expect(exp.units).toBe(-199);
    expect(await expireEDocSubscriptions(new Date(Date.now() + 31 * 86400_000))).toBe(0);
  });
});

describe('서명 요청 발송', () => {
  it('같은 화면을 두 번 제출해도 한 번만 만들고 한 번만 차감하며, 발송 시점 서식을 고정한다', async () => {
    const nonce = newId();
    const a = await one({ nonce });
    const b = await one({ nonce });
    expect(b.duplicated).toBe(true);
    expect(await prisma.eDocEnvelope.count()).toBe(1);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(1);
    expect((await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).trialRemaining).toBe(4);

    await prisma.documentTemplate.update({ where: { id: templateId }, data: { body: '나중에 고친 본문', fields: [] } });
    const env = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: a.envelopeId }, include: { signers: true } });
    const snap = readSnapshot(env.snapshotEnc);
    expect(snap.body).toBe('원래 본문');
    expect(snap.fields).toHaveLength(3);
    expect(env.snapshotEnc).not.toContain('원래 본문');
    expect(env.signers[0]!.nameEnc).not.toContain('홍길동');
    expect(env.signers[0]!.phoneMasked).toMatch(/\*/);
    const sentMt = await prisma.mtOutboundMessage.findFirstOrThrow({ where: { templateCode: 'EDOC_SIGN_REQUEST' } });
    expect(sentMt.bodyMasked).toContain('[보안링크]');
  });

  it('다른 기관 서식은 쓸 수 없고, 잔액이 없으면 아무것도 만들지 않는다', async () => {
    const other = await prisma.documentTemplate.create({ data: { id: newId(), merchantId: fx.merchantId, name: '보관됨', templateType: 'EDITOR', body: 'x', requireSignature: false, archivedAt: new Date() } });
    await expect(one({ templateId: other.id })).rejects.toThrow(/서식/);
    await ensureWallet(fx.merchantId);
    await adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: 0, units: -5, reason: '시범 회수', nonce: newId() });
    await expect(one()).rejects.toBeInstanceOf(EDocBillingError);
    expect(await prisma.eDocEnvelope.count()).toBe(0);
    expect(await prisma.eDocSigner.count()).toBe(0);
  });

  it('동시에 여러 건을 보내도 잔액만큼만 만들어지고 잔액이 음수가 되지 않는다', async () => {
    await ensureWallet(fx.merchantId);
    await adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: 400, units: -3, reason: '테스트', nonce: newId() });
    // 시범 2건 + 충전 400원(2건) = 4건
    const results = await Promise.allSettled(Array.from({ length: 7 }, () => one()));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(4);
    const w = await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } });
    expect([w.balance, w.trialRemaining, w.totalUsed]).toEqual([0, 0, 4]);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('대량 발송은 줄마다 1건씩 만들고, 같은 묶음을 다시 보내도 중복으로 만들지 않는다', async () => {
    const rows = parseRecipientLines('이름,휴대폰\n김하나, 010-2222-3333\n박둘\t01033334444\n잘못된줄, 123');
    expect(rows).toHaveLength(3);
    const batchNonce = newId();
    const first = await createBulkEnvelopes({ merchantId: fx.merchantId, actorId: fx.merchantUserId, templateId, role: 'DONOR', rows, batchNonce });
    expect(first.created).toBe(2);
    expect(first.failed).toBe(1);
    const again = await createBulkEnvelopes({ merchantId: fx.merchantId, actorId: fx.merchantUserId, templateId, role: 'DONOR', rows, batchNonce });
    expect(again.created).toBe(2);
    expect(await prisma.eDocEnvelope.count()).toBe(2);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(2);
  });
});

describe('서명', () => {
  it('순서대로 서명: 첫 서명자가 작성·서명하면 다음 사람에게 가고, 모두 서명하면 완료되며 해시 체인이 맞다', async () => {
    const r = await one({
      signingOrder: 'SEQUENTIAL',
      signers: [
        { name: '홍길동', phone: '010-1111-2222', role: 'PARTICIPANT' },
        { name: '홍부모', phone: '010-3333-4444', role: 'GUARDIAN' },
      ],
    });
    const [s1, s2] = await prisma.eDocSigner.findMany({ where: { envelopeId: r.envelopeId }, orderBy: { order: 'asc' } });
    expect([s1!.status, s2!.status]).toEqual(['SENT', 'WAITING']);

    const a = await tokenFor(s1!.id);
    // 본인확인 없이는 서명할 수 없다.
    await expect(signAsSigner({ token: a.token, proof: undefined, values: {}, signature: PNG, agreed: true })).rejects.toThrow(/본인확인/);
    await expect(signAsSigner({ token: a.token, proof: a.proof, values: { name: '홍길동', amount: '10000' }, signature: PNG, agreed: true })).rejects.toThrow(/동의/);
    const out1 = await signAsSigner({ token: a.token, proof: a.proof, values: { name: '홍길동', amount: '10,000', agree: 'on' }, signature: PNG, agreed: true, ip: '1.2.3.4' });
    expect(out1.completed).toBe(false);
    await expect(signAsSigner({ token: a.token, proof: a.proof, values: { name: '홍길동', amount: '1', agree: 'on' }, signature: PNG, agreed: true })).rejects.toThrow();

    const mid = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: r.envelopeId }, include: { signers: { orderBy: { order: 'asc' } } } });
    expect(mid.status).toBe('IN_PROGRESS');
    expect(mid.signers[1]!.status).toBe('SENT');
    expect(mid.signers[0]!.valuesEnc).not.toContain('홍길동');

    const b = await tokenFor(s2!.id);
    const view = await loadSigner(b.token);
    expect(view.ok && view.canSign).toBe(true);
    const out2 = await signAsSigner({ token: b.token, proof: b.proof, values: { name: '바꾸려는 값' }, signature: PNG, agreed: true });
    expect(out2.completed).toBe(true);

    const done = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: r.envelopeId } });
    expect(done.status).toBe('COMPLETED');
    expect(done.documentHash).toHaveLength(64);
    const chain = await verifyEnvelopeChain(r.envelopeId);
    expect(chain.ok).toBe(true);
    expect(chain.count).toBe(await prisma.eDocEvent.count({ where: { envelopeId: r.envelopeId } }));
    expect(await prisma.mtOutboundMessage.count({ where: { templateCode: 'EDOC_COMPLETED' } })).toBe(2);
  });

  it('동시 서명: 첫 서명자가 작성하기 전에는 다른 서명자가 서명할 수 없다', async () => {
    const r = await one({ signers: [{ name: '김봉사', phone: '010-1111-2222', role: 'VOLUNTEER' }, { name: '담당자', phone: '010-5555-6666', role: 'STAFF' }] });
    const [, s2] = await prisma.eDocSigner.findMany({ where: { envelopeId: r.envelopeId }, orderBy: { order: 'asc' } });
    expect(s2!.status).toBe('SENT');
    const b = await tokenFor(s2!.id);
    await expect(signAsSigner({ token: b.token, proof: b.proof, values: {}, signature: PNG, agreed: true })).rejects.toThrow(/첫 번째 서명자/);
  });

  it('재발송하면 이전 링크는 열리지 않는다', async () => {
    const r = await one();
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const old = await tokenFor(s.id);
    await remindSigner({ merchantId: fx.merchantId, envelopeId: r.envelopeId, signerId: s.id, actorId: fx.merchantUserId });
    expect((await loadSigner(old.token)).ok).toBe(false);
    await expect(remindSigner({ merchantId: fx.merchantId, envelopeId: r.envelopeId, signerId: s.id, actorId: fx.merchantUserId })).rejects.toThrow(/1시간/);
  });

  it('거절하면 문서가 멈추고, 이후 서명할 수 없다', async () => {
    const r = await one();
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: r.envelopeId } });
    const a = await tokenFor(s.id);
    await expect(declineAsSigner({ token: a.token, proof: a.proof, reason: '' })).rejects.toThrow(/사유/);
    await declineAsSigner({ token: a.token, proof: a.proof, reason: '금액 다시 상의' });
    expect((await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: r.envelopeId } })).status).toBe('DECLINED');
    await expect(signAsSigner({ token: a.token, proof: a.proof, values: { name: 'x', amount: '1', agree: 'on' }, signature: PNG, agreed: true })).rejects.toThrow();
  });
});

describe('취소 · 만료', () => {
  it('아무도 열기 전에 취소하면 환원하고, 연 뒤에 취소하면 환원하지 않는다', async () => {
    const a = await one();
    await cancelEnvelope({ merchantId: fx.merchantId, envelopeId: a.envelopeId, actorId: fx.merchantUserId, reason: '번호 오기' });
    expect((await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).trialRemaining).toBe(5);
    await expect(cancelEnvelope({ merchantId: fx.merchantId, envelopeId: a.envelopeId, actorId: fx.merchantUserId, reason: '또' })).rejects.toThrow(/진행 중/);

    const b = await one();
    await prisma.eDocSigner.updateMany({ where: { envelopeId: b.envelopeId }, data: { viewedAt: new Date() } });
    const res = await cancelEnvelope({ merchantId: fx.merchantId, envelopeId: b.envelopeId, actorId: fx.merchantUserId, reason: '내용 변경' });
    expect(res.refunded).toBe(false);
    expect((await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).trialRemaining).toBe(4);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('충전 잔액으로 보낸 건을 취소하면 금액을 되돌린다(부가세 분리 포함)', async () => {
    await ensureWallet(fx.merchantId);
    await adjustWallet({ merchantId: fx.merchantId, actorId: 'a', amount: 200, units: -5, reason: '테스트', nonce: newId() });
    const a = await one();
    expect(a.charge?.source).toBe('PREPAID');
    const use = await prisma.eDocLedger.findUniqueOrThrow({ where: { idempotencyKey: `use:${a.envelopeId}` } });
    expect([use.amount, use.supplyAmount, use.vatAmount]).toEqual([-200, -182, -18]);
    await cancelEnvelope({ merchantId: fx.merchantId, envelopeId: a.envelopeId, actorId: fx.merchantUserId, reason: '취소' });
    expect((await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).balance).toBe(200);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('기한이 지나면 만료되고 링크는 서명할 수 없는 상태가 된다', async () => {
    const a = await one();
    await prisma.eDocEnvelope.update({ where: { id: a.envelopeId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const s = await prisma.eDocSigner.findFirstOrThrow({ where: { envelopeId: a.envelopeId } });
    const t = await tokenFor(s.id);
    const before = await loadSigner(t.token);
    expect(before.ok && before.canSign).toBe(false);
    expect(await expireEDocEnvelopes()).toBe(1);
    expect((await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: a.envelopeId } })).status).toBe('EXPIRED');
    expect((await verifyEnvelopeChain(a.envelopeId)).ok).toBe(true);
  });
});
