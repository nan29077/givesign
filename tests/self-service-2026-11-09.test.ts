import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, phoneHash } from '@/lib/crypto';
import { clearMockOutbox, readMockOutbox } from '@/server/adapters/mt';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';
import { createRecurringDonation } from '@/server/services/recurring';
import { AGREEMENT_CHANGES_PER_DAY } from '@/server/services/agreements';
import { describeRecurringChange, type RecurringBefore } from '@/server/services/recurring-change-text';
import {
  SelfServiceError,
  applyRecurringChange,
  memberScope,
  myScope,
  previewRecurringChange,
  selfServiceRecurringList,
  type SelfServiceScope,
} from '@/server/services/donor-self-service';
import { StepUpError, StepUpRequiredError, confirmStepUp, hasStepUp, requestStepUp, type StepUpSubject } from '@/server/services/self-service-stepup';
import { getPreferredChannel, notificationSettings, setNoticeOptOut, setPreferredChannel } from '@/server/services/donor-preferences';
import { donorDonationHistory, registerDonationHistorySource } from '@/server/services/donor-history';
import { receiptScheduleNote } from '@/server/services/receipt-schedule';
import { receivedDocuments } from '@/server/services/donor-documents';
import { merchantRecurringChanges } from '@/server/services/recurring-change-log';
import { issueRecoveryLink } from '@/server/services/recurring-recovery-link';
import { cancelFromRecovery } from '@/server/services/recurring-recovery';

/**
 * 2026-11-09 2차 F — 후원자 셀프서비스 확대.
 * 변경 문장 계산(순수 함수) · 본인 재확인 · 하루 3회 · 다른 기관 거절 · 해지 사유 선택 · 연락 선호 · 이력 · 후원 내역 · 문서.
 */

// KST 2026-11-09 12:00
const NOW = new Date('2026-11-09T03:00:00Z');

const base = (over: Partial<RecurringBefore> = {}): RecurringBefore => ({
  status: 'ACTIVE',
  amount: 10000n,
  dayOfMonth: 25,
  nextChargeOn: '2026-11-25',
  resumeOn: null,
  chargedThisMonthOn: null,
  pending: false,
  ...over,
});

