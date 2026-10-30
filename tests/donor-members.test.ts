import { beforeEach, describe, expect, it, vi } from 'vitest';

// 회원 세션은 쿠키를 쓴다. 테스트에서는 메모리 쿠키 저장소로 대체한다.
const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, phoneHash } from '@/lib/crypto';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';
import {
  DonorMemberError,
  donorCookieName,
  donorMemberOverview,
  getDonorMember,
  loginDonorMember,
  logoutDonorMember,
  loginDonorWithSocial,
  setDonorMemberStatus,
  signupDonorMember,
  withdrawDonorMember,
} from '@/server/services/donor-members';

/**
 * 기관 후원페이지 회원 — 기관마다 독립된 로그인.
 *  1) 같은 이메일로 기관마다 따로 가입하고, 비밀번호도 따로다.
 *  2) A 기관 세션으로 B 기관 페이지를 열면 비로그인이다(쿠키를 옮겨 붙여도).
 *  3) 정지하면 세션이 끊기고 로그인할 수 없다. 탈퇴하면 개인정보가 지워지고 같은 이메일로 다시 가입할 수 있다.
 *  4) 회원 화면은 휴대폰 인증으로 연결된 그 기관 후원만 보여 준다.
 */

let fx: Fixture;
let orgA: { id: string; code: string };
let orgB: { id: string; code: string };

async function makeOtherOrg() {
  const user = await prisma.user.create({ data: { id: newId(), email: `m-${newId()}@test.kr`, role: 'MERCHANT' } });
  return prisma.merchantProfile.create({
    data: { id: newId(), userId: user.id, code: `GIV-${newId().slice(-4)}`, displayName: '다른기관', status: 'APPROVED' },
    select: { id: true, code: true },
  });
}

beforeEach(async () => {
  await resetDb();
  jar.clear();
  fx = await seedBasics({ paymentMode: 'DIRECT_TRIGGER' });
  orgA = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId }, select: { id: true, code: true } });
  orgB = await makeOtherOrg();
});

