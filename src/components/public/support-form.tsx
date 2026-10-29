'use client';

import * as React from 'react';
import { CheckCircle2, Send } from 'lucide-react';
import { Button, Field, Input, Notice, Select, Textarea, Card, CardTitle } from '@/components/ui';
import { SUPPORT_CATEGORIES } from '@/components/public/support-options';
import { submitSupportRequest, type SupportFormState } from '@/app/actions/support';

const initial: SupportFormState = { ok: false };

export function SupportForm({
  defaultTransactionNo,
  mode = 'support',
}: {
  defaultTransactionNo?: string;
  mode?: 'support' | 'onboarding';
}) {
  const [state, formAction, pending] = React.useActionState(submitSupportRequest, initial);
  const onboarding = mode === 'onboarding';

  if (state.ok && state.ticketId) {
    return (
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-success-50 text-success-500">
            <CheckCircle2 size={18} strokeWidth={1.7} />
          </span>
          <div className="min-w-0">
            <CardTitle>문의가 접수되었습니다</CardTitle>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
              담당자가 확인 후 순차적으로 답변드립니다. 답변이 등록되면 화면 오른쪽 아래{' '}
              <strong className="font-bold text-ink-700">문의 버튼</strong>에 알림 배지가 표시되고, 버튼을 눌러
              내용을 바로 확인하실 수 있습니다. 추가 문의 시 아래 접수번호를 알려주세요.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
          <p className="text-[12px] font-semibold text-brand-700">접수번호</p>
          <p className="mt-1 break-all font-mono text-[14px] font-bold tracking-tight text-ink-900">
            {state.ticketId}
          </p>
        </div>

        {state.linkNote ? (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-500">{state.linkNote}</p>
        ) : null}

        <Button
          type="button"
          variant="secondary"
          size="md"
          className="mt-4"
          onClick={() => window.location.reload()}
        >
          새 문의 작성
        </Button>
      </Card>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="intent" value={onboarding ? 'ONBOARDING' : 'SUPPORT'} />
      {onboarding ? <input type="hidden" name="category" value="MERCHANT" /> : (
      <Field label="문의 유형" required>
        <Select name="category" defaultValue="" required>
          <option value="" disabled>
            문의 유형을 선택해 주세요
          </option>
          {SUPPORT_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
      </Field>
      )}

      {onboarding ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="회사·사업자명" required>
            <Input name="companyName" placeholder="예: 햇살복지재단" maxLength={80} required />
          </Field>
          <Field label="기관명" required>
            <Input name="serviceName" placeholder="예: 지역사회 도시락 후원" maxLength={80} required />
          </Field>
          <Field label="담당자명" required>
            <Input name="contactName" placeholder="담당자 이름" maxLength={40} required />
          </Field>
          <Field label="회신 연락처" required>
            <Input name="contact" placeholder="이메일 또는 휴대전화번호" maxLength={100} required />
          </Field>
          <Field label="기관 홈페이지 (선택)">
            <Input name="serviceUrl" placeholder="https://" maxLength={200} inputMode="url" />
          </Field>
          <Field label="예상 월 결제 규모 (선택)">
            <Select name="monthlyVolume" defaultValue="">
              <option value="">아직 정해지지 않음</option>
              <option value="1천만원 미만">1천만원 미만</option>
              <option value="1천만~5천만원">1천만~5천만원</option>
              <option value="5천만~1억원">5천만~1억원</option>
              <option value="1억원 이상">1억원 이상</option>
            </Select>
          </Field>
        </div>
      ) : (
      <Field
        label="거래번호 (선택)"
        hint="결제 결과 문자나 마이페이지 후원 내역에서 확인할 수 있습니다. 예: TRD-20260819-XXXXXXXX"
      >
        <Input
          name="transactionNo"
          placeholder="TRD-20260819-XXXXXXXX"
          maxLength={64}
          autoComplete="off"
          defaultValue={defaultTransactionNo ?? ''}
        />
      </Field>
      )}

      <Field
        label={onboarding ? '도입 희망 내용' : '문의 내용'}
        required
        hint={onboarding
          ? '후원 대상, 원하는 문자 결제 흐름, 연동 방식과 도입 희망 시기를 알려주세요.'
          : '10자 이상 2,000자 이내로 입력해 주세요. 계좌번호, 카드번호, 주민등록번호는 입력하지 마세요.'}
      >
        <Textarea
          name="content"
          rows={8}
          required
          minLength={10}
          maxLength={2000}
          placeholder={onboarding
            ? '예: 지역사회 도시락 후원에 적용하려고 합니다. 문자 수신 후 결제 승인과 후원 내역 연동이 필요합니다.'
            : '발생한 상황과 시점을 함께 적어주시면 확인이 빨라집니다.'}
        />
      </Field>

      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '접수 중' : onboarding ? '도입 상담 신청하기' : '문의 접수하기'}
        <Send size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}