describe('describeRecurringChange (순수 함수)', () => {
  it('출금일 후 · 이번 주기 출금 완료: "이번 달 출금(11월 5일)은 이미 끝났습니다. 바꾼 금액 30,000원은 12월 5일 출금부터"', () => {
    const d = describeRecurringChange(base({ dayOfMonth: 5, nextChargeOn: '2026-12-05', chargedThisMonthOn: '2026-11-05' }), { action: 'CHANGE', amount: 30000n }, NOW);
    expect(d.allowed).toBe(true);
    expect(d.text).toBe('이번 달 출금(11월 5일)은 이미 끝났습니다. 바꾼 금액 30,000원은 12월 5일 출금부터 적용됩니다.');
    expect(d.effectiveOn).toBe('2026-12-05');
  });

  it('출금일 전 · 미완료: 금액은 이번 달 출금부터', () => {
    const d = describeRecurringChange(base(), { action: 'CHANGE', amount: 20000n }, NOW);
    expect(d.text).toBe('바꾼 금액 20,000원은 11월 25일 출금부터 적용됩니다.');
    expect(d.skipsThisMonth).toBe(false);
  });

  it('출금일을 이미 지난 날로 당기면 이번 달은 건너뛴다고 알린다', () => {
    const d = describeRecurringChange(base(), { action: 'CHANGE', dayOfMonth: 5 }, NOW);
    expect(d.effectiveOn).toBe('2026-12-05');
    expect(d.skipsThisMonth).toBe(true);
    expect(d.text).toContain('11월에는 출금되지 않습니다');
  });

  it('이번 달 출금 완료 후 출금일을 뒤로 미뤄도 다음 달부터(같은 달 두 번 출금 없음)', () => {
    const d = describeRecurringChange(base({ dayOfMonth: 5, nextChargeOn: '2026-12-05', chargedThisMonthOn: '2026-11-05' }), { action: 'CHANGE', dayOfMonth: 20 }, NOW);
    expect(d.effectiveOn).toBe('2026-12-20');
    expect(d.skipsThisMonth).toBe(false);
  });

  it('미완료 상태에서 출금일을 뒤로 미루면 이번 달 새 날짜에', () => {
    const d = describeRecurringChange(base(), { action: 'CHANGE', dayOfMonth: 28 }, NOW);
    expect(d.effectiveOn).toBe('2026-11-28');
  });

  it('오늘과 같은 날로 바꾸면 다음 달(실제 갱신 규칙과 같다)', () => {
    const d = describeRecurringChange(base(), { action: 'CHANGE', dayOfMonth: 9 }, NOW);
    expect(d.effectiveOn).toBe('2026-12-09');
  });

  it('일시정지 중: 재개 예정일 뒤 첫 출금부터 적용', () => {
    const d = describeRecurringChange(base({ status: 'PAUSED', resumeOn: '2027-01-10' }), { action: 'CHANGE', amount: 15000n }, NOW);
    expect(d.allowed).toBe(true);
    expect(d.text).toContain('쉬고 있어');
    expect(d.effectiveOn).toBe('2027-01-25');
    const noDate = describeRecurringChange(base({ status: 'PAUSED' }), { action: 'CHANGE', amount: 15000n }, NOW);
    expect(noDate.text).toContain('다시 시작한 뒤 첫 출금부터');
  });

  it('결과 미확인(PENDING) 중이면 금액·출금일 변경은 보류, 해지는 안내와 함께 가능', () => {
    const d = describeRecurringChange(base({ pending: true }), { action: 'CHANGE', amount: 20000n }, NOW);
    expect(d.allowed).toBe(false);
    expect(d.blocked).toBe('PENDING');
    expect(d.text).toContain('보류');
    const c = describeRecurringChange(base({ pending: true }), { action: 'CANCEL' }, NOW);
    expect(c.allowed).toBe(true);
    expect(c.text).toContain('결과를 확인하는 중');
  });

  it('바뀐 것 없음 · 해지된 약정 · 범위 밖 출금일은 막는다', () => {
    expect(describeRecurringChange(base(), { action: 'CHANGE', amount: 10000n }, NOW).blocked).toBe('NO_CHANGE');
    expect(describeRecurringChange(base({ status: 'CANCELED' }), { action: 'CANCEL' }, NOW).blocked).toBe('CANCELED');
    expect(describeRecurringChange(base(), { action: 'CHANGE', dayOfMonth: 31 }, NOW).blocked).toBe('INVALID_DAY');
  });

  it('쉬어 가기: 날짜 검사와 재개 후 첫 출금일', () => {
    expect(describeRecurringChange(base(), { action: 'PAUSE_UNTIL', resumeOn: '2026-11-09' }, NOW).blocked).toBe('INVALID_DATE');
    expect(describeRecurringChange(base(), { action: 'PAUSE_UNTIL', resumeOn: '2027-12-01' }, NOW).blocked).toBe('INVALID_DATE');
    expect(describeRecurringChange(base(), { action: 'PAUSE_UNTIL', resumeOn: '2026-02-30' }, NOW).blocked).toBe('INVALID_DATE');
    const d = describeRecurringChange(base(), { action: 'PAUSE_UNTIL', resumeOn: '2026-12-26' }, NOW);
    expect(d.effectiveOn).toBe('2027-01-25');
    expect(d.text).toContain('12월 26일까지 쉬고');
  });

  it('다시 시작: 이번 달 출금일이 지났으면 다음 달, 이미 출금했으면 다음 달', () => {
    const passed = describeRecurringChange(base({ status: 'PAUSED', dayOfMonth: 5 }), { action: 'RESUME' }, NOW);
    expect(passed.effectiveOn).toBe('2026-12-05');
    expect(passed.text).toContain('지나 다음 달부터');
    const upcoming = describeRecurringChange(base({ status: 'SUSPENDED', dayOfMonth: 20 }), { action: 'RESUME' }, NOW);
    expect(upcoming.effectiveOn).toBe('2026-11-20');
    expect(describeRecurringChange(base(), { action: 'RESUME' }, NOW).blocked).toBe('INVALID_STATE');
  });

  it('일시정지: 이번 달 출금이 끝났으면 다음 달부터 쉰다', () => {
    const d = describeRecurringChange(base({ dayOfMonth: 5, nextChargeOn: '2026-12-05', chargedThisMonthOn: '2026-11-05' }), { action: 'PAUSE' }, NOW);
    expect(d.text).toContain('이미 끝났습니다');
    expect(d.text).toContain('12월 5일 출금부터 쉽니다');
  });
});

