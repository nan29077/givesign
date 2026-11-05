import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CalendarClock, HandHeart, Info, MapPin } from 'lucide-react';
import { DonorShell } from '@/components/public/donor-shell';
import { featureVolunteerEnabled } from '@/lib/env';
import { dateKeyOf, shiftWhenLabel } from '@/lib/volunteer-schedule';
import { getPublicPosting } from '@/server/services/volunteer-postings';
import { loadDonorContext } from '../../_shell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '자원봉사 모집' };

/**
 * 공개 자원봉사 모집 공고. 모집 중 + 모집 기간 안 공고만 열린다(그 밖은 404).
 * 신청은 기브싸인 통합 후원자 계정의 신청서(/my/volunteer/apply)로 보낸다. 정원·기간은 신청 때 서버가 다시 확인한다.
 * 유입 경로(?src=&cid=)는 proxy 가 쿠키로 남기고, 신청 링크에도 그대로 붙여 둔다.
 */
export default async function PublicVolunteerPostingPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string; postingId: string }>;
  searchParams: Promise<{ src?: string; cid?: string }>;
}) {
  if (!featureVolunteerEnabled()) notFound();
  const { code, postingId } = await params;
  const sp = await searchParams;
  const ctx = await loadDonorContext(code);
  const posting = await getPublicPosting(ctx.org.id, postingId);
  if (!posting) notFound();
  const color = ctx.color;
  const track = `${sp.src ? `&src=${encodeURIComponent(sp.src.slice(0, 20))}` : ''}${sp.cid ? `&cid=${encodeURIComponent(sp.cid.slice(0, 30))}` : ''}`;
  const applyHref = (shiftId?: string) =>
    `/my/volunteer/apply?merchant=${ctx.org.code}&posting=${posting.id}${shiftId ? `&shift=${shiftId}` : ''}${track}`;

  return (
    <DonorShell org={ctx.shellOrg} viewer={ctx.viewer} active="home" color={color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-6 px-5 pt-7 sm:px-7">
        <Link href={`/donate/${ctx.org.code}`} className="text-xs font-bold text-ink-400 hover:text-ink-700">{ctx.org.displayName} / 자원봉사 모집</Link>
        <section>
          <p className="flex items-center gap-1.5 text-[12px] font-bold" style={{ color }}><HandHeart size={15} strokeWidth={1.7} /> {posting.interest}</p>
          <h1 className="mt-2 break-words text-[26px] font-black leading-snug tracking-[-0.03em] text-ink-900">{posting.title}</h1>
          <dl className="mt-4 grid gap-2 text-[13px] text-ink-700">
            <div className="flex items-start gap-2"><MapPin size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-400" /><dd>{posting.place}</dd></div>
            <div className="flex items-start gap-2"><CalendarClock size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-ink-400" /><dd>모집 {dateKeyOf(posting.recruitFrom)} ~ {dateKeyOf(posting.recruitTo)}</dd></div>
          </dl>
        </section>

        <section className="rounded-[24px] border border-ink-100 bg-white p-5">
          <h2 className="text-[15px] font-black text-ink-900">활동 내용</h2>
          <p className="mt-2 whitespace-pre-line text-[14px] leading-7 text-ink-700">{posting.description}</p>
          {posting.requirements ? (
            <p className="mt-3 rounded-2xl bg-ink-50 px-4 py-3 text-[13px] text-ink-700"><b>필요 사항</b> {posting.requirements}</p>
          ) : null}
        </section>

        <section>
          <h2 className="mb-3 text-[15px] font-black text-ink-900">회차</h2>
          {posting.shifts.length === 0 ? (
            <div className="rounded-[24px] border border-ink-100 bg-white p-5 text-[13px] text-ink-600">
              <p>정해진 회차 없이 신청을 받습니다. 기관 담당자가 확인한 뒤 일정을 안내해 드립니다.</p>
              <Link href={applyHref()} className="mt-4 flex h-11 items-center justify-center gap-1.5 rounded-2xl text-[14px] font-extrabold text-white" style={{ background: color }}>
                <HandHeart size={16} strokeWidth={1.7} /> 신청하기
              </Link>
            </div>
          ) : (
            <ul className="space-y-2">
              {posting.shifts.map((s) => {
                const left = Math.max(0, s.capacity - s.appliedCount);
                return (
                  <li key={s.id} className="flex items-center justify-between gap-3 rounded-2xl border border-ink-100 bg-white px-4 py-3">
                    <span>
                      <span className="block text-[14px] font-extrabold tabular-nums text-ink-900">{shiftWhenLabel(s)}</span>
                      <span className="text-[12px] tabular-nums text-ink-500">정원 {s.capacity}명 · {left > 0 ? `남은 자리 ${left}` : '마감'}</span>
                    </span>
                    {left > 0 ? (
                      <Link href={applyHref(s.id)} className="shrink-0 rounded-xl px-4 py-2 text-[13px] font-extrabold text-white" style={{ background: color }}>신청</Link>
                    ) : (
                      <span className="shrink-0 rounded-xl bg-ink-100 px-4 py-2 text-[13px] font-bold text-ink-400">마감</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <p className="flex items-start gap-1 text-[11.5px] leading-relaxed text-ink-500">
          <Info size={13} strokeWidth={1.8} className="mt-0.5 shrink-0" />
          <span>자원봉사 신청은 기브싸인 통합 계정으로 진행됩니다. 이 기관 회원 계정과는 별도로 로그인합니다. 신청 후 기관 담당자가 승인하면 일정이 문자로 안내됩니다.</span>
        </p>
        <Link href={`/donate/${ctx.org.code}`} className="block text-center text-[13px] font-bold text-ink-500 underline">기관 후원페이지로</Link>
      </div>
    </DonorShell>
  );
}
