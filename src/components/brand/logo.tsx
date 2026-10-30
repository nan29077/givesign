import * as React from 'react';

/** 선택된 3번 시안: 자라나는 희망 — 하트, 새싹, 받쳐 주는 미소. */
export function GiveSignMark({ size = 32, className, onDark = false }: { size?: number; className?: string; onDark?: boolean }) {
  const green = onDark ? '#ffffff' : '#07513d';
  const orange = onDark ? '#ffffff' : '#ff8824';
  return <svg width={size} height={size} viewBox="0 0 100 100" fill="none" className={className} aria-hidden="true">
    <path d="M50 28C46 23 32 15 32 9C32-1 45-3 50 6C55-3 68-1 68 9C68 15 54 23 50 28Z" transform="translate(0 6)" fill={orange} />
    <path d="M48 76C46 64 40 58 28 55C13 51 6 40 7 28C31 26 46 40 48 60L50 68L52 60C54 40 69 26 93 28C94 40 87 51 72 55C60 58 54 64 52 76C52 80 48 80 48 76Z" fill={green} />
    <path d="M9 72Q50 106 91 72" stroke={orange} strokeWidth="9" strokeLinecap="round" />
  </svg>;
}
export const GivesignMark = GiveSignMark;
export function Logo({ compact = false, onDark = false }: { compact?: boolean; onDark?: boolean }) {
  return <span className="inline-flex items-center gap-2" role="img" aria-label="기브싸인 GiveSign">
    <GiveSignMark size={compact ? 32 : 42} onDark={onDark} />
    {!compact && <span className={`flex flex-col leading-none ${onDark ? 'text-white' : 'text-[#07513d]'}`}>
      <span className="text-[23px] font-black tracking-[-0.06em]">기브싸인</span>
      <span className="mt-1 text-center text-[9px] font-semibold tracking-[0.3em]">GiveSign</span>
    </span>}
  </span>;
}
