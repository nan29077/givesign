'use client';

import * as React from 'react';
import { MessageSquareText } from 'lucide-react';

/**
 * 홍보물 QR 중간 페이지의 문자 앱 열기(2026-11-12 4차 K1).
 * 휴대폰이면 열자마자 한 번 문자 앱으로 보내고, 버튼도 남겨 둔다(문자 앱이 안 열리면 후원페이지 버튼을 쓴다).
 */
export function SmsOpener({ href, auto }: { href: string; auto: boolean }) {
  React.useEffect(() => {
    if (!auto) return;
    const t = window.setTimeout(() => {
      window.location.href = href;
    }, 300);
    return () => window.clearTimeout(t);
  }, [href, auto]);
  return (
    <a
      href={href}
      className="flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-600 px-5 py-4 text-[17px] font-extrabold text-white"
    >
      <MessageSquareText size={20} strokeWidth={1.7} />
      문자 앱 열기
    </a>
  );
}
