import QRCode from 'qrcode';
import { env } from '@/lib/env';
import { attributionQuery } from '@/lib/attribution';
import { normalizeMerchantCode } from '@/lib/id';
import { prisma } from '@/server/db';

/**
 * 후원페이지 · 캠페인 QR 코드.
 *
 * QR 은 기관 후원페이지(/donate/[code]) 또는 그 기관의 캠페인 페이지(/donate/[code]/campaigns/[id])만 가리킨다.
 * 임의 주소를 QR 로 만들어 주는 범용 생성기가 아니다 — 승인된 기관·그 기관의 캠페인만 받는다.
 * 주소에는 유입 경로 ?src=qr 가 붙어 QR 로 들어온 후원·약정·봉사 신청이 따로 집계된다.
 */

export type QrFormat = 'png' | 'svg';

export interface QrTarget {
  merchantCode: string;
  merchantName: string;
  campaignId: string | null;
  campaignTitle: string | null;
  url: string;
}

export function donationPageUrl(code: string) {
  return `${env.baseUrl}/donate/${code}?${attributionQuery('QR')}`;
}

export function campaignUrl(code: string, campaignId: string) {
  return `${env.baseUrl}/donate/${code}/campaigns/${campaignId}?${attributionQuery('QR')}`;
}

export async function resolveQrTarget(rawCode: string, campaignId?: string | null): Promise<QrTarget | null> {
  const code = normalizeMerchantCode(rawCode);
  if (!code) return null;
  const m = await prisma.merchantProfile.findFirst({
    where: { code, status: 'APPROVED', user: { status: 'ACTIVE', deletedAt: null } },
    select: { id: true, code: true, displayName: true },
  });
  if (!m) return null;
  if (!campaignId) return { merchantCode: m.code, merchantName: m.displayName, campaignId: null, campaignTitle: null, url: donationPageUrl(m.code) };
  const c = await prisma.campaign.findFirst({
    where: { id: campaignId, merchantId: m.id, status: { not: 'ARCHIVED' } },
    select: { id: true, title: true },
  });
  if (!c) return null;
  return { merchantCode: m.code, merchantName: m.displayName, campaignId: c.id, campaignTitle: c.title, url: campaignUrl(m.code, c.id) };
}

const COLORS = { dark: '#17261f', light: '#ffffff' };

export async function renderQr(url: string, format: QrFormat, size = 1024): Promise<Buffer | string> {
  const opts = { errorCorrectionLevel: 'H' as const, margin: 2, color: COLORS };
  if (format === 'svg') return QRCode.toString(url, { ...opts, type: 'svg' });
  return QRCode.toBuffer(url, { ...opts, type: 'png', width: Math.min(Math.max(size, 256), 2048) });
}

export function qrFileName(t: QrTarget, format: QrFormat) {
  const safe = (s: string) => s.replace(/[^0-9A-Za-z가-힣_-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const base = t.campaignTitle ? `${t.merchantCode}-${safe(t.campaignTitle)}` : `${t.merchantCode}-후원페이지`;
  return `qr-${base}.${format}`;
}
