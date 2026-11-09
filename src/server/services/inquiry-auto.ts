import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { decrypt, encrypt, maskPhone } from '@/lib/crypto';
import { kstDateKey } from '@/lib/datetime';
import { addBusinessDays, addDaysKey } from '@/lib/business-day';
import { solicitationHit } from '@/lib/solicitation';
import { PAID_STATUSES } from '@/components/studio/shared';
import { completeJson, getLlmAdapter, llmUsable, type LlmAdapter } from '@/server/adapters/llm';
import { maskForLlm } from './ai-drafts';
import { recordAiUsage } from './ai-usage';
import { loadHolidays } from './settlement-schedule';
import { receiptScheduleNote } from './receipt-schedule';
import { newGuestInquiryToken } from './inquiry';
import { notifyUser } from './notifications';
import type { InboxExceptionGroup } from './inbox-groups';
import * as tpl from './mt-templates';

/**
 * 문의 자동 응대 (2026-11-12 4차 K4).
 *
 * 대상: 기관이 응대하는 문의(`support_inquiry.handled_by = 'MERCHANT'`) — 문자 '문의' 명령 링크에서 그 기관으로 접수한 것.
 * 고객센터(/support)·채팅 위젯 문의는 예전처럼 통합 관리자가 응대한다(handled_by 비어 있음, 이 배치가 건드리지 않음).
 *
 *  1) 분류는 규칙 먼저(`classifyInquiryText`). 규칙이 '기타' 이고 LLM 이 실연동이면 보조로 묻는다(본문은 maskForLlm 으로 가림).
 *     자동 답변은 **규칙으로 정해진 분류**에서만 한다(LLM 분류만으로 자동 답변하지 않음).
 *  2) 정해진 답이 있는 분류(영수증·내역·정기 변경·연락처 변경)는 기관이 그 분류의 "자동 답변" 을 켰을 때만(기본 꺼짐)
 *     기관 서식으로 **문의당 1회** 답하고 "자동 답변됨"(CLOSED)으로 닫는다. 후원자가 다시 쓰면 담당자에게 간다.
 *  3) 그 밖(불만·환불·법적·기타, 자동 답변 꺼짐, 재문의)은 담당자에게: 지난 이력 요약(숫자·날짜만) + 처리 기한(기관 설정,
 *     기본 2영업일, 공휴일 표) + 승인 대기함 묶음 "답변이 필요한 문의" + 1차 C 담당·기한(inbox_assignment `inquiry:{id}`) —
 *     기한을 넘기면 inbox 배치가 기관 소유자에게 알린다. 답변 초안은 기존 AI 초안(draftInquiryReply, 입력칸 채우기만)을 쓴다.
 *  4) 처리는 배치(`/api/cron/inquiry-auto`)가 한다. 문의 행 선점(triage_locked_at) + 마지막 메시지 시각 조건부 갱신이라
 *     겹친 배치·동시 재문의에도 한 번만 답한다.
 */

export const INQUIRY_CATEGORIES = ['RECEIPT', 'RECURRING', 'CONTACT', 'HISTORY', 'COMPLAINT', 'REFUND', 'LEGAL', 'OTHER'] as const;
export type InquiryCategory = (typeof INQUIRY_CATEGORIES)[number];

export const INQUIRY_CATEGORY_LABEL: Record<InquiryCategory, string> = {
  RECEIPT: '영수증',
  RECURRING: '정기후원 변경·해지',
  CONTACT: '주소·연락처 변경',
  HISTORY: '후원 내역',
  COMPLAINT: '불만',
  REFUND: '환불',
  LEGAL: '법적 문제',
  OTHER: '기타',
};

/** 정해진 답이 있는 분류(기관이 켜야 자동 답변) */
export const AUTO_ANSWER_CATEGORIES = ['RECEIPT', 'HISTORY', 'RECURRING', 'CONTACT'] as const;
export type AutoAnswerCategory = (typeof AUTO_ANSWER_CATEGORIES)[number];
export const isAutoAnswerCategory = (c: string): c is AutoAnswerCategory => (AUTO_ANSWER_CATEGORIES as readonly string[]).includes(c);

