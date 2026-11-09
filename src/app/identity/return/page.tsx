import type { Metadata } from 'next';
import { Card } from '@/components/ui';

/**
 * 본인인증 공급자 돌아오는 주소(2026-11-13 5차 L1). 실공급자 결과 수신은 **규격 수령 후 구현**한다 —
 * 지금은 mock(/mock/identity)만 결과를 넘긴다. 이 화면은 공급자 파라미터를 해석하지 않는다(지어낸 규격 금지).
 */
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '본인인증 결과', robots: { index: false, follow: false } };

export default function IdentityReturnPage() {
  return (
    <main className="app-column px-4 py-10">
      <Card>
        <p className="text-[16px] font-bold text-ink-900">본인인증 기관 연동 전입니다</p>
        <p className="mt-2 text-[15px] text-ink-600">실제 본인인증 결과 수신은 연동 규격을 받은 뒤 구현됩니다.</p>
      </Card>
    </main>
  );
}
