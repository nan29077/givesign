import type { Metadata } from 'next';
import { Card } from '@/components/ui';
import { OptOutForm } from '@/components/relationship/forms';

/**
 * 관계 안내(광고) 무료 수신 거부(2026-11-13 5차 L4). 로그인 없이, 버튼 한 번으로 그 기관 소식·후원 안내 수신 동의를 철회한다.
 * 링크를 여는 것만으로는 바뀌지 않는다(미리보기 수집기 대비). 결제·영수증 안내는 계속 나간다.
 */
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '수신 거부', robots: { index: false, follow: false } };

export default async function OptOutPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-10">
      <div className="app-column">
        <Card>
          <h1 className="text-[20px] font-extrabold text-ink-900">기관 소식·후원 안내 수신 거부</h1>
          <p className="mt-2 text-[16px] leading-relaxed text-ink-700">
            아래 버튼을 누르면 이 기관의 소식·후원 안내(광고성) 문자를 더 이상 받지 않습니다. 비용은 들지 않습니다. 후원 결제·영수증 안내는 그대로 받습니다.
          </p>
          <div className="mt-4"><OptOutForm token={token} /></div>
        </Card>
      </div>
    </main>
  );
}
