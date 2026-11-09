'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant } from '@/server/auth';
import { logger } from '@/lib/logger';
import { DEPOSIT_FILE_MAX_BYTES, mappingFromForm } from '@/lib/bank-statement';
import {
  DepositError,
  archiveOfflinePledge,
  confirmDepositAsNewDonor,
  confirmDeposits,
  ignoreDeposits,
  importBankStatement,
  revertOfflineDonation,
  saveOfflinePledge,
  setReceiptIncludeOffline,
  unignoreDeposit,
} from '@/server/services/deposits';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 입금 맞추기(/studio/deposits) 액션 — 2026-11-09 E.
 * 권한: 기관 콘솔 계정(requireMerchant). 지금 기관당 담당자 계정은 1개이고 별도 금전 권한 체계가 없다.
 * 업로드·확정·무시·되돌리기·약정·영수증 설정 변경은 서비스가 감사로그를 남긴다.
 */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function fail(e: unknown): StudioActionState {
  const message = (e as Error)?.message ?? '';
  if (e instanceof DepositError) return { ok: false, message };
  logger.error('입금 맞추기 처리 오류', { message });
  return { ok: false, message: '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' };
}

async function merchant() {
  try {
    const u = await requireMerchant();
    return { merchantId: u.merchantId, userId: u.id };
  } catch (e) {
    return { error: (e as Error).message || '기관 권한이 필요합니다.' };
  }
}

function refresh() {
  revalidatePath('/studio/deposits');
  revalidatePath('/studio');
}

function wonOf(raw: string): bigint | null {
  const v = raw.replace(/[,\s원]/g, '');
  return /^\d{1,12}$/.test(v) ? BigInt(v) : null;
}

// ---------------------------------------------------------------------------
// 파일 올리기
// ---------------------------------------------------------------------------

export interface DepositUploadState extends StudioActionState {
  needsMapping?: { headerRow: number; headers: string[]; sample: string[][] };
  summary?: { format: string; rowCount: number; newCount: number; duplicateCount: number; skippedCount: number; autoMatched: number; suggested: number; unmatched: number; duplicateWarnings: number; errors: Array<{ line: number; reason: string }> };
}

export async function depositUploadAction(_p: DepositUploadState, f: FormData): Promise<DepositUploadState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  const file = f.get('file');
  if (!(file instanceof File) || file.size === 0) return { ok: false, message: '거래내역 파일(CSV·XLSX)을 골라 주세요.' };
  if (file.size > DEPOSIT_FILE_MAX_BYTES) return { ok: false, message: '파일은 2MB 이하로 올려 주세요. 기간을 나눠 내려받으면 됩니다.' };
  if (!/\.(csv|txt|xlsx|xls)$/i.test(file.name)) return { ok: false, message: 'CSV 또는 엑셀(.xlsx) 파일만 올릴 수 있습니다. 다른 형식은 엑셀에서 CSV 로 저장해 올려 주세요.' };
  const mapping = text(f, 'map_header') ? mappingFromForm((k) => text(f, k)) : null;
  if (text(f, 'map_header') && !mapping) return { ok: false, message: '날짜 열과 입금액 열은 꼭 골라 주세요.' };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const r = await importBankStatement({ merchantId: m.merchantId, userId: m.userId, fileName: file.name, bytes, mapping });
    if (r.status === 'NEEDS_MAPPING') {
      return {
        ok: false,
        message: '열 이름을 알아보지 못했습니다. 아래에서 날짜·입금액·입금자 열을 골라 같은 파일로 다시 올려 주세요.',
        needsMapping: { headerRow: r.headerRow, headers: r.headers, sample: r.sample },
      };
    }
    refresh();
    return {
      ok: true,
      message: `입금 ${r.rowCount}건을 읽었습니다(${r.format}). 자동 확정 ${r.autoMatched} · 확인 필요 ${r.suggested} · 모름 ${r.unmatched}${r.duplicateCount ? ` · 이미 넣은 입금 ${r.duplicateCount}` : ''}`,
      summary: {
        format: r.format,
        rowCount: r.rowCount,
        newCount: r.newCount,
        duplicateCount: r.duplicateCount,
        skippedCount: r.skippedCount,
        autoMatched: r.autoMatched,
        suggested: r.suggested,
        unmatched: r.unmatched,
        duplicateWarnings: r.duplicateWarnings,
        errors: r.errors,
      },
    };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// 확정 · 무시 · 되돌리기
// ---------------------------------------------------------------------------

