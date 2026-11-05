import { createHash } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, phoneHash, maskPhone, normalizePhone, normalizeResident, isValidResident, maskResident } from '@/lib/crypto';
import { kstDateKey, kstMonthKey } from '@/lib/datetime';
import { logger } from '@/lib/logger';
import {
  ADMIN_CANCELABLE,
  CONSIGNMENT_TEXT,
  CONSIGNMENT_VERSION,
  DONATION_STATUS as S,
  DONOR_CANCELABLE,
  ITEM_CONDITIONS,
  UNSOLD_ACTIONS,
  DELIVERY_METHODS,
  MATCH_MODES,
  blockedKeyword,
  nextMonth,
  settleLine,
  settlementDueDate,
  trackingCode,
  type DonationStatus,
  type ParsedSaleRow,
  type BazaarConfig,
} from '@/lib/bazaar';
import { doneeVerified, issuerReadiness, residentHash } from './receipts';
import { getBazaarConfig } from './bazaar-settings';

/**
 * 라이브 바자회 도메인 서비스.
 *
 * 상태 전이는 모두 transition() 을 거친다: 조건부 갱신(현재 상태가 기대값일 때만) + 상태 이력(append-only).
 * 동시에 두 화면에서 같은 단계를 누르면 하나만 성공하고 나머지는 "이미 처리됨" 오류를 받는다.
 * 금액은 BigInt(원). 원장은 append-only 이고 멱등키로 같은 반영을 두 번 하지 않는다.
 */

export class BazaarError extends Error {}

type Tx = Prisma.TransactionClient;
type Actor = { type: 'DONOR' | 'MERCHANT' | 'ADMIN' | 'SYSTEM'; userId?: string | null };

async function transition(
  tx: Tx,
  donationId: string,
  from: DonationStatus | DonationStatus[],
  to: DonationStatus,
  actor: Actor,
  note?: string | null,
  data: Prisma.InKindDonationUncheckedUpdateManyInput = {},
) {
  const fromList = Array.isArray(from) ? from : [from];
  const current = await tx.inKindDonation.findUnique({ where: { id: donationId }, select: { status: true } });
  if (!current) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  const updated = await tx.inKindDonation.updateMany({
    where: { id: donationId, status: { in: fromList } },
    data: { ...data, status: to },
  });
  if (updated.count !== 1) throw new BazaarError('이미 다른 단계로 처리된 기부 건입니다. 화면을 새로 고쳐 주세요.');
  await tx.inKindStatusLog.create({
    data: {
      id: newId(),
      donationId,
      fromStatus: current.status,
      toStatus: to,
      actorType: actor.type,
      actorUserId: actor.userId ?? null,
      note: note ?? null,
    },
  });
}

// ===========================================================================
// 기부 회원
// ===========================================================================

export interface GiverSignupInput {
  donorType: 'CORPORATE' | 'INDIVIDUAL';
  email: string;
  password: string;
  passwordHash: string;
  displayName: string;
  contactName: string;
  phone: string;
  businessNo?: string | null;
  representativeName?: string | null;
  address?: string | null;
}

export function normalizeBusinessNo(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  return d.length === 10 ? d : null;
}

export async function registerGiver(input: GiverSignupInput) {
  const email = input.email.trim().toLowerCase();
  const phone = normalizePhone(input.phone);
  if (!/^01\d{8,9}$/.test(phone)) throw new BazaarError('휴대폰 번호를 확인해 주세요.');
  if (!input.displayName.trim()) throw new BazaarError(input.donorType === 'CORPORATE' ? '상호를 입력해 주세요.' : '이름을 입력해 주세요.');
  let businessNo: string | null = null;
  if (input.donorType === 'CORPORATE') {
    businessNo = normalizeBusinessNo(input.businessNo);
    if (!businessNo) throw new BazaarError('사업자등록번호 10자리를 입력해 주세요.');
    if (!input.representativeName?.trim()) throw new BazaarError('대표자 이름을 입력해 주세요.');
  }
  const exists = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (exists) throw new BazaarError('이미 가입된 이메일입니다. 로그인해 주세요.');

  const userId = newId();
  const donorId = newId();
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: userId,
        email,
        name: input.donorType === 'CORPORATE' ? input.displayName.trim() : input.contactName.trim() || input.displayName.trim(),
        role: 'GIVER',
        passwordHash: input.passwordHash,
      },
    });
    await tx.inKindDonor.create({
      data: {
        id: donorId,
        userId,
        donorType: input.donorType,
        displayName: input.displayName.trim().slice(0, 60),
        businessNo,
        representativeName: input.representativeName?.trim().slice(0, 30) || null,
        contactName: (input.contactName.trim() || input.displayName.trim()).slice(0, 30),
        phoneEnc: encrypt(phone),
        phoneHash: phoneHash(phone),
        phoneMasked: maskPhone(phone),
        address: input.address?.trim().slice(0, 200) || null,
        legalName: input.donorType === 'INDIVIDUAL' ? input.displayName.trim().slice(0, 30) : null,
      },
    });
  });
  return { userId, donorId };
}

export async function donorByUser(userId: string) {
  return prisma.inKindDonor.findUnique({ where: { userId } });
}

export async function updateDonorProfile(
  donorId: string,
  input: { contactName?: string; phone?: string; address?: string | null; representativeName?: string | null },
) {
  const data: Prisma.InKindDonorUpdateInput = {};
  if (input.contactName !== undefined) {
    if (!input.contactName.trim()) throw new BazaarError('담당자(연락받을 분) 이름을 입력해 주세요.');
    data.contactName = input.contactName.trim().slice(0, 30);
  }
  if (input.phone) {
    const phone = normalizePhone(input.phone);
    if (!/^01\d{8,9}$/.test(phone)) throw new BazaarError('휴대폰 번호를 확인해 주세요.');
    data.phoneEnc = encrypt(phone);
    data.phoneHash = phoneHash(phone);
    data.phoneMasked = maskPhone(phone);
  }
  if (input.address !== undefined) data.address = input.address?.trim().slice(0, 200) || null;
  if (input.representativeName !== undefined) data.representativeName = input.representativeName?.trim().slice(0, 30) || null;
  await prisma.inKindDonor.update({ where: { id: donorId }, data });
}

/** 개인 기부자 영수증 정보(성명·주민등록번호). 원문은 저장하지 않는다. */
export async function updateDonorReceiptInfo(donorId: string, input: { legalName: string; resident: string; hometaxOptIn: boolean }) {
  const donor = await prisma.inKindDonor.findUnique({ where: { id: donorId } });
  if (!donor) throw new BazaarError('기부 회원을 찾을 수 없습니다.');
  if (donor.donorType !== 'INDIVIDUAL') throw new BazaarError('기업 회원은 사업자등록번호로 영수증이 발급됩니다.');
  const name = input.legalName.trim();
  if (!name) throw new BazaarError('영수증에 적을 성명을 입력해 주세요.');
  const resident = normalizeResident(input.resident);
  if (!resident || !isValidResident(resident)) throw new BazaarError('주민등록번호를 확인해 주세요.');
  await prisma.inKindDonor.update({
    where: { id: donorId },
    data: {
      legalName: name.slice(0, 30),
      residentNoEnc: encrypt(resident),
      residentNoHash: residentHash(resident),
      residentNoMasked: maskResident(resident),
      hometaxOptIn: input.hometaxOptIn,
    },
  });
}

// ===========================================================================
// 기관 참여(위탁판매 동의)·매칭 자격
// ===========================================================================

export async function applyParticipation(
  merchantId: string,
  input: { consignmentName: string; agree: boolean; neededItems?: string | null; mailOrderRegNo?: string | null },
) {
  if (!input.agree) throw new BazaarError('위탁판매 동의에 체크해 주세요.');
  if (!input.consignmentName.trim()) throw new BazaarError('동의하는 담당자 이름을 입력해 주세요.');
  const existing = await prisma.merchantBazaar.findUnique({ where: { merchantId } });
  if (existing?.status === 'APPROVED') {
    await prisma.merchantBazaar.update({
      where: { merchantId },
      data: { neededItems: input.neededItems?.trim().slice(0, 1000) || null, mailOrderRegNo: input.mailOrderRegNo?.trim().slice(0, 40) || null },
    });
    return 'UPDATED';
  }
  if (existing?.status === 'SUSPENDED') throw new BazaarError('참여가 정지된 상태입니다. 고객센터로 문의해 주세요.');
  const data = {
    status: 'APPLIED',
    consignmentName: input.consignmentName.trim().slice(0, 30),
    consignmentAgreedAt: new Date(),
    consignmentVersion: CONSIGNMENT_VERSION,
    neededItems: input.neededItems?.trim().slice(0, 1000) || null,
    mailOrderRegNo: input.mailOrderRegNo?.trim().slice(0, 40) || null,
    appliedAt: new Date(),
    decidedAt: null,
    decidedBy: null,
  };
  await prisma.merchantBazaar.upsert({ where: { merchantId }, create: { merchantId, ...data }, update: data });
  return 'APPLIED';
}

