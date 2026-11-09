import { decrypt, encrypt, maskPhone, normalizePhone, phoneHash, sha256 } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { addDays } from '@/lib/datetime';
import { prisma } from '@/server/db';
import { PAID_STATUSES } from '@/components/studio/shared';
import { RESERVED_DETAIL, sendMtDetailed } from './charge-flow';
import { env } from '@/lib/env';
import { kv } from '@/server/redis';
import * as tpl from './mt-templates';
import { mergeTargets } from './payer-merge';

/**
 * 후원자·자원봉사자 통합 관리 (구성원).
 *
 * 한 사람(PayerProfile)을 기준으로 후원(결제 건)·정기 약정·자원봉사 신청·활동·기관 보유 명단을 한 줄로 모은다.
 * 원천은 각 테이블이고 여기서는 계산만 한다 — 별도 누적 컬럼을 두지 않는다(절대 규칙 10 과 같은 원칙).
 *
 * 세그먼트는 기관이 다음에 할 일을 고르는 기준이다.
 *  - repeat_no_pledge : 일시후원 2회 이상인데 정기 약정이 없음 → 정기 전환 대상
 *  - volunteer_only   : 봉사만 하고 후원은 없음
 *  - dormant          : 6개월 이상 후원 없음(정기 약정 없음)
 *  - recurring        : 진행 중 정기 약정
 *  - contact_only     : 기관 명단에만 있고 아직 후원·봉사 없음
 */

export type SupporterRole = 'DONOR' | 'VOLUNTEER' | 'BOTH' | 'CONTACT';
export const SEGMENTS = ['all', 'repeat_no_pledge', 'volunteer_only', 'dormant', 'recurring', 'contact_only'] as const;
export type Segment = (typeof SEGMENTS)[number];

export const SEGMENT_LABEL: Record<Segment, string> = {
  all: '전체',
  repeat_no_pledge: '정기 전환 대상 (일시 2회↑·약정 없음)',
  volunteer_only: '봉사만 참여',
  dormant: '6개월 이상 후원 없음',
  recurring: '정기후원 중',
  contact_only: '명단만 있음',
};

export const ROLE_LABEL: Record<SupporterRole, string> = {
  DONOR: '후원자',
  VOLUNTEER: '봉사자',
  BOTH: '후원·봉사',
  CONTACT: '명단',
};

export interface SupporterRow {
  key: string;
  payerId: string | null;
  contactId: string | null;
  name: string;
  phoneMasked: string;
  role: SupporterRole;
  totalAmount: bigint;
  donationCount: number;
  oneTimeCount: number;
  lastDonatedAt: Date | null;
  firstSource: string | null;
  recurring: { status: string; amount: bigint; dayOfMonth: number } | null;
  volunteer: { status: string; minutes: number; lastActivity: Date | null } | null;
  tags: string[];
  segments: Segment[];
  /** 관리자가 이 후원자에 병합한 다른 후원자 수(번호 변경 등). 0 이면 병합 없음. 기관 화면은 "병합됨" 표시만 한다. */
  mergedCount: number;
  /** 기관 통장 계좌이체 확정분(입금 맞추기, 2026-11-09 E). totalAmount(기브싸인 결제)와 합치지 않고 따로 센다. */
  offlineAmount: bigint;
  offlineCount: number;
}

