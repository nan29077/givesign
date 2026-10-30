import { env } from '@/lib/env';
import { decrypt, encrypt, maskSecret } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { prisma } from '@/server/db';
import { getAlimtalkAdapter } from '@/server/adapters/alimtalk';
import type { AlimtalkChannelStatus } from '@/generated/prisma/enums';
import { MT_TEMPLATE, MT_TEMPLATE_META, type MtTemplateCode } from './mt-templates';

/**
 * 카카오 알림톡 채널 — 기관별 설정과 발송 경로 결정.
 *
 * 알림톡은 **정보성 메시지** 만 보낼 수 있다(카카오 정책). 광고성("정기후원에 참여해 주세요")은
 * 템플릿 승인이 나지 않으므로 아예 목록에 두지 않는다. 인증번호·결제 링크처럼 문자로 받아야
 * 안전한 것도 넣지 않는다.
 *
 * 발송 규칙
 *  1. ALIMTALK_ENABLED 이고
 *  2. 기관 채널이 관리자 확인(ACTIVE) 상태이고
 *  3. 그 템플릿에 카카오 승인 코드가 매핑돼 있으면 → 알림톡
 *  그 외에는 문자. 알림톡이 실패하면 같은 본문을 문자로 대체 발송한다(사후 처리 실패가 안내를 막지 않는다).
 */

export const ALIMTALK_TEMPLATES: MtTemplateCode[] = [
  MT_TEMPLATE.CHARGE_SUCCESS,
  MT_TEMPLATE.CHARGE_FAILED,
  MT_TEMPLATE.REFUND_DONE,
  MT_TEMPLATE.RECURRING_STARTED,
  MT_TEMPLATE.RECURRING_FAILED,
  MT_TEMPLATE.RECURRING_SUSPENDED,
  MT_TEMPLATE.RECEIPT_ISSUED,
  MT_TEMPLATE.MONTHLY_NOTICE,
  MT_TEMPLATE.AGREEMENT_ISSUED,
  MT_TEMPLATE.PLEDGE_LINK,
  MT_TEMPLATE.VOLUNTEER_LINK,
  MT_TEMPLATE.VOLUNTEER_RECEIVED,
  MT_TEMPLATE.VOLUNTEER_APPROVED,
];

export function alimtalkTemplateOptions() {
  return ALIMTALK_TEMPLATES.map((code) => ({ code, label: MT_TEMPLATE_META[code].label, sample: MT_TEMPLATE_META[code].defaultBody }));
}

export const ALIMTALK_STATUS_LABEL: Record<AlimtalkChannelStatus, string> = {
  NOT_CONNECTED: '미연결',
  PENDING: '승인 확인 대기',
  ACTIVE: '사용 중',
  SUSPENDED: '중지',
};

const CHANNEL_ID_RE = /^@[0-9A-Za-z가-힣_.-]{2,30}$/;
const KAKAO_TPL_RE = /^[0-9A-Za-z_-]{2,30}$/;

export class AlimtalkConfigError extends Error {}