export async function decideParticipation(merchantId: string, decision: 'APPROVED' | 'REJECTED' | 'SUSPENDED', adminUserId: string, note?: string | null) {
  const row = await prisma.merchantBazaar.findUnique({ where: { merchantId } });
  if (!row) throw new BazaarError('참여 신청이 없습니다.');
  await prisma.merchantBazaar.update({
    where: { merchantId },
    data: { status: decision, decidedAt: new Date(), decidedBy: adminUserId, note: note?.slice(0, 300) ?? row.note },
  });
}

/** 매칭 가능한 기관: 바자회 참여 승인 + 기관 승인 + 공익법인 지정 확인(영수증 발급 가능) */
export async function eligibleMerchants() {
  const rows = await prisma.merchantBazaar.findMany({
    where: { status: 'APPROVED', merchant: { status: 'APPROVED' } },
    include: { merchant: { select: { id: true, displayName: true, code: true, address: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true } } },
    orderBy: { appliedAt: 'asc' },
  });
  return rows.filter((r) => doneeVerified(r.merchant)).map((r) => ({ ...r.merchant, neededItems: r.neededItems }));
}

async function assertEligible(merchantId: string) {
  const list = await eligibleMerchants();
  const m = list.find((x) => x.id === merchantId);
  if (!m) throw new BazaarError('바자회 참여 승인과 공익법인 지정 확인이 끝난 기관에만 매칭할 수 있습니다.');
  return m;
}

// ===========================================================================
// 기부 접수
// ===========================================================================

export interface DonationItemInput {
  name: string;
  category: string;
  quantity: number;
  condition: string;
  expiryDate?: string | null;
  declaredUnitValue: number;
}

export interface DonationInput {
  title?: string | null;
  items: DonationItemInput[];
  matchMode: string;
  preferredMerchantId?: string | null;
  brandPublic: boolean;
  minSalePrice?: number | null;
  unsoldAction: string;
  deliveryMethod: string;
  donorMessage?: string | null;
}

function newDonationNo(now = new Date()) {
  const ymd = kstDateKey(now).replace(/-/g, '');
  const rand = Array.from({ length: 4 }, () => '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 32)]).join('');
  return `IKD-${ymd}-${rand}`;
}

export function validateDonationInput(input: DonationInput) {
  if (input.items.length === 0) throw new BazaarError('기부할 물품을 1개 이상 입력해 주세요.');
  if (input.items.length > 30) throw new BazaarError('한 번에 30개 품목까지 접수할 수 있습니다. 나누어 접수해 주세요.');
  input.items.forEach((it, i) => {
    const no = `${i + 1}번 품목`;
    if (!it.name.trim()) throw new BazaarError(`${no}: 품명을 입력해 주세요.`);
    const blocked = blockedKeyword(`${it.name} ${it.category}`);
    if (blocked) throw new BazaarError(`${no}: '${blocked}' 은(는) 바자회로 받을 수 없는 품목입니다.`);
    if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 100000) throw new BazaarError(`${no}: 수량을 확인해 주세요.`);
    if (!Number.isInteger(it.declaredUnitValue) || it.declaredUnitValue < 0 || it.declaredUnitValue > 100_000_000)
      throw new BazaarError(`${no}: 단가(원)를 확인해 주세요.`);
    if (!(ITEM_CONDITIONS as readonly string[]).includes(it.condition)) throw new BazaarError(`${no}: 상태를 선택해 주세요.`);
    if (it.expiryDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.expiryDate)) throw new BazaarError(`${no}: 유통기한 날짜 형식을 확인해 주세요.`);
      if (it.expiryDate < kstDateKey(new Date(Date.now() + 30 * 86_400_000)))
        throw new BazaarError(`${no}: 유통기한이 30일 이상 남은 물품만 받을 수 있습니다.`);
    }
  });
  if (!(MATCH_MODES as readonly string[]).includes(input.matchMode)) throw new BazaarError('기관 선택 방법을 골라 주세요.');
  if (input.matchMode === 'DESIGNATED' && !input.preferredMerchantId) throw new BazaarError('기부할 기관을 선택해 주세요.');
  if (!(UNSOLD_ACTIONS as readonly string[]).includes(input.unsoldAction)) throw new BazaarError('판매되지 않은 물품 처리 방법을 골라 주세요.');
  if (!(DELIVERY_METHODS as readonly string[]).includes(input.deliveryMethod)) throw new BazaarError('물품 전달 방법을 골라 주세요.');
}

export async function createDonation(donorId: string, userId: string, input: DonationInput) {
  validateDonationInput(input);
  const config = await getBazaarConfig();
  if (input.preferredMerchantId) await assertEligible(input.preferredMerchantId);
  const declaredTotal = input.items.reduce((s, it) => s + BigInt(it.declaredUnitValue) * BigInt(it.quantity), 0n);
  const id = newId();
  const title = (input.title?.trim() || `${input.items[0].name.trim()}${input.items.length > 1 ? ` 외 ${input.items.length - 1}건` : ''}`).slice(0, 80);
  const itemIds = input.items.map(() => newId());

  await prisma.$transaction(async (tx) => {
    await tx.inKindDonation.create({
      data: {
        id,
        donationNo: newDonationNo(),
        donorId,
        status: S.SUBMITTED,
        title,
        matchMode: input.matchMode,
        preferredMerchantId: input.matchMode === 'DESIGNATED' ? input.preferredMerchantId ?? null : null,
        brandPublic: input.brandPublic,
        minSalePrice: input.minSalePrice ? BigInt(input.minSalePrice) : null,
        unsoldAction: input.unsoldAction,
        deliveryMethod: input.deliveryMethod,
        donorMessage: input.donorMessage?.trim().slice(0, 500) || null,
        declaredTotal,
        items: {
          create: input.items.map((it, i) => ({
            id: itemIds[i],
            seq: i + 1,
            name: it.name.trim().slice(0, 80),
            category: it.category.slice(0, 30),
            quantity: it.quantity,
            condition: it.condition,
            expiryDate: it.expiryDate ? new Date(`${it.expiryDate}T00:00:00Z`) : null,
            declaredUnitValue: BigInt(it.declaredUnitValue),
          })),
        },
      },
    });
    await tx.inKindStatusLog.create({
      data: { id: newId(), donationId: id, fromStatus: null, toStatus: S.SUBMITTED, actorType: 'DONOR', actorUserId: userId, note: '기부 접수' },
    });
    await tx.inKindValuation.create({
      data: {
        id: newId(),
        donationId: id,
        actorType: 'DONOR',
        actorUserId: userId,
        kind: 'PROPOSE',
        total: declaredTotal,
        itemValues: Object.fromEntries(itemIds.map((iid, i) => [iid, String(input.items[i].declaredUnitValue)])),
        note: '접수 시 제시 가액',
      },
    });
    // 기관을 지정했으면 그 기관에 바로 매칭을 제안한다(운영자 단계를 줄인다).
    if (input.matchMode === 'DESIGNATED' && input.preferredMerchantId) {
      await tx.inKindMatch.create({
        data: {
          id: newId(),
          donationId: id,
          merchantId: input.preferredMerchantId,
          status: 'PROPOSED',
          proposedBy: 'SYSTEM',
          deadline: new Date(Date.now() + config.matchDeadlineDays * 86_400_000),
        },
      });
      await transition(tx, id, S.SUBMITTED, S.MATCH_PROPOSED, { type: 'SYSTEM' }, '기부자가 지정한 기관에 매칭 제안');
    }
  });
  return id;
}

export async function cancelDonationByDonor(donorId: string, donationId: string, userId: string, reason: string) {
  const d = await prisma.inKindDonation.findFirst({ where: { id: donationId, donorId } });
  if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  if (!DONOR_CANCELABLE.includes(d.status as DonationStatus)) throw new BazaarError('약정 이후에는 고객센터를 통해 취소할 수 있습니다.');
  await prisma.$transaction(async (tx) => {
    await tx.inKindMatch.updateMany({ where: { donationId, status: 'PROPOSED' }, data: { status: 'WITHDRAWN', decidedAt: new Date(), reason: '기부자 취소' } });
    await transition(tx, donationId, d.status as DonationStatus, S.CANCELED, { type: 'DONOR', userId }, reason.slice(0, 200) || '기부자 취소', {
      cancelReason: reason.slice(0, 200) || '기부자 취소',
    });
  });
}

