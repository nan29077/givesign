import { env } from '@/lib/env';
import { AdapterNotConfiguredError, type AdapterInfo } from '../types';

/**
 * 콘텐츠 생성 어댑터 (대본 LLM · 장면 이미지 · 음성 TTS).
 *
 * mock 공급자는 외부 AI 를 부르지 않는다. 기관·캠페인 데이터를 서식에 넣어 대본을 만들고,
 * 장면 이미지는 기관 색으로 그린 SVG(문자·도형만, 사람 사진 없음)로 만든다. 그래서 바로 내려받아 쓸 수 있다.
 * 음성(TTS)과 영상 조립(mp4)은 실제 공급자가 필요하므로 mock 에서는 만들지 않고, 그 사실을 결과에 남긴다
 * — 없는 결과물을 만든 척하지 않는다(절대 규칙 2).
 *
 * 수혜자 실사진·실명은 쓰지 않는다(초상권·복지 이용자 보호). 모든 산출물에 "AI 생성 콘텐츠" 표시를 넣는다.
 */

export type Tone = 'WARM' | 'HOPEFUL' | 'CALM' | 'URGENT';
export const TONE_LABEL: Record<Tone, string> = { WARM: '따뜻한', HOPEFUL: '희망찬', CALM: '차분한', URGENT: '긴급한' };

export interface ContentBrief {
  merchantName: string;
  campaignTitle: string;
  summary: string;
  story: string | null;
  beneficiary: string | null;
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

export interface GeneratedScript {
  title: string;
  script: string;
  scenes: Array<{ caption: string; durationSec: number }>;
  hashtags: string[];
}

export interface ContentGenAdapter {
  info(): AdapterInfo;
  script(brief: ContentBrief, kind: 'SHORTFORM' | 'IMAGE_SQUARE' | 'IMAGE_STORY'): Promise<{ data: GeneratedScript; costKrw: number }>;
  voice(script: string): Promise<{ available: boolean; note: string; costKrw: number }>;
  assemble(sceneCount: number): Promise<{ available: boolean; note: string; costKrw: number }>;
}

const OPENERS: Record<Tone, string> = {
  WARM: '오늘도 누군가의 하루를 따뜻하게 지키는 사람들이 있습니다.',
  HOPEFUL: '작은 마음이 모이면 내일이 달라집니다.',
  CALM: '천천히, 그러나 꾸준히 이웃 곁을 지키고 있습니다.',
  URGENT: '지금, 도움이 꼭 필요한 이웃이 있습니다.',
};
const CLOSERS: Record<Tone, string> = {
  WARM: '당신의 마음을 함께 보태 주세요.',
  HOPEFUL: '함께하면 희망이 됩니다.',
  CALM: '문자 한 통으로 곁에 서 주세요.',
  URGENT: '오늘 바로 함께해 주세요.',
};

function firstSentence(text: string | null, max = 46): string | null {
  if (!text) return null;
  const s = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?。])\s|\n/)[0] ?? '';
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : null;
}

function won(v: bigint) {
  return `${new Intl.NumberFormat('ko-KR').format(Number(v))}원`;
}

function scrub(text: string, banned: string[]) {
  let out = text;
  for (const w of banned) if (w) out = out.split(w).join('');
  return out.replace(/\s{2,}/g, ' ').trim();
}

export const mockContentAdapter: ContentGenAdapter = {
  info() {
    return { provider: 'mock', mode: 'mock', missingCredentials: [] };
  },
  async script(b, kind) {
    const pct = b.goalAmount > 0n ? Number((b.raisedAmount * 100n) / b.goalAmount) : 0;
    const story = firstSentence(b.story) ?? b.summary;
    const how = b.moNumber
      ? `${b.moNumber}${b.keyword ? ` 로 '${b.keyword}'` : ' 로'} 문자를 보내 주세요.`
      : '후원 페이지에서 참여할 수 있습니다.';
    const scenes = [
      { caption: OPENERS[b.tone], durationSec: 5 },
      { caption: `${b.merchantName} · ${b.campaignTitle}`, durationSec: 5 },
      { caption: story, durationSec: 7 },
      ...(b.beneficiary ? [{ caption: `함께할 이웃: ${firstSentence(b.beneficiary, 40)}`, durationSec: 6 }] : []),
      ...(b.usagePlan ? [{ caption: `후원금은 이렇게 쓰입니다. ${firstSentence(b.usagePlan, 40)}`, durationSec: 7 }] : []),
      { caption: `목표 ${won(b.goalAmount)} 중 ${pct}% 모였습니다${b.daysLeft !== null ? ` · ${b.daysLeft}일 남음` : ''}`, durationSec: 6 },
      { caption: `${how} ${CLOSERS[b.tone]}`, durationSec: 7 },
    ].map((s) => ({ ...s, caption: scrub(s.caption, b.bannedWords) }));
    const useScenes = kind === 'SHORTFORM' ? scenes : [scenes[1]!, scenes[2]!, scenes[scenes.length - 1]!];
    const tags = ['기브싸인', '나눔', '후원', '사회복지', b.merchantName.replace(/\s/g, ''), b.campaignTitle.replace(/\s/g, '').slice(0, 12)];
    return {
      data: {
        title: `${b.campaignTitle} — ${TONE_LABEL[b.tone]} 이야기`,
        script: useScenes.map((s) => s.caption).join('\n'),
        scenes: useScenes,
        hashtags: [...new Set(tags.filter(Boolean))],
      },
      costKrw: 0,
    };
  },
  async voice() {
    return { available: false, note: 'mock: 음성(TTS) 공급자 연결 전이라 내레이션 음성을 만들지 않았습니다. 자막 영상으로 쓰거나 공급자 연결 뒤 다시 만드세요.', costKrw: 0 };
  },
  async assemble(sceneCount) {
    return { available: false, note: `mock: 영상(mp4) 조립 공급자 연결 전입니다. 장면 ${sceneCount}개 SVG 와 자막 대본으로 미리보기·내려받기가 됩니다.`, costKrw: 0 };
  },
};

