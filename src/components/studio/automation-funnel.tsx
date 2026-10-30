import Link from 'next/link';
import { ArrowRight, BellRing, Clapperboard, HandHeart, HeartHandshake } from 'lucide-react';
import { prisma } from '@/server/db';
import { addDays } from '@/lib/datetime';
import { formatNumber, formatWon } from '@/lib/money';
import { sourceLabel } from '@/lib/attribution';
import { sourceFunnel } from '@/server/services/content';

/**
 * 기관 대시보드 — 자동화 깔때기 (최근 30일).
 *   유입(콘텐츠 게시) → 전환(후원·약정·봉사 신청) → 유지(알림톡·문자 안내, 영수증)
 * 모든 숫자는 원천 테이블(결제 건·약정·신청·발송 기록)에서 바로 센다.
 */
function Step({ href, icon: Icon, title, value, sub }: { href: string; icon: typeof HeartHandshake; title: string; value: string; sub: string }) {
  return (
    <Link href={href} className="card flex-1 p-4 transition hover:-translate-y-0.5">
      <p className="flex items-center gap-1.5 text-[12px] font-bold text-ink-400"><Icon size={16} strokeWidth={1.7} /> {title}</p>
      <p className="mt-2 text-[22px] font-black tabular-nums text-ink-900">{value}</p>
      <p className="mt-0.5 text-[11.5px] text-ink-400">{sub}</p>
    </Link>
  );
}

export async function AutomationFunnel({ merchantId }: { merchantId: string }) {
  const since = addDays(new Date(), -30);
  const [published, review, funnel, alimtalk, sms, receipts, volunteers] = await Promise.all([
    prisma.contentPublish.count({ where: { item: { merchantId }, status: { in: ['PUBLISHED', 'PRIVATE_UPLOADED'] }, publishedAt: { gte: since } } }),
    prisma.contentItem.count({ where: { merchantId, status: 'REVIEW' } }),
    sourceFunnel(merchantId, since),
    prisma.mtOutboundMessage.count({ where: { merchantId, channel: 'ALIMTALK', status: 'SENT', createdAt: { gte: since } } }),
    prisma.mtOutboundMessage.count({ where: { merchantId, channel: 'SMS', status: 'SENT', createdAt: { gte: since } } }),
    prisma.donationReceipt.count({ where: { merchantId, status: 'ISSUED', issuedAt: { gte: since } } }),
    prisma.volunteerApplication.count({ where: { merchantId, status: 'RECEIVED' } }),
  ]);
  const rows = [...funnel.entries()].sort((a, b) => b[1].donations + b[1].pledges + b[1].volunteers - (a[1].donations + a[1].pledges + a[1].volunteers));
  const total = rows.reduce((a, [, v]) => ({ d: a.d + v.donations, amt: a.amt + v.amount, p: a.p + v.pledges, v: a.v + v.volunteers }), { d: 0, amt: 0n, p: 0, v: 0 });
  const sns = rows.filter(([k]) => ['YOUTUBE', 'INSTAGRAM', 'FACEBOOK'].includes(k)).reduce((a, [, v]) => a + v.donations + v.pledges + v.volunteers, 0);


  return (
    <section className="card p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[16px] font-black text-ink-900">발굴 → 전환 → 관리 (최근 30일)</h2>
        <p className="text-[12px] text-ink-400">SNS 유입 전환 {formatNumber(sns)}건</p>
      </div>
      <div className="mt-3 flex flex-col gap-2 lg:flex-row lg:items-stretch">
        <Step href="/studio/content" icon={Clapperboard} title="발굴 · 콘텐츠 게시" value={`${published}건`} sub={review ? `검토 대기 ${review}건` : '숏폼·캠페인 이미지'} />
        <ArrowRight className="hidden self-center text-ink-300 lg:block" size={18} />
        <Step href="/studio/charges" icon={HeartHandshake} title="전환 · 일시후원" value={`${formatNumber(total.d)}건`} sub={formatWon(total.amt)} />
        <ArrowRight className="hidden self-center text-ink-300 lg:block" size={18} />
        <Step href="/studio/recurring" icon={HeartHandshake} title="전환 · 정기 약정" value={`${formatNumber(total.p)}건`} sub="전자 약정서 자동 보관" />
        <ArrowRight className="hidden self-center text-ink-300 lg:block" size={18} />
        <Step href="/studio/volunteers" icon={HandHeart} title="전환 · 자원봉사" value={`${formatNumber(total.v)}건`} sub={volunteers ? `새 신청 ${volunteers}건` : '신청 접수'} />
        <ArrowRight className="hidden self-center text-ink-300 lg:block" size={18} />
        <Step href="/studio/notices" icon={BellRing} title="관리 · 안내 발송" value={`${formatNumber(alimtalk + sms)}건`} sub={`알림톡 ${alimtalk} · 문자 ${sms} · 영수증 ${receipts}`} />
      </div>
      {rows.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {rows.map(([k, v]) => (
            <span key={k} className="rounded-full bg-ink-50 px-3 py-1 text-[12px] text-ink-600">
              <b className="text-ink-900">{k === 'UNKNOWN' ? '경로 미상' : k === 'RECURRING' ? '정기 출금' : sourceLabel(k)}</b> 후원 {v.donations} · 약정 {v.pledges} · 봉사 {v.volunteers}
            </span>
          ))}
        </div>
      ) : null}
    </section>
  );
}
