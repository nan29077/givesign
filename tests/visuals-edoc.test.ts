import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/auth', () => ({ requireMerchant: vi.fn(), requireAdmin: vi.fn(), writeAudit: vi.fn(async () => {}) }));
import { requireAdmin, requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { getOrgVisuals } from '@/server/services/visual-settings';
import { DONATION_BANNERS, DONATION_MARGINS } from '@/lib/visual-presets';
import { isValidMoNumber, formatMoNumber, normalizeMoNumber } from '@/lib/mo-number';
import { chargeDocument, EDOC_POLICY_DEFAULT, edocAccountKey, type EDocAccount } from '@/lib/edoc-billing';
import { createEDocRequest, requestEDocBilling, resolveEDocBilling } from '@/app/actions/edoc';
import { loadDocumentContext, submitDocument } from '@/server/services/documents';
import { getEDocAccount } from '@/server/services/edoc-billing';

let fixture: Fixture;
const form = (data: Record<string, string>) => { const f = new FormData(); Object.entries(data).forEach(([k, v]) => f.set(k, v)); return f; };
beforeEach(async () => {
  await resetDb(); fixture = await seedBasics();
  vi.mocked(requireMerchant).mockResolvedValue({ id: fixture.merchantUserId, merchantId: fixture.merchantId, name: '기관', email: null, role: 'MERCHANT', avatarIndex: 0, merchantStatus: 'APPROVED' });
  vi.mocked(requireAdmin).mockResolvedValue({ id: fixture.merchantUserId, name: '운영자', email: null, role: 'ADMIN', avatarIndex: 0, adminPermission: 'SUPER_ADMIN' });
});

describe('기관별 이미지와 MO 번호', () => {
  it('처음 무작위 배정한 배너와 여백을 다시 조회해도 유지한다', async () => {
    const a = await getOrgVisuals(fixture.merchantId), b = await getOrgVisuals(fixture.merchantId);
    expect(a).toEqual(b);
    expect(DONATION_BANNERS.some(p => p.url === a.defaultBanner)).toBe(true);
    expect(DONATION_MARGINS.some(p => p.url === a.resolvedBackground)).toBe(true);
    expect(await prisma.systemSetting.count({ where: { key: `givesign:org-visuals:${fixture.merchantId}` } })).toBe(1);
  });
  it('1588-1234-1234를 12자리로 저장하고 같은 형식으로 표시한다', () => {
    expect(normalizeMoNumber('1588-1234-1234')).toBe('158812341234');
    expect(formatMoNumber('158812341234')).toBe('1588-1234-1234');
    expect(isValidMoNumber('1588-1234-1234')).toBe(true);
    expect(isValidMoNumber('05051001001')).toBe(false);
    expect(isValidMoNumber('1588-1234')).toBe(false);
    expect(isValidMoNumber('abc158812341234')).toBe(false);
  });
});

describe('전자문서 이용량·보안·중복 방지', () => {
  it('정액 > 시범 > 충전 순으로 차감하고 잔액 부족과 기간 만료를 처리한다', () => {
    const a: EDocAccount = { balance: 1000, trialRemaining: 1, monthlyRemaining: 2, monthlyUntil: '2026-11-01T00:00:00Z', totalUsed: 0 };
    expect(chargeDocument(a, EDOC_POLICY_DEFAULT, new Date('2026-10-30')).source).toBe('MONTHLY');
    const expired = { ...a, monthlyUntil: '2026-10-01T00:00:00Z' };
    expect(chargeDocument(expired, EDOC_POLICY_DEFAULT, new Date('2026-10-30')).source).toBe('TRIAL');
    expect(chargeDocument({ ...expired, trialRemaining: 0 }, EDOC_POLICY_DEFAULT).account.balance).toBe(800);
    expect(() => chargeDocument({ ...expired, balance: 0, trialRemaining: 0 }, EDOC_POLICY_DEFAULT)).toThrow('잔액');
  });
  it('결제 없는 작성 요청은 한 번만 생성·차감하고 발급 당시 서식을 고정한다', async () => {
    const template = await prisma.documentTemplate.create({ data: { id: newId(), merchantId: fixture.merchantId, name: '봉사 신청서', templateType: 'EDITOR', body: '원래 서식 내용', requireSignature: false, fields: [{ id: 'name', label: '성명', type: 'TEXT', required: true }] } });
    const f = form({ nonce: newId(), templateId: template.id, recipientName: '홍길동', recipientPhone: '010-1234-5678' });
    const result = await createEDocRequest({ ok: false }, f);
    expect(result.ok).toBe(true); expect(result.secret).toContain('/doc/');
    expect((await createEDocRequest({ ok: false }, f)).ok).toBe(false);
    expect(await prisma.documentSubmission.count()).toBe(1);
    expect((await getEDocAccount(fixture.merchantId)).trialRemaining).toBe(4);
    const token = result.secret!.split('/doc/')[1];
    await prisma.documentTemplate.update({ where: { id: template.id }, data: { body: '나중에 수정한 내용', fields: [] } });
    const loaded = await loadDocumentContext(token);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('문서 조회 실패');
    expect(loaded.ctx.body).toBe('원래 서식 내용'); expect(loaded.ctx.fields).toHaveLength(1); expect(loaded.ctx.documentHash).toHaveLength(64);
    const row = await prisma.documentSubmission.findFirstOrThrow();
    expect(row.chargeId).toBeNull(); expect(row.payerNameEnc).not.toContain('홍길동');
    expect((await submitDocument({ token, values: { name: '홍길동' }, signature: null })).ok).toBe(true);
    expect((await submitDocument({ token, values: { name: '다른 값' }, signature: null })).ok).toBe(false);
  });
  it('다른 기관의 서식은 작성 요청에 사용할 수 없다', async () => {
    const result = await createEDocRequest({ ok: false }, form({ nonce: newId(), templateId: newId(), recipientName: '홍길동', recipientPhone: '01012345678' }));
    expect(result.ok).toBe(false); expect(await prisma.documentSubmission.count()).toBe(0);
  });
  it('충전 신청만으로 잔액이 늘지 않고, 입금 확인 없이 승인할 수 없으며 중복 승인은 반영하지 않는다', async () => {
    const nonce = newId();
    const f = form({ nonce, kind: 'TOPUP', amount: '10000' });
    expect((await requestEDocBilling({ ok: false }, f)).ok).toBe(true);
    expect((await requestEDocBilling({ ok: false }, f)).ok).toBe(true);
    expect((await getEDocAccount(fixture.merchantId)).balance).toBe(0);
    const approve = form({ merchantId: fixture.merchantId, requestId: nonce, decision: 'APPROVED' });
    expect((await resolveEDocBilling({ ok: false }, approve)).ok).toBe(false);
    approve.set('paymentConfirmed', 'on');
    expect((await resolveEDocBilling({ ok: false }, approve)).ok).toBe(true);
    expect((await resolveEDocBilling({ ok: false }, approve)).ok).toBe(false);
    expect((await getEDocAccount(fixture.merchantId)).balance).toBe(10000);
    expect((await prisma.systemSetting.findUniqueOrThrow({ where: { key: edocAccountKey(fixture.merchantId) } })).value).toMatchObject({ balance: 10000 });
  });
});
