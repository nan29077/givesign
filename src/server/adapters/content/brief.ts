import type { ContentKind } from '@/generated/prisma/enums';

/**
 * 콘텐츠 브리프·장면 공용 타입과 서식 대본(mock·사실 장면). 어댑터(index.ts)와 LLM 대본(llm-script.ts)이 같이 쓴다.
 */

export type Tone = 'WARM' | 'HOPEFUL' | 'CALM' | 'URGENT';
export const TONE_LABEL: Record<Tone, string> = { WARM: '따뜻한', HOPEFUL: '희망찬', CALM: '차분한', URGENT: '긴급한' };

export interface ContentBrief {
  merchantName: string;
  /** 기관 소개(기관 정보 > 소개). 프롬프트 맥락으로만 쓴다. */
  merchantIntro?: string | null;
  /** 후원페이지 소개(기관 사업). */
  merchantBusiness?: string | null;
  campaignTitle: string;
  summary: string;
  story: string | null;
  /**
   * 수혜 대상 문구는 공급자에 넘기지 않는다. 기관이 실명·구체 정보를 적어 둘 수 있어
   * 게시물에 실리면 복지 이용자가 식별될 수 있기 때문이다(CLAUDE.md 11항 — 수혜자 실명 금지).
   */
  beneficiary?: never;
  usagePlan: string | null;
  goalAmount: bigint;
  raisedAmount: bigint;
  daysLeft: number | null;
  keyword: string | null;
  moNumber: string | null;
  tone: Tone;
  color: string;
  regNo: string | null;
  bannedWords: string[];
}

/** 장면(카드) 한 장의 글. 그림은 서버가 그린다. */
export interface SceneSpec {
  caption: string;
  durationSec: number;
  /** 카드뉴스 구간 이름 (표지·문제·사연·사용계획·진행률·참여 방법·마무리) */
  label?: string;
  /** 진행률 막대 (0~100) */
  progress?: number;
}

/** LLM 이 쓴 플랫폼별 캡션 본문. 링크·키워드·해시태그·AI 표시는 시스템이 붙인다. */
export interface PlatformVariant {
  title?: string;
  body: string;
}

export interface GeneratedScript {
  title: string;
  script: string;
  scenes: SceneSpec[];
  hashtags: string[];
  /** LLM 공급자일 때만. 키는 SocialPlatform. */
  platformCaptions?: Record<string, PlatformVariant>;
}

const OPENERS: Record<Tone, string> = {
  WARM: '오늘도 누군가의 하루를 따뜻하게 지키는 사람들이 있습니다.',
  HOPEFUL: '작은 마음이 모이면 내일이 달라집니다.',
  CALM: '천천히, 그러나 꾸준히 이웃 곁을 지키고 있습니다.',
  URGENT: '지금, 도움이 꼭 필요한 이웃이 있습니다.',
};
export const CLOSERS: Record<Tone, string> = {
  WARM: '당신의 마음을 함께 보태 주세요.',
  HOPEFUL: '함께하면 희망이 됩니다.',
  CALM: '문자 한 통으로 곁에 서 주세요.',
  URGENT: '오늘 바로 함께해 주세요.',
};

export function firstSentence(text: string | null | undefined, max = 46): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?。])\s|\n/)[0] ?? '';
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null;
}

function won(v: bigint) {
  return `${new Intl.NumberFormat('ko-KR').format(Number(v))}원`;
}

export function scrub(text: string, banned: string[]) {
  let out = text;
  for (const w of banned) if (w) out = out.split(w).join('');
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function progressPct(b: Pick<ContentBrief, 'goalAmount' | 'raisedAmount'>) {
  return b.goalAmount > 0n ? Math.min(100, Number((b.raisedAmount * 100n) / b.goalAmount)) : 0;
}

/** 사실 장면 — 진행률·참여 방법은 언제나 캠페인 데이터로 시스템이 쓴다(LLM 이 숫자를 지어내지 않게). */
export function factScenes(b: ContentBrief) {
  const pct = progressPct(b);
  const how = b.moNumber
    ? `${b.moNumber}${b.keyword ? ` 로 '${b.keyword}'` : ' 로'} 문자를 보내 주세요.`
    : '후원 페이지에서 참여할 수 있습니다.';
  return {
    progress: {
      caption: `목표 ${won(b.goalAmount)} 중 ${pct}% 모였습니다${b.daysLeft !== null ? ` · ${b.daysLeft}일 남음` : ''}`,
      durationSec: 6,
      label: '진행률',
      progress: pct,
    } satisfies SceneSpec,
    how: { caption: how, durationSec: 6, label: '참여 방법' } satisfies SceneSpec,
    howWithCloser: { caption: `${how} ${CLOSERS[b.tone]}`, durationSec: 7, label: '참여 방법' } satisfies SceneSpec,
  };
}

/** 형식별 장면 수 (검증·화면 공용) */
export const KIND_SCENE_RANGE: Record<ContentKind, [number, number]> = {
  SHORTFORM: [5, 8],
  IMAGE_SQUARE: [3, 3],
  IMAGE_STORY: [3, 3],
  CARD_NEWS: [5, 7],
  IMAGE_FEED: [1, 1],
};

export function defaultHashtags(b: ContentBrief) {
  const tags = ['기브싸인', '나눔', '후원', '사회복지', b.merchantName.replace(/\s/g, ''), b.campaignTitle.replace(/\s/g, '').slice(0, 12)];
  return [...new Set(tags.filter((t) => /^[\p{L}\p{N}_]{1,30}$/u.test(t)))];
}

export function mockScenes(b: ContentBrief, kind: ContentKind): SceneSpec[] {
  const story = firstSentence(b.story) ?? b.summary;
  const facts = factScenes(b);
  const clean = (s: SceneSpec): SceneSpec => ({ ...s, caption: scrub(s.caption, b.bannedWords) });
  if (kind === 'CARD_NEWS') {
    return [
      { caption: `${b.campaignTitle}`, durationSec: 5, label: '표지' },
      { caption: firstSentence(b.summary, 80) ?? b.summary, durationSec: 5, label: '문제' },
      ...(b.story ? [{ caption: firstSentence(b.story, 80)!, durationSec: 6, label: '사연' }] : []),
      ...(b.usagePlan ? [{ caption: `후원금은 이렇게 쓰입니다. ${firstSentence(b.usagePlan, 60)}`, durationSec: 6, label: '사용계획' }] : []),
      facts.progress,
      facts.how,
      { caption: CLOSERS[b.tone], durationSec: 5, label: '마무리' },
    ].map(clean);
  }
  if (kind === 'IMAGE_FEED') {
    return [clean({ caption: `${b.campaignTitle} · ${firstSentence(b.summary, 40) ?? ''}`.trim(), durationSec: 6, progress: progressPct(b) })];
  }
  const scenes: SceneSpec[] = [
    { caption: firstSentence(b.summary, 60) ?? OPENERS[b.tone], durationSec: 5, label: '표지' },
    { caption: `${b.merchantName} · ${b.campaignTitle}`, durationSec: 5, label: '캠페인' },
    { caption: story, durationSec: 7, label: '사연' },
    ...(b.usagePlan ? [{ caption: `후원금은 이렇게 쓰입니다. ${firstSentence(b.usagePlan, 40)}`, durationSec: 7, label: '사용계획' }] : []),
    facts.progress,
    facts.howWithCloser,
  ].map(clean);
  return kind === 'SHORTFORM' ? scenes : [scenes[1]!, scenes[2]!, scenes[scenes.length - 1]!];
}
