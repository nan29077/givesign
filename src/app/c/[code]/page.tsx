import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { formatMoNumber } from '@/lib/mo-number';
import Link from 'next/link';
import {
  MessageSquare, CreditCard, ShieldCheck, CircleAlert,
  Gauge, Flag, Phone, BellRing, Smartphone, MonitorSmartphone,
} from 'lucide-react';
import { CopyButton } from '@/components/public/copy-button';
import { WebChargePanel } from '@/components/public/web-charge-panel';
import { WebChargePinPanel } from '@/components/public/web-charge-pin-panel';
import { openCampaigns, recentDonors } from '@/server/services/fundraising';
import { resolveChargeBanner } from '@/lib/banners';
import { ProfileAvatar } from '@/components/profile/generated-avatar';
import { LinkButton } from '@/components/ui';
import { normalizeMerchantCode } from '@/lib/id';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { prisma } from '@/server/db';
import { getSessionUser } from '@/server/auth';
import { displayPayerName, defaultPayerName } from '@/lib/payer-name';
import { resolvePolicy } from '@/server/services/limits';
import { getPaymentAdapter } from '@/server/adapters/payment';
import { resolveWebChargeChannel } from '@/server/services/web-charge';

export const dynamic = 'force-dynamic';

/**
 * 기관 문자후원 페이지 (`/c/[code]`, 후원페이지 `/donate/[code]` 의 호환 경로).
 *
 * 메인 서비스(PublicShell)의 하단 탭·우측 메뉴를 쓰지 않는 독립 페이지다.
 *  - 상단은 기관 아이덴티티(아바타·이름·서비스)가 차지하고
 *  - 기브싸인 브랜드는 하단 풋터에 서비스 표기로만 남긴다.
 *  - 모바일: 문자후원(번호·문자 보내기)이 먼저, 그 아래 웹 후원(PIN) 패널(`#web`).
 *    후원페이지의 "웹 후원" 버튼은 `#web` 으로 바로 닿는다(점검 F H-1).
 *  - PC: 웹 후원 패널이 먼저, 그 아래 문자 번호 안내.
 */

type Params = { params: Promise<{ code: string }>; searchParams?: Promise<{ campaign?: string }> };

/**
 * 로그인한 방문자의 후원자 프로필. 없으면 null.
 * 세션·프로필 조회 실패가 후원 페이지 자체를 막지 않도록 전부 흡수한다.
 */
async function currentViewerPayer() {
  try {
    const user = await getSessionUser();
    if (!user) return null;
    return await prisma.payerProfile.findUnique({
      where: { userId: user.id },
      select: { displayName: true, phoneMasked: true },
    });
  } catch {
    return null;
  }
}

async function findMerchant(rawCode: string) {
  const code = normalizeMerchantCode(rawCode);
  if (!/^GIV-[A-Z0-9]{2,10}$/.test(code)) return null;
  return prisma.merchantProfile.findFirst({
    where: {
      code,
      status: 'APPROVED',
      // 계정 자체가 정지·탈퇴된 기관의 후원 페이지는 닫아야 한다.
      // merchantProfile.status 만 보면 User 를 SUSPENDED 로 제재해도 페이지가 계속 열려
      // 정지 계정에 후원이 계속 쌓인다. 탈퇴(deletedAt)도 /donate 와 같은 기준으로 막는다.
      user: { status: 'ACTIVE', deletedAt: null },
    },
    // PostgreSQL 은 행 순서를 보장하지 않아, 번호가 2개 이상 배정된 기관은
    // 새로고침마다 다른 번호가 표시될 수 있다. 다른 화면과 동일하게 assignedAt 내림차순으로 고정한다.
    include: {
      user: { select: { avatarIndex: true } },
      moRoutes: { where: { status: 'ASSIGNED' }, orderBy: { assignedAt: 'desc' } },
      chargeProducts: {
        // 웹 후원 패널은 금액 칩만 그리고 createWebCharge 도 amount 만 받는다.
        // 실물 상품을 여기 노출하면 배송지·배송비 없이 결제되어 보낼 주소가 없는 주문이 생긴다.
        // 실물 주문은 문자로 받은 /r/[token] 흐름(배송지 입력 포함)에서만 받는다.
        where: { active: true, archivedAt: null, kind: 'DIGITAL' },
        orderBy: [{ sortOrder: 'asc' }, { amount: 'asc' }],
        select: { id: true, name: true, amount: true },
      },
    },
  });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { code } = await params;
  const merchant = await findMerchant(code);
  if (!merchant) {
    return { title: '사회복지기관을 찾을 수 없습니다', robots: { index: false, follow: false } };
  }
  return {
    title: `${merchant.displayName} 문자후원`,
    description: `${merchant.displayName}에 문자 한 통으로 후원하세요. 후원 금액은 문자를 보낸 뒤 고릅니다.`,
    robots: { index: false, follow: false },
  };
}

