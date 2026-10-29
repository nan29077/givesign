import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const artwork = new URL('../public/assets/givesign-og-share-art-v4.png', import.meta.url);
const markSource = new URL('../public/givesign-mark-v4.svg', import.meta.url);
const output = new URL('../public/assets/givesign-og-share-v4.png', import.meta.url);

const escapeXml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const copy = {
  eyebrow: 'CREATOR SUPPORT',
  titleA: '문자 한 통으로',
  titleB: '마음을 방송에 전하세요',
  description: '사회복지기관와 후원자를 잇는 가장 간단한 응원',
  badge: '안전한 문자 후원  ·  실시간 방송 연동',
};

const overlay = Buffer.from(`
  <svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
    <rect x="58" y="55" width="660" height="520" rx="36" fill="#fffdf7" fill-opacity="0.88" stroke="#ddb980" stroke-opacity="0.58"/>
    <text x="196" y="126" fill="#17161a" font-family="Arial, sans-serif" font-size="52" font-weight="900" letter-spacing="-2">GIVESIGN</text>
    <text x="92" y="208" fill="#a86f25" font-family="Arial, sans-serif" font-size="18" font-weight="800" letter-spacing="3.5">${escapeXml(copy.eyebrow)}</text>
    <text x="90" y="286" fill="#17161a" font-family="Malgun Gothic, Arial, sans-serif" font-size="48" font-weight="900" letter-spacing="-2">${escapeXml(copy.titleA)}</text>
    <text x="90" y="352" fill="#17161a" font-family="Malgun Gothic, Arial, sans-serif" font-size="48" font-weight="900" letter-spacing="-2">${escapeXml(copy.titleB)}</text>
    <rect x="90" y="379" width="92" height="7" rx="3.5" fill="#e9a936"/>
    <rect x="188" y="379" width="28" height="7" rx="3.5" fill="#f36f5b"/>
    <text x="90" y="431" fill="#5f5a55" font-family="Malgun Gothic, Arial, sans-serif" font-size="22" font-weight="600">${escapeXml(copy.description)}</text>
    <rect x="90" y="480" width="430" height="54" rx="27" fill="#fff3d1" stroke="#e8c98f"/>
    <circle cx="120" cy="507" r="8" fill="#f36f5b"/>
    <text x="143" y="515" fill="#6b4b24" font-family="Malgun Gothic, Arial, sans-serif" font-size="19" font-weight="800">${escapeXml(copy.badge)}</text>
  </svg>
`);

const mark = await sharp(await readFile(markSource))
  .resize(90, 90, { fit: 'contain' })
  .png()
  .toBuffer();

const card = await sharp(await readFile(artwork))
  .resize(1200, 630, { fit: 'cover' })
  .composite([
    { input: overlay, left: 0, top: 0 },
    { input: mark, left: 91, top: 77 },
  ])
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toBuffer();

await writeFile(output, card);
console.log('Generated public/assets/givesign-og-share-v4.png (1200x630)');
