import { beforeEach, describe, expect, it, vi } from 'vitest';

// 감사로그(writeAudit)는 요청 헤더를 읽는다. 테스트에서는 빈 요청으로 대체한다.
vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { encrypt, maskPhone, phoneHash } from '@/lib/crypto';
import { resetDb, seedBasics, seedRegisteredPayer, moPayload, inboundAndPay, type Fixture } from './helpers';
import {
  depositorKey,
  detectColumns,
  maskLongDigits,
  parseKstDateTime,
  parseStatementRows,
  parseWon,
  type ColumnMapping,
} from '@/lib/bank-statement';
import {
  DepositError,
  classifyDeposit,
  confirmDepositAsNewDonor,
  confirmDeposits,
  depositOverview,
  depositsInboxGroup,
  ignoreDeposits,
  importBankStatement,
  loadMatchContext,
  offlineMonthTotal,
  offlineReceiptCorrections,
  pledgeStatusThisMonth,
  recordManualOfflineDonation,
  revertOfflineDonation,
  saveOfflinePledge,
  setReceiptIncludeOffline,
  unignoreDeposit,
} from '@/server/services/deposits';
import { readStatementTable } from '@/server/services/bank-statement-file';
import {
  buildHometaxExport,
  issueReceipt,
  payerReceiptOverview,
  receiptCandidates,
  reissueReceipt,
  upsertReceiptProfile,
  voidReceipt,
} from '@/server/services/receipts';
import { processDomainEvents } from '@/server/services/events';
import { registerDefaultConsumers } from '@/server/services/event-consumers';
import { saveJourneySetting } from '@/server/services/journeys/engine';
import { loadInboxGroups, resetInboxGroupProviders } from '@/server/services/inbox-groups';
import { listSupporters } from '@/server/services/supporters';

/**
 * 2026-11-09 과제 E — 입금 자동 대사(기관 통장 거래내역 파일).
 * 형식 인식(은행 3종 + XLSX)·CP949·같은 파일/같은 입금 중복·자동 확정 조건·제안·확정·되돌리기·영수증 끔/켬·이벤트 1회.
 */

let fx: Fixture;
const fixture = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', name)));
const KB = 'bank-kb-2026-11-09.csv';
const SHINHAN = 'bank-shinhan-cp949-2026-11-09.csv';
const WOORI = 'bank-woori-2026-11-09.csv';
const HANA = 'bank-hana-2026-11-09.xlsx';

/** 저장된 입금 행(해시 제외)을 글자로 — 계좌번호 원문이 남았는지 본다 */
const dump = (rows: Array<{ txHash: string }>) =>
  JSON.stringify(rows.map(({ txHash: _h, ...r }) => r), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

async function importFile(name: string, mapping?: ColumnMapping) {
  return importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: name, bytes: fixture(name), mapping });
}

async function importCsv(csv: string, fileName = 'test.csv') {
  return importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName, bytes: new TextEncoder().encode(csv) });
}

/** 기관과 관계가 있는 후원자(기관 명단에 이름으로 연결) */
async function relatedPayer(phone: string, name: string) {
  const payer = await seedRegisteredPayer(phone);
  await prisma.supporterContact.create({
    data: { id: newId(), merchantId: fx.merchantId, name, phoneHash: phoneHash(phone), phoneEnc: encrypt(phone), phoneMasked: maskPhone(phone), role: 'DONOR', payerId: payer.id },
  });
  return payer;
}

async function priorOffline(payerId: string, amount: bigint, times: number) {
  for (let i = 0; i < times; i++) {
    await prisma.offlineDonation.create({
      data: { id: newId(), merchantId: fx.merchantId, payerId, source: 'MANUAL', amount, donatedAt: new Date(Date.UTC(2026, 6 + i, 5)), createdBy: 'test' },
    });
  }
}

beforeEach(async () => {
  await resetDb();
  resetInboxGroupProviders();
  fx = await seedBasics({ paymentMode: 'CONFIRM_LINK' });
  registerDefaultConsumers();
});

