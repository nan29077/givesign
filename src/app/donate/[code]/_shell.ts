import { notFound } from 'next/navigation';
import { getDonationPage } from '@/server/services/fundraising';
import { findDonationOrg, getDonorMember } from '@/server/services/donor-members';

/** 기관 후원 회원 화면(로그인·가입·마이페이지) 공통 데이터: 기관, 후원페이지 꾸밈, 이 기관의 로그인 회원. */
export async function loadDonorContext(code: string) {
  const org = await findDonationOrg(code);
  if (!org) notFound();
  const [page, viewer] = await Promise.all([getDonationPage(org.id), getDonorMember(org).catch(() => null)]);
  return {
    org,
    viewer,
    color: page.color || '#28634e',
    backgroundUrl: page.backgroundUrl,
    shellOrg: { code: org.code, displayName: org.displayName, logoUrl: page.logoUrl || org.avatarUrl || null },
  };
}

/** 같은 기관 후원페이지 안으로만 돌아가게 한다. */
export function safeDonorNext(code: string, next: string | undefined, fallback: string) {
  const base = `/donate/${code}`;
  return next && next.startsWith(base) && !next.startsWith('//') ? next : fallback;
}
