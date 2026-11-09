import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { addDays } from '@/lib/datetime';
import { readMockOutbox } from '@/server/adapters/mt';
import { forecastEDocCost } from '@/lib/edoc-forecast';
import {
  balanceBlockedQueue, bundleItemDedupeKey, bundlesInboxGroup, checkBundleProof, confirmBundleOtp, continueBundleSend, declineBundle,
  ensureDefaultBundles, handleRecurringPledgedBundle, listBundleSends, loadBundleSession, requestBundleOtp, resendBundleLink,
  retryBalanceBlocked, sendBundle, setBundleForRecurring, signBundle,
} from '@/server/services/document-bundles';
import { bundleSendPreview, registerDocumentBundleHandlers, requestBundleSend } from '@/server/services/document-bundle-approvals';
import { approveBillingRequest, ensureWallet, requestBilling, verifyWallet } from '@/server/services/edoc-billing';
import { createBulkEnvelopes, readSnapshot, verifyEnvelopeChain } from '@/server/services/edoc';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { decideApproval, runQueuedApprovals } from '@/server/services/approvals';
import { createRecurringDonation } from '@/server/services/recurring';
import { DOCUMENT_PURPOSES, MANUAL_ONLY_PURPOSES } from '@/server/services/purpose-documents';
import { ensureDefaultPurposeTemplates, purposeNeedsSignature } from '@/server/services/purpose-templates';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';

/**
 * 4차 J2·J3 — 업무별 문서 묶음 · 발송 비용 예측 · 충전 뒤 재시도.
 *
 *  1) 기본 묶음 세트는 멱등·동시 안전(기관×preset 1개).
 *  2) 묶음 발송 = 문서마다 기존 봉투(서명자 1명) + 문서마다 1건 차감(현재 요금 규칙 그대로) + 묶음 링크 문자 1통.
 *  3) 한 번의 본인확인 + 한 화면 서명으로 모든 문서가 끝난다(문서마다 감사기록·해시 체인 유지). 필수 미확인 → 아무것도 서명 안 함.
 *  4) 상태: 미열람 / 열람 후 미서명 / 거절 / 입력 오류.
 *  5) 비용 예측 = 실제 차감(정액 → 시범 → 충전 잔액).
 *  6) 잔액 부족으로 멈춘 묶음·저니는 충전 승인 이벤트 소비자가 1번만 다시 보낸다(중복 없음).
 *  7) 약정 흐름 묶음 사용은 기본 꺼짐(기존 흐름 무변화).
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAAABJRU5ErkJggg==';

let fx: Fixture;
let payerId: string;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { representativeName: '이대표' } });
  payerId = (await seedRegisteredPayer(fx.payerPhone)).id;
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기 출금 동의', content: '본문', required: false, effectiveFrom: new Date('2026-01-01') },
  });
  registerDefaultConsumers();
  registerDocumentBundleHandlers();
});

async function volunteerBundle() {
  await ensureDefaultBundles(fx.merchantId);
  return prisma.documentBundle.findFirstOrThrow({ where: { merchantId: fx.merchantId, presetKey: 'VOLUNTEER_SIGNUP' } });
}

/** 서명 화면 입력: 필수 항목을 채운 값(문서 항목 정의를 읽어 만든다) */
async function valuesFor(sessionToken: string) {
  const s = await loadBundleSession(sessionToken);
  if (!s.ok) throw new Error(s.reason);
  const values: Record<string, Record<string, string>> = {};
  for (const it of s.items) {
    const e = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: it.envelopeId } });
    const snap = readSnapshot(e.snapshotEnc);
    values[it.id] = Object.fromEntries(
      snap.fields.map((f) => [f.id, f.type === 'CHECKBOX' ? 'on' : f.type === 'DATE' ? '2026-11-20' : f.type === 'NUMBER' ? '1' : f.type === 'PHONE' ? '010-1234-5678' : '홍길동']),
    );
  }
  return { s, values };
}

function lastOtp(): string {
  const m = readMockOutbox(50).find((x) => x.template === 'EDOC_SIGN_VERIFY');
  return m!.text.match(/(\d{6})/)![1]!;
}

