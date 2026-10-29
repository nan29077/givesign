import * as React from 'react';
import Link from 'next/link';
import { Badge, Button, cx } from '@/components/ui';
import type { Tone } from '@/lib/labels';

/**
 * 관리자 화면용 고밀도 컨트롤.
 * 공용 UI(Input/Select)는 모바일 기준으로 커서, 표가 많은 관리자 화면에서는 작은 크기를 따로 쓴다.
 * 서버 컴포넌트와 클라이언트 컴포넌트 양쪽에서 사용할 수 있도록 순수 프리미티브만 둔다.
 */

const controlBase =
  'w-full rounded-lg border border-ink-200 bg-white text-[13px] text-ink-900 placeholder:text-ink-300 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-ink-50 disabled:text-ink-400';

export function AdminInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(controlBase, 'h-9 px-2.5', className)} {...props} />;
}

export function AdminSelect({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(controlBase, 'h-9 px-2', className)} {...props} />;
}

export function AdminTextarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(controlBase, 'px-2.5 py-2 leading-relaxed', className)} {...props} />;
}

export function AdminField({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-[11px] font-semibold text-ink-400">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] leading-relaxed text-ink-400">{hint}</span> : null}
    </label>
  );
}

/** GET 방식 필터 바. 서버 컴포넌트에서 그대로 사용한다. */
export function FilterBar({
  action,
  children,
  resetHref,
}: {
  action: string;
  children: React.ReactNode;
  resetHref?: string;
}) {
  return (
    <form
      method="get"
      action={action}
      className="mb-4 flex flex-wrap items-end gap-2 rounded-2xl border border-ink-100 bg-white p-3"
    >
      {children}
      <div className="flex items-center gap-2 pb-0.5">
        <Button type="submit" size="sm" variant="primary">
          조회
        </Button>
        {resetHref ? (
          <Link
            href={resetHref}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-500 hover:bg-ink-50"
          >
            초기화
          </Link>
        ) : null}
      </div>
    </form>
  );
}

/** 목록 페이지네이션. 현재 필터를 유지한 채 page 만 교체한다. */
export function Pager({
  basePath,
  params,
  page,
  lastPage,
  total,
  pageParam = 'page',
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  page: number;
  lastPage: number;
  total: number;
  /** 한 화면에 목록이 둘 이상일 때 페이지 파라미터 이름을 분리한다. */
  pageParam?: string;
}) {
  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '' && k !== pageParam) qs.set(k, v);
    }
    qs.set(pageParam, String(p));
    return `${basePath}?${qs.toString()}`;
  };

  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <span className="text-[12px] text-ink-400">
        전체 {total.toLocaleString('ko-KR')}건 · {page} / {lastPage} 페이지
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={href(page - 1)}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700 hover:bg-ink-50"
          >
            이전
          </Link>
        ) : null}
        {page < lastPage ? (
          <Link
            href={href(page + 1)}
            className="rounded-lg border border-ink-200 px-3 py-1.5 text-[12px] font-semibold text-ink-700 hover:bg-ink-50"
          >
            다음
          </Link>
        ) : null}
      </div>
    </div>
  );
}

/** 라벨 사전({text, tone})을 그대로 배지로 그린다. */
export function ToneBadge({ label }: { label: { text: string; tone: Tone } }) {
  return <Badge tone={label.tone}>{label.text}</Badge>;
}

/** 감사로그 등에서 JSON 스냅샷을 안전하게 출력한다. */
export function JsonView({ value, maxLength = 1200 }: { value: unknown; maxLength?: number }) {
  if (value === null || value === undefined) return <span className="text-[12px] text-ink-300">-</span>;
  let text: string;
  try {
    text = JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) ?? '-';
  } catch {
    text = '(직렬화할 수 없는 값)';
  }
  const clipped = text.length > maxLength ? `${text.slice(0, maxLength)}\n... (생략)` : text;
  return (
    <pre className="max-w-[420px] overflow-x-auto rounded-lg bg-ink-50 p-2 text-[11px] leading-relaxed whitespace-pre-wrap text-ink-700">
      {clipped}
    </pre>
  );
}

/** 사회복지기관 선택용 Select 옵션 */
export function MerchantOptions({
  merchants,
  allLabel = '전체',
}: {
  merchants: Array<{ id: string; displayName: string; code: string }>;
  allLabel?: string;
}) {
  return (
    <>
      <option value="">{allLabel}</option>
      {merchants.map((c) => (
        <option key={c.id} value={c.id}>
          {c.displayName} ({c.code})
        </option>
      ))}
    </>
  );
}
