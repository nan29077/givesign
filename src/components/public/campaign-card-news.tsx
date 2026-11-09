import type { CampaignCard } from '@/lib/fundraising';

export const cardThemes = {
  cream: { background: '#faf5e9', color: '#324936', accent: '#65875a' },
  green: { background: '#155442', color: '#ffffff', accent: '#d8e8b5' },
  peach: { background: '#fff0e5', color: '#573d30', accent: '#b5663a' },
  white: { background: '#ffffff', color: '#233d32', accent: '#587c66' },
};

/** 편집 미리보기와 공개 화면에서 동일한 카드 레이아웃을 사용한다. */
export function CampaignCardNews({ cards }: { cards: CampaignCard[] }) {
  return <div className="overflow-hidden rounded-[24px]" aria-label="캠페인 카드뉴스">
    {cards.map((card, index) => {
      const theme = cardThemes[card.theme];
      return <article key={index} className="overflow-hidden" style={{ background: theme.background, color: theme.color }}>
        {card.imageUrl && card.layout !== 'text' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={card.imageUrl} alt={card.alt || card.title || `캠페인 카드뉴스 ${index + 1}`} loading="lazy" className="block h-auto w-full" />
        ) : null}
        {card.layout !== 'image' && (card.title || card.body) ? <div className="px-7 py-12 text-center sm:px-12 sm:py-16">
          <span className="mx-auto mb-5 block h-1 w-8" style={{ background: theme.accent }} />
          <p className="mb-6 text-[12px] font-bold tracking-[0.12em]" style={{ color: theme.accent }}>{card.eyebrow || '우리의 이야기'} · {String(index + 1).padStart(2, '0')}</p>
          {card.title ? <h3 className="whitespace-pre-wrap break-words text-[28px] font-black leading-[1.4] tracking-[-0.04em] sm:text-[36px]">{card.title}</h3> : null}
          {card.body ? <p className="mx-auto mt-6 max-w-[440px] whitespace-pre-wrap break-words text-[15px] leading-[2.1] opacity-90 sm:text-[16px]">{card.body}</p> : null}
        </div> : null}
      </article>;
    })}
  </div>;
}
