import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { IdentityNotice } from '@/components/identity/identity-notice';
import { prisma } from '@/server/db';
import { Checkbox, EmptyState, Field, Input, LinkButton, Notice } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { updateRecurringAction } from '@/app/actions/donor';
import { recurringIsMock } from '@/server/services/recurring';
import { myScope, selfServiceRecurringList } from '@/server/services/donor-self-service';
import { hasStepUp } from '@/server/services/self-service-stepup';
import { RecurringManagerCard } from '@/components/self-service/recurring-manager';
import { StepUpPanel } from '@/components/self-service/self-service-forms';

export const dynamic = 'force-dynamic';

/**
 * 내 정기후원 — 정기후원 관리 한 화면 (2026-11-09 2차 F).
 * 약정별로 금액·출금일 변경(결과 문장 미리보기), 쉬어 가기(재개 예정일), 일시정지·다시 시작·해지, 결제수단 다시 등록,
 * 변경 이력. 변경·해지는 휴대폰 재확인(10분) 뒤에만 된다.
 */
export default async function MyRecurringPage() {
  const { user, payerId } = await requirePayerContext('/my/recurring');
  const scope = payerId ? await myScope(user.id) : null;
  if (!payerId || !scope) {
    return (
      <>
        <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />
        <div className="mt-4"><LinkButton href="/my/account#phone-link" size="md" className="w-full">휴대폰 번호 연결하기</LinkButton></div>
      </>
    );
  }
  const [{ items, hasActiveToken }, verified, payer, extras] = await Promise.all([
    selfServiceRecurringList(scope),
    hasStepUp({ kind: 'USER', userId: user.id }),
    prisma.payerProfile.findUnique({ where: { id: payerId }, select: { phoneMasked: true } }),
    prisma.recurringDonation.findMany({ where: { payerId, status: { not: 'CANCELED' } }, select: { id: true, message: true, anonymous: true } }),
  ]);
  const extraOf = new Map(extras.map((x) => [x.id, x]));
  const hasLive = items.some((i) => i.status !== 'CANCELED');

  return (
    <div className="space-y-4 text-[16px]">
      {recurringIsMock() ? <Notice tone="neutral">현재 mock 결제사입니다. 실제 출금 없이 흐름만 재현됩니다.</Notice> : null}
      {!hasActiveToken ? (
        <Notice tone="warning" title="등록된 결제수단이 없습니다">정기후원은 등록된 결제수단으로 매월 출금됩니다. 아래 약정의 &lsquo;결제수단 다시 등록&rsquo;에서 등록할 수 있습니다.</Notice>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          title="진행 중인 정기후원이 없습니다"
          description="기관 후원페이지의 '매월 후원하기' 에서 금액과 출금일을 정하면 매월 자동으로 후원됩니다."
          action={<LinkButton href="/" variant="secondary">기관 찾아보기</LinkButton>}
        />
      ) : (
        <>
          {hasLive ? <StepUpPanel verified={verified} phoneMasked={payer?.phoneMasked ?? null} /> : null}
          {hasLive ? <IdentityNotice purpose="RECURRING" next="/my/recurring" /> : null}
          {items.map((item) => {
            const extra = extraOf.get(item.id);
            return (
              <div key={item.id} className="space-y-2">
                <RecurringManagerCard item={item} hasActiveToken={hasActiveToken} agreementHref={item.agreementDocId ? `/my/agreements/${item.agreementDocId}` : null} />
                {extra ? (
                  <details className="rounded-2xl border border-ink-100 bg-white px-4 py-3">
                    <summary className="cursor-pointer text-[15px] font-bold text-ink-700">응원 메시지·익명 표시 바꾸기</summary>
                    <DonorActionForm action={updateRecurringAction} submitLabel="저장" size="md" className="mt-3">
                      <input type="hidden" name="id" value={item.id} />
                      <input type="hidden" name="amount" value={item.amount.toString()} />
                      <input type="hidden" name="dayOfMonth" value={String(item.dayOfMonth)} />
                      <Field label="응원 메시지"><Input name="message" maxLength={80} defaultValue={extra.message} /></Field>
                      <Checkbox name="anonymous" defaultChecked={extra.anonymous} label="후원페이지에 익명으로 표시" />
                    </DonorActionForm>
                  </details>
                ) : null}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
