import { NextResponse } from 'next/server';
import { destroySession } from '@/server/auth';
import { isSameOrigin } from '@/server/request-guard';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  // CSRF 방어: 외부 사이트가 사용자를 임의로 로그아웃시키지 못하게 한다.
  if (!isSameOrigin(req)) {
    return NextResponse.json({ ok: false, message: '허용되지 않은 요청입니다.' }, { status: 403 });
  }
  await destroySession();
  return NextResponse.redirect(new URL('/', req.url), 303);
}