describe('receiptScheduleNote', () => {
  it('연 1회 기관은 다음 해 1월, 매월 기관은 다음 달', () => {
    expect(receiptScheduleNote('YEARLY', NOW).text).toContain('2027년 1월에 발급');
    expect(receiptScheduleNote(null, NOW).month).toBe('2027-01');
    expect(receiptScheduleNote('MONTHLY', NOW).text).toContain('12월 초');
    expect(receiptScheduleNote('MONTHLY', new Date('2026-12-15T03:00:00Z')).month).toBe('2027-01');
  });
});

// ---------------------------------------------------------------------------
let fx: Fixture;
let userId: string;
let payerId: string;
const PHONE = '01055556666';

async function otpFromOutbox(): Promise<string> {
  const m = readMockOutbox(1)[0];
  const code = m?.text.match(/(\d{6})/)?.[1];
  if (!code) throw new Error('인증번호 문자를 찾지 못했습니다');
  return code;
}

async function stepUp(s: StepUpSubject) {
  clearMockOutbox();
  await requestStepUp(s);
  await confirmStepUp(s, await otpFromOutbox());
}

async function makeRecurring(merchantId = fx.merchantId, amount = 10000n, day = 25) {
  const made = await createRecurringDonation({ payerId, merchantId, amount, dayOfMonth: day });
  if (!made.ok) throw new Error(made.message);
  return made.recurring;
}

async function makeMerchant(name: string) {
  const u = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, name, role: 'MERCHANT' } });
  return prisma.merchantProfile.create({ data: { id: newId(), userId: u.id, code: `GIV-${newId().slice(-4)}`, displayName: name, status: 'APPROVED', maxAmount: 1_000_000n } });
}

async function makeMember(merchantId: string, verified = true) {
  return prisma.donorMember.create({
    data: {
      id: newId(), merchantId, email: `d-${newId()}@test.kr`, passwordHash: 'x', name: '회원', termsAgreedAt: new Date(),
      ...(verified ? { phoneHash: phoneHash(PHONE), phoneEnc: encrypt(PHONE), phoneMasked: maskPhone(PHONE), phoneVerifiedAt: new Date() } : {}),
    },
  });
}

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { maxAmount: 1_000_000n } });
  await prisma.termsVersion.create({
    data: { id: newId(), type: 'RECURRING_DEBIT', version: '1.0', title: '정기후원 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') },
  });
  const user = await prisma.user.create({ data: { id: newId(), email: `donor-${newId()}@test.kr`, name: '후원자', role: 'PAYER' } });
  userId = user.id;
  const payer = await seedRegisteredPayer(PHONE);
  await prisma.payerProfile.update({ where: { id: payer.id }, data: { userId } });
  payerId = payer.id;
});

async function scopeMy(): Promise<SelfServiceScope> {
  const s = await myScope(userId);
  if (!s) throw new Error('scope 없음');
  return s;
}

