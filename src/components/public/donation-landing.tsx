import Image from 'next/image';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { BadgeCheck, CalendarClock, HeartHandshake, MessageSquareText, Phone, Repeat, ShieldCheck, Users } from 'lucide-react';
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
import { isLocal } from '@/lib/env';

import { PublicMarginMascots } from '@/components/brand/mascot-decorations';
import { formatMoNumber } from '@/lib/mo-number';
import { ProgressBar } from '@/components/public/progress-bar';
import { ProfileAvatar } from '@/components/profile/generated-avatar';

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

  const [page, campaigns, viewer, summary] = await Promise.all([
    getDonationPage(org.id),
    listCampaigns(org.id, { publicOnly: true }),
    getSessionUser().catch(() => null),
    merchantDonationSummary(org.id),
  ]);
  const preview = viewer?.merchantId === org.id || viewer?.role === 'ADMIN';
  const campaign = campaignId ? campaigns.find((c) => c.id === campaignId) ?? null : null;
  if (campaignId && !campaign) {
    // 비공개(DRAFT) 캠페인은 담당자 미리보기에서만 열린다.
    if (!preview) notFound();
    const draft = await listCampaigns(org.id, { includeArchived: true });
    const d = draft.find((c) => c.id === campaignId);
    if (!d) notFound();
    return <Landing org={org} page={page} campaigns={campaigns} campaign={d} preview summary={summary} donors={[]} />;
  }
  if (!page.published && !preview) {
    // 후원페이지를 아직 공개하지 않은 기관이라도 승인된 기관이면 후원은 받을 수 있다.
    // 막다른 안내 대신 간편 후원 화면(/c)으로 보낸다. 캠페인 지정은 모금 중일 때만 유지한다.
    redirect(`/c/${org.code}${campaign?.open ? `?campaign=${campaign.id}` : ''}`);
  }
  const donors = page.showRecentDonors ? await recentDonors(org.id, 12) : [];
  return <Landing org={org} page={page} campaigns={campaigns} campaign={campaign} preview={preview} summary={summary} donors={donors} />;
}

type Org = NonNullable<Awaited<ReturnType<typeof prisma.merchantProfile.findFirst<{ include: { moRoutes: true } }>>>>;

