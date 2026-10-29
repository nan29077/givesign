'use client';

import * as React from 'react';
import { Download, Loader2, LockKeyhole } from 'lucide-react';
import { prepareHometaxExportAction, type HometaxExportGateState } from '@/app/actions/fundraising';

/**
 * 홈택스 제출 명세 내려받기.
 * 주민등록번호 원문이 든 파일이라 비밀번호를 다시 확인하고 사유를 받은 뒤 1회용 링크로 내려받는다.
 */
export function HometaxExportForm({ year }: { year: number }) {
  const [open, setOpen] = React.useState(false);
  const [state, action, pending] = React.useActionState<HometaxExportGateState, FormData>(prepareHometaxExportAction, { ok: false });
  const formRef = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    if (state.ok && state.url) {
      window.location.assign(state.url);
      // 비밀번호 입력값을 화면에 남기지 않는다.
      formRef.current?.reset();
    }
  }, [state]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-11 items-center gap-2 rounded-xl bg-ink-900 px-4 text-[14px] font-extrabold text-white"
      >
        <Download size={16} strokeWidth={1.7} /> {year}년 명세 CSV 내려받기
      </button>
    );
  }

  return (
    <form ref={formRef} action={action} className="w-full max-w-md space-y-2.5 rounded-xl border border-ink-100 p-3.5">
      <input type="hidden" name="year" value={year} />
      <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-800">
        <LockKeyhole size={16} strokeWidth={1.7} /> 주민등록번호가 포함된 파일입니다. 본인 확인 후 내려받습니다.
      </p>
      <label className="block text-[12px] font-bold text-ink-500">
        로그인 비밀번호
        <input
          type="password"
          name="password"
          required
          autoComplete="current-password"
          className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-3 text-[14px] text-ink-900"
        />
      </label>
      <label className="block text-[12px] font-bold text-ink-500">
        내려받는 사유
        <input
          type="text"
          name="reason"
          required
          minLength={4}
          maxLength={100}
          placeholder={`예: ${year}년 연말정산 간소화 자료 제출`}
          className="mt-1 h-10 w-full rounded-lg border border-ink-200 px-3 text-[14px] text-ink-900"
        />
      </label>
      {state.message && !state.ok ? <p className="text-[12.5px] font-semibold text-danger-500">{state.message}</p> : null}
      {state.ok ? <p className="text-[12.5px] font-semibold text-ink-600">확인되었습니다. 내려받기가 곧 시작됩니다. 다시 받으려면 비밀번호를 다시 입력해 주세요.</p> : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-ink-900 px-3.5 text-[13px] font-extrabold text-white disabled:opacity-60"
        >
          {pending ? <Loader2 size={16} strokeWidth={1.7} className="animate-spin" /> : <Download size={16} strokeWidth={1.7} />}
          확인하고 내려받기
        </button>
        <button type="button" onClick={() => setOpen(false)} className="h-10 rounded-lg px-3 text-[13px] font-bold text-ink-500">
          취소
        </button>
      </div>
      <p className="text-[11.5px] text-ink-400">확인 링크는 5분 동안 한 번만 쓸 수 있고, 하루 5번까지 만들 수 있습니다.</p>
    </form>
  );
}