function parseTemplateCodes(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

export async function getAlimtalkChannel(merchantId: string) {
  const row = await prisma.merchantAlimtalkChannel.findUnique({ where: { merchantId } });
  if (!row) return null;
  return { ...row, templateCodes: parseTemplateCodes(row.templateCodes) };
}

/**
 * 기관이 채널 정보를 저장한다. 발신프로필 키나 템플릿 코드가 바뀌면 관리자 확인을 다시 받는다
 * (승인되지 않은 코드로 보내면 카카오가 전건 거절한다).
 */
export async function saveAlimtalkChannel(
  merchantId: string,
  input: { channelId: string; senderKey?: string; templateCodes: Record<string, string> },
) {
  const channelId = input.channelId.trim();
  if (!CHANNEL_ID_RE.test(channelId)) throw new AlimtalkConfigError('카카오톡 채널 아이디는 @ 로 시작하는 2~30자로 입력해 주세요. (예: @햇살복지관)');
  const codes: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.templateCodes)) {
    if (!ALIMTALK_TEMPLATES.includes(k as MtTemplateCode)) continue;
    const code = v.trim();
    if (!code) continue;
    if (!KAKAO_TPL_RE.test(code)) throw new AlimtalkConfigError(`템플릿 코드는 영문·숫자·_- 2~30자로 입력해 주세요. (${MT_TEMPLATE_META[k as MtTemplateCode].label})`);
    codes[k] = code;
  }
  const senderKey = input.senderKey?.trim();
  if (senderKey && !/^[0-9A-Za-z]{20,64}$/.test(senderKey)) throw new AlimtalkConfigError('발신프로필 키 형식이 올바르지 않습니다. (영문·숫자 20~64자)');

  const before = await getAlimtalkChannel(merchantId);
  const keyChanged = Boolean(senderKey);
  const codesChanged = JSON.stringify(before?.templateCodes ?? {}) !== JSON.stringify(codes);
  const channelChanged = before?.channelId !== channelId;
  const needsReview = !before || keyChanged || codesChanged || channelChanged;
  if (!before && !senderKey) throw new AlimtalkConfigError('처음 연결할 때는 발신프로필 키가 필요합니다.');

  if (!before) {
    return prisma.merchantAlimtalkChannel.create({
      data: {
        merchantId,
        channelId,
        senderKeyEnc: encrypt(senderKey!),
        senderKeyMasked: maskSecret(senderKey!),
        templateCodes: codes,
        status: 'PENDING',
      },
    });
  }
  return prisma.merchantAlimtalkChannel.update({
    where: { merchantId },
    data: {
      channelId,
      ...(senderKey ? { senderKeyEnc: encrypt(senderKey), senderKeyMasked: maskSecret(senderKey) } : {}),
      templateCodes: codes,
      ...(needsReview && before?.status !== 'SUSPENDED' ? { status: 'PENDING' as const, verifiedAt: null, verifiedBy: null } : {}),
    },
  });
}

/** 관리자: 카카오 발신프로필·템플릿 승인을 확인했다고 표시한다. */
export async function setAlimtalkChannelStatus(merchantId: string, status: AlimtalkChannelStatus, adminUserId: string, note?: string) {
  const row = await prisma.merchantAlimtalkChannel.findUnique({ where: { merchantId } });
  if (!row) throw new AlimtalkConfigError('기관이 아직 알림톡 채널을 등록하지 않았습니다.');
  if (status === 'ACTIVE' && Object.keys(parseTemplateCodes(row.templateCodes)).length === 0) {
    throw new AlimtalkConfigError('승인 템플릿 코드가 하나도 없습니다. 기관이 템플릿 코드를 등록한 뒤 확인해 주세요.');
  }
  return prisma.merchantAlimtalkChannel.update({
    where: { merchantId },
    data: {
      status,
      note: note ?? row.note,
      verifiedAt: status === 'ACTIVE' ? new Date() : row.verifiedAt,
      verifiedBy: status === 'ACTIVE' ? adminUserId : row.verifiedBy,
    },
  });
}

export interface AlimtalkRoute {
  senderKey: string;
  kakaoTemplateCode: string;
}

/** 이 기관·이 템플릿을 알림톡으로 보낼 수 있으면 경로를, 아니면 null(문자). */
export async function resolveAlimtalkRoute(merchantId: string | null | undefined, templateCode: string): Promise<AlimtalkRoute | null> {
  if (!env.automation.alimtalkEnabled || !merchantId) return null;
  if (!ALIMTALK_TEMPLATES.includes(templateCode as MtTemplateCode)) return null;
  const row = await prisma.merchantAlimtalkChannel.findUnique({ where: { merchantId } }).catch(() => null);
  if (!row || row.status !== 'ACTIVE' || !row.senderKeyEnc) return null;
  const code = parseTemplateCodes(row.templateCodes)[templateCode];
  if (!code) return null;
  try {
    return { senderKey: decrypt(row.senderKeyEnc), kakaoTemplateCode: code };
  } catch (e) {
    logger.error('알림톡 발신프로필 키 복호화 실패 — 문자로 보냅니다', { merchantId, message: (e as Error).message });
    return null;
  }
}

/** 알림톡 1건 발송. 실패하면 { ok:false } — 호출부가 문자로 대체한다. */
export async function sendAlimtalk(to: string, route: AlimtalkRoute, text: string) {
  const adapter = getAlimtalkAdapter();
  try {
    const res = await adapter.send({ to, senderKey: route.senderKey, templateCode: route.kakaoTemplateCode, text });
    return { ok: res.ok, provider: adapter.info().provider, messageId: res.data?.providerMessageId ?? null, code: res.code ?? null, message: res.message ?? null };
  } catch (e) {
    return { ok: false, provider: adapter.info().provider, messageId: null, code: 'EXCEPTION', message: (e as Error).message };
  }
}
