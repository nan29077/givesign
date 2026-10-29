import * as React from 'react';
import { cx } from '@/components/ui';

/**
 * 가입 시 생성되는 무작위 ULID를 50종 캐릭터 중 하나에 안정적으로 매핑한다.
 * 별도 개인정보나 외부 이미지 URL 없이도 같은 계정은 항상 같은 캐릭터를 본다.
 */
export function avatarIndexFromSeed(seed: string) {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % 50;
}

export function normalizeAvatarIndex(index: number | null | undefined, seed: string) {
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 50
    ? index
    : avatarIndexFromSeed(seed || 'givesign');
}

export function GeneratedAvatar({
  seed,
  avatarIndex,
  name,
  className,
}: {
  seed: string;
  avatarIndex?: number | null;
  name?: string | null;
  className?: string;
}) {
  const index = normalizeAvatarIndex(avatarIndex, seed);
  const avatarSrc = '/assets/givesign/mascot.png';

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarSrc}
      alt={`${name || '사용자'} 프로필 캐릭터`}
      className={cx(
        'inline-block shrink-0 rounded-full bg-brand-50 object-contain shadow-[0_5px_14px_rgba(23,22,26,0.15)] ring-2 ring-white',
        className,
      )}
      data-avatar-index={index}
    />
  );
}

// 과거 데이터에 남아 있는 값이라 브랜드명을 바꾸면 안 된다.
// (파일 자체는 더 이상 없고, 이 목록은 "잘못 저장된 avatarUrl" 을 걸러내는 용도다)
const CHARACTER_SHEETS: string[] = [];

/**
 * 앱 전역 프로필 표시 컴포넌트.
 * 직접 등록한 개별 이미지는 우선 사용하고, 과거 테스트 데이터처럼 캐릭터
 * 스프라이트 전체가 avatarUrl에 저장된 경우에는 계정별 생성 캐릭터로 복구한다.
 */
export function ProfileAvatar({
  seed,
  avatarIndex,
  name,
  imageUrl,
  className,
}: {
  seed: string;
  avatarIndex?: number | null;
  name?: string | null;
  imageUrl?: string | null;
  className?: string;
}) {
  const isCharacterSheet = CHARACTER_SHEETS.some((sheet) => imageUrl?.endsWith(sheet));

  if (imageUrl && !isCharacterSheet) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={`${name || '사용자'} 프로필`}
        className={cx(
          'inline-block shrink-0 rounded-full bg-brand-50 object-cover shadow-[0_5px_14px_rgba(23,22,26,0.15)] ring-2 ring-white',
          className,
        )}
      />
    );
  }

  return <GeneratedAvatar seed={seed} avatarIndex={avatarIndex} name={name} className={className} />;
}