export function getContentAdapter(): ContentGenAdapter {
  if (env.automation.contentProvider === 'mock') return mockContentAdapter;
  const provider = env.automation.contentProvider;
  return {
    info: () => ({ provider, mode: 'live', missingCredentials: [`${provider.toUpperCase()}_API_KEY 연동 구현`] }),
    async script() {
      throw new AdapterNotConfiguredError(provider, [`${provider.toUpperCase()}_API_KEY`]);
    },
    async voice() {
      throw new AdapterNotConfiguredError(provider, ['TTS']);
    },
    async assemble() {
      throw new AdapterNotConfiguredError(provider, ['VIDEO']);
    },
  };
}

// ---------------------------------------------------------------------------
// SVG 장면 렌더 (공급자와 무관하게 서버에서 그린다)
// ---------------------------------------------------------------------------

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 한글 기준 대략 글자 수로 줄을 나눈다. */
export function wrapText(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if ((cur + (cur ? ' ' : '') + w).length > perLine && cur) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
    while (cur.length > perLine) {
      lines.push(cur.slice(0, perLine));
      cur = cur.slice(perLine);
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = `${cut[maxLines - 1]!.slice(0, perLine - 1)}…`;
    return cut;
  }
  return lines;
}

function safeColor(c: string) {
  return /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#28634e';
}

export function renderSceneSvg(input: {
  caption: string;
  index: number;
  total: number;
  merchantName: string;
  color: string;
  footer: string;
  format: 'STORY' | 'SQUARE';
}): string {
  const W = 1080;
  const H = input.format === 'STORY' ? 1920 : 1080;
  const color = safeColor(input.color);
  const lines = wrapText(input.caption, input.format === 'STORY' ? 13 : 15, input.format === 'STORY' ? 6 : 4);
  const fs = input.format === 'STORY' ? 76 : 64;
  const lh = fs * 1.4;
  const top = H / 2 - (lines.length * lh) / 2 + fs * 0.35;
  const seed = (input.index * 97 + input.merchantName.length * 13) % 360;
  const text = lines
    .map((l, i) => `<text x="${W / 2}" y="${top + i * lh}" text-anchor="middle" font-size="${fs}" font-weight="800" fill="#ffffff">${esc(l)}</text>`)
    .join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="Pretendard, 'Noto Sans KR', sans-serif">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#0f1f1a"/></linearGradient></defs>`,
    `<rect width="${W}" height="${H}" fill="url(#g)"/>`,
    `<circle cx="${W * 0.82}" cy="${H * 0.16}" r="${W * 0.28}" fill="#ffffff" fill-opacity="0.07" transform="rotate(${seed} ${W / 2} ${H / 2})"/>`,
    `<circle cx="${W * 0.12}" cy="${H * 0.86}" r="${W * 0.22}" fill="#ffffff" fill-opacity="0.05"/>`,
    `<path d="M${W / 2 - 36} ${H * 0.2} c-24 -40 -96 -28 -96 24 c0 44 60 76 96 104 c36 -28 96 -60 96 -104 c0 -52 -72 -64 -96 -24z" fill="#ffffff" fill-opacity="0.9"/>`,
    `<text x="64" y="${input.format === 'STORY' ? 140 : 110}" font-size="40" font-weight="700" fill="#ffffff" fill-opacity="0.92">${esc(input.merchantName)}</text>`,
    `<text x="${W - 64}" y="${input.format === 'STORY' ? 140 : 110}" text-anchor="end" font-size="34" fill="#ffffff" fill-opacity="0.7">${input.index + 1}/${input.total}</text>`,
    text,
    `<rect x="0" y="${H - 120}" width="${W}" height="120" fill="#000000" fill-opacity="0.35"/>`,
    `<text x="${W / 2}" y="${H - 50}" text-anchor="middle" font-size="30" fill="#ffffff" fill-opacity="0.9">${esc(input.footer)}</text>`,
    `</svg>`,
  ].join('');
}
