import * as React from 'react';
import { MascotAccent } from '@/components/brand/mascot-decorations';

/**
 * 공개 페이지 공통 헤더.
 * PublicShell 안에서 각 페이지 최상단에 사용한다.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <header className="relative mb-6 overflow-hidden rounded-[26px] border border-slate-200/80 bg-[linear-gradient(135deg,#f7fafc_0%,#fff_52%,#eef5f2_100%)] px-5 py-6 pr-20 shadow-[0_14px_34px_rgba(7,20,38,0.08)] sm:px-7 sm:py-8 sm:pr-28">
      <span className="absolute -right-8 -top-10 h-32 w-32 rounded-full bg-[#b7f34a]/22 blur-2xl" aria-hidden />
      <span className="absolute -bottom-12 left-1/3 h-24 w-24 rounded-full bg-[#071426]/10 blur-2xl" aria-hidden />
      <MascotAccent seed={title} className="absolute -bottom-3 -right-2 h-[82px] w-[82px] opacity-90 sm:-bottom-4 sm:right-2 sm:h-[108px] sm:w-[108px]" />
      <div className="relative z-[1]">
      {eyebrow ? <p className="text-[10px] font-extrabold tracking-[0.18em] text-brand-700">{eyebrow}</p> : null}
      <h1 className="mt-2 text-[26px] font-black leading-[1.2] tracking-[-0.04em] text-ink-900 sm:text-[31px]">{title}</h1>
      {description ? <p className="mt-3 max-w-[520px] text-[13.5px] leading-relaxed text-ink-500 sm:text-[14px]">{description}</p> : null}
      </div>
    </header>
  );
}
