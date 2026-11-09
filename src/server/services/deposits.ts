import { prisma } from '@/server/db';
import type { Prisma } from '@/generated/prisma/client';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, normalizePhone, phoneHash, sha256, decrypt } from '@/lib/crypto';
import { kstDateKey, kstMonthKey, kstStartOfMonth } from '@/lib/datetime';
import { formatWon } from '@/lib/money';
import { logger } from '@/lib/logger';
import { PAID_STATUSES } from '@/components/studio/shared';
import {
  DEPOSIT_FILE_MAX_BYTES,
  DEPOSIT_MAX_ROWS,
  detectColumns,
  formatLabel,
  guessHeaderRow,
  parseStatementRows,
  depositorKey,
  type ColumnMapping,
  type ParsedDeposit,
} from '@/lib/bank-statement';
import { readStatementTable, StatementFileError } from './bank-statement-file';
import { emitDomainEvent, registerConsumer, type StoredDomainEvent } from './events';
import { notifyUser } from './notifications';
import { kv } from '@/server/redis';

/**
 * 입금 자동 대사 — 기관 통장 거래내역 파일 (2026-11-09 과제 E).
 *
 * 사회복지기관 후원금 중 기브싸인 결제(MO·웹·정기 출금) 밖에서 기관 통장으로 바로 들어온 계좌이체·CMS 를
 * 기관이 올린 거래내역 파일로 후원자와 맞춘다. 이 돈은 **기브싸인이 받은 돈이 아니다** — 결제(charge)·정산 원장·
 * 수수료와 무관하고, 확정분은 `offline_donation` 에만 남는다(캠페인 모금액·정산·후원 내역 숫자는 바뀌지 않는다).
 *
 *  - 파일: 같은 파일(내용 해시)은 기관당 1회. 같은 입금은 (기관, 거래일시, 금액, 입금자 키, 잔액[, 파일 안 같은 값 순번]) 해시로 1회.
 *  - 맞추기 규칙은 `classifyDeposit` 한 곳(테스트 대상). 자동 확정은 "이름 일치 1명 + 같은 금액 정기 입금 이력(확정 2회↑ 또는 계좌이체 약정)" 일 때만.
 *  - 확정·되돌리기는 조건부 갱신(입금 상태)으로 한 번만. 확정 = offline_donation + 이벤트 offline.received 같은 트랜잭션.
 *  - 권한: 기관 콘솔 계정(requireMerchant — 지금 기관당 담당자 계정 1개, 별도 금전 권한 체계 없음). 업로드·확정·무시·되돌리기는 감사로그.
 */

export class DepositError extends Error {}

const ACTIVE_STATUSES = ['UNMATCHED', 'SUGGESTED'] as const;

// ---------------------------------------------------------------------------
// 감사로그 — 요청 밖(테스트·배치)에서도 남긴다
// ---------------------------------------------------------------------------

async function audit(input: { actorUserId: string; action: string; targetType: string; targetId?: string; after?: unknown }) {
  try {
    const { writeAudit } = await import('@/server/auth');
    await writeAudit(input);
    return;
  } catch {
    // 요청 맥락(headers)이 없으면 IP 없이 직접 남긴다.
  }
  await prisma.adminAuditLog
    .create({
      data: {
        id: newId(),
        actorUserId: input.actorUserId,
        actorLabel: input.actorUserId,
        actorRole: 'MERCHANT',
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        afterValue: (input.after ?? null) as object,
      },
    })
    .catch((e) => logger.warn('입금 맞추기 감사로그 실패', { action: input.action, message: (e as Error).message }));
}

// ---------------------------------------------------------------------------
// 후보 (그 기관과 관계가 있는 후원자)
// ---------------------------------------------------------------------------

export interface DepositCandidate {
  /** p:{payerId} 또는 c:{contactId}(아직 후원자 계정이 없는 기관 명단) */
  key: string;
  payerId: string | null;
  contactId: string | null;
  name: string;
  phoneMasked: string;
  reason: 'EXACT' | 'SIMILAR';
}

interface CandidateInfo {
  key: string;
  payerId: string | null;
  contactId: string | null;
  name: string;
  phoneMasked: string;
  names: Set<string>;
  /** 알려진 금액(정기 약정·계좌이체 약정·이전 확정 입금) — 비슷한 이름 제안 근거 */
  amounts: Set<string>;
}

export interface MatchContext {
  merchantId: string;
  candidates: Map<string, CandidateInfo>;
  byName: Map<string, Set<string>>;
  /** payerId → 금액 → 확정된 계좌이체 횟수 */
  history: Map<string, Map<string, number>>;
  /** payerId → 보관 전 계좌이체 약정 */
  pledges: Map<string, { id: string; amount: bigint; campaignId: string | null }>;
}