export async function listSupporters(merchantId: string, now = new Date()): Promise<SupporterRow[]> {
  const [sums, oneTime, firstCharges, recurring, apps, acts, contacts, offline] = await Promise.all([
    prisma.charge.groupBy({
      by: ['payerId'],
      where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { not: null } },
      _sum: { amount: true },
      _count: { _all: true },
      _max: { paidAt: true },
    }),
    prisma.charge.groupBy({
      by: ['payerId'],
      where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { not: null }, recurringId: null },
      _count: { _all: true },
    }),
    prisma.charge.findMany({
      where: { merchantId, isTest: false, payerId: { not: null }, source: { not: null } },
      select: { payerId: true, source: true, receivedAt: true },
      orderBy: { receivedAt: 'asc' },
      distinct: ['payerId'],
    }),
    prisma.recurringDonation.findMany({
      where: { merchantId, status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } },
      select: { payerId: true, status: true, amount: true, dayOfMonth: true, source: true },
    }),
    prisma.volunteerApplication.findMany({
      where: { merchantId, status: { in: ['RECEIVED', 'APPROVED'] } },
      select: { payerId: true, status: true, source: true },
    }),
    prisma.volunteerActivity.groupBy({
      by: ['payerId'],
      where: { merchantId },
      _sum: { minutes: true },
      _max: { activityDate: true },
    }),
    prisma.supporterContact.findMany({
      where: { merchantId, archivedAt: null },
      select: { id: true, name: true, phoneMasked: true, role: true, tags: true, payerId: true },
    }),
    prisma.offlineDonation.groupBy({
      by: ['payerId'],
      where: { merchantId, status: 'CONFIRMED' },
      _sum: { amount: true },
      _count: { _all: true },
      _max: { donatedAt: true },
    }),
  ]);

  // 관리자 병합(번호 변경 등): 원본 후원자 행은 대상 후원자 한 줄로 합산한다(데이터는 옮기지 않는다).
  const rawIds = new Set<string>();
  for (const s of sums) rawIds.add(s.payerId!);
  for (const r of recurring) rawIds.add(r.payerId);
  for (const a of apps) rawIds.add(a.payerId);
  for (const a of acts) rawIds.add(a.payerId);
  for (const c of contacts) if (c.payerId) rawIds.add(c.payerId);
  for (const o of offline) rawIds.add(o.payerId);
  const merged = await mergeTargets([...rawIds]);
  const canon = (id: string) => merged.get(id) ?? id;
  const mergedCount = new Map<string, number>();
  for (const [, t] of merged) mergedCount.set(t, (mergedCount.get(t) ?? 0) + 1);

  const ids = new Set<string>();
  for (const s of sums) ids.add(canon(s.payerId!));
  for (const r of recurring) ids.add(canon(r.payerId));
  for (const a of apps) ids.add(canon(a.payerId));
  for (const a of acts) ids.add(canon(a.payerId));
  for (const o of offline) ids.add(canon(o.payerId));
  const payers = await prisma.payerProfile.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, displayName: true, phoneMasked: true },
  });
  const pm = new Map(payers.map((p) => [p.id, p]));
  type SumRow = { _sum: { amount: bigint }; _count: { _all: number }; _max: { paidAt: Date | null } };
  const sumM = new Map<string, SumRow>();
  for (const s of sums) {
    const k = canon(s.payerId!);
    const cur = sumM.get(k);
    const paid = s._max.paidAt ?? null;
    if (!cur) sumM.set(k, { _sum: { amount: s._sum.amount ?? 0n }, _count: { _all: s._count._all }, _max: { paidAt: paid } });
    else {
      cur._sum.amount += s._sum.amount ?? 0n;
      cur._count._all += s._count._all;
      if (paid && (!cur._max.paidAt || paid > cur._max.paidAt)) cur._max.paidAt = paid;
    }
  }
  const oneM = new Map<string, number>();
  for (const s of oneTime) oneM.set(canon(s.payerId!), (oneM.get(canon(s.payerId!)) ?? 0) + s._count._all);
  // firstCharges 는 receivedAt 오름차순이라 처음 넣은 값이 가장 이른 유입이다.
  const srcM = new Map<string, string | null>();
  for (const c of firstCharges) if (!srcM.has(canon(c.payerId!))) srcM.set(canon(c.payerId!), c.source);
  const recM = new Map<string, (typeof recurring)[number]>();
  for (const r of recurring) {
    const k = canon(r.payerId);
    if (!recM.has(k) || (r.status === 'ACTIVE' && recM.get(k)!.status !== 'ACTIVE')) recM.set(k, r);
  }
  const appM = new Map<string, (typeof apps)[number]>();
  for (const a of apps) {
    const k = canon(a.payerId);
    if (!appM.has(k) || (a.status === 'APPROVED' && appM.get(k)!.status !== 'APPROVED')) appM.set(k, a);
  }
  type ActRow = { _sum: { minutes: number | null }; _max: { activityDate: Date | null } };
  const actM = new Map<string, ActRow>();
  for (const a of acts) {
    const k = canon(a.payerId);
    const cur = actM.get(k);
    if (!cur) actM.set(k, { _sum: { minutes: a._sum.minutes ?? 0 }, _max: { activityDate: a._max.activityDate ?? null } });
    else {
      cur._sum.minutes = (cur._sum.minutes ?? 0) + (a._sum.minutes ?? 0);
      const d = a._max.activityDate ?? null;
      if (d && (!cur._max.activityDate || d > cur._max.activityDate)) cur._max.activityDate = d;
    }
  }
  const offM = new Map<string, { amount: bigint; count: number; last: Date | null }>();
  for (const o of offline) {
    const k = canon(o.payerId);
    const cur = offM.get(k) ?? { amount: 0n, count: 0, last: null };
    cur.amount += o._sum.amount ?? 0n;
    cur.count += o._count._all;
    const d = o._max.donatedAt ?? null;
    if (d && (!cur.last || d > cur.last)) cur.last = d;
    offM.set(k, cur);
  }
  const contactByPayer = new Map<string, (typeof contacts)[number]>();
  for (const c of contacts) if (c.payerId && !contactByPayer.has(canon(c.payerId))) contactByPayer.set(canon(c.payerId), c);
  const dormantBefore = addDays(now, -183).getTime();

  const rows: SupporterRow[] = [];
  for (const id of ids) {
    const p = pm.get(id);
    const s = sumM.get(id);
    const r = recM.get(id);
    const a = appM.get(id);
    const act = actM.get(id);
    const c = contactByPayer.get(id);
    const off = offM.get(id);
    const donor = Boolean(s || r || off);
    const vol = Boolean(a || act);
    const role: SupporterRole = donor && vol ? 'BOTH' : donor ? 'DONOR' : 'VOLUNTEER';
    const oneTimeCount = oneM.get(id) ?? 0;
    const last = s?._max.paidAt ?? null;
    const segs: Segment[] = ['all'];
    if (oneTimeCount >= 2 && !r) segs.push('repeat_no_pledge');
    if (vol && !donor) segs.push('volunteer_only');
    // 계좌이체 확정분이 최근에 있으면 휴면이 아니다(계좌이체가 없으면 예전 판단 그대로).
    if (s && !r && Math.max(last?.getTime() ?? 0, off?.last?.getTime() ?? 0) < dormantBefore) segs.push('dormant');
    if (r?.status === 'ACTIVE') segs.push('recurring');
    rows.push({
      key: `p:${id}`,
      payerId: id,
      contactId: c?.id ?? null,
      name: p?.displayName || c?.name || '후원자',
      phoneMasked: p?.phoneMasked ?? c?.phoneMasked ?? '',
      role,
      totalAmount: s?._sum.amount ?? 0n,
      donationCount: s?._count._all ?? 0,
      oneTimeCount,
      lastDonatedAt: last,
      firstSource: srcM.get(id) ?? r?.source ?? a?.source ?? null,
      recurring: r ? { status: r.status, amount: r.amount, dayOfMonth: r.dayOfMonth } : null,
      volunteer: a || act ? { status: a?.status ?? 'DONE', minutes: act?._sum.minutes ?? 0, lastActivity: act?._max.activityDate ?? null } : null,
      tags: c?.tags ?? [],
      segments: segs,
      mergedCount: mergedCount.get(id) ?? 0,
      offlineAmount: off?.amount ?? 0n,
      offlineCount: off?.count ?? 0,
    });
  }
  for (const c of contacts) {
    if (c.payerId && ids.has(canon(c.payerId))) continue;
    rows.push({
      key: `c:${c.id}`,
      payerId: c.payerId,
      contactId: c.id,
      name: c.name,
      phoneMasked: c.phoneMasked,
      role: 'CONTACT',
      totalAmount: 0n,
      donationCount: 0,
      oneTimeCount: 0,
      lastDonatedAt: null,
      firstSource: 'IMPORT',
      recurring: null,
      volunteer: null,
      tags: c.tags,
      segments: ['all', 'contact_only'],
      mergedCount: 0,
      offlineAmount: 0n,
      offlineCount: 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 명단 업로드 (CSV)
// ---------------------------------------------------------------------------

export const IMPORT_MAX_ROWS = 2000;
export const IMPORT_ROLE: Record<string, string> = { 후원자: 'DONOR', 봉사자: 'VOLUNTEER', 기타: 'OTHER', DONOR: 'DONOR', VOLUNTEER: 'VOLUNTEER', OTHER: 'OTHER' };

export interface ImportPreviewRow {
  line: number;
  name: string;
  phoneMasked: string;
  role: string;
  tags: string[];
  status: 'NEW' | 'DUPLICATE' | 'ERROR';
  error?: string;
}

/** 따옴표를 지원하는 단순 CSV 파서 */
export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
      continue;
    }
    if (ch === '"') q = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim())) out.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) out.push(row);
  return out;
}

