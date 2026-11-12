'use client';

import { useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from 'lucide-react';
import { ImageUploadField } from './image-upload-field';
import { CampaignCardNews } from '@/components/public/campaign-card-news';
import { hasCardGuidance, readCampaignCards, type CampaignCard } from '@/lib/fundraising';
import { DONATION_BANNERS } from '@/lib/visual-presets';
import { campaignStoryCards, CAMPAIGN_STORY_FLOW } from '@/lib/campaign-storytelling';

type Entry = CampaignCard & { key: number };
const emptyCard = (): CampaignCard => ({ imageUrl: '', title: '', body: '', alt: '', layout: 'editorial', theme: 'cream' });
const input = 'w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-sm text-ink-900';

export function CampaignCardEditor({ initial }: { initial?: unknown }) {
  const [cards, setCards] = useState<Entry[]>(() => readCampaignCards(initial).map((c, key) => ({ ...c, key })));
  const [nextKey, setNextKey] = useState(cards.length);
  const [preview, setPreview] = useState(false);
  const [template, setTemplate] = useState('meal');
  function add(card = emptyCard()) {
    if (cards.length >= 15) return;
    setCards([...cards, { ...card, key: nextKey }]); setNextKey(nextKey + 1);
  }
  function update(key: number, patch: Partial<CampaignCard>) { setCards((prev) => prev.map((c) => c.key === key ? { ...c, ...patch } : c)); }
  function move(index: number, delta: number) {
    setCards((prev) => { const copy = [...prev]; [copy[index], copy[index + delta]] = [copy[index + delta], copy[index]]; return copy; });
  }
  function applyTemplate() {
    const configs = {
      meal: { image: 0, title: '한 끼에 담긴 따뜻한 마음', body: '우리 이웃에게 필요한 식사와 안부를 전합니다. 기관의 실제 지원 대상과 상황을 소개해 주세요.' },
      child: { image: 1, title: '아이들의 내일을 함께 응원해요', body: '아이들이 안전한 환경에서 꿈을 키울 수 있도록 함께해 주세요. 기관의 실제 사업 내용을 적어 주세요.' },
      care: { image: 2, title: '혼자가 아닌 일상을 만듭니다', body: '돌봄이 필요한 이웃에게 든든한 연결이 되어 주세요. 지원이 필요한 이유를 구체적으로 소개해 주세요.' },
    };
    const c = configs[template as keyof typeof configs];
    const values: CampaignCard[] = [
      { ...emptyCard(), imageUrl: DONATION_BANNERS[c.image].url, title: c.title, body: c.body, alt: c.title },
      { ...emptyCard(), layout: 'text', theme: 'peach', title: '여러분의 후원은 이렇게 쓰입니다', body: '지원 항목과 수량, 예산을 기관의 계획에 맞게 입력해 주세요.\n예: 식사 지원 · 생활용품 · 정기적인 안부 확인' },
      { ...emptyCard(), layout: 'text', theme: 'green', title: '작은 나눔이 변화의 시작입니다', body: '지원 일정과 기대하는 변화를 적어 주세요.\n함께해 주신 후원자에게 사업 결과를 전하겠습니다.' },
    ];
    setCards(values.map((v, i) => ({ ...v, key: nextKey + i }))); setNextKey(nextKey + 3);
  }
  function buildStory(event: React.MouseEvent<HTMLButtonElement>) {
    const form = event.currentTarget.form;
    if (!form) return;
    const data = new FormData(form);
    const value = (name: string) => String(data.get(name) ?? '');
    const values = campaignStoryCards({ title: value('title'), summary: value('summary'), story: value('story'), usagePlan: value('usagePlan'), imageUrl: value('imageUrl') });
    setCards(values.map((v, i) => ({ ...v, key: nextKey + i })));
    setNextKey(nextKey + values.length);
    setPreview(true);
  }
  const serialized = cards.map(({ key: _key, ...card }) => card);
  return <section className="rounded-2xl border border-ink-100 bg-white p-5 sm:p-6">
    <input type="hidden" name="cardNews" value={JSON.stringify(serialized)} />
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="text-lg font-black text-ink-900">카드뉴스로 전하는 캠페인</h2><p className="mt-1 text-sm leading-6 text-ink-500">최대 15장. 이미지와 이야기를 한 장씩 구성하고 순서를 바꿔 보세요.</p></div>
      <button type="button" onClick={() => setPreview(!preview)} className="rounded-xl border border-ink-200 px-4 py-2 text-sm font-bold">{preview ? '편집으로 돌아가기' : '카드뉴스 미리보기'}</button>
    </div>
    <div className="mt-5 rounded-2xl bg-[#faf5e9] p-5">
      <p className="text-sm font-black text-ink-900">이야기로 공감하고, 후원으로 이어지는 캠페인</p>
      <p className="mt-2 text-xs leading-6 text-ink-600">{CAMPAIGN_STORY_FLOW}. 큰 제목과 이미지, 짧은 문단을 번갈아 배치합니다.</p>
      <p className="mt-1 text-xs leading-6 text-ink-500">입력한 제목·소개·이야기·사용 계획으로 6장을 구성합니다. 빈 항목에는 작성 안내가 들어가며, 안내 문구를 실제 내용으로 바꿔야 저장됩니다.{cards.length ? '현재 카드를 교체하려면 먼저 모두 삭제해 주세요.' : '본문을 먼저 입력하면 카드에도 반영됩니다.'}</p>
      <button type="button" disabled={cards.length > 0} onClick={buildStory} className="mt-3 rounded-xl bg-brand-700 px-4 py-2 text-sm font-bold text-white disabled:opacity-40">캠페인 내용으로 스토리형 6장 만들기</button>
      <a href="https://www.worldvision.or.kr/campaign/26-1000girls" target="_blank" rel="noreferrer" className="ml-3 inline-block text-xs font-bold text-brand-700 underline underline-offset-4">참고 캠페인 보기</a>
    </div>
    {!cards.length ? <div className="mt-5 rounded-2xl bg-[#f6f8f2] p-5">
      <p className="text-sm font-bold">이야기 템플릿으로 시작하기</p><p className="mt-1 text-xs leading-6 text-ink-500">사진·내용·색상은 모두 바꿀 수 있습니다. 예시 문구는 기관의 실제 계획에 맞게 수정해 주세요.</p>
      <div className="mt-3 flex flex-wrap gap-2"><select aria-label="카드뉴스 템플릿" value={template} onChange={(e) => setTemplate(e.target.value)} className="rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm"><option value="meal">따뜻한 한 끼</option><option value="child">아이들의 내일</option><option value="care">이웃 돌봄</option></select><button type="button" onClick={applyTemplate} className="rounded-xl bg-brand-700 px-4 py-2 text-sm font-bold text-white">3장 템플릿 불러오기</button></div>
    </div> : null}
    {preview ? <div className="mx-auto mt-6 max-w-[600px]">{cards.length ? <CampaignCardNews cards={serialized} /> : <p className="py-10 text-center text-sm text-ink-400">카드를 추가하면 여기에 표시됩니다.</p>}</div> : <div className="mt-5 space-y-5">
      {cards.map((card, index) => <div key={card.key} className="rounded-2xl border border-ink-200 p-4 sm:p-5">
        {hasCardGuidance(card) ? <p role="status" className="mb-3 rounded-xl bg-amber-50 px-3 py-2 text-xs font-bold leading-5 text-amber-800">작성 안내 문구가 남아 있습니다. 기관의 실제 내용으로 바꿔야 저장할 수 있습니다.</p> : null}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">카드 {String(index + 1).padStart(2, '0')}</h3><div className="flex gap-1">
          <button type="button" aria-label={`${index + 1}번 카드 위로`} disabled={!index} onClick={() => move(index, -1)} className="rounded-lg p-2 hover:bg-ink-50 disabled:opacity-25"><ArrowUp size={16} /></button>
          <button type="button" aria-label={`${index + 1}번 카드 아래로`} disabled={index === cards.length - 1} onClick={() => move(index, 1)} className="rounded-lg p-2 hover:bg-ink-50 disabled:opacity-25"><ArrowDown size={16} /></button>
          <button type="button" aria-label={`${index + 1}번 카드 복제`} disabled={cards.length >= 15} onClick={() => add(card)} className="rounded-lg p-2 hover:bg-ink-50 disabled:opacity-25"><Copy size={16} /></button>
          <button type="button" aria-label={`${index + 1}번 카드 삭제`} onClick={() => setCards(cards.filter((c) => c.key !== card.key))} className="rounded-lg p-2 text-red-600 hover:bg-red-50"><Trash2 size={16} /></button>
        </div></div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs font-bold">구성<select className={input} value={card.layout} onChange={(e) => update(card.key, { layout: e.target.value as CampaignCard['layout'] })}><option value="editorial">이미지 + 제목·설명</option><option value="image">완성된 카드뉴스 이미지</option><option value="text">제목·설명만</option></select></label><label className="space-y-1 text-xs font-bold">배경 색상<select className={input} value={card.theme} onChange={(e) => update(card.key, { theme: e.target.value as CampaignCard['theme'] })}><option value="cream">따뜻한 크림</option><option value="green">숲 초록</option><option value="peach">살구빛</option><option value="white">화이트</option></select></label></div>
        {card.layout !== 'text' ? <div className="space-y-3">
          <ImageUploadField label={`카드 ${index + 1} 이미지`} name={`card-image-${card.key}`} value={card.imageUrl} onValueChange={(imageUrl) => update(card.key, { imageUrl })} hint="JPG·PNG·WEBP·GIF, 5MB 이하. 가로 1080px 권장. 세로형 이미지도 자르지 않고 원본 비율로 표시합니다." />
          <div className="flex gap-2" aria-label={`카드 ${index + 1} 기본 이미지 선택`}>{DONATION_BANNERS.map((p, i) => <button type="button" key={p.url} onClick={() => update(card.key, { imageUrl: p.url })} aria-label={`카드 ${index + 1} 기본 이미지 ${i + 1}`} className="w-1/5 overflow-hidden rounded-lg border border-ink-100">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.url} alt={p.label} className="aspect-video w-full object-cover" />
          </button>)}</div>
          <label className="block space-y-1 text-xs font-bold">이미지 설명<input className={input} maxLength={200} value={card.alt} onChange={(e) => update(card.key, { alt: e.target.value })} placeholder="이미지 내용을 글로 설명해 주세요" /></label>
        </div> : null}
        {card.layout !== 'image' ? <label className="mt-4 block space-y-1 text-xs font-bold">구간 이름<input className={input} maxLength={40} value={card.eyebrow ?? ''} onChange={(e) => update(card.key, { eyebrow: e.target.value })} placeholder="예: 우리 이웃의 이야기" /></label> : null}
        {card.layout !== 'image' ? <div className="mt-4 space-y-3"><label className="block space-y-1 text-xs font-bold">카드 제목<input className={input} maxLength={100} value={card.title} onChange={(e) => update(card.key, { title: e.target.value })} placeholder="이 카드에서 전하고 싶은 한 문장" /></label><label className="block space-y-1 text-xs font-bold">이야기<textarea className={input} rows={5} maxLength={1500} value={card.body} onChange={(e) => update(card.key, { body: e.target.value })} placeholder="상황, 필요한 도움, 후원으로 달라질 일상을 적어 주세요." /></label></div> : null}
      </div>)}
    </div>}
    <button type="button" disabled={cards.length >= 15} onClick={() => { add(); setPreview(false); }} className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-brand-400 bg-brand-50 px-4 py-4 text-sm font-bold text-brand-800 disabled:opacity-40"><Plus size={18} /> 카드 추가 ({cards.length}/15)</button>
    <p className="mt-3 text-xs leading-6 text-ink-400">카드뉴스가 없어도 기존 캠페인 이야기는 그대로 표시됩니다. 추가·수정한 내용은 아래 캠페인 저장 버튼을 눌러야 반영됩니다.</p>
  </section>;
}
