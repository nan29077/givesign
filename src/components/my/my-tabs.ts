/**
 * 마이페이지 탭 정의와 활성 판정(순수 함수 — 테스트 대상).
 *
 * 활성 판정은 경로 접두사 일치이고, 여러 탭이 맞으면 가장 긴 접두사를 고른다.
 * 예전에는 정확 일치(`match.includes(pathname)`)라 `/my/agreements/<id>` 같은 하위 화면에서
 * 어떤 탭도 활성이 아니었다(점검 F).
 */
export type MyTabKey = 'donations' | 'recurring' | 'volunteer' | 'receipts' | 'account';

export interface MyTabDef {
  key: MyTabKey;
  href: string;
  label: string;
  /** 이 접두사로 시작하는 경로에서 탭을 활성으로 본다. '/my' 는 정확 일치만. */
  prefixes: string[];
}

export const MY_TABS: MyTabDef[] = [
  { key: 'donations', href: '/my', label: '후원 내역', prefixes: ['/my', '/my/payments'] },
  { key: 'recurring', href: '/my/recurring', label: '정기후원', prefixes: ['/my/recurring', '/my/agreements'] },
  { key: 'volunteer', href: '/my/volunteer', label: '봉사', prefixes: ['/my/volunteer'] },
  { key: 'receipts', href: '/my/receipts', label: '영수증', prefixes: ['/my/receipts', '/my/documents'] },
  { key: 'account', href: '/my/account', label: '내 정보', prefixes: ['/my/account', '/my/limits', '/my/blocks', '/my/consents'] },
];

/** 기능 플래그에 맞춰 보일 탭. 자원봉사(FEATURE_VOLUNTEER)가 꺼져 있으면 봉사 탭을 뺀다. */
export function visibleMyTabs(opts: { volunteerEnabled: boolean }): MyTabDef[] {
  return MY_TABS.filter((t) => t.key !== 'volunteer' || opts.volunteerEnabled);
}

function prefixMatches(pathname: string, prefix: string): boolean {
  if (prefix === '/my') return pathname === '/my';
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 현재 경로에서 활성인 탭. 없으면 null. */
export function activeMyTab(pathname: string, tabs: MyTabDef[] = MY_TABS): MyTabKey | null {
  let best: { key: MyTabKey; len: number } | null = null;
  for (const t of tabs) {
    for (const p of t.prefixes) {
      if (prefixMatches(pathname, p) && (!best || p.length > best.len)) best = { key: t.key, len: p.length };
    }
  }
  return best?.key ?? null;
}
