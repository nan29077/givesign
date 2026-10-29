'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronRight, Search } from 'lucide-react';
import { Button, Input, Notice } from '@/components/ui';
import { lookupMerchantCode, type MerchantSearchItem } from '@/app/actions/merchant-lookup';
import { ProfileAvatar } from '@/components/profile/generated-avatar';

/**
 * 사회복지기관 검색.
 * 코드(GIV-8K2M)뿐 아니라 사회복지기관 이름·서비스명으로도 찾을 수 있다.
 * 검색 버튼은 결과 목록만 열고, 사용자가 결과를 선택했을 때만 결제 페이지로 이동한다.
 */
export function MerchantCodeForm({ autoFocus = false }: { autoFocus?: boolean }) {
  const router = useRouter();
  const [value, setValue] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [matches, setMatches] = React.useState<MerchantSearchItem[] | null>(null);
  const [pending, startTransition] = React.useTransition();
  const resultsId = React.useId();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMatches(null);
    startTransition(async () => {
      const res = await lookupMerchantCode(value);
      if (!res.ok) {
        setError(res.message ?? '조회에 실패했습니다.');
        return;
      }
      setMatches(res.matches ?? []);
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setMatches(null);
            setError(null);
          }}
          placeholder="코드 · 채널명 · 닉네임"
          aria-label="사회복지기관 코드 또는 이름 검색"
          autoFocus={autoFocus}
          maxLength={40}
          className="flex-1 text-center text-[16px] font-bold"
          aria-controls={resultsId}
          aria-expanded={matches !== null}
        />
        <Button type="submit" disabled={pending || value.trim().length < 2} className="shrink-0 px-5">
          {pending ? '검색중' : '검색'}
          <Search size={15} strokeWidth={1.9} />
        </Button>
      </div>
      <p className="text-center text-[11.5px] text-ink-400">
        사회복지기관 코드(GIV-8K2M), 서비스명으로 검색할 수 있습니다.
      </p>

      {error ? <Notice tone="warning">{error}</Notice> : null}

      {pending ? (
        <div className="rounded-2xl border border-brand-100 bg-brand-50/60 px-4 py-4 text-center text-[12.5px] font-semibold text-brand-800">
          사회복지기관을 찾고 있습니다.
        </div>
      ) : null}

      {matches ? (
        <div
          id={resultsId}
          role="listbox"
          aria-label="사회복지기관 검색 결과"
          className="overflow-hidden rounded-2xl border border-brand-200 bg-white shadow-[0_14px_34px_rgba(23,22,26,0.12)]"
        >
          <div className="flex items-center justify-between border-b border-ink-100 bg-brand-50/70 px-4 py-2.5">
            <p className="text-[12px] font-extrabold text-ink-700">검색된 사회복지기관</p>
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-bold text-brand-700 shadow-sm">
              {matches.length}명
            </span>
          </div>
          <div className="max-h-[280px] overflow-y-auto p-2">
            {matches.map((m) => (
              <button
                key={m.code}
                type="button"
                role="option"
                aria-selected="false"
                onClick={() => router.push(`/c/${m.code}`)}
                className="group flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-all hover:bg-brand-50 focus:bg-brand-50 focus:outline-none focus:ring-2 focus:ring-brand-300"
              >
                <ProfileAvatar
                  seed={m.code}
                  avatarIndex={m.avatarIndex}
                  name={m.displayName}
                  imageUrl={m.avatarUrl}
                  className="h-12 w-12"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-extrabold text-ink-900">{m.displayName}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-ink-400">
                    {m.channelName ?? '채널명 미등록'}
                  </span>
                </span>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-50 text-ink-300 transition-colors group-hover:bg-brand-400 group-hover:text-ink-900">
                  <ChevronRight size={17} strokeWidth={1.9} />
                </span>
              </button>
            ))}
          </div>
          <p className="border-t border-ink-100 px-4 py-2.5 text-center text-[11.5px] text-ink-400">
            원하는 사회복지기관을 선택하면 결제페이지로 이동합니다.
          </p>
        </div>
      ) : null}
    </form>
  );
}
