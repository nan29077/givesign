'use client';

import * as React from 'react';
import { CheckCircle2, Send, Hash } from 'lucide-react';
import { Button, Card, CardTitle, Checkbox, Field, Input, LinkButton, Notice, Select, Textarea, Badge } from '@/components/ui';
import { applyMerchant, type MerchantApplyState } from '@/app/actions/merchant-apply';

const initial: MerchantApplyState = { ok: false };

const STATUS_TEXT: Record<string, string> = {
  PENDING: '심사 대기 중입니다.',
  APPROVED: '이미 승인된 사회복지기관 계정입니다.',
  REJECTED: '이전 신청이 반려되었습니다. 고객센터로 문의해 주세요.',
  SUSPENDED: '이용이 정지된 사회복지기관 계정입니다. 고객센터로 문의해 주세요.',
};


export function MerchantApplyForm({ loggedIn, sessionEmail }: { loggedIn: boolean; sessionEmail?: string | null }) {
  const [state, formAction, pending] = React.useActionState(applyMerchant, initial);
  const [isBusiness, setIsBusiness] = React.useState(false);

  // ------------------------------------------------------------ 신청 완료 화면
  if (state.ok && state.code) {
    return <ApplyDone code={state.code} displayName={state.displayName} />;
  }

  // ------------------------------------------------------------ 기신청 안내
  if (state.alreadyStatus && state.code) {
    return (
      <Card>
        <CardTitle>이미 신청 이력이 있습니다</CardTitle>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
          {STATUS_TEXT[state.alreadyStatus] ?? '신청 상태를 확인해 주세요.'}
        </p>
        <div className="mt-4 rounded-xl border border-brand-200 bg-brand-50 px-4 py-3">
          <p className="text-[12px] font-semibold text-brand-700">사회복지기관 코드</p>
          <p className="mt-1 font-mono text-[18px] font-extrabold tracking-[0.1em] text-ink-900">{state.code}</p>
        </div>
        <LinkButton href="/support" variant="secondary" size="md" className="mt-4 w-full">
          고객센터 문의
        </LinkButton>
      </Card>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <Card className="space-y-4">
        <CardTitle>기관 정보</CardTitle>

        <Field label="표시명" required hint="후원 페이지에 표시되는 이름입니다.">
          <Input name="displayName" required maxLength={30} defaultValue={state.values?.displayName} placeholder="햇살종합사회복지관" />
        </Field>

        <Field label="기관명" hint="사회복지기관의 공식 이름을 입력해 주세요.">
          <Input name="channelName" maxLength={60} defaultValue={state.values?.channelName} placeholder="예: 햇살종합사회복지관" />
        </Field>

        <Field label="기관 홈페이지" hint="https:// 로 시작하는 전체 주소를 입력해 주세요.">
          <Input
            name="channelUrl"
            type="url"
            maxLength={300}
            defaultValue={state.values?.channelUrl}
            inputMode="url"
            placeholder="https://"
          />
        </Field>

        <Field label="소개" hint="후원 페이지에 표시할 짧은 소개입니다. (300자 이내)">
          <Textarea name="description" rows={4} maxLength={300} defaultValue={state.values?.description} placeholder="문자 한 통으로 후원할 수 있습니다." />
        </Field>
      </Card>

      <Card className="space-y-4">
        <CardTitle>연락 및 정산 정보</CardTitle>

        <Field
          label="연락 이메일"
          required
          hint={loggedIn ? '심사 결과를 받을 이메일입니다.' : '이 이메일이 로그인 계정으로 사용됩니다.'}
        >
          <Input
            name="contactEmail"
            type="email"
            required
            inputMode="email"
            autoComplete="email"
            defaultValue={state.values?.contactEmail ?? sessionEmail ?? ''}
            placeholder="merchant@example.com"
          />
        </Field>

        <Field label="사업자 여부" required>
          <Select
            name="isBusinessSelect"
            value={isBusiness ? 'Y' : 'N'}
            onChange={(e) => setIsBusiness(e.target.value === 'Y')}
          >
            <option value="N">개인 (사업자 아님)</option>
            <option value="Y">개인사업자 · 법인사업자</option>
          </Select>
        </Field>
        {/* Select 값을 서버 액션에 체크박스 형태로 전달 */}
        <input type="hidden" name="isBusiness" value={isBusiness ? 'on' : ''} />

        {isBusiness ? (
          <Field label="사업자등록번호" required hint="숫자 10자리를 입력해 주세요.">
            <Input
              name="businessNo"
              inputMode="numeric"
              maxLength={20}
              defaultValue={state.values?.businessNo}
              placeholder="1234567890"
            />
          </Field>
        ) : (
          <p className="text-[12px] leading-relaxed text-ink-400">
            개인으로 신청하면 정산 시 소득세 원천징수가 적용됩니다. 사업자는 승인 후 증빙 서류 확인이 필요합니다.
          </p>
        )}
      </Card>

      {!loggedIn ? (
        <Card className="space-y-4">
          <div>
            <CardTitle>로그인 계정 만들기</CardTitle>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
              입력한 연락 이메일로 사회복지기관 계정이 생성되고, 신청 후 자동으로 로그인됩니다.
            </p>
          </div>
          <Field label="비밀번호" required hint="8자 이상 입력해 주세요.">
            <Input type="password" name="password" required minLength={8} autoComplete="new-password" />
          </Field>
          <Field label="비밀번호 확인" required>
            <Input type="password" name="passwordConfirm" required minLength={8} autoComplete="new-password" />
          </Field>
        </Card>
      ) : (
        <Notice tone="brand">
          현재 로그인된 계정으로 신청합니다. 다른 계정으로 신청하려면 로그아웃 후 다시 시도해 주세요.
        </Notice>
      )}

      <Card>
        <Checkbox
          name="agree"
          label="사회복지기관 이용 조건과 개인정보 수집·이용에 동의합니다. (필수)"
          description="심사 과정에서 채널 운영 정보와 본인 확인 자료를 요청할 수 있습니다."
        />
      </Card>

      {state.message ? <Notice tone="warning">{state.message}</Notice> : null}

      <Button type="submit" size="lg" disabled={pending}>
        {pending ? '신청 중' : '가입 신청하기'}
        <Send size={16} strokeWidth={1.7} />
      </Button>
    </form>
  );
}

function ApplyDone({ code, displayName }: { code: string; displayName?: string }) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-success-50 text-success-500">
            <CheckCircle2 size={18} strokeWidth={1.7} />
          </span>
          <div>
            <CardTitle>가입 신청이 접수되었습니다</CardTitle>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-500">
              {displayName ? `${displayName} 님의 ` : ''}신청이 심사 대기 상태로 등록되었습니다. 승인 결과는 등록한
              이메일로 안내드립니다.
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50 px-4 py-4 text-center">
          <p className="flex items-center justify-center gap-1.5 text-[12px] font-semibold text-brand-700">
            <Hash size={14} strokeWidth={1.8} />
            사회복지기관 코드
          </p>
          <p className="mt-1.5 font-mono text-[26px] font-extrabold tracking-[0.12em] text-ink-900">{code}</p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-ink-500">
            승인 후 후원자가 이 코드로 후원 페이지에 접속할 수 있습니다.
          </p>
        </div>
      </Card>

      <Card>
        <div className="mb-2 flex items-center gap-2">
          <CardTitle>다음 단계</CardTitle>
          <Badge tone="warning">심사 대기</Badge>
        </div>
        <ol className="space-y-2.5 text-[13px] leading-relaxed text-ink-700">
          <li>
            <span className="font-bold text-ink-900">1. 관리자 심사</span>
            <br />
            채널 운영 정보와 신청 내용을 확인합니다.
          </li>
          <li>
            <span className="font-bold text-ink-900">2. MO 결제 수신번호 배정</span>
            <br />
            문자 수신 번호는 관리자 승인 이후에 배정됩니다. 승인 전에는 후원 페이지가 공개되지 않고 문자후원도 접수되지
            않습니다.
          </li>
          <li>
            <span className="font-bold text-ink-900">3. 결제 연동 설정</span>
            <br />
            승인 후 사회복지기관 콘솔에서 결제 수신번호, 후원 설정, 정산 계좌를 설정합니다.
          </li>
        </ol>
      </Card>

      <Notice tone="warning" title="현재 준비 단계 안내">
        기브싸인은 준비 단계로 실제 문자 발송과 결제는 비활성화되어 있습니다. 승인 및 번호 배정 일정은 별도로
        안내드립니다.
      </Notice>

      <div className="grid grid-cols-2 gap-2">
        <LinkButton href="/studio" variant="primary" size="md" className="w-full">
          사회복지기관 콘솔
        </LinkButton>
        <LinkButton href="/support" variant="secondary" size="md" className="w-full">
          고객센터 문의
        </LinkButton>
      </div>
    </div>
  );
}