interface ParsedContact {
  line: number;
  name: string;
  phone: string;
  role: string;
  tags: string[];
  note: string | null;
}

function parseContacts(csv: string): { rows: ParsedContact[]; errors: ImportPreviewRow[] } {
  const table = parseCsv(csv);
  if (table.length === 0) return { rows: [], errors: [] };
  const header = table[0]!.map((h) => h.trim());
  const hasHeader = header.some((h) => /이름|성명|휴대폰|전화|name|phone/i.test(h));
  const col = (names: RegExp, fallback: number) => {
    const i = header.findIndex((h) => names.test(h));
    return hasHeader ? i : fallback;
  };
  const ci = { name: col(/이름|성명|name/i, 0), phone: col(/휴대폰|전화|연락처|phone/i, 1), role: col(/구분|역할|role/i, 2), tags: col(/태그|tag/i, 3), note: col(/메모|비고|note/i, 4) };
  const body = hasHeader ? table.slice(1) : table;
  const rows: ParsedContact[] = [];
  const errors: ImportPreviewRow[] = [];
  body.slice(0, IMPORT_MAX_ROWS).forEach((r, idx) => {
    const line = idx + (hasHeader ? 2 : 1);
    const name = (r[ci.name] ?? '').trim().slice(0, 30);
    const phone = normalizePhone(r[ci.phone] ?? '');
    const role = IMPORT_ROLE[(r[ci.role] ?? '').trim()] ?? 'OTHER';
    const tags = (ci.tags >= 0 ? (r[ci.tags] ?? '') : '').split(/[;|/]/).map((t) => t.trim()).filter(Boolean).slice(0, 5);
    const note = ci.note >= 0 ? (r[ci.note] ?? '').trim().slice(0, 200) || null : null;
    if (!name) errors.push({ line, name: '', phoneMasked: '', role, tags, status: 'ERROR', error: '이름 없음' });
    else if (!/^01\d{8,9}$/.test(phone)) errors.push({ line, name, phoneMasked: '', role, tags, status: 'ERROR', error: '휴대폰 번호 형식 오류' });
    else rows.push({ line, name, phone, role, tags, note });
  });
  return { rows, errors };
}