async function sendVolunteer(dedupeKey = 'bundle:test:1') {
  const b = await volunteerBundle();
  const r = await sendBundle({ merchantId: fx.merchantId, bundleId: b.id, payerId, context: { assignment: '토요일 오전 배식' }, dedupeKey });
  return { b, r };
}

describe('[1] 용도 · 기본 묶음', () => {
  it('새 용도(개인정보 동의·출금 동의)는 서명 문서이고 자동 발송 경로가 없다(묶음으로만)', () => {
    expect(DOCUMENT_PURPOSES).toEqual(expect.arrayContaining(['PRIVACY_CONSENT', 'DEBIT_CONSENT']));
    expect(purposeNeedsSignature('PRIVACY_CONSENT')).toBe(true);
    expect(purposeNeedsSignature('DEBIT_CONSENT')).toBe(true);
    expect(MANUAL_ONLY_PURPOSES).toEqual(expect.arrayContaining(['PRIVACY_CONSENT', 'DEBIT_CONSENT']));
  });

  it('기본 묶음은 멱등·동시 안전, 기존 CONSENT_PRIVACY 서식은 새로 만들지 않고 용도만 붙인다', async () => {
    await Promise.all([1, 2, 3, 4].map(() => ensureDefaultBundles(fx.merchantId)));
    expect(await ensureDefaultBundles(fx.merchantId)).toEqual([]);
    const bundles = await prisma.documentBundle.findMany({ where: { merchantId: fx.merchantId }, include: { items: { orderBy: { position: 'asc' } } } });
    expect(bundles).toHaveLength(2);
    const rec = bundles.find((b) => b.kind === 'RECURRING_SIGNUP')!;
    expect(rec.items.map((i) => [i.purpose, i.required])).toEqual([['SUPPORT_AGREEMENT', true], ['PRIVACY_CONSENT', true], ['DEBIT_CONSENT', true]]);
    const vol = bundles.find((b) => b.kind === 'VOLUNTEER_SIGNUP')!;
    expect(vol.items.map((i) => [i.purpose, i.required])).toEqual([['VOLUNTEER_APPLICATION', true], ['PRIVACY_CONSENT', true], ['PORTRAIT_CONSENT', false]]);
    expect(rec.useForRecurring).toBe(false);

    const old = await prisma.documentTemplate.create({ data: { id: newId(), merchantId: fx.merchantId, name: '우리 개인정보 동의서', templateType: 'PRESET', presetKey: 'CONSENT_PRIVACY', body: '동의', active: true } });
    await ensureDefaultPurposeTemplates(fx.merchantId, ['PRIVACY_CONSENT']);
    expect((await prisma.documentTemplate.findUniqueOrThrow({ where: { id: old.id } })).purpose).toBe('PRIVACY_CONSENT');
    expect(await prisma.documentTemplate.count({ where: { merchantId: fx.merchantId, presetKey: 'CONSENT_PRIVACY' } })).toBe(1);
  });

  it('약정 흐름 묶음은 정기후원 신청 묶음만, 기관당 하나만 켜진다', async () => {
    await ensureDefaultBundles(fx.merchantId);
    const [rec, vol] = await Promise.all([
      prisma.documentBundle.findFirstOrThrow({ where: { merchantId: fx.merchantId, kind: 'RECURRING_SIGNUP' } }),
      prisma.documentBundle.findFirstOrThrow({ where: { merchantId: fx.merchantId, kind: 'VOLUNTEER_SIGNUP' } }),
    ]);
    await expect(setBundleForRecurring(fx.merchantId, vol.id, true)).rejects.toThrow(/정기후원 신청 묶음만/);
    await setBundleForRecurring(fx.merchantId, rec.id, true);
    const extra = await prisma.documentBundle.create({ data: { id: newId(), merchantId: fx.merchantId, name: '복사본', kind: 'RECURRING_SIGNUP' } });
    await setBundleForRecurring(fx.merchantId, extra.id, true);
    expect(await prisma.documentBundle.count({ where: { merchantId: fx.merchantId, useForRecurring: true } })).toBe(1);
    // DB 부분 유니크도 막는다
    await expect(prisma.documentBundle.update({ where: { id: rec.id }, data: { useForRecurring: true } })).rejects.toThrow();
  });
});