export async function cancelDonationByAdmin(donationId: string, adminUserId: string, reason: string) {
  const d = await prisma.inKindDonation.findUnique({ where: { id: donationId } });
  if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  if (!ADMIN_CANCELABLE.includes(d.status as DonationStatus)) throw new BazaarError('영수증이 발급된 뒤에는 취소할 수 없습니다(영수증 무효 처리 후 진행).');
  if (!reason.trim()) throw new BazaarError('취소 사유를 입력해 주세요.');
  await prisma.$transaction(async (tx) => {
    await tx.inKindMatch.updateMany({ where: { donationId, status: 'PROPOSED' }, data: { status: 'WITHDRAWN', decidedAt: new Date(), reason: '관리자 취소' } });
    await transition(tx, donationId, d.status as DonationStatus, S.CANCELED, { type: 'ADMIN', userId: adminUserId }, reason.slice(0, 200), {
      cancelReason: reason.slice(0, 200),
    });
  });
}

// ===========================================================================
// 매칭
// ===========================================================================

export async function proposeMatch(donationId: string, merchantId: string, adminUserId: string) {
  await assertEligible(merchantId);
  const config = await getBazaarConfig();
  await prisma.$transaction(async (tx) => {
    const d = await tx.inKindDonation.findUnique({ where: { id: donationId } });
    if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
    if (d.status !== S.SUBMITTED) throw new BazaarError('접수 상태(매칭 전)인 기부 건만 매칭을 제안할 수 있습니다.');
    const rejectedBefore = await tx.inKindMatch.findFirst({ where: { donationId, merchantId, status: 'REJECTED' } });
    if (rejectedBefore) throw new BazaarError('이 기관은 이미 이 기부 건을 거절했습니다. 다른 기관을 선택해 주세요.');
    await tx.inKindMatch.create({
      data: {
        id: newId(),
        donationId,
        merchantId,
        status: 'PROPOSED',
        proposedBy: adminUserId,
        deadline: new Date(Date.now() + config.matchDeadlineDays * 86_400_000),
      },
    });
    await transition(tx, donationId, S.SUBMITTED, S.MATCH_PROPOSED, { type: 'ADMIN', userId: adminUserId }, '기관 매칭 제안');
  });
}

export async function withdrawMatch(donationId: string, adminUserId: string) {
  await prisma.$transaction(async (tx) => {
    const n = await tx.inKindMatch.updateMany({
      where: { donationId, status: 'PROPOSED' },
      data: { status: 'WITHDRAWN', decidedAt: new Date(), decidedBy: adminUserId, reason: '관리자 철회' },
    });
    if (n.count === 0) throw new BazaarError('진행 중인 매칭 제안이 없습니다.');
    await transition(tx, donationId, S.MATCH_PROPOSED, S.SUBMITTED, { type: 'ADMIN', userId: adminUserId }, '매칭 제안 철회');
  });
}

/** 기한이 지난 제안을 만료 처리하고 기부 건을 접수 상태로 되돌린다(화면 조회·배치 공용). */
export async function expireMatches(now = new Date()) {
  const expired = await prisma.inKindMatch.findMany({ where: { status: 'PROPOSED', deadline: { lt: now } }, select: { id: true, donationId: true } });
  let count = 0;
  for (const m of expired) {
    await prisma
      .$transaction(async (tx) => {
        const n = await tx.inKindMatch.updateMany({ where: { id: m.id, status: 'PROPOSED' }, data: { status: 'EXPIRED', decidedAt: now } });
        if (n.count !== 1) return;
        await transition(tx, m.donationId, S.MATCH_PROPOSED, S.SUBMITTED, { type: 'SYSTEM' }, '매칭 수락 기한 만료');
        count += 1;
      })
      .catch((e) => logger.warn('바자회 매칭 만료 처리 실패', { matchId: m.id, message: (e as Error).message }));
  }
  return count;
}

export async function respondMatch(merchantId: string, matchId: string, accept: boolean, userId: string, reason?: string | null) {
  await prisma.$transaction(async (tx) => {
    const m = await tx.inKindMatch.findFirst({ where: { id: matchId, merchantId } });
    if (!m) throw new BazaarError('매칭 제안을 찾을 수 없습니다.');
    if (m.status !== 'PROPOSED') throw new BazaarError('이미 처리된 제안입니다.');
    if (m.deadline < new Date()) throw new BazaarError('수락 기한이 지난 제안입니다. 운영자가 다시 제안하면 응답할 수 있습니다.');
    if (accept) {
      await tx.inKindMatch.update({ where: { id: m.id }, data: { status: 'ACCEPTED', decidedAt: new Date(), decidedBy: userId } });
      await transition(tx, m.donationId, S.MATCH_PROPOSED, S.VALUATING, { type: 'MERCHANT', userId }, '기관 수락', { merchantId });
    } else {
      if (!reason?.trim()) throw new BazaarError('거절 사유를 입력해 주세요.');
      await tx.inKindMatch.update({ where: { id: m.id }, data: { status: 'REJECTED', decidedAt: new Date(), decidedBy: userId, reason: reason.slice(0, 200) } });
      await transition(tx, m.donationId, S.MATCH_PROPOSED, S.SUBMITTED, { type: 'MERCHANT', userId }, `기관 거절: ${reason.slice(0, 200)}`);
    }
  });
}

// ===========================================================================
// 가액 협의
// ===========================================================================

function parseItemValues(itemIds: string[], values: Record<string, string>) {
  const out: Record<string, bigint> = {};
  for (const id of itemIds) {
    const raw = (values[id] ?? '').replace(/[,\s원]/g, '');
    if (!/^\d+$/.test(raw)) throw new BazaarError('품목별 단가를 숫자로 입력해 주세요.');
    const v = BigInt(raw);
    if (v > 100_000_000n) throw new BazaarError('단가가 너무 큽니다.');
    out[id] = v;
  }
  return out;
}

export async function latestValuation(donationId: string) {
  return prisma.inKindValuation.findFirst({ where: { donationId }, orderBy: { createdAt: 'desc' } });
}

/**
 * 가액 제안·역제안. 기부자(PROPOSE) 또는 기관(COUNTER).
 * 상대가 낸 마지막 제안을 그대로 받아들이려면 acceptValuation 을 쓴다.
 */
export async function proposeValuation(
  donationId: string,
  actor: { type: 'DONOR' | 'MERCHANT'; userId: string; donorId?: string; merchantId?: string },
  values: Record<string, string>,
  note?: string | null,
) {
  const d = await prisma.inKindDonation.findUnique({ where: { id: donationId }, include: { items: { orderBy: { seq: 'asc' } } } });
  if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  if (actor.type === 'DONOR' && d.donorId !== actor.donorId) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  if (actor.type === 'MERCHANT' && d.merchantId !== actor.merchantId) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  if (d.status !== S.VALUATING) throw new BazaarError('가액 협의 단계에서만 제안할 수 있습니다.');
  const parsed = parseItemValues(d.items.map((i) => i.id), values);
  const total = d.items.reduce((s, it) => s + parsed[it.id] * BigInt(it.quantity), 0n);
  await prisma.inKindValuation.create({
    data: {
      id: newId(),
      donationId,
      actorType: actor.type,
      actorUserId: actor.userId,
      kind: actor.type === 'DONOR' ? 'PROPOSE' : 'COUNTER',
      total,
      itemValues: Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.toString()])),
      note: note?.trim().slice(0, 500) || null,
    },
  });
  return total;
}