export const DEFAULT_DUE_BUSINESS_DAYS = 2;
export const TRIAGE_LOCK_MS = 5 * 60_000;

/** 머지 필드: {기관명} {발급월} {링크} */
export const INQUIRY_MERGE_FIELDS = ['{기관명}', '{발급월}', '{링크}'] as const;

export const DEFAULT_AUTO_TEMPLATES: Record<AutoAnswerCategory, string> = {
  RECEIPT:
    '안녕하세요, {기관명}입니다. 기부금영수증은 {발급월}에 발급합니다. 영수증에 필요한 정보(성명·주민등록번호) 등록과 발급 내역은 아래 화면에서 보실 수 있습니다.\n{링크}\n더 궁금한 점이 있으면 이 문의에 다시 남겨 주세요. 담당자가 확인해 답해 드립니다.',
  HISTORY:
    '안녕하세요, {기관명}입니다. 후원 내역은 아래 화면에서 연도별로 보실 수 있습니다.\n{링크}\n더 궁금한 점이 있으면 이 문의에 다시 남겨 주세요. 담당자가 확인해 답해 드립니다.',
  RECURRING:
    '안녕하세요, {기관명}입니다. 정기후원 금액·출금일 변경, 일시정지, 해지는 아래 화면에서 본인 확인(인증번호) 후 직접 하실 수 있습니다. 기관 번호로 "변경" 또는 "해지" 라고 문자를 보내셔도 됩니다.\n{링크}\n더 궁금한 점이 있으면 이 문의에 다시 남겨 주세요.',
  CONTACT:
    '안녕하세요, {기관명}입니다. 주소·연락처 변경은 아래 화면의 설정에서 하실 수 있습니다. 휴대폰 번호가 바뀐 경우 새 번호로 다시 인증해 주세요.\n{링크}\n더 궁금한 점이 있으면 이 문의에 다시 남겨 주세요.',
};

const SELF_SERVICE_PATH: Record<AutoAnswerCategory, string> = {
  RECEIPT: '/my/receipts',
  HISTORY: '/my',
  RECURRING: '/my/recurring',
  CONTACT: '/my/settings',
};

// ---------------------------------------------------------------------------
// 분류
// ---------------------------------------------------------------------------

/** 순서가 우선순위다: 사람이 봐야 하는 분류(법적·환불·불만)가 먼저. */
const RULES: Array<{ category: InquiryCategory; re: RegExp }> = [
  { category: 'LEGAL', re: /(소송|고소|고발|변호사|법적|법원|경찰|소비자원|공정위|금감원|내용증명|신고하겠|신고할)/u },
  { category: 'REFUND', re: /(환불|환급|돌려\s*(주|받)|반환|잘못\s*(결제|출금|빠져|나갔)|이중\s*(결제|출금)|두\s*번\s*(결제|출금|빠져))/u },
  { category: 'COMPLAINT', re: /(불만|화가|화나|짜증|어이\s*없|황당|불친절|항의|실망|기분\s*나쁘|사기|최악|답답)/u },
  { category: 'RECURRING', re: /((정기|매월|매달|자동\s*이체|출금일|약정).{0,20}(변경|바꾸|바꿔|해지|중단|그만|멈추|멈춰|줄이|늘리|날짜|일시\s*정지))|(정기\s*후원\s*(해지|변경|중단))|^\s*(해지|중단)/u },
  { category: 'RECEIPT', re: /(영수증|연말\s*정산|소득\s*공제|세액\s*공제|기부금\s*공제)/u },
  { category: 'CONTACT', re: /(주소|연락처|전화\s*번호|휴대\s*폰\s*번호|핸드폰\s*번호|이메일).{0,15}(변경|바꾸|바꿔|바뀌|수정|틀렸|잘못)|번호가\s*바뀌/u },
  { category: 'HISTORY', re: /(후원\s*내역|기부\s*내역|결제\s*내역|내역\s*(확인|조회|보고)|얼마\s*(나|를)?\s*후원|후원\s*(한|했던)\s*(금액|기록)|후원\s*기록)/u },
];

