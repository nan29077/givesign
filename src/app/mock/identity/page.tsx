import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, Notice } from '@/components/ui';
import { isLocal, contractIntegrations } from '@/lib/env';
import { mockIdentitySubmit } from './actions';

/**
 * 모의 휴대폰 본인인증 화면(2026-11-13 5차 L1). PASS·NICE 규격 수령 전 검수용 — 실제 본인 확인이 아니다.
 * 입력한 이름·생년월일·번호는 저장하지 않고 해시만 남는다. 결과에는 [MOCK] 표시가 붙는다.
 */
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '테스트용 모의 본인인증', robots: { index: false, follow: false } };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));
const input = 'h-12 w-full rounded-xl border border-ink-200 px-3 text-[16px] outline-none focus:border-brand-400';

export default async function MockIdentityPage({ searchParams }: { searchParams: Promise<Search> }) {
  if (!(isLocal || contractIntegrations().identityProvider === 'mock')) notFound();
  const sp = await searchParams;
  const req = one(sp.req);
  const error = one(sp.error);
  const back = one(sp.back);
  return (
    <main className="min-h-screen bg-ink-50 px-4 pb-14 pt-6">
      <div className="app-column space-y-3">
        <Notice tone="warning" title="[MOCK] 실제 본인인증 화면이 아닙니다">
          본인인증 기관(PASS·NICE) 연동 전 검수용 화면입니다. 입력한 값은 저장하지 않으며 실제 본인 확인이 아닙니다.
        </Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Card>
          <p className="text-[16px] font-extrabold text-ink-900">휴대폰 본인인증</p>
          <form action={mockIdentitySubmit} className="mt-3 space-y-3">
            <input type="hidden" name="req" value={req} />
            <label className="block text-[15px] font-semibold text-ink-700">이름<input name="name" className={input} autoComplete="name" /></label>
            <label className="block text-[15px] font-semibold text-ink-700">생년월일 8자리<input name="birthDate" inputMode="numeric" placeholder="19900101" className={input} /></label>
            <label className="block text-[15px] font-semibold text-ink-700">휴대폰 번호<input name="phone" type="tel" inputMode="tel" placeholder="010-1234-5678" className={input} /></label>
            <button type="submit" name="decision" value="ok" className="h-12 w-full rounded-xl bg-brand-400 text-[16px] font-extrabold text-ink-900 hover:bg-brand-500">[MOCK] 인증하기</button>
            <button type="submit" name="decision" value="cancel" className="h-11 w-full rounded-xl border border-ink-200 bg-white text-[15px] font-bold text-ink-700">취소</button>
          </form>
          {back ? <p className="mt-3 text-[14px]"><Link href={back} className="font-bold text-brand-700">원래 화면으로 돌아가기</Link></p> : null}
        </Card>
      </div>
    </main>
  );
}