describe('[2] 묶음 발송 · 이용요금', () => {
  it('문서마다 봉투 1개·1건 차감, 개별 서명 문자 없이 묶음 링크 문자 1통, 다시 불러도 한 번', async () => {
    const before = readMockOutbox(100).length;
    const { r } = await sendVolunteer();
    expect(r).toMatchObject({ ok: true, status: 'SENT' });
    const send = await prisma.documentBundleSend.findFirstOrThrow({ include: { items: true } });
    expect(send.items.every((i) => i.status === 'CREATED' && i.envelopeId)).toBe(true);
    expect(await prisma.eDocEnvelope.count()).toBe(3);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);
    const msgs = readMockOutbox(100).slice(0, readMockOutbox(100).length - before);
    const signMsgs = msgs.filter((m) => m.template === 'EDOC_SIGN_REQUEST');
    expect(signMsgs).toHaveLength(1);
    expect(signMsgs[0]!.text).toContain('/sign/bundle/');
    expect(signMsgs[0]!.text).toContain('문서 3건');
    // 발급 대장에는 묶음 문서로 남는다(문서별 발송 키)
    expect(await prisma.issuedDocument.count({ where: { subjectType: 'document_bundle_send', subjectId: send.id } })).toBe(3);
    expect(await prisma.issuedDocument.count({ where: { dedupeKey: bundleItemDedupeKey(send.id, 'PRIVACY_CONSENT') } })).toBe(1);

    const again = await sendVolunteer();
    expect(again.r).toMatchObject({ ok: true, already: true });
    expect(await prisma.eDocEnvelope.count()).toBe(3);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('동시에 같은 묶음을 보내도 봉투·차감·문자는 한 번', async () => {
    const b = await volunteerBundle();
    const call = () => sendBundle({ merchantId: fx.merchantId, bundleId: b.id, payerId, context: {}, dedupeKey: 'bundle:race' });
    await Promise.all([call(), call(), call()]);
    expect(await prisma.documentBundleSend.count()).toBe(1);
    expect(await prisma.eDocEnvelope.count()).toBe(3);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);
  });

  it('잔액이 모자라면 문서를 하나도 만들지 않고 멈춘다(반쪽 묶음 없음)', async () => {
    await prisma.eDocWallet.create({ data: { merchantId: fx.merchantId, balance: 200, trialRemaining: 1, totalUsed: 0 } });
    const { r } = await sendVolunteer();
    expect(r).toMatchObject({ ok: false, status: 'BLOCKED', blocked: 'EDOC_BALANCE' });
    expect(await prisma.eDocEnvelope.count()).toBe(0);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(0);
    const g = await bundlesInboxGroup(fx.merchantId, new Date());
    expect(g).toMatchObject({ kind: 'DOCUMENT_BUNDLE_BLOCKED', affectedCount: 1, amount: 200n });
    const q = await balanceBlockedQueue(fx.merchantId);
    expect(q).toEqual([expect.objectContaining({ kind: 'BUNDLE', units: 3 })]);
  });

  it('필수 문서 서식이 꺼져 있으면 입력 오류로 멈추고, 고친 뒤 이어 보내면 이미 만든 문서는 다시 만들지 않는다', async () => {
    await ensureDefaultPurposeTemplates(fx.merchantId, ['PRIVACY_CONSENT']);
    await prisma.documentTemplate.updateMany({ where: { merchantId: fx.merchantId, purpose: 'PRIVACY_CONSENT' }, data: { active: false } });
    const { r } = await sendVolunteer();
    expect(r).toMatchObject({ ok: false, status: 'BLOCKED', blocked: 'DISABLED' });
    const [view] = await listBundleSends(fx.merchantId);
    expect(view!.items.find((i) => i.purpose === 'PRIVACY_CONSENT')!.state).toBe('INPUT_ERROR');
    expect(await prisma.eDocEnvelope.count()).toBe(1); // 첫 문서(신청서)는 만들어졌다

    await prisma.documentTemplate.updateMany({ where: { merchantId: fx.merchantId, purpose: 'PRIVACY_CONSENT' }, data: { active: true } });
    const send = await prisma.documentBundleSend.findFirstOrThrow();
    expect(await continueBundleSend(send.id)).toMatchObject({ ok: true, status: 'SENT' });
    expect(await prisma.eDocEnvelope.count()).toBe(3);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);
  });
});