/** 그 기관과 관계가 있는 후원자(결제·약정·명단·봉사·계좌이체)를 모은다. 병합된 후원자는 대상 후원자로 합친다. */
export async function loadMatchContext(merchantId: string): Promise<MatchContext> {
  const [chargeNames, recurring, apps, acts, contacts, offline, pledges] = await Promise.all([
    prisma.charge.groupBy({
      by: ['payerId', 'displayName', 'anonymous'],
      where: { merchantId, isTest: false, status: { in: PAID_STATUSES }, payerId: { not: null } },
    }),
    prisma.recurringDonation.findMany({ where: { merchantId }, select: { payerId: true, amount: true, status: true } }),
    prisma.volunteerApplication.findMany({ where: { merchantId }, select: { payerId: true }, distinct: ['payerId'] }),
    prisma.volunteerActivity.findMany({ where: { merchantId }, select: { payerId: true }, distinct: ['payerId'] }),
    prisma.supporterContact.findMany({ where: { merchantId, archivedAt: null }, select: { id: true, name: true, phoneMasked: true, payerId: true } }),
    prisma.offlineDonation.groupBy({ by: ['payerId', 'amount'], where: { merchantId, status: 'CONFIRMED' }, _count: { _all: true } }),
    prisma.offlinePledge.findMany({ where: { merchantId, archivedAt: null }, select: { id: true, payerId: true, amount: true, campaignId: true } }),
  ]);
  const raw = new Set<string>();
  for (const c of chargeNames) raw.add(c.payerId!);
  for (const r of recurring) raw.add(r.payerId);
  for (const a of apps) raw.add(a.payerId);
  for (const a of acts) raw.add(a.payerId);
  for (const c of contacts) if (c.payerId) raw.add(c.payerId);
  for (const o of offline) raw.add(o.payerId);
  for (const p of pledges) raw.add(p.payerId);
  const merged = await prisma.payerProfile.findMany({ where: { id: { in: [...raw] }, mergedIntoId: { not: null } }, select: { id: true, mergedIntoId: true } });
  const canonMap = new Map(merged.map((m) => [m.id, m.mergedIntoId!]));
  const canon = (id: string) => canonMap.get(id) ?? id;
  const ids = new Set([...raw].map(canon));
  const [payers, receiptProfiles] = await Promise.all([
    prisma.payerProfile.findMany({ where: { id: { in: [...ids] } }, select: { id: true, displayName: true, phoneMasked: true, onboardingStatus: true } }),
    prisma.payerReceiptProfile.findMany({ where: { payerId: { in: [...raw] } }, select: { payerId: true, legalName: true } }),
  ]);

  const candidates = new Map<string, CandidateInfo>();
  const contactByPayer = new Map<string, (typeof contacts)[number]>();
  for (const c of contacts) if (c.payerId && !contactByPayer.has(canon(c.payerId))) contactByPayer.set(canon(c.payerId), c);
  for (const p of payers) {
    if (p.onboardingStatus === 'WITHDRAWN') continue;
    const contact = contactByPayer.get(p.id);
    candidates.set(`p:${p.id}`, {
      key: `p:${p.id}`,
      payerId: p.id,
      contactId: contact?.id ?? null,
      name: contact?.name || p.displayName || '후원자',
      phoneMasked: p.phoneMasked,
      names: new Set(),
      amounts: new Set(),
    });
  }
  const addName = (payerId: string, name: string | null | undefined) => {
    const c = candidates.get(`p:${canon(payerId)}`);
    const k = depositorKey(name ?? '');
    if (c && k.length >= 2) c.names.add(k);
  };
  for (const p of payers) addName(p.id, p.displayName);
  for (const r of receiptProfiles) addName(r.payerId, r.legalName);
  for (const c of chargeNames) if (!c.anonymous) addName(c.payerId!, c.displayName);
  for (const c of contacts) {
    if (c.payerId) {
      addName(c.payerId, c.name);
      continue;
    }
    const k = depositorKey(c.name);
    candidates.set(`c:${c.id}`, { key: `c:${c.id}`, payerId: null, contactId: c.id, name: c.name, phoneMasked: c.phoneMasked, names: new Set(k.length >= 2 ? [k] : []), amounts: new Set() });
  }
  for (const r of recurring) candidates.get(`p:${canon(r.payerId)}`)?.amounts.add(r.amount.toString());

  const history = new Map<string, Map<string, number>>();
  for (const o of offline) {
    const pid = canon(o.payerId);
    const m = history.get(pid) ?? new Map<string, number>();
    m.set(o.amount.toString(), (m.get(o.amount.toString()) ?? 0) + o._count._all);
    history.set(pid, m);
    candidates.get(`p:${pid}`)?.amounts.add(o.amount.toString());
  }
  const pledgeMap = new Map<string, { id: string; amount: bigint; campaignId: string | null }>();
  for (const p of pledges) {
    pledgeMap.set(canon(p.payerId), { id: p.id, amount: p.amount, campaignId: p.campaignId });
    candidates.get(`p:${canon(p.payerId)}`)?.amounts.add(p.amount.toString());
  }

  const byName = new Map<string, Set<string>>();
  for (const c of candidates.values()) {
    for (const n of c.names) {
      const set = byName.get(n) ?? new Set<string>();
      set.add(c.key);
      byName.set(n, set);
    }
  }
  return { merchantId, candidates, byName, history, pledges: pledgeMap };
}

export interface Classification {
  status: 'MATCHED' | 'SUGGESTED' | 'UNMATCHED';
  /** 자동 확정 대상 */
  payerId?: string;
  pledgeId?: string | null;
  campaignId?: string | null;
  candidates: DepositCandidate[];
  /** 화면용 근거 */
  note: string;
}

const toCandidate = (c: CandidateInfo, reason: DepositCandidate['reason']): DepositCandidate => ({
  key: c.key,
  payerId: c.payerId,
  contactId: c.contactId,
  name: c.name,
  phoneMasked: c.phoneMasked,
  reason,
});

/**
 * 맞추기 규칙(코드 한 곳).
 *  - 자동 확정: 이름 일치 후보가 정확히 1명(후원자 계정 있음)이고, 그 후원자에게 같은 금액의 정기 입금 이력
 *    (이전 확정 입금 2회 이상 같은 금액, 또는 같은 금액의 계좌이체 약정)이 있을 때만. 같은 날 같은 사람·금액 입금이 또 있으면(경고) 자동 확정하지 않는다.
 *  - 제안: 이름 일치 1명이지만 이력 없음 / 이름 일치 여러 명 / 이름 앞 2글자 + 알려진 금액 일치.
 *  - 모름: 후보 없음.
 */
export function classifyDeposit(dep: { key: string; amount: bigint; duplicateWarning?: boolean }, ctx: MatchContext): Classification {
  const amount = dep.amount.toString();
  const exactKeys = dep.key.length >= 2 ? [...(ctx.byName.get(dep.key) ?? [])] : [];
  const exact = exactKeys.map((k) => ctx.candidates.get(k)!).filter(Boolean);
  if (exact.length === 1) {
    const c = exact[0]!;
    if (c.payerId) {
      const pledge = ctx.pledges.get(c.payerId);
      const pledgeHit = pledge && pledge.amount === dep.amount ? pledge : null;
      const prior = ctx.history.get(c.payerId)?.get(amount) ?? 0;
      if ((pledgeHit || prior >= 2) && !dep.duplicateWarning) {
        return {
          status: 'MATCHED',
          payerId: c.payerId,
          pledgeId: pledgeHit?.id ?? null,
          campaignId: pledgeHit?.campaignId ?? null,
          candidates: [toCandidate(c, 'EXACT')],
          note: pledgeHit ? '이름 일치 + 계좌이체 약정 금액' : `이름 일치 + 같은 금액 입금 ${prior}회`,
        };
      }
      return {
        status: 'SUGGESTED',
        candidates: [toCandidate(c, 'EXACT')],
        note: dep.duplicateWarning ? '같은 날 같은 금액 입금이 또 있음 — 확인 필요' : '이름 일치(같은 금액 정기 입금 이력 없음)',
      };
    }
    return { status: 'SUGGESTED', candidates: [toCandidate(c, 'EXACT')], note: '기관 명단의 이름과 일치(후원자 계정 없음)' };
  }
  if (exact.length > 1) {
    return { status: 'SUGGESTED', candidates: exact.slice(0, 5).map((c) => toCandidate(c, 'EXACT')), note: `이름이 같은 후원자 ${exact.length}명` };
  }
  if (dep.key.length >= 2) {
    const head = dep.key.slice(0, 2);
    const similar: CandidateInfo[] = [];
    for (const c of ctx.candidates.values()) {
      if (!c.amounts.has(amount)) continue;
      if ([...c.names].some((n) => n.length >= 2 && n.slice(0, 2) === head)) similar.push(c);
      if (similar.length >= 5) break;
    }
    if (similar.length) return { status: 'SUGGESTED', candidates: similar.map((c) => toCandidate(c, 'SIMILAR')), note: '이름 앞 두 글자와 금액이 같은 후원자' };
  }
  return { status: 'UNMATCHED', candidates: [], note: '맞는 후원자 없음' };
}

