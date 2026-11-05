'use client';

import * as React from 'react';
import Link from 'next/link';
import { Building2, UserRound } from 'lucide-react';
import { Button, Checkbox, Field, Input, Notice, cx } from '@/components/ui';
import { signupGiverAction, type GiverSignupState } from '@/app/actions/bazaar-giver';

const initial: GiverSignupState = { ok: false };

/** 현물 기부 회원 가입: 기업 회원 / 개인 회원 */
export function GiverSignupForm() {
  const [state, formAction, pending] = React.useActionState(signupGiverAction, initial);
  const [type, setType] = React.useState<'CORPORATE' | 'INDIVIDUAL'>((state.values?.donorType as 'CORPORATE' | 'INDIVIDUAL') || 'CORPORATE');
  const v = state.values ?? {};
  const corp = type === 'CORPORATE';
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="donorType" value={type} />
      <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="회원 구분">
        {([
          ['CORPORATE', '기업 회원', '재고·신상품을 기부하는 회사', Building2],
          ['INDIVIDUAL', '개인 회원', '새 상품·미개봉 물품을 기부하는 개인', UserRound],
        ] as const).map(([value, label, desc, Icon]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={type === value}
            onClick={() => setType(value)}
            className={cx(
              'rounded-2xl border p-4 text-left transition',
              type === value ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-100' : 'border-ink-200 bg-white hover:bg-ink-50',
            )}
          >
            <Icon size={20} strokeWidth={1.6} className="text-brand-700" aria-hidden />
            <p className="mt-2 text-[14px] font-extrabold text-ink-900">{label}</p>
            <p className="mt-0.5 text-[12px] text-ink-500">{desc}</p>
          </button>
        ))}
      </div>

      <Field label={corp ? '상호(법인명)' : '이름'} required hint={corp ? '기부금영수증에 적히는 이름입니다.' : '기부금영수증에 적히는 성명입니다.'}>
        <Input name="displayName" required maxLength={60} defaultValue={v.displayName} />
      </Field>
      {corp ? (
        <>
          <Field label="사업자등록번호" required hint="숫자 10자리. 법인 기부금영수증은 이 번호로 발급됩니다.">
            <Input name="businessNo" required inputMode="numeric" defaultValue={v.businessNo} placeholder="123-45-67890" />
          </Field>
          <Field label="대표자" required>
            <Input name="representativeName" required maxLength={30} defaultValue={v.representativeName} />
          </Field>
          <Field label="담당자 이름" required hint="기부 진행 연락을 받을 분입니다.">
            <Input name="contactName" required maxLength={30} defaultValue={v.contactName} />
          </Field>
        </>
      ) : null}
      <Field label={corp ? '담당자 휴대폰' : '휴대폰'} required>
        <Input name="phone" required inputMode="tel" autoComplete="tel" defaultValue={v.phone} placeholder="010-0000-0000" />
      </Field>
      <Field label="주소" hint="영수증에 적을 주소(선택). 나중에 바꿀 수 있습니다.">
        <Input name="address" maxLength={200} defaultValue={v.address} />
      </Field>
      <Field label="이메일(로그인 아이디)" required>
        <Input type="email" name="email" required autoComplete="email" inputMode="email" defaultValue={v.email} />
      </Field>
      <Field label="비밀번호" required hint="8자 이상">
        <Input type="password" name="password" required minLength={8} autoComplete="new-password" />
      </Field>
      <Field label="비밀번호 확인" required>
        <Input type="password" name="passwordConfirm" required minLength={8} autoComplete="new-password" />
      </Field>
      <div className="rounded-xl border border-ink-200 px-3 py-1">
        <Checkbox
          name="agree"
          label={
            <span>
              <Link href="/terms" className="font-semibold text-brand-700">이용약관</Link>과{' '}
              <Link href="/privacy" className="font-semibold text-brand-700">개인정보처리방침</Link>에 동의합니다. (연락처는 암호화해 보관합니다)
            </span>
          }
        />
      </div>
      {state.message ? <Notice tone={state.ok ? 'success' : 'danger'}>{state.message}</Notice> : null}
      <Button type="submit" size="lg" disabled={pending}>{pending ? '가입 중' : '가입하고 기부 시작하기'}</Button>
    </form>
  );
}
