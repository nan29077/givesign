import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { BadgeCheck, CalendarClock, CheckCircle2, Clock3, HeartHandshake, MessageSquareText, Phone, Repeat, ShieldCheck, UserRound, Users } from 'lucide-react';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { doneeVerified } from '@/server/services/receipts';
import {
  getDonationPage,
  listCampaigns,
  merchantDonationSummary,
  recentDonors,
  type CampaignWithStats,
} from '@/server/services/fundraising';
import { campaignProgress, campaignStatusLabel, daysLeft } from '@/lib/fundraising';
import { normalizeMerchantCode } from '@/lib/id';
import { formatNumber, formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

import { OrgLogo } from '@/components/brand/org-logo';
import { DonorShell } from '@/components/public/donor-shell';
import { getDonorMember, type DonorViewer } from '@/server/services/donor-members';
import { formatMoNumber } from '@/lib/mo-number';
import { ProgressBar } from '@/components/public/progress-bar';

/**
 * 공개 후원페이지 `/donate/[code]` 와 캠페인 상세 `/donate/[code]/campaigns/[id]`.
 *
 * 보여 주는 것: 기관 이야기 · 모금 현황 · 모금 중 캠페인(진행률) · 문자/웹/정기후원 참여 방법
 *            · 최근 후원(마스킹) · 투명성(모집등록번호·공익법인·결산 링크·담당자)
 * 후원자 전화번호 원문은 어떤 경우에도 내보내지 않는다.
 */



export async function DonationLanding({ code, campaignId }: { code: string; campaignId?: string }) {
  const org = await prisma.merchantProfile.findFirst({
    where: { code: normalizeMerchantCode(code), status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
    include: { moRoutes: { where: { status: 'ASSIGNED' }, orderBy: { assignedAt: 'desc' } } },
  });
  if (!org) notFound();

  const [page, campaigns, staff, viewer, summary] = await Promise.all([
    getDonationPage(org.id),
    listCampaigns(org.id, { publicOnly: true }),
    getSessionUser().catch(() => null),
    // 후원 회원은 이 기관 회원만 인정한다(기관마다 독립된 로그인).
    getDonorMember(org).catch(() => null),
    merchantDonationSummary(org.id),
  ]);
  // 비공개 페이지·작성 중 캠페인을 열어 볼 수 있는 사람(기관 담당자·관리자). 안내 띠는 띄우지 않는다.
  const preview = staff?.merchantId === org.id || staff?.role === 'ADMIN';
  const campaign = campaignId ? campaigns.find((c) => c.id === campaignId) ?? null : null;
  if (campaignId && !campaign) {
    // 비공개(DRAFT) 캠페인은 담당자 미리보기에서만 열린다.
    if (!preview) notFound();
    const draft = await listCampaigns(org.id, { includeArchived: true });
    const d = draft.find((c) => c.id === campaignId);
    if (!d) notFound();
    return <Landing org={org} page={page} campaigns={campaigns} campaign={d} viewer={viewer} summary={summary} donors={[]} />;
  }
  if (!page.published && !preview) {
    // 후원페이지를 아직 공개하지 않은 기관이라도 승인된 기관이면 후원은 받을 수 있다.
    // 막다른 안내 대신 간편 후원 화면(/c)으로 보낸다. 캠페인 지정은 모금 중일 때만 유지한다.
    redirect(`/c/${org.code}${campaign?.open ? `?campaign=${campaign.id}` : ''}`);
  }
  const donors = page.showRecentDonors ? await recentDonors(org.id, 12) : [];
  return <Landing org={org} page={page} campaigns={campaigns} campaign={campaign} viewer={viewer} summary={summary} donors={donors} />;
}

type Org = NonNullable<Awaited<ReturnType<typeof prisma.merchantProfile.findFirst<{ include: { moRoutes: true } }>>>>;

function Landing({
  org,
  page,
  campaigns,
  campaign,
  viewer,
  summary,
  donors,
}: {
  org: Org;
  page: Awaited<ReturnType<typeof getDonationPage>>;
  campaigns: CampaignWithStats[];
  campaign: CampaignWithStats | null;
  viewer: DonorViewer | null;
  summary: Awaited<ReturnType<typeof merchantDonationSummary>>;
  donors: Awaited<ReturnType<typeof recentDonors>>;
}) {
  const color = page.color || '#28634e';
  const route = org.moRoutes[0] ?? null;
  const keyword = campaign?.open ? campaign.code : null;
  const prefix = route?.mode === 'SHARED_PREFIX' && route.keyword ? `${route.keyword} ` : '';
  const smsBody = `${prefix}${keyword ? `${keyword} ` : ''}응원합니다`;
  const smsHref = route ? `sms:${route.phoneNumber}?body=${encodeURIComponent(smsBody)}` : null;
  const webHref = `/c/${org.code}${campaign?.open ? `?campaign=${campaign.id}` : ''}`;
  const recurringHref = `/my/recurring/new?merchant=${org.code}${campaign?.open ? `&campaign=${campaign.id}` : ''}`;
  const hero = campaign?.imageUrl || page.heroUrl || '/assets/givesign/hero.png';
  const openCampaigns = campaigns.filter((c) => c.open);
  const closedCampaigns = campaigns.filter((c) => c.status === 'CLOSED');

  const logoUrl = page.logoUrl || org.avatarUrl || null;
  const shellOrg = { code: org.code, displayName: org.displayName, logoUrl };
  const loginHint = viewer
    ? `${viewer.name}님, 함께해 주셔서 감사합니다. 후원 내역은 마이페이지에서 볼 수 있어요.`
    : '로그인하면 이 기관에서의 후원 내역을 관리할 수 있어요.';

  return (
    <DonorShell org={shellOrg} viewer={viewer} active="home" color={color} backgroundUrl={page.backgroundUrl}>
      {/* 히어로 */}
      <div className="relative mx-4 mt-5 overflow-hidden rounded-[30px] sm:mx-7">
        <Image unoptimized width={1600} height={800} src={hero} alt="" className="aspect-[16/11] w-full object-cover sm:aspect-[2/1]" priority />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(27,104,69,.88),rgba(27,104,69,.42)_55%,rgba(27,104,69,.05))]" />
        <div className="absolute inset-x-0 top-0 p-6 pt-10 text-white sm:p-10 sm:pt-16">
          <p className="inline-block rounded-full border border-white/40 bg-white/15 px-3.5 py-1.5 text-[11.5px] font-bold backdrop-blur">
            {campaign ? (campaign.open ? `모금 중 · ${daysLeft(campaign.endsOn)}일 남음` : campaignStatusLabel[campaign.status].text) : '함께 만드는 따뜻한 변화'}
          </p>
          <h1 className="mt-3 max-w-xl text-[22px] font-black leading-snug tracking-[-0.03em] sm:text-[28px]">{campaign?.title ?? page.title}</h1>
          <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed opacity-95 sm:text-[15px]">{campaign?.summary ?? page.subtitle}</p>
        </div>
      </div>

      {/* 기관 프로필 카드 (히어로에 겹쳐 올라온다) */}
      <section className="relative z-[1] mx-6 -mt-14 rounded-[32px] bg-white px-5 pb-6 pt-7 text-center shadow-[0_20px_25px_-5px_rgba(0,0,0,0.08),0_8px_10px_-6px_rgba(0,0,0,0.08)] sm:mx-12 sm:-mt-20 sm:px-8">
        <OrgLogo code={org.code} name={org.displayName} logoUrl={logoUrl} className="mx-auto h-20 w-20" />
        <h2 className="mt-4 text-[22px] font-black tracking-[-0.02em] text-ink-900">{org.displayName}</h2>
        {doneeVerified(org) ? (
          <p className="mt-1.5 flex items-center justify-center gap-1 text-[12px] font-bold" style={{ color }}>
            <BadgeCheck size={14} strokeWidth={1.8} /> 기부금영수증 발급 기관
          </p>
        ) : null}

        {campaign ? (
          <div className="mt-5 rounded-2xl bg-[#f7f6ee] p-4 text-left">
            <CampaignProgress c={campaign} color={color} large />
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-[12px]">
              <div><dt className="text-ink-400">후원자</dt><dd className="font-extrabold text-ink-900">{formatNumber(campaign.stats.donorCount)}명</dd></div>
              <div><dt className="text-ink-400">후원 건수</dt><dd className="font-extrabold text-ink-900">{formatNumber(campaign.stats.chargeCount)}건</dd></div>
              <div><dt className="text-ink-400">기간</dt><dd className="font-extrabold text-ink-900">{campaign.startsOn.toISOString().slice(5, 10)}~{campaign.endsOn.toISOString().slice(5, 10)}</dd></div>
            </dl>
          </div>
        ) : page.showProgress ? (
          <div className="mt-5 grid grid-cols-3 gap-2.5">
            <Stat tone="bg-[#f7f6ee]" color={color} icon={<HeartHandshake size={17} strokeWidth={1.7} />} label="누적 모금액" value={formatWon(summary.totalRaised)} />
            <Stat tone="bg-[#f8f1e7]" color={color} icon={<CalendarClock size={17} strokeWidth={1.7} />} label="이번 달" value={formatWon(summary.monthRaised)} />
            <Stat tone="bg-[#eef5ed]" color={color} icon={<Users size={17} strokeWidth={1.7} />} label="후원 참여자" value={`${formatNumber(summary.totalDonors)}명`} />
          </div>
        ) : null}

        <p className="mt-4 rounded-2xl bg-[#eef6ef] px-4 py-3 text-[13px] leading-6" style={{ color }}>
          여러분의 후원은 {org.displayName}의 이웃들에게 전달됩니다.
        </p>

        {campaign && !campaign.open ? (
          <p className="mt-3 rounded-2xl bg-ink-50 px-4 py-3 text-[12.5px] text-ink-600">
            {campaign.status === 'CLOSED' ? '모금이 끝난 캠페인입니다. 기관 일반 후원으로 참여하실 수 있습니다.' : '모금 기간이 아닙니다.'}
          </p>
        ) : null}

        <div className="mt-4 grid grid-cols-3 gap-2">
          {smsHref ? (
            <MethodButton href={smsHref} color={color} icon={<MessageSquareText size={17} strokeWidth={1.8} />} label="문자" external />
          ) : (
            <span className="flex h-12 items-center justify-center rounded-2xl bg-ink-100 text-[13px] font-bold text-ink-400">문자 준비 중</span>
          )}
          <MethodButton href={webHref} color={color} icon={<Phone size={17} strokeWidth={1.8} />} label="웹 후원" />
          <MethodButton href={recurringHref} color={color} icon={<Repeat size={17} strokeWidth={1.8} />} label="정기후원" />
        </div>
        {route ? (
          <p className="mt-3 text-[12.5px] text-ink-500">
            후원 문자 번호 <span className="font-mono font-extrabold" style={{ color }}>{formatMoNumber(route.phoneNumber)}</span>
            {keyword || prefix ? <> · 맨 앞에 <span className="font-mono font-extrabold">{`${prefix}${keyword ?? ''}`.trim()}</span></> : null}
          </p>
        ) : null}
        <p className="mt-2 text-[11.5px] text-ink-400">{loginHint}</p>
      </section>

      <div className="space-y-10 px-5 pt-10 sm:px-7">
        {/* 캠페인 상세 본문 */}
        {campaign ? (
          <>
            <TextSection title="함께 만드는 변화" body={campaign.story || page.intro || '캠페인 소개를 준비하고 있습니다.'} />
            {campaign.beneficiary ? <TextSection title="지원 대상" body={campaign.beneficiary} /> : null}
            {campaign.usagePlan ? <TextSection title="후원금 사용 계획" body={campaign.usagePlan} /> : null}
            {campaign.status === 'CLOSED' && campaign.resultReport ? <TextSection title="결과 보고" body={campaign.resultReport} /> : null}
          </>
        ) : null}

        {/* 문자후원 내역 */}
        {donors.length > 0 ? (
          <section>
            <SectionHead title="문자후원 내역" />
            <ul className="grid gap-3 sm:grid-cols-3">
              {donors.map((d, i) => (
                <li key={i} className="flex flex-col rounded-[24px] border border-ink-100 bg-white p-4 shadow-[0_2px_10px_rgba(23,22,26,0.04)]">
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-600">
                        <MessageSquareText size={17} strokeWidth={1.7} />
                      </span>
                      <span className="truncate text-[16px] font-black tabular-nums text-ink-900">{formatWon(d.amount)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#eef6ef] px-2 py-1 text-[11px] font-bold" style={{ color }}>
                      <CheckCircle2 size={12} strokeWidth={2} /> 완료
                    </span>
                  </div>
                  <p className="mt-3 min-h-[52px] flex-1 whitespace-pre-wrap break-words rounded-2xl bg-ink-50 px-3.5 py-3 text-[13px] leading-relaxed text-ink-700">
                    {d.message || (d.name === '익명' ? '익명으로 마음을 전했습니다.' : '응원합니다')}
                  </p>
                  <div className="mt-3 border-t border-ink-100 pt-3 text-[11.5px] text-ink-500">
                    <p className="flex items-center gap-1.5 font-bold text-ink-700">
                      <UserRound size={13} strokeWidth={1.8} /> {d.name}
                      {d.recurring ? <span className="rounded-md bg-[#eef6ef] px-1.5 text-[10.5px]" style={{ color }}>정기</span> : null}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5"><Clock3 size={13} strokeWidth={1.8} /> {formatKst(d.paidAt, false)}</p>
                    {d.campaignTitle ? <p className="mt-1 truncate text-ink-400">{d.campaignTitle}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* 캠페인 */}
        {!campaign && page.showCampaigns && (openCampaigns.length > 0 || closedCampaigns.length > 0) ? (
          <section id="donation-campaigns" className="scroll-mt-6">
            <SectionHead title="모금 캠페인" />
            {openCampaigns.length === 0 ? <p className="text-[13.5px] text-ink-500">새로운 캠페인을 준비하고 있습니다.</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              {openCampaigns.map((c) => (
                <Link key={c.id} href={`/donate/${org.code}/campaigns/${c.id}`} className="group overflow-hidden rounded-[24px] border border-ink-100 bg-white shadow-[0_2px_10px_rgba(23,22,26,0.04)] transition-shadow hover:shadow-lg">
                  <Image unoptimized width={800} height={450} src={c.imageUrl || page.heroUrl || '/assets/givesign/hero.png'} alt="" className="aspect-video w-full object-cover" />
                  <div className="p-4">
                    <p className="text-[11.5px] font-bold" style={{ color }}>{c.featured ? '집중 모금 · ' : ''}{daysLeft(c.endsOn)}일 남음</p>
                    <h3 className="mt-1 text-[15.5px] font-extrabold text-ink-900 group-hover:underline">{c.title}</h3>
                    <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-500">{c.summary}</p>
                    <div className="mt-3"><CampaignProgress c={c} color={color} /></div>
                  </div>
                </Link>
              ))}
            </div>
            {closedCampaigns.length ? (
              <details className="mt-3 rounded-2xl border border-ink-100 bg-white px-4 py-3">
                <summary className="cursor-pointer text-[13px] font-bold text-ink-500">종료된 캠페인 {closedCampaigns.length}개</summary>
                <ul className="mt-2 divide-y divide-ink-100 text-[13px]">
                  {closedCampaigns.map((c) => (
                    <li key={c.id} className="flex items-center justify-between gap-3 py-2">
                      <Link href={`/donate/${org.code}/campaigns/${c.id}`} className="truncate font-semibold text-ink-800 hover:underline">{c.title}</Link>
                      <span className="shrink-0 tabular-nums text-ink-500">{formatWon(c.stats.raised)}{c.resultReport ? ' · 결과 보고' : ''}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </section>
        ) : null}

        {!campaign ? <TextSection title="우리 기관의 이야기" body={page.intro || '기관 소개를 준비하고 있습니다.'} /> : null}

        {page.thanks ? (
          <blockquote className="flex items-start gap-3 rounded-[24px] border border-ink-100 bg-white p-5 text-[14px] leading-7 text-ink-700 shadow-[0_2px_10px_rgba(23,22,26,0.04)]">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full" style={{ backgroundColor: `color-mix(in srgb, ${color} 12%, white)`, color }}>
              <HeartHandshake size={18} strokeWidth={1.7} />
            </span>
            <span className="min-w-0 pt-0.5">{page.thanks}</span>
          </blockquote>
        ) : null}

        {route ? (
          <section className="rounded-[24px] border border-ink-100 bg-white p-5 text-[13px] leading-relaxed text-ink-700">
            <h2 className="text-[15px] font-black text-ink-900">문자로 후원하는 방법</h2>
            <ol className="mt-3 list-decimal space-y-1.5 pl-4">
              <li>
                <span className="font-mono font-extrabold" style={{ color }}>{formatMoNumber(route.phoneNumber)}</span> 로{' '}
                {keyword || prefix ? <>문자 맨 앞에 <span className="font-mono font-extrabold">{`${prefix}${keyword ?? ''}`.trim()}</span> 을 적고 </> : null}
                응원 메시지를 보냅니다.
              </li>
              <li>답장 문자의 링크에서 후원 금액을 고르고 PIN 을 입력하면 후원이 완료됩니다.</li>
              <li>처음이라면 결제수단(내통장결제) 등록 안내가 먼저 옵니다. 문자만으로는 출금되지 않습니다.</li>
            </ol>
            {keyword ? <p className="mt-2 text-[12px] text-ink-500">키워드 없이 보내면 기관 일반 후원으로 접수됩니다.</p> : null}
          </section>
        ) : null}

        <section className="rounded-[24px] border border-ink-100 bg-white p-5">
          <h2 className="flex items-center gap-2 text-[15px] font-black text-ink-900"><ShieldCheck size={18} strokeWidth={1.7} /> 투명한 운영</h2>
          <dl className="mt-3 grid gap-2 text-[12.5px] sm:grid-cols-2">
            <Row k="기관명" v={org.displayName} />
            {org.representativeName ? <Row k="대표자" v={org.representativeName} /> : null}
            {org.businessNo ? <Row k="고유번호" v={org.businessNo} /> : null}
            {org.address ? <Row k="소재지" v={org.address} /> : null}
            <Row k="기부금영수증" v={doneeVerified(org) ? '발급 가능 (공익법인 지정)' : '기관에 문의'} />
            {org.fundraisingRegNo ? <Row k="기부금품 모집등록" v={`${org.fundraisingRegNo}${org.fundraisingRegAuthority ? ` (${org.fundraisingRegAuthority})` : ''}`} /> : null}
            {org.contactPhone || org.contactName ? <Row k="후원 담당" v={`${org.contactName ?? ''} ${org.contactPhone ?? ''}`.trim()} /> : null}
            {page.transparencyUrl ? <Row k="결산·사업보고" v={<a href={page.transparencyUrl} target="_blank" rel="noreferrer" className="font-bold underline" style={{ color }}>공시 보기</a>} /> : null}
          </dl>
          <p className="mt-3 text-[11.5px] leading-relaxed text-ink-400">
            후원금은 기브싸인 정산을 거쳐 기관 계좌로 지급되며, 결제가 완료된 후원만 집계·영수증에 반영됩니다. 환불은 기관 정책에 따릅니다.
          </p>
        </section>

        {campaign ? <Link href={`/donate/${org.code}`} className="block text-center text-[13px] font-bold text-ink-500 underline">기관 후원페이지로</Link> : null}
      </div>
    </DonorShell>
  );
}

function MethodButton({ href, color, icon, label, external = false }: { href: string; color: string; icon: React.ReactNode; label: string; external?: boolean }) {
  const cls = 'flex h-12 items-center justify-center gap-1.5 rounded-2xl text-[14px] font-extrabold text-white shadow-[0_6px_14px_rgba(27,104,69,0.18)] transition-transform hover:-translate-y-0.5';
  return external ? (
    <a href={href} className={cls} style={{ backgroundColor: color }}>{icon}{label}</a>
  ) : (
    <Link href={href} className={cls} style={{ backgroundColor: color }}>{icon}{label}</Link>
  );
}

function SectionHead({ title }: { title: string }) {
  return <h2 className="mb-3 text-[18px] font-black tracking-[-0.02em] text-ink-900">{title}</h2>;
}

function TextSection({ title, body }: { title: string; body: string }) {
  return (
    <section>
      <SectionHead title={title} />
      <p className="whitespace-pre-wrap rounded-[24px] border border-ink-100 bg-white p-5 text-[14px] leading-7 text-ink-700">{body}</p>
    </section>
  );
}

function CampaignProgress({ c, color, large = false }: { c: CampaignWithStats; color: string; large?: boolean }) {
  const p = campaignProgress(c.stats.raised, c.goalAmount);
  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <span className={large ? 'text-[26px] font-black tabular-nums text-ink-900' : 'text-[15px] font-black tabular-nums text-ink-900'}>{formatWon(c.stats.raised)}</span>
        <span className="text-[12px] text-ink-500">목표 {formatWon(c.goalAmount)} · <strong style={{ color }}>{p.percent}%</strong></span>
      </div>
      <ProgressBar percent={p.capped} color={color} className="mt-1.5" height={large ? 'h-3.5' : 'h-2'} />
    </div>
  );
}

function Stat({ icon, label, value, tone, color }: { icon: React.ReactNode; label: string; value: string; tone: string; color: string }) {
  return (
    <div className={`rounded-2xl px-2 py-4 ${tone}`}>
      <p className="flex justify-center" style={{ color }}>{icon}</p>
      <p className="mt-1.5 truncate text-[14px] font-black tabular-nums tracking-[-0.02em] text-ink-900 sm:text-[16px]">{value}</p>
      <p className="mt-0.5 text-[11px] text-ink-400">{label}</p>
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-ink-400">{k}</dt>
      <dd className="min-w-0 break-words font-semibold text-ink-800">{v}</dd>
    </div>
  );
}
