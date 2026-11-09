import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Card } from '@/components/ui';
import { isIdentityPurpose, safeReturnPath, startIdentityVerification } from '@/server/services/identity';

/** 휴대폰 본인인증 시작(2026-11-13 5차 L1) → 공급자 인증창(mock 은 /mock/identity). */
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '휴대폰 본인인증', robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

export default async function IdentityStartPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const purpose = one(sp.purpose);
  if (!isIdentityPurpose(purpose)) {
    return (
      <main className="app-column px-4 py-10"><Card><p className="text-[15px] font-bold text-ink-900">잘못된 본인인증 요청입니다.</p></Card></main>
    );
  }
  let url: string;
  try {
    url = (await startIdentityVerification({ purpose, returnPath: safeReturnPath(one(sp.next)) })).redirectUrl;
  } catch (e) {
    return (
      <main className="app-column px-4 py-10">
        <Card>
          <p className="text-[15px] font-bold text-ink-900">본인인증을 시작하지 못했습니다</p>
          <p className="mt-2 text-[14px] text-ink-600">{(e as Error).message}</p>
        </Card>
      </main>
    );
  }
  redirect(url);
}
