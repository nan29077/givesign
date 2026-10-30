import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/server/auth', () => ({ requireMerchant: vi.fn(), getSessionUser: vi.fn() }));
vi.mock('@/server/rate-limit', () => ({ consumeRateLimit: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/server/uploads', () => ({ newObjectName: vi.fn(() => 'qa.png'), putObject: vi.fn(async () => '/api/media/qa.png') }));
import { requireMerchant, getSessionUser } from '@/server/auth';
import { POST } from '@/app/api/upload/route';

const request = (valid = true, origin = 'http://localhost:3060') => {
  const data = new FormData();
  const bytes = valid ? Buffer.from('89504e470d0a1a0a00000000', 'hex') : Buffer.from('<svg>not an image</svg>');
  data.set('file', new File([bytes], valid ? 'qa.png' : 'qa.svg'));
  return new Request('http://localhost:3060/api/upload', { method: 'POST', headers: { origin }, body: data });
};
beforeEach(() => {
  vi.mocked(requireMerchant).mockRejectedValue(new Error('기관 권한 없음'));
  vi.mocked(getSessionUser).mockResolvedValue(null);
});
describe('기관·최고관리자 이미지 업로드', () => {
  it('최고관리자는 메인 배경 이미지를 직접 업로드할 수 있다', async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: 'admin', role: 'ADMIN', name: null, email: null, avatarIndex: 0, adminPermission: 'SUPER_ADMIN' });
    const r = await POST(request()); expect(r.status).toBe(200); expect(await r.json()).toMatchObject({ ok: true, url: '/api/media/qa.png' });
  });
  it('승인된 기관 담당자는 자신의 배너와 여백 이미지를 업로드할 수 있다', async () => {
    vi.mocked(requireMerchant).mockResolvedValue({ id: 'org-user', merchantId: 'org', role: 'MERCHANT', name: null, email: null, avatarIndex: 0, merchantStatus: 'APPROVED' });
    expect((await POST(request())).status).toBe(200);
  });
  it('읽기 전용 관리자의 이미지 업로드는 막는다', async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: 'read', role: 'ADMIN', name: null, email: null, avatarIndex: 0, adminPermission: 'READ_ONLY' });
    expect((await POST(request())).status).toBe(401);
  });
  it('이미지 형식이 아니거나 다른 출처의 요청이면 거절한다', async () => {
    vi.mocked(getSessionUser).mockResolvedValue({ id: 'admin', role: 'ADMIN', name: null, email: null, avatarIndex: 0, adminPermission: 'SUPER_ADMIN' });
    expect((await POST(request(false))).status).toBe(400);
    expect((await POST(request(true, 'https://other.example'))).status).toBe(403);
  });
});
