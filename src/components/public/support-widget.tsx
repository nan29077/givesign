'use client';

import * as React from 'react';
import Link from 'next/link';
import { MessageCircleQuestion, X, ChevronDown, Send, RotateCw } from 'lucide-react';
import { cx, Notice } from '@/components/ui';
import { sendInquiryMessage, type InquiryActionState } from '@/app/actions/inquiry';

/**
 * 우측 하단 플로팅 문의 위젯.
 *
 * - PC(lg+): 우측 메뉴바 바로 아래에 세로 정렬해 버튼을 고정하고, 패널은 버튼 위로 열린다.
 * - 모바일·태블릿(lg 미만): 하단 탭바를 가리지 않도록 탭바 위쪽에 버튼을 띄운다.
 * - 탭 1) 자주 묻는 질문: 상위 FAQ 아코디언 + 전체 보기 링크
 * - 탭 2) 1:1 문의: 채팅형 문의. 비로그인도 가능(게스트 쿠키), 답변은 15초 간격 폴링으로 수신.
 */

export interface WidgetFaq {
  id: string;
  title: string;
  body: string;
}

interface ThreadMessage {
  id: string;
  sender: 'USER' | 'ADMIN';
  body: string;
  at: string;
}

const initialState: InquiryActionState = { ok: false };