describe('[3] 한 번의 본인확인 · 한 화면 서명', () => {
  it('인증번호 1통으로 모든 문서를 열고, 한 번 제출로 모두 서명한다(문서마다 감사기록·해시 체인)', async () => {
    const { r } = await sendVolunteer();
    if (!r.ok) throw new Error('send');
    const token = r.devToken ?? (readMockOutbox(50).find((m) => m.template === 'EDOC_SIGN_REQUEST')!.text.match(/sign\/bundle\/([A-Za-z0-9_-]+)/)![1]!);
    const before = (await listBundleSends(fx.merchantId))[0]!;
    expect(before.items.every((i) => i.state === 'UNVIEWED')).toBe(true);

    await requestBundleOtp(token);
    expect(readMockOutbox(50).filter((m) => m.template === 'EDOC_SIGN_VERIFY')).toHaveLength(1);
    await expect(confirmBundleOtp(token, '000000')).rejects.toThrow(/일치하지 않습니다/);
    const c = await confirmBundleOtp(token, lastOtp());
    const s = await loadBundleSession(token);
    if (!s.ok) throw new Error('session');
    expect(checkBundleProof(c.sendId, s.tokenHash, c.proof)).toBe(true);
    expect((await listBundleSends(fx.merchantId))[0]!.items.every((i) => i.state === 'VIEWED')).toBe(true);

    const { values } = await valuesFor(token);
    const agreed = Object.fromEntries(s.items.map((i) => [i.id, true]));
    // 위조 증표는 거절
    await expect(signBundle({ token, proof: `${Math.floor(Date.now() / 1000) + 60}.x`, signature: PNG, agreed, values })).rejects.toThrow(/본인확인/);
    const out = await signBundle({ token, proof: c.proof, signature: PNG, agreed, values });
    expect(out.signed).toBe(3);

    const envs = await prisma.eDocEnvelope.findMany({ include: { events: true } });
    expect(envs.every((e) => e.status === 'COMPLETED' && e.documentHash)).toBe(true);
    for (const e of envs) {
      expect(e.events.filter((x) => x.type === 'OTP_VERIFIED')).toHaveLength(1);
      expect(e.events.filter((x) => x.type === 'SIGNED')).toHaveLength(1);
      expect((await verifyEnvelopeChain(e.id)).ok).toBe(true);
    }
    const send = await prisma.documentBundleSend.findFirstOrThrow();
    expect(send.status).toBe('COMPLETED');
    expect(readMockOutbox(50).filter((m) => m.template === 'EDOC_COMPLETED')).toHaveLength(1); // 문서마다가 아니라 묶음 1통
    expect(await prisma.issuedDocument.count({ where: { status: 'SIGNED' } })).toBe(3);
    expect((await listBundleSends(fx.merchantId))[0]!.counts.SIGNED).toBe(3);
    // 끝난 묶음에 다시 서명할 수 없다
    await expect(signBundle({ token, proof: c.proof, signature: PNG, agreed, values })).rejects.toThrow(/남아 있지 않습니다/);
  });

  it('필수 문서를 확인하지 않으면 아무것도 서명하지 않고, 선택 문서는 체크한 것만 서명한다', async () => {
    const { r } = await sendVolunteer();
    if (!r.ok || !r.devToken) {
      // 로컬이 아니면 링크 토큰을 문자에서 읽는다
    }
    const token = r.ok && r.devToken ? r.devToken : readMockOutbox(50).find((m) => m.template === 'EDOC_SIGN_REQUEST')!.text.match(/sign\/bundle\/([A-Za-z0-9_-]+)/)![1]!;
    await requestBundleOtp(token);
    const c = await confirmBundleOtp(token, lastOtp());
    const { s, values } = await valuesFor(token);
    if (!s.ok) throw new Error('s');
    const required = s.items.filter((i) => i.required);
    const optional = s.items.find((i) => !i.required)!;
    await expect(signBundle({ token, proof: c.proof, signature: PNG, agreed: { [required[0]!.id]: true }, values })).rejects.toThrow(/체크해 주세요/);
    expect(await prisma.eDocSigner.count({ where: { status: 'SIGNED' } })).toBe(0);

    const out = await signBundle({ token, proof: c.proof, signature: PNG, agreed: Object.fromEntries(required.map((i) => [i.id, true])), values });
    expect(out.signed).toBe(2);
    expect((await prisma.documentBundleSend.findFirstOrThrow()).status).toBe('COMPLETED');
    const opt = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: optional.envelopeId } });
    expect(opt.status).not.toBe('COMPLETED');
  });

  it('링크를 다시 보내면 이전 링크·증표는 무효, 거절하면 거절 상태', async () => {
    const { r } = await sendVolunteer();
    const token = r.ok && r.devToken ? r.devToken : readMockOutbox(50).find((m) => m.template === 'EDOC_SIGN_REQUEST')!.text.match(/sign\/bundle\/([A-Za-z0-9_-]+)/)![1]!;
    await requestBundleOtp(token);
    const c = await confirmBundleOtp(token, lastOtp());
    const send = await prisma.documentBundleSend.findFirstOrThrow();
    await resendBundleLink(fx.merchantId, send.id);
    expect(await loadBundleSession(token)).toMatchObject({ ok: false });
    const fresh = readMockOutbox(50).find((m) => m.template === 'EDOC_SIGN_REQUEST')!.text.match(/sign\/bundle\/([A-Za-z0-9_-]+)/)![1]!;
    const s2 = await loadBundleSession(fresh);
    if (!s2.ok) throw new Error('s2');
    expect(checkBundleProof(send.id, s2.tokenHash, c.proof)).toBe(false);

    await requestBundleOtp(fresh);
    const c2 = await confirmBundleOtp(fresh, lastOtp());
    await declineBundle({ token: fresh, proof: c2.proof, reason: '내용이 달라요' });
    const view = (await listBundleSends(fx.merchantId))[0]!;
    expect(view.items.filter((i) => i.state === 'DECLINED')).toHaveLength(3);
    expect(view.status).toBe('CLOSED');
  });
});

