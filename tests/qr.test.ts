import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@/server/db';
import { campaignSchema } from '@/lib/fundraising';
import { saveCampaign, setCampaignStatus } from '@/server/services/fundraising';
import { qrFileName, renderQr, resolveQrTarget } from '@/server/services/qr';
import { resetDb, seedBasics, type Fixture } from './helpers';

/**
 * 후원페이지·캠페인 QR.
 *  1) 기관 QR 은 후원페이지, 캠페인 QR 은 그 기관의 캠페인 페이지를 가리키고 유입 경로 src=qr 가 붙는다.
 *  2) 미승인 기관·다른 기관 캠페인·보관한 캠페인은 QR 을 만들지 않는다(범용 QR 생성기가 아니다).
 *  3) PNG·SVG 모두 만들어진다.
 */
let fx: Fixture;
let code: string;

beforeEach(async () => {
  await resetDb();
  fx = await seedBasics();
  code = (await prisma.merchantProfile.findUniqueOrThrow({ where: { id: fx.merchantId } })).code;
});

async function campaign(merchantId = fx.merchantId, kw = 'QRTEST') {
  const c = await saveCampaign(merchantId, campaignSchema.parse({ code: kw, title: '겨울 이불 나눔', summary: '이불을 전합니다', goalAmount: 100000, startsOn: '2026-01-01', endsOn: '2099-12-31' }));
  await setCampaignStatus(merchantId, c.id, 'ACTIVE');
  return c;
}

describe('QR 코드', () => {
  it('후원페이지와 캠페인 QR 이 각자의 주소와 유입 경로를 담는다', async () => {
    const page = await resolveQrTarget(code);
    expect(page!.url).toMatch(new RegExp(`/donate/${code}\\?src=qr$`));
    const c = await campaign();
    const t = await resolveQrTarget(code.toLowerCase(), c.id);
    expect(t!.url).toMatch(new RegExp(`/donate/${code}/campaigns/${c.id}\\?src=qr$`));
    expect(qrFileName(t!, 'png')).toBe(`qr-${code}-겨울-이불-나눔.png`);
    const png = (await renderQr(t!.url, 'png', 512)) as Buffer;
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    const svg = (await renderQr(t!.url, 'svg')) as string;
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('미승인 기관·다른 기관 캠페인·보관한 캠페인은 QR 을 만들지 않는다', async () => {
    const c = await campaign();
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'SUSPENDED' } });
    expect(await resolveQrTarget(code)).toBeNull();
    await prisma.merchantProfile.update({ where: { id: fx.merchantId }, data: { status: 'APPROVED' } });
    expect(await resolveQrTarget(code, 'NOT-A-CAMPAIGN')).toBeNull();
    await prisma.campaign.update({ where: { id: c.id }, data: { status: 'ARCHIVED' } });
    expect(await resolveQrTarget(code, c.id)).toBeNull();
    expect(await resolveQrTarget('<script>')).toBeNull();
  });
});
