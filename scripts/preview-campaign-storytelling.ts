import { mkdir, readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { renderSceneSvg } from '../src/server/adapters/content';
import { mockScenes, type ContentBrief } from '../src/server/adapters/content/brief';

async function main() {
const dir = 'output/qa/campaign-storytelling';
await mkdir(dir, { recursive: true });
const artwork = `data:image/png;base64,${(await sharp(await readFile('public/assets/givesign/presets/banner-1.webp')).resize(1080, 608).png().toBuffer()).toString('base64')}`;
const brief: ContentBrief = {
  merchantName: '햇살종합사회복지관', campaignTitle: '한 끼에 담긴 따뜻한 마음', summary: '이웃에게 따뜻한 식사와 안부를 전합니다.',
  story: '혼자 식사를 준비하기 어려운 이웃에게 식사와 안부를 함께 전하고자 합니다.', usagePlan: '식재료 구입과 식사 배달에 사용합니다.',
  goalAmount: 3000000n, raisedAmount: 1050000n, daysLeft: 20, keyword: '한끼', moNumber: '1588-1234', tone: 'WARM', color: '#28634e', regNo: '제2026-예시호', bannedWords: [],
};
const scenes = mockScenes(brief, 'CARD_NEWS');
const tiles = [];
for (const [i, scene] of scenes.entries()) {
  const svg = renderSceneSvg({ ...scene, index: i, total: scenes.length, merchantName: brief.merchantName, color: brief.color, footer: 'AI 생성 콘텐츠 · 기부금품 모집등록 제2026-예시호', format: 'FEED', artwork });
  await writeFile(`${dir}/card-${i + 1}.svg`, svg);
  const input = await sharp(Buffer.from(svg)).resize(360, 450).png().toBuffer();
  tiles.push({ input, left: (i % 4) * 360, top: Math.floor(i / 4) * 450 });
}
await sharp({ create: { width: 1440, height: Math.ceil(scenes.length / 4) * 450, channels: 3, background: '#e5e7e2' } }).composite(tiles).png().toFile(`${dir}/cards.png`);
console.log(`${dir}/cards.png`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
