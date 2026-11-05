import { NextResponse } from 'next/server';
import { clientIpFromRequest } from '@/server/rate-limit';
import { recordContentClick } from '@/server/services/content-clicks';

export const dynamic = 'force-dynamic';

/**
 * 콘텐츠 짧은 링크. 클릭을 세고(봇·10분 중복 제외) 게시 행의 기관 후원페이지로 302.
 * 이동할 주소는 서버가 게시 행에서 만든다 — 쿼리로 받은 주소로는 보내지 않는다(오픈 리다이렉트 금지).
 */
export async function GET(request: Request, { params }: { params: Promise<{ publishId: string }> }) {
  const { publishId } = await params;
  const r = await recordContentClick({
    publishId,
    ip: clientIpFromRequest(request),
    userAgent: request.headers.get('user-agent'),
  });
  if (!r.found) return new NextResponse('Not Found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const res = NextResponse.redirect(r.target, 302);
  res.headers.set('cache-control', 'no-store');
  res.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  return res;
}
