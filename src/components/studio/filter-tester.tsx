'use client';

import * as React from 'react';
import { testBannedWordsAction } from '@/app/actions/studio';
import { Notice } from '@/components/ui';

/**
 * 금칙어 미리보기.
 * 문장을 넣으면 내 금칙어 + 전역 금칙어를 적용한 결과(통과/마스킹/차단)를 보여준다.
 * 실제 결제는 생성되지 않는다.
 */
export function FilterTester() {
  const [state, action, pending] = React.useActionState(testBannedWordsAction, { ok: false });

  return (
    <div>
      <form action={action} className="flex flex-col gap-2 sm:flex-row">
        <input
          name="sample"
          placeholder="테스트할 문장을 입력하세요 (예: 늘 응원합니다)"
          maxLength={200}
          className="h-11 flex-1 rounded-xl border border-ink-200 px-3.5 text-[14px] outline-none focus:border-brand-400"
        />
        <button
          type="submit"
          disabled={pending}
          className="h-11 shrink-0 rounded-xl bg-ink-900 px-4 text-[13px] font-bold text-white disabled:opacity-60"
        >
          {pending ? '확인 중…' : '미리보기'}
        </button>
      </form>

      {state.message ? (
        <div className="mt-2.5">
          <Notice tone={state.ok ? 'brand' : 'warning'}>{state.message}</Notice>
        </div>
      ) : null}
    </div>
  );
}
