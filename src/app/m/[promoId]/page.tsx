import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { HeartHandshake } from 'lucide-react';
import { formatMoNumber } from '@/lib/mo-number';
import { smsHref, smsPlatform } from '@/lib/sms-link';
import { promoSmsTarget } from '@/server/services/promo-codes';
import { SmsOpener } from './sms-opener';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '문자로 후원하기', robots: { index: false, follow: false } };

/**
 * 홍보물 QR 중간 페이지 (2026-11-12 4차 K1).
 * QR 을 찍으면 이 화면이 열리고, 휴대폰이면 키워드가 채워진 문자 앱을 연다(iOS `sms:번호&body=`, 안드로이드 `sms:번호?body=`).
 * 문자 앱이 안 열리거나 PC 면 후원페이지 버튼(유입 경로 promo — 웹 후원도 홍보물로 집계)을 쓴다.
 * 문자를 보내기 전에는 아무것도 결제되지 않는다. 이 화면은 기록을 남기지 않는다.
 */
export default async function PromoLandingPage({ params }: { params: Promise<{ promoId: string }> }) {
  const { promoId } = await params;
  const target = await promoSmsTarget(promoId);
  if (!target) notFound();
  const platform = smsPlatform((await headers()).get('user-agent'));
  const href = target.number ? smsHref(target.number, target.body, platform) : null;
  const mobile = platform !== 'other';

  return (
    <main className="min-h-screen bg-[#f6f4ee] px-4 py-10">
      <div className="mx-auto max-w-[420px] space-y-4 rounded-[28px] bg-white p-6 shadow-sm">
        <div className="flex items-center gap-2 text-brand-700">
          <HeartHandshake size={20} strokeWidth={1.7} />
          <span className="text-[14px] font-bold">{target.merchantName}</span>
        </div>
        <h1 className="text-[22px] font-black leading-snug text-ink-900">{target.campaignTitle}</h1>
        {target.inactive ? (
          <p className="rounded-2xl bg-warning-50 px-4 py-3 text-[15px] leading-relaxed text-ink-800">
            이 홍보물의 기간이 끝났거나 모금이 마감되었습니다. 아래 후원페이지에서 기관 소식을 확인해 주세요.
          </p>
        ) : href ? (
          <>
            <p className="text-[16px] leading-relaxed text-ink-700">
              {mobile ? '문자 앱이 열리면 그대로 보내 주세요. 답장으로 온 링크에서 금액을 고르면 후원이 진행됩니다.' : '휴대폰 카메라로 QR 을 찍으면 문자 앱이 바로 열립니다.'}
            </p>
            <div className="rounded-2xl bg-ink-50 px-4 py-3 text-[15px] text-ink-800">
              <p>받는 번호 <strong className="font-mono">{formatMoNumber(target.number!)}</strong></p>
              <p className="mt-1">보낼 내용 <strong>{target.body.trim()}</strong> (뒤에 응원 메시지를 덧붙여도 됩니다)</p>
            </div>
            <SmsOpener href={href} auto={mobile} />
          </>
        ) : (
          <p className="text-[15px] leading-relaxed text-ink-700">이 기관의 문자 후원 번호가 아직 준비되지 않았습니다. 아래 후원페이지를 이용해 주세요.</p>
        )}
        <a href={target.donateUrl} className="block w-full rounded-2xl border border-ink-200 px-5 py-4 text-center text-[16px] font-bold text-ink-800">
          문자 앱이 열리지 않으면 — 후원페이지에서 후원하기
        </a>
        <p className="text-[12.5px] leading-relaxed text-ink-400">문자를 보내기 전에는 아무것도 결제되지 않습니다.</p>
      </div>
    </main>
  );
}