describe('본인 재확인(휴대폰 OTP, 10분)', () => {
  it('재확인 없이 변경·해지하면 거절하고 약정은 그대로다', async () => {
    const r = await makeRecurring();
    const scope = await scopeMy();
    await expect(applyRecurringChange(scope, r.id, { action: 'CHANGE', amount: 20000n })).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(applyRecurringChange(scope, r.id, { action: 'CANCEL' })).rejects.toBeInstanceOf(StepUpRequiredError);
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.amount).toBe(10000n);
    expect(row.status).toBe('ACTIVE');
    expect(await prisma.recurringChangeLog.count()).toBe(0);
  });

  it('연결된 번호로 받은 인증번호를 확인하면 바꿀 수 있고 결과 문장·이력이 남는다', async () => {
    const r = await makeRecurring();
    const scope = await scopeMy();
    const subject: StepUpSubject = { kind: 'USER', userId };
    clearMockOutbox();
    await requestStepUp(subject);
    expect(readMockOutbox(1)[0].to).toBe(PHONE);
    await expect(confirmStepUp(subject, '000000')).rejects.toBeInstanceOf(StepUpError);
    await confirmStepUp(subject, await otpFromOutbox());
    expect(await hasStepUp(subject)).toBe(true);
    // 회원 화면 재확인과는 섞이지 않는다
    const member = await makeMember(fx.merchantId);
    expect(await hasStepUp({ kind: 'MEMBER', memberId: member.id })).toBe(false);

    const preview = await previewRecurringChange(scope, r.id, { action: 'CHANGE', amount: 20000n });
    const res = await applyRecurringChange(scope, r.id, { action: 'CHANGE', amount: 20000n });
    expect(res.message).toContain(preview.text);
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.amount).toBe(20000n);
    const logs = await prisma.recurringChangeLog.findMany({ where: { recurringId: r.id } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: 'DONOR', via: 'MY', kind: 'CHANGE' });
    expect((logs[0].before as { amount: string }).amount).toBe('10000');
    expect((logs[0].after as { amount: string }).amount).toBe('20000');
    // 기관 콘솔 이력에 보인다
    const studio = await merchantRecurringChanges(fx.merchantId);
    expect(studio).toHaveLength(1);
  });

  it('번호가 바뀌면 재확인이 무효다', async () => {
    const subject: StepUpSubject = { kind: 'USER', userId };
    await stepUp(subject);
    await prisma.payerProfile.update({ where: { id: payerId }, data: { phoneHash: phoneHash('01099998888') } });
    expect(await hasStepUp(subject)).toBe(false);
  });

  it('인증되지 않은 회원은 재확인 번호를 받을 수 없다', async () => {
    const member = await makeMember(fx.merchantId, false);
    await expect(requestStepUp({ kind: 'MEMBER', memberId: member.id })).rejects.toBeInstanceOf(StepUpError);
    expect(await memberScope(member)).toBeNull();
  });
});

describe('기존 제한 유지', () => {
  it(`약정 조건 변경은 하루 ${AGREEMENT_CHANGES_PER_DAY}번까지(셀프서비스에서도)`, async () => {
    const r = await makeRecurring();
    const scope = await scopeMy();
    await stepUp({ kind: 'USER', userId });
    for (let i = 1; i <= AGREEMENT_CHANGES_PER_DAY; i++) {
      await applyRecurringChange(scope, r.id, { action: 'CHANGE', amount: BigInt(10000 + i * 1000) });
    }
    await expect(applyRecurringChange(scope, r.id, { action: 'CHANGE', amount: 50000n })).rejects.toThrow(/하루 3번/);
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.amount).toBe(BigInt(10000 + AGREEMENT_CHANGES_PER_DAY * 1000));
    expect(await prisma.recurringChangeLog.count({ where: { recurringId: r.id } })).toBe(AGREEMENT_CHANGES_PER_DAY);
    const list = await selfServiceRecurringList(scope);
    expect(list.items[0].changesLeft).toBe(0);
  });

  it('금액 범위를 벗어나면 거절(기존 검사)', async () => {
    const r = await makeRecurring();
    const scope = await scopeMy();
    await stepUp({ kind: 'USER', userId });
    await expect(applyRecurringChange(scope, r.id, { action: 'CHANGE', amount: 500n })).rejects.toThrow(/이상/);
  });

  it('결과 미확인(PENDING) 출금이 있으면 금액·출금일 변경을 보류한다', async () => {
    const r = await makeRecurring();
    await prisma.recurringRun.create({ data: { id: newId(), recurringId: r.id, monthKey: r.cycleMonth, attempt: 1, status: 'PENDING', reason: '결제 결과 미확인' } });
    const scope = await scopeMy();
    await stepUp({ kind: 'USER', userId });
    await expect(applyRecurringChange(scope, r.id, { action: 'CHANGE', dayOfMonth: 10 })).rejects.toThrow(/보류/);
    expect((await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } })).dayOfMonth).toBe(25);
  });
});

