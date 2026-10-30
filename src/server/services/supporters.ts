import { encrypt, maskPhone, normalizePhone, phoneHash, sha256 } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { addDays } from '@/lib/datetime';
import { prisma } from '@/server/db';
import { PAID_STATUSES } from '@/components/studio/shared';
import { RESERVED_DETAIL } from './charge-flow';

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
}

export async function listSupporters(merchantId: string, now = new Date()): Promise<SupporterRow[]> {
  const [sums, oneTime, firstCharges, recurring, apps, acts, contacts] = await Promise.all([
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
  ]);

  const ids = new Set<string>();
  for (const s of sums) ids.add(s.payerId!);
  for (const r of recurring) ids.add(r.payerId);
  for (const a of apps) ids.add(a.payerId);
  for (const a of acts) ids.add(a.payerId);
  const payers = await prisma.payerProfile.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, displayName: true, phoneMasked: true },
  });
  const pm = new Map(payers.map((p) => [p.id, p]));
  const sumM = new Map(sums.map((s) => [s.payerId!, s]));
  const oneM = new Map(oneTime.map((s) => [s.payerId!, s._count._all]));
  const srcM = new Map(firstCharges.map((c) => [c.payerId!, c.source]));
  const recM = new Map(recurring.map((r) => [r.payerId, r]));
  const appM = new Map(apps.map((a) => [a.payerId, a]));
  const actM = new Map(acts.map((a) => [a.payerId, a]));
  const contactByPayer = new Map(contacts.filter((c) => c.payerId).map((c) => [c.payerId!, c]));
  const dormantBefore = addDays(now, -183).getTime();

  const rows: SupporterRow[] = [];
  for (const id of ids) {
    const p = pm.get(id);
    const s = sumM.get(id);
    const r = recM.get(id);
    const a = appM.get(id);
    const act = actM.get(id);
    const c = contactByPayer.get(id);
    const donor = Boolean(s || r);
    const vol = Boolean(a || act);
    const role: SupporterRole = donor && vol ? 'BOTH' : donor ? 'DONOR' : 'VOLUNTEER';
    const oneTimeCount = oneM.get(id) ?? 0;
    const last = s?._max.paidAt ?? null;
    const segs: Segment[] = ['all'];
    if (oneTimeCount >= 2 && !r) segs.push('repeat_no_pledge');
    if (vol && !donor) segs.push('volunteer_only');
    if (s && !r && (last?.getTime() ?? 0) < dormantBefore) segs.push('dormant');
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
    });
  }
  for (const c of contacts) {
    if (c.payerId && ids.has(c.payerId)) continue;
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
  const payers = await prisma.payerProfile.findMany({
    where: { phoneHash: { in: [...latest.keys()] } },
    select: { id: true, phoneHash: true, displayName: true, phoneMasked: true },
  });
  const pledged = new Set(
    (
      await prisma.recurringDonation.findMany({
        where: { merchantId, payerId: { in: payers.map((p) => p.id) }, createdAt: { gte: since } },
        select: { payerId: true },
      })
    ).map((r) => r.payerId),
  );
  return payers
    .filter((p) => !pledged.has(p.id))
    .map((p) => ({ payerId: p.id, name: p.displayName ?? '후원자', phoneMasked: p.phoneMasked, requestedAt: latest.get(p.phoneHash)! }));
}