describe('파일 읽기·형식 인식', () => {
  it('값 읽기: 금액·날짜·이름 키·긴 숫자 가리기', () => {
    expect(parseWon('1,000,000')).toBe(1000000n);
    expect(parseWon('10000원')).toBe(10000n);
    expect(parseWon('')).toBe(0n);
    expect(parseWon('10000.50')).toBeNull();
    expect(parseKstDateTime('2026.10.05 09:12:33')?.at.toISOString()).toBe('2026-10-05T00:12:33.000Z');
    expect(parseKstDateTime('2026-10-05', '101500')?.at.toISOString()).toBe('2026-10-05T01:15:00.000Z');
    expect(parseKstDateTime('20261005')?.timeKnown).toBe(false);
    expect(parseKstDateTime('2026-02-30')).toBeNull();
    expect(depositorKey('(주)행복 상사')).toBe('행복상사');
    expect(depositorKey('홍길동(후원)')).toBe('홍길동');
    expect(depositorKey(' 홍 길동 ')).toBe('홍길동');
    expect(depositorKey('(홍길동)')).toBe('홍길동');
    expect(maskLongDigits('1002-123-456789 이몽룡')).toBe('***6789 이몽룡');
  });

  it('국민은행 형식: 위쪽 계좌정보 줄을 건너뛰고 열을 인식, 출금·합계 줄은 버린다. 계좌번호는 남지 않는다', async () => {
    const r = await importFile(KB);
    expect(r.status).toBe('DONE');
    if (r.status !== 'DONE') return;
    expect(r.format).toBe('국민은행 형식');
    expect(r.encoding).toBe('utf-8');
    expect(r.rowCount).toBe(3);
    const rows = await prisma.bankDeposit.findMany({ where: { merchantId: fx.merchantId }, orderBy: { occurredAt: 'asc' } });
    expect(rows.map((d) => [d.depositorName, d.amount])).toEqual([
      ['홍길동', 30000n],
      ['김영희', 10000n],
      ['(주)행복상사', 100000n],
    ]);
    expect(rows[0]!.memo).toBe('타행이체');
    expect(rows[2]!.depositorKey).toBe('행복상사');
    expect(dump(rows)).not.toContain('123456-01-234567');
    const imp = await prisma.bankStatementImport.findFirstOrThrow({ where: { merchantId: fx.merchantId } });
    expect(imp.periodFrom?.toISOString()).toBe('2026-10-05T00:12:33.000Z');
    expect(imp.unmatchedCount).toBe(3);
  });

  it('신한은행 CP949: 인코딩을 자동 판별하고 거래일자+거래시간을 합쳐 읽는다', async () => {
    const table = readStatementTable(fixture(SHINHAN), SHINHAN);
    expect(table.encoding).toBe('cp949');
    const m = detectColumns(table.rows)!;
    expect(m).toMatchObject({ header: 0, date: 0, time: 1, amountOut: 3, amountIn: 4, name: 5, memo: 2, balance: 6 });
    const r = await importFile(SHINHAN);
    expect(r).toMatchObject({ status: 'DONE', encoding: 'cp949', rowCount: 2, format: '신한은행·통장 형식' });
    const names = (await prisma.bankDeposit.findMany({ where: { merchantId: fx.merchantId }, orderBy: { occurredAt: 'asc' } })).map((d) => d.depositorKey);
    expect(names).toEqual(['홍길동', '박철수']);
  });

  it('우리은행 형식: 같은 날 같은 사람·같은 금액 두 건은 둘 다 남기고 경고, 적요 속 계좌번호는 가린다', async () => {
    const r = await importFile(WOORI);
    expect(r).toMatchObject({ status: 'DONE', format: '우리은행 형식', rowCount: 3, newCount: 3, duplicateWarnings: 2 });
    const rows = await prisma.bankDeposit.findMany({ where: { merchantId: fx.merchantId }, orderBy: [{ occurredAt: 'asc' }, { balance: 'asc' }] });
    expect(rows.filter((d) => d.duplicateWarning)).toHaveLength(2);
    expect(rows[2]!.depositorName).toBe('***6789 이몽룡');
    expect(dump(rows)).not.toContain('456789');
  });

  it('XLSX(패키지 추가 없이): 공유 문자열·인라인 문자열·엑셀 날짜 일련번호를 읽는다', async () => {
    const r = await importFile(HANA);
    expect(r).toMatchObject({ status: 'DONE', encoding: 'xlsx', format: '하나은행 형식', rowCount: 2 });
    const rows = await prisma.bankDeposit.findMany({ where: { merchantId: fx.merchantId }, orderBy: { occurredAt: 'asc' } });
    expect(rows.map((d) => [d.depositorName, d.amount, d.occurredAt.toISOString()])).toEqual([
      ['홍길동', 25000n, '2026-10-05T00:30:00.000Z'],
      ['최&지우', 7000n, '2026-10-06T15:00:00.000Z'],
    ]);
  });

  it('모르는 열 이름이면 저장 없이 열 고르기를 돌려주고, 열을 지정하면 읽는다. .xls 는 CSV 로 저장하라고 안내', async () => {
    const csv = '날,돈들어옴,누가\n2026-10-01,5000,홍길동\n2026-10-02,7000,김영희\n';
    const r = await importCsv(csv, 'odd.csv');
    expect(r.status).toBe('NEEDS_MAPPING');
    if (r.status === 'NEEDS_MAPPING') expect(r.headers).toEqual(['날', '돈들어옴', '누가']);
    expect(await prisma.bankStatementImport.count()).toBe(0);
    const done = await importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'odd.csv', bytes: new TextEncoder().encode(csv), mapping: { header: 0, date: 0, amountIn: 1, name: 2 } });
    expect(done).toMatchObject({ status: 'DONE', format: '열 직접 지정', rowCount: 2 });
    await expect(importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'old.xls', bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3, 4, 5]) })).rejects.toThrow(/CSV/);
  });

  it('행 상한 5,000·파일 2MB', async () => {
    const lines = ['거래일시,입금액,입금자'];
    for (let i = 0; i < 5001; i++) lines.push(`2026-10-01 ${String(Math.floor(i / 3600) % 24).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')},1000,홍${i}`);
    await expect(importCsv(lines.join('\n'))).rejects.toThrow(/5,000/);
    await expect(importBankStatement({ merchantId: fx.merchantId, userId: fx.merchantUserId, fileName: 'big.csv', bytes: new Uint8Array(2 * 1024 * 1024 + 1) })).rejects.toThrow(/2MB/);
  });

  it('parseStatementRows: 출금 행·0원은 건너뛰고 날짜 오류는 줄 번호와 함께', () => {
    const rows = [['거래일시', '입금액', '출금액', '입금자'], ['2026-10-01', '1000', '0', '가'], ['2026-10-01', '0', '500', '나'], ['2026-13-01', '1000', '0', '다']];
    const p = parseStatementRows(rows, detectColumns(rows)!);
    expect(p.deposits).toHaveLength(1);
    expect(p.skipped).toBe(1);
    expect(p.errors).toEqual([{ line: 4, reason: '거래일시를 읽을 수 없음' }]);
  });
});

