'use client';

import * as React from 'react';
import { Sparkles } from 'lucide-react';
import { Button, Card, Field, Input, Notice } from '@/components/ui';
import { updatePayerNickname, type PayerActionState } from '@/app/actions/payer';
import { displayPayerName, checkPayerName, PAYER_NAME_MAX } from '@/lib/payer-name';

const initial: PayerActionState = { ok: false };

/**
 * 후원 내역에 표시될 이름 수정 폼.
 *
 * 후원자는 휴대폰 번호만 남기므로, 닉네임을 정하지 않으면 사회복지기관 화면과
 * 후원 내역에 "후원자5678" 처럼 표시된다. 그래서 결과를 항상 미리 보여준다.
 */
export function NicknameForm({
  current,
  defaultName,
}: {
  /** 저장된 닉네임. 설정하지 않았으면 null */
  current: string | null;
  /** 닉네임을 비웠을 때 쓰이는 이름 (예: 후원자5678) */
  defaultName: string;
}) {
  const [state, action, pending] = React.useActionState(updatePayerNickname, initial);
  const [value, setValue] = React.useState(current ?? '');

  const check = checkPayerName(value);
  const error = value.trim().length > 1 && !check.ok ? check.message : null;
  // 실제 송출과 같은 규칙을 거친다(자동 생성된 기본 이름은 끝 4자리로 불린다).
  const preview = displayPayerName(check.ok && check.value.length > 0 ? check.value : defaultName);
  const usingDefault = !current;

  return (
    <Card>
      <form action={action} className="space-y-3">
        <Field
          label="닉네임"
          hint={`${PAYER_NAME_MAX}자 이내. 비워두면 번호 끝 4자리(${displayPayerName(defaultName)})로 표시됩니다.`}
        >
          <Input
            name="nickname"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={PAYER_NAME_MAX + 4}
            placeholder="예: 밤톨이"
            aria-invalid={Boolean(error)}
          />
        </Field>

        {error ? <p className="text-[12px] font-semibold text-danger-500">{error}</p> : null}

        <div className="rounded-xl bg-brand-50 px-3.5 py-3">
          <p className="flex items-center gap-1.5 text-[11.5px] font-bold text-brand-700">
            <Sparkles size={13} strokeWidth={1.6} />
            후원 내역에 이렇게 표시됩니다
          </p>
          <p className="mt-1 text-[14px] font-bold text-ink-900">
            {preview}님이 3,000원을 결제하셨습니다
          </p>
          {usingDefault ? (
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-500">
              지금은 휴대폰 번호 끝 4자리로 표시되고 있습니다. 닉네임을 정하면 사회복지기관이 누가
              보냈는지 알아볼 수 있습니다.
            </p>
          ) : null}
        </div>

        <Button type="submit" size="sm" variant="secondary" disabled={pending || Boolean(error)}>
          {pending ? '저장 중' : '닉네임 저장'}
        </Button>

        {state.message ? (
          <Notice tone={state.ok ? 'success' : 'danger'} title={state.ok ? '저장했습니다' : '저장하지 못했습니다'}>
            {state.message}
          </Notice>
        ) : null}

        <p className="text-[11.5px] leading-relaxed text-ink-400">
          이미 접수된 결제는 그때 표시된 이름이 그대로 남습니다. 바꾼 닉네임은 다음 결제부터 적용됩니다.
        </p>
      </form>
    </Card>
  );
}