/** 확인 필요 목록: 체크한 행을 한 번에 확정하거나 무시한다. 행마다 고른 후보는 cand_{입금 id}. */
export async function depositReviewAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  const ids = f.getAll('pick').filter((v): v is string => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) return { ok: false, message: '처리할 입금을 체크해 주세요.' };
  try {
    if (text(f, 'intent') === 'ignore') {
      const n = await ignoreDeposits(m.merchantId, m.userId, ids);
      refresh();
      return { ok: true, message: `${n}건을 후원 아님으로 표시했습니다.` };
    }
    const r = await confirmDeposits(
      m.merchantId,
      m.userId,
      ids.map((id) => ({ depositId: id, candidateKey: text(f, `cand_${id}`) || null })),
      { campaignId: text(f, 'campaignId') || null },
    );
    refresh();
    return {
      ok: r.confirmed > 0,
      message: `${r.confirmed}건을 확정했습니다.${r.skipped ? ` 건너뜀 ${r.skipped}건(이미 처리됐거나 후보 없음).` : ''}${r.reasons.length ? ` ${r.reasons.slice(0, 3).join(' / ')}` : ''}`,
    };
  } catch (e) {
    return fail(e);
  }
}

export async function depositNewDonorAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  try {
    await confirmDepositAsNewDonor(m.merchantId, m.userId, text(f, 'depositId'), { name: text(f, 'name'), phone: text(f, 'phone'), campaignId: text(f, 'campaignId') || null });
    refresh();
    return { ok: true, message: '후원자와 연결해 확정했습니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function depositIgnoreOneAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  try {
    const n = await ignoreDeposits(m.merchantId, m.userId, [text(f, 'depositId')]);
    refresh();
    return n ? { ok: true, message: '후원 아님으로 표시했습니다.' } : { ok: false, message: '이미 처리된 입금입니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function depositUnignoreAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  try {
    await unignoreDeposit(m.merchantId, m.userId, text(f, 'depositId'));
    refresh();
    return { ok: true, message: '다시 확인 목록으로 옮겼습니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function offlineRevertAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  try {
    const r = await revertOfflineDonation(m.merchantId, m.userId, text(f, 'offlineDonationId'), text(f, 'reason'));
    refresh();
    revalidatePath('/studio/receipts');
    return {
      ok: true,
      message: r.receiptCorrection
        ? `되돌렸습니다. 이미 발급된 기부금영수증 ${r.receiptCorrection} 에 들어간 금액이라 정정이 필요합니다(기부금영수증 화면에서 무효 후 재발급).`
        : '되돌렸습니다. 입금은 다시 확인 목록에 있습니다.',
    };
  } catch (e) {
    return fail(e);
  }
}

// ---------------------------------------------------------------------------
// 계좌이체 약정 · 설정
// ---------------------------------------------------------------------------

export async function offlinePledgeSaveAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  const amount = wonOf(text(f, 'amount'));
  const day = Number(text(f, 'dayOfMonth'));
  if (amount === null) return { ok: false, message: '약정 금액을 숫자로 적어 주세요.' };
  try {
    await saveOfflinePledge(m.merchantId, m.userId, {
      payerId: text(f, 'payerId') || null,
      name: text(f, 'name'),
      phone: text(f, 'phone'),
      amount,
      dayOfMonth: day,
      campaignId: text(f, 'campaignId') || null,
      memo: text(f, 'memo') || null,
    });
    refresh();
    return { ok: true, message: '계좌이체 약정을 저장했습니다. 매칭 근거와 이번 달 미입금 확인에만 쓰고, 출금은 하지 않습니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function offlinePledgeArchiveAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  try {
    await archiveOfflinePledge(m.merchantId, m.userId, text(f, 'pledgeId'));
    refresh();
    return { ok: true, message: '약정을 보관했습니다.' };
  } catch (e) {
    return fail(e);
  }
}

export async function receiptIncludeOfflineAction(_p: StudioActionState, f: FormData): Promise<StudioActionState> {
  const m = await merchant();
  if ('error' in m) return { ok: false, message: m.error };
  try {
    const on = f.get('receiptIncludeOffline') != null;
    await setReceiptIncludeOffline(m.merchantId, m.userId, on);
    refresh();
    revalidatePath('/studio/receipts');
    return { ok: true, message: on ? '앞으로 발급하는 기부금영수증에 확정된 계좌이체 후원을 합산합니다.' : '기부금영수증에 계좌이체 후원을 넣지 않습니다(이미 발급된 영수증은 그대로).' };
  } catch (e) {
    return fail(e);
  }
}
