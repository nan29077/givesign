import { notFound } from 'next/navigation';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { featureVolunteerEnabled } from '@/lib/env';
import { normalizeMerchantCode } from '@/lib/id';
import { Card, Checkbox, EmptyState, Field, Input, LinkButton, Select, Textarea } from '@/components/ui';
import { DonorActionForm } from '@/components/my/donor-action-form';
import { applyVolunteerAction } from '@/app/actions/volunteer';
import { currentTermsDoc } from '@/server/services/terms';
import { VOLUNTEER_DAYS, VOLUNTEER_INTERESTS, VOLUNTEER_SLOTS } from '@/server/services/volunteers';
import { dayLabel, slotLabel } from '@/server/services/agreements';

export const dynamic = 'force-dynamic';

/** 자원봉사 신청서. 문자 '봉사' 회신 링크·후원페이지·SNS 링크에서 ?merchant=코드 로 들어온다. */
export default async function VolunteerApplyPage({ searchParams }: { searchParams: Promise<{ merchant?: string }> }) {
  if (!featureVolunteerEnabled()) notFound();
  const sp = await searchParams;
  const code = normalizeMerchantCode(sp.merchant ?? '');
  const { payerId } = await requirePayerContext(`/my/volunteer/apply?merchant=${encodeURIComponent(sp.merchant ?? '')}`);
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
  const [terms, existing, profile] = await Promise.all([
    currentTermsDoc('VOLUNTEER_PRIVACY'),
    prisma.volunteerApplication.findFirst({ where: { payerId, merchantId: merchant.id, status: { in: ['RECEIVED', 'APPROVED'] } }, select: { id: true } }),
    prisma.volunteerProfile.findUnique({ where: { payerId } }),
  ]);
  if (existing) {
    return <EmptyState title="이미 진행 중인 신청이 있습니다" description="봉사 탭에서 진행 상황과 배정 안내를 확인해 주세요." action={<LinkButton href="/my/volunteer">봉사 탭으로</LinkButton>} />;
  }
  return (
    <div className="space-y-4">
      <Card>
        <p className="text-[12px] font-bold text-ink-400">자원봉사 신청</p>
        <h2 className="mt-1 text-[20px] font-black text-ink-900">{merchant.displayName}</h2>
        <p className="mt-1 text-[13px] text-ink-500">가능한 분야와 시간을 알려 주시면 기관 담당자가 확인한 뒤 일정을 안내해 드립니다.</p>
      </Card>
      <Card>
        <DonorActionForm action={applyVolunteerAction} submitLabel="신청서 제출" size="lg">
          <input type="hidden" name="merchantCode" value={merchant.code} />
          <Field label="활동 분야 (여러 개 선택)" required>
            <div className="flex flex-wrap gap-2">
              {VOLUNTEER_INTERESTS.map((i) => (
                <label key={i} className="cursor-pointer rounded-xl border border-ink-200 px-3 py-2 text-[13px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                  <input type="checkbox" name="interests" value={i} defaultChecked={profile?.interests.includes(i)} className="sr-only" />{i}
                </label>
              ))}
            </div>
          </Field>
          <Field label="가능한 요일" required>
            <div className="flex flex-wrap gap-2">
              {VOLUNTEER_DAYS.map((d) => (
                <label key={d} className="cursor-pointer rounded-xl border border-ink-200 px-3 py-2 text-[13px] font-bold has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                  <input type="checkbox" name="days" value={d} defaultChecked={profile?.availableDays.includes(d)} className="sr-only" />{dayLabel(d)}
                </label>
              ))}
            </div>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="시간대">
              <Select name="timeSlot" defaultValue={profile?.timeSlot ?? 'WEEKEND'}>{VOLUNTEER_SLOTS.map((s) => <option key={s} value={s}>{slotLabel(s)}</option>)}</Select>
            </Field>
            <Field label="희망 활동 (선택)"><Input name="wish" maxLength={100} placeholder="예: 어르신 말벗" /></Field>
          </div>
          <Field label="봉사 경력 (선택)"><Textarea name="experience" rows={2} maxLength={300} defaultValue={profile?.experience ?? ''} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="비상연락처 이름 (선택)"><Input name="emergencyName" maxLength={20} defaultValue={profile?.emergencyName ?? ''} /></Field>
            <Field label="비상연락처 휴대폰 (선택)" hint="암호화해 저장하며 기관에는 마스킹 번호만 보입니다."><Input name="emergencyPhone" inputMode="tel" placeholder="010-0000-0000" /></Field>
          </div>
          <Field label="기관에 남길 말 (선택)"><Textarea name="message" rows={2} maxLength={300} /></Field>
          <Checkbox name="safetyPledge" label="안전 수칙을 지키고 담당자 안내에 따라 활동하겠습니다. (필수)" />
          <Checkbox name="agree" label={`${terms?.title ?? '자원봉사 개인정보 수집·이용 동의'} (필수)`} description="신청 내용은 신청서로 보관되며 마이페이지에서 열람할 수 있습니다." />
          {terms ? <details className="rounded-xl bg-ink-50 p-3 text-[12px] leading-relaxed text-ink-600"><summary className="cursor-pointer font-bold">동의 내용 보기</summary><p className="mt-2 whitespace-pre-line">{terms.content}</p></details> : null}
        </DonorActionForm>
      </Card>
    </div>
  );
}
