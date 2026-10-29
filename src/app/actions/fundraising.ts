'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { requireMerchant, writeAudit } from '@/server/auth';
import { prisma } from '@/server/db';
import { logger } from '@/lib/logger';
import { campaignSchema, donationPageSchema } from '@/lib/fundraising';
import {
  CampaignCodeTakenError,
  saveCampaign,
  saveDonationPage,
  setCampaignStatus,
} from '@/server/services/fundraising';
import {
  issueReceipt,
  issueReceiptsBulk,
  reissueReceipt,
  voidReceipt,
  ReceiptError,
} from '@/server/services/receipts';
import type { StudioActionState } from '@/app/actions/studio';
import type { CampaignStatus, OrganizationType } from '@/generated/prisma/enums';

/**
 * 기관 콘솔 — 캠페인 · 후원페이지 · 기관 정보 · 기부금영수증 액션.
 * (판매·주문 액션은 actions/studio.ts 에 그대로 있다)
 */

type Handler = (merchantId: string, userId: string) => Promise<StudioActionState>;

async function withMerchant(fn: Handler): Promise<StudioActionState> {
  let merchantId: string;
  let userId: string;
  try {
    const user = await requireMerchant();
    merchantId = user.merchantId;
    userId = user.id;
  } catch (e) {
    return { ok: false, message: (e as Error).message || '기관 권한이 필요합니다.' };
  }
  try {
    return await fn(merchantId, userId);
  } catch (e) {
    const message = (e as Error)?.message ?? '';
    if (e instanceof ReceiptError || e instanceof CampaignCodeTakenError) return { ok: false, message };
    const internal = !message || /prisma|invocation|decrypt|ECONNREFUSED|ETIMEDOUT/i.test(message) || !/[가-힣]/.test(message);
    if (internal) {
      logger.error('기관 콘솔(모금) 액션 처리 오류', { message });
      return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
    }
    return { ok: false, message };
  }
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};
const checked = (f: FormData, k: string) => f.get(k) != null;

function revalidateFundraising() {
  revalidatePath('/studio');
  revalidatePath('/studio/campaigns');
  revalidatePath('/studio/donation-page');
  revalidatePath('/donate', 'layout');
}

// ---------------------------------------------------------------------------
// 캠페인
// ---------------------------------------------------------------------------

export async function saveCampaignAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(f, 'id') || undefined;
    const parsed = campaignSchema.safeParse({
      code: text(f, 'code'),
      title: text(f, 'title'),
      summary: text(f, 'summary'),
      story: text(f, 'story'),
      beneficiary: text(f, 'beneficiary'),
      usagePlan: text(f, 'usagePlan'),
      imageUrl: text(f, 'imageUrl'),
      goalAmount: text(f, 'goalAmount').replace(/,/g, ''),
      startsOn: text(f, 'startsOn'),
      endsOn: text(f, 'endsOn'),
      featured: checked(f, 'featured'),
      resultReport: text(f, 'resultReport'),
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.' };
    const saved = await saveCampaign(merchantId, parsed.data, id);
    revalidateFundraising();
    return {
      ok: true,
      message: id ? '캠페인을 저장했습니다.' : '캠페인을 만들었습니다. 공개하려면 "모금 시작" 을 눌러 주세요.',
      redirectTo: id ? undefined : `/studio/campaigns/${saved.id}`,
    };
  });
}

export async function setCampaignStatusAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const id = text(f, 'id');
    const next = text(f, 'status') as CampaignStatus;
    if (!['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED'].includes(next)) return { ok: false, message: '알 수 없는 상태입니다.' };
    if (next === 'ACTIVE') {
      // 모금을 시작하려면 기관 후원페이지가 없어도 되지만, 키워드 안내가 나갈 MO 번호는 있어야 한다.
      const mo = await prisma.merchantMoNumber.count({ where: { merchantId, status: 'ASSIGNED' } });
      if (mo === 0) return { ok: false, message: '배정된 MO 번호가 없어 문자 후원을 받을 수 없습니다. 관리자에게 번호 배정을 요청해 주세요.' };
    }
    await setCampaignStatus(merchantId, id, next);
    revalidateFundraising();
    const label: Record<CampaignStatus, string> = { DRAFT: '작성 중으로 되돌렸습니다.', ACTIVE: '모금을 시작했습니다.', CLOSED: '모금을 종료했습니다.', ARCHIVED: '보관했습니다.' };
    return { ok: true, message: label[next] };
  });
}

