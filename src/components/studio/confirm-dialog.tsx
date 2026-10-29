'use client';

import * as React from 'react';
import { Check, CircleAlert, HelpCircle, Loader2, X } from 'lucide-react';
import { Button, cx } from '@/components/ui';
import { Portal } from '@/components/ui/portal';

/**
 * 스튜디오 공용 확인 알림창.
 *
 * 브라우저 기본 confirm/alert 대신 기브싸인 디자인을 그대로 쓴다.
 * [설정 저장] · [테스트 결제 보내기] 처럼 "누른 것이 확실히 보여야 하는" 동작에 붙인다.
 *
 * 흐름
 *   버튼 클릭 → (물음) 정말 저장할까요? → [확인] → (처리 중) → (완료) 저장되었습니다 → [확인]
 *
 * 규칙
 *  - 이모지를 쓰지 않는다. 아이콘은 lucide-react 라인 아이콘만 사용한다.
 *  - 배경을 눌러도 닫히지만, 처리 중에는 닫히지 않는다.
 *  - ESC 로 닫을 수 있다(처리 중 제외).
 */

export type ConfirmPhase = 'closed' | 'ask' | 'busy' | 'done';

export interface ConfirmTone {
  /** 확인 버튼 색. 되돌릴 수 없는 동작이면 danger 를 쓴다. */
  variant?: 'primary' | 'danger' | 'accent';
}

export function ConfirmDialog({
  phase,
  title,
  description,
  confirmLabel = '확인',
  cancelLabel = '취소',
  busyLabel = '처리 중',
  doneOk,
  doneTitle,
  doneDescription,
  variant = 'primary',
  onConfirm,
  onClose,
}: ConfirmTone & {
  phase: ConfirmPhase;
  /** 물음 단계 제목 */
  title: string;
  /** 물음 단계 설명 (선택) */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  /** 완료 단계가 성공인지 실패인지 */
  doneOk?: boolean;
  /** 완료 단계 제목 (보통 서버가 준 문구) */
  doneTitle?: string;
  doneDescription?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const open = phase !== 'closed';
  const busy = phase === 'busy';
  const done = phase === 'done';

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  // 열려 있는 동안 배경 스크롤을 막는다.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const headTone = done ? (doneOk ? 'success' : 'danger') : 'brand';
  const HeadIcon = done ? (doneOk ? Check : CircleAlert) : HelpCircle;

  return (
    <Portal>
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={done ? doneTitle ?? '완료' : title}
    >
      <button
        type="button"
        aria-label="닫기"
        tabIndex={-1}
        onClick={() => {
          if (!busy) onClose();
        }}
        className="absolute inset-0 cursor-default bg-ink-900/55 backdrop-blur-[2px]"
      />

      <div className="animate-banner-in relative w-full max-w-[420px] overflow-hidden rounded-[22px] bg-white shadow-[0_28px_70px_rgba(23,22,26,0.32)]">
        {!busy ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full border border-ink-200 text-ink-400 transition-colors hover:bg-ink-50"
          >
            <X size={16} strokeWidth={1.8} />
          </button>
        ) : null}

        <div className="px-6 pb-5 pt-7 text-center">
          <span
            className={cx(
              'mx-auto grid h-14 w-14 place-items-center rounded-2xl border',
              headTone === 'success' && 'border-success-500/25 bg-success-500/10 text-success-500',
              headTone === 'danger' && 'border-danger-500/25 bg-danger-500/10 text-danger-500',
              headTone === 'brand' && 'border-brand-200 bg-brand-50 text-brand-700',
            )}
          >
            {busy ? (
              <Loader2 size={26} strokeWidth={1.9} className="animate-spin" />
            ) : (
              <HeadIcon size={26} strokeWidth={1.9} />
            )}
          </span>

          <p className="mt-4 text-[17px] font-black tracking-[-0.02em] text-ink-900">
            {busy ? busyLabel : done ? doneTitle ?? '완료되었습니다' : title}
          </p>
          {(busy ? null : done ? doneDescription : description) ? (
            <p className="mx-auto mt-2 max-w-[320px] text-[13px] leading-relaxed text-ink-500">
              {done ? doneDescription : description}
            </p>
          ) : null}
        </div>

        <div className="flex gap-2 border-t border-ink-100 px-5 py-4">
          {done ? (
            <Button type="button" variant="primary" size="md" className="flex-1 justify-center" onClick={onClose}>
              확인
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="secondary"
                size="md"
                className="flex-1 justify-center"
                onClick={onClose}
                disabled={busy}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                variant={variant}
                size="md"
                className="flex-1 justify-center"
                onClick={onConfirm}
                disabled={busy}
                aria-busy={busy}
              >
                {busy ? (
                  <>
                    <Loader2 size={16} strokeWidth={1.6} className="animate-spin" />
                    {busyLabel}
                  </>
                ) : (
                  confirmLabel
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
    </Portal>
  );
}

// ---------------------------------------------------------------------------

export interface ConfirmSubmit {
  phase: ConfirmPhase;
  /** form 의 onSubmit 에 그대로 연결한다. 확인 전에는 제출을 막는다. */
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  /** 알림창의 [확인] 에 연결한다. 여기서 실제 제출이 일어난다. */
  confirm: () => void;
  close: () => void;
}

/**
 * "확인을 눌러야 실제로 제출되는" 폼을 만든다.
 *
 * 제출 → 서버 액션 응답까지를 한 알림창 안에서 물음 → 처리 중 → 완료 3단계로 보여 준다.
 * 서버 액션 응답(state)이 바뀌는 순간을 렌더 중에 잡는다. effect 로 처리하면 화면이 한 프레임
 * 늦게 바뀌고 연속 제출에서 cascading render 경고가 난다.
 */
export function useConfirmSubmit(
  formRef: React.RefObject<HTMLFormElement | null>,
  state: unknown,
  pending: boolean,
): ConfirmSubmit {
  const [phase, setPhase] = React.useState<ConfirmPhase>('closed');
  /** [확인] 으로 시작한 제출인지. true 일 때만 실제 제출을 통과시킨다. (이벤트 핸들러에서만 쓴다) */
  const armed = React.useRef(false);
  /** 이번 알림창에서 제출까지 진행했는지. 응답을 완료 화면으로 보여줄지 판단한다. */
  const [awaiting, setAwaiting] = React.useState(false);

  const [prevState, setPrevState] = React.useState(state);
  if (prevState !== state) {
    setPrevState(state);
    if (awaiting) {
      setAwaiting(false);
      setPhase('done');
    }
  }

  const [prevPending, setPrevPending] = React.useState(pending);
  if (prevPending !== pending) {
    setPrevPending(pending);
    if (pending && awaiting) setPhase('busy');
  }

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (armed.current) {
      armed.current = false;
      return; // [확인] 으로 시작한 제출은 그대로 통과시킨다
    }
    e.preventDefault();
    setPhase('ask');
  };

  const confirm = () => {
    armed.current = true;
    setAwaiting(true);
    setPhase('busy');
    formRef.current?.requestSubmit();
  };

  const close = () => {
    setAwaiting(false);
    setPhase('closed');
  };

  return { phase, onSubmit, confirm, close };
}
