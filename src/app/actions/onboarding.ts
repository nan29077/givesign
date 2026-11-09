'use server';

import { revalidatePath } from 'next/cache';
import { requireMerchant, writeAudit } from '@/server/auth';
import { logger } from '@/lib/logger';
import { OnboardingError, dismissOnboarding, readTestSteps, runOnboardingTest, scanOrgDocument, setOnboardingSkip } from '@/server/services/onboarding';
import type { StudioActionState } from '@/app/actions/studio';

/**
 * 기관 도입 자동 액션 (2026-11-12 4차 I2). 서류 읽기는 입력칸 후보만(저장은 담당자), 시험은 샌드박스(실제 결제·문자·집계 없음).
 */

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

async function merchant() {
  return requireMerchant();
}

function friendly(e: unknown) {
  if (e instanceof OnboardingError) return (e as Error).message;
  logger.error('도입 체크리스트 처리 오류', { message: (e as Error).message });
  return '처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}

export async function scanOrgDocAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const u = await merchant();
    const file = f.get('file');
    if (!(file instanceof File) || file.size === 0) return { ok: false, message: '고유번호증·사업자등록증 사진이나 PDF 를 골라 주세요.' };
    if (file.size > 5 * 1024 * 1024) return { ok: false, message: '파일은 5MB 이하로 올려 주세요.' };
    const buffer = Buffer.from(await file.arrayBuffer());
    const r = await scanOrgDocument({ merchantId: u.merchantId, userId: u.id, buffer, mime: file.type });
    await writeAudit({ action: 'ORG_DOC_SCAN', targetType: 'merchant', targetId: u.merchantId, after: { scanId: r.scanId, found: r.found } }).catch(() => undefined);
    if (!r.found) return { ok: false, message: '글자는 읽었지만 이름·번호·대표자·주소를 찾지 못했습니다. 더 밝고 반듯한 사진으로 다시 올리거나 직접 입력해 주세요.' };
    return { ok: true, message: '서류에서 읽은 값으로 입력칸을 채웁니다. 확인하고 고친 뒤 [기관 정보 저장] 을 눌러야 저장됩니다.', redirectTo: `/studio/profile?scan=${r.scanId}#org-info` };
  } catch (e) {
    return { ok: false, message: friendly(e) };
  }
}

export async function runOnboardingTestAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const u = await merchant();
    const r = await runOnboardingTest({ merchantId: u.merchantId, userId: u.id, phone: text(f, 'phone'), staffName: text(f, 'staffName') });
    revalidatePath('/studio/start');
    revalidatePath('/studio/inbox');
    const steps = readTestSteps(r.run.steps);
    const failed = steps.filter((s) => !s.ok);
    const head = r.reused ? '방금 실행한 시험 결과입니다. ' : '';
    return { ok: failed.length === 0, message: `${head}${failed.length ? `시험 중 ${failed.length}단계가 실패했습니다: ${failed.map((s) => s.message).join(' / ')}` : '시험 후원·시험 문서가 모두 성공했습니다(시뮬레이션 — 집계·정산·영수증에서 빠집니다).'}` };
  } catch (e) {
    return { ok: false, message: friendly(e) };
  }
}

export async function setOnboardingSkipAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const u = await merchant();
    await setOnboardingSkip(u.merchantId, u.id, text(f, 'step'), text(f, 'skip') !== 'false');
    revalidatePath('/studio/start');
    revalidatePath('/studio');
    return { ok: true, message: text(f, 'skip') !== 'false' ? '해당 없음으로 표시했습니다.' : '다시 할 일로 되돌렸습니다.' };
  } catch (e) {
    return { ok: false, message: friendly(e) };
  }
}

export async function dismissOnboardingAction(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const u = await merchant();
    await dismissOnboarding(u.merchantId, u.id, text(f, 'dismiss') !== 'false');
    revalidatePath('/studio');
    revalidatePath('/studio/start');
    return { ok: true, message: text(f, 'dismiss') !== 'false' ? '대시보드 안내를 숨겼습니다. 도입 체크리스트는 언제든 /studio/start 에서 볼 수 있습니다.' : '대시보드 안내를 다시 보입니다.' };
  } catch (e) {
    return { ok: false, message: friendly(e) };
  }
}
