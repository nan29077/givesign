import type { Metadata } from 'next';
import { IdentityNotice } from '@/components/identity/identity-notice';
import Link from 'next/link';
import { DonorShell } from '@/components/public/donor-shell';
import { Notice } from '@/components/ui';
import { recurringIsMock } from '@/server/services/recurring';
import { selfServiceRecurringList } from '@/server/services/donor-self-service';
import { hasStepUp } from '@/server/services/self-service-stepup';
import { RecurringManagerCard } from '@/components/self-service/recurring-manager';
import { StepUpPanel } from '@/components/self-service/self-service-forms';
import { MemberMyNav, NeedPhoneNotice, loadMemberSelf } from '../_member';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '정기후원 관리', robots: { index: false } };

/**
 * 기관 후원 회원 — 정기후원 관리 (2026-11-09 2차 F). 이 기관 약정만 보인다(인증한 번호의 후원자 기준).
 * 변경·해지는 로그인 + 휴대폰 재확인(10분) 뒤에만.
 */
export default async function DonorRecurringPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const { ctx, me, base, scope } = await loadMemberSelf(code, '/recurring');
  const data = scope ? await selfServiceRecurringList(scope) : null;
  const verified = scope ? await hasStepUp({ kind: 'MEMBER', memberId: me.id }) : false;
  const hasLive = Boolean(data?.items.some((i) => i.status !== 'CANCELED'));

  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-4 px-4 pt-6 text-[16px] sm:px-7">
        <MemberMyNav base={base} active="recurring" color={ctx.color} />
        <h1 className="text-[22px] font-black text-ink-900">{ctx.org.displayName} 정기후원</h1>
        {!scope || !data ? (
          <NeedPhoneNotice base={base} />
        ) : data.items.length === 0 ? (
          <div className="rounded-[24px] border border-ink-100 bg-white p-5 text-[16px] leading-relaxed text-ink-700">
            이 기관에 등록된 정기후원이 없습니다. <Link href={base} className="font-bold underline" style={{ color: ctx.color }}>후원페이지에서 매월 후원하기</Link>
          </div>
        ) : (
          <>
            {recurringIsMock() ? <Notice tone="neutral">현재 mock 결제사입니다. 실제 출금 없이 흐름만 재현됩니다.</Notice> : null}
            {hasLive ? <StepUpPanel code={ctx.org.code} verified={verified} phoneMasked={me.phoneMasked} /> : null}
            {hasLive ? <IdentityNotice purpose="RECURRING" next={`${base}/my/recurring`} /> : null}
            {data.items.map((item) => (
              <RecurringManagerCard
                key={item.id}
                item={item}
                code={ctx.org.code}
                hasActiveToken={data.hasActiveToken}
                agreementHref={item.agreementDocId ? `${base}/my/agreements/${item.agreementDocId}` : null}
              />
            ))}
          </>
        )}
      </div>
    </DonorShell>
  );
}
