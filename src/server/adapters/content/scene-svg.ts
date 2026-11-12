import { SCENE_FONT_FAMILY } from './fonts';

export type SceneFormat = 'STORY' | 'SQUARE' | 'FEED';
export const FORMAT_SIZE: Record<SceneFormat, { w: number; h: number }> = {
  STORY: { w: 1080, h: 1920 }, SQUARE: { w: 1080, h: 1080 }, FEED: { w: 1080, h: 1350 },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const safeImage = (s?: string | null) => s && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 2_000_000 ? s : null;

/** 큰 제목, 사진 영역, 밝고 어두운 지면을 번갈아 사용하는 캠페인 편집 디자인. */
export function editorialSceneSvg(input: {
  caption: string; index: number; total: number; merchantName: string; color: string; footer: string;
  format: SceneFormat; label?: string; progress?: number; logo?: string | null; artwork?: string | null;
}, wrap: (s: string, perLine: number, maxLines: number) => string[]): string {
  const { w: W, h: H } = FORMAT_SIZE[input.format];
  const color = /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : '#28634e';
  const label = input.label || (input.index === 0 ? '함께 만드는 변화' : '우리의 이야기');
  const closing = /참여|마무리/.test(label);
  const dark = closing || label === '진행률';
  const bg = dark ? '#162f29' : input.index % 3 === 2 ? '#f8e9df' : '#faf5e9';
  const ink = dark ? '#ffffff' : '#203e33';
  const accent = dark ? '#dce8ba' : color;
  const logo = safeImage(input.logo);
  const artwork = safeImage(input.artwork);
  const illustrated = !!artwork && (input.index === 0 || label === '사연') && !dark;
  const perLine = illustrated ? 15 : 14;
  const lines = wrap(input.caption, perLine, 12);
  const budget = illustrated ? 0.28 : typeof input.progress === 'number' ? 0.32 : 0.40;
  const fs = Math.min(input.format === 'STORY' ? 88 : 76, H * budget / Math.max(1, lines.length) / 1.35);
  const lineH = fs * 1.35;
  const top = H * (illustrated ? 0.29 : 0.31);
  const pct = typeof input.progress === 'number' && Number.isFinite(input.progress) ? Math.max(0, Math.min(100, Math.round(input.progress))) : null;
  const footerLines = wrap(input.footer, 44, 3);
  const brandLines = wrap(input.merchantName, 22, 2);
  const elements = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${SCENE_FONT_FAMILY}" role="img" aria-label="${esc(input.caption)}">`,
    `<rect width="${W}" height="${H}" fill="${bg}"/>`,
    `<rect x="72" y="${H * 0.15}" width="64" height="6" fill="${accent}"/>`,
    logo ? `<image href="${logo}" x="72" y="56" width="64" height="64"/>` : '',
    ...brandLines.map((line, i) => `<text x="${logo ? 156 : 72}" y="${88 + i * 36}" font-size="28" font-weight="700" fill="${ink}">${esc(line)}</text>`),
    `<text x="1008" y="88" text-anchor="end" font-size="26" fill="${ink}">${String(input.index + 1).padStart(2, '0')} / ${String(input.total).padStart(2, '0')}</text>`,
    `<text x="72" y="${H * 0.20}" font-size="30" font-weight="700" fill="${accent}">${esc(label)}</text>`,
    ...lines.map((line, i) => `<text x="72" y="${top + i * lineH}" font-size="${fs}" font-weight="800" letter-spacing="-2" fill="${ink}">${esc(line)}</text>`),
  ];
  if (illustrated) {
    const y = Math.max(H * 0.60, top + (lines.length - 1) * lineH + 65);
    const height = H - 160 - y;
    if (height > 80) elements.push(`<svg x="0" y="${y}" width="${W}" height="${height}" viewBox="0 0 1080 608" preserveAspectRatio="xMidYMid slice"><image href="${artwork}" width="1080" height="608" preserveAspectRatio="xMidYMid slice"/></svg>`);
  } else if (pct !== null) {
    const y = Math.max(H * 0.70, top + lines.length * lineH + 30);
    elements.push(`<rect x="72" y="${y}" width="936" height="16" rx="8" fill="#ffffff" fill-opacity="0.15"/>`);
    if (pct > 0) elements.push(`<rect x="72" y="${y}" width="${936 * pct / 100}" height="16" rx="8" fill="${accent}"/>`);
    elements.push(`<text x="72" y="${y + 90}" font-size="56" font-weight="800" fill="${accent}">${pct}%의 마음이 모였습니다</text>`);
  } else {
    const y = Math.max(H * 0.73, top + lines.length * lineH + 20);
    elements.push(`<path d="M72 ${y} H1008" stroke="${accent}" stroke-opacity="0.35"/>`);
    if (closing) elements.push(`<text x="72" y="${y + 66}" font-size="32" font-weight="700" fill="${accent}">후원으로 함께해 주세요 →</text>`);
  }
  elements.push(`<rect y="${H - 130}" width="${W}" height="130" fill="${bg}"/>`, ...footerLines.map((line, i) => `<text x="72" y="${H - 88 + i * 30}" font-size="22" fill="${ink}" fill-opacity="0.75">${esc(line)}</text>`), '</svg>');
  return elements.join('');
}