export async function previewSupporterImport(merchantId: string, csv: string) {
  const { rows, errors } = parseContacts(csv);
  const hashes = rows.map((r) => phoneHash(r.phone));
  const existing = new Set(
    (await prisma.supporterContact.findMany({ where: { merchantId, phoneHash: { in: hashes } }, select: { phoneHash: true } })).map((c) => c.phoneHash),
  );
  const seen = new Set<string>();
  const preview: ImportPreviewRow[] = [...errors];
  for (const r of rows) {
    const h = phoneHash(r.phone);
    const dup = existing.has(h) || seen.has(h);
    seen.add(h);
    preview.push({ line: r.line, name: r.name, phoneMasked: maskPhone(r.phone), role: r.role, tags: r.tags, status: dup ? 'DUPLICATE' : 'NEW' });
  }
  preview.sort((a, b) => a.line - b.line);
  return {
    rows: preview,
    newCount: preview.filter((p) => p.status === 'NEW').length,
    duplicateCount: preview.filter((p) => p.status === 'DUPLICATE').length,
    errorCount: errors.length,
    truncated: parseCsv(csv).length - 1 > IMPORT_MAX_ROWS,
  };
}

export class ImportError extends Error {}

export async function commitSupporterImport(input: {
  merchantId: string;
  userId: string;
  fileName: string;
  csv: string;
  consentConfirmed: boolean;
  consentBasis: string;
}) {
  if (!input.consentConfirmed) throw new ImportError('연락처 수집·이용 동의를 받은 명단인지 확인해 주세요.');
  const basis = input.consentBasis.trim();
  if (basis.length < 4) throw new ImportError('동의를 받은 근거(예: 2025 후원의 밤 신청서)를 적어 주세요.');
  const { rows, errors } = parseContacts(input.csv);
  if (rows.length === 0) throw new ImportError('등록할 수 있는 행이 없습니다. 이름과 휴대폰 열을 확인해 주세요.');

  const hashes = rows.map((r) => phoneHash(r.phone));
  const [existing, payers] = await Promise.all([
    prisma.supporterContact.findMany({ where: { merchantId: input.merchantId, phoneHash: { in: hashes } }, select: { phoneHash: true } }),
    prisma.payerProfile.findMany({ where: { phoneHash: { in: hashes } }, select: { id: true, phoneHash: true } }),
  ]);
  const existingSet = new Set(existing.map((e) => e.phoneHash));
  const payerByHash = new Map(payers.map((p) => [p.phoneHash, p.id]));
  const seen = new Set<string>();
  const fresh: ParsedContact[] = [];
  for (const r of rows) {
    const h = phoneHash(r.phone);
    if (existingSet.has(h) || seen.has(h)) continue;
    seen.add(h);
    fresh.push(r);
  }
  const importId = newId();
  await prisma.$transaction(async (tx) => {
    await tx.supporterImport.create({
      data: {
        id: importId,
        merchantId: input.merchantId,
        fileName: input.fileName.slice(0, 120) || 'upload.csv',
        rowCount: rows.length + errors.length,
        acceptedCount: fresh.length,
        duplicateCount: rows.length - fresh.length,
        errorCount: errors.length,
        consentConfirmedAt: new Date(),
        consentBasis: basis.slice(0, 200),
        checksum: sha256(input.csv),
        createdBy: input.userId,
      },
    });
    if (fresh.length) {
      await tx.supporterContact.createMany({
        data: fresh.map((r) => {
          const h = phoneHash(r.phone);
          return {
            id: newId(),
            merchantId: input.merchantId,
            importId,
            name: r.name,
            phoneHash: h,
            phoneEnc: encrypt(r.phone),
            phoneMasked: maskPhone(r.phone),
            role: r.role,
            tags: r.tags,
            note: r.note,
            payerId: payerByHash.get(h) ?? null,
          };
        }),
        skipDuplicates: true,
      });
    }
  });
  return { importId, accepted: fresh.length, duplicates: rows.length - fresh.length, errors: errors.length };
}