describe('기관별 후원 회원', () => {
  it('[1] 같은 이메일로 기관마다 따로 가입하고, 다른 기관 비밀번호로는 로그인되지 않는다', async () => {
    await signupDonorMember(orgA, { email: 'Kim@Test.kr', name: '김A', password: 'pass-aaaa', marketingAgreed: false });
    await signupDonorMember(orgB, { email: 'kim@test.kr', name: '김B', password: 'pass-bbbb', marketingAgreed: true });
    expect(await prisma.donorMember.count({ where: { email: 'kim@test.kr' } })).toBe(2);

    await expect(signupDonorMember(orgA, { email: 'kim@test.kr', name: '중복', password: 'pass-cccc', marketingAgreed: false })).rejects.toBeInstanceOf(DonorMemberError);
    await expect(loginDonorMember(orgA, 'kim@test.kr', 'pass-bbbb')).rejects.toBeInstanceOf(DonorMemberError);
    await expect(loginDonorMember(orgA, 'kim@test.kr', 'pass-aaaa')).resolves.toBeTruthy();
  });

  it('[2] 세션은 기관 범위다 — A 기관 쿠키를 B 기관 이름으로 옮겨 붙여도 로그인으로 보지 않는다', async () => {
    await signupDonorMember(orgA, { email: 'a@test.kr', name: '에이', password: 'pass-aaaa', marketingAgreed: false });
    expect((await getDonorMember(orgA))?.name).toBe('에이');
    expect(await getDonorMember(orgB)).toBeNull();

    const tokenA = jar.get(donorCookieName(orgA.code))!;
    jar.set(donorCookieName(orgB.code), tokenA);
    expect(await getDonorMember(orgB)).toBeNull();

    await logoutDonorMember(orgA);
    expect(await getDonorMember(orgA)).toBeNull();
  });

  it('[3] 정지하면 세션이 끊기고 로그인할 수 없다. 해제하면 다시 된다', async () => {
    const id = await signupDonorMember(orgA, { email: 's@test.kr', name: '정지', password: 'pass-ssss', marketingAgreed: false });
    await setDonorMemberStatus(id, 'SUSPENDED', '테스트');
    expect(await getDonorMember(orgA)).toBeNull();
    await expect(loginDonorMember(orgA, 's@test.kr', 'pass-ssss')).rejects.toThrow(/정지/);
    await setDonorMemberStatus(id, 'ACTIVE', null);
    await expect(loginDonorMember(orgA, 's@test.kr', 'pass-ssss')).resolves.toBe(id);
  });

  it('[4] 탈퇴하면 개인정보가 지워지고 같은 이메일로 다시 가입할 수 있다', async () => {
    const id = await signupDonorMember(orgA, { email: 'w@test.kr', name: '탈퇴', password: 'pass-wwww', marketingAgreed: true });
    await withdrawDonorMember(id);
    const row = await prisma.donorMember.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('WITHDRAWN');
    expect(row.email).not.toContain('w@test.kr');
    expect(row.name).toBe('탈퇴 회원');
    expect(await getDonorMember(orgA)).toBeNull();
    await expect(signupDonorMember(orgA, { email: 'w@test.kr', name: '재가입', password: 'pass-wwww', marketingAgreed: false })).resolves.toBeTruthy();
  });

  it('[5] 회원 화면은 휴대폰 인증으로 연결된 그 기관 후원만 보여 준다', async () => {
    await seedRegisteredPayer(fx.payerPhone);
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: 'A 기관 후원' }), fx.merchantId);
    const id = await signupDonorMember(orgA, { email: 'p@test.kr', name: '연결', password: 'pass-pppp', marketingAgreed: false });

    const before = await donorMemberOverview({ id, merchantId: orgA.id });
    expect(before.linked).toBe(false);

    // 휴대폰 인증 완료 상태로 만든다(OTP 흐름은 화면 테스트에서 확인).
    await prisma.donorMember.update({ where: { id }, data: { phoneHash: phoneHash(fx.payerPhone), phoneEnc: encrypt(fx.payerPhone), phoneMasked: '010-****-5678', phoneVerifiedAt: new Date() } });
    const after = await donorMemberOverview({ id, merchantId: orgA.id });
    expect(after.linked).toBe(true);
    expect(after.count).toBe(1);

    // 같은 번호의 B 기관 회원에게는 A 기관 후원이 보이지 않는다.
    const idB = await signupDonorMember(orgB, { email: 'p@test.kr', name: '연결B', password: 'pass-pppp', marketingAgreed: false });
    await prisma.donorMember.update({ where: { id: idB }, data: { phoneHash: phoneHash(fx.payerPhone), phoneVerifiedAt: new Date() } });
    const other = await donorMemberOverview({ id: idB, merchantId: orgB.id });
    expect(other.count).toBe(0);
  });

  it('[6] 같은 기관 안에서 같은 번호를 두 회원이 인증할 수 없다(DB 유니크)', async () => {
    const a = await signupDonorMember(orgA, { email: 'x@test.kr', name: 'X', password: 'pass-xxxx', marketingAgreed: false });
    const b = await signupDonorMember(orgA, { email: 'y@test.kr', name: 'Y', password: 'pass-yyyy', marketingAgreed: false });
    const ph = phoneHash('01099998888');
    await prisma.donorMember.update({ where: { id: a }, data: { phoneHash: ph } });
    await expect(prisma.donorMember.update({ where: { id: b }, data: { phoneHash: ph } })).rejects.toThrow();
  });

  it('[7] 소셜 간편 로그인은 기관마다 따로 연결되고, 같은 이메일의 기존 회원과 자동으로 합치지 않는다', async () => {
    const a1 = await loginDonorWithSocial(orgA, { provider: 'kakao', providerUserId: 'k-1', email: 'Soc@Test.kr', name: '소셜' });
    expect(a1.created).toBe(true);
    const a2 = await loginDonorWithSocial(orgA, { provider: 'kakao', providerUserId: 'k-1' });
    expect(a2).toEqual({ memberId: a1.memberId, created: false });
    const b1 = await loginDonorWithSocial(orgB, { provider: 'kakao', providerUserId: 'k-1', email: 'soc@test.kr' });
    expect(b1.created).toBe(true);
    expect(b1.memberId).not.toBe(a1.memberId);
    const acc = await prisma.donorSocialAccount.findFirstOrThrow({ where: { memberId: a1.memberId } });
    expect(acc.providerUserHash).not.toContain('k-1');
    // 비밀번호 로그인은 되지 않는다.
    await expect(loginDonorMember(orgA, 'soc@test.kr', '')).rejects.toBeInstanceOf(DonorMemberError);

    await signupDonorMember(orgA, { email: 'mail@test.kr', name: '메일', password: 'pass-mmmm', marketingAgreed: false });
    await expect(loginDonorWithSocial(orgA, { provider: 'naver', providerUserId: 'n-1', email: 'mail@test.kr' })).rejects.toThrow(/같은 이메일/);

    await withdrawDonorMember(a1.memberId);
    expect(await prisma.donorSocialAccount.count({ where: { memberId: a1.memberId } })).toBe(0);
  });
});
