import * as React from 'react';
export function GiveSignMark({ size = 32, className, onDark = false }: { size?: number; className?: string; onDark?: boolean }) {
 return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" className={className} aria-hidden><rect x="2" y="2" width="44" height="44" rx="15" fill={onDark ? '#e3efcf' : '#28634e'} /><path d="M24 33s-12-7-12-15a6.5 6.5 0 0 1 12-3 6.5 6.5 0 0 1 12 3c0 8-12 15-12 15Z" fill="#f4a18b" /><path d="M16 35c4 3 12 3 16-1M24 14c0-5 4-7 8-6-1 4-4 7-8 6Z" stroke={onDark ? '#28634e' : '#f8f4e9'} strokeWidth="2.5" strokeLinecap="round" /></svg>;
}
export const GivesignMark = GiveSignMark;
export function Logo({ compact = false, onDark = false }: { compact?: boolean; onDark?: boolean }) { return <span className="inline-flex items-center gap-2"><GiveSignMark size={compact ? 30 : 34} onDark={onDark} />{!compact && <span aria-label="기브싸인 GiveSign" className={onDark ? 'text-[21px] font-black text-white' : 'text-[21px] font-black text-[#28634e]'}>기브싸인<span className="ml-1.5 text-[10px] opacity-70">GiveSign</span></span>}</span>; }