describe('[4] 비용 예측 = 실제 차감', () => {
  it('정액 2 · 시범 1 · 충전 500원(건당 200원) → 6건 중 5건 발송·1건 멈춤, 출처별 건수가 원장과 같다', async () => {
    await prisma.eDocWallet.create({ data: { merchantId: fx.merchantId, balance: 500, trialRemaining: 1, totalUsed: 0 } });
    await prisma.eDocSubscription.create({ data: { id: newId(), merchantId: fx.merchantId, price: 0, quota: 2, used: 0, startsAt: new Date(), endsAt: addDays(new Date(), 10) } });
    const f = forecastEDocCost({ monthlyLeft: 2, trialLeft: 1, balance: 500, perDocument: 200 }, 6);
    expect(f).toMatchObject({ monthly: 2, trial: 1, prepaid: 2, prepaidAmount: 400, blocked: 1, balanceAfter: 100 });

    const t = await prisma.documentTemplate.create({ data: { id: newId(), merchantId: fx.merchantId, name: '확인서', templateType: 'EDITOR', body: '확인합니다', active: true } });
    const rows = Array.from({ length: 6 }, (_, i) => ({ name: `받는분${i}`, phone: `0101111000${i}` }));
    const r = await createBulkEnvelopes({ merchantId: fx.merchantId, actorId: 'staff', templateId: t.id, role: 'DONOR', rows, batchNonce: newId() });
    expect(r.created).toBe(6 - f.blocked);
    const uses = await prisma.eDocLedger.findMany({ where: { kind: 'USE' } });
    expect(uses.filter((u) => u.source === 'MONTHLY')).toHaveLength(f.monthly);
    expect(uses.filter((u) => u.source === 'TRIAL')).toHaveLength(f.trial);
    expect(uses.filter((u) => u.source === 'PREPAID')).toHaveLength(f.prepaid);
    expect(-uses.reduce((a, u) => a + u.amount, 0)).toBe(f.prepaidAmount);
    expect((await prisma.eDocWallet.findUniqueOrThrow({ where: { merchantId: fx.merchantId } })).balance).toBe(f.balanceAfter);
  });

  it('묶음 대량 발송 승인 확인 화면: 대상 × 1명당 문서 수 로 예측하고, 승인하면 배치가 보낸다', async () => {
    const b = await volunteerBundle();
    const p2 = (await seedRegisteredPayer('01099990000')).id;
    for (const id of [payerId, p2]) await prisma.volunteerApplication.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: id, status: 'APPROVED' } });
    await expect(requestBundleSend(fx.merchantId, b.id, 'RECURRING_ACTIVE')).rejects.toThrow(/정기후원 신청 묶음만/);
    const req = await requestBundleSend(fx.merchantId, b.id, 'VOLUNTEER_APPROVED');
    await expect(requestBundleSend(fx.merchantId, b.id, 'VOLUNTEER_APPROVED')).rejects.toThrow(/이미 승인 대기함/);
    const p = (await bundleSendPreview(fx.merchantId, req.approvalId))!;
    expect(p).toMatchObject({ targetCount: 2, units: 3 });
    expect(p.forecast).toMatchObject({ count: 6, trial: 5, blocked: 1 }); // 신규 기관 시범 5건

    await decideApproval({ merchantId: fx.merchantId, id: req.approvalId, decision: 'APPROVE', userId: fx.merchantUserId });
    await runQueuedApprovals();
    const sends = await prisma.documentBundleSend.findMany({ orderBy: { createdAt: 'asc' } });
    expect(sends).toHaveLength(2);
    expect(sends.map((s) => s.status).sort()).toEqual(['BLOCKED', 'SENT']);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);
  });
});