describe('권한 범위', () => {
  it('기관 후원 회원 화면은 다른 기관 약정에 접근할 수 없다', async () => {
    const other = await makeMerchant('다른기관');
    const mine = await makeRecurring(fx.merchantId);
    const theirs = await makeRecurring(other.id);
    const member = await makeMember(fx.merchantId);
    const scope = await memberScope(member);
    expect(scope?.via).toBe('MEMBER');
    await stepUp({ kind: 'MEMBER', memberId: member.id });
    await expect(previewRecurringChange(scope!, theirs.id, { action: 'CANCEL' })).rejects.toBeInstanceOf(SelfServiceError);
    await expect(applyRecurringChange(scope!, theirs.id, { action: 'CANCEL' })).rejects.toBeInstanceOf(SelfServiceError);
    expect((await prisma.recurringDonation.findUniqueOrThrow({ where: { id: theirs.id } })).status).toBe('ACTIVE');
    const list = await selfServiceRecurringList(scope!);
    expect(list.items.map((i) => i.id)).toEqual([mine.id]);
    // 통합 화면은 두 기관 모두
    expect((await selfServiceRecurringList(await scopeMy())).items).toHaveLength(2);
    // 회원 화면에서 바꾸면 via=MEMBER
    await applyRecurringChange(scope!, mine.id, { action: 'PAUSE' });
    expect((await prisma.recurringChangeLog.findFirstOrThrow({ where: { recurringId: mine.id } })).via).toBe('MEMBER');
  });

  it('다른 후원자의 약정은 없는 것으로 본다', async () => {
    const r = await makeRecurring();
    const u2 = await prisma.user.create({ data: { id: newId(), email: `x-${newId()}@test.kr`, name: 'x', role: 'PAYER' } });
    const p2 = await seedRegisteredPayer('01011112222');
    await prisma.payerProfile.update({ where: { id: p2.id }, data: { userId: u2.id } });
    const s2 = await myScope(u2.id);
    await expect(previewRecurringChange(s2!, r.id, { action: 'CANCEL' })).rejects.toBeInstanceOf(SelfServiceError);
  });
});

