import Image from 'next/image';
import { cx } from '@/components/ui';
import { isOptimizableImage } from '@/lib/image-src';

/** 공개 서브페이지와 콘솔 제목 옆에 쓰는 기브싸인 마스코트. */
export function MascotAccent({ className }: { seed: string; className?: string }) {
  return (
    <span
      className={cx('mascot-accent pointer-events-none select-none rounded-[28px] border border-white/60 bg-white/55 p-1.5 backdrop-blur-md', className)}
      aria-hidden="true"
    >
      <Image src="/assets/givesign/mascot.png" alt="" width={112} height={112} sizes="112px" className="h-full w-full object-contain" />
    </span>
  );
}

/**
 * 모든 PC 공개 화면의 앱 바깥 여백에 공통으로 노출되는 기브싸인 사무실 장면.
 * 1180px 미만에서는 CSS 로 숨기므로 미리 불러오지 않는다(priority 없음, 지연 로딩).
 */
export function PublicMarginMascots({ src = '/assets/givesign/hero.png' }: { src?: string }) {
  return (
    <div className="public-mascot-scene" aria-hidden="true">
      <Image
        unoptimized={!isOptimizableImage(src)}
        src={src}
        alt=""
        fill
        sizes="(min-width: 1180px) 100vw, 1px"
        loading="lazy"
        className="public-margin-backdrop object-cover"
      />
    </div>
  );
}

/** 관리자·서비스 콘솔 배경 모서리의 give sign 브랜드 마크. */
export function ConsoleCornerMascot() {
  return (
    <span className="console-corner-mascot pointer-events-none select-none" aria-hidden="true">
      <Image src="/assets/givesign/mascot.png" alt="" width={170} height={170} sizes="170px" />
    </span>
  );
}
