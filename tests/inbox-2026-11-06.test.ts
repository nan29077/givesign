import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { requestApproval } from '@/server/services/approvals';
import { automationReadiness, inboxActionCount, inboxItems } from '@/server/services/inbox';
import { resetDb, seedBasics, seedRegisteredPayer, type Fixture } from './helpers';

/**
 * 고도화 4단계: 통합 승인 대기함 · 자동화 준비도.
 */

let fx: Fixture;
beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
});

describe('[1] 승인 대기함', () => {
  it('승인 요청·봉사 신청을 한 목록에 모으고, 다른 기관 것은 보이지 않는다', async () => {
    const payer = await seedRegisteredPayer(fx.payerPhone);
    await requestApproval({ merchantId: fx.merchantId, kind: 'RECEIPT_BATCH', title: '2026년 영수증 3건 발급', dedupeKey: 'rb:1', payload: { taxYear: 2026 } });
    await requestApproval({ merchantId: 'OTHER', kind: 'RECEIPT_BATCH', title: '다른 기관', dedupeKey: 'rb:2' });
    // 같은 키는 한 번만
    const again = await requestApproval({ merchantId: fx.merchantId, kind: 'RECEIPT_BATCH', title: '중복', dedupeKey: 'rb:1' });
    expect(again.created).toBe(false);
    await prisma.volunteerApplication.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: payer.id, status: 'RECEIVED' } });

    const { actions } = await inboxItems(fx.merchantId);
    expect(actions.map((a) => a.kind).sort()).toEqual(['RECEIPT_BATCH', 'VOLUNTEER_APPLICATION']);
    expect(actions.find((a) => a.kind === 'RECEIPT_BATCH')?.approvalId).toBeTruthy();
    expect(actions.some((a) => a.title === '다른 기관')).toBe(false);
    expect(await inboxActionCount(fx.merchantId)).toBe(2);
  });

  it('기한이 지난 승인 요청은 목록에서 빠진다', async () => {
    await requestApproval({ merchantId: fx.merchantId, kind: 'DOCUMENT_SEND', title: '지난 요청', dedupeKey: 'old', expiresAt: new Date(Date.now() - 1000) });
    const { actions } = await inboxItems(fx.merchantId);
    expect(actions).toHaveLength(0);
  });
});

describe('[2] 자동화 준비도', () => {
  it('공익법인 확인·모집등록번호가 빠지면 필수 누락으로 보이고, 채우면 사라진다', async () => {
    let r = await automationReadiness(fx.merchantId);
    const keysMissing = r.items.filter((i) => !i.ok).map((i) => i.key);
    expect(keysMissing).toEqual(expect.arrayContaining(['donee', 'issuer']));
    const before = r.requiredMissing;
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: {
        businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true,
        designatedDoneeVerifiedAt: new Date(), fundraisingRegNo: '서울-2026-01',
      },
    });
    r = await automationReadiness(fx.merchantId);
    expect(r.items.find((i) => i.key === 'donee')?.ok).toBe(true);
    expect(r.items.find((i) => i.key === 'issuer')?.ok).toBe(true);
    expect(r.items.find((i) => i.key === 'regNo')?.ok).toBe(true);
    expect(r.requiredMissing).toBeLessThan(before);
  });
});