function Landing({
  org,
  page,
  campaigns,
  campaign,
  preview,
  summary,
  donors,
}: {
  org: Org;
  page: Awaited<ReturnType<typeof getDonationPage>>;
  campaigns: CampaignWithStats[];
  campaign: CampaignWithStats | null;
  preview: boolean;
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

  return (
    <main className="donation-canvas relative isolate min-h-screen pb-24" style={{ ['--org' as string]: color }}>
      <PublicMarginMascots src={page.backgroundUrl} /><div className="donation-app"><header className="flex items-center justify-between border-b border-stone-200 px-6 py-5">
        <Link href={`/donate/${org.code}`} aria-label={`${org.displayName} 후원 홈`} className="min-w-0 flex-1 pr-4">{page.logoUrl ? <Image unoptimized src={page.logoUrl} width={220} height={64} alt={`${org.displayName} 로고`} className="h-12 w-auto max-w-full object-contain object-left" priority /> : <span className="block break-words text-lg font-black leading-snug text-ink-900">{org.displayName}</span>}</Link>
        <nav className="flex shrink-0 items-center gap-4 text-[13px] font-bold text-ink-600">
          <Link href="/how-it-works">이용 안내</Link>
          <Link href="/my">마이페이지</Link>
        </nav>
      </header>

      {preview ? (
        <p className="mx-auto mb-3 max-w-[720px] rounded-xl border border-warning-500/30 bg-warning-50 px-5 py-2.5 text-[13px] text-ink-800">
          담당자 미리보기 · 후원페이지 {page.published ? '공개' : '비공개'}
          {campaign ? ` · 캠페인 ${campaignStatusLabel[campaign.status].text}` : ''}
          {' · '}<Link href="/studio/donation-page" className="font-bold underline">페이지 설정</Link>
        </p>
      ) : null}
      {isLocal ? (
        <p className="mx-auto mb-3 max-w-5xl px-5 text-[12px] text-ink-400">로컬 테스트 환경입니다. 표시된 MO 번호와 결제 흐름은 검수용이며 실제 후원 결제가 아닙니다.</p>
      ) : null}

      <div className="mx-auto max-w-5xl overflow-hidden bg-white">
        {/* 히어로 */}
        <div className="donation-hero relative mx-4 mt-5 overflow-hidden rounded-[30px] sm:mx-8">
          <Image unoptimized width={1600} height={800} src={hero} alt="" className="aspect-[4/3] w-full object-cover sm:aspect-[16/9]" priority />
          <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(27,104,69,.9),rgba(27,104,69,.45)_52%,rgba(27,104,69,.08))]" />
          <div className="absolute bottom-0 left-0 right-0 p-6 text-white sm:p-10">
            <p className="inline-block rounded-full bg-white/20 px-4 py-2 text-xs font-bold backdrop-blur">함께 만드는 따뜻한 변화</p>
            <h1 className="mt-4 max-w-3xl text-[24px] font-black leading-snug tracking-[-0.03em] sm:text-[30px]">{campaign?.title ?? page.title}</h1>
            <p className="mt-2 max-w-2xl text-[15px] leading-relaxed opacity-95 sm:text-[17px]">{campaign?.summary ?? page.subtitle}</p>
          </div>
        </div>

        <section className="donation-profile mx-6 mt-8 border-b border-stone-100 bg-white pb-8 pt-2 text-center sm:mx-8">
          {page.logoUrl ? <Image unoptimized src={page.logoUrl} width={96} height={96} alt="기관 로고" className="mx-auto h-20 w-20 rounded-[24px] border-4 border-white bg-white object-contain shadow-lg" /> : <ProfileAvatar seed={org.code} name={org.displayName} imageUrl={org.avatarUrl} className="mx-auto h-20 w-20 rounded-[24px]" />}
          <h2 className="mt-5 text-[23px] font-black text-ink-900">{org.displayName}</h2>
          {doneeVerified(org) && <p className="mt-2 flex items-center justify-center gap-1 text-xs font-bold" style={{color}}><BadgeCheck size={14} /> 기부금영수증 발급 가능</p>}
          {!campaign && page.showProgress && <div className="mt-6 grid grid-cols-3 gap-2"><Stat icon={<HeartHandshake size={16} />} label="누적 모금액" value={formatWon(summary.totalRaised)} /><Stat icon={<CalendarClock size={16} />} label="이번 달" value={formatWon(summary.monthRaised)} /><Stat icon={<Users size={16} />} label="후원 참여자" value={formatNumber(summary.totalDonors)+'명'} /></div>}
          <p className="mt-5 rounded-2xl bg-[#eef6ef] px-4 py-3 text-sm leading-6" style={{color}}>여러분의 후원은 {org.displayName}의 이웃들에게 전달됩니다.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">{smsHref && <a href={smsHref} className="flex h-12 items-center justify-center gap-2 rounded-2xl text-sm font-bold text-white" style={{background:color}}><MessageSquareText size={17} /> 문자후원</a>}<Link href={webHref} className="flex h-12 items-center justify-center gap-2 rounded-2xl text-sm font-bold text-white" style={{background:color}}><Phone size={17} /> 웹 후원</Link><Link href={recurringHref} className="flex h-12 items-center justify-center gap-2 rounded-2xl text-sm font-bold text-white" style={{background:color}}><Repeat size={17} /> 정기후원</Link></div>
          {route && <p className="mt-4 font-mono text-base font-extrabold" style={{color}}>{formatMoNumber(route.phoneNumber)}</p>}
        </section>
        <div className="donation-body flex flex-col gap-8 p-6 sm:p-8">
          {/* 본문 */}
          <div className="min-w-0 space-y-10">
            {campaign ? (
              <section className="rounded-2xl border border-ink-100 p-5">
                <CampaignProgress c={campaign} color={color} large />
                <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
                  <div><dt className="text-ink-400">후원자</dt><dd className="font-extrabold text-ink-900">{formatNumber(campaign.stats.donorCount)}명</dd></div>
                  <div><dt className="text-ink-400">후원 건수</dt><dd className="font-extrabold text-ink-900">{formatNumber(campaign.stats.chargeCount)}건</dd></div>
                  <div><dt className="text-ink-400">모금 기간</dt><dd className="font-extrabold text-ink-900">{campaign.startsOn.toISOString().slice(5, 10)} ~ {campaign.endsOn.toISOString().slice(5, 10)}</dd></div>
                  <div><dt className="text-ink-400">상태</dt><dd className="font-extrabold text-ink-900">{campaign.open ? `${daysLeft(campaign.endsOn)}일 남음` : campaignStatusLabel[campaign.status].text}</dd></div>
                </dl>
              </section>
            ) : null}

            <section>
              <h2 className="text-[20px] font-black tracking-[-0.02em] text-ink-900">{campaign ? '함께 만드는 변화' : '우리 기관의 이야기'}</h2>
              <p className="mt-4 whitespace-pre-wrap text-[15px] leading-8 text-ink-700">{campaign?.story || page.intro || '기관 소개를 준비하고 있습니다.'}</p>
            </section>
            {campaign?.beneficiary ? (
              <section><h2 className="text-[18px] font-black text-ink-900">지원 대상</h2><p className="mt-3 whitespace-pre-wrap leading-7 text-ink-700">{campaign.beneficiary}</p></section>
            ) : null}
            {campaign?.usagePlan ? (
              <section><h2 className="text-[18px] font-black text-ink-900">후원금 사용 계획</h2><p className="mt-3 whitespace-pre-wrap leading-7 text-ink-700">{campaign.usagePlan}</p></section>
            ) : null}
            {campaign?.status === 'CLOSED' && campaign.resultReport ? (
              <section className="rounded-2xl bg-success-50 p-5"><h2 className="text-[18px] font-black text-ink-900">결과 보고</h2><p className="mt-3 whitespace-pre-wrap leading-7 text-ink-700">{campaign.resultReport}</p></section>
            ) : null}

            {!campaign && page.showCampaigns && (openCampaigns.length > 0 || closedCampaigns.length > 0) ? (
              <section id="donation-campaigns">
                <h2 className="text-[20px] font-black tracking-[-0.02em] text-ink-900">진행 중인 캠페인</h2>
                {openCampaigns.length === 0 ? <p className="mt-3 text-ink-500">새로운 캠페인을 준비하고 있습니다.</p> : null}
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {openCampaigns.map((c) => (
                    <Link key={c.id} href={`/donate/${org.code}/campaigns/${c.id}`} className="group overflow-hidden rounded-2xl border border-ink-100 transition-shadow hover:shadow-lg">
                      <Image unoptimized width={800} height={450} src={c.imageUrl || page.heroUrl || '/assets/givesign/hero.png'} alt="" className="aspect-video w-full object-cover" />
                      <div className="p-4">
                        <p className="text-[11.5px] font-bold" style={{ color }}>{c.featured ? '집중 모금 · ' : ''}{daysLeft(c.endsOn)}일 남음</p>
                        <h3 className="mt-1 text-[16px] font-extrabold text-ink-900 group-hover:underline">{c.title}</h3>
                        <p className="mt-1 line-clamp-2 text-[13px] text-ink-500">{c.summary}</p>
                        <div className="mt-3"><CampaignProgress c={c} color={color} /></div>
                      </div>
                    </Link>
                  ))}
                </div>
                {closedCampaigns.length ? (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-[13px] font-bold text-ink-500">종료된 캠페인 {closedCampaigns.length}개 보기</summary>
                    <ul className="mt-2 divide-y divide-ink-100 text-[13px]">
                      {closedCampaigns.map((c) => (
                        <li key={c.id} className="flex items-center justify-between py-2">
                          <Link href={`/donate/${org.code}/campaigns/${c.id}`} className="font-semibold text-ink-800 hover:underline">{c.title}</Link>
                          <span className="tabular-nums text-ink-500">{formatWon(c.stats.raised)} 모금{c.resultReport ? ' · 결과 보고' : ''}</span>
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </section>
            ) : null}

            {donors.length > 0 ? (
              <section>
                <h2 className="text-[20px] font-black tracking-[-0.02em] text-ink-900">최근 함께한 분들</h2>
                <ul className="mt-4 grid gap-3 sm:grid-cols-3">
                  {donors.map((d, i) => (
                    <li key={i} className="flex items-start justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-extrabold text-ink-900">
                          {d.name}
                          {d.recurring ? <span className="ml-1.5 rounded-md bg-white px-1.5 py-0.5 text-[10.5px] font-bold" style={{ color }}>정기</span> : null}
                          {d.campaignTitle ? <span className="ml-1.5 text-[11.5px] font-semibold text-ink-400">{d.campaignTitle}</span> : null}
                        </p>
                        {d.message ? <p className="mt-0.5 truncate text-[12.5px] text-ink-500">{d.message}</p> : null}
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-[13.5px] font-black tabular-nums text-ink-900">{formatWon(d.amount)}</p>
                        <p className="text-[11px] text-ink-400">{formatKst(d.paidAt, false).slice(0, 10)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            {page.thanks ? (
              <blockquote className="rounded-2xl border-l-4 bg-ink-50 p-5 text-[14.5px] leading-7 text-ink-700" style={{ borderColor: color }}>{page.thanks}</blockquote>
            ) : null}

            <section className="rounded-2xl border border-ink-100 p-5">
              <h2 className="flex items-center gap-2 text-[15px] font-black text-ink-900"><ShieldCheck size={18} strokeWidth={1.7} /> 투명한 운영</h2>
              <dl className="mt-3 grid gap-2 text-[13px] sm:grid-cols-2">
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
          </div>

          {/* 참여 카드 (sticky) */}
          <aside id="donation-participation" className="w-full">
            <div className="rounded-2xl border border-stone-200 bg-[#fafbf8] p-5">
              <p className="text-[12px] font-bold text-ink-400">{campaign ? '이 캠페인에 후원하기' : '후원 참여하기'}</p>
              {campaign && !campaign.open ? (
                <p className="mt-3 rounded-xl bg-ink-50 p-3 text-[13px] text-ink-600">
                  {campaign.status === 'CLOSED' ? '모금이 종료된 캠페인입니다. 기관 일반 후원으로 참여하실 수 있습니다.' : '모금 기간이 아닙니다.'}
                </p>
              ) : null}

              <div className="mt-3 space-y-2.5">
                {smsHref ? (
                  <a href={smsHref} className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[15px] font-extrabold text-white shadow-md transition-transform hover:-translate-y-0.5" style={{ backgroundColor: color }}>
                    <MessageSquareText size={18} strokeWidth={1.8} /> 문자로 후원하기
                  </a>
                ) : (
                  <p className="rounded-xl bg-ink-50 p-3 text-[13px] text-ink-500">기관 전용 문자 번호를 준비 중입니다.</p>
                )}
                <Link href={webHref} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-ink-200 bg-white text-[14px] font-extrabold text-ink-900 hover:bg-ink-50">
                  <Phone size={16} strokeWidth={1.8} /> PC·웹에서 후원하기
                </Link>
                <Link href={recurringHref} className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-ink-200 bg-white text-[14px] font-extrabold text-ink-900 hover:bg-ink-50">
                  <Repeat size={16} strokeWidth={1.8} /> 매월 정기후원 신청
                </Link>
              </div>

              {route ? (
                <div className="mt-4 rounded-xl bg-ink-50 p-4 text-[13px] leading-relaxed text-ink-700">
                  <p className="font-extrabold text-ink-900">문자 후원 방법</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-4">
                    <li>
                      <span className="font-mono font-extrabold" style={{ color }}>{formatMoNumber(route.phoneNumber)}</span> 로{' '}
                      {keyword || prefix ? <>문자 맨 앞에 <span className="font-mono font-extrabold">{`${prefix}${keyword ?? ''}`.trim()}</span> 을 적고 </> : null}
                      응원 메시지를 보냅니다.
                    </li>
                    <li>답장 문자의 링크에서 후원 금액을 고르고 PIN 을 입력하면 결제됩니다.</li>
                    <li>처음이라면 결제수단(내통장결제) 등록 안내가 먼저 옵니다. 문자만으로는 결제되지 않습니다.</li>
                  </ol>
                  {keyword ? <p className="mt-2 text-[12px] text-ink-500">키워드 없이 보내면 기관 일반 후원으로 접수됩니다.</p> : null}
                </div>
              ) : null}

              <p className="mt-4 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-ink-400">
                <CalendarClock size={13} strokeWidth={1.7} className="mt-0.5 shrink-0" />
                {campaign
                  ? '캠페인 모금액은 결제가 완료된 후원만 집계되며 환불 시 차감됩니다.'
                  : page.showProgress
                    ? `이달 ${formatWon(summary.monthRaised)} · ${formatNumber(summary.monthCharges)}건의 마음이 모였습니다.`
                    : '결제가 완료된 후원만 기관에 전달됩니다.'}
              </p>
            </div>
            {campaign ? <Link href={`/donate/${org.code}`} className="mt-3 block text-center text-[13px] font-bold text-ink-500 underline">기관 후원페이지로</Link> : null}
          </aside>
        </div>
      </div>

      <footer className="donation-footer">
        <p className="text-sm font-bold text-[#07513d]">{org.displayName}</p>
        <nav aria-label="법적 안내" className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-2">
          <Link href="/terms">이용약관</Link><Link href="/privacy" className="font-bold text-ink-700">개인정보처리방침</Link><Link href="/terms/e-finance">전자금융거래약관</Link><Link href="/support">고객센터</Link>
        </nav>
        <p className="mt-5 text-[11px] text-ink-400">후원과 이웃을 잇는 기브싸인 · GiveSign</p>
      </footer></div>
      <nav className="donation-rail" aria-label="기관 후원 메뉴"><ProfileAvatar seed={org.code} name={org.displayName} imageUrl={page.logoUrl || org.avatarUrl} className="mx-auto h-16 w-16 rounded-[20px]" /><p className="mt-3 whitespace-normal text-center text-xs font-black leading-5 [overflow-wrap:anywhere]">{org.displayName}</p><div className="my-5 h-px bg-ink-100" /><Link href={`/donate/${org.code}`} className="donation-rail-link"><HeartHandshake size={21} />기관 홈</Link><a href="#donation-campaigns" className="donation-rail-link"><MessageSquareText size={21} />모금 캠페인</a><Link href="/my" className="donation-rail-link"><Users size={21} />마이페이지</Link><Link href="/login" className="donation-rail-login">로그인</Link></nav>
    </main>
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

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-ink-100 p-4">
      <p className="flex items-center gap-1.5 text-[11.5px] font-bold text-ink-400">{icon}{label}</p>
      <p className="mt-1.5 text-[18px] font-black tabular-nums tracking-[-0.02em] text-ink-900 sm:text-[22px]">{value}</p>
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