// ---------------------------------------------------------------------------
// 후원페이지
// ---------------------------------------------------------------------------

export async function saveDonationPageAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const parsed = donationPageSchema.safeParse({
      title: text(f, 'title'),
      subtitle: text(f, 'subtitle'),
      intro: text(f, 'intro'),
      heroUrl: text(f, 'heroUrl'),
      logoUrl: text(f, 'logoUrl'),
      color: text(f, 'color') || '#28634e',
      thanks: text(f, 'thanks'),
      transparencyUrl: text(f, 'transparencyUrl'),
      published: checked(f, 'published'),
      showCampaigns: checked(f, 'showCampaigns'),
      showProgress: checked(f, 'showProgress'),
      showRecentDonors: checked(f, 'showRecentDonors'),
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.' };
    await saveDonationPage(merchantId, parsed.data);
    revalidateFundraising();
    return { ok: true, message: parsed.data.published ? '후원페이지를 저장하고 공개했습니다.' : '후원페이지를 저장했습니다(비공개).' };
  });
}

// ---------------------------------------------------------------------------
// 기관 정보 (기부금영수증 발급 주체)
// ---------------------------------------------------------------------------

const ORG_TYPES: OrganizationType[] = ['WELFARE_CORPORATION', 'WELFARE_FACILITY', 'NONPROFIT_ORG', 'PUBLIC_INTEREST_CORP', 'RELIGIOUS', 'OTHER'];

export async function saveOrganizationInfoAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId) => {
    const schema = z.object({
      orgType: z.enum(ORG_TYPES as [OrganizationType, ...OrganizationType[]]).nullable(),
      businessNo: z.string().regex(/^(\d{3}-\d{2}-\d{5}|\d{10})?$/, '고유번호(사업자등록번호)는 000-00-00000 형식입니다.'),
      representativeName: z.string().max(30),
      address: z.string().max(200),
      contactName: z.string().max(30),
      contactPhone: z.string().regex(/^[\d-]{0,14}$/, '연락처는 숫자와 - 만 입력합니다.'),
      contactEmail: z.union([z.literal(''), z.email('이메일 형식을 확인해 주세요.')]),
      designatedDonee: z.boolean(),
      designatedDoneeUntil: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/),
      donationCode: z.enum(['10', '40', '41']),
      fundraisingRegNo: z.string().max(40),
      fundraisingRegAuthority: z.string().max(40),
    });
    const parsed = schema.safeParse({
      orgType: text(f, 'orgType') || null,
      businessNo: text(f, 'businessNo'),
      representativeName: text(f, 'representativeName'),
      address: text(f, 'address'),
      contactName: text(f, 'contactName'),
      contactPhone: text(f, 'contactPhone'),
      contactEmail: text(f, 'contactEmail'),
      designatedDonee: checked(f, 'designatedDonee'),
      designatedDoneeUntil: text(f, 'designatedDoneeUntil'),
      donationCode: text(f, 'donationCode') || '40',
      fundraisingRegNo: text(f, 'fundraisingRegNo'),
      fundraisingRegAuthority: text(f, 'fundraisingRegAuthority'),
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.' };
    const d = parsed.data;
    const bn = d.businessNo.replace(/-/g, '');
    await prisma.merchantProfile.update({
      where: { id: merchantId },
      data: {
        orgType: d.orgType,
        businessNo: bn ? `${bn.slice(0, 3)}-${bn.slice(3, 5)}-${bn.slice(5)}` : null,
        representativeName: d.representativeName || null,
        address: d.address || null,
        contactName: d.contactName || null,
        contactPhone: d.contactPhone || null,
        contactEmail: d.contactEmail || null,
        designatedDonee: d.designatedDonee,
        designatedDoneeUntil: d.designatedDoneeUntil ? new Date(`${d.designatedDoneeUntil}T00:00:00Z`) : null,
        donationCode: d.donationCode,
        fundraisingRegNo: d.fundraisingRegNo || null,
        fundraisingRegAuthority: d.fundraisingRegAuthority || null,
      },
    });
    revalidatePath('/studio/profile');
    revalidatePath('/studio/receipts');
    revalidatePath('/donate', 'layout');
    return { ok: true, message: '기관 정보를 저장했습니다.' };
  });
}

