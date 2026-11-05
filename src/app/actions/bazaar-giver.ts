'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { AdminActionState } from '@/components/admin/state';
import { createSession, hashPassword } from '@/server/auth';
import { consumeIpRateLimit } from '@/server/rate-limit';
import { requireGiver } from '@/server/bazaar-auth';
import { assertBazaarEnabled } from '@/server/services/bazaar-settings';
import * as svc from '@/server/services/bazaar';
import { prisma } from '@/server/db';

/**
 * 라이브 바자회 — 현물 기부 회원(기업/개인) 액션.
 */

export interface GiverSignupState {
  ok: boolean;
  message?: string;
  values?: Record<string, string>;
}

const signupSchema = z
  .object({
    donorType: z.enum(['CORPORATE', 'INDIVIDUAL'], { message: '기업 회원·개인 회원 중 하나를 골라 주세요.' }),
    email: z.string().trim().toLowerCase().email('이메일 형식이 올바르지 않습니다.'),
    password: z.string().min(8, '비밀번호는 8자 이상이어야 합니다.').max(72, '비밀번호는 72자 이내로 입력해 주세요.'),
    passwordConfirm: z.string(),
    displayName: z.string().trim().min(1, '이름(상호)을 입력해 주세요.').max(60),
    contactName: z.string().trim().max(30).optional(),
    phone: z.string().trim().min(9, '휴대폰 번호를 입력해 주세요.'),
    businessNo: z.string().trim().optional(),
    representativeName: z.string().trim().optional(),
    address: z.string().trim().max(200).optional(),
    agree: z.literal('on', { message: '이용약관·개인정보 수집에 동의해 주세요.' }),
  })
  .refine((v) => v.password === v.passwordConfirm, { message: '비밀번호가 서로 일치하지 않습니다.', path: ['passwordConfirm'] });

export async function signupGiverAction(_p: GiverSignupState, fd: FormData): Promise<GiverSignupState> {
  const raw = Object.fromEntries(['donorType', 'email', 'password', 'passwordConfirm', 'displayName', 'contactName', 'phone', 'businessNo', 'representativeName', 'address', 'agree'].map((k) => [k, String(fd.get(k) ?? '')]));
  const values = Object.fromEntries(Object.entries(raw).filter(([k]) => !k.startsWith('password') && k !== 'agree'));
  try {
    await assertBazaarEnabled();
  } catch {
    return { ok: false, message: '현재 가입을 받지 않습니다.', values };
  }
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? '입력값을 확인해 주세요.', values };
  const limited = await consumeIpRateLimit('signup', 5, 60);
  if (!limited.ok) return { ok: false, message: '가입 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', values };
  let userId: string;
  try {
    const r = await svc.registerGiver({
      donorType: parsed.data.donorType,
      email: parsed.data.email,
      password: parsed.data.password,
      passwordHash: await hashPassword(parsed.data.password),
      displayName: parsed.data.displayName,
      contactName: parsed.data.contactName || parsed.data.displayName,
      phone: parsed.data.phone,
      businessNo: parsed.data.businessNo,
      representativeName: parsed.data.representativeName,
      address: parsed.data.address,
    });
    userId = r.userId;
  } catch (e) {
    return { ok: false, message: e instanceof svc.BazaarError ? e.message : '가입 처리 중 오류가 발생했습니다.', values };
  }
  await createSession(userId);
  redirect('/giver');
}

async function runGiver(fn: (g: Awaited<ReturnType<typeof requireGiver>>) => Promise<string>): Promise<AdminActionState> {
  try {
    const g = await requireGiver();
    const message = await fn(g);
    revalidatePath('/giver', 'layout');
    revalidatePath('/studio/bazaar', 'layout');
    revalidatePath('/admin/bazaar', 'layout');
    return { ok: true, message };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : '처리 중 오류가 발생했습니다.' };
  }
}

const t = (fd: FormData, k: string) => String(fd.get(k) ?? '').trim();

function numberOf(v: string) {
  const s = v.replace(/[,\s원]/g, '');
  return /^\d+$/.test(s) ? Number(s) : NaN;
}