describe('중복 방지', () => {
  it('같은 파일은 두 번 올릴 수 없다', async () => {
    await importFile(KB);
    await expect(importFile(KB)).rejects.toBeInstanceOf(DepositError);
    expect(await prisma.bankDeposit.count()).toBe(3);
  });

  it('다른 파일에 같은 입금이 있으면 한 번만 넣는다(기관·거래일시·금액·입금자·잔액 해시)', async () => {
    await importFile(KB);
    const csv = '﻿거래일시,적요,보낸분/받는분,출금액(원),입금액(원),잔액(원)\n2026.10.05 09:12:33,타행이체,홍길동,0,"30,000","1,030,000"\n2026.10.20 09:00:00,타행이체,새사람,0,"5,000","1,095,000"\n';
    const r = await importCsv(csv, 'kb-later.csv');
    expect(r).toMatchObject({ status: 'DONE', rowCount: 2, newCount: 1, duplicateCount: 1 });
    expect(await prisma.bankDeposit.count()).toBe(4);
  });

  it('동시에 같은 파일을 두 번 올려도 한 번만 들어간다', async () => {
    const rs = await Promise.allSettled([importFile(KB), importFile(KB)]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.bankDeposit.count()).toBe(3);
  });
});

describe('자동 맞추기 규칙', () => {
  it('이름 일치 1명 + 같은 금액 확정 입금 2회 → 자동 확정, 이벤트 1회', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await priorOffline(payer.id, 30000n, 2);
    const r = await importFile(KB);
    expect(r).toMatchObject({ status: 'DONE', autoMatched: 1, suggested: 0, unmatched: 2 });
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    expect(dep).toMatchObject({ status: 'MATCHED', autoMatched: true, payerId: payer.id, confirmedBy: 'SYSTEM' });
    const od = await prisma.offlineDonation.findFirstOrThrow({ where: { depositId: dep.id } });
    expect(od).toMatchObject({ amount: 30000n, status: 'CONFIRMED', source: 'BANK_FILE', autoMatched: true });
    expect(await prisma.domainEvent.count({ where: { type: 'offline.received' } })).toBe(1);
    // 결제·정산 원장은 건드리지 않는다
    expect(await prisma.charge.count()).toBe(0);
    expect(await prisma.settlementLedger.count()).toBe(0);
  });

  it('이력 1회뿐이면 자동 확정하지 않고 제안', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await priorOffline(payer.id, 30000n, 1);
    await priorOffline(payer.id, 10000n, 3); // 다른 금액 이력은 근거가 아니다
    const r = await importFile(KB);
    expect(r).toMatchObject({ autoMatched: 0, suggested: 1 });
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    expect(dep.status).toBe('SUGGESTED');
    expect((dep.candidates as Array<{ payerId: string; reason: string }>)[0]).toMatchObject({ payerId: payer.id, reason: 'EXACT' });
  });

  it('같은 금액의 계좌이체 약정이 있으면 자동 확정(약정·캠페인 연결)', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    const camp = await prisma.campaign.create({ data: { id: newId(), merchantId: fx.merchantId, code: 'KIMJANG', title: '김장', summary: 's', goalAmount: 1000000n, startsOn: new Date('2026-01-01'), endsOn: new Date('2026-12-31') } });
    const pl = await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: payer.id, amount: 30000n, dayOfMonth: 5, campaignId: camp.id });
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    expect(dep).toMatchObject({ status: 'MATCHED', pledgeId: pl.id });
    expect(await prisma.offlineDonation.findFirstOrThrow({ where: { depositId: dep.id } })).toMatchObject({ pledgeId: pl.id, campaignId: camp.id });
    // 캠페인 모금액(결제 건 기준)은 바뀌지 않는다 — offline 은 charge 가 아니다
    expect(await prisma.charge.count({ where: { campaignId: camp.id } })).toBe(0);
  });

  it('이름이 같은 후원자가 여럿이면 제안(모두 후보), 같은 날 같은 금액 두 건은 이력이 있어도 자동 확정하지 않는다', async () => {
    const a = await relatedPayer('01022223333', '홍길동');
    const b = await relatedPayer('01044445555', '홍 길동');
    await priorOffline(a.id, 30000n, 2);
    const ctx = await loadMatchContext(fx.merchantId);
    const cls = classifyDeposit({ key: '홍길동', amount: 30000n }, ctx);
    expect(cls.status).toBe('SUGGESTED');
    expect(cls.candidates.map((c) => c.payerId).sort()).toEqual([a.id, b.id].sort());

    await prisma.supporterContact.deleteMany({ where: { payerId: b.id } });
    const ctx2 = await loadMatchContext(fx.merchantId);
    expect(classifyDeposit({ key: '홍길동', amount: 30000n }, ctx2).status).toBe('MATCHED');
    expect(classifyDeposit({ key: '홍길동', amount: 30000n, duplicateWarning: true }, ctx2).status).toBe('SUGGESTED');
    const r = await importFile(WOORI);
    expect(r).toMatchObject({ autoMatched: 0 });
    expect(await prisma.bankDeposit.count({ where: { depositorKey: '홍길동', status: 'SUGGESTED', duplicateWarning: true } })).toBe(2);
  });

  it('이름 앞 두 글자 + 알려진 금액이 같으면 제안(SIMILAR), 아무 후보도 없으면 모름', async () => {
    const payer = await relatedPayer('01022223333', '홍길순');
    await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: payer.id, amount: 30000n, dayOfMonth: 5 });
    const ctx = await loadMatchContext(fx.merchantId);
    const cls = classifyDeposit({ key: '홍길동', amount: 30000n }, ctx);
    expect(cls).toMatchObject({ status: 'SUGGESTED' });
    expect(cls.candidates[0]).toMatchObject({ payerId: payer.id, reason: 'SIMILAR' });
    expect(classifyDeposit({ key: '홍길동', amount: 31000n }, ctx).status).toBe('UNMATCHED');
    expect(classifyDeposit({ key: '이몽룡', amount: 30000n }, ctx).status).toBe('UNMATCHED');
  });

  it('후원자 계정 없는 기관 명단 이름도 후보가 되고, 확정하면 같은 번호의 후원자 계정과 잇는다', async () => {
    await prisma.supporterContact.create({
      data: { id: newId(), merchantId: fx.merchantId, name: '김영희', phoneHash: phoneHash('01077778888'), phoneEnc: encrypt('01077778888'), phoneMasked: maskPhone('01077778888'), role: 'DONOR' },
    });
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '김영희' } });
    expect(dep.status).toBe('SUGGESTED');
    const r = await confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: dep.id }]);
    expect(r.confirmed).toBe(1);
    const payer = await prisma.payerProfile.findUniqueOrThrow({ where: { phoneHash: phoneHash('01077778888') } });
    expect(payer.displayName).toBeNull();
    expect((await prisma.supporterContact.findFirstOrThrow({ where: { name: '김영희' } })).payerId).toBe(payer.id);
    expect((await prisma.bankDeposit.findUniqueOrThrow({ where: { id: dep.id } })).payerId).toBe(payer.id);
  });

  it('탈퇴한 후원자는 후보가 아니다', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await prisma.payerProfile.update({ where: { id: payer.id }, data: { onboardingStatus: 'WITHDRAWN' } });
    const ctx = await loadMatchContext(fx.merchantId);
    expect(classifyDeposit({ key: '홍길동', amount: 30000n }, ctx).status).toBe('UNMATCHED');
  });
});

