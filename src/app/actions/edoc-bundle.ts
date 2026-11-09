'use server';

import { cookies, headers } from 'next/headers';
import { clientIpFrom } from '@/server/rate-limit';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import {
  BundleError,
  bundleCookieName,
  confirmBundleOtp,
  declineBundle,
  loadBundleSession,
  requestBundleOtp,
  signBundle,
} from '@/server/services/document-bundles';

/**
 * 문서 묶음 서명 화면(/sign/bundle/[토큰], 비로그인) — 2026-11-12 4차 J2.
 * 본인확인 1번 → 묶음 증표 쿠키(경로 /sign/bundle, 발송·현재 토큰에 묶임) → 한 화면에서 순서대로 서명.
 */

export interface BundleActionState {
  ok: boolean;
  message?: string;
  devCode?: string;
  codeSent?: boolean;
  done?: 'verified' | 'signed' | 'declined';
  results?: Array<{ label: string; ok: boolean; message?: string }>;
}

const text = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === 'string' ? v.trim() : '';
};

function friendly(e: unknown, fallback: string) {
  if (e instanceof BundleError) return e.message;
  const msg = e instanceof Error ? e.message : '';
  if (msg && /[가-힣]/.test(msg) && !/prisma|invocation|decrypt/i.test(msg)) return msg;
  logger.warn('문서 묶음 서명 화면 오류', { message: msg });
  return fallback;
}

async function meta() {
  const h = await headers();
  return { ip: clientIpFrom((n) => h.get(n)) ?? undefined, userAgent: h.get('user-agent') ?? undefined };
}

async function proofFor(token: string) {
  const s = await loadBundleSession(token);
  if (!s.ok) return undefined;
  return (await cookies()).get(bundleCookieName(s.sendId))?.value;
}

export async function bundleOtpRequestAction(_p: BundleActionState, f: FormData): Promise<BundleActionState> {
  try {
    const r = await requestBundleOtp(text(f, 'token'), await meta());
    return { ok: true, codeSent: true, message: `${r.phoneMasked} 번호로 인증번호를 보냈습니다.`, devCode: r.devCode };
  } catch (e) {
    return { ok: false, codeSent: false, message: friendly(e, '인증번호를 보내지 못했습니다.') };
  }
}

export async function bundleOtpConfirmAction(_p: BundleActionState, f: FormData): Promise<BundleActionState> {
  try {
    const r = await confirmBundleOtp(text(f, 'token'), text(f, 'otp'), await meta());
    (await cookies()).set(bundleCookieName(r.sendId), r.proof, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' && env.baseUrl.startsWith('https'), path: '/sign/bundle', maxAge: r.maxAge,
    });
    return { ok: true, codeSent: true, done: 'verified', message: '본인확인을 마쳤습니다.' };
  } catch (e) {
    return { ok: false, codeSent: true, message: friendly(e, '본인확인을 하지 못했습니다.') };
  }
}

export async function bundleSignAction(_p: BundleActionState, f: FormData): Promise<BundleActionState> {
  const token = text(f, 'token');
  const agreed: Record<string, boolean> = {};
  const values: Record<string, Record<string, string>> = {};
  for (const [k, v] of f.entries()) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('agree:')) agreed[k.slice(6)] = true;
    else if (k.startsWith('v:')) {
      const [, item, field] = k.split(':');
      if (!item || !field) continue;
      (values[item] ??= {})[field] = v;
    }
  }
  try {
    const r = await signBundle({ token, proof: await proofFor(token), signature: text(f, 'signature') || null, agreed, values, ...(await meta()) });
    const failed = r.results.filter((x) => !x.ok && x.message !== '선택 문서 — 서명하지 않음');
    return {
      ok: failed.length === 0,
      done: r.signed > 0 ? 'signed' : undefined,
      results: r.results.map((x) => ({ label: x.label, ok: x.ok, message: x.message })),
      message: failed.length ? `${r.signed}건 서명했고 ${failed.length}건은 서명하지 못했습니다.` : `${r.signed}건 모두 서명했습니다.`,
    };
  } catch (e) {
    return { ok: false, message: friendly(e, '서명을 저장하지 못했습니다. 다시 시도해 주세요.') };
  }
}

export async function bundleDeclineAction(_p: BundleActionState, f: FormData): Promise<BundleActionState> {
  try {
    const token = text(f, 'token');
    const r = await declineBundle({ token, proof: await proofFor(token), reason: text(f, 'reason'), ...(await meta()) });
    return { ok: true, done: 'declined', message: `${r.declined}건의 서명을 거절했습니다. 기관에 사유가 전달됩니다.` };
  } catch (e) {
    return { ok: false, message: friendly(e, '처리하지 못했습니다.') };
  }
}
