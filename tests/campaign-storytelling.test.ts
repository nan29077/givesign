import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import { campaignStoryCards } from '@/lib/campaign-storytelling';
import { campaignCardsSchema } from '@/lib/fundraising';
import { mockContentAdapter, renderSceneSvg } from '@/server/adapters/content';
import { assembleVideo } from '@/server/adapters/content/video';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { updateContentDraft } from '@/server/services/content';
import { resetDb, seedBasics } from './helpers';

it('캠페인의 사연·필요·변화·사용 계획을 각 카드에 담고 구간 이름을 보존한다', () => {
  const cards = campaignCardsSchema.parse(campaignStoryCards({ title: '겨울 식사', summary: '따뜻한 식사를 전합니다', story: '사연 본문\n\n현재 필요한 도움\n\n기대하는 변화', usagePlan: '식재료와 배달', imageUrl: '/assets/givesign/presets/banner-1.webp' }));
  expect(cards[0].imageUrl).toContain('banner-1');
  expect(cards.slice(1, 5).map(c => c.body)).toEqual(['사연 본문', '현재 필요한 도움', '기대하는 변화', '식재료와 배달']);
  expect(cards[4].eyebrow).toBe('후원금 사용 계획');
  expect(JSON.stringify(cards)).not.toMatch(/월드비전|리나|키링/);
});

it('자료가 비어 있으면 통계와 사례를 만들지 않고 작성 안내를 넣는다', () => {
  const cards = campaignStoryCards({ title: '', summary: '', story: '', usagePlan: '' });
  expect(cards[1].body).toContain('적어 주세요');
  expect(cards[4].body).toContain('확인한 사용 계획');
});

it('외부 이미지는 SVG에 삽입하지 않고 자막과 기관명은 이스케이프한다', () => {
  const svg = renderSceneSvg({ caption: '<script>위험</script>', merchantName: '기관 & 이웃', index: 0, total: 1, color: '#ffffff', footer: 'AI 생성 콘텐츠', format: 'FEED', artwork: 'https://example.com/x.png', logo: 'javascript:alert(1)' });
  expect(svg).not.toContain('<image');
  expect(svg).not.toContain('<script>');
  expect(svg).toContain('기관 &amp; 이웃');
  expect(svg).toContain('height="1350"');
});

it('설정 없이도 기본 FFmpeg로 자막이 포함된 9:16 MP4를 실제 생성한다', async () => {
  const previous = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = '';
  try {
    const svg = renderSceneSvg({ caption: '이웃의 내일을 함께 지켜 주세요', merchantName: '기브싸인', index: 0, total: 1, color: '#28634e', footer: 'AI 생성 콘텐츠 · 기부금품 모집등록 테스트', format: 'STORY' });
    const result = await assembleVideo({ scenes: [{ svg, durationSec: 1 }] });
    expect(result.available, result.note).toBe(true);
    const file = path.join('var/uploads', result.videoUrl!.split('/').pop()!);
    expect(readFileSync(file).subarray(4, 8).toString()).toBe('ftyp');
    const decoded = execFileSync(ffmpeg!, ['-hide_banner', '-i', file, '-f', 'null', '-'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(decoded).toBe('');
  } finally {
    if (previous === undefined) delete process.env.FFMPEG_PATH; else process.env.FFMPEG_PATH = previous;
  }
}, 60000);

it('숏폼 자막을 수정하면 새 장면으로 MP4를 조립하고 이전 영상과 승인 상태를 교체한다', async () => {
  await resetDb();
  const fx = await seedBasics();
  const id = newId();
  await prisma.contentItem.create({ data: {
    id, merchantId: fx.merchantId, kind: 'SHORTFORM', status: 'APPROVED', provider: 'mock', createdBy: fx.merchantUserId,
    title: '식사 지원', scenes: [{ caption: '이전 자막', durationSec: 1 }], videoUrl: '/api/media/old.mp4',
  } });
  const assemble = vi.spyOn(mockContentAdapter, 'assemble').mockResolvedValue({ available: true, note: '새 자막 영상', costKrw: 0, videoUrl: '/api/media/revised.mp4' });
  try {
    const result = await updateContentDraft(fx.merchantId, id, { captions: ['수정한 자막'], caption: '후원하기 {링크}\nAI 생성 콘텐츠' });
    expect(assemble.mock.calls[0][0].scenes[0].svg).toContain('수정한 자막');
    expect(result.videoUrl).toBe('/api/media/revised.mp4');
    expect(result.status).toBe('REVIEW');
    const job = await prisma.contentJob.findFirstOrThrow({ where: { itemId: id, step: 'ASSEMBLE' } });
    expect(job.output).toMatchObject({ note: '새 자막 영상' });
  } finally { assemble.mockRestore(); }
});
