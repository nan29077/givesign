import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { ulid } from 'ulid';
import { defaultDonationPage, pageKey, campaignKey } from '../src/lib/fundraising';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
async function main() { try {
  const org = await prisma.merchantProfile.findUniqueOrThrow({ where: { code: 'GIV-8K2M' } });
  // This script operates only on the explicitly named local seed institution.
  if (org.displayName !== '햇살종합사회복지관') throw new Error('로컬 시드 기관에서만 실행할 수 있습니다.');
  const rows = await prisma.systemSetting.findMany({ where: { key: { startsWith: `givesign:campaign:${org.id}:` } } });
  for (const row of rows) {
    const value = row.value as { title?: string };
    if (/\((검수 캠페인|수정 검증)\)$/.test(value.title || '')) await prisma.systemSetting.delete({ where: { key: row.key } });
  }
  await prisma.systemSetting.upsert({ where: { key: pageKey(org.id) }, create: { key: pageKey(org.id), value: { ...defaultDonationPage, title: '작은 나눔이 이웃의 든든한 한 끼가 됩니다', published: true } }, update: { value: { ...defaultDonationPage, title: '작은 나눔이 이웃의 든든한 한 끼가 됩니다', published: true } } });
  const id = ulid();
  await prisma.systemSetting.create({ data: { key: campaignKey(org.id, id), value: { id, merchantId: org.id, createdAt: new Date().toISOString(), title: '한 끼에 담은 희망 (예시)', summary: '돌봄이 필요한 이웃에게 따뜻한 도시락을 전합니다. 이 캠페인은 검수용 예시입니다.', story: '누군가의 안부가 담긴 한 끼가 이웃의 하루를 바꿉니다. 지역사회와 함께 건강한 식사를 준비하고 정기적으로 전달하는 캠페인입니다.', beneficiary: '식사 지원이 필요한 지역의 어르신과 취약가정 (예시)', usage: '도시락 식재료 구입, 조리와 포장, 이웃에게 전달하는 활동에 사용합니다. 실제 사업 계획은 기관에서 작성해 주세요.', image: '/assets/givesign/banner.png', goal: 1000000, start: '2026-10-01', end: '2026-12-31', published: true } } });
  // Replace original payment-service sample posts with welfare-specific sample content.
  await prisma.contentPost.updateMany({ where: { type: 'FAQ', title: '충전은 언제 반영되나요?' }, data: { title: '후원 내역은 언제 확인할 수 있나요?', body: '결제 완료 후 후원 내역에서 결과를 확인할 수 있습니다. 기관 정산은 별도의 정산 일정에 따라 진행됩니다.', category: '후원 안내' } });
  await prisma.contentPost.updateMany({ where: { type: 'FAQ', title: '문자후원는 어떻게 이용하나요?' }, data: { title: '문자후원은 어떻게 이용하나요?', body: '기관 MO 번호로 문자를 보내고 받은 안내 링크에서 기관과 금액을 확인한 뒤 승인합니다.' } });
  console.log('GiveSign local demo page and welfare campaign prepared.');
} finally { await prisma.$disconnect(); } }
main().catch(e => { console.error(e); process.exitCode = 1; });