// ---------------------------------------------------------------------------
// 정기 약정 미완료 재안내
// ---------------------------------------------------------------------------

/**
 * 문자 '정기' 로 약정 링크를 받았지만 30일 안에 약정을 마치지 않은 후원자.
 * 본인이 먼저 요청한 안내를 한 번 더 보내는 것이라 정보성 안내로 본다. 광고성 발송 대상은 만들지 않는다.
 */
export async function pendingPledgeRequests(merchantId: string, now = new Date()) {
  const since = addDays(now, -30);
  const mos = await prisma.moInboundMessage.findMany({
    where: { merchantId, receivedAt: { gte: since }, resultDetail: { startsWith: RESERVED_DETAIL.PLEDGE } },
    select: { phoneHash: true, receivedAt: true },
    orderBy: { receivedAt: 'desc' },
  });
  const latest = new Map<string, Date>();
  for (const m of mos) if (!latest.has(m.phoneHash)) latest.set(m.phoneHash, m.receivedAt);
  if (latest.size === 0) return [];
  // 이용 제한된 후원자는 대상에서 뺀다(전체 제한 blockedAt).
  const payers = await prisma.payerProfile.findMany({
    where: { phoneHash: { in: [...latest.keys()] }, blockedAt: null },
    select: { id: true, phoneHash: true, displayName: true, phoneMasked: true },
  });
  const ids = payers.map((p) => p.id);
  const [pledges, blockedByMerchant, blockedByPayer] = await Promise.all([
    // 진행 중 약정(언제 만들었든) 또는 최근 30일 안에 만든 약정이 있으면 이미 마친 사람이다.
    prisma.recurringDonation.findMany({
      where: { merchantId, payerId: { in: ids }, OR: [{ status: { in: ['ACTIVE', 'PAUSED', 'SUSPENDED'] } }, { createdAt: { gte: since } }] },
      select: { payerId: true },
    }),
    // 기관이 차단한 후원자
    prisma.blockedPayer.findMany({ where: { merchantId, payerId: { in: ids } }, select: { payerId: true } }),
    // 후원자가 이 기관을 차단했거나 이 기관 안내를 거부한 경우
    prisma.payerMerchantLink.findMany({
      where: { merchantId, payerId: { in: ids }, OR: [{ payerBlockedAt: { not: null } }, { noticeOptOutAt: { not: null } }] },
      select: { payerId: true },
    }),
  ]);
  const excluded = new Set([...pledges, ...blockedByMerchant, ...blockedByPayer].map((r) => r.payerId));
  return payers
    .filter((p) => !excluded.has(p.id))
    .map((p) => ({ payerId: p.id, name: p.displayName ?? '후원자', phoneMasked: p.phoneMasked, requestedAt: latest.get(p.phoneHash)! }));
}

