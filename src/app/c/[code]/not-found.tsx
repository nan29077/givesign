import Link from 'next/link';
import { CircleAlert } from 'lucide-react';
import { MerchantCodeForm } from '@/components/merchant-code-form';
import { Logo } from '@/components/brand/logo';
import { LinkButton } from '@/components/ui';

/**
 * /c/[code] 에서 기관을 찾지 못했을 때(미존재·미승인·정지·탈퇴).
 * page.tsx 가 notFound() 를 던지면 HTTP 404 와 함께 이 화면을 그린다.
 */
export default function MerchantChargeNotFound() {
  return (
    <div className="grid min-h-dvh place-items-center bg-[#f7f5ef] px-4 py-10">
      <div className="w-full max-w-[440px]">
        <div className="rounded-[26px] border border-ink-100 bg-white p-6 shadow-[0_24px_60px_rgba(23,22,26,0.1)]">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-warning-50 text-warning-500">
            <CircleAlert size={20} strokeWidth={1.7} />
          </span>
          <h1 className="mt-3 text-[19px] font-extrabold leading-snug tracking-tight text-ink-900">
            사회복지기관을 찾을 수 없습니다.
          </h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-500">
            기관 화면에 안내된 코드를 다시 확인해 주세요. 승인 전이거나 이용이 정지된 기관의 코드도 조회되지 않습니다.
          </p>
          <div className="mt-4">
            <MerchantCodeForm autoFocus />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <LinkButton href="/" variant="secondary" size="md" className="w-full">
              홈으로
            </LinkButton>
            <LinkButton href="/support" variant="secondary" size="md" className="w-full">
              고객센터
            </LinkButton>
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
