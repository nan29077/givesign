'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, CircleCheck } from 'lucide-react';

/**
 * 계좌(빌키) 등록 완료 후 사회복지기관 후원 페이지(/c/[code])로 자동 이동한다.
 *
 * 주의
 *  - 서버에서 redirect() 하지 않는다. 완료 화면에는 등록 계좌·해지 방법 안내가 함께 있고,
 *    새로고침으로 다시 들어온 사람도 그 내용을 볼 수 있어야 한다.
 *  - router.replace 를 쓴다. push 하면 뒤로가기로 완료 화면에 돌아왔다가 다시 이동해 갇힌다.
 *  - 자동 이동이 막힌 환경(스크립트 차단 등)을 위해 아래 링크를 항상 함께 노출한다.
 */
export function CompleteRedirect({
  merchantCode,
  merchantName,
  seconds = 3,
}: {
  merchantCode: string;
  merchantName: string;
  seconds?: number;
}) {
  const router = useRouter();
  const [left, setLeft] = React.useState(seconds);
  const href = `/c/${merchantCode}`;

  React.useEffect(() => {
    const tick = setInterval(() => setLeft((v) => (v > 0 ? v - 1 : 0)), 1000);
    const timer = setTimeout(() => router.replace(href), seconds * 1000);
    return () => {
      clearInterval(tick);
      clearTimeout(timer);
    };
  }, [router, href, seconds]);

  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3.5">
      <p className="flex items-center gap-2 text-[13.5px] font-extrabold text-ink-900">
        <CircleCheck size={17} strokeWidth={1.7} className="text-success-500" />
        가입이 완료되었습니다
      </p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-700">
        {left > 0
          ? `${left}초 후 ${merchantName} 문자 발송 페이지로 이동합니다.`
          : `${merchantName} 문자 발송 페이지로 이동하는 중입니다.`}
      </p>
      <button
        type="button"
        onClick={() => router.replace(href)}
        className="mt-2.5 inline-flex items-center gap-1.5 text-[12.5px] font-extrabold text-brand-700"
      >
        지금 바로 이동
        <ArrowRight size={15} strokeWidth={1.8} />
      </button>
    </div>
  );
}