describe('확정·무시·되돌리기', () => {
  it('확인 필요 목록에서 확정: 동시에 두 번 눌러도 기록·이벤트는 한 번', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    const [a, b] = await Promise.all([
      confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: dep.id, candidateKey: `p:${payer.id}` }]),
      confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: dep.id, candidateKey: `p:${payer.id}` }]),
    ]);
    expect(a.confirmed + b.confirmed).toBe(1);
    expect(await prisma.offlineDonation.count({ where: { depositId: dep.id } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'offline.received' } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: 'OFFLINE_DEPOSIT_CONFIRM' } })).toBe(1);
    expect(await prisma.adminAuditLog.count({ where: { action: 'OFFLINE_DEPOSIT_IMPORT' } })).toBe(1);
  });

  it('입금 행 후보에 없는 후원자는 고를 수 없다(다른 기관 후원자 주입 방지)', async () => {
    await relatedPayer('01022223333', '홍길동');
    const other = await seedRegisteredPayer('01099990000');
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    const r = await confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: dep.id, candidateKey: `p:${other.id}` }]);
    expect(r).toMatchObject({ confirmed: 0, skipped: 1 });
    expect(await prisma.offlineDonation.count()).toBe(0);
  });

  it('모르는 입금 → 이름·연락처로 후원자 연결(같은 번호의 후원자가 있으면 그 사람). 기관 명단에도 남는다', async () => {
    const existing = await seedRegisteredPayer('01055556666');
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '행복상사' } });
    expect(dep.status).toBe('UNMATCHED');
    await expect(confirmDepositAsNewDonor(fx.merchantId, fx.merchantUserId, dep.id, { name: '행복상사', phone: '0101' })).rejects.toThrow(/휴대폰/);
    await confirmDepositAsNewDonor(fx.merchantId, fx.merchantUserId, dep.id, { name: '행복상사', phone: '010-5555-6666' });
    expect(await prisma.offlineDonation.findFirstOrThrow({ where: { depositId: dep.id } })).toMatchObject({ payerId: existing.id });
    expect(await prisma.supporterContact.findFirstOrThrow({ where: { merchantId: fx.merchantId, payerId: existing.id } })).toMatchObject({ name: '행복상사', role: 'DONOR' });
    await expect(confirmDepositAsNewDonor(fx.merchantId, fx.merchantUserId, dep.id, { name: 'x', phone: '01055556666' })).rejects.toThrow(/이미 처리/);
  });

  it('무시 → 무시 취소하면 다시 확인 필요/모름으로(자동 확정은 하지 않음)', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    expect(await ignoreDeposits(fx.merchantId, fx.merchantUserId, [dep.id])).toBe(1);
    expect(await ignoreDeposits(fx.merchantId, fx.merchantUserId, [dep.id])).toBe(0);
    await priorOffline(payer.id, 30000n, 2);
    expect(await unignoreDeposit(fx.merchantId, fx.merchantUserId, dep.id)).toBe(true);
    expect((await prisma.bankDeposit.findUniqueOrThrow({ where: { id: dep.id } })).status).toBe('SUGGESTED');
  });

  it('되돌리기: 기록은 REVERTED 로 남고 입금은 다시 확인 필요, offline.reverted 1회, 진행 중 감사 저니 취소. 다시 확정해도 offline.received 는 다시 나지 않는다', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await saveJourneySetting(fx.merchantId, 'donation-thanks', { enabled: true, approvals: { 'thanks-letter': true }, params: { includeOffline: true } }, fx.merchantUserId);
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    await confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: dep.id }]);
    await processDomainEvents();
    const run = await prisma.journeyRun.findFirstOrThrow({ where: { merchantId: fx.merchantId, journeyKey: 'donation-thanks' } });
    expect(run.subjectType).toBe('offline_donation');
    expect(['AWAITING_APPROVAL', 'WAITING']).toContain(run.status);

    const od = await prisma.offlineDonation.findFirstOrThrow({ where: { depositId: dep.id } });
    await expect(revertOfflineDonation(fx.merchantId, fx.merchantUserId, od.id, '')).rejects.toThrow(/이유/);
    const rr = await revertOfflineDonation(fx.merchantId, fx.merchantUserId, od.id, '다른 후원자 입금');
    expect(rr.receiptCorrection).toBeNull();
    await expect(revertOfflineDonation(fx.merchantId, fx.merchantUserId, od.id, '두 번째')).rejects.toThrow(/이미/);
    expect(await prisma.offlineDonation.findUniqueOrThrow({ where: { id: od.id } })).toMatchObject({ status: 'REVERTED', revertReason: '다른 후원자 입금' });
    expect(await prisma.bankDeposit.findUniqueOrThrow({ where: { id: dep.id } })).toMatchObject({ status: 'SUGGESTED', payerId: null });
    await processDomainEvents();
    expect(await prisma.domainEvent.count({ where: { type: 'offline.reverted' } })).toBe(1);
    expect((await prisma.journeyRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('CANCELED');

    await confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: dep.id, candidateKey: `p:${payer.id}` }]);
    expect(await prisma.offlineDonation.count({ where: { depositId: dep.id } })).toBe(2);
    expect(await prisma.offlineDonation.count({ where: { depositId: dep.id, status: 'CONFIRMED' } })).toBe(1);
    expect(await prisma.domainEvent.count({ where: { type: 'offline.received' } })).toBe(1);
  });

  it('직접 입력(MANUAL)은 기관과 관계있는 후원자만', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    const stranger = await seedRegisteredPayer('01099990000');
    await recordManualOfflineDonation(fx.merchantId, fx.merchantUserId, { payerId: payer.id, amount: 20000n, donatedAt: new Date() });
    await expect(recordManualOfflineDonation(fx.merchantId, fx.merchantUserId, { payerId: stranger.id, amount: 20000n, donatedAt: new Date() })).rejects.toThrow(/관계/);
    expect(await offlineMonthTotal(fx.merchantId)).toEqual({ amount: 20000n, count: 1 });
  });
});