export function classifyInquiryText(text: string): InquiryCategory {
  const t = (text ?? '').normalize('NFKC');
  for (const r of RULES) if (r.re.test(t)) return r.category;
  return 'OTHER';
}

/**
 * 분류(규칙 → LLM 보조). LLM 에는 maskForLlm 으로 가린 본문만 보낸다.
 * LLM 분류 결과는 담당자 화면 표시용이고, 자동 답변 판단에는 쓰지 않는다(호출부가 by 로 구분).
 */
export async function classifyInquiry(text: string, opts: { merchantId?: string | null; adapter?: LlmAdapter } = {}): Promise<{ category: InquiryCategory; by: 'RULE' | 'LLM' }> {
  const rule = classifyInquiryText(text);
  if (rule !== 'OTHER') return { category: rule, by: 'RULE' };
  const adapter = opts.adapter ?? getLlmAdapter();
  if (!llmUsable(adapter)) return { category: 'OTHER', by: 'RULE' };
  const info = adapter.info();
  try {
    const { value } = await completeJson(
      adapter,
      {
        system: '사회복지기관 후원자 문의를 분류한다. 개인정보를 추측하거나 만들지 않는다.',
        user: [
          `분류는 ${INQUIRY_CATEGORIES.join('|')} 중 하나다 (영수증·정기후원 변경/해지·주소/연락처 변경·후원 내역·불만·환불·법적·기타).`,
          '[문의]',
          maskForLlm(text).slice(0, 1500),
          '',
          '출력 JSON: {"category": "OTHER"}',
        ].join('\n'),
        json: true,
        maxTokens: 100,
        mockText: '{"category":"OTHER"}',
      },
      (d) => {
        const c = String(d.category ?? '').toUpperCase();
        return (INQUIRY_CATEGORIES as readonly string[]).includes(c) ? { ok: true, value: c as InquiryCategory } : { ok: false, reason: 'category 값' };
      },
      (a) => recordAiUsage({ merchantId: opts.merchantId ?? null, feature: 'inquiry_draft', provider: info.provider, model: info.model, usage: a.usage, ok: a.ok }).then(() => undefined),
    );
    return { category: value, by: 'LLM' };
  } catch (e) {
    logger.warn('문의 LLM 분류 실패 — 기타로 둡니다', { message: (e as Error).message.slice(0, 120) });
    return { category: 'OTHER', by: 'RULE' };
  }
}

// ---------------------------------------------------------------------------
// 기관 설정
// ---------------------------------------------------------------------------

export class InquiryAutoError extends Error {}

export interface InquiryAutoSettingView {
  autoCategories: AutoAnswerCategory[];
  templates: Record<AutoAnswerCategory, string>;
  customized: Record<AutoAnswerCategory, boolean>;
  dueBusinessDays: number;
}

export async function getInquiryAutoSetting(merchantId: string): Promise<InquiryAutoSettingView> {
  const row = await prisma.inquiryAutoSetting.findUnique({ where: { merchantId } });
  const saved = (row?.templates ?? {}) as Record<string, unknown>;
  const templates = {} as Record<AutoAnswerCategory, string>;
  const customized = {} as Record<AutoAnswerCategory, boolean>;
  for (const c of AUTO_ANSWER_CATEGORIES) {
    const v = typeof saved[c] === 'string' && (saved[c] as string).trim() ? (saved[c] as string) : null;
    templates[c] = v ?? DEFAULT_AUTO_TEMPLATES[c];
    customized[c] = Boolean(v);
  }
  return {
    autoCategories: (row?.autoCategories ?? []).filter(isAutoAnswerCategory),
    templates,
    customized,
    dueBusinessDays: row?.dueBusinessDays ?? DEFAULT_DUE_BUSINESS_DAYS,
  };
}

/** 서식 검사: 1,000자, 후원 권유 문구 금지(정보성만), {링크} 외 주소 금지 */
export function validateAutoTemplate(text: string): string | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  if (t.length > 1000) return '답변 서식은 1,000자 이내로 써 주세요.';
  if (/https?:\/\//i.test(t)) return '주소는 직접 쓰지 말고 {링크} 를 써 주세요. 기브싸인이 후원자 화면 주소를 넣습니다.';
  const hit = solicitationHit(t);
  if (hit) return `자동 답변은 안내(정보성)만 보낼 수 있습니다. 후원 권유 문구를 빼 주세요: "${hit}"`;
  return null;
}