describe('[5] 충전 뒤 재시도', () => {
  it('충전 승인 → edoc.balance_added → 멈춘 묶음을 이어서 보낸다(1회, 중복 없음)', async () => {
    await prisma.eDocWallet.create({ data: { merchantId: fx.merchantId, balance: 0, trialRemaining: 0, totalUsed: 0 } });
    const { r } = await sendVolunteer();
    expect(r).toMatchObject({ status: 'BLOCKED', blocked: 'EDOC_BALANCE' });
    const id = newId();
    await requestBilling({ merchantId: fx.merchantId, actorId: 'u', requestId: id, kind: 'TOPUP', amount: 10000, depositorName: '기관', wantsTaxInvoice: false });
    await approveBillingRequest({ requestId: id, actorId: 'admin', paymentConfirmed: true, taxInvoiceIssued: false });
    expect(await prisma.domainEvent.count({ where: { type: 'edoc.balance_added', subjectId: id } })).toBe(1);

    await processDomainEvents();
    const send = await prisma.documentBundleSend.findFirstOrThrow();
    expect(send.status).toBe('SENT');
    expect(await prisma.eDocEnvelope.count()).toBe(3);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);

    // 다시 돌려도(배치 재실행·소비자 재호출) 그대로
    await processDomainEvents();
    await retryBalanceBlocked(fx.merchantId);
    expect(await prisma.eDocEnvelope.count()).toBe(3);
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);
    expect(readMockOutbox(100).filter((m) => m.template === 'EDOC_SIGN_REQUEST')).toHaveLength(1);
    expect((await verifyWallet(fx.merchantId)).ok).toBe(true);
  });

  it('잔액 부족으로 기다리는 저니 문서 단계는 지금 잔액만큼 오래된 것부터 당겨지고, 두 번째는 바뀌지 않는다', async () => {
    await ensureWallet(fx.merchantId); // 시범 5건
    const future = addDays(new Date(), 1);
    const mk = async (minutesAgo: number) => {
      const run = await prisma.journeyRun.create({ data: { id: newId(), merchantId: fx.merchantId, journeyKey: 'volunteer_welcome', triggerKey: `t:${newId()}`, payerId, stepIndex: 1, status: 'WAITING', dueAt: future } });
      await prisma.journeyStepLog.create({ data: { id: newId(), runId: run.id, merchantId: fx.merchantId, payerId, stepIndex: 1, stepKey: 'doc', outcome: 'BLOCKED', detail: '전자문서 이용 잔액 부족 — 충전 후 다시 시도', at: new Date(Date.now() - minutesAgo * 60_000) } });
      return run;
    };
    const a = await mk(30);
    const b = await mk(10);
    const q = await balanceBlockedQueue(fx.merchantId);
    expect(q.map((x) => x.id)).toEqual([a.id, b.id]);
    const now = new Date();
    const res = await retryBalanceBlocked(fx.merchantId, now);
    expect(res.journeys).toBe(2);
    for (const id of [a.id, b.id]) expect((await prisma.journeyRun.findUniqueOrThrow({ where: { id } })).dueAt.getTime()).toBeLessThanOrEqual(now.getTime());
    expect((await retryBalanceBlocked(fx.merchantId, now)).journeys).toBe(0);
  });
});