export async function createDonationAction(_p: AdminActionState, fd: FormData): Promise<AdminActionState> {
  let donationId: string | null = null;
  const res = await runGiver(async ({ user, donor }) => {
    const count = Math.min(Number(t(fd, 'itemCount')) || 0, 30);
    const items: svc.DonationItemInput[] = [];
    for (let i = 0; i < count; i++) {
      const name = t(fd, `item_name_${i}`);
      if (!name) continue;
      items.push({
        name,
        category: t(fd, `item_category_${i}`) || '기타',
        quantity: numberOf(t(fd, `item_qty_${i}`)),
        condition: t(fd, `item_condition_${i}`),
        expiryDate: t(fd, `item_expiry_${i}`) || null,
        declaredUnitValue: numberOf(t(fd, `item_value_${i}`)),
      });
    }
    const minSale = t(fd, 'minSalePrice');
    donationId = await svc.createDonation(donor.id, user.id, {
      title: t(fd, 'title') || null,
      items,
      matchMode: t(fd, 'matchMode'),
      preferredMerchantId: t(fd, 'preferredMerchantId') || null,
      brandPublic: fd.get('brandPublic') === 'on',
      minSalePrice: minSale ? numberOf(minSale) || null : null,
      unsoldAction: t(fd, 'unsoldAction'),
      deliveryMethod: t(fd, 'deliveryMethod'),
      donorMessage: t(fd, 'donorMessage') || null,
    });
    for (const f of fd.getAll('photos')) if (f instanceof File && f.size > 0) await svc.saveDonationFile(donationId, 'PHOTO', f, user.id);
    for (const f of fd.getAll('evidence')) if (f instanceof File && f.size > 0) await svc.saveDonationFile(donationId, 'EVIDENCE', f, user.id);
    return '기부를 접수했습니다.';
  });
  if (res.ok && donationId) redirect(`/giver/donations/${donationId}?created=1`);
  return res;
}

export async function donorValuationAction(_p: AdminActionState, fd: FormData) {
  return runGiver(async ({ user, donor }) => {
    const donationId = t(fd, 'donationId');
    if (t(fd, 'mode') === 'ACCEPT') {
      await svc.acceptValuation(donationId, { type: 'DONOR', userId: user.id, donorId: donor.id });
      return '기관 제안 가액을 수락했습니다. 이제 약정에 동의해 주세요.';
    }
    const values: Record<string, string> = {};
    for (const [k, v] of fd.entries()) if (k.startsWith('unit_')) values[k.slice(5)] = String(v);
    const total = await svc.proposeValuation(donationId, { type: 'DONOR', userId: user.id, donorId: donor.id }, values, t(fd, 'note') || null);
    return `합계 ${total.toLocaleString('ko-KR')}원으로 다시 제안했습니다. 기관이 확정하면 약정 단계로 넘어갑니다.`;
  });
}

export async function evidenceUploadAction(_p: AdminActionState, fd: FormData) {
  return runGiver(async ({ user, donor }) => {
    const donationId = t(fd, 'donationId');
    const d = await prisma.inKindDonation.findFirst({ where: { id: donationId, donorId: donor.id } });
    if (!d) throw new Error('기부 건을 찾을 수 없습니다.');
    let n = 0;
    for (const f of fd.getAll('evidence')) if (f instanceof File && f.size > 0 && (await svc.saveDonationFile(donationId, 'EVIDENCE', f, user.id))) n += 1;
    if (n === 0) throw new Error('올릴 파일을 골라 주세요.');
    return `근거 자료 ${n}개를 올렸습니다.`;
  });
}

export async function pledgeAction(_p: AdminActionState, fd: FormData) {
  return runGiver(async ({ user, donor }) => {
    await svc.pledgeDonation(donor.id, t(fd, 'donationId'), user.id, { name: t(fd, 'pledgeName'), agree: fd.get('agree') === 'on' });
    return '약정에 동의했습니다. 안내된 창고로 물품을 보내 주세요.';
  });
}

export async function shippingAction(_p: AdminActionState, fd: FormData) {
  return runGiver(async ({ donor }) => {
    await svc.updateShipping(donor.id, t(fd, 'donationId'), t(fd, 'carrier'), t(fd, 'trackingNo'));
    return '발송 정보를 저장했습니다.';
  });
}

export async function donorCancelAction(_p: AdminActionState, fd: FormData) {
  return runGiver(async ({ user, donor }) => {
    await svc.cancelDonationByDonor(donor.id, t(fd, 'donationId'), user.id, t(fd, 'reason'));
    return '기부를 취소했습니다.';
  });
}

export async function updateGiverProfileAction(_p: AdminActionState, fd: FormData) {
  return runGiver(async ({ donor }) => {
    await svc.updateDonorProfile(donor.id, {
      contactName: t(fd, 'contactName'),
      phone: t(fd, 'phone') || undefined,
      address: t(fd, 'address') || null,
      ...(donor.donorType === 'CORPORATE' ? { representativeName: t(fd, 'representativeName') || null } : {}),
    });
    return '회원 정보를 저장했습니다.';
  });
}

export async function updateGiverReceiptAction(_p: AdminActionState, fd: FormData) {
  return runGiver(async ({ donor }) => {
    await svc.updateDonorReceiptInfo(donor.id, { legalName: t(fd, 'legalName'), resident: t(fd, 'resident'), hometaxOptIn: fd.get('hometaxOptIn') === 'on' });
    return '영수증 정보를 저장했습니다. 주민등록번호는 암호화해 보관하며 화면에는 가린 값만 보입니다.';
  });
}
