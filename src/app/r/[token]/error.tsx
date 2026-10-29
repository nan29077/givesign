'use client';

import Link from 'next/link';
import { CircleAlert } from 'lucide-react';

/**
 * 보안 링크(/r/[token]) 세그먼트 에러 경계.
 *
 * 이 화면은 문자로 받은 결제 링크를 연 후원자가 보는 화면이다.
 * 루트 error.tsx 가 잡으면 개발자용 안내(배치파일 실행, .env 확인, /api/health)가
 * 후원자에게 그대로 노출된다. 여기서는 후원자가 알아야 하는 것만 말한다.
 *
 * 가장 중요한 문구는 "출금이 됐는지" 다. 결제 화면에서 오류가 나면 후원자는
 * 돈이 빠졌는지부터 알고 싶어 한다.
 */
export default function SecureLinkError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-[#f7f5ef] px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="rounded-[26px] border border-ink-100 bg-white p-6 shadow-[0_24px_60px_rgba(23,22,26,0.1)]">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-warning-50 text-warning-500">
            <CircleAlert size={20} strokeWidth={1.7} />
          </span>
          <h1 className="mt-3 text-[19px] font-extrabold leading-snug tracking-tight text-ink-900">
            화면을 불러오지 못했습니다
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
            일시적인 오류입니다. <strong className="font-bold text-ink-900">결제는 진행되지 않았습니다.</strong> 아래
            버튼으로 다시 시도해 주세요.
          </p>
          <p className="mt-2 text-[12.5px] leading-relaxed text-ink-400">
            같은 화면이 계속 나오면 이 링크는 그대로 두고, 사회복지기관의 결제 수신번호로 문자를 다시 보내 주세요. 출금
            여부가 걱정되면 홈 화면의 &lsquo;결제내역 확인&rsquo; 에서 휴대폰 번호로 조회할 수 있습니다.
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
          <Link
            href="/"
            className="mt-2 inline-flex h-11 w-full items-center justify-center rounded-2xl border border-ink-200 text-[14px] font-bold text-ink-700 hover:bg-ink-50"
          >
            홈으로
          </Link>
        </div>
      </div>
    </div>
  );
}
