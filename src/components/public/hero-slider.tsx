'use client';

import * as React from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from '@/components/ui';

const slides = [
 { image: '/assets/givesign/donation-automation-banner-v1.webp', mascotOverlay: false, eyebrow: 'GIVESIGN AUTOMATION · 후원 자동화', title: '반복되는 후원 업무는 가볍게,\n이웃에게 전하는 마음은 더 깊게', description: '후원 접수부터 정기 약정·월간 안내·기부금영수증까지. 담당자의 확인과 승인으로 이어지는 후원 운영을 만나보세요.', href: '/#donation-automation', cta: '후원 자동화 알아보기' },
 { image: '/assets/givesign/presets/banner-2.webp', mascotOverlay: false, eyebrow: 'GIVESIGN DOCUMENTS · 기관 전자문서', title: '후원약정부터 봉사 신청까지,\n종이 대신 간편한 전자문서', description: '기관 서식 작성·서명 요청·제출 확인·보관까지. 업무량에 맞는 충전형·정액형으로 이용하세요.', href: '/electronic-documents', cta: '기관 전자문서 알아보기' },
 { image: '/assets/givesign/hero.png', mascotOverlay: false, eyebrow: 'GIVESIGN · 함께 만드는 내일', title: '문자 한 통에 담긴 마음,\n이웃의 희망이 됩니다', description: '사회복지기관 전용 MO 번호로 시작하는 문자후원. 작은 나눔이 더 따뜻한 일상을 만듭니다.', href: '/how-it-works', cta: '문자후원 알아보기' },
 { image: '/assets/givesign/banner.png', mascotOverlay: false, eyebrow: '함께 나누는 일상', title: '우리 기관의 이야기를\n후원자와 나누세요', description: '기관 후원페이지와 캠페인을 만들고, 후원 내역과 정산을 한곳에서 관리하세요.', href: '/business', cta: '기관 도입 안내' },
];

export function HeroSlider() {
  const [current, setCurrent] = React.useState(0);
  const [paused, setPaused] = React.useState(false);

  const move = React.useCallback((next: number) => {
    setCurrent((next + slides.length) % slides.length);
  }, []);

  React.useEffect(() => {
    if (paused) return;
    // 시스템의 동작 줄이기 설정을 존중해 자동 전환을 멈춘다
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setCurrent((value) => (value + 1) % slides.length), 5600);
    return () => window.clearInterval(timer);
  }, [paused]);

  return (
    <section
      className="hero-slider group relative isolate overflow-hidden rounded-[30px] bg-ink-900 shadow-[0_28px_80px_rgba(32,60,50,0.28)]"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      aria-label="기브싸인 주요 서비스"
    >
      {/* 이미지 영역.
          모바일: 원본 비율(3:2)에 맞춰 이미지가 잘리지 않게 보여주고, 텍스트는 이미지 아래에 배치한다.
          PC(sm+): 기존처럼 와이드 비율 + 좌측 텍스트 오버레이. */}
      <div className="relative aspect-[3/2] sm:aspect-[16/11]">
        {slides.map((slide, index) => (
          <div
            key={slide.image}
            className={cx(
              'absolute inset-0 transition-[opacity,transform] duration-700 ease-out',
              current === index ? 'scale-100 opacity-100' : 'pointer-events-none scale-[1.025] opacity-0',
            )}
            aria-hidden={current !== index}
          >
            <Image src={slide.image} alt="" fill priority={index === 0} sizes="(min-width: 768px) 640px, 100vw" className="object-cover" />
            {slide.mascotOverlay ? (
              <Image
                src="/assets/givesign-mascot-v1.png"
                alt=""
                width={320}
                height={320}
                sizes="(min-width: 640px) 230px, 42vw"
                className={cx(
                  'hero-mascot absolute bottom-[-5%] right-[3%] z-[2] h-auto w-[36%] max-w-[230px] object-contain drop-shadow-[0_20px_30px_rgba(0,0,0,.3)]',
                  index === 1 ? '-rotate-6' : 'rotate-6',
                )}
              />
            ) : null}
            <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(32,60,50,0)_52%,rgba(32,60,50,.72)_86%,rgba(32,60,50,1)_100%)] sm:bg-[linear-gradient(90deg,rgba(32,60,50,.98)_0%,rgba(32,60,50,.8)_46%,rgba(32,60,50,.06)_100%)]" />
          </div>
        ))}

        <div className="absolute right-4 top-4 z-20 hidden gap-1 sm:flex">
          <button type="button" aria-label="이전 배너" onClick={() => move(current - 1)} className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-black/15 text-white backdrop-blur transition-colors hover:bg-black/35">
            <ChevronLeft size={17} strokeWidth={1.7} />
          </button>
          <button type="button" aria-label="다음 배너" onClick={() => move(current + 1)} className="grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-black/15 text-white backdrop-blur transition-colors hover:bg-black/35">
            <ChevronRight size={17} strokeWidth={1.7} />
          </button>
        </div>
      </div>

      {/* 텍스트 영역. 모바일은 이미지 아래 일반 흐름, sm+ 는 이미지 위 오버레이 */}
      <div className="relative z-10 -mt-2 px-6 pb-6 pt-0 sm:absolute sm:inset-y-0 sm:left-0 sm:mt-0 sm:flex sm:w-[72%] sm:flex-col sm:justify-end sm:p-9 sm:pb-9">
        <p className="text-[10px] font-bold tracking-[0.22em] text-brand-400">{slides[current].eyebrow}</p>
        <h1 className="mt-2.5 whitespace-pre-line text-[26px] font-black leading-[1.16] tracking-[-0.045em] text-white sm:mt-3 sm:text-[36px]">
          {slides[current].title}
        </h1>
        <p className="mt-2.5 max-w-[430px] text-[13px] leading-relaxed text-white/72 sm:mt-3 sm:text-[14px]">
          {slides[current].description}
        </p>
        <Link
          href={slides[current].href}
          className="mt-4 inline-flex h-11 w-fit items-center gap-2 rounded-full bg-brand-400 px-5 text-[13px] font-extrabold text-ink-900 shadow-lg shadow-black/10 transition-transform hover:-translate-y-0.5 sm:mt-5"
        >
          {slides[current].cta}
          <ArrowRight size={15} strokeWidth={1.8} />
        </Link>

        <div className="mt-5 flex items-center gap-2 sm:mt-6">
          {slides.map((slide, index) => (
            <button
              key={slide.image}
              type="button"
              aria-label={`${index + 1}번 배너 보기`}
              onClick={() => move(index)}
              className={cx(
                'h-1.5 rounded-full transition-all',
                current === index ? 'w-9 bg-white' : 'w-2.5 bg-white/35 hover:bg-white/65',
              )}
            />
          ))}
          <span className="ml-1 text-[10px] font-semibold tabular-nums text-white/55">0{current + 1} / 0{slides.length}</span>
        </div>
      </div>
    </section>
  );
}
