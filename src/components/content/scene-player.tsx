'use client';

import * as React from 'react';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { cx } from '@/components/ui';

/**
 * 장면 미리보기 — 숏폼은 장면 길이대로 넘기고, 이미지는 한 장씩 본다.
 * 영상(mp4) 조립 공급자 연결 전에는 이 스토리보드가 미리보기다.
 */
export function ScenePlayer({ scenes, format }: { scenes: Array<{ svg: string; durationSec: number; caption: string }>; format: 'STORY' | 'SQUARE' }) {
  const [i, setI] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const total = scenes.length;
  React.useEffect(() => {
    if (!playing || total === 0) return;
    const t = setTimeout(() => setI((v) => (v + 1) % total), (scenes[i]?.durationSec ?? 5) * 1000);
    return () => clearTimeout(t);
  }, [playing, i, total, scenes]);
  if (total === 0) return null;
  const src = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  const totalSec = scenes.reduce((a, s) => a + s.durationSec, 0);
  return (
    <div>
      <div className={cx('relative mx-auto overflow-hidden rounded-2xl bg-ink-900 shadow-lg', format === 'STORY' ? 'aspect-[9/16] max-w-[300px]' : 'aspect-square max-w-[380px]')}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src(scenes[i]!.svg)} alt={scenes[i]!.caption} className="h-full w-full object-cover" />
        <div className="absolute inset-x-0 top-0 flex gap-1 p-2">
          {scenes.map((_, k) => <span key={k} className={cx('h-1 flex-1 rounded-full', k <= i ? 'bg-white' : 'bg-white/30')} />)}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-center gap-2">
        <button type="button" onClick={() => setI((v) => (v - 1 + total) % total)} className="rounded-full border border-ink-200 p-2 text-ink-600" aria-label="이전 장면"><SkipBack size={16} strokeWidth={1.7} /></button>
        <button type="button" onClick={() => setPlaying((p) => !p)} className="rounded-full bg-ink-900 p-2.5 text-white" aria-label={playing ? '일시정지' : '재생'}>{playing ? <Pause size={18} strokeWidth={1.7} /> : <Play size={18} strokeWidth={1.7} />}</button>
        <button type="button" onClick={() => setI((v) => (v + 1) % total)} className="rounded-full border border-ink-200 p-2 text-ink-600" aria-label="다음 장면"><SkipForward size={16} strokeWidth={1.7} /></button>
        <span className="ml-2 text-[12px] tabular-nums text-ink-400">{i + 1}/{total} · 약 {totalSec}초</span>
      </div>
    </div>
  );
}

/** 목록용 작은 썸네일 */
export function SvgThumb({ svg, format, className }: { svg: string | null; format: 'STORY' | 'SQUARE'; className?: string }) {
  if (!svg) return <div className={cx('rounded-xl bg-ink-100', format === 'STORY' ? 'aspect-[9/16]' : 'aspect-square', className)} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} alt="" className={cx('rounded-xl object-cover', format === 'STORY' ? 'aspect-[9/16]' : 'aspect-square', className)} />;
}
