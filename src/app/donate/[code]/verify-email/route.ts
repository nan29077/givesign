import { NextResponse } from 'next/server';
import { findDonationOrg } from '@/server/services/donor-members';
import { confirmDonorEmail } from '@/server/services/mail';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 후원 회원 이메일 인증 링크 (메일 실연동일 때만 발송된다). 토큰은 해시로만 대조한다. */
export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const { code } = await ctx.params;
  const org = await findDonationOrg(code);
  if (!org) return NextResponse.redirect(new URL('/', req.url), 303);
  const token = new URL(req.url).searchParams.get('token') ?? '';
  const r = await confirmDonorEmail(org, token);
  const q = r === 'VERIFIED' ? 'verified' : r === 'EXPIRED' ? 'expired' : 'invalid';
  return NextResponse.redirect(new URL(`/donate/${org.code}/my?email=${q}`, req.url), 303);
}