// ---------------------------------------------------------------------------
// 파일 올리기
// ---------------------------------------------------------------------------

export type ImportResult =
  | { status: 'NEEDS_MAPPING'; headerRow: number; headers: string[]; sample: string[][]; encoding: string }
  | {
      status: 'DONE';
      importId: string;
      format: string;
      encoding: string;
      rowCount: number;
      newCount: number;
      duplicateCount: number;
      skippedCount: number;
      errors: Array<{ line: number; reason: string }>;
      autoMatched: number;
      suggested: number;
      unmatched: number;
      duplicateWarnings: number;
    };

/** (기관, 거래일시, 금액, 입금자 키, 잔액) 해시. 같은 파일 안에서 다섯 값이 모두 같은 줄은 순번을 붙인다(잔액·시각이 없는 형식). */
export function depositHash(merchantId: string, d: Pick<ParsedDeposit, 'occurredAt' | 'amount' | 'key' | 'balance'>, ordinal: number): string {
  return sha256(`bank-deposit:${merchantId}|${d.occurredAt.toISOString()}|${d.amount}|${d.key}|${d.balance ?? ''}|${ordinal}`);
}

/**
 * 거래내역 파일을 올린다. 열을 모르면 NEEDS_MAPPING(열 고르기 화면) — 아무것도 저장하지 않는다.
 * 같은 파일은 두 번 올릴 수 없고(DepositError), 다른 파일에 이미 있던 입금은 건너뛴다(duplicateCount).
 */
