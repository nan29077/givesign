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

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '후원 회원 마이페이지', robots: { index: false } };

const channelText: Record<string, string> = { MO: '문자', WEB: '웹', RECURRING: '정기' };

/**
 * 기관 후원 회원 마이페이지. 이 기관 후원만 보여 준다.
 * 후원 내역 연결은 휴대폰 인증으로 한다(문자 후원의 후원자 식별 기준이 휴대폰 번호다).
 */
export default async function DonorMyPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const ctx = await loadDonorContext(code);
  const base = `/donate/${ctx.org.code}`;
  if (!ctx.viewer) redirect(`${base}/login?next=${encodeURIComponent(`${base}/my`)}`);
  const me = ctx.viewer;
  const data = await donorMemberOverview(me);

  return (
    <DonorShell org={ctx.shellOrg} viewer={me} active="my" color={ctx.color} backgroundUrl={ctx.backgroundUrl}>
      <div className="space-y-5 px-5 pt-7 sm:px-7">
        <section className="flex items-center gap-4 rounded-[28px] bg-white p-5 shadow-[0_12px_24px_-8px_rgba(0,0,0,0.08)]">
          <GeneratedAvatar seed={me.id} avatarIndex={me.avatarIndex} name={me.name} className="h-14 w-14" />
          <div className="min-w-0">
            <p className="truncate text-[18px] font-black text-ink-900">{me.name}님</p>
            <p className="truncate text-[12.5px] text-ink-500">{me.email}</p>
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
          <h2 className="text-[15px] font-black text-ink-900">후원 내역</h2>
          {!data.linked ? (
            <p className="mt-2 text-[13px] text-ink-500">휴대폰 인증을 마치면 후원 내역이 표시됩니다.</p>
          ) : data.charges.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-500">아직 이 기관에 완료된 후원이 없습니다. <Link href={base} className="font-bold underline" style={{ color: ctx.color }}>후원하러 가기</Link></p>
          ) : (
            <ul className="mt-3 divide-y divide-ink-100">
              {data.charges.map((c) => (
                <li key={c.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-bold text-ink-900">
                      {channelText[c.channel] ?? c.channel} 후원{c.campaign ? <span className="ml-1.5 text-[12px] font-semibold text-ink-400">{c.campaign.title}</span> : null}
                    </p>
                    {c.message ? <p className="mt-0.5 truncate text-[12.5px] text-ink-500">{c.message}</p> : null}
                    <p className="mt-0.5 text-[11px] text-ink-400">{c.paidAt ? formatKst(c.paidAt, false) : '-'} · <span className="font-mono">{c.transactionNo}</span>{c.anonymous ? ' · 익명' : ''}</p>
                  </div>
                  <p className="shrink-0 text-[14px] font-black tabular-nums text-ink-900">{formatWon(c.amount)}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        {data.recurring.length > 0 ? (
          <section className="rounded-[24px] border border-ink-100 bg-white p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-black text-ink-900"><Repeat size={17} strokeWidth={1.7} /> 정기후원</h2>
            <ul className="mt-3 space-y-2">
              {data.recurring.map((r) => (
                <li key={r.id} className="flex items-center justify-between rounded-2xl bg-ink-50 px-4 py-3 text-[13px]">
                  <span className="font-bold text-ink-900">매월 {r.dayOfMonth}일 {formatWon(r.amount)}</span>
                  <span className="text-ink-500">{recurringStatusLabel[r.status]?.text ?? r.status}{r.status === 'ACTIVE' ? ` · 다음 ${r.nextChargeOn.toISOString().slice(0, 10)}` : ''}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11.5px] text-ink-400">정기후원 변경·해지는 결제수단을 등록한 기브싸인 마이페이지에서 할 수 있습니다.</p>
          </section>
        ) : null}

        {data.receipts.length > 0 ? (
          <section className="rounded-[24px] border border-ink-100 bg-white p-5">
            <h2 className="flex items-center gap-2 text-[15px] font-black text-ink-900"><Receipt size={17} strokeWidth={1.7} /> 기부금영수증</h2>
            <ul className="mt-3 space-y-2">
              {data.receipts.map((r) => (
                <li key={r.id} className="flex items-center justify-between rounded-2xl bg-ink-50 px-4 py-3 text-[13px]">
                  <span className="font-bold text-ink-900">{r.taxYear}년 귀속 <span className="font-mono text-[11.5px] font-semibold text-ink-400">{r.receiptNo}</span></span>
                  <span className="font-black tabular-nums text-ink-900">{formatWon(r.totalAmount)}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11.5px] text-ink-400">영수증 원본은 발급 때 받은 문자 링크에서 열람·출력할 수 있습니다.</p>
          </section>
        ) : null}

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
