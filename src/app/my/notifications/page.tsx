import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { EmptyState, LinkButton } from '@/components/ui';
import { NotificationSettingsPanel } from '@/components/self-service/notification-settings';
import { notificationSettings } from '@/server/services/donor-preferences';

export const dynamic = 'force-dynamic';

/** 알림 설정 한 곳 (2026-11-09 2차 F): 안내 받는 방법 · 기관별 월간 안내 · 기관별 (선택) 소식 수신 동의 */
export default async function MyNotificationsPage() {
  const { payerId } = await requirePayerContext('/my/notifications');
  if (!payerId) {
    return (
      <>
        <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />
        <div className="mt-4"><LinkButton href="/my/account#phone-link" size="md" className="w-full">휴대폰 번호 연결하기</LinkButton></div>
      </>
    );
  }
  const settings = await notificationSettings(payerId);
  return (
    <div className="space-y-4">
      <div>
        <Link href="/my/account" className="inline-flex items-center gap-1 text-[14px] font-semibold text-ink-500 hover:text-ink-900">
          <ChevronLeft size={16} strokeWidth={1.7} /> 내 정보로 돌아가기
        </Link>
        <h2 className="mt-1 text-[20px] font-black text-ink-900">알림 설정</h2>
      </div>
      <NotificationSettingsPanel channel={settings.channel} merchants={settings.merchants} />
    </div>
  );
}
