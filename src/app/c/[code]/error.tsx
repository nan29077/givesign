'use client';

import { CircleAlert } from 'lucide-react';

/**
 * 사회복지기관 후원 페이지 세그먼트 에러 경계.
 *
 * 서버 오류(DB 연결 실패, 렌더 오류 등)가 발생할 때 루트 error.tsx 대신
 * 후원 페이지 디자인과 어울리는 화면을 보여준다.
 */
export default function MerchantChargeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const looksLikeDb =
    /database|prisma|ECONNREFUSED|connect|P1000|P1001|P2021/i.test(error?.message ?? '');

  return (
    <div className="grid min-h-dvh place-items-center bg-[#f7f5ef] px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="rounded-[26px] border border-ink-100 bg-white p-6 shadow-[0_24px_60px_rgba(23,22,26,0.1)]">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-warning-50 text-warning-500">
            <CircleAlert size={20} strokeWidth={1.7} />
          </span>
          <h1 className="mt-3 text-[19px] font-extrabold leading-snug tracking-tight text-ink-900">
            후원 페이지를 불러오지 못했습니다
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
            {looksLikeDb
              ? '서버와 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'
              : '일시적인 오류입니다. 아래 버튼을 눌러 다시 시도해 주세요.'}
          </p>
          {process.env.NODE_ENV !== 'production' && error?.message ? (
            <pre className="mt-3 overflow-x-auto rounded-xl bg-ink-50 p-3 text-[11.5px] leading-relaxed text-ink-500">
              {error.message}
            </pre>
          ) : null}
          <button
            type="button"
            onClick={reset}
            className="mt-5 inline-flex h-12 w-full items-center justify-center rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900 hover:bg-brand-500"
          >
            다시 시도
          </button>
        </div>
      </div>
    </div>
  );
}
