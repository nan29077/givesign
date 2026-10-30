import { cx } from '@/components/ui';
import { GeneratedAvatar } from '@/components/profile/generated-avatar';

/**
 * 기관 로고.
 *
 * 기관이 로고를 올렸으면 로고를 원본 비율 그대로(잘리지 않게) 흰 바탕의 둥근 사각형 안에 보여 준다.
 * 아직 올리지 않았으면 지금처럼 기관 코드로 배정되는 기본 캐릭터(아바타)를 보여 준다.
 * 기관 콘솔 프로필, 공개 후원페이지 상단·프로필 카드·메뉴, 관리자 화면에서 같은 규칙을 쓴다.
 */
/** 예전 시드가 기본 캐릭터 파일을 로고 칸에 넣어 두었다. 이 값은 "직접 올린 로고"로 보지 않는다. */
const DEFAULT_MASCOT = '/assets/givesign/mascot.png';

export function isCustomLogo(url?: string | null): url is string {
  return Boolean(url && url !== DEFAULT_MASCOT);
}

export function OrgLogo({
  code,
  name,
  logoUrl,
  avatarIndex,
  className,
}: {
  code: string;
  name: string;
  logoUrl?: string | null;
  avatarIndex?: number | null;
  className?: string;
}) {
  if (isCustomLogo(logoUrl)) {
    return (
      <span
        className={cx(
          'inline-grid shrink-0 place-items-center overflow-hidden rounded-[28%] bg-white shadow-[0_5px_14px_rgba(23,22,26,0.12)] ring-1 ring-ink-100',
          className,
        )}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoUrl} alt={`${name} 로고`} className="h-[84%] w-[84%] object-contain" />
      </span>
    );
  }
  return <GeneratedAvatar seed={code} avatarIndex={avatarIndex} name={name} className={cx('rounded-[28%]', className)} />;
}
