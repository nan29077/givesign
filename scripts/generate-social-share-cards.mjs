import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';

// 사진을 작은 박스에 넣지 않고 카드 전체에 크게 표시한다.
// 주요 인물과 로고·문구는 중앙 정사각형 영역에서도 확인할 수 있도록 배치한다.
const logo = await sharp('public/assets/givesign/brand/logo-hope-transparent-v7.png').resize(230,74,{fit:'inside'}).png().toBuffer();
const photo = await sharp('public/assets/givesign/brand/share-community-v10.webp').resize(1200,630,{fit:'cover',position:'centre'}).png().toBuffer();
const variants = [
  {file:'givesign-share-v10.png',lines:['작은 나눔이,','자라나는 희망으로']},
  {file:'givesign-campaign-share-v10-1.png',lines:['따뜻한 한 끼가,','이웃의 내일이 됩니다']},
  {file:'givesign-campaign-share-v10-2.png',lines:['아이들의 꿈에,','당신의 마음을 더해요']},
  {file:'givesign-campaign-share-v10-3.png',lines:['곁을 지키는 나눔,','함께하는 든든한 일상']},
  {file:'givesign-campaign-share-v10-4.png',lines:['작은 나눔이,','마을의 희망으로 자랍니다']},
  {file:'givesign-campaign-share-v10-5.png',lines:['함께 걷는 오늘,','더 따뜻한 내일']},
];
await mkdir('output/qa',{recursive:true});
for (const v of variants) {
  const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#153f30" stop-opacity="0"/><stop offset="1" stop-color="#153f30" stop-opacity=".94"/></linearGradient></defs><rect y="445" width="1200" height="185" fill="url(#shade)"/><text x="600" y="535" text-anchor="middle" font-family="Malgun Gothic" font-size="34" font-weight="700" fill="#f8f5e9">${v.lines[0]}</text><text x="600" y="589" text-anchor="middle" font-family="Malgun Gothic" font-size="43" font-weight="900" fill="#ffffff">${v.lines[1]}</text></svg>`);
  await sharp(photo).composite([{input:logo,left:485,top:12},{input:overlay}]).png().toFile(`public/assets/${v.file}`);
}
const thumbs=[];
for(let i=0;i<variants.length;i++){
 const full=await sharp(`public/assets/${variants[i].file}`).resize(480,252).png().toBuffer();
 const square=await sharp(`public/assets/${variants[i].file}`).extract({left:285,top:0,width:630,height:630}).resize(252,252).png().toBuffer();
 thumbs.push({input:full,left:0,top:i*264},{input:square,left:492,top:i*264});
}
await sharp({create:{width:744,height:1584,channels:4,background:'#ffffff'}}).composite(thumbs).png().toFile('output/qa/share-cards-v10-crop-check.png');
console.log('이미지 전체형 공유카드 6종 생성 완료');
