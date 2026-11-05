import Link from 'next/link';
import { CircleAlert, House, LifeBuoy } from 'lucide-react';
import { Logo } from '@/components/brand/logo';

/**
 * 공통 404 화면. notFound() 를 부른 경로 중 자기 not-found 가 없는 곳은 모두 여기로 온다.
 * PublicShell 없이 단독으로 그린다(세션·DB 조회 없이도 항상 뜨도록).
 */
export default function NotFound() {
  return (
    <div className="grid min-h-dvh place-items-center bg-[#f7f5ef] px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="rounded-[26px] border border-ink-100 bg-white p-6 shadow-[0_24px_60px_rgba(23,22,26,0.1)]">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-warning-50 text-warning-500">
            <CircleAlert size={20} strokeWidth={1.7} />
          </span>
          <h1 className="mt-3 text-[19px] font-extrabold leading-snug tracking-tight text-ink-900">
            페이지를 찾을 수 없습니다
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
            주소가 잘못되었거나, 링크가 만료되었거나, 아직 공개되지 않은 페이지입니다. 받은 링크를 다시 확인해 주세요.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <Link
              href="/"
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl bg-brand-400 text-[14px] font-bold text-ink-900 hover:bg-brand-500"
            >
              <House size={16} strokeWidth={1.7} />
              홈으로
            </Link>
            <Link
              href="/support"
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-ink-200 bg-white text-[14px] font-bold text-ink-700 hover:bg-ink-50"
            >
              <LifeBuoy size={16} strokeWidth={1.7} />
              고객센터
            </Link>
          </div>
        </div>
        <div className="mt-5 flex justify-center opacity-70">
          <Link href="/" aria-label="기브싸인 홈으로">
            <Logo compact />
          </Link>
        </div>
      </div>
    </div>
  );
}