export async function importBankStatement(input: {
  merchantId: string;
  userId: string;
  fileName: string;
  bytes: Uint8Array;
  mapping?: ColumnMapping | null;
  now?: Date;
}): Promise<ImportResult> {
  if (input.bytes.length === 0) throw new DepositError('빈 파일입니다.');
  if (input.bytes.length > DEPOSIT_FILE_MAX_BYTES) throw new DepositError('파일은 2MB 이하로 올려 주세요. 기간을 나눠 내려받으면 됩니다.');
  let table: ReturnType<typeof readStatementTable>;
  try {
    table = readStatementTable(input.bytes, input.fileName);
  } catch (e) {
    if (e instanceof StatementFileError) throw new DepositError(e.message);
    throw e;
  }
  const mapping = input.mapping ?? detectColumns(table.rows);
  if (!mapping) {
    const headerRow = guessHeaderRow(table.rows);
    return {
      status: 'NEEDS_MAPPING',
      headerRow,
      headers: table.rows[headerRow] ?? [],
      sample: table.rows.slice(headerRow + 1, headerRow + 4),
      encoding: table.encoding,
    };
  }
  const parsed = parseStatementRows(table.rows, mapping);
  if (parsed.tooMany) throw new DepositError(`입금 행이 ${DEPOSIT_MAX_ROWS.toLocaleString('ko-KR')}건을 넘습니다. 기간을 나눠 올려 주세요.`);
  if (parsed.deposits.length === 0) {
    throw new DepositError(parsed.errors.length ? `읽을 수 있는 입금 행이 없습니다(오류 ${parsed.errors.length}행 — 예: ${parsed.errors[0]!.line}번째 줄 ${parsed.errors[0]!.reason}).` : '입금 행이 없습니다(출금만 있거나 빈 파일).');
  }
  const format = input.mapping ? '열 직접 지정' : formatLabel(table.rows[mapping.header] ?? []);
  const fileHash = sha256(Buffer.from(input.bytes).toString('base64'));
  const importId = newId();

  // 같은 줄 순번(파일 안에서 다섯 값이 모두 같은 입금)
  const seen = new Map<string, number>();
  const rows = parsed.deposits.map((d) => {
    const base = `${d.occurredAt.toISOString()}|${d.amount}|${d.key}|${d.balance ?? ''}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    return { d, txHash: depositHash(input.merchantId, d, ordinal) };
  });

  try {
    await prisma.$transaction(async (tx) => {
      await tx.bankStatementImport.create({
        data: {
          id: importId,
          merchantId: input.merchantId,
          fileName: input.fileName.slice(0, 120) || 'statement.csv',
          fileHash,
          format,
          encoding: table.encoding,
          rowCount: parsed.deposits.length,
          skippedCount: parsed.skipped,
          errorCount: parsed.errors.length,
          periodFrom: parsed.periodFrom,
          periodTo: parsed.periodTo,
          createdBy: input.userId,
        },
      });
      await tx.bankDeposit.createMany({
        data: rows.map(({ d, txHash }) => ({
          id: newId(),
          merchantId: input.merchantId,
          importId,
          occurredAt: d.occurredAt,
          depositorName: d.name,
          depositorKey: d.key,
          amount: d.amount,
          memo: d.memo,
          balance: d.balance,
          txHash,
        })),
        skipDuplicates: true,
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') throw new DepositError('이미 올린 파일입니다. 같은 파일은 한 번만 올릴 수 있습니다.');
    throw e;
  }

  const fresh = await prisma.bankDeposit.findMany({ where: { importId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const result = await matchDeposits(input.merchantId, fresh, { userId: 'SYSTEM', batchId: importId, now: input.now });
  const counts = {
    newCount: fresh.length,
    duplicateCount: parsed.deposits.length - fresh.length,
    autoMatchedCount: result.autoMatched,
    suggestedCount: result.suggested,
    unmatchedCount: result.unmatched,
  };
  await prisma.bankStatementImport.update({ where: { id: importId }, data: counts });
  await audit({
    actorUserId: input.userId,
    action: 'OFFLINE_DEPOSIT_IMPORT',
    targetType: 'BankStatementImport',
    targetId: importId,
    after: { fileName: input.fileName.slice(0, 120), format, encoding: table.encoding, rows: parsed.deposits.length, ...counts },
  });
  return {
    status: 'DONE',
    importId,
    format,
    encoding: table.encoding,
    rowCount: parsed.deposits.length,
    newCount: counts.newCount,
    duplicateCount: counts.duplicateCount,
    skippedCount: parsed.skipped,
    errors: parsed.errors.slice(0, 20),
    autoMatched: result.autoMatched,
    suggested: result.suggested,
    unmatched: result.unmatched,
    duplicateWarnings: result.duplicateWarnings,
  };
}

type DepositRow = Awaited<ReturnType<typeof prisma.bankDeposit.findMany>>[number];

/** 새 입금들을 분류하고, 자동 확정 대상은 확정한다(시간순 — 앞의 확정이 뒤의 이력이 된다). */
async function matchDeposits(merchantId: string, deposits: DepositRow[], opts: { userId: string; batchId: string; now?: Date }) {
  const ctx = await loadMatchContext(merchantId);
  const out = { autoMatched: 0, suggested: 0, unmatched: 0, duplicateWarnings: 0 };
  if (deposits.length === 0) return out;

  // 같은 날(KST)·같은 사람·같은 금액 — 이번 파일 안 + 이미 있는 입금
  const dayKey = (d: { occurredAt: Date; depositorKey: string; amount: bigint }) => `${kstDateKey(d.occurredAt)}|${d.depositorKey}|${d.amount}`;
  const minAt = deposits[0]!.occurredAt;
  const maxAt = deposits[deposits.length - 1]!.occurredAt;
  const existing = await prisma.bankDeposit.findMany({
    where: { merchantId, id: { notIn: deposits.map((d) => d.id) }, occurredAt: { gte: new Date(minAt.getTime() - 86_400_000), lte: new Date(maxAt.getTime() + 86_400_000) } },
    select: { id: true, occurredAt: true, depositorKey: true, amount: true },
  });
  const dayCount = new Map<string, number>();
  for (const d of [...existing, ...deposits]) if (d.depositorKey) dayCount.set(dayKey(d), (dayCount.get(dayKey(d)) ?? 0) + 1);
  const warnedExisting = existing.filter((d) => d.depositorKey && (dayCount.get(dayKey(d)) ?? 0) > 1).map((d) => d.id);
  if (warnedExisting.length) await prisma.bankDeposit.updateMany({ where: { id: { in: warnedExisting } }, data: { duplicateWarning: true } });

  const autoTargets: Array<{ dep: DepositRow; cls: Classification }> = [];
  for (const dep of deposits) {
    const duplicateWarning = Boolean(dep.depositorKey) && (dayCount.get(dayKey(dep)) ?? 0) > 1;
    if (duplicateWarning) out.duplicateWarnings += 1;
    const cls = classifyDeposit({ key: dep.depositorKey, amount: dep.amount, duplicateWarning }, ctx);
    if (cls.status === 'MATCHED') {
      // 자동 확정은 아래에서 한 건씩(조건부). 이번 파일의 앞선 확정을 뒤의 이력으로 센다.
      const m = ctx.history.get(cls.payerId!) ?? new Map<string, number>();
      m.set(dep.amount.toString(), (m.get(dep.amount.toString()) ?? 0) + 1);
      ctx.history.set(cls.payerId!, m);
      autoTargets.push({ dep, cls });
    }
    await prisma.bankDeposit.updateMany({
      where: { id: dep.id, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: cls.status === 'MATCHED' ? 'SUGGESTED' : cls.status,
        candidates: cls.candidates as unknown as Prisma.InputJsonValue,
        duplicateWarning,
      },
    });
    if (cls.status === 'SUGGESTED') out.suggested += 1;
    if (cls.status === 'UNMATCHED') out.unmatched += 1;
  }
  for (const { dep, cls } of autoTargets) {
    const r = await confirmOne({
      merchantId,
      depositId: dep.id,
      payerId: cls.payerId!,
      pledgeId: cls.pledgeId ?? null,
      campaignId: cls.campaignId ?? null,
      userId: opts.userId,
      auto: true,
      batchId: opts.batchId,
      batchCount: autoTargets.length,
    });
    if (r) out.autoMatched += 1;
    else out.suggested += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 확정 · 무시 · 되돌리기
// ---------------------------------------------------------------------------

/** 한 건 확정(조건부). 이미 처리된 입금이면 null. */
async function confirmOne(input: {
  merchantId: string;
  depositId: string;
  payerId: string;
  pledgeId?: string | null;
  campaignId?: string | null;
  userId: string;
  auto: boolean;
  batchId: string;
  batchCount: number;
}): Promise<{ offlineDonationId: string } | null> {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const dep = await tx.bankDeposit.findFirst({ where: { id: input.depositId, merchantId: input.merchantId } });
    if (!dep) return null;
    const claimed = await tx.bankDeposit.updateMany({
      where: { id: dep.id, merchantId: input.merchantId, status: { in: [...ACTIVE_STATUSES] } },
      data: {
        status: 'MATCHED',
        payerId: input.payerId,
        pledgeId: input.pledgeId ?? null,
        autoMatched: input.auto,
        confirmedBy: input.userId,
        confirmedAt: now,
      },
    });
    if (claimed.count !== 1) return null;
    const id = newId();
    await tx.offlineDonation.create({
      data: {
        id,
        merchantId: input.merchantId,
        payerId: input.payerId,
        depositId: dep.id,
        source: 'BANK_FILE',
        amount: dep.amount,
        donatedAt: dep.occurredAt,
        campaignId: input.campaignId ?? null,
        pledgeId: input.pledgeId ?? null,
        autoMatched: input.auto,
        createdBy: input.userId,
      },
    });
    await emitDomainEvent(
      {
        merchantId: input.merchantId,
        type: 'offline.received',
        subjectType: 'offline_donation',
        subjectId: id,
        payerId: input.payerId,
        dedupeKey: `offline.received:${dep.id}`,
        payload: {
          amount: dep.amount,
          depositId: dep.id,
          source: 'BANK_FILE',
          autoMatched: input.auto,
          campaignId: input.campaignId ?? null,
          batchId: input.batchId,
          batchCount: input.batchCount,
          recurring: false,
        },
      },
      tx,
    );
    return { offlineDonationId: id };
  });
}

/** 기관 명단(후원자 계정 없음) 후보를 후원자 계정과 잇는다. 같은 번호의 후원자가 있으면 그 사람이다. */
async function payerForContact(merchantId: string, contactId: string): Promise<string> {
  const c = await prisma.supporterContact.findFirst({ where: { id: contactId, merchantId }, select: { id: true, phoneEnc: true, payerId: true } });
  if (!c) throw new DepositError('명단 행을 찾을 수 없습니다.');
  if (c.payerId) return c.payerId;
  const payer = await getOrCreatePayer(decrypt(c.phoneEnc));
  await prisma.supporterContact.updateMany({ where: { id: c.id, payerId: null }, data: { payerId: payer.id } });
  return payer.id;
}

async function getOrCreatePayer(phone: string) {
  const ph = phoneHash(phone);
  const existing = await prisma.payerProfile.findUnique({ where: { phoneHash: ph }, select: { id: true, mergedIntoId: true } });
  if (existing) return { id: existing.mergedIntoId ?? existing.id };
  try {
    // 표시 이름은 비워 둔다(기관이 적은 이름은 기관 명단에만 둔다 — 다른 기관 화면에 퍼지지 않게).
    const p = await prisma.payerProfile.create({ data: { id: newId(), phoneHash: ph, phoneEnc: encrypt(normalizePhone(phone)), phoneMasked: maskPhone(phone) }, select: { id: true } });
    return p;
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    return prisma.payerProfile.findUniqueOrThrow({ where: { phoneHash: ph }, select: { id: true } });
  }
}

export interface ConfirmItem {
  depositId: string;
  /** 입금 행의 후보 키(p:… / c:…). 비우면 첫 후보 */
  candidateKey?: string | null;
}

/**
 * 확인 필요 목록에서 한 번에 확정. 후보는 그 입금 행에 저장된 후보 중에서만 고른다(다른 기관 후원자를 넣을 수 없게).
 * 이미 처리된 행은 건너뛴다(동시 클릭·두 번 제출 안전).
 */
export async function confirmDeposits(merchantId: string, userId: string, items: ConfirmItem[], opts: { campaignId?: string | null } = {}) {
  if (items.length === 0) throw new DepositError('확정할 입금을 골라 주세요.');
  if (items.length > 200) throw new DepositError('한 번에 200건까지 확정할 수 있습니다.');
  const campaignId = await validCampaign(merchantId, opts.campaignId);
  const batchId = newId();
  const out = { confirmed: 0, skipped: 0, reasons: [] as string[] };
  const deposits = await prisma.bankDeposit.findMany({ where: { merchantId, id: { in: items.map((i) => i.depositId) } } });
  const byId = new Map(deposits.map((d) => [d.id, d]));
  for (const item of items) {
    const dep = byId.get(item.depositId);
    if (!dep || !(ACTIVE_STATUSES as readonly string[]).includes(dep.status)) {
      out.skipped += 1;
      continue;
    }
    const cands = (dep.candidates as unknown as DepositCandidate[]) ?? [];
    const cand = item.candidateKey ? cands.find((c) => c.key === item.candidateKey) : cands[0];
    if (!cand) {
      out.skipped += 1;
      out.reasons.push(`${dep.depositorName}: 고를 후원자 후보가 없음`);
      continue;
    }
    const payerId = cand.payerId ?? (await payerForContact(merchantId, cand.contactId!));
    const r = await confirmOne({ merchantId, depositId: dep.id, payerId, campaignId, userId, auto: false, batchId, batchCount: items.length });
    if (r) out.confirmed += 1;
    else out.skipped += 1;
  }
  if (out.confirmed) {
    await audit({ actorUserId: userId, action: 'OFFLINE_DEPOSIT_CONFIRM', targetType: 'merchant', targetId: merchantId, after: { batchId, confirmed: out.confirmed, skipped: out.skipped, depositIds: items.map((i) => i.depositId).slice(0, 200) } });
  }
  return out;
}

/** 모르는 입금 → 후원자로 연결(이름·연락처). 같은 번호의 후원자가 있으면 그 사람으로, 없으면 새로 만든다. 기관 명단에도 남긴다. */
export async function confirmDepositAsNewDonor(merchantId: string, userId: string, depositId: string, input: { name: string; phone: string; campaignId?: string | null }) {
  const name = input.name.trim().slice(0, 30);
  const phone = normalizePhone(input.phone);
  if (name.length < 1) throw new DepositError('이름을 적어 주세요.');
  if (!/^01\d{8,9}$/.test(phone)) throw new DepositError('휴대폰 번호를 정확히 적어 주세요.');
  const dep = await prisma.bankDeposit.findFirst({ where: { id: depositId, merchantId }, select: { id: true, status: true } });
  if (!dep) throw new DepositError('입금을 찾을 수 없습니다.');
  if (!(ACTIVE_STATUSES as readonly string[]).includes(dep.status)) throw new DepositError('이미 처리된 입금입니다.');
  const campaignId = await validCampaign(merchantId, input.campaignId);
  const payer = await getOrCreatePayer(phone);
  await upsertDonorContact(merchantId, payer.id, name, phone);
  const r = await confirmOne({ merchantId, depositId, payerId: payer.id, campaignId, userId, auto: false, batchId: newId(), batchCount: 1 });
  if (!r) throw new DepositError('이미 처리된 입금입니다.');
  await audit({ actorUserId: userId, action: 'OFFLINE_DEPOSIT_CONFIRM', targetType: 'BankDeposit', targetId: depositId, after: { newDonor: true, phoneMasked: maskPhone(phone) } });
  return r;
}

async function upsertDonorContact(merchantId: string, payerId: string, name: string, phone: string) {
  const ph = phoneHash(phone);
  await prisma.supporterContact.createMany({
    data: [{ id: newId(), merchantId, name, phoneHash: ph, phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), role: 'DONOR', tags: ['계좌이체'], note: '입금 맞추기에서 등록', payerId }],
    skipDuplicates: true,
  });
  await prisma.supporterContact.updateMany({ where: { merchantId, phoneHash: ph, payerId: null }, data: { payerId } });
}

async function validCampaign(merchantId: string, campaignId?: string | null) {
  if (!campaignId) return null;
  const c = await prisma.campaign.findFirst({ where: { id: campaignId, merchantId }, select: { id: true } });
  if (!c) throw new DepositError('캠페인을 찾을 수 없습니다.');
  return c.id;
}

/** 후원 아님(무시). 확인 필요·모름 상태에서만. */
export async function ignoreDeposits(merchantId: string, userId: string, depositIds: string[]) {
  if (depositIds.length === 0) throw new DepositError('무시할 입금을 골라 주세요.');
  const r = await prisma.bankDeposit.updateMany({
    where: { merchantId, id: { in: depositIds.slice(0, 200) }, status: { in: [...ACTIVE_STATUSES] } },
    data: { status: 'IGNORED', ignoredBy: userId, ignoredAt: new Date() },
  });
  if (r.count) await audit({ actorUserId: userId, action: 'OFFLINE_DEPOSIT_IGNORE', targetType: 'merchant', targetId: merchantId, after: { count: r.count, depositIds: depositIds.slice(0, 200) } });
  return r.count;
}

/** 무시 취소 → 다시 맞춰 본다(자동 확정은 하지 않고 확인 필요/모름으로만). */
export async function unignoreDeposit(merchantId: string, userId: string, depositId: string) {
  const dep = await prisma.bankDeposit.findFirst({ where: { id: depositId, merchantId, status: 'IGNORED' } });
  if (!dep) throw new DepositError('무시한 입금이 아닙니다.');
  const ctx = await loadMatchContext(merchantId);
  const cls = classifyDeposit({ key: dep.depositorKey, amount: dep.amount, duplicateWarning: true }, ctx);
  const r = await prisma.bankDeposit.updateMany({
    where: { id: dep.id, status: 'IGNORED' },
    data: { status: cls.candidates.length ? 'SUGGESTED' : 'UNMATCHED', candidates: cls.candidates as unknown as Prisma.InputJsonValue, ignoredBy: null, ignoredAt: null },
  });
  if (r.count) await audit({ actorUserId: userId, action: 'OFFLINE_DEPOSIT_UNIGNORE', targetType: 'BankDeposit', targetId: dep.id });
  return r.count === 1;
}

/**
 * 확정 취소(되돌리기). 기록은 REVERTED 로 남기고 입금은 다시 확인 필요/모름으로 돌린다.
 * 이미 발급된 영수증에 묶인 건이면 영수증을 자동 무효화하지 않고 `receiptCorrection` 으로 알린다(담당자 확인 — 영수증 화면 "정정 필요").
 */
export async function revertOfflineDonation(merchantId: string, userId: string, offlineDonationId: string, reason: string) {
  const why = reason.trim().slice(0, 200);
  if (why.length < 2) throw new DepositError('되돌리는 이유를 적어 주세요.');
  const now = new Date();
  const result = await prisma.$transaction(async (tx) => {
    const od = await tx.offlineDonation.findFirst({ where: { id: offlineDonationId, merchantId } });
    if (!od) throw new DepositError('계좌이체 후원 기록을 찾을 수 없습니다.');
    const r = await tx.offlineDonation.updateMany({
      where: { id: od.id, status: 'CONFIRMED' },
      data: { status: 'REVERTED', revertedAt: now, revertedBy: userId, revertReason: why },
    });
    if (r.count !== 1) throw new DepositError('이미 되돌린 기록입니다.');
    if (od.depositId) {
      const dep = await tx.bankDeposit.findUnique({ where: { id: od.depositId }, select: { candidates: true } });
      const hasCands = Array.isArray(dep?.candidates) && (dep!.candidates as unknown[]).length > 0;
      await tx.bankDeposit.updateMany({
        where: { id: od.depositId, status: 'MATCHED' },
        data: { status: hasCands ? 'SUGGESTED' : 'UNMATCHED', payerId: null, pledgeId: null, autoMatched: false, confirmedBy: null, confirmedAt: null },
      });
    }
    await emitDomainEvent(
      {
        merchantId,
        type: 'offline.reverted',
        subjectType: 'offline_donation',
        subjectId: od.id,
        payerId: od.payerId,
        dedupeKey: `offline.reverted:${od.id}`,
        payload: { amount: od.amount, depositId: od.depositId, receiptId: od.receiptId },
      },
      tx,
    );
    const receipt = od.receiptId ? await tx.donationReceipt.findUnique({ where: { id: od.receiptId }, select: { status: true, receiptNo: true } }) : null;
    return { receiptCorrection: receipt?.status === 'ISSUED' ? receipt.receiptNo : null };
  });
  await audit({ actorUserId: userId, action: 'OFFLINE_DONATION_REVERT', targetType: 'OfflineDonation', targetId: offlineDonationId, after: { reason: why, receiptCorrection: result.receiptCorrection } });
  return result;
}

/** 직접 입력(출처 MANUAL) — 파일 없이 담당자가 기록. 그 기관과 관계가 있는 후원자만. */
export async function recordManualOfflineDonation(merchantId: string, userId: string, input: { payerId: string; amount: bigint; donatedAt: Date; campaignId?: string | null }) {
  if (input.amount <= 0n || input.amount > 1_000_000_000n) throw new DepositError('금액을 확인해 주세요.');
  const ctx = await loadMatchContext(merchantId);
  if (!ctx.candidates.has(`p:${input.payerId}`)) throw new DepositError('이 기관과 관계가 있는 후원자가 아닙니다.');
  const campaignId = await validCampaign(merchantId, input.campaignId);
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.offlineDonation.create({
      data: { id, merchantId, payerId: input.payerId, source: 'MANUAL', amount: input.amount, donatedAt: input.donatedAt, campaignId, createdBy: userId },
    });
    await emitDomainEvent(
      {
        merchantId,
        type: 'offline.received',
        subjectType: 'offline_donation',
        subjectId: id,
        payerId: input.payerId,
        dedupeKey: `offline.received:manual:${id}`,
        payload: { amount: input.amount, depositId: null, source: 'MANUAL', autoMatched: false, campaignId, batchId: id, batchCount: 1, recurring: false },
      },
      tx,
    );
  });
  await audit({ actorUserId: userId, action: 'OFFLINE_DONATION_MANUAL', targetType: 'OfflineDonation', targetId: id, after: { amount: input.amount.toString() } });
  return { id };
}

// ---------------------------------------------------------------------------
// 계좌이체 약정 (오프라인 약정 표시 — 출금·결제를 만들지 않는다)
// ---------------------------------------------------------------------------

export async function saveOfflinePledge(
  merchantId: string,
  userId: string,
  input: { payerId?: string | null; name?: string; phone?: string; amount: bigint; dayOfMonth: number; campaignId?: string | null; memo?: string | null },
) {
  if (input.amount < 1000n || input.amount > 100_000_000n) throw new DepositError('약정 금액은 1,000원 ~ 1억 원 사이로 적어 주세요.');
  if (!Number.isInteger(input.dayOfMonth) || input.dayOfMonth < 1 || input.dayOfMonth > 31) throw new DepositError('입금일은 1~31일 중에서 골라 주세요.');
  const campaignId = await validCampaign(merchantId, input.campaignId);
  let payerId = input.payerId ?? null;
  if (payerId) {
    const ctx = await loadMatchContext(merchantId);
    if (!ctx.candidates.has(`p:${payerId}`)) throw new DepositError('이 기관과 관계가 있는 후원자가 아닙니다.');
  } else {
    const phone = normalizePhone(input.phone ?? '');
    const name = (input.name ?? '').trim().slice(0, 30);
    if (!name || !/^01\d{8,9}$/.test(phone)) throw new DepositError('후원자를 고르거나 이름·휴대폰 번호를 적어 주세요.');
    payerId = (await getOrCreatePayer(phone)).id;
    await upsertDonorContact(merchantId, payerId, name, phone);
  }
  const data = { amount: input.amount, dayOfMonth: input.dayOfMonth, campaignId, memo: input.memo?.trim().slice(0, 100) || null };
  const live = await prisma.offlinePledge.findFirst({ where: { merchantId, payerId, archivedAt: null }, select: { id: true } });
  let id: string;
  if (live) {
    await prisma.offlinePledge.update({ where: { id: live.id }, data });
    id = live.id;
  } else {
    id = newId();
    try {
      await prisma.offlinePledge.create({ data: { id, merchantId, payerId, createdBy: userId, ...data } });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      throw new DepositError('이미 등록된 약정이 있습니다. 화면을 새로 고쳐 주세요.');
    }
  }
  await audit({ actorUserId: userId, action: 'OFFLINE_PLEDGE_SAVE', targetType: 'OfflinePledge', targetId: id, after: { amount: input.amount.toString(), dayOfMonth: input.dayOfMonth } });
  return { id };
}

export async function archiveOfflinePledge(merchantId: string, userId: string, pledgeId: string) {
  const r = await prisma.offlinePledge.updateMany({ where: { id: pledgeId, merchantId, archivedAt: null }, data: { archivedAt: new Date() } });
  if (r.count !== 1) throw new DepositError('보관할 약정을 찾을 수 없습니다.');
  await audit({ actorUserId: userId, action: 'OFFLINE_PLEDGE_ARCHIVE', targetType: 'OfflinePledge', targetId: pledgeId });
}

/** 입금 확인 유예(약정일 + 3일)가 지나도 이번 달(KST) 확정 입금이 없는 약정 = 미입금 */
export const PLEDGE_GRACE_DAYS = 3;

export async function pledgeStatusThisMonth(merchantId: string, now = new Date()) {
  const pledges = await prisma.offlinePledge.findMany({
    where: { merchantId, archivedAt: null },
    include: { payer: { select: { displayName: true, phoneMasked: true } } },
    orderBy: { dayOfMonth: 'asc' },
  });
  if (pledges.length === 0) return [];
  const monthStart = kstStartOfMonth(now);
  const [received, contacts] = await Promise.all([
    prisma.offlineDonation.groupBy({
      by: ['payerId'],
      where: { merchantId, status: 'CONFIRMED', donatedAt: { gte: monthStart }, payerId: { in: pledges.map((p) => p.payerId) } },
      _sum: { amount: true },
    }),
    prisma.supporterContact.findMany({ where: { merchantId, payerId: { in: pledges.map((p) => p.payerId) } }, select: { payerId: true, name: true } }),
  ]);
  const got = new Map(received.map((r) => [r.payerId, r._sum.amount ?? 0n]));
  const nameOf = new Map(contacts.map((c) => [c.payerId!, c.name]));
  const today = Number(kstDateKey(now).slice(8, 10));
  const [y, m] = kstMonthKey(now).split('-').map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return pledges.map((p) => {
    const due = Math.min(p.dayOfMonth, lastDay);
    const amount = got.get(p.payerId) ?? 0n;
    const status = amount > 0n ? 'RECEIVED' : today > due + PLEDGE_GRACE_DAYS || (due + PLEDGE_GRACE_DAYS > lastDay && today === lastDay) ? 'MISSING' : 'NOT_YET';
    return {
      id: p.id,
      payerId: p.payerId,
      name: nameOf.get(p.payerId) || p.payer.displayName || '후원자',
      phoneMasked: p.payer.phoneMasked,
      amount: p.amount,
      dayOfMonth: p.dayOfMonth,
      receivedAmount: amount,
      status: status as 'RECEIVED' | 'MISSING' | 'NOT_YET',
    };
  });
}

// ---------------------------------------------------------------------------
// 조회 (화면)
// ---------------------------------------------------------------------------

export async function depositOverview(merchantId: string) {
  const [counts, pending, matched, ignored, imports, settings] = await Promise.all([
    prisma.bankDeposit.groupBy({ by: ['status'], where: { merchantId }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.bankDeposit.findMany({ where: { merchantId, status: { in: [...ACTIVE_STATUSES] } }, orderBy: [{ status: 'desc' }, { occurredAt: 'desc' }], take: 200 }),
    prisma.offlineDonation.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { payer: { select: { displayName: true, phoneMasked: true } }, deposit: { select: { depositorName: true, occurredAt: true } }, receipt: { select: { receiptNo: true, status: true } } },
    }),
    prisma.bankDeposit.findMany({ where: { merchantId, status: 'IGNORED' }, orderBy: { ignoredAt: 'desc' }, take: 20 }),
    prisma.bankStatementImport.findMany({ where: { merchantId }, orderBy: { createdAt: 'desc' }, take: 10 }),
    prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { receiptIncludeOffline: true } }),
  ]);
  const contacts = await prisma.supporterContact.findMany({ where: { merchantId, payerId: { in: matched.map((m) => m.payerId) } }, select: { payerId: true, name: true } });
  const nameOf = new Map(contacts.map((c) => [c.payerId!, c.name]));
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, { count: c._count._all, amount: c._sum.amount ?? 0n }])) as Partial<Record<string, { count: number; amount: bigint }>>;
  return {
    byStatus,
    pending: pending.map((d) => ({ ...d, candidates: (d.candidates as unknown as DepositCandidate[]) ?? [] })),
    matched: matched.map((m) => ({ ...m, donorName: nameOf.get(m.payerId) || m.payer.displayName || '후원자' })),
    ignored,
    imports,
    receiptIncludeOffline: settings?.receiptIncludeOffline ?? false,
  };
}

/** 이번 달(KST) 확정된 계좌이체 합계 — 대시보드에서 기브싸인 결제와 나눠 보여 준다(합치지 않는다). */
export async function offlineMonthTotal(merchantId: string, now = new Date()) {
  const a = await prisma.offlineDonation.aggregate({
    where: { merchantId, status: 'CONFIRMED', donatedAt: { gte: kstStartOfMonth(now) } },
    _sum: { amount: true },
    _count: { _all: true },
  });
  return { amount: a._sum.amount ?? 0n, count: a._count._all };
}

/** 후원자별 확정 계좌이체 누적(후원자 관리·통합 명단). 병합 정리는 부르는 쪽이 한다. */
export async function offlineTotalsByPayer(merchantId: string) {
  const g = await prisma.offlineDonation.groupBy({
    by: ['payerId'],
    where: { merchantId, status: 'CONFIRMED' },
    _sum: { amount: true },
    _count: { _all: true },
    _max: { donatedAt: true },
  });
  return new Map(g.map((r) => [r.payerId, { amount: r._sum.amount ?? 0n, count: r._count._all, last: r._max.donatedAt }]));
}

/**
 * 정정 필요 영수증: 발급(ISSUED)된 영수증에 묶인 계좌이체 후원이 나중에 확정 취소된 경우.
 * 자동으로 무효화하지 않는다 — 담당자가 확인해 무효(VOID) → 재발급한다(절대 규칙 9 그대로).
 */
export async function offlineReceiptCorrections(merchantId: string, taxYear?: number) {
  const rows = await prisma.offlineDonation.findMany({
    where: { merchantId, status: 'REVERTED', receiptId: { not: null }, receipt: { status: 'ISSUED', ...(taxYear ? { taxYear } : {}) } },
    select: { amount: true, receipt: { select: { id: true, receiptNo: true, totalAmount: true } } },
  });
  const byReceipt = new Map<string, { receiptId: string; receiptNo: string; totalAmount: bigint; revertedAmount: bigint }>();
  for (const r of rows) {
    const cur = byReceipt.get(r.receipt!.id) ?? { receiptId: r.receipt!.id, receiptNo: r.receipt!.receiptNo, totalAmount: r.receipt!.totalAmount, revertedAmount: 0n };
    cur.revertedAmount += r.amount;
    byReceipt.set(r.receipt!.id, cur);
  }
  return [...byReceipt.values()];
}

/** 영수증 합산 포함 설정(기본 끔). */
export async function setReceiptIncludeOffline(merchantId: string, userId: string, on: boolean) {
  const before = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: merchantId }, select: { receiptIncludeOffline: true } });
  if (before.receiptIncludeOffline === on) return;
  await prisma.merchantProfile.update({ where: { id: merchantId }, data: { receiptIncludeOffline: on } });
  await audit({ actorUserId: userId, action: 'RECEIPT_INCLUDE_OFFLINE_CHANGE', targetType: 'MerchantProfile', targetId: merchantId, after: { receiptIncludeOffline: on } });
}

// ---------------------------------------------------------------------------
// 승인 대기함 묶음 · 이벤트 소비자
// ---------------------------------------------------------------------------

/** 승인 대기함 "입금 확인 필요" 묶음(InboxExceptionGroup 형식). 없으면 null. */
export async function depositsInboxGroup(merchantId: string) {
  const [g, oldest] = await Promise.all([
    prisma.bankDeposit.groupBy({ by: ['status'], where: { merchantId, status: { in: [...ACTIVE_STATUSES] } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.bankDeposit.findFirst({ where: { merchantId, status: { in: [...ACTIVE_STATUSES] } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
  ]);
  const suggested = g.find((x) => x.status === 'SUGGESTED')?._count._all ?? 0;
  const unmatched = g.find((x) => x.status === 'UNMATCHED')?._count._all ?? 0;
  const total = suggested + unmatched;
  if (total === 0 || !oldest) return null;
  return {
    kind: 'OFFLINE_DEPOSIT_REVIEW',
    title: `입금 확인 필요 ${total}건`,
    reason: `통장 입금 중 후원자 확인이 필요한 건 ${suggested}건 · 맞는 후원자를 못 찾은 건 ${unmatched}건`,
    affectedCount: total,
    amount: g.reduce((s, x) => s + (x._sum.amount ?? 0n), 0n),
    oldestAt: oldest.createdAt,
    href: '/studio/deposits',
    recommendedAction: '입금 맞추기에서 후보를 골라 확정하거나, 후원이 아닌 입금은 무시로 표시하세요. 확정 전에는 후원자 기록·감사 안내가 생기지 않습니다.',
    actions: [],
    severity: 'normal' as const,
  };
}

/** 기관 알림. 한 번에 여러 건(같은 묶음 id)이면 알림 1건으로 묶는다. */
export async function handleOfflineAlert(ev: StoredDomainEvent) {
  const m = await prisma.merchantProfile.findUnique({ where: { id: ev.merchantId }, select: { userId: true } });
  if (!m) return 'SKIPPED' as const;
  const batchCount = Number(ev.payload.batchCount ?? 1);
  const batchId = typeof ev.payload.batchId === 'string' ? ev.payload.batchId : ev.id;
  if (batchCount > 1) {
    const fresh = await kv.setnx(`offline-alert:${batchId}`, ev.id, 7 * 86_400);
    if (!fresh) return 'SKIPPED' as const;
    try {
      await notifyUser({
        userId: m.userId,
        title: `계좌이체 후원 ${batchCount}건 확인`,
        body: ev.payload.autoMatched === true ? '통장 거래내역에서 자동으로 맞춘 입금입니다. 입금 맞추기에서 확인할 수 있습니다.' : '입금 맞추기에서 확정한 입금입니다.',
        linkUrl: '/studio/deposits',
      });
    } catch (e) {
      await kv.del(`offline-alert:${batchId}`).catch(() => undefined);
      throw e;
    }
    return;
  }
  const amount = (() => {
    try {
      return BigInt(String(ev.payload.amount ?? '0'));
    } catch {
      return 0n;
    }
  })();
  await notifyUser({
    userId: m.userId,
    title: `계좌이체 후원 확인 ${formatWon(amount)}`,
    body: ev.payload.autoMatched === true ? '통장 거래내역에서 자동으로 맞춘 입금입니다.' : '입금 맞추기에서 확정한 입금입니다.',
    linkUrl: '/studio/deposits',
  });
}

let registered = false;
export function registerOfflineDepositConsumers() {
  if (registered) return;
  registered = true;
  registerConsumer({ name: 'offline-alert', types: ['offline.received'], handle: handleOfflineAlert });
}

// ---------------------------------------------------------------------------
// 계좌 거래내역 자동 조회 경로(2026-11-13 5차 L3) — 파일과 **같은 정규화·중복 해시**
// ---------------------------------------------------------------------------

/** 자동 조회 줄을 은행 파일과 같은 표(줄×칸)로 바꿔 parseStatementRows 로 읽는다. 머리글 1줄 + 이 열 순서. */
export const BANK_FEED_MAPPING: ColumnMapping = { header: 0, date: 0, name: 1, memo: 2, amountIn: 3, amountOut: 4, balance: 5 };

/**
 * 공급자가 준 거래(표 형식)를 입금 대사 표로 넣는다. 파일 올리기와 같은 열 읽기(parseStatementRows)·같은 입금 해시(depositHash, 묶음 안 순번)·
 * 같은 맞추기(matchDeposits)를 탄다 — 같은 입금을 파일로 이미 넣었으면 건너뛴다. 같은 조회 결과를 두 번 넣지 않는다(feedKey 해시).
 */
export async function importBankFeedRows(input: { merchantId: string; provider: string; feedKey: string; rows: string[][]; now?: Date }) {
  const parsed = parseStatementRows(input.rows, BANK_FEED_MAPPING);
  if (parsed.deposits.length === 0) return { status: 'EMPTY' as const, newCount: 0, duplicateCount: 0, errors: parsed.errors.length };
  const importId = newId();
  const seen = new Map<string, number>();
  const rows = parsed.deposits.map((d) => {
    const base = `${d.occurredAt.toISOString()}|${d.amount}|${d.key}|${d.balance ?? ''}`;
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    return { d, txHash: depositHash(input.merchantId, d, ordinal) };
  });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.bankStatementImport.create({
        data: {
          id: importId, merchantId: input.merchantId, fileName: `계좌 자동 조회(${input.provider})`.slice(0, 120),
          fileHash: sha256(`bank-feed:${input.provider}:${input.feedKey}`), format: '계좌 자동 조회', encoding: 'feed',
          rowCount: parsed.deposits.length, skippedCount: parsed.skipped, errorCount: parsed.errors.length,
          periodFrom: parsed.periodFrom, periodTo: parsed.periodTo, createdBy: 'SYSTEM',
        },
      });
      await tx.bankDeposit.createMany({
        data: rows.map(({ d, txHash }) => ({
          id: newId(), merchantId: input.merchantId, importId, occurredAt: d.occurredAt, depositorName: d.name, depositorKey: d.key,
          amount: d.amount, memo: d.memo, balance: d.balance, txHash,
        })),
        skipDuplicates: true,
      });
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return { status: 'ALREADY' as const, newCount: 0, duplicateCount: parsed.deposits.length, errors: parsed.errors.length };
    throw e;
  }
  const fresh = await prisma.bankDeposit.findMany({ where: { importId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const result = await matchDeposits(input.merchantId, fresh, { userId: 'SYSTEM', batchId: importId, now: input.now });
  const counts = { newCount: fresh.length, duplicateCount: parsed.deposits.length - fresh.length, autoMatchedCount: result.autoMatched, suggestedCount: result.suggested, unmatchedCount: result.unmatched };
  await prisma.bankStatementImport.update({ where: { id: importId }, data: counts });
  return { status: 'DONE' as const, importId, newCount: counts.newCount, duplicateCount: counts.duplicateCount, errors: parsed.errors.length, autoMatched: result.autoMatched };
}
