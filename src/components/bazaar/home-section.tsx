import Link from 'next/link';
import { CalendarClock, Gift, HandCoins, PackageCheck, Radio, ReceiptText } from 'lucide-react';
import { LinkButton } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { formatWon } from '@/lib/money';

/**
 * 메인 화면 라이브 바자회 소개 섹션. 스위치가 켜져 있을 때만 page.tsx 가 그린다.
 * 지표는 실제 데이터만 보여 주고, 없으면 그 줄을 숨긴다(지어내지 않는다).
 */
const STEPS = [
  { icon: Gift, title: '물품 기부', body: '기업·개인이 새 상품이나 미개봉 물품을 기부합니다.' },
  { icon: ReceiptText, title: '기관 영수증', body: '매칭된 기관이 검수 후 현물 기부금영수증을 발급합니다.' },
  { icon: Radio, title: '라이브 판매', body: '기브싸인 셀러가 라이브 방송으로 물품을 판매합니다.' },
  { icon: HandCoins, title: '기관 귀속', body: '판매 금액에서 수수료를 뺀 금액이 매월 기관에 지급됩니다.' },
];

export function BazaarHomeSection({
  lives,
  merchants,
  paidTotal,
}: {
  lives: Array<{ id: string; title: string; scheduledAt: Date; broadcastUrl: string | null; merchantName: string }>;
  merchants: number;
  paidTotal: bigint;
}) {
  return (
    <section className="mt-14 overflow-hidden rounded-[28px] border border-brand-100 bg-white" aria-labelledby="home-bazaar-title">
      <div className="p-6 sm:p-8">
        <p className="inline-flex items-center gap-1.5 rounded-full bg-brand-100 px-3 py-1 text-[12px] font-extrabold text-brand-800">
          <PackageCheck size={14} strokeWidth={1.7} aria-hidden /> 라이브 바자회
        </p>
        <h2 id="home-bazaar-title" className="mt-3 text-[26px] font-black leading-tight tracking-[-0.03em] text-ink-900 sm:text-[30px]">
          물건을 기부하면,<br />라이브로 팔아 기관의 후원금이 됩니다
        </h2>
        <ol className="mt-6 grid gap-3 sm:grid-cols-4">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl bg-ink-50 p-4">
              <s.icon size={20} strokeWidth={1.6} className="text-brand-700" aria-hidden />
              <p className="mt-2 text-[14px] font-extrabold text-ink-900">
                <span className="mr-1 tabular-nums text-brand-700">{i + 1}</span>
                {s.title}
              </p>
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-500">{s.body}</p>
            </li>
          ))}
        </ol>

        {lives.length > 0 ? (
          <div className="mt-6">
            <h3 className="flex items-center gap-1.5 text-[14px] font-extrabold text-ink-900">
              <CalendarClock size={16} strokeWidth={1.7} aria-hidden /> 다가오는 라이브
            </h3>
            <ul className="mt-2 grid gap-2 sm:grid-cols-3">
              {lives.map((l) => (
                <li key={l.id} className="rounded-xl border border-ink-200 p-3">
                  <p className="text-[12px] font-bold text-brand-700">{formatKst(l.scheduledAt, false)}</p>
                  <p className="mt-0.5 text-[14px] font-extrabold text-ink-900">{l.title}</p>
                  <p className="text-[12px] text-ink-500">{l.merchantName}</p>
                  {l.broadcastUrl ? (
                    <a href={l.broadcastUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-[12px] font-bold text-brand-700 underline underline-offset-2">
                      방송 보러 가기
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {merchants > 0 || paidTotal > 0n ? (
          <p className="mt-5 text-[13px] text-ink-500">
            {merchants > 0 ? <>참여 기관 <strong className="text-ink-900">{merchants}곳</strong></> : null}
            {merchants > 0 && paidTotal > 0n ? ' · ' : null}
            {paidTotal > 0n ? <>기관에 지급된 금액 <strong className="text-ink-900">{formatWon(paidTotal)}</strong></> : null}
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <LinkButton href="/bazaar/join">물품 기부하기</LinkButton>
          <LinkButton href="/bazaar" variant="secondary">라이브 바자회 알아보기</LinkButton>
        </div>
        <p className="mt-3 text-[12px] text-ink-400">
          이미 회원이라면 <Link href="/login?next=/giver" className="font-bold text-brand-700 underline underline-offset-2">로그인</Link> 후 기부자 콘솔에서 진행 상황을 볼 수 있습니다.
        </p>
      </div>
    </section>
  );
}