export async function saveInquiryAutoSetting(
  merchantId: string,
  input: { autoCategories: string[]; templates: Record<string, string>; dueBusinessDays: number },
  userId: string,
) {
  const autoCategories = [...new Set(input.autoCategories.filter(isAutoAnswerCategory))];
  const templates: Record<string, string> = {};
  for (const c of AUTO_ANSWER_CATEGORIES) {
    const raw = (input.templates[c] ?? '').trim();
    const bad = validateAutoTemplate(raw);
    if (bad) throw new InquiryAutoError(`${INQUIRY_CATEGORY_LABEL[c]}: ${bad}`);
    if (raw && raw !== DEFAULT_AUTO_TEMPLATES[c]) templates[c] = raw;
  }
  const due = Math.trunc(input.dueBusinessDays);
  if (!Number.isFinite(due) || due < 1 || due > 10) throw new InquiryAutoError('처리 기한은 1~10영업일로 정해 주세요.');
  await prisma.inquiryAutoSetting.upsert({
    where: { merchantId },
    create: { merchantId, autoCategories, templates, dueBusinessDays: due, updatedBy: userId },
    update: { autoCategories, templates, dueBusinessDays: due, updatedBy: userId },
  });
}

export function renderAutoAnswer(template: string, vars: { merchantName: string; receiptMonth: string; link: string }): string {
  return template.split('{기관명}').join(vars.merchantName).split('{발급월}').join(vars.receiptMonth).split('{링크}').join(vars.link);
}

function monthText(month: string) {
  const [y, m] = month.split('-');
  return `${y}년 ${Number(m)}월`;
}

// ---------------------------------------------------------------------------
// 접수 (문자 '문의' 명령 링크)
// ---------------------------------------------------------------------------

/**
 * 그 기관에 문의를 남긴다. (기관, 후원자)당 스레드 하나를 이어 쓴다. 새 메시지가 오면 OPEN 으로 돌아가고 배치가 분류한다.
 * 회신 연락처는 그 번호(암호문·마스킹). 채팅 위젯에서 답을 볼 수 있게 게스트 토큰을 새로 준다(원문은 쿠키, DB 는 해시).
 */