// ---------------------------------------------------------------------------
// 기부금영수증
// ---------------------------------------------------------------------------

function parseYear(v: string): number | null {
  const n = Number(v);
  const now = new Date().getFullYear();
  return Number.isInteger(n) && n >= 2020 && n <= now ? n : null;
}

export async function issueReceiptAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const year = parseYear(text(f, 'taxYear'));
    const payerId = text(f, 'payerId');
    if (!year || !payerId) return { ok: false, message: '귀속 연도와 후원자를 확인해 주세요.' };
    const { receipt } = await issueReceipt({ merchantId, payerId, taxYear: year, issuedBy: userId });
    await writeAudit({ adminUserId: undefined, action: 'RECEIPT_ISSUE', targetType: 'DonationReceipt', targetId: receipt.id, after: { receiptNo: receipt.receiptNo, by: userId } });
    revalidatePath('/studio/receipts');
    return { ok: true, message: `영수증 ${receipt.receiptNo} 를 발급하고 후원자에게 안내 문자를 보냈습니다.` };
  });
}

export async function issueReceiptsBulkAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const year = parseYear(text(f, 'taxYear'));
    if (!year) return { ok: false, message: '귀속 연도를 확인해 주세요.' };
    const r = await issueReceiptsBulk(merchantId, year, userId);
    await writeAudit({ action: 'RECEIPT_ISSUE_BULK', targetType: 'MerchantProfile', targetId: merchantId, after: { taxYear: year, issued: r.issued, skipped: r.skipped, failed: r.failed, by: userId } });
    revalidatePath('/studio/receipts');
    return {
      ok: r.failed === 0,
      message: `발급 ${r.issued}건 · 정보 미등록으로 건너뜀 ${r.skipped}건 · 실패 ${r.failed}건${r.failed ? ` (${r.details.find((d) => d.status === 'FAILED')?.reason ?? ''})` : ''}`,
    };
  });
}

export async function voidReceiptAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'receiptId');
    const reason = text(f, 'reason');
    if (!id) return { ok: false, message: '영수증을 확인해 주세요.' };
    if (reason.length < 2) return { ok: false, message: '무효 사유를 입력해 주세요.' };
    const own = await prisma.donationReceipt.findFirst({ where: { id, merchantId }, select: { id: true } });
    if (!own) return { ok: false, message: '영수증을 찾을 수 없습니다.' };
    const r = await voidReceipt(id, reason, userId);
    await writeAudit({ action: 'RECEIPT_VOID', targetType: 'DonationReceipt', targetId: id, after: { receiptNo: r.receiptNo, reason, by: userId } });
    revalidatePath('/studio/receipts');
    return { ok: true, message: `영수증 ${r.receiptNo} 를 무효 처리했습니다. 포함됐던 후원 건은 다시 발급 대상이 됩니다.` };
  });
}

export async function reissueReceiptAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  return withMerchant(async (merchantId, userId) => {
    const id = text(f, 'receiptId');
    const own = await prisma.donationReceipt.findFirst({ where: { id, merchantId }, select: { id: true } });
    if (!own) return { ok: false, message: '영수증을 찾을 수 없습니다.' };
    const { receipt } = await reissueReceipt(id, userId);
    await writeAudit({ action: 'RECEIPT_REISSUE', targetType: 'DonationReceipt', targetId: receipt.id, after: { receiptNo: receipt.receiptNo, from: id, by: userId } });
    revalidatePath('/studio/receipts');
    return { ok: true, message: `영수증 ${receipt.receiptNo} 로 재발급했습니다.` };
  });
}
