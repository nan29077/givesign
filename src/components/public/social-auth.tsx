import * as React from 'react';
import { allSocialProviderStatus, type SocialProvider } from '@/server/adapters/social';
import { cx } from '@/components/ui';

/**
 * 카카오 / 네이버 간편 로그인·회원가입 버튼.
 *
 * 연동 키가 설정되기 전까지는 눌러도 로그인이 진행되지 않고
 * "연동 준비 중" 안내로 돌아온다. 준비되지 않은 기능을 성공한 것처럼 보이게 하지 않는다.
 */

/** 카카오 말풍선 형태의 간단한 마크 (라인/솔리드 도형) */
function KakaoMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
      <path
        d="M12 4c-4.42 0-8 2.79-8 6.24 0 2.2 1.47 4.13 3.68 5.24l-.86 3.16a.35.35 0 0 0 .53.39l3.72-2.45c.3.03.62.05.93.05 4.42 0 8-2.79 8-6.39C20 6.79 16.42 4 12 4Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** 네이버 N 형태의 간단한 마크 */
function NaverMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden fill="none">
      <path d="M5 4h5.1l3.9 6.1V4H19v16h-5.1L10 13.9V20H5V4Z" fill="currentColor" />
    </svg>
  );
}

const STYLE: Record<SocialProvider, { className: string; mark: React.ReactNode }> = {
  kakao: {
    className: 'bg-[#FEE500] text-[#191600] hover:brightness-95',
    mark: <KakaoMark />,
  },
  naver: {
    className: 'bg-[#03C75A] text-white hover:brightness-95',
    mark: <NaverMark />,
  },
};

export function SocialAuthButtons({ mode }: { mode: 'login' | 'signup' }) {
  const providers = allSocialProviderStatus();
  const verb = mode === 'signup' ? '회원가입' : '로그인';
  const allPending = providers.every((p) => !p.ready);

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-ink-100" />
        <span className="text-[12px] font-semibold text-ink-400">간편 {verb}</span>
        <span className="h-px flex-1 bg-ink-100" />
      </div>

      {providers.map((p) => (
        <a
          key={p.provider}
          href={`/api/auth/social/${p.provider}?mode=${mode}`}
          className={cx(
            'flex h-13 w-full items-center justify-center gap-2 rounded-2xl px-4 text-[15px] font-bold transition-[filter]',
            'h-14',
            STYLE[p.provider].className,
          )}
          aria-label={`${p.label}로 ${verb}`}
        >
          {STYLE[p.provider].mark}
          {p.label}로 {verb}
          {!p.ready ? <span className="text-[12px] font-semibold opacity-70">(준비 중)</span> : null}
        </a>
      ))}

      {allPending ? (
        <p className="text-center text-[12px] leading-relaxed text-ink-400">
          카카오·네이버 간편 {verb}은 연동 준비 중입니다. 지금은 이메일로 {verb}해 주세요.
        </p>
      ) : null}
    </div>
  );
}
