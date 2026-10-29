'use client';

import * as React from 'react';
import { Check, CircleAlert, Loader2 } from 'lucide-react';
import { cx } from '@/components/ui';
import { Portal } from '@/components/ui/portal';

/**
 * 저장 버튼 피드백 (스튜디오 공용).
 *
 * 문제
 *  - 서버 액션은 로컬에서 100ms 안에 끝나 [저장 중] 이 눈에 보이지 않는다.
 *  - 결과 문구가 긴 폼 맨 아래에만 뜨고, 같은 문구를 다시 띄우면 화면이 전혀 바뀌지 않아
 *    두 번째 저장부터는 눌렸는지 알 수 없다.
 *
 * 해결
 *  - 저장할 때마다 시각이 바뀌는 토스트를 화면 위쪽 고정 위치에 띄운다.
 *    스크롤 위치와 무관하게 보이고, 같은 문구여도 시각이 달라 매번 새로 뜬 것이 보인다.
 *  - 버튼 자체도 [저장 중] → [저장됨] → [설정 저장] 3단계로 바뀐다.
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 */

/** 성공 토스트가 화면에 머무는 시간 */
const SUCCESS_MS = 3500;
/** 실패 토스트는 읽을 시간이 더 필요하다 */
const ERROR_MS = 7000;
/** 버튼이 [저장됨] 으로 남아 있는 시간 */
const DONE_MS = 2200;

export interface SaveFeedbackState {
  ok: boolean;
  message?: string;
}

export interface SaveFeedback {
  /** 토스트에 렌더링할 값. 없으면 표시하지 않는다. */
  toast: { ok: boolean; message: string; at: string; seq: number } | null;
  /** 저장 직후 잠깐 true. 버튼 문구를 [저장됨] 으로 바꾸는 데 쓴다. */
  justSaved: boolean;
  dismiss: () => void;
}

function nowLabel(): string {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * 서버 액션 응답이 바뀌는 순간을 잡아 토스트 상태를 만든다.
 *
 * 렌더 중 상태 조정 패턴을 쓴다. effect 로 처리하면 화면이 한 프레임 늦게 바뀌고
 * 연속 저장 시 cascading render 경고가 난다.
 */
export function useSaveFeedback(state: SaveFeedbackState, pending: boolean): SaveFeedback {
  const [toast, setToast] = React.useState<SaveFeedback['toast']>(null);
  const [justSaved, setJustSaved] = React.useState(false);
  /** 저장할 때마다 1씩 오른다. 같은 문구여도 애니메이션이 다시 시작되도록 key 로 쓴다. */
  const [seq, setSeq] = React.useState(0);

  const [prev, setPrev] = React.useState(state);
  if (prev !== state) {
    setPrev(state);
    if (state.message) {
      const next = seq + 1;
      setSeq(next);
      setToast({ ok: state.ok, message: state.message, at: nowLabel(), seq: next });
      setJustSaved(state.ok);
    }
  }

  // 저장을 다시 누르면 이전 결과는 즉시 치운다. 새 결과가 왔을 때 확실히 새로 뜬 것으로 보인다.
  const [prevPending, setPrevPending] = React.useState(pending);
  if (prevPending !== pending) {
    setPrevPending(pending);
    if (pending) {
      setToast(null);
      setJustSaved(false);
    }
  }

  const key = toast?.seq ?? 0;
  const ok = toast?.ok ?? false;
  React.useEffect(() => {
    if (!key) return;
    const timer = window.setTimeout(() => setToast(null), ok ? SUCCESS_MS : ERROR_MS);
    return () => window.clearTimeout(timer);
  }, [key, ok]);

  React.useEffect(() => {
    if (!justSaved) return;
    const timer = window.setTimeout(() => setJustSaved(false), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [justSaved]);

  return { toast, justSaved, dismiss: () => setToast(null) };
}

/**
 * 화면 위쪽에 고정으로 뜨는 저장 결과 토스트.
 * 콘솔 헤더(z-40)와 사이드바(z-30) 위에 오도록 z-[80] 을 쓴다.
 */
export function SaveToast({ feedback }: { feedback: SaveFeedback }) {
  const { toast, dismiss } = feedback;
  if (!toast) return null;

  return (
    <Portal>
    <div
      className="pointer-events-none fixed inset-x-0 top-[76px] z-[80] flex justify-center px-4"
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={dismiss}
        key={toast.seq}
        className={cx(
          'animate-banner-in pointer-events-auto flex max-w-[520px] items-center gap-2.5 rounded-full border px-4 py-2.5 text-left shadow-[0_14px_38px_rgba(23,22,26,0.22)]',
          toast.ok ? 'border-success-500/30 bg-ink-900 text-white' : 'border-danger-500/40 bg-danger-500 text-white',
        )}
      >
        <span
          className={cx(
            'grid h-6 w-6 shrink-0 place-items-center rounded-full',
            toast.ok ? 'bg-success-500/20 text-success-500' : 'bg-white/20 text-white',
          )}
        >
          {toast.ok ? <Check size={15} strokeWidth={1.7} /> : <CircleAlert size={15} strokeWidth={1.6} />}
        </span>
        <span className="min-w-0 text-[13px] font-bold leading-snug">{toast.message}</span>
        <span className="shrink-0 text-[11px] font-semibold tabular-nums text-white/55">{toast.at}</span>
      </button>
    </div>
    </Portal>
  );
}

/**
 * 저장 버튼 안쪽 내용. [저장 중] → [저장됨] → 기본 문구 순으로 바뀐다.
 * 버튼 폭이 흔들리지 않도록 아이콘 자리를 항상 차지하게 둔다.
 */
export function SaveButtonLabel({
  pending,
  justSaved,
  label,
  pendingLabel = '저장 중',
  doneLabel = '저장됨',
}: {
  pending: boolean;
  justSaved: boolean;
  label: string;
  pendingLabel?: string;
  doneLabel?: string;
}) {
  if (pending) {
    return (
      <>
        <Loader2 size={16} strokeWidth={1.6} className="animate-spin" />
        {pendingLabel}
      </>
    );
  }
  if (justSaved) {
    return (
      <>
        <Check size={16} strokeWidth={1.7} />
        {doneLabel}
      </>
    );
  }
  return <>{label}</>;
}
