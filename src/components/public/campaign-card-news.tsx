import type { CampaignCard } from '@/lib/fundraising';

export const cardThemes = {
  cream: { background: '#faf5e9', color: '#324936', accent: '#65875a' },
  green: { background: '#155442', color: '#ffffff', accent: '#d8e8b5' },
  peach: { background: '#fff0e5', color: '#573d30', accent: '#b5663a' },
  white: { background: '#ffffff', color: '#233d32', accent: '#587c66' },
};

/** 편집 미리보기와 공개 화면에서 동일한 카드 레이아웃을 사용한다. */
export function CampaignCardNews({ cards }: { cards: CampaignCard[] }) {
  return <div className="space-y-6" aria-label="캠페인 카드뉴스">
    {cards.map((card, index) => {
      const theme = cardThemes[card.theme];
      return <article key={index} className="overflow-hidden rounded-[24px] border border-black/5" style={{ background: theme.background, color: theme.color }}>
        {card.imageUrl && card.layout !== 'text' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.imageUrl} alt={card.alt || card.title || `캠페인 카드뉴스 ${index + 1}`} loading="lazy" className="block h-auto w-full" />
        ) : null}
        {card.layout !== 'image' && (card.title || card.body) ? <div className="px-6 py-8 sm:px-10 sm:py-10">
          <p className="mb-4 text-[11px] font-bold tracking-[0.2em]" style={{ color: theme.accent }}>OUR STORY · {String(index + 1).padStart(2, '0')}</p>
          {card.title ? <h3 className="whitespace-pre-wrap break-words text-[23px] font-black leading-snug tracking-[-0.03em] sm:text-[28px]">{card.title}</h3> : null}
          {card.body ? <p className="mt-4 whitespace-pre-wrap break-words text-[14px] leading-8 opacity-90 sm:text-[15px]">{card.body}</p> : null}
        </div> : null}
      </article>;
    })}
  </div>;
}