export default async function MerchantChargePage({ params, searchParams }: Params) {
  const { code } = await params;
  const sp = (await searchParams) ?? {};
  const merchant = await findMerchant(code);

  // 미존재·미승인·정지·탈퇴 기관은 404 상태로 돌려준다(같은 폴더 not-found.tsx 가 안내 화면을 그린다).
  if (!merchant) notFound();

  const [policy, donors] = await Promise.all([
    resolvePolicy(merchant.id),
    // 공개 최근 후원: 결제 성공(PAID_STATUSES)·실후원(isTest=false)·결제 시각 있는 건만.
    // 후원페이지(/donate)와 같은 함수를 써서 두 화면 기준이 갈라지지 않게 한다(점검 F H-3).
    recentDonors(merchant.id, 10),
  ]);

  // 허용 범위 = 플랫폼 정책 ∩ 기관 설정 (결제 시 checkLimits 가 같은 교집합으로 판정한다).
  // 정책 범위만 보여 주면 본인인증까지 마친 뒤 금액 범위 오류로 거절된다.
  const effMin = merchant.minAmount > policy.minAmount ? merchant.minAmount : policy.minAmount;
  const effMax = merchant.maxAmount < policy.maxAmount ? merchant.maxAmount : policy.maxAmount;

  // 로그인한 후원자라면 후원 내역에 어떤 이름으로 남는지 알려준다.
  // 비로그인 방문자에게는 아무것도 보여주지 않는다(안내할 대상이 없다).
  const viewerPayer = await currentViewerPayer();

  const route = merchant.moRoutes[0] ?? null;
  // 모금 중 캠페인. 후원페이지에서 ?campaign= 으로 들어오면 기본 선택한다.
  const openList = await openCampaigns(merchant.id);
  const campaigns = openList.map((c) => ({ id: c.id, title: c.title }));
  const defaultCampaignId = campaigns.some((c) => c.id === sp.campaign) ? sp.campaign! : '';
  const defaultCampaign = openList.find((c) => c.id === defaultCampaignId) ?? null;
  // 후원자가 고를 수 있는 후원 항목. 문자·웹 모두 같은 목록을 쓴다.
  const products = merchant.chargeProducts.map((p) => ({ id: p.id, name: p.name, amount: p.amount.toString() }));
  const bannerUrl = resolveChargeBanner(merchant.id, merchant.bannerUrl);

  // 결제 연동이 mock 이면 결제 화면에 반드시 표시한다 (가짜 성공 처리 금지 원칙)
  let paymentMock = true;
  try {
    paymentMock = getPaymentAdapter().info().mode === 'mock';
  } catch {
    paymentMock = true;
  }
  // 모바일 문자 링크 본문에 키워드를 미리 넣는다(점검 M-14).
  //  - 대표번호(SHARED_PREFIX) 기관은 기관 키워드가 없으면 라우팅되지 않는다.
  //  - 후원페이지에서 캠페인을 지정하고 넘어왔으면(?campaign=) 캠페인 키워드도 넣어 지정후원이 유지되게 한다.
  const smsPrefix = route?.mode === 'SHARED_PREFIX' && route.keyword ? `${route.keyword} ` : '';
  const smsBody = `${smsPrefix}${defaultCampaign ? `${defaultCampaign.code} ` : ''}응원합니다`;
  const smsHref = route ? `sms:${route.phoneNumber}?body=${encodeURIComponent(smsBody)}` : null;
  const moNumberLabel = route ? formatMoNumber(route.phoneNumber) : null;

  return (
    <div className="min-h-dvh bg-[#f7f5ef]">
      {/* ── 기관 히어로 ─────────────────────────────────────────── */}
      <header className="relative isolate overflow-hidden bg-ink-900 pb-24 pt-10">
        {/* 기관 배너 (미설정 시 기본 배너 5종 중 기관별 고정 적용, 프리셋 WebP) */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={bannerUrl} alt="" decoding="async" className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-70" />
        <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(23,22,26,0.4)_0%,rgba(23,22,26,0.66)_70%,rgba(23,22,26,0.9)_100%)]" />
        <div className="relative mx-auto w-full max-w-[560px] px-5 text-center">
          <div className="mx-auto w-fit">
            <ProfileAvatar
              seed={merchant.code}
              avatarIndex={merchant.user.avatarIndex}
              name={merchant.displayName}
              imageUrl={merchant.avatarUrl}
              className="h-24 w-24 border-2 border-brand-400/70"
            />
          </div>

          <h1 className="mt-4 text-[26px] font-black leading-tight tracking-[-0.04em] text-white">
            {merchant.displayName}
          </h1>
          {merchant.channelName ? (
            <p className="mt-1 text-[13.5px] font-semibold text-white/60">{merchant.channelName}</p>
          ) : null}

          {merchant.description ? (
            <p className="mx-auto mt-4 max-w-[440px] whitespace-pre-line text-[13px] leading-relaxed text-white/70">
              {merchant.description}
            </p>
          ) : null}
        </div>
      </header>

      {/* ── 본문 ─────────────────────────────────────────────────────── */}
      <main className="relative z-10 mx-auto w-full max-w-[560px] px-4 pb-32 sm:pb-16">
        {/* 후원 카드 (히어로에 겹침) */}
        <section className="-mt-16">
          {/*
            웹 후원(PIN)은 MO 수신번호가 필요 없어 번호 배정 여부와 무관하게 항상 노출한다.
            예전에는 웹 패널이 sm 이상에서만 보여 휴대폰에서는 웹 후원이 불가능했다(점검 F H-1).
            순서: 모바일 = 문자후원 → 웹 후원, PC = 웹 후원 → 문자 번호 안내.
          */}
          <div className="flex flex-col rounded-[26px] border border-brand-200/60 bg-white p-5 shadow-[0_24px_60px_rgba(23,22,26,0.14)] sm:p-6">
            {/* 모바일: 문자후원 (문자 1통 = 금액 선택 링크) */}
            {route ? (
              <div className="order-1 sm:hidden">
                <p className="flex items-center justify-center gap-1.5 text-[12px] font-bold text-brand-700">
                  <Phone size={14} strokeWidth={1.8} />
                  {merchant.displayName} 후원 문자 번호
                </p>
                <p className="mt-2 text-center font-mono text-[32px] font-extrabold leading-none tracking-tight text-ink-900">
                  {moNumberLabel}
                </p>
                <div className="mt-3 flex justify-center">
                  <CopyButton value={route.phoneNumber} label="번호 복사" />
                </div>

                <div className="mt-5 rounded-xl bg-ink-50 px-4 py-3">
                  <p className="text-[13px] font-semibold text-ink-500">후원 금액</p>
                  {products.length === 0 ? (
                    <p className="mt-1 text-[13px] font-bold text-ink-900">
                      {merchant.allowCustomAmount ? '문자를 보낸 뒤 링크에서 직접 입력합니다.' : '준비 중입니다.'}
                    </p>
                  ) : (
                    <>
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {products.map((p) => (
                          <span
                            key={p.id}
                            className="rounded-full bg-white px-2.5 py-1 text-[12px] font-bold text-ink-800 shadow-sm"
                          >
                            {p.name}
                          </span>
                        ))}
                        {merchant.allowCustomAmount ? (
                          <span className="rounded-full bg-white px-2.5 py-1 text-[12px] font-bold text-ink-500 shadow-sm">
                            직접 입력
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-400">
                        문자를 보내면 받은 링크에서 위 금액 중 하나를 고릅니다.
                      </p>
                    </>
                  )}
                </div>

                <a
                  href={smsHref ?? undefined}
                  className="mt-4 inline-flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[16px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] transition-colors hover:bg-brand-500 active:bg-brand-600"
                >
                  <MessageSquare size={18} strokeWidth={1.7} />
                  문자후원하기
                </a>
                <p className="mt-2.5 text-center text-[11.5px] leading-relaxed text-ink-400">
                  문자 앱이 열리며 후원 문자 번호가 자동 입력됩니다. 문자를 보내면 후원 금액을 고르는 링크가 오고,{' '}
                  금액을 고른 뒤 PIN 을 입력하면 등록된 계좌에서 출금됩니다.
                </p>
              </div>
            ) : (
              /* 번호 미배정: 문자후원 영역만 안내로 대체한다. 아래 웹 후원은 그대로 동작한다. */
              <div className="order-1 text-center sm:hidden">
                <span className="mx-auto grid h-11 w-11 place-items-center rounded-xl bg-warning-50 text-warning-500">
                  <CircleAlert size={22} strokeWidth={1.7} />
                </span>
                <p className="mt-3 text-[15px] font-extrabold text-ink-900">후원 문자 번호가 아직 배정되지 않았습니다</p>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-500">
                  아직 문자 수신 번호가 배정되지 않아 문자후원을 접수할 수 없습니다. 번호가 배정되면 이 페이지에
                  표시됩니다. 아래에서 웹으로 후원하실 수 있습니다.
                </p>
              </div>
            )}

            {/* 웹 후원 (PIN 인증). 후원페이지의 "웹 후원" 버튼이 #web 으로 바로 닿는다. */}
            <div
              id="web"
              className="order-2 mt-6 scroll-mt-4 border-t border-ink-100 pt-6 sm:order-1 sm:mt-0 sm:border-t-0 sm:pt-0"
            >
              <p className="mb-4 flex items-center justify-center gap-1.5 text-center text-[16px] font-black tracking-[-0.02em] text-ink-900">
                <MonitorSmartphone size={18} strokeWidth={1.7} className="text-brand-700 sm:hidden" />
                <span className="sm:hidden">웹으로 후원하기</span>
                <span className="hidden sm:inline">{merchant.displayName} 후원하기</span>
              </p>
              {/* 기본은 PIN 인증 흐름이다. 구 즉시결제 화면은 되돌림 플래그를 켰을 때만 쓴다. */}
              {resolveWebChargeChannel() === 'PIN' ? (
                <WebChargePinPanel
                  merchantId={merchant.id}
                  merchantName={merchant.displayName}
                  products={products}
                  allowCustom={merchant.allowCustomAmount}
                  minAmount={effMin.toString()}
                  maxAmount={effMax.toString()}
                  paymentMock={paymentMock}
                  campaigns={campaigns}
                  defaultCampaignId={defaultCampaignId}
                  smsAvailable={Boolean(route)}
                />
              ) : (
                <WebChargePanel
                  merchantId={merchant.id}
                  merchantName={merchant.displayName}
                  products={products}
                  allowCustom={merchant.allowCustomAmount}
                  minAmount={effMin.toString()}
                  maxAmount={effMax.toString()}
                  paymentMock={paymentMock}
                />
              )}
            </div>

            {/* PC: 문자 번호 안내. 데스크톱에서는 문자를 보낼 수 없으므로 번호만 안내한다. */}
            {route ? (
              <div className="order-3 mt-5 hidden rounded-2xl border border-brand-200/70 bg-brand-50/60 px-4 py-3.5 sm:block">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-[12px] font-bold text-brand-700">
                      <Phone size={14} strokeWidth={1.8} />
                      후원 문자 번호
                    </p>
                    <p className="mt-1 font-mono text-[22px] font-extrabold leading-none tracking-tight text-ink-900">
                      {moNumberLabel}
                    </p>
                  </div>
                  <CopyButton value={route.phoneNumber} label="번호 복사" />
                </div>
                <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-500">
                  휴대폰에서 이 번호로 문자를 보내 후원할 수도 있습니다.
                </p>
              </div>
            ) : null}
          </div>
        </section>

        {/*
          표시 이름 안내.
          로그인한 후원자에게만 보여준다. 닉네임을 정하지 않았으면 번호 끝 4자리로
          후원 내역에 남는다는 사실을 알려주고, 정했으면 지금 이름을 확인시켜 준다.
        */}
        {viewerPayer ? (
          <section className="mt-6">
            <div className="rounded-2xl border border-brand-200/70 bg-brand-50 px-4 py-3.5">
              <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900">
                <BellRing size={15} strokeWidth={1.8} className="shrink-0 text-brand-700" />
                {viewerPayer.displayName
                  ? `후원 내역에 ${viewerPayer.displayName} 님으로 표시됩니다`
                  : '후원 내역에 휴대폰 번호로 표시됩니다'}
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-700">
                {viewerPayer.displayName
                  ? '후원하면 이 이름으로 후원 내역과 기관 화면에 표시됩니다.'
                  : `닉네임을 정하지 않아 번호 끝 4자리(${displayPayerName(defaultPayerName(viewerPayer.phoneMasked))})로 표시됩니다. 닉네임을 정하면 기관이 누가 보냈는지 알아볼 수 있습니다.`}
              </p>
              <Link
                href="/my/account#nickname"
                className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-brand-700 underline underline-offset-2"
              >
                닉네임 {viewerPayer.displayName ? '변경하기' : '설정하기'}
              </Link>
            </div>
          </section>
        ) : null}

        {/* 첫 문자 안내 (모바일 문자후원) */}
        {route ? (
          <section className="mt-6 sm:hidden">
            <div className="rounded-2xl border border-warning-500/30 bg-warning-50 px-4 py-3.5">
              <p className="flex items-center gap-1.5 text-[13px] font-bold text-ink-900">
                <CircleAlert size={15} strokeWidth={1.8} className="shrink-0 text-warning-500" />
                처음 보내는 문자는 후원되지 않습니다
              </p>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink-700">
                최초 문자는 계좌 등록 안내만 발송됩니다. 안내 문자의 링크에서 계좌 등록과 이용 동의를 마친 뒤 다시
                문자를 보내주세요.
              </p>
            </div>
          </section>
        ) : null}

        {/* 후원 방법 — 문자후원 (모바일, 번호가 있을 때) */}
        {route ? (
          <section className="mt-8 sm:hidden">
            <h2 className="px-1 text-[15px] font-black tracking-[-0.02em] text-ink-900">문자 후원 방법</h2>
            <div className="mt-2.5 space-y-2.5">
              <Step
                no="1"
                icon={<CreditCard size={17} strokeWidth={1.7} />}
                title="계좌를 1회 등록합니다"
                body="첫 문자를 보내면 오는 안내 링크에서 본인 명의 계좌를 등록합니다. 계좌번호 원문은 저장하지 않고 은행명과 끝 4자리만 보관합니다."
              />
              <Step
                no="2"
                icon={<MessageSquare size={17} strokeWidth={1.7} />}
                title="후원 문자를 보냅니다"
                body="위 번호로 문자를 보내면 후원 금액을 고를 수 있는 링크가 도착합니다."
              />
              <Step
                no="3"
                icon={<ShieldCheck size={17} strokeWidth={1.7} />}
                title="PIN 을 입력하면 출금됩니다"
                body="문자로 받은 링크에서 결제 PIN 을 입력하면 등록한 계좌에서 후원 금액이 출금됩니다. PIN 을 입력하지 않으면 출금되지 않습니다."
              />
              <Step
                no="4"
                icon={<BellRing size={17} strokeWidth={1.7} />}
                title="후원이 반영됩니다"
                body="출금이 완료되면 기관에 후원이 반영되고, 완료 문자를 받습니다. 출금되지 않은 요청은 반영되지 않습니다."
              />
            </div>
          </section>
        ) : null}

        {/* 후원 방법 — 웹 후원 (모바일·PC 공통) */}
        <section className="mt-8">
          <h2 className="px-1 text-[15px] font-black tracking-[-0.02em] text-ink-900">웹 후원 방법</h2>
          <div className="mt-2.5 space-y-2.5">
            <Step
              no="1"
              icon={<MessageSquare size={17} strokeWidth={1.7} />}
              title="후원 금액을 고릅니다"
              body="웹 후원 패널에서 후원 금액(직접 입력 포함)과 후원 내역에 남길 메모를 고를 수 있습니다."
            />
            <Step
              no="2"
              icon={<Smartphone size={17} strokeWidth={1.7} />}
              title="휴대전화 번호를 입력합니다"
              body="입력한 번호로 결제 PIN 입력 링크를 문자로 보내드립니다. 이 단계까지는 출금되지 않습니다. 처음이라면 등록 창에서 계좌를 1회 등록합니다."
            />
            <Step
              no="3"
              icon={<CreditCard size={17} strokeWidth={1.7} />}
              title="PIN 을 입력하면 출금됩니다"
              body="문자로 받은 링크에서 결제 PIN 을 입력하면 등록된 계좌에서 선택한 금액이 출금됩니다. 유효시간 안에 입력하지 않으면 자동 취소됩니다."
            />
            <Step
              no="4"
              icon={<ShieldCheck size={17} strokeWidth={1.7} />}
              title="후원이 반영됩니다"
              body="출금이 완료되면 기관에 후원이 반영되고, 완료 문자를 받습니다. 출금되지 않은 요청은 반영되지 않습니다."
            />
          </div>
        </section>

        {/* 최근 후원 */}
        <section className="mt-8">
          <div className="flex items-end justify-between px-1">
            <h2 className="text-[15px] font-black tracking-[-0.02em] text-ink-900">최근 후원</h2>
            <span className="text-[11.5px] text-ink-400">완료된 후원만 · 이름 일부 공개</span>
          </div>
          {donors.length === 0 ? (
            <div className="mt-2.5 rounded-2xl border border-dashed border-ink-200 bg-white/60 px-5 py-8 text-center">
              <p className="text-[13.5px] font-bold text-ink-700">아직 후원이 없습니다</p>
              <p className="mt-1 text-[12.5px] text-ink-400">첫 후원을 남겨 보세요.</p>
            </div>
          ) : (
            <div className="mt-2.5 space-y-2">
              {donors.map((d, i) => (
                <div key={`${d.paidAt.getTime()}-${i}`} className="rounded-2xl border border-ink-100 bg-white p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-100 text-[11px] font-black text-brand-800">
                        {(d.name || '후').slice(0, 1)}
                      </span>
                      <span className="truncate text-[13px] font-bold text-ink-900">{d.name}</span>
                      {d.recurring ? (
                        <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-bold text-brand-700">정기</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-[14px] font-extrabold tracking-tight text-brand-700">
                      {formatWon(d.amount)}
                    </span>
                  </div>
                  {/* 익명 후원은 recentDonors 가 메시지를 비워 둔다(메시지 속 실명·호실로 특정될 수 있다). */}
                  {d.message ? (
                    <p className="mt-1.5 break-words text-[13px] leading-relaxed text-ink-700">{d.message}</p>
                  ) : null}
                  <p className="mt-1.5 text-[11.5px] text-ink-300">
                    {formatKst(d.paidAt, false)}
                    {d.campaignTitle ? ` · ${d.campaignTitle}` : ''}
                  </p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 이용 한도 · 유의 */}
        <section className="mt-8">
          <div className="rounded-2xl border border-ink-100 bg-white p-5">
            <p className="flex items-center gap-1.5 text-[13.5px] font-bold text-ink-900">
              <Gauge size={16} strokeWidth={1.7} className="text-brand-700" />
              이용 한도 안내
            </p>
            <ul className="mt-2 space-y-1.5 text-[12.5px] leading-relaxed text-ink-500">
              <li>1일 {formatWon(policy.payerDailyLimit)} · 1개월 {formatWon(policy.payerMonthlyLimit)}까지 후원할 수 있습니다.</li>
              <li>이 기관에는 1일 {formatWon(policy.perMerchantDailyLimit)}까지 후원할 수 있습니다.</li>
              <li>{formatNumber(policy.velocityWindowSec)}초 내 {formatNumber(policy.velocityMaxCount)}건을 넘으면 잠시 대기해야 합니다.</li>
              <li>만 19세 미만은 이용할 수 없습니다.</li>
            </ul>
          </div>
        </section>

        {/* 신고 */}
        <section className="mt-4">
          <div className="flex items-start gap-3 rounded-2xl border border-ink-100 bg-white p-5">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-ink-50 text-brand-700">
              <Flag size={17} strokeWidth={1.7} />
            </span>
            <div>
              <p className="text-[13.5px] font-bold text-ink-900">문제가 있나요?</p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">
                부적절한 후원 유도, 출금 오류, 원치 않는 후원 내역 노출은 고객센터로 신고해 주세요. 거래번호를 함께
                알려주시면 빠르게 확인할 수 있습니다.
              </p>
              <LinkButton href="/support" variant="secondary" size="sm" className="mt-2.5">
                신고 · 문의하기
              </LinkButton>
            </div>
          </div>
        </section>

        {/* 서비스 풋터 */}
        <footer className="mt-10 border-t border-ink-100 pt-6 text-center">
          <p className="text-[11.5px] leading-relaxed text-ink-400">
            이 페이지는 <span className="font-bold text-ink-500">기브싸인 문자후원</span>으로 운영됩니다.
            <br />
            사회복지기관과 제휴한 문자후원 서비스입니다.
          </p>
          <div className="mt-3 flex items-center justify-center gap-4 text-[12px] font-semibold text-ink-400">
            <Link href="/how-it-works" className="transition-colors hover:text-ink-900">이용방법</Link>
            <span aria-hidden className="h-3 w-px bg-ink-200" />
            <Link href="/support" className="transition-colors hover:text-ink-900">고객센터</Link>
            <span aria-hidden className="h-3 w-px bg-ink-200" />
            <Link href="/" className="transition-colors hover:text-ink-900">기브싸인 홈</Link>
          </div>
        </footer>
      </main>

      {/* ── 모바일 하단 고정 CTA (문자후원하기) ─────────────────────── */}
      {smsHref && route ? (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-100 bg-white/95 px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 backdrop-blur-xl sm:hidden">
          <div className="mx-auto flex max-w-[560px] items-center gap-2">
            <a
              href="#web"
              className="inline-flex h-12 shrink-0 items-center justify-center gap-1.5 rounded-2xl border border-ink-200 bg-white px-4 text-[14px] font-bold text-ink-700"
            >
              <MonitorSmartphone size={16} strokeWidth={1.7} />
              웹 후원
            </a>
            <a
              href={smsHref}
              className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-2xl bg-brand-400 text-[15px] font-extrabold text-ink-900 shadow-[0_8px_20px_rgba(237,166,0,0.28)] transition-colors hover:bg-brand-500 active:bg-brand-600"
            >
              <MessageSquare size={17} strokeWidth={1.7} />
              문자후원하기
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Step({ no, icon, title, body }: { no: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-2xl border border-ink-100 bg-white p-4">
      <span className="relative mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        {icon}
        <span className="absolute -left-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-ink-900 text-[10px] font-black text-brand-400">
          {no}
        </span>
      </span>
      <div>
        <p className="text-[13.5px] font-bold text-ink-900">{title}</p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-500">{body}</p>
      </div>
    </div>
  );
}
