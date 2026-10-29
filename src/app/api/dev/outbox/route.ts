import { NextResponse } from 'next/server';
import { isLocal } from '@/lib/env';
import { readMockOutbox } from '@/server/adapters/mt';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 개발 전용 모의 MT 발송함 조회.
 *
 * 관리자 화면은 보안링크 토큰을 마스킹하므로, 로컬에서 전체 흐름
 * (MO 수신 → 계좌 등록 → 확인 링크 → 결제)을 검증할 때만 사용한다.
 * APP_ENV=local 이 아니면 404 를 반환하며, 운영 배포 시에는 이 라우트를 제거한다.
 */
export async function GET() {
  if (!isLocal) {
    return NextResponse.json({ ok: false, message: 'not found' }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    warning: '개발 전용 엔드포인트입니다. 운영 환경에서는 비활성화됩니다.',
    outbox: readMockOutbox(30),
  });
}
