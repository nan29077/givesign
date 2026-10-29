import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * 요청 경로를 헤더로 넘긴다.
 *
 * 레이아웃(src/app/my/layout.tsx)은 자신이 어떤 경로에서 렌더되는지 알 수 없다. 비로그인 후원자를 로그인으로
 * 보낼 때 원래 가려던 주소(정기후원 신청 ?merchant=&campaign= 등)를 next 로 넘기려면 경로가 필요하다(점검 M-16).
 * 그 외의 일은 하지 않는다(인증·리다이렉트는 각 화면이 담당).
 */
export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  const { pathname, search } = request.nextUrl;
  headers.set('x-givesign-path', `${pathname}${search}`);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ['/my/:path*'],
};
