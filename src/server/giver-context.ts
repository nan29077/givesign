import { redirect } from 'next/navigation';
import { getSessionUser } from '@/server/auth';
import { prisma } from '@/server/db';
import { bazaarPageGuard } from '@/server/services/bazaar-settings';

/** 기부자 콘솔 화면(서버 컴포넌트) 공용: 스위치·로그인·기부 회원 확인 */
export async function giverPageContext() {
  await bazaarPageGuard();
  const user = await getSessionUser().catch(() => null);
  if (!user || user.role !== 'GIVER') redirect('/login?next=/giver');
  const donor = await prisma.inKindDonor.findUnique({ where: { userId: user.id } });
  if (!donor) redirect('/bazaar/join');
  return { user, donor };
}
