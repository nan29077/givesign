import { redirect } from 'next/navigation';
import { prisma } from '@/server/db';
import { getSessionUser, type SessionUser } from '@/server/auth';

/**
 * 마이페이지 공통 로더.
 * - 로그인하지 않았으면 /login 으로 보낸다.
 * - PayerProfile 은 문자후원(MO) 수신 시 생성되므로 회원가입만 한 계정에는 없을 수 있다.
 */

export interface PayerContext {
  user: SessionUser;
  payerId: string | null;
}

export async function requirePayerContext(next = '/my'): Promise<PayerContext> {
  const user = await getSessionUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);

  const payer = await prisma.payerProfile.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });

  return { user, payerId: payer?.id ?? null };
}

export const NO_PAYER_TITLE = '휴대폰 번호가 연결되지 않았습니다';
export const NO_PAYER_DESC =
  '문자후원 내역은 휴대전화 번호를 기준으로 기록됩니다. 마이페이지의 내 정보 탭에서 본인 휴대폰 번호를 인증하면 그 번호로 결제한 내역이 이 계정에 표시됩니다.';