describe('[6] 약정 흐름 — 기본은 기존 그대로', () => {
  const original = env.automation.esignProvider;
  afterEach(() => {
    (env.automation as { esignProvider: string }).esignProvider = original;
  });

  it('설정이 꺼져 있으면 약정에 묶음을 보내지 않는다', async () => {
    await ensureDefaultBundles(fx.merchantId);
    const r = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 3 });
    if (!r.ok) throw new Error(r.message);
    expect(await handleRecurringPledgedBundle({ merchantId: fx.merchantId, subjectId: r.recurring.id, payerId })).toBe('SKIPPED');
    await processDomainEvents();
    expect(await prisma.documentBundleSend.count()).toBe(0);
  });

  it('켜면 약정 흐름의 약정서 서명 요청을 잇고(새로 만들지 않음) 나머지 문서만 차감한다', async () => {
    (env.automation as { esignProvider: string }).esignProvider = 'internal';
    await ensureDefaultBundles(fx.merchantId);
    const rec = await prisma.documentBundle.findFirstOrThrow({ where: { merchantId: fx.merchantId, kind: 'RECURRING_SIGNUP' } });
    await setBundleForRecurring(fx.merchantId, rec.id, true);
    const r = await createRecurringDonation({ payerId, merchantId: fx.merchantId, amount: 10000n, dayOfMonth: 3 });
    if (!r.ok) throw new Error(r.message);
    const agreementEnvelopes = await prisma.eDocEnvelope.count();
    expect(agreementEnvelopes).toBe(1);
    await processDomainEvents();
    const send = await prisma.documentBundleSend.findFirstOrThrow({ include: { items: { orderBy: { position: 'asc' } } } });
    expect(send.status).toBe('SENT');
    const doc = await prisma.agreementDocument.findFirstOrThrow({ where: { subjectId: r.recurring.id } });
    expect(send.items[0]).toMatchObject({ purpose: 'SUPPORT_AGREEMENT', status: 'CREATED', envelopeId: doc.esignRequestId });
    expect(await prisma.eDocEnvelope.count()).toBe(3); // 약정서 1 + 개인정보 동의 + 출금 동의
    expect(await prisma.eDocLedger.count({ where: { kind: 'USE' } })).toBe(3);
    // 출금 동의서에 약정 금액·출금일이 머지됐다
    const debit = send.items.find((i) => i.purpose === 'DEBIT_CONSENT')!;
    const e = await prisma.eDocEnvelope.findUniqueOrThrow({ where: { id: debit.envelopeId! } });
    expect(readSnapshot(e.snapshotEnc).body).toContain('10,000원');
    expect(readSnapshot(e.snapshotEnc).body).toContain('매월 3일');
  });
});
