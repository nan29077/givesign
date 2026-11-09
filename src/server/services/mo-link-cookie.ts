import { cookies } from 'next/headers';
import { env } from '@/lib/env';
import { hmac, safeEqual } from '@/lib/crypto';

/** 문자 명령 링크(/mo/[토큰])에서 본인 확인을 마친 브라우저 표시 (2026-11-12 4차 K3). */
export const MO_LINK_COOKIE = 'givesign_mo_link';

/** 명령 링크 본인 확인을 마친 브라우저 표시(httpOnly). 값은 링크 id 의 HMAC. */
const bindValue = (linkId: string) => hmac(`mo-link:${linkId}`, env.crypto.sessionSecret);

export async function bindReplyLinkCookie(linkId: string) {
  const jar = await cookies();
  jar.set(MO_LINK_COOKIE, `${linkId}.${bindValue(linkId)}`, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.baseUrl.startsWith('https'),
    maxAge: 600,
    path: '/',
  });
}

export async function replyLinkBound(linkId: string): Promise<boolean> {
  try {
    const raw = (await cookies()).get(MO_LINK_COOKIE)?.value ?? '';
    const [id, sig] = raw.split('.');
    return id === linkId && !!sig && safeEqual(sig, bindValue(linkId));
  } catch {
    return false;
  }
}

