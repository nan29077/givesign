'use client';

import * as React from 'react';
import { ChevronRight, ShieldCheck } from 'lucide-react';
import { Button, Card, Checkbox, Input, Notice, cx } from '@/components/ui';
import { startRegistrationAction } from '@/app/actions/registration';
import { displayPayerName, checkPayerName, PAYER_NAME_MAX } from '@/lib/payer-name';
import { SNS_PLATFORMS, type SnsPlatform, SnsPlatformSelector } from '@/components/shared/sns-platform-selector';

/**
 * 이용 동의 + 계좌 등록 시작.
 * - 필수 항목을 모두 동의하기 전에는 제출할 수 없다.
 * - 마케팅(선택) 동의는 필수 항목과 분리해 표시한다.
 * - 표시 이름은 선택 입력이다. 비워두면 번호 끝 4자리로 만든 기본 이름이 쓰인다.
 */

export interface TermsItem {
  id: string;
  type: string;
  title: string;
  content: string;
  required: boolean;
  version: string;
}

export function RegisterForm({
  token,
  terms,
  defaultName,
}: {
  token: string;
  terms: TermsItem[];
  /** 닉네임을 비워둘 경우 쓰이는 이름 (예: 후원자5678) */
  defaultName: string;
}) {
  const required = terms.filter((t) => t.required);
  const optional = terms.filter((t) => !t.required);

  const [agreed, setAgreed] = React.useState<Record<string, boolean>>({});
  const [nickname, setNickname] = React.useState('');
  const [snsPlatform, setSnsPlatform] = React.useState<SnsPlatform | ''>('');
  const [error, setError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  const nameCheck = checkPayerName(nickname);
  // 입력 도중(1글자)에는 빨간 경고를 띄우지 않는다. 지우고 다시 쓰는 중일 수 있다.
  const nameError = nickname.trim().length > 1 && !nameCheck.ok ? nameCheck.message : null;

  const allRequiredAgreed = required.length > 0 && required.every((t) => agreed[t.type]);
  const allAgreed = terms.every((t) => agreed[t.type]);

  function toggle(type: string, value: boolean) {
    setAgreed((prev) => ({ ...prev, [type]: value }));
  }

  function toggleAll(value: boolean) {
    const next: Record<string, boolean> = {};
    for (const t of terms) next[t.type] = value;
    setAgreed(next);
  }

  function submit() {
    if (!allRequiredAgreed || pending) return;
    if (!nameCheck.ok) {
      setError(nameCheck.message ?? '닉네임을 다시 입력해 주세요.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await startRegistrationAction(
        token,
        terms.map((t) => ({ type: t.type as never, agreed: Boolean(agreed[t.type]) })),
        'ACCOUNT',
        nameCheck.value,
        snsPlatform || undefined,
      );
      // 성공하면 결제창으로 리다이렉트되므로 아래 코드는 실행되지 않는다.
      if (res && res.ok === false) setError(res.message);
    });
  }

  // 후원 내역에서는 자동 생성된 기본 이름을 끝 4자리로 줄여 부른다.
  // 미리보기도 같은 함수를 거쳐야 화면에서 약속한 이름과 실제 기록이 어긋나지 않는다.
  const preview = displayPayerName(
    nameCheck.ok && nameCheck.value.length > 0 ? nameCheck.value : defaultName,
  );

  return (
    <div className="space-y-3">
      {/*
        표시 이름 (선택).
        후원자는 번호만 남기므로, 설정하지 않으면 사회복지기관 화면과 후원 내역에
        "후원자5678" 처럼 표시된다. 결과를 미리 보여줘야 그냥 넘기지 않는다.
      */}
      <Card>
        <p className="text-[14.5px] font-bold text-ink-900">후원 내역에 표시될 이름 (선택)</p>
        <p className="mt-1 text-[12px] leading-relaxed text-ink-500">
          평소 쓰는 닉네임을 적어두면 사회복지기관이 누구의 결제인지 알아볼 수 있습니다.
        </p>
        <div className="mt-2.5">
          <SnsPlatformSelector value={snsPlatform} onChange={setSnsPlatform} />
        </div>
        <div className="mt-2">
          <Input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            maxLength={PAYER_NAME_MAX + 4}
            placeholder={snsPlatform ? `${SNS_PLATFORMS.find(p => p.value === snsPlatform)?.label ?? ''} 닉네임` : '예: 밤톨이'}
            aria-label="후원 내역에 표시될 이름"
            aria-invalid={Boolean(nameError)}
          />
        </div>
        {nameError ? (
          <p className="mt-1.5 text-[12px] font-semibold text-danger-500">{nameError}</p>
        ) : (
          <p className="mt-1.5 text-[12px] text-ink-400">
            {PAYER_NAME_MAX}자 이내. 비워두면 번호 끝 4자리(
            <b className="font-bold text-ink-700">{displayPayerName(defaultName)}</b>)로 표시됩니다.
          </p>
        )}
        <div className="mt-2.5 rounded-xl bg-brand-50 px-3.5 py-2.5">
          <p className="text-[11px] font-bold text-brand-700">후원 내역에 이렇게 표시됩니다</p>
          <p className="mt-0.5 text-[13px] font-semibold text-ink-900">
            {preview}님이 3,000원을 후원했습니다
          </p>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
          닉네임은 나중에 마이페이지에서 언제든지 바꿀 수 있습니다.
        </p>
      </Card>

      <Card>
        <button
          type="button"
          onClick={() => toggleAll(!allAgreed)}
          className={cx(
            'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
            allAgreed ? 'border-brand-300 bg-brand-50' : 'border-ink-200 bg-white',
          )}
        >
          <span
            className={cx(
              'grid h-6 w-6 shrink-0 place-items-center rounded-md border',
              allAgreed ? 'border-brand-500 bg-brand-500 text-ink-900' : 'border-ink-300 text-transparent',
            )}
            aria-hidden
          >
            <ShieldCheck size={16} strokeWidth={1.7} />
          </span>
          <span>
            <span className="block text-[14.5px] font-bold text-ink-900">전체 동의</span>
            <span className="block text-[12px] text-ink-400">선택 항목을 포함해 모두 동의합니다.</span>
          </span>
        </button>

        <div className="mt-2 divide-y divide-ink-100">
          {required.map((t) => (
            <TermsRow key={t.id} item={t} checked={Boolean(agreed[t.type])} onChange={(v) => toggle(t.type, v)} />
          ))}
        </div>

        {optional.length > 0 ? (
          <div className="mt-3 rounded-xl bg-ink-50 px-3 py-1">
            <p className="pt-2 text-[12px] font-semibold text-ink-500">선택 동의 (동의하지 않아도 이용할 수 있습니다)</p>
            <div className="divide-y divide-ink-100">
              {optional.map((t) => (
                <TermsRow key={t.id} item={t} checked={Boolean(agreed[t.type])} onChange={(v) => toggle(t.type, v)} />
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {error ? <Notice tone="danger" title="등록을 시작할 수 없습니다">{error}</Notice> : null}

      <Button size="lg" onClick={submit} disabled={!allRequiredAgreed || pending}>
        {pending ? '결제창으로 이동 중' : '동의하고 계좌 등록하기'}
        <ChevronRight size={17} strokeWidth={1.8} />
      </Button>
      <p className="text-center text-[12px] leading-relaxed text-ink-400">
        다음 화면에서 본인 명의 계좌 인증과 출금이체 등록이 진행됩니다.
      </p>
    </div>
  );
}

function TermsRow({
  item,
  checked,
  onChange,
}: {
  item: TermsItem;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="py-1">
      <div className="flex items-start justify-between gap-2">
        <Checkbox
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          label={
            <span>
              <span className={cx('mr-1 text-[12px] font-bold', item.required ? 'text-accent-500' : 'text-ink-400')}>
                {item.required ? '[필수]' : '[선택]'}
              </span>
              {item.title}
            </span>
          }
        />
      </div>
      <details className="ml-8 pb-2">
        <summary className="cursor-pointer list-none text-[12px] font-semibold text-brand-700">약관 내용 보기</summary>
        <p className="mt-1.5 max-h-40 overflow-y-auto rounded-lg bg-ink-50 px-3 py-2 text-[12px] leading-relaxed text-ink-500">
          {item.content}
        </p>
        <p className="mt-1 text-[11px] text-ink-300">버전 {item.version}</p>
      </details>
    </div>
  );
}
