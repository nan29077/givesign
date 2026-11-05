import { env } from '@/lib/env';
import { generateToken, tokenHash } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { mailIsLive, sendMail } from '@/server/adapters/mail';

/**
 * 메일 본문과 발송 지점 (2026-11-06 7단계).
 *
 * 모든 발송은 `mailIsLive()`(ses + 필수 설정) 일 때만 한다. 아니면 아무것도 보내지 않고 false 를 돌려주며,
 * 호출부는 "메일로 보냈다" 고 말하지 않는다. 본문의 일회용 링크는 로그에 남기지 않는다.
 */

const base = () => env.baseUrl.replace(/\/+$/, '');
const brand = '기브싸인(GIVESIGN)';

function htmlEscape(v: string) {
  return v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(title: string, lines: string[], link: { href: string; label: string } | null) {
  const text = [title, '', ...lines, ...(link ? ['', `${link.label}: ${link.href}`] : []), '', `— ${brand}`].join('\n');
  const html = `<!doctype html><html lang="ko"><body style="font-family:sans-serif;color:#1f2937;line-height:1.6">
<h2 style="font-size:18px">${htmlEscape(title)}</h2>
${lines.map((l) => `<p style="margin:0 0 8px">${htmlEscape(l)}</p>`).join('\n')}
${link ? `<p style="margin:20px 0"><a href="${htmlEscape(link.href)}" style="background:#28634e;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none">${htmlEscape(link.label)}</a></p><p style="font-size:12px;color:#6b7280;word-break:break-all">${htmlEscape(link.href)}</p>` : ''}
<p style="font-size:12px;color:#9ca3af">${brand}</p></body></html>`;
  return { text, html };
}

/** 비밀번호 재설정 메일. 실연동이 아니면 보내지 않고 false. */
export async function sendPasswordResetMail(to: string, link: string): Promise<boolean> {
  if (!mailIsLive()) return false;
  const body = layout('비밀번호 재설정 안내', ['아래 버튼을 눌러 새 비밀번호를 지정해 주세요.', '링크는 1시간 동안 한 번만 쓸 수 있습니다. 직접 요청하지 않았다면 이 메일을 무시해 주세요.'], { href: link, label: '비밀번호 재설정' });
  const r = await sendMail({ to, subject: `[${brand}] 비밀번호 재설정 안내`, ...body, tag: 'PASSWORD_RESET' });
  if (!r.ok) logger.error('비밀번호 재설정 메일 발송 실패', { code: r.code ?? null });
  return r.ok;
}

// ---------------------------------------------------------------------------
// 후원 회원 이메일 인증
// ---------------------------------------------------------------------------

const VERIFY_TTL_MS = 24 * 3600_000;

/** 가입 직후 이메일 인증 링크를 보낸다. 실연동이 아니면 아무것도 만들지 않고 false(지금 동작 그대로). */
export async function sendDonorEmailVerification(org: { id: string; code: string; displayName?: string }, memberId: string): Promise<boolean> {
  if (!mailIsLive()) return false;
  const m = await prisma.donorMember.findUnique({ where: { id: memberId }, select: { id: true, merchantId: true, email: true, emailVerifiedAt: true } });
  if (!m || m.merchantId !== org.id || m.emailVerifiedAt) return false;
  if (m.email.endsWith('@social.givesign.local')) return false; // 간편 로그인 자리표시 주소
  const token = generateToken(32);
  const now = new Date();
  await prisma.$transaction([
    prisma.donorEmailToken.updateMany({ where: { memberId, usedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } }),
    prisma.donorEmailToken.create({ data: { id: newId(), memberId, merchantId: org.id, email: m.email, tokenHash: tokenHash(token), expiresAt: new Date(now.getTime() + VERIFY_TTL_MS) } }),
  ]);
  const link = `${base()}/donate/${org.code}/verify-email?token=${token}`;
  const name = org.displayName ?? '기관';
  const body = layout(`${name} 후원 회원 이메일 인증`, [`${name} 후원페이지 회원 가입을 완료하려면 아래 버튼으로 이메일을 인증해 주세요.`, '링크는 24시간 동안 쓸 수 있습니다. 직접 가입하지 않았다면 이 메일을 무시해 주세요.'], { href: link, label: '이메일 인증' });
  const r = await sendMail({ to: m.email, subject: `[${name}] 후원 회원 이메일 인증`, ...body, tag: 'DONOR_EMAIL_VERIFY' });
  if (!r.ok) logger.error('후원 회원 인증 메일 발송 실패', { merchantId: org.id, code: r.code ?? null });
  return r.ok;
}

export type DonorEmailVerifyResult = 'VERIFIED' | 'INVALID' | 'EXPIRED';

/** 인증 링크 확인. 이 기관의 링크이고, 발급 당시 이메일이 지금 회원 이메일과 같을 때만 인증한다. */
export async function confirmDonorEmail(org: { id: string }, token: string): Promise<DonorEmailVerifyResult> {
  if (!token || token.length > 200) return 'INVALID';
  const row = await prisma.donorEmailToken.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!row || row.merchantId !== org.id || row.usedAt) return 'INVALID';
  if (row.expiresAt.getTime() < Date.now()) return 'EXPIRED';
  const claimed = await prisma.donorEmailToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
  if (claimed.count !== 1) return 'INVALID';
  const r = await prisma.donorMember.updateMany({ where: { id: row.memberId, merchantId: org.id, email: row.email, withdrawnAt: null }, data: { emailVerifiedAt: new Date() } });
  return r.count === 1 ? 'VERIFIED' : 'INVALID';
}

// ---------------------------------------------------------------------------
// 발급 문서 안내 (호출 연결은 아직 하지 않음 — 영수증·약정서 자동 발송 단계에서 연결)
// ---------------------------------------------------------------------------

/**
 * 영수증·발급 문서 안내 메일. 문서 원문·주민번호를 메일에 넣지 않고, 열람 주소만 보낸다.
 * 실연동이 아니면 보내지 않고 false.
 */
export async function sendDocumentMail(input: { to: string; merchantName: string; documentTitle: string; viewUrl: string; note?: string }): Promise<boolean> {
  if (!mailIsLive()) return false;
  const body = layout(`${input.merchantName} — ${input.documentTitle}`, [
    `${input.merchantName}에서 ${input.documentTitle}을(를) 보냈습니다.`,
    ...(input.note ? [input.note] : []),
    '아래 버튼으로 열람·내려받을 수 있습니다.',
  ], { href: input.viewUrl, label: '문서 보기' });
  const r = await sendMail({ to: input.to, subject: `[${input.merchantName}] ${input.documentTitle}`, ...body, tag: 'DOCUMENT' });
  if (!r.ok) logger.error('발급 문서 안내 메일 발송 실패', { code: r.code ?? null });
  return r.ok;
}
