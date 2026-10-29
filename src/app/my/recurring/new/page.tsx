import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { Card, Checkbox, EmptyState, Field, Input, LinkButton, Notice, Select, Textarea } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { createRecurringAction } from '@/app/actions/donor';
import { openCampaigns } from '@/server/services/fundraising';
import { currentTermsDoc } from '@/server/services/terms';
import { firstChargeDate, recurringAmountRange, recurringIsMock } from '@/server/services/recurring';
import { normalizeMerchantCode } from '@/lib/id';
import { kstDateKey } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

const PRESETS = [10000, 20000, 30000, 50000, 100000];


/**
 * 정기후원 신청. /donate/[code] 의 "매월 후원하기" 에서 ?merchant=코드 로 들어온다.
 */
export default async function NewRecurringPage({ searchParams }: { searchParams: Promise<{ merchant?: string; campaign?: string }> }) {
  const sp = await searchParams;
  const code = normalizeMerchantCode(sp.merchant ?? '');
  const { payerId } = await requirePayerContext(`/my/recurring/new?merchant=${encodeURIComponent(sp.merchant ?? '')}`);
  const merchant = code ? await prisma.merchantProfile.findFirst({ where: { code, status: 'APPROVED' }, select: { id: true, code: true, displayName: true } }) : null;
  if (!merchant) notFound();

  if (!payerId) {
    return (
      <>
        <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />
        <div className="mt-4"><LinkButton href="/my/account#phone-link" size="md" className="w-full">휴대폰 번호 연결하기</LinkButton></div>
      </>
    );
  }
  const [hasToken, campaigns, terms, existing, range] = await Promise.all([
    prisma.paymentMethodToken.count({ where: { payerId, status: 'ACTIVE' } }),
    openCampaigns(merchant.id),
    currentTermsDoc('RECURRING_DEBIT'),
    prisma.recurringDonation.findFirst({ where: { payerId, merchantId: merchant.id, status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } }, select: { id: true } }),
    recurringAmountRange(merchant.id, payerId),
  ]);
  const defaultDay = Math.min(28, Number(kstDateKey().slice(8, 10)));

  if (existing) {
    return (
      <Card>
        <Notice tone="brand" title="이미 이 기관에 정기후원이 등록되어 있습니다">금액이나 출금일은 <Link href="/my/recurring" className="font-bold underline">정기후원</Link> 탭에서 바꿀 수 있습니다.</Notice>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <p className="text-[12px] font-bold text-ink-400">정기후원 신청</p>
        <h2 className="mt-1 text-[20px] font-black text-ink-900">{merchant.displayName}</h2>
        <p className="mt-1 text-[13px] text-ink-500">매월 정한 날짜에 등록된 결제수단에서 자동으로 후원됩니다. 언제든 일시정지·해지할 수 있습니다.</p>
      </Card>
      {recurringIsMock() ? <Notice tone="neutral">현재 mock 결제사입니다. 실제 출금 없이 흐름만 재현됩니다.</Notice> : null}
      {!hasToken ? (
        <Notice tone="warning" title="등록된 결제수단이 없습니다">먼저 기관 MO 번호로 문자를 보내 결제수단 등록을 마쳐 주세요. 등록 후 이 화면으로 돌아오면 신청할 수 있습니다.</Notice>
      ) : (
        <Card>
          <DonorActionForm action={createRecurringAction} submitLabel="정기후원 시작" size="lg">
            <input type="hidden" name="merchantCode" value={merchant.code} />
            <Field label="매월 후원 금액(원)" required hint={`${formatNumber(range.min)}원 ~ ${formatNumber(range.max)}원 (기관 설정과 이용 한도 기준)`}>
              <div className="mb-2 flex flex-wrap gap-2">
                {PRESETS.filter((p) => BigInt(p) >= range.min && BigInt(p) <= range.max).map((p) => (
                  <label key={p} className="cursor-pointer rounded-xl border border-ink-200 px-3 py-2 text-[13px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                    <input type="radio" name="preset" value={p} className="sr-only" />
                    {formatNumber(p)}원
                  </label>
                ))}
              </div>
              <Input name="amount" inputMode="numeric" placeholder="직접 입력 (위에서 고르면 비워 두세요)" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="출금일" required hint={`첫 출금 예정 ${firstChargeDate(defaultDay)}`}>
                <Select name="dayOfMonth" defaultValue={String(defaultDay)}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>매월 {d}일</option>)}
                </Select>
              </Field>
              {campaigns.length ? (
                <Field label="지정 캠페인(선택)">
                  <Select name="campaignId" defaultValue={sp.campaign && campaigns.some((c) => c.id === sp.campaign) ? sp.campaign : ''}>
                    <option value="">기관 일반 후원</option>
                    {campaigns.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                  </Select>
                </Field>
              ) : null}
            </div>
            <Field label="응원 메시지(선택)"><Textarea name="message" rows={2} maxLength={80} placeholder="매달 작은 마음을 보탭니다" /></Field>
            <Checkbox name="anonymous" label="후원페이지에 익명으로 표시" />
            <div className="rounded-xl border border-ink-200 p-3">
              <p className="text-[13px] font-bold text-ink-900">{terms?.title ?? '정기후원 자동 출금 동의'}</p>
              <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-[12px] leading-relaxed text-ink-500">{terms?.content ?? '동의 약관이 준비되지 않았습니다.'}</pre>
              <Checkbox name="agree" required label="위 내용을 확인했고 매월 자동 출금에 동의합니다" />
            </div>
          </DonorActionForm>
        </Card>
      )}
    </div>
  );
}