export function SupportWidget({
  faqs,
  loggedIn,
  hasThread = false,
}: {
  faqs: WidgetFaq[];
  loggedIn: boolean;
  /** 이 방문자에게 문의 스레드가 있을 수 있는지 (세션 또는 게스트 쿠키 보유) */
  hasThread?: boolean;
}) {
  const [open, setOpen] = React.useState(false);

  // 키보드만 쓰는 후원자는 ESC 로 닫을 수 있어야 하고, 열릴 때 패널 안으로 포커스가 들어가야 한다.
  const panelRef = React.useRef<HTMLDivElement>(null);
  const restoreFocusTo = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!open) {
      restoreFocusTo.current?.focus?.();
      restoreFocusTo.current = null;
      return;
    }
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    const target = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button, [href], [tabindex]:not([tabindex="-1"])',
    );
    target?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const [tab, setTab] = React.useState<'faq' | 'chat'>('faq');
  const [messages, setMessages] = React.useState<ThreadMessage[]>([]);
  const [status, setStatus] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [openFaq, setOpenFaq] = React.useState<string | null>(null);
  /** 아직 확인하지 않은 관리자 답변 수. 문의 창을 열지 않아도 배지로 알 수 있게 한다. */
  const [unread, setUnread] = React.useState(0);
  const listRef = React.useRef<HTMLDivElement>(null);

  const [state, formAction, pending] = React.useActionState(sendInquiryMessage, initialState);
  const formRef = React.useRef<HTMLFormElement>(null);

  const loadThread = React.useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/inquiry', { cache: 'no-store' });
      if (!res.ok) return;
      const data = (await res.json()) as {
        exists: boolean;
        status: string | null;
        unread?: number;
        messages: ThreadMessage[];
      };
      setMessages(data.messages);
      setStatus(data.status);
      // 창이 열려 있으면 방금 읽은 것이므로 배지를 지운다.
      setUnread(open && tab === 'chat' ? 0 : (data.unread ?? 0));
    } catch {
      /* 네트워크 오류는 다음 폴링에서 회복 */
    } finally {
      setLoading(false);
    }
  }, [open, tab]);

  // 채팅 탭이 열려 있는 동안 15초 간격 폴링
  React.useEffect(() => {
    if (!open || tab !== 'chat') return;
    const first = window.setTimeout(loadThread, 0);
    const timer = window.setInterval(loadThread, 15000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [open, tab, loadThread]);

  // 창이 닫혀 있어도 답변 도착 여부는 알려야 한다.
  // 문의 이력이 있는 방문자만, 최초 1회 + 5분 간격으로 확인한다.
  React.useEffect(() => {
    if (!hasThread) return;
    if (open && tab === 'chat') return;
    const first = window.setTimeout(loadThread, 1500);
    const timer = window.setInterval(loadThread, 300_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [open, tab, hasThread, loadThread]);

  // 전송 성공 시 폼 비우고 스레드 새로고침 (ref 접근이 있으므로 effect 로 처리)
  React.useEffect(() => {
    if (!state.ok) return;
    formRef.current?.reset();
    const t = window.setTimeout(loadThread, 0);
    return () => window.clearTimeout(t);
  }, [state, loadThread]);

  // 새 메시지가 오면 맨 아래로 스크롤
  React.useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, open, tab]);

  const needGuestFields = !loggedIn && messages.length === 0;

  return (
    <>
      {/* 플로팅 버튼
          - lg 미만(모바일·태블릿): 하단 탭바(약 64px + safe-area)를 가리지 않게 그 위에 배치
          - lg 이상(PC): 공개 레이아웃(824px)의 우측 메뉴바 중앙선에 정렬 */}
      <div
        className={cx(
          'pointer-events-none fixed inset-x-0 z-50',
          'bottom-[calc(76px+env(safe-area-inset-bottom))] lg:bottom-6',
        )}
      >
        <div className="mx-auto flex w-full max-w-[824px] justify-end px-4 lg:px-0">
          <div className="flex justify-end lg:w-[96px] lg:justify-center">
          <button
            type="button"
            aria-label={open ? '문의 창 닫기' : '문의하기'}
            aria-expanded={open}
            onClick={() => {
              // 답변이 와 있으면 곧바로 채팅 탭을 연다.
              if (!open && unread > 0) setTab('chat');
              setOpen((v) => !v);
            }}
            className="pointer-events-auto relative flex h-[52px] w-[52px] items-center justify-center rounded-full bg-ink-900 text-brand-400 shadow-[0_10px_28px_rgba(23,22,26,0.35)] transition-transform hover:-translate-y-0.5 active:translate-y-0"
          >
            {open ? <X size={22} strokeWidth={1.8} /> : <MessageCircleQuestion size={24} strokeWidth={1.8} />}
            {!open && unread > 0 ? (
              <span
                aria-label={`읽지 않은 답변 ${unread}건`}
                className="absolute -right-0.5 -top-0.5 grid h-[20px] min-w-[20px] place-items-center rounded-full bg-[#e5484d] px-1 text-[11px] font-extrabold text-white shadow-[0_2px_6px_rgba(0,0,0,0.25)]"
              >
                {unread > 9 ? '9+' : unread}
              </span>
            ) : null}
          </button>
          </div>
        </div>
      </div>

      {/* 패널 */}
      {open ? (
        <div
          className={cx(
            'pointer-events-none fixed inset-x-0 z-50',
            'bottom-[calc(140px+env(safe-area-inset-bottom))] lg:bottom-[88px]',
          )}
        >
          <div className="mx-auto flex w-full max-w-[824px] justify-end px-3 lg:px-0">
        <div
          ref={panelRef}
          role="dialog"
          aria-label="고객 문의"
          className={cx(
            'pointer-events-auto flex w-full flex-col overflow-hidden rounded-[22px] border border-ink-100 bg-white shadow-[0_30px_80px_rgba(23,22,26,0.28)]',
            'max-h-[62dvh]',
            'lg:h-[560px] lg:max-h-[calc(100dvh-150px)] lg:w-[370px]',
          )}
        >
          {/* 헤더 */}
          <div className="flex items-center justify-between bg-ink-900 px-4 py-3.5">
            <div>
              <p className="text-[14px] font-black tracking-[-0.02em] text-white">무엇을 도와드릴까요?</p>
              <p className="mt-0.5 text-[11px] text-white/60">자주 묻는 질문을 확인하거나 1:1 문의를 남겨주세요.</p>
            </div>
          </div>

          {/* 탭 */}
          <div className="grid grid-cols-2 border-b border-ink-100">
            {(
              [
                { key: 'faq', label: '자주 묻는 질문' },
                { key: 'chat', label: '1:1 문의' },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cx(
                  'h-11 text-[13px] font-bold transition-colors',
                  tab === t.key ? 'border-b-2 border-brand-500 text-ink-900' : 'text-ink-400 hover:text-ink-700',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* FAQ 탭 */}
          {tab === 'faq' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {faqs.length === 0 ? (
                <div className="rounded-xl bg-ink-50 px-3.5 py-4 text-[12.5px] leading-relaxed text-ink-600">
                  기브싸인은 문자 한 통으로 사회복지기관에 후원할 수 있는 서비스입니다. 이용 문의와 도입 상담은 1:1 문의로 남겨주세요.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {faqs.map((f) => {
                    const opened = openFaq === f.id;
                    return (
                      <div key={f.id} className="rounded-xl border border-ink-100">
                        <button
                          type="button"
                          onClick={() => setOpenFaq(opened ? null : f.id)}
                          aria-expanded={opened}
                          className="flex w-full items-center justify-between gap-2 px-3.5 py-3 text-left"
                        >
                          <span className="text-[13px] font-bold text-ink-900">{f.title}</span>
                          <ChevronDown
                            size={15}
                            strokeWidth={1.8}
                            className={cx('shrink-0 text-ink-300 transition-transform', opened && 'rotate-180')}
                          />
                        </button>
                        {opened ? (
                          <p className="border-t border-ink-100 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-600">
                            {f.body}
                          </p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Link
                  href="/faq"
                  onClick={() => setOpen(false)}
                  className="flex h-10 items-center justify-center rounded-xl border border-ink-200 text-[12.5px] font-bold text-ink-700 hover:bg-ink-50"
                >
                  FAQ 전체 보기
                </Link>
                <button
                  type="button"
                  onClick={() => setTab('chat')}
                  className="flex h-10 items-center justify-center rounded-xl bg-brand-400 text-[12.5px] font-extrabold text-ink-900 hover:bg-brand-500"
                >
                  1:1 문의하기
                </button>
              </div>
            </div>
          ) : null}

          {/* 채팅 탭 */}
          {tab === 'chat' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
                {messages.length === 0 ? (
                  <div className="rounded-xl bg-ink-50 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-600">
                    안녕하세요, 기브싸인입니다. 궁금한 점을 남겨주시면 순차적으로 답변해 드립니다.
                    {loggedIn ? '' : ' 비회원도 문의할 수 있으며, 답변은 이 창에서 확인할 수 있습니다.'}
                  </div>
                ) : (
                  messages.map((m) => (
                    <div key={m.id} className={cx('flex', m.sender === 'USER' ? 'justify-end' : 'justify-start')}>
                      <div
                        className={cx(
                          'max-w-[82%] rounded-2xl px-3 py-2',
                          m.sender === 'USER' ? 'bg-brand-400 text-ink-900' : 'bg-ink-50 text-ink-900',
                        )}
                      >
                        <p className="whitespace-pre-line break-words text-[12.5px] leading-relaxed">{m.body}</p>
                        <p className={cx('mt-0.5 text-[10px] tabular-nums', m.sender === 'USER' ? 'text-ink-900/50' : 'text-ink-400')}>
                          {/* 서버 렌더 시 컨테이너 기본 타임존(AWS 는 UTC)으로 찍혀 9시간 어긋나고
                              하이드레이션 경고가 나므로, 표시 기준을 KST 로 고정한다. */}
                          {new Date(m.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })}
                        </p>
                      </div>
                    </div>
                  ))
                )}
                {status === 'ANSWERED' ? (
                  <p className="text-center text-[11px] text-ink-400">답변이 등록되었습니다. 추가 문의가 있으면 이어서 보내주세요.</p>
                ) : null}
                {status === 'CLOSED' ? (
                  <p className="text-center text-[11px] text-ink-400">종결된 문의입니다. 새 메시지를 보내면 다시 접수됩니다.</p>
                ) : null}
              </div>

              <form ref={formRef} action={formAction} className="border-t border-ink-100 p-3">
                {needGuestFields ? (
                  <div className="mb-2 grid grid-cols-2 gap-2">
                    <input
                      name="guestName"
                      placeholder="이름 (선택)"
                      maxLength={30}
                      className="h-9 rounded-lg border border-ink-200 px-2.5 text-[12px] outline-none focus:border-brand-400"
                    />
                    <input
                      name="contact"
                      placeholder="회신 연락처 (선택)"
                      maxLength={80}
                      className="h-9 rounded-lg border border-ink-200 px-2.5 text-[12px] outline-none focus:border-brand-400"
                    />
                  </div>
                ) : null}
                <div className="flex items-end gap-2">
                  <textarea
                    name="body"
                    rows={2}
                    maxLength={1000}
                    required
                    placeholder="결제·후원 이용 문의 또는 GiveSign 도입 상담 내용을 입력해 주세요"
                    className="min-h-[44px] flex-1 resize-none rounded-xl border border-ink-200 px-3 py-2.5 text-[13px] leading-relaxed outline-none focus:border-brand-400"
                  />
                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      aria-label="새로고침"
                      onClick={() => loadThread()}
                      className="grid h-9 w-11 place-items-center rounded-lg border border-ink-200 text-ink-400 hover:text-ink-900"
                    >
                      <RotateCw size={14} strokeWidth={1.8} className={loading ? 'animate-spin' : undefined} />
                    </button>
                    <button
                      type="submit"
                      disabled={pending}
                      aria-label="보내기"
                      className="grid h-9 w-11 place-items-center rounded-lg bg-brand-400 text-ink-900 hover:bg-brand-500 disabled:opacity-60"
                    >
                      <Send size={15} strokeWidth={1.8} />
                    </button>
                  </div>
                </div>
                {state.message && !state.ok ? (
                  <div className="mt-2">
                    <Notice tone="warning">{state.message}</Notice>
                  </div>
                ) : null}
              </form>
            </div>
          ) : null}
        </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
