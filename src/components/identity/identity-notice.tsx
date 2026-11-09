import Link from 'next/link';
import { BadgeCheck } from 'lucide-react';
import { identityRequired, identityStartHref, IDENTITY_PURPOSE_LABEL, type IdentityPurpose } from '@/server/services/identity';
import { getIdentityAdapter } from '@/server/adapters/identity';

/**
 * 본인인증 안내(2026-11-13 5차 L1). 그 목적의 `IDENTITY_REQUIRED_FOR_*` 가 꺼져 있으면 아무것도 그리지 않는다(예전 화면 그대로).
 * 후원자 화면 조각이라 본문 16px 이상·큰 버튼.
 */
export function IdentityNotice({ purpose, next, verified = false }: { purpose: IdentityPurpose; next: string; verified?: boolean }) {
  if (!identityRequired(purpose)) return null;
  const mock = getIdentityAdapter().info().mode === 'mock';
  return (
    <div className="rounded-2xl border border-brand-200 bg-brand-50/60 p-4">
      <div className="flex items-center gap-2">
        <BadgeCheck size={18} strokeWidth={1.7} className="text-brand-700" />
        <p className="text-[16px] font-bold text-ink-900">{IDENTITY_PURPOSE_LABEL[purpose]}에는 휴대폰 본인인증이 필요합니다</p>
      </div>
      <p className="mt-1 text-[15px] leading-relaxed text-ink-700">
        {verified ? '본인인증을 마쳤습니다. 이어서 진행해 주세요.' : '본인 명의 휴대폰으로 인증한 뒤 진행할 수 있습니다. 인증 결과는 정해진 시간 동안만 쓰입니다.'}
        {mock ? ' [MOCK] 본인인증 기관 연동 전 — 실제 본인 확인이 아닙니다.' : ''}
      </p>
      {!verified ? (
        <Link href={identityStartHref(purpose, next)} className="mt-3 inline-flex h-12 items-center justify-center rounded-xl bg-brand-400 px-5 text-[16px] font-extrabold text-ink-900 hover:bg-brand-500">
          휴대폰 본인인증 하기
        </Link>
      ) : null}
    </div>
  );
}
