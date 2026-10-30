import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/auth', () => ({ requireMerchant: vi.fn(), requireAdmin: vi.fn(), writeAudit: vi.fn(async () => {}) }));
import { requireAdmin, requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { resetDb, seedBasics, type Fixture } from './helpers';
import { getOrgVisuals } from '@/server/services/visual-settings';
import { DONATION_BANNERS, DONATION_MARGINS } from '@/lib/visual-presets';
import { isValidMoNumber, formatMoNumber, normalizeMoNumber } from '@/lib/mo-number';

let fixture: Fixture;
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