/** 약정 재안내 최소 간격(후원자별). */
export const PLEDGE_REMINDER_INTERVAL_DAYS = 7;

/**
 * 약정 미완료 재안내 발송. 후원자당 PLEDGE_REMINDER_INTERVAL_DAYS 에 한 번만 보낸다 —
 * 버튼을 여러 번 눌러도, 동시에 눌러도 다시 나가지 않는다(kv setnx). 잠금 상태를 확인할 수 없으면
 * 보내지 않는다(스팸보다 누락이 낫다). 약정 링크는 문자로만 보낸다(알림톡 템플릿 목록에 없음).
 */
export async function sendPledgeReminders(merchantId: string, now = new Date()) {
  const targets = await pendingPledgeRequests(merchantId, now);
  const out = { targets: targets.length, sent: 0, suppressed: 0, failed: 0 };
  if (targets.length === 0) return out;
  const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { code: true, displayName: true } });
  const payers = await prisma.payerProfile.findMany({ where: { id: { in: targets.map((t) => t.payerId) } }, select: { id: true, phoneEnc: true } });
  for (const p of payers) {
    const fresh = await kv
      .setnx(`pledge:remind:${merchantId}:${p.id}`, String(now.getTime()), PLEDGE_REMINDER_INTERVAL_DAYS * 86_400)
      .catch(() => false);
    if (!fresh) {
      out.suppressed += 1;
      continue;
    }
    const link = `${env.baseUrl}/my/recurring/new?merchant=${merchant.code}&src=sms`;
    const r = await sendMtDetailed({ phone: decrypt(p.phoneEnc), template: tpl.tplPledgeLink({ merchantName: merchant.displayName, link }), merchantId }).catch(() => null);
    if (r?.ok) out.sent += 1;
    else out.failed += 1;
  }
  return out;
}
