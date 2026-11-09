import type { Metadata } from 'next';
import { BellRing } from 'lucide-react';
import { DonorShell } from '@/components/public/donor-shell';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { NotificationSettingsPanel } from '@/components/self-service/notification-settings';
import { notificationSettings } from '@/server/services/donor-preferences';
import { donorMarketingToggleAction } from '@/app/actions/marketing-consent';
import { donorMemberMarketingState } from '@/server/services/marketing-consent';
import { MemberMyNav, loadMemberSelf } from '../_member';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '알림 설정', robots: { index: false } };

/** 기관 후원 회원 — 알림 설정 한 곳(이 기관만). 휴대폰 인증 전에는 (선택) 소식 수신 동의만 바꿀 수 있다. */
export default async function DonorSettingsPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const { ctx, me, base, scope } = await loadMemberSelf(code, '/settings');
  const settings = scope ? await notificationSettings(scope.payerId, scope.merchantId) : null;
  const marketing = await donorMemberMarketingState(me.id);
  // 인증한 번호의 후원자가 이 기관과 아직 이어지지 않았으면(후원 전) 기관별 설정 대신 회원 동의만 보여 준다.
  const merchants = settings?.merchants ?? [];
  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-4 px-4 pt-6 text-[16px] sm:px-7">
        <MemberMyNav base={base} active="settings" color={ctx.color} />
        <h1 className="text-[22px] font-black text-ink-900">알림 설정</h1>
        {settings ? <NotificationSettingsPanel code={ctx.org.code} channel={settings.channel} merchants={merchants} /> : null}
        {!settings || merchants.length === 0 ? (
          <section className="rounded-[24px] border border-ink-100 bg-white p-5">
            <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><BellRing size={20} strokeWidth={1.7} /> 소식·후원 안내 받기 (선택)</h2>
            <p className="mt-1.5 leading-relaxed text-ink-700">
              {ctx.org.displayName}의 소식과 후원 안내를 받을지 정합니다. 지금은 <b>{marketing.agreed ? '동의함' : '동의 안 함'}</b> 상태입니다. 출금·영수증 안내와는 별개입니다.
              {!settings ? ' 휴대폰 인증을 마치면 안내 받는 방법과 월간 안내도 여기서 바꿀 수 있습니다.' : ''}
            </p>
            <DonorActionForm action={donorMarketingToggleAction} submitLabel={marketing.agreed ? '동의 철회' : '동의하기'} size="lg" variant="secondary" className="mt-3">
              <input type="hidden" name="code" value={ctx.org.code} />
              <input type="hidden" name="agree" value={marketing.agreed ? '0' : '1'} />
            </DonorActionForm>
          </section>
        ) : null}
      </div>
    </DonorShell>
  );
}
