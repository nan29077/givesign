import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

// 원본 사진은 contain으로 전체 표시하고 모든 핵심 요소를 중앙 600px 안에 둔다.
// 1200×630 가로형 카드와 가운데 정사각형 크롭에 모두 대응하는 구도.
const logo = await sharp('public/assets/givesign/brand/logo-hope-transparent-v7.png').resize(270,86,{fit:'inside'}).png().toBuffer();
const variants = [
  {file:'givesign-share-v9.png',photo:1,lines:['작은 나눔이,','자라나는 희망으로']},
  {file:'givesign-campaign-share-v9-1.png',photo:1,lines:['따뜻한 한 끼가,','이웃의 내일이 됩니다']},
  {file:'givesign-campaign-share-v9-2.png',photo:2,lines:['아이들의 꿈에,','당신의 마음을 더해요']},
  {file:'givesign-campaign-share-v9-3.png',photo:3,lines:['곁을 지키는 나눔,','함께하는 든든한 일상']},
  {file:'givesign-campaign-share-v9-4.png',photo:4,lines:['작은 나눔이,','마을의 희망으로 자랍니다']},
  {file:'givesign-campaign-share-v9-5.png',photo:5,lines:['함께 걷는 오늘,','더 따뜻한 내일']},
];
await mkdir('output/qa',{recursive:true});
for (const v of variants) {
  const photo = await sharp(`public/assets/givesign/presets/banner-${v.photo}.webp`).resize(540,304,{fit:'contain',background:'#f8f5ec'}).png().toBuffer();
  const mask = Buffer.from('<svg width="540" height="304"><rect width="540" height="304" rx="22" fill="white"/></svg>');
  const rounded = await sharp(photo).composite([{input:mask,blend:'dest-in'}]).png().toBuffer();
  const bg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#f8f5ec"/><circle cx="50" cy="50" r="200" fill="#edf1e4"/><circle cx="1180" cy="650" r="230" fill="#eee8d9"/><path d="M165 430Q240 320 195 230Q110 345 165 430" fill="#e2ead9"/><path d="M1045 170Q990 280 1040 375Q1110 280 1045 170" fill="#e2ead9"/><text x="600" y="183" text-anchor="middle" font-family="Malgun Gothic" font-size="37" font-weight="900" fill="#124c3a">${v.lines[0]}</text><text x="600" y="231" text-anchor="middle" font-family="Malgun Gothic" font-size="37" font-weight="900" fill="#124c3a">${v.lines[1]}</text></svg>`);
  await sharp(bg).composite([{input:logo,left:465,top:43},{input:rounded,left:330,top:274}]).png().toFile(`public/assets/${v.file}`);
}
const thumbs=[];
for(let i=0;i<variants.length;i++){
 const full=await sharp(`public/assets/${variants[i].file}`).resize(480,252).png().toBuffer();
 const square=await sharp(`public/assets/${variants[i].file}`).extract({left:285,top:0,width:630,height:630}).resize(252,252).png().toBuffer();
 thumbs.push({input:full,left:0,top:i*264},{input:square,left:492,top:i*264});
}
await sharp({create:{width:744,height:1584,channels:4,background:'#ffffff'}}).composite(thumbs).png().toFile('output/qa/share-cards-v9-crop-check.png');
console.log('공유카드 6종 및 가로/정사각형 검수 이미지 생성 완료');