describe('해지·쉬기·재개', () => {
  it('해지 사유를 고르지 않아도 해지된다(확인 1번)', async () => {
    const r = await makeRecurring();
    const scope = await scopeMy();
    await stepUp({ kind: 'USER', userId });
    const res = await applyRecurringChange(scope, r.id, { action: 'CANCEL' }, { reason: '' });
    expect(res.message).toContain('해지했습니다');
    const row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('CANCELED');
    expect(row.cancelReason).toBeNull();
    const log = await prisma.recurringChangeLog.findFirstOrThrow({ where: { recurringId: r.id } });
    expect(log.kind).toBe('CANCEL');
    expect(log.reason).toBeNull();
  });

  it('쉬어 가기는 1차 재개 예정일(resume_on)을 그대로 쓰고, 다시 시작하면 비운다', async () => {
    const r = await makeRecurring();
    const scope = await scopeMy();
    await stepUp({ kind: 'USER', userId });
    const kstToday = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
    const d = new Date(`${kstToday}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 20);
    const resumeOn = d.toISOString().slice(0, 10);
    await applyRecurringChange(scope, r.id, { action: 'PAUSE_UNTIL', resumeOn });
    let row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('PAUSED');
    expect(row.resumeOn?.toISOString().slice(0, 10)).toBe(resumeOn);
    await applyRecurringChange(scope, r.id, { action: 'RESUME' });
    row = await prisma.recurringDonation.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('ACTIVE');
    expect(row.resumeOn).toBeNull();
    const kinds = (await prisma.recurringChangeLog.findMany({ where: { recurringId: r.id }, orderBy: { createdAt: 'asc' } })).map((l) => l.kind);
    expect(kinds).toEqual(['PAUSE_UNTIL', 'RESUME']);
  });

  it('같은 약정에 동시에 두 번 해지해도 한 번만 처리된다', async () => {
    const r = await makeRecurring();
    const scope = await scopeMy();
    await stepUp({ kind: 'USER', userId });
    const results = await Promise.allSettled([
      applyRecurringChange(scope, r.id, { action: 'CANCEL' }),
      applyRecurringChange(scope, r.id, { action: 'CANCEL' }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.recurringChangeLog.count({ where: { recurringId: r.id } })).toBe(1);
  });

  it('복구 링크에서 해지해도 이력이 남는다(via=RECOVER_LINK, 재확인 없음 — 1차 규칙)', async () => {
    const r = await makeRecurring();
    const link = await issueRecoveryLink(r.id, payerId);
    await cancelFromRecovery(link.token);
    const log = await prisma.recurringChangeLog.findFirstOrThrow({ where: { recurringId: r.id } });
    expect(log).toMatchObject({ via: 'RECOVER_LINK', kind: 'CANCEL', actor: 'DONOR' });
  });
});

describe('알림 설정', () => {
  it('연락 선호는 기본 알림톡 우선, 저장·잘못된 값 거절, 같은 값이면 바꾸지 않음', async () => {
    expect(await getPreferredChannel(payerId)).toBe('ALIMTALK');
    expect((await setPreferredChannel(payerId, 'SMS')).changed).toBe(true);
    expect(await getPreferredChannel(payerId)).toBe('SMS');
    expect((await setPreferredChannel(payerId, 'SMS')).changed).toBe(false);
    await expect(setPreferredChannel(payerId, 'EMAIL')).rejects.toThrow();
    expect((await prisma.payerProfile.findUniqueOrThrow({ where: { id: payerId } })).preferredChannel).toBe('SMS');
  });

  it('월간 안내 수신 거부는 이어진 기관만, 기관 범위로 걸러 보인다', async () => {
    const other = await makeMerchant('다른기관');
    await prisma.payerMerchantLink.createMany({ data: [{ id: newId(), payerId, merchantId: fx.merchantId }, { id: newId(), payerId, merchantId: other.id }] });
    expect(await setNoticeOptOut(payerId, fx.merchantId, true)).toBe(true);
    const stranger = await makeMerchant('모르는기관');
    expect(await setNoticeOptOut(payerId, stranger.id, true)).toBe(false);
    const all = await notificationSettings(payerId);
    expect(all.merchants).toHaveLength(2);
    const only = await notificationSettings(payerId, fx.merchantId);
    expect(only.merchants).toHaveLength(1);
    expect(only.merchants[0].noticeOptOut).toBe(true);
  });
});

describe('후원 내역 · 받은 문서', () => {
  it('연도별 합계와 건별 내역(출처 표시), 등록한 출처를 합치고 실패한 출처만 뺀다', async () => {
    const other = await makeMerchant('다른기관');
    const mk = (merchantId: string, amount: bigint, paidAt: Date) =>
      prisma.charge.create({
        data: {
          id: newId(), transactionNo: `TRD-${newId()}`, merchantId, payerId, amount, displayName: '후원자', message: '응원',
          status: 'PAYMENT_SUCCESS', paymentMode: 'CONFIRM_LINK', paidAt, channel: 'WEB',
        },
      });
    await mk(fx.merchantId, 10000n, new Date('2025-06-01T03:00:00Z'));
    await mk(fx.merchantId, 20000n, new Date('2026-03-01T03:00:00Z'));
    await mk(fx.merchantId, 5000n, new Date('2026-07-01T03:00:00Z'));
    await mk(other.id, 99000n, new Date('2026-07-01T03:00:00Z'));
    registerDonationHistorySource('TEST_TRANSFER', async ({ merchantId }) => [
      { id: 't1', source: 'TEST_TRANSFER', sourceLabel: '계좌이체', merchantId: merchantId ?? fx.merchantId, amount: 3000n, at: new Date('2026-08-01T03:00:00Z'), title: '계좌이체 후원' },
    ], '계좌이체');
    registerDonationHistorySource('TEST_BROKEN', async () => { throw new Error('x'); }, '고장난 출처');
    const h = await donorDonationHistory(payerId, { merchantId: fx.merchantId, now: NOW });
    expect(h.totals.map((t) => [t.year, t.amount])).toEqual([[2026, 28000n], [2025, 10000n]]);
    expect(h.year).toBe(2026);
    expect(h.entries.map((e) => e.sourceLabel)).toEqual(['계좌이체', '웹 후원', '웹 후원']);
    expect(h.failedSources).toEqual(['고장난 출처']);
    const y2025 = await donorDonationHistory(payerId, { merchantId: fx.merchantId, year: 2025, now: NOW });
    expect(y2025.entries).toHaveLength(1);
    registerDonationHistorySource('TEST_TRANSFER', async () => []);
    registerDonationHistorySource('TEST_BROKEN', async () => []);
  });

  it('받은 문서: 약정서는 서명 완료·동의 성립 판만, 기관 범위로 거른다', async () => {
    const r = await makeRecurring();
    const docs = await receivedDocuments(payerId, fx.merchantId);
    const agreements = await prisma.agreementDocument.findMany({ where: { payerId } });
    const shown = agreements.filter((a) => a.esignStatus === 'SIGNED' || a.esignStatus === 'NONE');
    expect(docs.filter((d) => d.kind === 'AGREEMENT')).toHaveLength(shown.length);
    const other = await makeMerchant('다른기관');
    expect(await receivedDocuments(payerId, other.id)).toHaveLength(0);
    expect(r.id).toBeTruthy();
  });
});
