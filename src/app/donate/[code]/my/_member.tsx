import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bell, FileText, HandCoins, Receipt, Repeat } from 'lucide-react';
import { loadDonorContext } from '../_shell';
import { memberScope } from '@/server/services/donor-self-service';

/**
 * 기관 후원 회원 마이페이지 하위 화면 공통 (2026-11-09 2차 F).
 * 로그인하지 않았으면 그 기관 로그인으로 보낸다. 휴대폰 인증이 끝나 후원자와 이어진 경우에만 scope 가 있다.
 */
export async function loadMemberSelf(code: string, path: string) {
  const ctx = await loadDonorContext(code);
  const base = `/donate/${ctx.org.code}`;
  if (!ctx.viewer) redirect(`${base}/login?next=${encodeURIComponent(`${base}/my${path}`)}`);
  const scope = await memberScope(ctx.viewer);
  return { ctx, me: ctx.viewer, base, scope: scope && scope.via === 'MEMBER' ? scope : null };
}

export type MemberTab = 'home' | 'recurring' | 'settings' | 'receipts' | 'documents';

const TABS: Array<{ key: MemberTab; path: string; label: string; icon: typeof Repeat }> = [
  { key: 'home', path: '', label: '후원 내역', icon: HandCoins },
  { key: 'recurring', path: '/recurring', label: '정기후원', icon: Repeat },
  { key: 'receipts', path: '/receipts', label: '영수증', icon: Receipt },
  { key: 'documents', path: '/documents', label: '받은 문서', icon: FileText },
  { key: 'settings', path: '/settings', label: '알림 설정', icon: Bell },
];

/** 회원 마이페이지 메뉴(큰 글자, 좁은 화면에서는 두 줄로 감김) */
export function MemberMyNav({ base, active, color }: { base: string; active: MemberTab; color: string }) {
  return (
    <nav aria-label="후원 회원 메뉴" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      {TABS.map((t) => {
        const on = t.key === active;
        const Icon = t.icon;
        return (
          <Link
            key={t.key}
            href={`${base}/my${t.path}`}
            aria-current={on ? 'page' : undefined}
            className={`flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-2xl border px-2 py-2 text-[14px] font-bold ${on ? 'border-transparent text-white' : 'border-ink-100 bg-white text-ink-700'}`}
            style={on ? { backgroundColor: color } : undefined}
          >
            <Icon size={18} strokeWidth={1.7} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** 휴대폰 인증 전 안내 */
export function NeedPhoneNotice({ base }: { base: string }) {
  return (
    <div className="rounded-[24px] border border-ink-100 bg-white p-5 text-[16px] leading-relaxed text-ink-700">
      휴대폰 번호를 인증하면 그 번호로 한 이 기관 후원을 여기서 관리할 수 있습니다.{' '}
      <Link href={`${base}/my`} className="font-bold underline">마이페이지에서 휴대폰 인증하기</Link>
    </div>
  );
}