describe('이어지는 일', () => {
  it('기관 알림: 한 번에 여러 건이면 묶음 1건, 한 건이면 1건', async () => {
    const a = await relatedPayer('01022223333', '홍길동');
    const b = await relatedPayer('01033334444', '김영희');
    const c = await relatedPayer('01044445555', '행복상사');
    for (const p of [a, b, c]) await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: p.id, amount: p.id === a.id ? 30000n : p.id === b.id ? 10000n : 100000n, dayOfMonth: 5 });
    const r = await importFile(KB);
    expect(r).toMatchObject({ autoMatched: 3 });
    await processDomainEvents();
    await processDomainEvents();
    const notes = await prisma.notification.findMany({ where: { userId: fx.merchantUserId } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.title).toBe('계좌이체 후원 3건 확인');

    await recordManualOfflineDonation(fx.merchantId, fx.merchantUserId, { payerId: a.id, amount: 5000n, donatedAt: new Date() });
    await processDomainEvents();
    expect(await prisma.notification.count({ where: { userId: fx.merchantUserId } })).toBe(2);
  });

  it('후원 감사 저니는 기본 끔: 계좌이체 확정으로는 실행이 생기지 않는다(문자 후원 감사는 그대로)', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await importFile(KB);
    const dep = await prisma.bankDeposit.findFirstOrThrow({ where: { depositorKey: '홍길동' } });
    await confirmDeposits(fx.merchantId, fx.merchantUserId, [{ depositId: dep.id, candidateKey: `p:${payer.id}` }]);
    await processDomainEvents();
    expect(await prisma.journeyRun.count({ where: { subjectType: 'offline_donation' } })).toBe(0);
    const delivered = await prisma.domainEventDelivery.findMany({ where: { event: { type: 'offline.received' } } });
    expect(delivered.find((d) => d.consumer === 'journeys')?.status).toBe('SKIPPED');
  });

  it('승인 대기함 묶음 "입금 확인 필요 N건"', async () => {
    await relatedPayer('01022223333', '홍길동');
    await importFile(KB);
    const g = await depositsInboxGroup(fx.merchantId);
    expect(g).toMatchObject({ kind: 'OFFLINE_DEPOSIT_REVIEW', affectedCount: 3, amount: 140000n, href: '/studio/deposits' });
    const loaded = await loadInboxGroups(fx.merchantId);
    expect(loaded.find((x) => x.provider === 'offline-deposits')?.group?.title).toBe('입금 확인 필요 3건');
    const ids = (await prisma.bankDeposit.findMany({ select: { id: true } })).map((d) => d.id);
    await ignoreDeposits(fx.merchantId, fx.merchantUserId, ids);
    expect(await depositsInboxGroup(fx.merchantId)).toBeNull();
  });

  it('계좌이체 약정: 이번 달 입금됨·아직·미입금', async () => {
    const a = await relatedPayer('01022223333', '홍길동');
    const b = await relatedPayer('01033334444', '김영희');
    const c = await relatedPayer('01044445555', '박철수');
    const now = new Date('2026-11-20T03:00:00Z'); // KST 11/20
    await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: a.id, amount: 30000n, dayOfMonth: 5 });
    await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: b.id, amount: 10000n, dayOfMonth: 10 });
    await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: c.id, amount: 10000n, dayOfMonth: 25 });
    await prisma.offlineDonation.create({ data: { id: newId(), merchantId: fx.merchantId, payerId: a.id, amount: 30000n, donatedAt: new Date('2026-11-05T01:00:00Z'), createdBy: 't' } });
    const s = await pledgeStatusThisMonth(fx.merchantId, now);
    expect(Object.fromEntries(s.map((x) => [x.payerId, x.status]))).toEqual({ [a.id]: 'RECEIVED', [b.id]: 'MISSING', [c.id]: 'NOT_YET' });
    // 같은 후원자 약정은 1건(다시 저장하면 고친다)
    await saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: a.id, amount: 50000n, dayOfMonth: 7 });
    expect(await prisma.offlinePledge.count({ where: { payerId: a.id, archivedAt: null } })).toBe(1);
    await expect(saveOfflinePledge(fx.merchantId, fx.merchantUserId, { payerId: a.id, amount: 50000n, dayOfMonth: 32 })).rejects.toThrow(/입금일/);
  });

  it('통합 명단·대시보드: 계좌이체만 한 후원자도 명단에 나오고 금액은 출처별로 나눠 센다', async () => {
    const payer = await relatedPayer('01022223333', '홍길동');
    await recordManualOfflineDonation(fx.merchantId, fx.merchantUserId, { payerId: payer.id, amount: 20000n, donatedAt: new Date() });
    const rows = await listSupporters(fx.merchantId);
    const row = rows.find((r) => r.payerId === payer.id)!;
    expect(row).toMatchObject({ role: 'DONOR', totalAmount: 0n, donationCount: 0, offlineAmount: 20000n, offlineCount: 1 });
    const ov = await depositOverview(fx.merchantId);
    expect(ov.matched[0]).toMatchObject({ donorName: '홍길동', amount: 20000n });
  });
});

