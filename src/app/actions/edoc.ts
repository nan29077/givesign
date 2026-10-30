'use server';
import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { prisma } from '@/server/db';
import { requireAdmin, requireMerchant, writeAudit } from '@/server/auth';
import { encrypt, generateToken, maskName, maskPhone, normalizePhone, tokenHash } from '@/lib/crypto';
import { newId } from '@/lib/id';
import { getEDocAccount, getEDocPolicy } from '@/server/services/edoc-billing';
import { chargeDocument, edocAccountKey, edocAccountSchema, edocPolicySchema, EDOC_POLICY_KEY, type EDocRequest } from '@/lib/edoc-billing';
import type { StudioActionState } from './studio';
import { documentUrl, DOCUMENT_LINK_TTL_DAYS } from '@/server/services/documents';
import { addDays } from '@/lib/datetime';

const text = (f: FormData, k: string) => String(f.get(k) || '').trim();
const refresh = () => { revalidatePath('/studio/e-documents'); revalidatePath('/studio/document-billing'); revalidatePath('/studio/documents'); revalidatePath('/admin/e-documents'); };

/** Generation consumes one unit atomically; recipient data and template snapshot are encrypted. */
export async function createEDocRequest(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant();
    const nonce = text(f, 'nonce');
    if (!/^[0-9A-Z]{26}$/.test(nonce)) throw new Error('화면을 새로 열고 다시 시도해 주세요.');
    const name = text(f, 'recipientName');
    const phone = normalizePhone(text(f, 'recipientPhone'));
    if (!name || name.length > 40 || !/^01\d{8,9}$/.test(phone)) throw new Error('수신인 이름과 휴대폰 번호를 확인해 주세요.');
    const template = await prisma.documentTemplate.findFirst({ where: { id: text(f, 'templateId'), merchantId: user.merchantId, active: true, archivedAt: null } });
    if (!template) throw new Error('사용 가능한 기관 서식을 선택해 주세요.');
    await getEDocAccount(user.merchantId);
    const policy = await getEDocPolicy();
    const token = generateToken(32), id = newId(), key = edocAccountKey(user.merchantId);
    const snapshot = JSON.stringify({ name: template.name, description: template.description, templateType: template.templateType, body: template.body, fields: template.fields, fileUrl: template.fileUrl, fileName: template.fileName, requireSignature: template.requireSignature });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT key FROM system_setting WHERE key = ${key} FOR UPDATE`;
      const usedKey = `givesign:edoc:request-once:${user.merchantId}:${nonce}`;
      if (await tx.systemSetting.findUnique({ where: { key: usedKey } })) throw new Error('이미 생성한 작성 요청입니다. 새 요청은 화면을 새로 열어 주세요.');
      const row = await tx.systemSetting.findUniqueOrThrow({ where: { key } });
      const charged = chargeDocument(edocAccountSchema.parse(row.value), policy);
      await tx.documentSubmission.create({ data: { id, merchantId: user.merchantId, templateId: template.id, tokenHash: tokenHash(token), expiresAt: addDays(new Date(), DOCUMENT_LINK_TTL_DAYS), payerNameEnc: encrypt(name), payerNameMasked: maskName(name), payerPhoneEnc: encrypt(phone), payerPhoneMasked: maskPhone(phone) } });
      await tx.systemSetting.update({ where: { key }, data: { value: charged.account } });
      await tx.systemSetting.create({ data: { key: usedKey, value: { submissionId: id } } });
      await tx.systemSetting.create({ data: { key: `givesign:edoc:snapshot:${id}`, value: { encrypted: encrypt(snapshot), sha256: createHash('sha256').update(snapshot).digest('hex'), createdAt: new Date().toISOString() } } });
      await tx.systemSetting.create({ data: { key: `givesign:edoc:usage:${id}`, value: { merchantId: user.merchantId, submissionId: id, source: charged.source, amount: charged.amount, createdAt: new Date().toISOString() } } });
    });
    await writeAudit({ adminUserId: user.id, action: 'EDOC_REQUEST_CREATE', targetType: 'document_submission', targetId: id, after: { merchantId: user.merchantId, templateId: template.id } });
    refresh();
    return { ok: true, message: '작성 요청을 생성했습니다. 아래 링크를 수신인에게 전달해 주세요. 기관이 문자를 발송하려면 요청 상세 화면을 이용하세요.', secret: documentUrl(token), secretLabel: '작성 요청 링크 (이번에만 표시)', secretHint: '수신인에게만 전달하세요. 유효기간은 30일입니다.' };
  } catch (e) { return { ok: false, message: e instanceof Error && /[가-힣]/.test(e.message) && !/prisma|invocation/i.test(e.message) ? e.message : '작성 요청 생성에 실패했습니다.' }; }
}

export async function requestEDocBilling(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireMerchant(); const policy = await getEDocPolicy();
    const kind = text(f, 'kind');
    if (kind !== 'TOPUP' && kind !== 'MONTHLY') throw new Error('이용 방식을 선택해 주세요.');
    const amount = kind === 'MONTHLY' ? policy.monthlyPrice : Number(text(f, 'amount'));
    if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 10000000) throw new Error('신청 금액은 1,000원~10,000,000원으로 입력해 주세요.');
    const id = text(f, 'nonce');
    if (!/^[0-9A-Z]{26}$/.test(id)) throw new Error('화면을 새로 열고 다시 신청해 주세요.');
    const requestKey = `givesign:edoc:billing:${user.merchantId}:${id}`;
    if (await prisma.systemSetting.findUnique({ where: { key: requestKey } })) return { ok: true, message: '이미 접수한 신청입니다. 신청 이력에서 확인해 주세요.' };
    const pending = await prisma.systemSetting.count({ where: { key: { startsWith: `givesign:edoc:billing:${user.merchantId}:` }, value: { path: ['status'], equals: 'PENDING' } } });
    if (pending >= 3) throw new Error('확인 대기 중인 신청이 있습니다. 관리자 확인 후 다시 신청해 주세요.');
    const value: EDocRequest = { id, merchantId: user.merchantId, kind, amount, quota: kind === 'MONTHLY' ? policy.monthlyQuota : 0, status: 'PENDING', createdAt: new Date().toISOString() };
    await prisma.systemSetting.upsert({ where: { key: requestKey }, update: {}, create: { key: requestKey, value } });
    refresh(); return { ok: true, message: '신청을 접수했습니다. 실제 결제 완료가 아니며, 관리자가 입금·계약을 확인한 뒤 이용량을 반영합니다.' };
  } catch (e) { return { ok: false, message: e instanceof Error && /[가-힣]/.test(e.message) ? e.message : '신청하지 못했습니다.' }; }
}

export async function saveEDocPolicy(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireAdmin(); if (user.adminPermission !== 'SUPER_ADMIN') throw new Error('요금 정책은 최고관리자만 변경할 수 있습니다.');
    const parsed = edocPolicySchema.safeParse(Object.fromEntries(f));
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0].message };
    await prisma.systemSetting.upsert({ where: { key: EDOC_POLICY_KEY }, create: { key: EDOC_POLICY_KEY, value: parsed.data, updatedBy: user.id }, update: { value: parsed.data, updatedBy: user.id } });
    await writeAudit({ adminUserId: user.id, action: 'EDOC_POLICY_UPDATE', targetType: 'system_setting', after: parsed.data });
    refresh(); return { ok: true, message: '전자문서 이용 요금과 제공량을 저장했습니다. 이미 접수한 신청 금액은 유지됩니다.' };
  } catch { return { ok: false, message: '최고관리자 권한과 입력값을 확인해 주세요.' }; }
}

export async function resolveEDocBilling(_prev: StudioActionState, f: FormData): Promise<StudioActionState> {
  try {
    const user = await requireAdmin();
    if (!['SUPER_ADMIN', 'FINANCE', 'OPERATION'].includes(user.adminPermission || '')) throw new Error('운영·재무 권한이 필요합니다.');
    const merchantId = text(f, 'merchantId'), requestId = text(f, 'requestId'), decision = text(f, 'decision');
    if (!['APPROVED', 'REJECTED'].includes(decision)) throw new Error('처리 방식을 확인해 주세요.');
    if (decision === 'APPROVED' && f.get('paymentConfirmed') !== 'on') throw new Error('실제 입금 또는 계약 확인 여부를 체크해 주세요.');
    await getEDocAccount(merchantId);
    const key = edocAccountKey(merchantId), reqKey = `givesign:edoc:billing:${merchantId}:${requestId}`;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT key FROM system_setting WHERE key = ${key} FOR UPDATE`;
      const row = await tx.systemSetting.findUniqueOrThrow({ where: { key: reqKey } });
      const request = row.value as unknown as EDocRequest;
      if (request.merchantId !== merchantId || request.status !== 'PENDING') throw new Error('이미 처리했거나 유효하지 않은 신청입니다.');
      if (decision === 'APPROVED') {
        const account = edocAccountSchema.parse((await tx.systemSetting.findUniqueOrThrow({ where: { key } })).value);
        if (request.kind === 'TOPUP') account.balance += request.amount;
        else {
          if (account.monthlyUntil && new Date(account.monthlyUntil) > new Date()) throw new Error('정액 이용 기간이 남아 있습니다. 만료 후 갱신해 주세요.');
          account.monthlyRemaining = request.quota; account.monthlyUntil = addDays(new Date(), 30).toISOString();
        }
        await tx.systemSetting.update({ where: { key }, data: { value: account } });
      }
      await tx.systemSetting.update({ where: { key: reqKey }, data: { value: { ...request, status: decision, resolvedAt: new Date().toISOString() } } });
      await tx.systemSetting.create({ data: { key: `givesign:edoc:billing-event:${requestId}`, value: { merchantId, requestId, decision, amount: request.amount, adminId: user.id, createdAt: new Date().toISOString() } } });
    });
    await writeAudit({ adminUserId: user.id, action: 'EDOC_BILLING_' + decision, targetType: 'system_setting', targetId: reqKey, after: { merchantId, requestId } });
    refresh(); return { ok: true, message: decision === 'APPROVED' ? '확인한 입금·계약을 기준으로 이용량을 반영했습니다.' : '신청을 반려했습니다.' };
  } catch (e) { return { ok: false, message: e instanceof Error && /[가-힣]/.test(e.message) && !/prisma|invocation/i.test(e.message) ? e.message : '신청 처리에 실패했습니다.' }; }
}
