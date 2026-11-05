'use client';

import * as React from 'react';
import { Sparkles, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui';
import type { AiDraftState } from '@/app/actions/ai-drafts';

type FormField = HTMLInputElement | HTMLTextAreaElement;

/**
 * "AI 초안" 버튼 — 감싸고 있는 폼의 입력칸(targets)을 초안으로 채운다. 저장은 하지 않는다.
 * 담당자가 내용을 확인·수정한 뒤 폼의 원래 저장 버튼을 눌러야 반영된다. [되돌리기]로 채우기 전 값으로 돌린다.
 *
 * available=false(LLM 공급자 mock·키 없음)이면 버튼 대신 안내 문구를 보인다.
 */
export function AiDraftButton({
  action,
  available,
  unavailableMessage,
  hintFields = [],
  extra,
  label = 'AI 초안',
}: {
  action: (input: Record<string, string>) => Promise<AiDraftState>;
  available: boolean;
  unavailableMessage?: string;
  /** 폼에서 읽어 함께 보낼 입력칸 (예: 담당자가 적은 제목) */
  hintFields?: string[];
  /** 함께 보낼 고정 값 */
  extra?: Record<string, string>;
  label?: string;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [pending, start] = React.useTransition();
  const [state, setState] = React.useState<AiDraftState | null>(null);
  const [backup, setBackup] = React.useState<Record<string, string> | null>(null);

  if (!available) {
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-400">
        <Sparkles size={16} strokeWidth={1.6} />
        {unavailableMessage ?? 'AI 공급자 연결 후 사용할 수 있습니다.'}
      </span>
    );
  }

  const field = (form: HTMLFormElement, name: string) => {
    const el = form.elements.namedItem(name);
    return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? (el as FormField) : null;
  };

  const run = () => {
    const form = ref.current?.closest('form');
    if (!form) return;
    const input: Record<string, string> = { ...(extra ?? {}) };
    for (const n of hintFields) input[n] = field(form, n)?.value ?? '';
    start(async () => {
      const r = await action(input);
      setState(r);
      if (!r.ok || !r.fields) return;
      const prev: Record<string, string> = {};
      for (const [name, value] of Object.entries(r.fields)) {
        const el = field(form, name);
        if (!el) continue;
        prev[name] = el.value;
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      setBackup(prev);
    });
  };

  const undo = () => {
    const form = ref.current?.closest('form');
    if (!form || !backup) return;
    for (const [name, value] of Object.entries(backup)) {
      const el = field(form, name);
      if (el) el.value = value;
    }
    setBackup(null);
    setState({ ok: true, message: '채우기 전 내용으로 되돌렸습니다.' });
  };

  return (
    <span ref={ref} className="inline-flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" onClick={run} disabled={pending}>
        <Sparkles size={16} strokeWidth={1.7} className="mr-1" />
        {pending ? '초안 만드는 중' : label}
      </Button>
      {backup ? (
        <Button size="sm" variant="ghost" onClick={undo}>
          <Undo2 size={16} strokeWidth={1.7} className="mr-1" />
          되돌리기
        </Button>
      ) : null}
      {state?.message ? <span className={state.ok ? 'text-[12px] text-ink-500' : 'text-[12px] text-danger-500'}>{state.message}</span> : null}
    </span>
  );
}