describe('기부금영수증 — receipt_include_offline 끔/켬', () => {
  const RESIDENT = '900101-1234568';
  let year: number;
  let payerId: string;

  async function setupIssuer() {
    await prisma.termsVersion.create({ data: { id: newId(), type: 'RECEIPT_ISSUANCE', version: '1.0', title: '영수증 동의', content: 't', required: false, effectiveFrom: new Date('2026-01-01') } });
    await prisma.merchantProfile.update({
      where: { id: fx.merchantId },
      data: { businessNo: '123-82-00001', representativeName: '김대표', address: '서울시 중구 1', designatedDonee: true, designatedDoneeVerifiedAt: new Date(), orgType: 'WELFARE_CORPORATION' },
    });
    const payer = await seedRegisteredPayer(fx.payerPhone);
    payerId = payer.id;
    await prisma.supporterContact.create({ data: { id: newId(), merchantId: fx.merchantId, name: '홍길동', phoneHash: phoneHash(fx.payerPhone), phoneEnc: encrypt(fx.payerPhone), phoneMasked: maskPhone(fx.payerPhone), payerId } });
    await upsertReceiptProfile(payerId, { legalName: '홍길동', residentNo: RESIDENT, hometaxOptIn: true });
    await inboundAndPay(moPayload({ to: fx.moNumber, from: fx.payerPhone, text: '후원' }), fx.merchantId);
    const charge = await prisma.charge.findFirstOrThrow({ where: { payerId } });
    year = Number(new Date(charge.paidAt!.getTime() + 9 * 3600000).toISOString().slice(0, 4));
    return charge;
  }

  it('끔(기본): 계좌이체가 있어도 후보·발급·명세가 예전과 완전히 같다', async () => {
    const charge = await setupIssuer();
    const before = await receiptCandidates(fx.merchantId, year);
    const beforeOverview = await payerReceiptOverview(payerId, year);
    await recordManualOfflineDonation(fx.merchantId, fx.merchantUserId, { payerId, amount: 70000n, donatedAt: new Date() });
    expect(await receiptCandidates(fx.merchantId, year)).toEqual(before);
    expect((await payerReceiptOverview(payerId, year)).pending).toEqual(beforeOverview.pending);
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId, taxYear: year, issuedBy: 't', silent: true });
    expect(receipt.totalAmount).toBe(charge.amount);
    expect(receipt.chargeCount).toBe(1);
    expect(receipt.items).toEqual([{ chargeId: charge.id, transactionNo: charge.transactionNo, paidAt: charge.paidAt!.toISOString(), amount: charge.amount.toString() }]);
    expect(await prisma.offlineDonation.count({ where: { receiptId: { not: null } } })).toBe(0);
    const ex = await buildHometaxExport(fx.merchantId, year, 't');
    expect(ex.total).toBe(charge.amount);
    expect(ex.content).toContain('금전(문자후원)');
    expect(ex.content).not.toContain('계좌이체');
  });

  it('켬: 후보·발급·홈택스 명세에 포함, 확정 취소하면 정정 필요 표시(자동 무효 없음) → 무효·재발급은 확정분만', async () => {
    const charge = await setupIssuer();
    const od = await recordManualOfflineDonation(fx.merchantId, fx.merchantUserId, { payerId, amount: 70000n, donatedAt: new Date() });
    await setReceiptIncludeOffline(fx.merchantId, fx.merchantUserId, true);
    const cands = await receiptCandidates(fx.merchantId, year);
    expect(cands.find((c) => c.payerId === payerId)).toMatchObject({ amount: charge.amount + 70000n, count: 2, ready: true });
    expect((await payerReceiptOverview(payerId, year)).pending[0]).toMatchObject({ amount: charge.amount + 70000n, count: 2 });

    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId, taxYear: year, issuedBy: 't', silent: true });
    expect(receipt.totalAmount).toBe(charge.amount + 70000n);
    expect(receipt.chargeCount).toBe(2);
    expect(await prisma.offlineDonation.findUniqueOrThrow({ where: { id: od.id } })).toMatchObject({ receiptId: receipt.id });
    const ex = await buildHometaxExport(fx.merchantId, year, 't');
    expect(ex.total).toBe(charge.amount + 70000n);
    expect(ex.content).toContain('금전(문자후원·계좌이체)');
    // 이미 묶인 건은 다시 후보가 아니다
    expect(await receiptCandidates(fx.merchantId, year)).toEqual([]);

    const rr = await revertOfflineDonation(fx.merchantId, fx.merchantUserId, od.id, '입금 착오');
    expect(rr.receiptCorrection).toBe(receipt.receiptNo);
    expect((await prisma.donationReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe('ISSUED');
    expect(await offlineReceiptCorrections(fx.merchantId, year)).toEqual([{ receiptId: receipt.id, receiptNo: receipt.receiptNo, totalAmount: receipt.totalAmount, revertedAmount: 70000n }]);

    await voidReceipt(receipt.id, '계좌이체 확정 취소', 't');
    expect(await offlineReceiptCorrections(fx.merchantId, year)).toEqual([]);
    const re = await reissueReceipt(receipt.id, 't');
    expect(re.receipt.totalAmount).toBe(charge.amount);
    expect(re.receipt.receiptNo).not.toBe(receipt.receiptNo);
  });

  it('켬: 결제 없이 계좌이체만 한 후원자도 발급할 수 있다', async () => {
    await setupIssuer();
    const other = await relatedPayer('01066667777', '이몽룡');
    await upsertReceiptProfile(other.id, { legalName: '이몽룡', residentNo: '850505-1012344', hometaxOptIn: true });
    await recordManualOfflineDonation(fx.merchantId, fx.merchantUserId, { payerId: other.id, amount: 40000n, donatedAt: new Date() });
    await expect(issueReceipt({ merchantId: fx.merchantId, payerId: other.id, taxYear: year, issuedBy: 't', silent: true })).rejects.toThrow(/발급할 후원 내역/);
    await setReceiptIncludeOffline(fx.merchantId, fx.merchantUserId, true);
    const { receipt } = await issueReceipt({ merchantId: fx.merchantId, payerId: other.id, taxYear: year, issuedBy: 't', silent: true });
    expect(receipt).toMatchObject({ totalAmount: 40000n, chargeCount: 1 });
    expect(await prisma.adminAuditLog.count({ where: { action: 'RECEIPT_INCLUDE_OFFLINE_CHANGE' } })).toBe(1);
  });
});