export async function submitMerchantInquiry(input: { merchantId: string; payerId: string; phone: string; body: string }): Promise<{ inquiryId: string; guestToken: string }> {
  const body = (input.body ?? '').trim();
  if (body.length < 2) throw new InquiryAutoError('문의 내용을 입력해 주세요.');
  if (body.length > 1000) throw new InquiryAutoError('문의 내용은 1,000자 이내로 입력해 주세요.');
  const now = new Date();
  const guest = newGuestInquiryToken();
  const existing = await prisma.supportInquiry.findFirst({
    where: { handledBy: 'MERCHANT', merchantId: input.merchantId, payerId: input.payerId },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  const inquiryId = existing?.id ?? newId();
  await prisma.$transaction(async (tx) => {
    if (existing) {
      await tx.supportInquiry.update({ where: { id: existing.id }, data: { status: 'OPEN', lastMessageAt: now, guestToken: guest.stored } });
    } else {
      await tx.supportInquiry.create({
        data: {
          id: inquiryId,
          guestToken: guest.stored,
          contactEnc: encrypt(input.phone),
          contactMasked: maskPhone(input.phone),
          category: '기관 문의',
          status: 'OPEN',
          merchantId: input.merchantId,
          source: 'SMS',
          handledBy: 'MERCHANT',
          payerId: input.payerId,
          lastMessageAt: now,
        },
      });
    }
    await tx.supportMessage.create({ data: { id: newId(), inquiryId, sender: 'USER', body, createdAt: now } });
  });
  return { inquiryId, guestToken: guest.token };
}

// ---------------------------------------------------------------------------
// 지난 이력 요약 (숫자·날짜만)
// ---------------------------------------------------------------------------

export interface InquiryHistorySummary {
  paidCount: number;
  paidAmount: string;
  firstPaidOn: string | null;
  lastPaidOn: string | null;
  refundCount: number;
  activeRecurring: number;
  recurringMonthly: string;
  receiptsIssued: number;
  previousMessages: number;
}

export async function inquiryHistorySummary(merchantId: string, payerId: string, inquiryId?: string): Promise<InquiryHistorySummary> {
  const paid = { merchantId, payerId, status: { in: PAID_STATUSES }, isTest: false } as const;
  const [agg, first, last, refunds, recurring, receipts, messages] = await Promise.all([
    prisma.charge.aggregate({ where: paid, _sum: { amount: true }, _count: { _all: true } }),
    prisma.charge.findFirst({ where: { ...paid, paidAt: { not: null } }, orderBy: { paidAt: 'asc' }, select: { paidAt: true } }),
    prisma.charge.findFirst({ where: { ...paid, paidAt: { not: null } }, orderBy: { paidAt: 'desc' }, select: { paidAt: true } }),
    prisma.refund.count({ where: { charge: { merchantId, payerId } } }),
    prisma.recurringDonation.aggregate({ where: { merchantId, payerId, status: 'ACTIVE' }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.donationReceipt.count({ where: { merchantId, payerId, status: 'ISSUED' } }),
    inquiryId ? prisma.supportMessage.count({ where: { inquiryId, sender: 'USER' } }) : Promise.resolve(0),
  ]);
  return {
    paidCount: agg._count._all,
    paidAmount: (agg._sum.amount ?? 0n).toString(),
    firstPaidOn: first?.paidAt ? kstDateKey(first.paidAt) : null,
    lastPaidOn: last?.paidAt ? kstDateKey(last.paidAt) : null,
    refundCount: refunds,
    activeRecurring: recurring._count._all,
    recurringMonthly: (recurring._sum.amount ?? 0n).toString(),
    receiptsIssued: receipts,
    previousMessages: Math.max(0, messages - 1),
  };
}

export function readHistorySummary(v: unknown): InquiryHistorySummary | null {
  if (!v || typeof v !== 'object') return null;
  return v as InquiryHistorySummary;
}

// ---------------------------------------------------------------------------
// 처리 기한
// ---------------------------------------------------------------------------

/** from(KST 날짜) 기준 n 영업일 뒤 그날 끝(23:59:59 KST). 공휴일 표(public_holiday) 사용. */
export async function inquiryDueAt(from: Date, businessDays: number): Promise<Date> {
  const key = kstDateKey(from);
  const holidays = await loadHolidays(key, addDaysKey(key, 40));
  const dueKey = addBusinessDays(key, businessDays, holidays);
  return new Date(`${dueKey}T23:59:59.000+09:00`);
}

// ---------------------------------------------------------------------------
// 배치: 분류 → 자동 답변 또는 담당자에게
// ---------------------------------------------------------------------------

export interface TriageResult {
  checked: number;
  autoAnswered: number;
  toStaff: number;
  skipped: number;
}

/** 새 메시지가 있는 기관 응대 문의를 처리한다. */
export async function processInquiryTriage(opts: { now?: Date; adapter?: LlmAdapter; limit?: number; deadline?: number } = {}): Promise<TriageResult> {
  const now = opts.now ?? new Date();
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM support_inquiry
     WHERE handled_by = 'MERCHANT' AND status::text = 'OPEN' AND merchant_id IS NOT NULL
       AND (triaged_at IS NULL OR triaged_at < last_message_at)
     ORDER BY last_message_at ASC
     LIMIT ${opts.limit ?? 100}`;
  const result: TriageResult = { checked: rows.length, autoAnswered: 0, toStaff: 0, skipped: 0 };
  for (const r of rows) {
    if (opts.deadline && Date.now() > opts.deadline) break;
    try {
      const outcome = await triageInquiry(r.id, { now, adapter: opts.adapter });
      if (outcome === 'AUTO') result.autoAnswered += 1;
      else if (outcome === 'STAFF') result.toStaff += 1;
      else result.skipped += 1;
    } catch (e) {
      result.skipped += 1;
      logger.warn('문의 자동 응대 처리 실패', { inquiryId: r.id, message: (e as Error).message });
    }
  }
  return result;
}

export async function triageInquiry(inquiryId: string, opts: { now?: Date; adapter?: LlmAdapter } = {}): Promise<'AUTO' | 'STAFF' | 'SKIP'> {
  const now = opts.now ?? new Date();
  const lockAt = new Date();
  // 선점: 새 메시지가 있고 다른 배치가 잡고 있지 않을 때만(5분 넘은 선점은 버려진 것으로 본다)
  const claimed = await prisma.$queryRaw<Array<{ id: string }>>`
    UPDATE support_inquiry SET triage_locked_at = ${lockAt}
     WHERE id = ${inquiryId} AND handled_by = 'MERCHANT' AND status::text = 'OPEN'
       AND (triaged_at IS NULL OR triaged_at < last_message_at)
       AND (triage_locked_at IS NULL OR triage_locked_at < ${new Date(lockAt.getTime() - TRIAGE_LOCK_MS)})
     RETURNING id`;
  if (claimed.length === 0) return 'SKIP';
  const release = () => prisma.supportInquiry.updateMany({ where: { id: inquiryId, triageLockedAt: lockAt }, data: { triageLockedAt: null } });

  try {
    const inq = await prisma.supportInquiry.findUniqueOrThrow({ where: { id: inquiryId } });
    if (!inq.merchantId) {
      await release();
      return 'SKIP';
    }
    const newMessages = await prisma.supportMessage.findMany({
      where: { inquiryId, sender: 'USER', ...(inq.triagedAt ? { createdAt: { gt: inq.triagedAt } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { body: true },
    });
    const text = newMessages.reverse().map((m) => m.body).join('\n');
    const cls = await classifyInquiry(text, { merchantId: inq.merchantId, adapter: opts.adapter });
    const setting = await getInquiryAutoSetting(inq.merchantId);

    const canAuto = !inq.autoAnsweredAt && cls.by === 'RULE' && isAutoAnswerCategory(cls.category) && setting.autoCategories.includes(cls.category);
    if (canAuto) {
      const merchant = await prisma.merchantProfile.findUniqueOrThrow({ where: { id: inq.merchantId }, select: { code: true, displayName: true, receiptCycle: true } });
      const category = cls.category as AutoAnswerCategory;
      const body = renderAutoAnswer(setting.templates[category], {
        merchantName: merchant.displayName,
        receiptMonth: monthText(receiptScheduleNote(merchant.receiptCycle, now).month),
        link: `${env.baseUrl}/donate/${merchant.code}${SELF_SERVICE_PATH[category]}`,
      });
      const answered = await prisma.$transaction(async (tx) => {
        // 문의당 1회 + 읽은 뒤 새 메시지가 왔으면 답하지 않는다(그 메시지를 닫아 버리지 않게)
        const claim = await tx.supportInquiry.updateMany({
          where: { id: inquiryId, autoAnsweredAt: null, status: 'OPEN', lastMessageAt: inq.lastMessageAt, triageLockedAt: lockAt },
          data: { autoAnsweredAt: now, status: 'CLOSED', autoCategory: category, autoCategoryBy: 'RULE', triagedAt: inq.lastMessageAt, triageLockedAt: null, needsStaffAt: null, dueAt: null },
        });
        if (claim.count !== 1) return false;
        await tx.supportMessage.create({ data: { id: newId(), inquiryId, sender: 'ADMIN', authorKind: 'AUTO', body, readByAdminAt: now } });
        return true;
      });
      if (!answered) {
        await release();
        return 'SKIP';
      }
      await notifyInquiryAnswer(inquiryId, body);
      return 'AUTO';
    }

    // 담당자에게
    const firstTime = !inq.needsStaffAt;
    const dueAt = inq.dueAt ?? (await inquiryDueAt(now, setting.dueBusinessDays));
    const summary = inq.payerId ? await inquiryHistorySummary(inq.merchantId, inq.payerId, inquiryId) : null;
    const updated = await prisma.supportInquiry.updateMany({
      where: { id: inquiryId, triageLockedAt: lockAt, lastMessageAt: inq.lastMessageAt },
      data: {
        autoCategory: cls.category,
        autoCategoryBy: cls.by,
        needsStaffAt: inq.needsStaffAt ?? now,
        dueAt,
        historySummary: (summary ?? undefined) as object | undefined,
        triagedAt: inq.lastMessageAt,
        triageLockedAt: null,
      },
    });
    if (updated.count !== 1) {
      await release();
      return 'SKIP';
    }
    if (firstTime) await assignInquiryDue(inq.merchantId, inquiryId, dueAt, cls.category);
    return 'STAFF';
  } catch (e) {
    await release().catch(() => undefined);
    throw e;
  }
}

/** 1차 C 담당·기한 기구: 항목 키 `inquiry:{id}`. 기한을 넘기면 inbox 배치가 기관 소유자에게 알린다. */
async function assignInquiryDue(merchantId: string, inquiryId: string, dueAt: Date, category: InquiryCategory) {
  try {
    const { saveInboxAssignment } = await import('./inbox-assignments');
    await saveInboxAssignment({ merchantId, userId: 'system', itemKey: `inquiry:${inquiryId}`, dueAt, memo: `문의 답변 필요 (${INQUIRY_CATEGORY_LABEL[category]})` });
    const m = await prisma.merchantProfile.findUnique({ where: { id: merchantId }, select: { userId: true } });
    if (m) await notifyUser({ userId: m.userId, title: '답변이 필요한 문의가 있습니다', body: `분류: ${INQUIRY_CATEGORY_LABEL[category]}. 문의 응대 화면에서 확인해 주세요.`, linkUrl: `/studio/inquiries/${inquiryId}` });
  } catch (e) {
    logger.warn('문의 처리 기한 배정 실패', { inquiryId, message: (e as Error).message });
  }
}

/** 문자로 접수한 문의(기관 응대)의 답변을 그 번호로 알린다(정보성). 실패해도 답변은 남는다. */
export async function notifyInquiryAnswer(inquiryId: string, body: string): Promise<boolean> {
  try {
    const inq = await prisma.supportInquiry.findUnique({ where: { id: inquiryId }, select: { handledBy: true, merchantId: true, payerId: true, contactEnc: true } });
    if (!inq || inq.handledBy !== 'MERCHANT' || !inq.merchantId) return false;
    const payer = inq.payerId ? await prisma.payerProfile.findUnique({ where: { id: inq.payerId }, select: { phoneEnc: true, onboardingStatus: true } }) : null;
    const phoneEnc = payer && payer.onboardingStatus !== 'WITHDRAWN' ? payer.phoneEnc : inq.contactEnc;
    if (!phoneEnc) return false;
    const merchant = await prisma.merchantProfile.findUnique({ where: { id: inq.merchantId }, select: { displayName: true } });
    const { sendMt } = await import('./charge-flow');
    return await sendMt({ phone: decrypt(phoneEnc), template: tpl.tplInquiryAnswer({ merchantName: merchant?.displayName ?? '기관', body }), merchantId: inq.merchantId });
  } catch (e) {
    logger.warn('문의 답변 문자 실패', { inquiryId, message: (e as Error).message });
    return false;
  }
}

// ---------------------------------------------------------------------------
// 기관 콘솔
// ---------------------------------------------------------------------------

export async function listMerchantInquiries(merchantId: string, filter: 'needs' | 'all' = 'needs') {
  return prisma.supportInquiry.findMany({
    where: { merchantId, handledBy: 'MERCHANT', ...(filter === 'needs' ? { status: 'OPEN' } : {}) },
    orderBy: [{ dueAt: 'asc' }, { lastMessageAt: 'desc' }],
    take: 100,
    select: {
      id: true, status: true, autoCategory: true, autoCategoryBy: true, autoAnsweredAt: true, needsStaffAt: true, dueAt: true,
      lastMessageAt: true, createdAt: true, contactMasked: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { body: true, sender: true, authorKind: true } },
    },
  });
}

export async function getMerchantInquiry(merchantId: string, inquiryId: string) {
  return prisma.supportInquiry.findFirst({
    where: { id: inquiryId, merchantId, handledBy: 'MERCHANT' },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: 200 } },
  });
}

/** 기관 담당자 답변 → ANSWERED, 기한·배정 닫기, 문자로 알림 */
export async function replyAsMerchant(input: { merchantId: string; inquiryId: string; body: string; userId: string }) {
  const body = (input.body ?? '').trim();
  if (!body) throw new InquiryAutoError('답변 내용을 입력해 주세요.');
  if (body.length > 2000) throw new InquiryAutoError('답변은 2,000자 이내로 입력해 주세요.');
  const inq = await prisma.supportInquiry.findFirst({ where: { id: input.inquiryId, merchantId: input.merchantId, handledBy: 'MERCHANT' }, select: { id: true } });
  if (!inq) throw new InquiryAutoError('문의를 찾을 수 없습니다.');
  const now = new Date();
  await prisma.$transaction([
    prisma.supportMessage.create({ data: { id: newId(), inquiryId: inq.id, sender: 'ADMIN', authorKind: 'MERCHANT', body, readByAdminAt: now } }),
    prisma.supportInquiry.update({ where: { id: inq.id }, data: { status: 'ANSWERED', lastMessageAt: now, triagedAt: now, needsStaffAt: null, dueAt: null } }),
    prisma.supportMessage.updateMany({ where: { inquiryId: inq.id, sender: 'USER', readByAdminAt: null }, data: { readByAdminAt: now } }),
    prisma.inboxAssignment.updateMany({ where: { merchantId: input.merchantId, itemKey: `inquiry:${inq.id}`, resolvedAt: null }, data: { resolvedAt: now } }),
  ]);
  await notifyInquiryAnswer(inq.id, body);
}

/** 답변 없이 닫기(담당자 판단) */
export async function closeAsMerchant(merchantId: string, inquiryId: string) {
  const now = new Date();
  const r = await prisma.supportInquiry.updateMany({ where: { id: inquiryId, merchantId, handledBy: 'MERCHANT' }, data: { status: 'CLOSED', needsStaffAt: null, dueAt: null, triagedAt: now } });
  if (r.count !== 1) throw new InquiryAutoError('문의를 찾을 수 없습니다.');
  await prisma.inboxAssignment.updateMany({ where: { merchantId, itemKey: `inquiry:${inquiryId}`, resolvedAt: null }, data: { resolvedAt: now } });
}

/** 승인 대기함 묶음 "답변이 필요한 문의" */
export async function inquiryReplyInboxGroup(merchantId: string, now = new Date()): Promise<InboxExceptionGroup | null> {
  const rows = await prisma.supportInquiry.findMany({
    where: { merchantId, handledBy: 'MERCHANT', status: 'OPEN', needsStaffAt: { not: null } },
    select: { needsStaffAt: true, dueAt: true, autoCategory: true },
  });
  if (rows.length === 0) return null;
  const overdue = rows.filter((r) => r.dueAt && r.dueAt.getTime() < now.getTime()).length;
  const kinds = [...new Set(rows.map((r) => INQUIRY_CATEGORY_LABEL[(r.autoCategory as InquiryCategory) ?? 'OTHER'] ?? '기타'))].slice(0, 4).join('·');
  return {
    kind: 'inquiry-reply',
    title: `답변이 필요한 문의 ${rows.length}건`,
    reason: `${kinds} 문의는 담당자가 직접 답해야 합니다.${overdue ? ` 처리 기한이 지난 문의 ${overdue}건.` : ''}`,
    affectedCount: rows.length,
    oldestAt: rows.reduce((m, r) => (r.needsStaffAt! < m ? r.needsStaffAt! : m), rows[0]!.needsStaffAt!),
    href: '/studio/inquiries',
    recommendedAction: '지난 이력 요약과 답변 초안을 보고 답해 주세요',
    actions: [],
    severity: overdue ? 'high' : 'normal',
  };
}
