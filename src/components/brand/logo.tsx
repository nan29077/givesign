import * as React from 'react';

/** 승인된 3번 시안 원본에서 추출한 이미지. 모양·서체를 재해석하지 않는다. */
export function GiveSignMark({ size = 32, className }: { size?: number; className?: string; onDark?: boolean }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/assets/givesign/brand/mark-hope-transparent-v7.png" width={size} height={size} className={className} alt="" aria-hidden="true" />;
}
export const GivesignMark = GiveSignMark;
export function Logo({ compact = false }: { compact?: boolean; onDark?: boolean }) {
  if (compact) return <GiveSignMark size={32} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src="/assets/givesign/brand/logo-hope-transparent-v7.png" width={124} height={40} className="h-[40px] w-[124px] object-contain" alt="기브싸인 GiveSign" />;
}