/** 상대의 마지막 제안을 받아들여 가액을 확정한다. 자기 제안은 스스로 확정할 수 없다. */
export async function acceptValuation(
  donationId: string,
  actor: { type: 'DONOR' | 'MERCHANT'; userId: string; donorId?: string; merchantId?: string },
) {
  await prisma.$transaction(async (tx) => {
    const d = await tx.inKindDonation.findUnique({ where: { id: donationId }, include: { items: true } });
    if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
    if (actor.type === 'DONOR' && d.donorId !== actor.donorId) throw new BazaarError('기부 건을 찾을 수 없습니다.');
    if (actor.type === 'MERCHANT' && d.merchantId !== actor.merchantId) throw new BazaarError('기부 건을 찾을 수 없습니다.');
    if (d.status !== S.VALUATING) throw new BazaarError('가액 협의 단계가 아닙니다.');
    const last = await tx.inKindValuation.findFirst({
      where: { donationId, kind: { in: ['PROPOSE', 'COUNTER'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!last) throw new BazaarError('확정할 가액 제안이 없습니다.');
    if (last.actorType === actor.type) throw new BazaarError('내가 낸 제안은 상대가 수락해야 확정됩니다.');
    const values = last.itemValues as Record<string, string>;
    for (const it of d.items) {
      const v = values[it.id];
      if (v === undefined) throw new BazaarError('제안에 빠진 품목이 있습니다. 다시 제안해 주세요.');
      await tx.inKindItem.update({ where: { id: it.id }, data: { unitValue: BigInt(v) } });
    }
    await tx.inKindValuation.create({
      data: {
        id: newId(),
        donationId,
        actorType: actor.type,
        actorUserId: actor.userId,
        kind: 'CONFIRM',
        total: last.total,
        itemValues: last.itemValues as Prisma.InputJsonValue,
        note: actor.type === 'MERCHANT' ? '기관이 기부자 제시 가액을 확정' : '기부자가 기관 제안 가액을 수락',
      },
    });
    await transition(tx, donationId, S.VALUATING, S.VALUE_CONFIRMED, { type: actor.type, userId: actor.userId }, `가액 확정 ${last.total.toString()}원`, {
      confirmedTotal: last.total,
      valuationConfirmedAt: new Date(),
    });
  });
}

// ===========================================================================
// 약정(전자 동의)
// ===========================================================================

export async function pledgeDonation(donorId: string, donationId: string, userId: string, input: { name: string; agree: boolean }) {
  if (!input.agree) throw new BazaarError('약정 내용에 동의해 주세요.');
  const d = await prisma.inKindDonation.findFirst({
    where: { id: donationId, donorId },
    include: { items: { orderBy: { seq: 'asc' } }, merchant: { select: { displayName: true, code: true } }, donor: true },
  });
  if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  if (d.status !== S.VALUE_CONFIRMED) throw new BazaarError('가액이 확정된 뒤에 약정할 수 있습니다.');
  const name = input.name.trim();
  if (!name) throw new BazaarError('약정자 이름을 입력해 주세요.');
  const snapshot = {
    version: CONSIGNMENT_VERSION,
    donationNo: d.donationNo,
    donor: { type: d.donor.donorType, displayName: d.donor.displayName, phoneMasked: d.donor.phoneMasked },
    merchant: { name: d.merchant?.displayName, code: d.merchant?.code },
    items: d.items.map((it) => ({ name: it.name, quantity: it.quantity, unitValue: (it.unitValue ?? 0n).toString() })),
    confirmedTotal: (d.confirmedTotal ?? 0n).toString(),
    conditions: {
      brandPublic: d.brandPublic,
      minSalePrice: d.minSalePrice?.toString() ?? null,
      unsoldAction: d.unsoldAction,
      deliveryMethod: d.deliveryMethod,
    },
    clauses: [
      '기부자는 위 물품을 기관에 무상으로 기부하며, 기관이 라이브 바자회로 판매(현금화)하는 데 동의합니다.',
      '판매 가격은 운영자가 정하며, 기부금영수증 가액보다 낮게 판매될 수 있습니다.',
      '기부금영수증은 입고·검수 후 기관이 검수를 확정한 수량과 위 단가로 발급됩니다.',
      '판매되지 않은 물품은 위에서 고른 방법으로 처리합니다.',
      ...CONSIGNMENT_TEXT.slice(1, 2),
    ],
    signedName: name.slice(0, 30),
    signedAt: new Date().toISOString(),
  };
  const hash = createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
  await prisma.$transaction(async (tx) => {
    await transition(tx, donationId, S.VALUE_CONFIRMED, S.PLEDGED, { type: 'DONOR', userId }, '기부 약정 동의', {
      pledgeName: name.slice(0, 30),
      pledgeSnapshot: snapshot as Prisma.InputJsonValue,
      pledgeHash: hash,
      pledgedAt: new Date(),
    });
  });
  return hash;
}

export async function updateShipping(donorId: string, donationId: string, carrier: string, trackingNo: string) {
  const d = await prisma.inKindDonation.findFirst({ where: { id: donationId, donorId } });
  if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  if (d.status !== S.PLEDGED) throw new BazaarError('약정 완료 후 입고 전까지만 발송 정보를 적을 수 있습니다.');
  if (!carrier.trim() || !trackingNo.trim()) throw new BazaarError('택배사와 송장번호를 입력해 주세요.');
  await prisma.inKindDonation.update({
    where: { id: donationId },
    data: { shippingCarrier: carrier.trim().slice(0, 30), shippingTrackingNo: trackingNo.trim().slice(0, 40), shippedAt: new Date() },
  });
}

// ===========================================================================
// 입고·검수 → 기관 검수 확정 → 현물 영수증 → 판매 상품 생성
// ===========================================================================

export interface InboundInput {
  warehouse: string;
  receivedAt: Date;
  result: 'PASS' | 'PARTIAL' | 'FAIL';
  items: Array<{ itemId: string; receivedQty: number; acceptedQty: number; note?: string | null }>;
  returnCost: bigint;
  returnCostBearer: 'NONE' | 'MERCHANT' | 'GIVESIGN';
  disposition?: 'RETURNED' | 'DISPOSED' | null;
  note?: string | null;
}

export async function registerInbound(donationId: string, adminUserId: string, input: InboundInput) {
  if (!input.warehouse.trim()) throw new BazaarError('입고 창고를 입력해 주세요.');
  if (input.returnCost < 0n) throw new BazaarError('반송비를 확인해 주세요.');
  if (input.returnCost > 0n && input.returnCostBearer === 'NONE') throw new BazaarError('반송비가 있으면 부담 주체(기관/기브싸인)를 골라 주세요.');
  await prisma.$transaction(async (tx) => {
    const d = await tx.inKindDonation.findUnique({ where: { id: donationId }, include: { items: true, inbound: true } });
    if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
    const reEdit = d.status === S.INSPECTED && !d.inbound?.merchantConfirmedAt;
    if (d.status !== S.PLEDGED && !reEdit) throw new BazaarError('약정 완료(입고 대기) 상태에서 입고를 등록할 수 있습니다.');
    let accepted = 0;
    for (const it of d.items) {
      const row = input.items.find((x) => x.itemId === it.id);
      if (!row) throw new BazaarError(`'${it.name}' 의 입고 수량을 입력해 주세요.`);
      if (row.receivedQty < 0 || row.acceptedQty < 0 || row.acceptedQty > row.receivedQty)
        throw new BazaarError(`'${it.name}': 합격 수량은 입고 수량을 넘을 수 없습니다.`);
      if (row.acceptedQty > it.quantity) throw new BazaarError(`'${it.name}': 합격 수량이 약정 수량(${it.quantity})보다 많습니다.`);
      accepted += row.acceptedQty;
      await tx.inKindItem.update({
        where: { id: it.id },
        data: { receivedQty: row.receivedQty, acceptedQty: input.result === 'FAIL' ? 0 : row.acceptedQty, inspectNote: row.note?.slice(0, 200) || null },
      });
    }
    if (input.result !== 'FAIL' && accepted === 0) throw new BazaarError('합격 수량이 없으면 결과를 불합격으로 등록해 주세요.');
    const data = {
      warehouse: input.warehouse.trim().slice(0, 100),
      receivedAt: input.receivedAt,
      inspectedBy: adminUserId,
      result: input.result,
      note: input.note?.trim().slice(0, 500) || null,
      returnCost: input.returnCost,
      returnCostBearer: input.returnCostBearer,
      disposition: input.result === 'FAIL' ? input.disposition ?? 'RETURNED' : null,
    };
    if (d.inbound) await tx.inKindInbound.update({ where: { donationId }, data });
    else await tx.inKindInbound.create({ data: { id: newId(), donationId, ...data } });

    if (input.result === 'FAIL') {
      await transition(tx, donationId, [S.PLEDGED, S.INSPECTED], S.RETURNED, { type: 'ADMIN', userId: adminUserId }, `검수 불합격(${data.disposition === 'DISPOSED' ? '폐기' : '반송'})`, {
        closedAt: new Date(),
      });
      // 불합격은 여기서 끝나므로 기관 부담 반송비를 바로 원장에 남긴다.
      if (input.returnCostBearer === 'MERCHANT' && input.returnCost > 0n && d.merchantId) {
        await appendLedger(tx, {
          merchantId: d.merchantId,
          entryType: 'RETURN_COST',
          amount: -input.returnCost,
          idempotencyKey: `inbound-return:${donationId}`,
          memo: `${d.donationNo} 검수 불합격 반송비`,
        });
      }
    } else if (d.status === S.PLEDGED) {
      await transition(tx, donationId, S.PLEDGED, S.INSPECTED, { type: 'ADMIN', userId: adminUserId }, `입고·검수 등록(${input.result === 'PASS' ? '합격' : '일부 합격'})`);
    }
  });
}

/** 검수 확정 시 영수증 금액 = Σ 확정 단가 × 합격 수량 */
export function receiptAmountOf(items: Array<{ unitValue: bigint | null; acceptedQty: number | null }>) {
  return items.reduce((s, it) => s + (it.unitValue ?? 0n) * BigInt(it.acceptedQty ?? 0), 0n);
}

async function nextReceiptSeq(tx: Tx, merchantId: string, taxYear: number) {
  await tx.$queryRaw`SELECT id FROM merchant_profile WHERE id = ${merchantId} FOR UPDATE`;
  const last = await tx.inKindReceipt.findFirst({ where: { merchantId, taxYear }, orderBy: { seq: 'desc' }, select: { seq: true } });
  return (last?.seq ?? 0) + 1;
}

async function issueInKindReceiptTx(tx: Tx, donationId: string, issuedBy: string) {
  const d = await tx.inKindDonation.findUnique({
    where: { id: donationId },
    include: { items: { orderBy: { seq: 'asc' } }, donor: true, merchant: true, inbound: true },
  });
  if (!d || !d.merchant) throw new BazaarError('기부 건을 찾을 수 없습니다.');
  const readiness = issuerReadiness(d.merchant);
  if (!readiness.ok) throw new BazaarError(`기관 정보가 부족해 영수증을 발급할 수 없습니다: ${readiness.missing.join(', ')}`);
  const donor = d.donor;
  if (donor.donorType === 'INDIVIDUAL' && (!donor.legalName || !donor.residentNoEnc))
    throw new BazaarError('개인 기부자가 영수증 정보(성명·주민등록번호)를 아직 등록하지 않았습니다. 기부자 콘솔에서 등록하면 발급할 수 있습니다.');
  if (donor.donorType === 'CORPORATE' && !donor.businessNo) throw new BazaarError('기업 기부자의 사업자등록번호가 없습니다.');
  const items = d.items.filter((it) => (it.acceptedQty ?? 0) > 0);
  const total = receiptAmountOf(items);
  if (total <= 0n) throw new BazaarError('영수증 금액이 0원입니다. 합격 수량과 확정 단가를 확인해 주세요.');
  const donatedAt = d.inbound?.receivedAt ?? new Date();
  const taxYear = Number(kstDateKey(donatedAt).slice(0, 4));
  const seq = await nextReceiptSeq(tx, d.merchant.id, taxYear);
  const receiptNo = `${d.merchant.code}-${taxYear}-H${String(seq).padStart(6, '0')}`;
  return tx.inKindReceipt.create({
    data: {
      id: newId(),
      merchantId: d.merchant.id,
      donationId: d.id,
      donorId: donor.id,
      taxYear,
      seq,
      receiptNo,
      totalAmount: total,
      donationCode: d.merchant.donationCode,
      donorType: donor.donorType,
      donorSnapshot: {
        type: donor.donorType,
        name: donor.donorType === 'CORPORATE' ? donor.displayName : donor.legalName,
        businessNo: donor.businessNo,
        representativeName: donor.representativeName,
        residentNoMasked: donor.residentNoMasked,
        address: donor.address,
        hometaxOptIn: donor.donorType === 'CORPORATE' ? true : donor.hometaxOptIn,
      } as Prisma.InputJsonValue,
      issuerSnapshot: {
        name: d.merchant.displayName,
        businessNo: d.merchant.businessNo,
        representativeName: d.merchant.representativeName,
        address: d.merchant.address,
        orgType: d.merchant.orgType,
        code: d.merchant.code,
      } as Prisma.InputJsonValue,
      items: items.map((it) => ({
        name: it.name,
        quantity: it.acceptedQty,
        unitValue: (it.unitValue ?? 0n).toString(),
        amount: ((it.unitValue ?? 0n) * BigInt(it.acceptedQty ?? 0)).toString(),
      })) as Prisma.InputJsonValue,
      residentNoEnc: donor.donorType === 'INDIVIDUAL' ? donor.residentNoEnc : null,
      donatedAt,
      issuedBy,
    },
  });
}

async function nextTrackingNumber(tx: Tx) {
  // 표 전체 잠금 대신 advisory lock 으로 번호 발급만 직렬화한다.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(778201)`;
  const last = await tx.bazaarProduct.findFirst({ orderBy: { trackingCode: 'desc' }, select: { trackingCode: true } });
  return (last ? Number(last.trackingCode.slice(4)) : 0) + 1;
}

/**
 * 기관 검수 확정: 영수증 발급 + 판매 상품(등록 대기) 생성을 한 트랜잭션으로 처리한다.
 * 영수증 발급 조건이 안 맞으면 전체를 되돌리고 이유를 알린다.
 */
export async function confirmInspection(merchantId: string, donationId: string, userId: string) {
  const config = await getBazaarConfig();
  return prisma.$transaction(async (tx) => {
    const d = await tx.inKindDonation.findFirst({ where: { id: donationId, merchantId }, include: { items: { orderBy: { seq: 'asc' } }, inbound: true } });
    if (!d) throw new BazaarError('기부 건을 찾을 수 없습니다.');
    if (d.status !== S.INSPECTED || !d.inbound) throw new BazaarError('입고·검수가 등록된 기부 건만 확정할 수 있습니다.');
    const n = await tx.inKindInbound.updateMany({ where: { donationId, merchantConfirmedAt: null }, data: { merchantConfirmedAt: new Date(), merchantConfirmedBy: userId } });
    if (n.count !== 1) throw new BazaarError('이미 확정된 검수입니다.');
    const receipt = await issueInKindReceiptTx(tx, donationId, userId);
    // 일부 합격·기관 부담 반송비
    if (d.inbound.returnCostBearer === 'MERCHANT' && d.inbound.returnCost > 0n) {
      await appendLedger(tx, {
        merchantId,
        entryType: 'RETURN_COST',
        amount: -d.inbound.returnCost,
        idempotencyKey: `inbound-return:${donationId}`,
        memo: `${d.donationNo} 일부 불합격 반송비`,
      });
    }
    const floor = BigInt(config.minSalePrice);
    for (const it of d.items) {
      if ((it.acceptedQty ?? 0) <= 0) continue;
      const num = await nextTrackingNumber(tx);
      const minByDonor = d.minSalePrice ?? 0n;
      const base = minByDonor > floor ? minByDonor : floor;
      await tx.bazaarProduct.create({
        data: {
          id: newId(),
          trackingCode: trackingCode(num),
          merchantId,
          donationId,
          itemId: it.id,
          name: it.name,
          salePrice: base,
          quantity: it.acceptedQty ?? 0,
          perPersonLimit: config.defaultPerPersonLimit,
        },
      });
    }
    await transition(tx, donationId, S.INSPECTED, S.RECEIPTED, { type: 'MERCHANT', userId }, `검수 확정·현물 영수증 ${receipt.receiptNo} 발급`);
    return receipt;
  });
}

/** 영수증 무효(정정). 무효 뒤 재발급은 reissueInKindReceipt. 번호는 재사용하지 않는다. */
export async function voidInKindReceipt(receiptId: string, adminUserId: string, reason: string) {
  if (!reason.trim()) throw new BazaarError('무효 사유를 입력해 주세요.');
  const n = await prisma.inKindReceipt.updateMany({
    where: { id: receiptId, status: 'ISSUED' },
    data: { status: 'VOID', voidedAt: new Date(), voidedBy: adminUserId, voidReason: reason.slice(0, 200) },
  });
  if (n.count !== 1) throw new BazaarError('발급 상태인 영수증만 무효 처리할 수 있습니다.');
}

export async function reissueInKindReceipt(donationId: string, adminUserId: string) {
  return prisma.$transaction(async (tx) => {
    const active = await tx.inKindReceipt.findFirst({ where: { donationId, status: 'ISSUED' } });
    if (active) throw new BazaarError('발급 상태인 영수증이 있습니다. 먼저 무효 처리해 주세요.');
    const d = await tx.inKindDonation.findUnique({ where: { id: donationId }, select: { status: true } });
    if (!d || !([S.RECEIPTED, S.ON_SALE, S.SALE_ENDED, S.CLOSED] as DonationStatus[]).includes(d.status as DonationStatus))
      throw new BazaarError('검수 확정이 끝난 기부 건만 재발급할 수 있습니다.');
    return issueInKindReceiptTx(tx, donationId, adminUserId);
  });
}

// ===========================================================================
// 판매 상품
// ===========================================================================

export async function updateProduct(
  productId: string,
  input: { name: string; salePrice: number; shippingFee: number; quantity: number; perPersonLimit: number },
  config?: BazaarConfig,
) {
  const cfg = config ?? (await getBazaarConfig());
  const p = await prisma.bazaarProduct.findUnique({ where: { id: productId }, include: { item: true, donation: true } });
  if (!p) throw new BazaarError('상품을 찾을 수 없습니다.');
  if (p.status === 'ENDED') throw new BazaarError('판매가 끝난 상품은 바꿀 수 없습니다.');
  if (!input.name.trim()) throw new BazaarError('상품명을 입력해 주세요.');
  if (!Number.isInteger(input.salePrice) || input.salePrice < cfg.minSalePrice)
    throw new BazaarError(`판매가는 최소 판매가 ${cfg.minSalePrice.toLocaleString('ko-KR')}원 이상이어야 합니다.`);
  if (p.donation.minSalePrice && BigInt(input.salePrice) < p.donation.minSalePrice)
    throw new BazaarError(`기부자가 정한 최저가 ${Number(p.donation.minSalePrice).toLocaleString('ko-KR')}원보다 낮게 팔 수 없습니다.`);
  if (!Number.isInteger(input.shippingFee) || input.shippingFee < 0) throw new BazaarError('배송비를 확인해 주세요.');
  if (!Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > (p.item.acceptedQty ?? 0))
    throw new BazaarError(`판매 수량은 합격 수량(${p.item.acceptedQty ?? 0}) 이하여야 합니다.`);
  if (!Number.isInteger(input.perPersonLimit) || input.perPersonLimit < 1) throw new BazaarError('1인 구매 제한을 확인해 주세요.');
  await prisma.bazaarProduct.update({
    where: { id: productId },
    data: {
      name: input.name.trim().slice(0, 80),
      salePrice: BigInt(input.salePrice),
      shippingFee: BigInt(input.shippingFee),
      quantity: input.quantity,
      perPersonLimit: input.perPersonLimit,
    },
  });
}

export async function markProductListed(productId: string, adminUserId: string, externalRef?: string | null) {
  await prisma.$transaction(async (tx) => {
    const n = await tx.bazaarProduct.updateMany({
      where: { id: productId, status: 'DRAFT' },
      data: { status: 'LISTED', listedAt: new Date(), externalRef: externalRef?.trim().slice(0, 80) || null },
    });
    if (n.count !== 1) throw new BazaarError('등록 대기 상태의 상품만 판매 중으로 바꿀 수 있습니다.');
    const p = await tx.bazaarProduct.findUniqueOrThrow({ where: { id: productId } });
    const d = await tx.inKindDonation.findUniqueOrThrow({ where: { id: p.donationId }, select: { status: true } });
    if (d.status === S.RECEIPTED) {
      await transition(tx, p.donationId, S.RECEIPTED, S.ON_SALE, { type: 'ADMIN', userId: adminUserId }, `${p.trackingCode} 셀러브릭스 등록`);
    }
  });
}

export async function endProduct(productId: string, adminUserId: string, remainingAction: string) {
  if (!['MERCHANT_USE', 'TRANSFER', 'RETURN', 'DISPOSE'].includes(remainingAction)) throw new BazaarError('남은 수량 처리 방법을 골라 주세요.');
  await prisma.$transaction(async (tx) => {
    const n = await tx.bazaarProduct.updateMany({
      where: { id: productId, status: { in: ['DRAFT', 'LISTED'] } },
      data: { status: 'ENDED', endedAt: new Date(), remainingAction },
    });
    if (n.count !== 1) throw new BazaarError('이미 판매가 끝난 상품입니다.');
    const p = await tx.bazaarProduct.findUniqueOrThrow({ where: { id: productId } });
    const open = await tx.bazaarProduct.count({ where: { donationId: p.donationId, status: { in: ['DRAFT', 'LISTED'] } } });
    if (open === 0) {
      const d = await tx.inKindDonation.findUniqueOrThrow({ where: { id: p.donationId }, select: { status: true } });
      if (d.status === S.ON_SALE || d.status === S.RECEIPTED) {
        await transition(tx, p.donationId, [S.ON_SALE, S.RECEIPTED], S.SALE_ENDED, { type: 'ADMIN', userId: adminUserId }, '모든 상품 판매 종료');
      }
    }
  });
}

export async function closeDonation(donationId: string, adminUserId: string) {
  await prisma.$transaction(async (tx) => {
    await transition(tx, donationId, S.SALE_ENDED, S.CLOSED, { type: 'ADMIN', userId: adminUserId }, '종결', { closedAt: new Date() });
  });
}

/** 상품별 누적 판매(승인된 판매 결과 기준) */
export async function productSalesSummary(productIds: string[]) {
  if (productIds.length === 0) return new Map<string, { soldQty: number; gross: bigint; refundQty: number; refund: bigint }>();
  const rows = await prisma.bazaarSaleLine.groupBy({
    by: ['productId'],
    where: { productId: { in: productIds }, batch: { status: 'APPROVED' } },
    _sum: { soldQty: true, grossAmount: true, refundQty: true, refundAmount: true },
  });
  return new Map(
    rows.map((r) => [
      r.productId,
      { soldQty: r._sum.soldQty ?? 0, gross: r._sum.grossAmount ?? 0n, refundQty: r._sum.refundQty ?? 0, refund: r._sum.refundAmount ?? 0n },
    ]),
  );
}

// ===========================================================================
// 셀러·편성
// ===========================================================================

export async function saveSeller(input: { id?: string; name: string; sellerbricksId: string; phone?: string | null; memo?: string | null; active?: boolean }) {
  if (!input.name.trim()) throw new BazaarError('셀러 이름을 입력해 주세요.');
  if (!input.sellerbricksId.trim()) throw new BazaarError('셀러브릭스 계정(아이디·이메일)을 입력해 주세요.');
  const phone = input.phone ? normalizePhone(input.phone) : '';
  if (phone && !/^0\d{8,10}$/.test(phone)) throw new BazaarError('연락처를 확인해 주세요.');
  const data = {
    name: input.name.trim().slice(0, 30),
    sellerbricksId: input.sellerbricksId.trim().slice(0, 80),
    memo: input.memo?.trim().slice(0, 200) || null,
    active: input.active ?? true,
    ...(phone ? { phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone) } : {}),
  };
  if (input.id) await prisma.bazaarSeller.update({ where: { id: input.id }, data });
  else await prisma.bazaarSeller.create({ data: { id: newId(), ...data } });
}

export async function createLive(
  adminUserId: string,
  input: { merchantId: string; sellerId: string; title: string; scheduledAt: Date; broadcastUrl?: string | null; productIds: string[]; note?: string | null },
) {
  if (!input.title.trim()) throw new BazaarError('방송 제목을 입력해 주세요.');
  if (Number.isNaN(input.scheduledAt.getTime())) throw new BazaarError('방송 일시를 확인해 주세요.');
  const seller = await prisma.bazaarSeller.findUnique({ where: { id: input.sellerId } });
  if (!seller?.active) throw new BazaarError('활동 중인 셀러를 골라 주세요.');
  if (input.broadcastUrl && !/^https:\/\//.test(input.broadcastUrl)) throw new BazaarError('방송 주소는 https:// 로 시작해야 합니다.');
  if (input.productIds.length) {
    const ok = await prisma.bazaarProduct.count({ where: { id: { in: input.productIds }, merchantId: input.merchantId, status: { in: ['DRAFT', 'LISTED'] } } });
    if (ok !== input.productIds.length) throw new BazaarError('같은 기관의 판매 중·등록 대기 상품만 편성할 수 있습니다.');
  }
  const id = newId();
  await prisma.bazaarLive.create({
    data: {
      id,
      merchantId: input.merchantId,
      sellerId: input.sellerId,
      title: input.title.trim().slice(0, 80),
      scheduledAt: input.scheduledAt,
      broadcastUrl: input.broadcastUrl?.trim() || null,
      productIds: input.productIds as unknown as Prisma.InputJsonValue,
      note: input.note?.trim().slice(0, 300) || null,
      createdBy: adminUserId,
    },
  });
  return id;
}

export async function decideLive(merchantId: string, liveId: string, approve: boolean, userId: string, note?: string | null) {
  const n = await prisma.bazaarLive.updateMany({
    where: { id: liveId, merchantId, status: 'PROPOSED' },
    data: { status: approve ? 'APPROVED' : 'REJECTED', decidedAt: new Date(), decidedBy: userId, ...(note ? { note: note.slice(0, 300) } : {}) },
  });
  if (n.count !== 1) throw new BazaarError('승인 대기 중인 편성만 처리할 수 있습니다.');
}

export async function updateLiveStatus(liveId: string, status: 'DONE' | 'CANCELED', broadcastUrl?: string | null) {
  if (broadcastUrl && !/^https:\/\//.test(broadcastUrl)) throw new BazaarError('방송 주소는 https:// 로 시작해야 합니다.');
  const n = await prisma.bazaarLive.updateMany({
    where: { id: liveId, status: { in: ['PROPOSED', 'APPROVED'] } },
    data: { status, ...(broadcastUrl ? { broadcastUrl } : {}) },
  });
  if (n.count !== 1) throw new BazaarError('이미 끝났거나 취소된 편성입니다.');
}

export async function updateLiveUrl(liveId: string, broadcastUrl: string) {
  if (!/^https:\/\//.test(broadcastUrl)) throw new BazaarError('방송 주소는 https:// 로 시작해야 합니다.');
  await prisma.bazaarLive.update({ where: { id: liveId }, data: { broadcastUrl } });
}

// ===========================================================================
// 판매 결과(수기·파일) → 승인 → 원장
// ===========================================================================

async function appendLedger(
  tx: Tx,
  e: {
    merchantId: string;
    entryType: 'SALE' | 'REFUND' | 'FEE' | 'RETURN_COST' | 'PAYOUT';
    amount: bigint;
    idempotencyKey: string;
    month?: string;
    supplyAmount?: bigint | null;
    vatAmount?: bigint | null;
    productId?: string | null;
    batchId?: string | null;
    settlementId?: string | null;
    memo?: string | null;
  },
) {
  const exists = await tx.bazaarLedger.findUnique({ where: { idempotencyKey: e.idempotencyKey }, select: { id: true } });
  if (exists) return false;
  const month = e.month ?? (await openMonthFor(tx, e.merchantId));
  await tx.bazaarLedger.create({
    data: {
      id: newId(),
      merchantId: e.merchantId,
      month,
      entryType: e.entryType,
      amount: e.amount,
      supplyAmount: e.supplyAmount ?? null,
      vatAmount: e.vatAmount ?? null,
      productId: e.productId ?? null,
      batchId: e.batchId ?? null,
      settlementId: e.settlementId ?? null,
      idempotencyKey: e.idempotencyKey,
      memo: e.memo?.slice(0, 200) ?? null,
    },
  });
  return true;
}

/** 이번 달 정산이 이미 확정·지급됐으면 다음 달로 넘긴다(확정된 정산 금액이 바뀌지 않게). */
async function openMonthFor(tx: Tx, merchantId: string, now = new Date()) {
  let month = kstMonthKey(now);
  for (let i = 0; i < 24; i++) {
    const s = await tx.bazaarSettlement.findUnique({ where: { merchantId_month: { merchantId, month } }, select: { status: true } });
    if (!s || s.status === 'DRAFT') return month;
    month = nextMonth(month);
  }
  return month;
}

export interface SaleRowInput {
  trackingCode: string;
  soldQty: number;
  grossAmount: bigint;
  refundQty: number;
  refundAmount: bigint;
  returnCost: bigint;
  returnBearer: 'NONE' | 'MERCHANT' | 'GIVESIGN';
  note?: string | null;
}

/** 판매 결과 검증: 추적 코드 존재·판매 가능 상태·누적 수량/금액 범위 */
export async function validateSaleRows(rows: SaleRowInput[], excludeBatchId?: string) {
  const errors: string[] = [];
  const codes = [...new Set(rows.map((r) => r.trackingCode))];
  const products = await prisma.bazaarProduct.findMany({ where: { trackingCode: { in: codes } } });
  const byCode = new Map(products.map((p) => [p.trackingCode, p]));
  // 승인된 것 + 다른 대기 묶음까지 합쳐 초과 판매를 막는다.
  const prior = await prisma.bazaarSaleLine.groupBy({
    by: ['productId'],
    where: { productId: { in: products.map((p) => p.id) }, batch: { status: { in: ['APPROVED', 'DRAFT'] }, ...(excludeBatchId ? { id: { not: excludeBatchId } } : {}) } },
    _sum: { soldQty: true, grossAmount: true, refundQty: true, refundAmount: true },
  });
  const acc = new Map(prior.map((r) => [r.productId, { sold: r._sum.soldQty ?? 0, gross: r._sum.grossAmount ?? 0n, rq: r._sum.refundQty ?? 0, refund: r._sum.refundAmount ?? 0n }]));
  rows.forEach((r, i) => {
    const p = byCode.get(r.trackingCode);
    const at = `${i + 1}번째 줄(${r.trackingCode})`;
    if (!p) {
      errors.push(`${at}: 등록된 바자회 상품이 아닙니다.`);
      return;
    }
    if (p.status === 'DRAFT') errors.push(`${at}: 아직 셀러브릭스 등록 완료로 표시되지 않은 상품입니다.`);
    const a = acc.get(p.id) ?? { sold: 0, gross: 0n, rq: 0, refund: 0n };
    a.sold += r.soldQty;
    a.gross += r.grossAmount;
    a.rq += r.refundQty;
    a.refund += r.refundAmount;
    acc.set(p.id, a);
    if (a.sold > p.quantity) errors.push(`${at}: 누적 판매 수량(${a.sold})이 판매 수량(${p.quantity})을 넘습니다.`);
    if (a.refund > a.gross) errors.push(`${at}: 누적 환불 금액이 누적 판매 금액을 넘습니다.`);
    if (a.rq > a.sold) errors.push(`${at}: 누적 환불 수량이 누적 판매 수량을 넘습니다.`);
  });
  return { errors, byCode };
}

export async function createSaleBatch(
  adminUserId: string,
  input: { title: string; liveId?: string | null; source: 'MANUAL' | 'CSV'; rows: SaleRowInput[]; note?: string | null },
) {
  if (!input.title.trim()) throw new BazaarError('판매 결과 제목을 입력해 주세요(예: 11월 2주차 방송).');
  if (input.rows.length === 0) throw new BazaarError('판매 결과가 비어 있습니다.');
  if (input.rows.length > 2000) throw new BazaarError('한 번에 2,000줄까지 올릴 수 있습니다.');
  const { errors, byCode } = await validateSaleRows(input.rows);
  if (errors.length) throw new BazaarError(errors.slice(0, 8).join('\n') + (errors.length > 8 ? `\n외 ${errors.length - 8}건` : ''));
  const id = newId();
  await prisma.bazaarSaleBatch.create({
    data: {
      id,
      liveId: input.liveId || null,
      title: input.title.trim().slice(0, 80),
      source: input.source,
      createdBy: adminUserId,
      note: input.note?.trim().slice(0, 300) || null,
      lines: {
        create: input.rows.map((r) => {
          const p = byCode.get(r.trackingCode)!;
          return {
            id: newId(),
            productId: p.id,
            merchantId: p.merchantId,
            soldQty: r.soldQty,
            grossAmount: r.grossAmount,
            refundQty: r.refundQty,
            refundAmount: r.refundAmount,
            returnCost: r.returnCost,
            returnBearer: r.returnBearer,
            note: r.note?.slice(0, 200) || null,
          };
        }),
      },
    },
  });
  return id;
}

export function saleRowsFromParsed(rows: ParsedSaleRow[]): { rows: SaleRowInput[]; errors: string[] } {
  const errors = rows.filter((r) => r.error).map((r) => `${r.line}번째 줄: ${r.error}`);
  return {
    errors,
    rows: rows
      .filter((r) => !r.error && r.trackingCode)
      .map((r) => ({
        trackingCode: r.trackingCode!,
        soldQty: r.soldQty,
        grossAmount: r.grossAmount,
        refundQty: r.refundQty,
        refundAmount: r.refundAmount,
        returnCost: r.returnCost,
        returnBearer: r.returnBearer,
        note: r.note,
      })),
  };
}

/**
 * 판매 결과 승인 → 원장 반영.
 * 입력자와 승인자가 달라야 한다. 최고관리자는 사유를 적으면 단독 승인할 수 있다(소규모 운영 대비, 감사로그).
 */
export async function approveSaleBatch(batchId: string, approver: { userId: string; superAdmin: boolean }, soloReason?: string | null) {
  const config = await getBazaarConfig();
  return prisma.$transaction(async (tx) => {
    const b = await tx.bazaarSaleBatch.findUnique({ where: { id: batchId }, include: { lines: { include: { product: true } } } });
    if (!b) throw new BazaarError('판매 결과를 찾을 수 없습니다.');
    if (b.status !== 'DRAFT') throw new BazaarError('이미 처리된 판매 결과입니다.');
    if (b.createdBy === approver.userId) {
      if (!approver.superAdmin) throw new BazaarError('입력한 사람과 다른 관리자가 승인해야 합니다.');
      if (!soloReason?.trim()) throw new BazaarError('단독 승인 사유를 입력해 주세요(최고관리자만 가능).');
    }
    const n = await tx.bazaarSaleBatch.updateMany({
      where: { id: batchId, status: 'DRAFT' },
      data: {
        status: 'APPROVED',
        approvedBy: approver.userId,
        approvedAt: new Date(),
        month: kstMonthKey(),
        note: soloReason?.trim() ? `${b.note ? `${b.note} / ` : ''}단독 승인: ${soloReason.trim().slice(0, 200)}` : b.note,
      },
    });
    if (n.count !== 1) throw new BazaarError('이미 처리된 판매 결과입니다.');
    let payout = 0n;
    for (const l of b.lines) {
      const r = settleLine(l, config);
      const month = await openMonthFor(tx, l.merchantId);
      const base = { merchantId: l.merchantId, month, productId: l.productId, batchId: b.id };
      if (l.grossAmount > 0n)
        await appendLedger(tx, { ...base, entryType: 'SALE', amount: l.grossAmount, idempotencyKey: `sale:${l.id}`, memo: `${l.product.trackingCode} 판매 ${l.soldQty}개` });
      if (l.refundAmount > 0n)
        await appendLedger(tx, { ...base, entryType: 'REFUND', amount: -l.refundAmount, idempotencyKey: `refund:${l.id}`, memo: `${l.product.trackingCode} 환불 ${l.refundQty}개` });
      if (r.fee !== 0n)
        await appendLedger(tx, {
          ...base,
          entryType: 'FEE',
          amount: -r.fee,
          supplyAmount: -r.supply,
          vatAmount: -r.vat,
          idempotencyKey: `fee:${l.id}`,
          memo: `수수료 ${config.feeRatePercent}% (부가세 ${config.feeVatMode === 'INCLUDED' ? '포함' : '별도'})`,
        });
      if (r.returnCost > 0n)
        await appendLedger(tx, { ...base, entryType: 'RETURN_COST', amount: -r.returnCost, idempotencyKey: `return:${l.id}`, memo: `${l.product.trackingCode} 반송비(기관 부담)` });
      payout += r.payout;
    }
    return payout;
  });
}

export async function rejectSaleBatch(batchId: string, adminUserId: string, reason: string) {
  if (!reason.trim()) throw new BazaarError('반려 사유를 입력해 주세요.');
  const n = await prisma.bazaarSaleBatch.updateMany({
    where: { id: batchId, status: 'DRAFT' },
    data: { status: 'REJECTED', rejectReason: reason.slice(0, 200), approvedBy: adminUserId, approvedAt: new Date() },
  });
  if (n.count !== 1) throw new BazaarError('승인 대기 중인 판매 결과만 반려할 수 있습니다.');
}

// ===========================================================================
// 월 정산(월 1회)
// ===========================================================================

export async function settlementTotals(merchantId: string, month: string) {
  const rows = await prisma.bazaarLedger.groupBy({
    by: ['entryType'],
    where: { merchantId, month, entryType: { not: 'PAYOUT' } },
    _sum: { amount: true, vatAmount: true },
  });
  const get = (t: string) => rows.find((r) => r.entryType === t)?._sum.amount ?? 0n;
  const vat = rows.find((r) => r.entryType === 'FEE')?._sum.vatAmount ?? 0n;
  const gross = get('SALE');
  const refund = -get('REFUND');
  const fee = -get('FEE');
  const returnCost = -get('RETURN_COST');
  return { gross, refund, fee, feeVat: -vat, returnCost, payout: gross - refund - fee - returnCost };
}

/** 해당 월 원장이 있는 기관마다 정산을 만들거나(집계) 다시 계산한다. 확정·지급된 정산은 건드리지 않는다. */
export async function generateSettlements(month: string) {
  const config = await getBazaarConfig();
  const merchants = await prisma.bazaarLedger.findMany({ where: { month, entryType: { not: 'PAYOUT' } }, distinct: ['merchantId'], select: { merchantId: true } });
  let created = 0;
  for (const { merchantId } of merchants) {
    const t = await settlementTotals(merchantId, month);
    const existing = await prisma.bazaarSettlement.findUnique({ where: { merchantId_month: { merchantId, month } } });
    if (existing && existing.status !== 'DRAFT') continue;
    const data = { ...t, dueDate: settlementDueDate(month, config.settlementPayDay) };
    if (existing) await prisma.bazaarSettlement.update({ where: { id: existing.id }, data });
    else {
      await prisma.bazaarSettlement.create({ data: { id: newId(), merchantId, month, ...data } });
      created += 1;
    }
  }
  return { merchants: merchants.length, created };
}

export async function confirmSettlement(settlementId: string, adminUserId: string) {
  const s = await prisma.bazaarSettlement.findUnique({ where: { id: settlementId } });
  if (!s) throw new BazaarError('정산을 찾을 수 없습니다.');
  if (s.status !== 'DRAFT') throw new BazaarError('집계 상태의 정산만 확정할 수 있습니다.');
  // 확정 직전에 원장으로 다시 계산해 저장한다(집계 뒤 들어온 판매 반영).
  const t = await settlementTotals(s.merchantId, s.month);
  const n = await prisma.bazaarSettlement.updateMany({
    where: { id: settlementId, status: 'DRAFT' },
    data: { ...t, status: 'CONFIRMED', confirmedAt: new Date(), confirmedBy: adminUserId },
  });
  if (n.count !== 1) throw new BazaarError('이미 처리된 정산입니다.');
}

/** 지급 완료 기록(계좌 이체는 운영자가 은행에서 한다). 원장에 지급 기록을 남긴다. */
export async function markSettlementPaid(settlementId: string, adminUserId: string, input: { transferRef: string; paidAt: Date }) {
  if (!input.transferRef.trim()) throw new BazaarError('이체 확인 번호(또는 메모)를 입력해 주세요.');
  await prisma.$transaction(async (tx) => {
    const s = await tx.bazaarSettlement.findUnique({ where: { id: settlementId } });
    if (!s) throw new BazaarError('정산을 찾을 수 없습니다.');
    if (s.status !== 'CONFIRMED') throw new BazaarError('확정된 정산만 지급 완료로 바꿀 수 있습니다.');
    if (s.payout <= 0n) throw new BazaarError('지급할 금액이 없습니다(0원 이하). 다음 달 정산과 함께 처리됩니다.');
    const n = await tx.bazaarSettlement.updateMany({
      where: { id: settlementId, status: 'CONFIRMED' },
      data: { status: 'PAID', paidAt: input.paidAt, paidBy: adminUserId, transferRef: input.transferRef.trim().slice(0, 80) },
    });
    if (n.count !== 1) throw new BazaarError('이미 처리된 정산입니다.');
    await appendLedger(tx, {
      merchantId: s.merchantId,
      month: s.month,
      entryType: 'PAYOUT',
      amount: -s.payout,
      settlementId: s.id,
      idempotencyKey: `payout:${s.id}`,
      memo: `${s.month} 정산 지급`,
    });
  });
}

// ===========================================================================
// 대사
// ===========================================================================

/** 기브싸인에 승인 반영된 순판매액(판매 - 환불) — 원장 귀속 월 기준 */
export async function internalNetSales(month: string) {
  const rows = await prisma.bazaarLedger.groupBy({ by: ['entryType'], where: { month, entryType: { in: ['SALE', 'REFUND'] } }, _sum: { amount: true } });
  return rows.reduce((s, r) => s + (r._sum.amount ?? 0n), 0n);
}

export async function createReconcile(month: string, externalAmount: bigint, adminUserId: string, note?: string | null) {
  const internal = await internalNetSales(month);
  await prisma.bazaarReconcile.create({
    data: { id: newId(), month, externalAmount, internalAmount: internal, diff: externalAmount - internal, note: note?.trim().slice(0, 300) || null, createdBy: adminUserId },
  });
  return { internal, diff: externalAmount - internal };
}

// ===========================================================================
// 파일(사진·근거)
// ===========================================================================

const MAX_FILE = 5 * 1024 * 1024;
export function sniffFile(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

export async function saveDonationFile(donationId: string, kind: 'PHOTO' | 'EVIDENCE' | 'INSPECTION', file: File, uploadedBy: string) {
  if (file.size === 0) return null;
  if (file.size > MAX_FILE) throw new BazaarError('파일은 5MB 이하만 올릴 수 있습니다.');
  const count = await prisma.inKindFile.count({ where: { donationId } });
  if (count >= 20) throw new BazaarError('한 기부 건에는 파일을 20개까지 올릴 수 있습니다.');
  const buf = Buffer.from(await file.arrayBuffer());
  const kindOf = sniffFile(buf);
  if (!kindOf) throw new BazaarError('JPG·PNG·WEBP 사진 또는 PDF 만 올릴 수 있습니다.');
  const { putPrivateObject, newObjectName } = await import('@/server/uploads');
  const name = newObjectName(kindOf.ext);
  await putPrivateObject(name, buf, kindOf.mime);
  const id = newId();
  await prisma.inKindFile.create({
    data: {
      id,
      donationId,
      kind,
      objectName: name,
      fileName: (file.name || `file.${kindOf.ext}`).replace(/[^\w.\-가-힣 ]/g, '_').slice(0, 100),
      contentType: kindOf.mime,
      size: buf.length,
      uploadedBy,
    },
  });
  return id;
}
