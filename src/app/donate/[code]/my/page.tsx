import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { HeartHandshake, MessageSquareText, Phone, Receipt, Repeat, ShieldCheck } from 'lucide-react';
import { DonorShell } from '@/components/public/donor-shell';
import { DonorPhoneLinkForm, DonorWithdrawForm } from '@/components/public/donor-auth-forms';
import { GeneratedAvatar } from '@/components/profile/generated-avatar';
import { donorMemberOverview } from '@/server/services/donor-members';
import { recurringStatusLabel } from '@/server/services/recurring';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { loadDonorContext } from '../_shell';
import { donorDonationHistory } from '@/server/services/donor-history';
import { memberScope } from '@/server/services/donor-self-service';
import { MemberMyNav } from './_member';
import { DonorImpactList } from '@/components/self-service/impact-list';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '후원 회원 마이페이지', robots: { index: false } };

/**
 * 기관 후원 회원 마이페이지. 이 기관 후원만 보여 준다.
 * 후원 내역 연결은 휴대폰 인증으로 한다(문자 후원의 후원자 식별 기준이 휴대폰 번호다).
 */
export default async function DonorMyPage({ params, searchParams }: { params: Promise<{ code: string }>; searchParams: Promise<{ email?: string; year?: string }> }) {
  const { code } = await params;
  const { email: emailResult, year } = await searchParams;
  const ctx = await loadDonorContext(code);
  const base = `/donate/${ctx.org.code}`;
  if (!ctx.viewer) redirect(`${base}/login?next=${encodeURIComponent(`${base}/my`)}`);
  const me = ctx.viewer;
  const [data, scope] = await Promise.all([donorMemberOverview(me), memberScope(me)]);
  // 연도별 합계·건별 내역(출처 표시 — 결제 + 등록된 다른 출처, 2026-11-09 2차 F)
  const history = scope ? await donorDonationHistory(scope.payerId, { merchantId: ctx.org.id, year: year ? Number(year) : undefined }) : null;

  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-5 px-4 pt-7 text-[16px] sm:px-7">
        <MemberMyNav base={base} active="home" color={ctx.color} />
        <section className="flex items-center gap-4 rounded-[28px] bg-white p-5 shadow-[0_12px_24px_-8px_rgba(0,0,0,0.08)]">
          <GeneratedAvatar seed={me.id} avatarIndex={me.avatarIndex} name={me.name} className="h-14 w-14" />
          <div className="min-w-0">
            <p className="truncate text-[18px] font-black text-ink-900">{me.name}님</p>
            <p className="truncate text-[12.5px] text-ink-500">{me.email}</p>
            {emailResult === 'verified' ? <p className="text-[11.5px] font-bold text-brand-700">이메일 인증을 완료했습니다.</p> : null}
            {emailResult === 'expired' || emailResult === 'invalid' ? <p className="text-[11.5px] font-bold text-danger-500">{emailResult === 'expired' ? '이메일 인증 링크가 만료되었습니다.' : '이메일 인증 링크를 확인할 수 없습니다.'}</p> : null}
            <p className="mt-0.5 text-[11.5px] font-bold" style={{ color: ctx.color }}>{ctx.org.displayName} 후원 회원</p>
          </div>
        </section>

        <section className="grid grid-cols-2 gap-2.5">
          <div className="rounded-2xl bg-[#f7f6ee] p-4 text-center">
            <HeartHandshake size={18} strokeWidth={1.7} className="mx-auto" style={{ color: ctx.color }} />
            <p className="mt-1.5 text-[17px] font-black tabular-nums text-ink-900">{formatWon(data.total)}</p>
            <p className="text-[11px] text-ink-400">누적 후원</p>
          </div>
          <div className="rounded-2xl bg-[#eef5ed] p-4 text-center">
            <MessageSquareText size={18} strokeWidth={1.7} className="mx-auto" style={{ color: ctx.color }} />
            <p className="mt-1.5 text-[17px] font-black tabular-nums text-ink-900">{formatNumber(data.count)}건</p>
            <p className="text-[11px] text-ink-400">후원 횟수</p>
          </div>
        </section>

        <section className="rounded-[24px] border border-ink-100 bg-white p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-black text-ink-900"><Phone size={17} strokeWidth={1.7} /> 휴대폰 인증</h2>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">
            {me.phoneVerified
              ? `${me.phoneMasked} 번호로 보낸 ${ctx.org.displayName} 후원이 아래에 표시됩니다. 번호를 바꾸려면 다시 인증하세요.`
              : `문자로 후원한 번호를 인증하면 그 번호로 보낸 ${ctx.org.displayName} 후원 내역을 볼 수 있습니다.`}
          </p>
          <div className="mt-3">
            <DonorPhoneLinkForm code={ctx.org.code} color={ctx.color} phoneMasked={me.phoneMasked} />
          </div>
        </section>

        <section className="rounded-[24px] border border-ink-100 bg-white p-5">
          <h2 className="text-[18px] font-black text-ink-900">후원 내역</h2>
          {!data.linked || !history ? (
            <p className="mt-2 text-[16px] text-ink-500">휴대폰 인증을 마치면 후원 내역이 표시됩니다.</p>
          ) : history.totals.length === 0 ? (
            <p className="mt-2 text-[16px] text-ink-500">아직 이 기관에 완료된 후원이 없습니다. <Link href={base} className="font-bold underline" style={{ color: ctx.color }}>후원하러 가기</Link></p>
          ) : (
            <>
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {history.totals.map((t) => (
                  <li key={t.year}>
                    <Link
                      href={`${base}/my?year=${t.year}`}
                      aria-current={t.year === history.year ? 'true' : undefined}
                      className={`block rounded-2xl border px-3 py-3 ${t.year === history.year ? 'border-transparent text-white' : 'border-ink-100 bg-ink-50 text-ink-900'}`}
                      style={t.year === history.year ? { backgroundColor: ctx.color } : undefined}
                    >
                      <span className="block text-[14px] font-bold">{t.year}년 · {formatNumber(t.count)}건</span>
                      <span className="block text-[18px] font-black tabular-nums">{formatWon(t.amount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-[15px] font-bold text-ink-500">{history.year}년 건별 내역 · 합계 {formatWon(history.yearTotal)}</p>
              <ul className="mt-1 divide-y divide-ink-100">
                {history.entries.map((e) => (
                  <li key={`${e.source}:${e.id}`} className="flex items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="text-[16px] font-bold text-ink-900">
                        {e.title} <span className="ml-1 rounded-md bg-ink-100 px-1.5 py-0.5 text-[12px] font-semibold text-ink-500">{e.sourceLabel}</span>
                      </p>
                      {e.detail ? <p className="mt-0.5 truncate text-[14px] text-ink-500">{e.detail}</p> : null}
                      <p className="mt-0.5 text-[13px] text-ink-400">{formatKst(e.at, false)}{e.reference ? <> · <span className="font-mono">{e.reference}</span></> : null}</p>
                    </div>
                    <p className="shrink-0 text-[16px] font-black tabular-nums text-ink-900">{formatWon(e.amount)}</p>
                  </li>
                ))}
              </ul>
              {history.failedSources.length ? <p className="mt-2 text-[13px] text-warning-500">일부 내역({history.failedSources.join(', ')})을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.</p> : null}
            </>
          )}
        </section>

        {/* 2026-11-09 3차 H: 이 기관에서 함께한 사업(진행 기록·결과 보고) */}
        {scope ? <DonorImpactList payerId={scope.payerId} merchantId={ctx.org.id} color={ctx.color} /> : null}

        {data.recurring.length > 0 ? (
          <section className="rounded-[24px] border border-ink-100 bg-white p-5">
            <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><Repeat size={20} strokeWidth={1.7} /> 정기후원</h2>
            <ul className="mt-3 space-y-2">
              {data.recurring.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-ink-50 px-4 py-3 text-[16px]">
                  <span className="font-bold text-ink-900">매월 {r.dayOfMonth}일 {formatWon(r.amount)}</span>
                  <span className="text-ink-500">{recurringStatusLabel[r.status]?.text ?? r.status}{r.status === 'ACTIVE' ? ` · 다음 ${r.nextChargeOn.toISOString().slice(0, 10)}` : ''}</span>
                </li>
              ))}
            </ul>
            <Link href={`${base}/my/recurring`} className="mt-3 flex h-14 w-full items-center justify-center rounded-2xl text-[16px] font-extrabold text-white" style={{ backgroundColor: ctx.color }}>
              금액·출금일 바꾸기 · 쉬기 · 해지
            </Link>
          </section>
        ) : null}

        <section className="rounded-[24px] border border-ink-100 bg-white p-5">
          <h2 className="flex items-center gap-2 text-[18px] font-black text-ink-900"><Receipt size={20} strokeWidth={1.7} /> 기부금영수증</h2>
          <p className="mt-1.5 text-[16px] leading-relaxed text-ink-700">
            {data.receipts.length ? `발급된 영수증 ${data.receipts.length}장이 있습니다.` : '영수증 정보를 등록하면 기관이 영수증을 발급할 수 있습니다.'}
          </p>
          <Link href={`${base}/my/receipts`} className="mt-3 flex h-12 w-full items-center justify-center rounded-2xl border border-ink-200 bg-white text-[16px] font-extrabold text-ink-900">영수증 정보·발급 내역 보기</Link>
        </section>

        <section className="rounded-[24px] border border-ink-100 bg-white p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-black text-ink-900"><ShieldCheck size={17} strokeWidth={1.7} /> 계정</h2>
          <div className="mt-3">
            <DonorWithdrawForm code={ctx.org.code} />
          </div>
        </section>
      </div>
    </DonorShell>
  );
}
