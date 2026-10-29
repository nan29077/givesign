import { prisma } from '@/server/db';
import { newId } from '@/lib/id';
import { decrypt, merchantPayerRef } from '@/lib/crypto';
import { logger } from '@/lib/logger';
import { kstStartOfDay } from '@/lib/datetime';
import { filterContent } from './content-filter';
import { loadBannedWords, sendMtDetailed } from './charge-flow';
import { MT_TEMPLATE } from './mt-templates';
import type { MerchantMtTemplate } from '@/generated/prisma/client';

/**
 * 사회복지기관 MT 발송 v1.
 *
 * 사회복지기관이 자기 후원자에게 **거래 안내 문자**를 보내는 기능이다.
 * 처음 여는 v1 은 아래 네 가지로 범위를 좁혔다.
 *
 *  1. 발신번호는 기브싸인 번호 고정 — 사회복지기관이 발신번호를 사전등록하지 않아도 된다
 *  2. 정보성 문자만 — 광고·홍보는 등록 단계에서 걸러 사람이 본다
 *  3. 수신자는 그 사회복지기관에 거래 이력이 있는 후원자만 — 콜드 발송이 원천 차단된다
 *  4. 등록해 검수 통과한 템플릿만 — 자유 본문은 보낼 수 없다
 *
 * 이 네 가지가 있으면 광고성 정보에 붙는 사전 동의·야간 발송 제한·수신거부 의무가
 * 적용 대상이 아니게 된다. 제약을 푸는 순간 그 의무가 전부 따라오므로,
 * 넓힐 때는 규제 검토를 함께 해야 한다.
 */

/** 본문 최대 길이. LMS 안에 확실히 들어가는 보수적인 값. */
export const MERCHANT_MT_MAX_LENGTH = 200;

/** 템플릿 코드 형식. 사회복지기관이 자기 시스템에서 부르는 이름이다. */
const CODE_RE = /^[A-Za-z0-9_-]{2,40}$/;

/** 사회복지기관당 등록할 수 있는 템플릿 수. */
export const MERCHANT_MT_TEMPLATE_MAX = 30;

/**
 * 사회복지기관당 하루 발송 한도. 넘으면 다음 날까지 막힌다.
 *
 * 환경변수에 숫자가 아닌 값이 들어오면 NaN 이 되고, `remaining <= 0` 비교가 항상 false 라
 * **한도가 통째로 사라진다.** 잘못 적은 값은 조용히 기본값으로 되돌린다.
 */
export const MERCHANT_MT_DAILY_LIMIT = (() => {
  const raw = Number(process.env.MERCHANT_MT_DAILY_LIMIT ?? 500);
  return Number.isInteger(raw) && raw > 0 ? raw : 500;
})();

/** 본문에서 시스템이 자동으로 채우는 치환자. 사회복지기관이 값을 보내지 않아도 된다. */
const SYSTEM_TOKENS = ['사회복지기관'] as const;

/**
 * 광고·홍보로 읽히는 표현.
 *
 * 하나라도 걸리면 자동 승인하지 않고 사람이 본다(PENDING).
 * 완벽한 판별기가 아니라 **거르는 그물**이다. 놓친 것은 관리자가 발송 이력에서 잡는다.
 * 정보성 문자만 허용한다는 전제가 깨지면 규제 세트가 통째로 따라오므로 넉넉히 잡는다.
 */
const AD_PATTERNS = [
  '광고', '할인', '세일', '특가', '이벤트', '쿠폰', '적립금 지급', '프로모션', '홍보',
  '무료체험', '무료 체험', '당첨', '경품', '초대합니다', '가입하세요', '지금 구매',
  '오픈기념', '오픈 기념', '한정판매', '한정 판매', '마감임박', '마감 임박', '최저가',
  '％할인', '%할인', '% 할인', '이월상품', '떨이',
];

export interface TemplateReview {
  /** 저장해도 되는지. false 면 아예 저장하지 않는다. */
  ok: boolean;
  /** 저장 거부 사유(ok=false). */
  message?: string;
  /** 저장할 때의 상태. 광고성 의심이면 PENDING 으로 두고 사람이 본다. */
  status: 'APPROVED' | 'PENDING';
  /** 보류 사유(status=PENDING). */
  reviewNote?: string;
  /** 본문에서 뽑은 치환자 이름(시스템 치환자 제외). */
  variables: string[];
}

/** 본문에 쓰인 `{이름}` 치환자를 뽑는다. 시스템이 채우는 것은 제외한다. */
export function extractVariables(body: string): string[] {
  const names = [...body.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim()).filter(Boolean);
  const unique = [...new Set(names)];
  return unique.filter((n) => !SYSTEM_TOKENS.includes(n as (typeof SYSTEM_TOKENS)[number]));
}

/**
 * 등록 시점 검수.
 *
 * 검수는 여기서 한 번만 한다. 통과한 템플릿은 발송 때 다시 검사하지 않는다 —
 * 발송마다 검사하면 지연이 쌓이고, 기준이 바뀌었을 때 이미 쓰던 템플릿이 갑자기 막혀
 * 사회복지기관 서비스가 멈춘다.
 */
export async function reviewTemplateBody(merchantId: string, rawBody: string): Promise<TemplateReview> {
  const body = rawBody.trim();

  if (!body) {
    return { ok: false, message: '본문을 입력해 주세요.', status: 'PENDING', variables: [] };
  }
  if (body.length > MERCHANT_MT_MAX_LENGTH) {
    return {
      ok: false,
      message: `본문은 ${MERCHANT_MT_MAX_LENGTH}자 이내여야 합니다. (현재 ${body.length}자)`,
      status: 'PENDING',
      variables: [],
    };
  }
  // 링크가 들어간 문자는 통신사 스팸 필터에 걸리고, 후원자는 피싱으로 오인한다.
  if (/https?:\/\/|www\./i.test(body)) {
    return { ok: false, message: '문자 본문에는 링크를 넣을 수 없습니다.', status: 'PENDING', variables: [] };
  }
  // 짝이 맞지 않는 중괄호는 치환에 실패해 후원자에게 `{이름}` 이 그대로 나간다.
  if ((body.match(/\{/g)?.length ?? 0) !== (body.match(/\}/g)?.length ?? 0)) {
    return { ok: false, message: '치환자의 중괄호 짝이 맞지 않습니다.', status: 'PENDING', variables: [] };
  }

  const variables = extractVariables(body);
  if (variables.length > 10) {
    return { ok: false, message: '치환자는 10개까지 쓸 수 있습니다.', status: 'PENDING', variables: [] };
  }

  const rules = await loadBannedWords(merchantId);
  const filtered = filterContent(body, { bannedWords: rules, maxLength: MERCHANT_MT_MAX_LENGTH });
  if (filtered.containsPersonalInfo) {
    return {
      ok: false,
      message: '전화번호·계좌번호·이메일 같은 개인정보는 문자 본문에 넣을 수 없습니다.',
      status: 'PENDING',
      variables,
    };
  }
  if (filtered.flagged.length > 0) {
    return {
      ok: true,
      status: 'PENDING',
      reviewNote: `금칙어가 포함되어 검수 대기로 등록했습니다: ${filtered.flagged.slice(0, 3).join(', ')}`,
      variables,
    };
  }

  const hit = AD_PATTERNS.find((word) => body.includes(word));
  if (hit) {
    return {
      ok: true,
      status: 'PENDING',
      reviewNote:
        `광고·홍보 표현으로 보이는 말이 있어 검수 대기로 등록했습니다: "${hit}". ` +
        'v1 은 거래·주문·지급과 직접 관련된 안내만 보낼 수 있습니다. 광고성 발송은 별도 계약이 필요합니다.',
      variables,
    };
  }

  return { ok: true, status: 'APPROVED', variables };
}

/** 치환값 하나의 최대 길이. 상품명·주문번호·날짜를 담기엔 넉넉하고, 문장을 밀어 넣기엔 짧다. */
export const MERCHANT_MT_VARIABLE_MAX_LENGTH = 40;

/**
 * 치환값 검수.
 *
 * 검수는 등록 시점 한 번(`reviewTemplateBody`)이라는 원칙은 **본문**에 대한 것이다.
 * 치환값은 발송할 때마다 사회복지기관이 새로 보내는 값이라 등록 시점에 볼 수가 없다.
 * 그래서 여기서만은 발송할 때 본다.
 *
 * 이 검사가 없으면 "{사회복지기관} 주문하신 {상품} 이(가) 발송되었습니다" 처럼 무해하게 승인받은
 * 템플릿의 `{상품}` 자리에 광고 문구와 단축 URL 을 넣어, 기브싸인 발신 이름으로 광고
 * 문자를 보낼 수 있다. 정보성 문자만 보낸다는 전제가 깨지면 광고 표기·수신거부 의무가
 * 통째로 따라오고, 그 책임은 발신자인 기브싸인가 진다.
 *
 * 본문 검수와 달리 여기서는 광고 표현도 **거부**한다. 보류시킬 사람이 없기 때문이다.
 */
export async function reviewVariableValues(
  merchantId: string,
  values: Record<string, string>,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const entries = Object.entries(values);
  if (entries.length === 0) return { ok: true };

  for (const [name, value] of entries) {
    if (value.length > MERCHANT_MT_VARIABLE_MAX_LENGTH) {
      return {
        ok: false,
        message: `치환값 "${name}" 이 너무 깁니다. ${MERCHANT_MT_VARIABLE_MAX_LENGTH}자 이내로 보내 주세요.`,
      };
    }
    // 줄바꿈을 넣으면 한 문자 안에 다른 안내문을 덧붙인 것처럼 보이게 만들 수 있다.
    if (/[\r\n]/.test(value)) {
      return { ok: false, message: `치환값 "${name}" 에는 줄바꿈을 넣을 수 없습니다.` };
    }
    if (/https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|co\.kr|kr|io|ly|me|link)\b/i.test(value)) {
      return {
        ok: false,
        message: `치환값 "${name}" 에는 링크를 넣을 수 없습니다. 문자 본문에 링크가 들어가면 통신사 스팸 필터에 걸리고 후원자는 피싱으로 오인합니다.`,
      };
    }
    // 치환자 문법을 값으로 넣어 다른 치환자를 만들어 내는 것을 막는다.
    if (/[{}]/.test(value)) {
      return { ok: false, message: `치환값 "${name}" 에는 중괄호를 넣을 수 없습니다.` };
    }
    const ad = AD_PATTERNS.find((word) => value.includes(word));
    if (ad) {
      return {
        ok: false,
        message:
          `치환값 "${name}" 에 광고·홍보 표현이 있습니다: "${ad}". ` +
          'v1 은 거래·주문·지급과 직접 관련된 안내만 보낼 수 있습니다.',
      };
    }
  }

  // 금칙어·개인정보는 사회복지기관별 규칙까지 적용해 한 번에 본다.
  const joined = entries.map(([, v]) => v).join(' ');
  const rules = await loadBannedWords(merchantId);
  const filtered = filterContent(joined, { bannedWords: rules, maxLength: MERCHANT_MT_MAX_LENGTH });
  if (filtered.containsPersonalInfo) {
    return {
      ok: false,
      message: '치환값에 전화번호·계좌번호·이메일 같은 개인정보를 넣을 수 없습니다.',
    };
  }
  if (filtered.flagged.length > 0) {
    return { ok: false, message: `치환값에 금칙어가 있습니다: ${filtered.flagged.slice(0, 3).join(', ')}` };
  }

  return { ok: true };
}

/** 템플릿 등록. 같은 코드가 있으면 본문을 갈아 끼우고 다시 검수한다. */
export async function upsertMerchantTemplate(input: {
  merchantId: string;
  code: string;
  name: string;
  body: string;
}): Promise<{ ok: false; message: string } | { ok: true; template: MerchantMtTemplate; reviewNote?: string }> {
  const code = input.code.trim();
  if (!CODE_RE.test(code)) {
    return { ok: false, message: '템플릿 코드는 영문·숫자·_- 로 2~40자여야 합니다.' };
  }

  const existing = await prisma.merchantMtTemplate.findUnique({
    where: { merchantId_code: { merchantId: input.merchantId, code } },
  });
  if (!existing) {
    const count = await prisma.merchantMtTemplate.count({ where: { merchantId: input.merchantId } });
    if (count >= MERCHANT_MT_TEMPLATE_MAX) {
      return { ok: false, message: `템플릿은 ${MERCHANT_MT_TEMPLATE_MAX}개까지 등록할 수 있습니다.` };
    }
  }

  const review = await reviewTemplateBody(input.merchantId, input.body);
  if (!review.ok) return { ok: false, message: review.message ?? '본문을 확인해 주세요.' };

  const data = {
    name: input.name.trim().slice(0, 40) || code,
    body: input.body.trim(),
    variables: review.variables.join(','),
    status: review.status,
    reviewNote: review.reviewNote ?? null,
    // 자동 승인 건은 사람이 본 것이 아니므로 검수자 기록을 남기지 않는다.
    reviewedAt: review.status === 'APPROVED' ? new Date() : null,
    reviewedBy: null,
  };

  const template = existing
    ? await prisma.merchantMtTemplate.update({ where: { id: existing.id }, data })
    : await prisma.merchantMtTemplate.create({
        data: { id: newId(), merchantId: input.merchantId, code, ...data },
      });

  return { ok: true, template, reviewNote: review.reviewNote };
}

/** 본문의 치환자를 실제 값으로 바꾼다. 치환값에 `$&` 가 있어도 깨지지 않게 함수형 치환을 쓴다. */
export function renderMerchantTemplate(
  body: string,
  values: Record<string, string>,
  merchantName: string,
): string {
  return body.replace(/\{([^{}]+)\}/g, (whole, rawName: string) => {
    const name = rawName.trim();
    if (name === '사회복지기관') return merchantName;
    const value = values[name];
    return value === undefined ? whole : value;
  });
}

/** 발송 대상 후원자. payerRef 또는 거래번호로 지정한다. */
export interface RecipientQuery {
  payerRef?: string | null;
  transactionNo?: string | null;
}

/**
 * 수신자 해석.
 *
 * payerRef 는 merchantId 와 phoneHash 로 만든 HMAC 이라 되돌릴 수 없다.
 * 그래서 `payer_merchant_link.payer_ref` 에 저장해 두고 그 값으로 찾는다.
 * 저장 전에 만들어진 옛 행은 값이 비어 있으므로, 못 찾으면 그 사회복지기관의 빈 행만
 * 한 번 채운 뒤 다시 찾는다(자기 치유). 채우고도 없으면 그 후원자는 없는 것이다.
 */
export async function resolveRecipient(
  merchantId: string,
  query: RecipientQuery,
): Promise<{ payerId: string; phone: string; phoneMasked: string } | null> {
  if (typeof query.transactionNo === 'string' && query.transactionNo.trim()) {
    const charge = await prisma.charge.findFirst({
      where: { transactionNo: query.transactionNo.trim(), merchantId },
      select: { payer: { select: { id: true, phoneEnc: true, phoneMasked: true } } },
    });
    if (!charge?.payer) return null;
    return {
      payerId: charge.payer.id,
      phone: decrypt(charge.payer.phoneEnc),
      phoneMasked: charge.payer.phoneMasked,
    };
  }

  // 사회복지기관이 문자열이 아닌 값을 보낼 수 있다. `.trim()` 을 바로 부르면 500 이 난다.
  const ref = typeof query.payerRef === 'string' ? query.payerRef.trim() : '';
  if (!ref) return null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const link = await prisma.payerMerchantLink.findFirst({
      where: { merchantId, payerRef: ref },
      select: { payer: { select: { id: true, phoneEnc: true, phoneMasked: true } } },
    });
    if (link?.payer) {
      return {
        payerId: link.payer.id,
        phone: decrypt(link.payer.phoneEnc),
        phoneMasked: link.payer.phoneMasked,
      };
    }
    // 후원금가 비어 있어서 못 찾은 것일 수 있다. 남은 것을 모두 채운 뒤 한 번 더 본다.
    if (attempt === 0 && (await backfillPayerRefs(merchantId)) === 0) break;
  }
  return null;
}

/**
 * payerRef 후원금 채우기.
 *
 * 이 기능이 생기기 전에 만들어진 연결 행에는 payerRef 가 없다.
 * HMAC 비밀키가 애플리케이션에만 있어 마이그레이션 SQL 로는 채울 수 없으므로 여기서 채운다.
 *
 * 후원자가 1000명을 넘는 사회복지기관에서 한 번에 1000건만 채우면, 그 뒤에 있는 옛 후원자는
 * 몇 번을 호출해도 영원히 찾지 못한다(매번 같은 앞쪽 1000건만 다시 보게 된다).
 * 그래서 배치로 나눠 남은 것이 없을 때까지 채운다. 배치 크기는 요청 하나가 지나치게
 * 오래 잡히지 않도록 두고, 전체 상한으로 폭주를 막는다.
 */
const BACKFILL_BATCH = 500;
const BACKFILL_MAX = 50_000;

export async function backfillPayerRefs(merchantId: string, max = BACKFILL_MAX): Promise<number> {
  let filled = 0;
  while (filled < max) {
    const rows = await prisma.payerMerchantLink.findMany({
      where: { merchantId, payerRef: null },
      take: Math.min(BACKFILL_BATCH, max - filled),
      select: { id: true, payer: { select: { phoneHash: true } } },
    });
    if (rows.length === 0) break;

    let filledInBatch = 0;
    for (const row of rows) {
      if (!row.payer?.phoneHash) continue;
      await prisma.payerMerchantLink.update({
        where: { id: row.id },
        data: { payerRef: merchantPayerRef(merchantId, row.payer.phoneHash) },
      });
      filledInBatch += 1;
    }
    filled += filledInBatch;
    // 후원자 행이 없어 채울 수 없는 연결만 남았다면 같은 배치를 무한히 다시 읽게 된다.
    if (filledInBatch === 0) break;
  }
  if (filled > 0) logger.info('payerRef 후원금를 채웠습니다', { merchantId, filled });
  return filled;
}

/**
 * 오늘 이 사회복지기관이 API 로 보낸 문자 수와 남은 한도.
 *
 * 하루의 경계는 **KST 자정**이다. `setHours(0,0,0,0)` 은 서버 시간대를 따르므로
 * 서버가 UTC 로 뜨면 한국 시간 아침 9시에 한도가 초기화된다(문서는 KST 라고 안내한다).
 */
export async function merchantMtQuota(merchantId: string) {
  const used = await prisma.mtOutboundMessage.count({
    where: { merchantId, merchantSent: true, createdAt: { gte: kstStartOfDay() } },
  });
  return { limit: MERCHANT_MT_DAILY_LIMIT, used, remaining: Math.max(0, MERCHANT_MT_DAILY_LIMIT - used) };
}

export type SendFailure =
  | 'TEMPLATE_NOT_FOUND'
  | 'TEMPLATE_NOT_APPROVED'
  | 'MISSING_VARIABLES'
  | 'RECIPIENT_NOT_FOUND'
  | 'RECIPIENT_BLOCKED'
  | 'QUOTA_EXCEEDED';

/**
 * 사회복지기관 문자 1건 발송.
 *
 * 멱등키가 같으면 새로 보내지 않고 처음 결과를 그대로 돌려준다.
 * 재시도로 같은 문자가 두 번 나가면 후원자는 그것을 스팸으로 받아들인다.
 */
export async function sendMerchantMt(input: {
  merchantId: string;
  merchantName: string;
  templateCode: string;
  variables: Record<string, string>;
  recipient: RecipientQuery;
  idempotencyKey: string;
}): Promise<
  | { ok: false; code: SendFailure; message: string; detail?: string[] }
  | { ok: true; id: string; status: string; reused: boolean; bodyMasked: string; phoneMasked: string }
> {
  // 1) 멱등키가 이미 있으면 그때 결과를 돌려준다.
  const prior = await prisma.mtOutboundMessage.findFirst({
    where: { merchantId: input.merchantId, idempotencyKey: input.idempotencyKey },
    select: { id: true, status: true, bodyMasked: true, phoneMasked: true },
  });
  if (prior) {
    return { ok: true, id: prior.id, status: prior.status, reused: true, bodyMasked: prior.bodyMasked, phoneMasked: prior.phoneMasked };
  }

  // 2) 템플릿
  const template = await prisma.merchantMtTemplate.findUnique({
    where: { merchantId_code: { merchantId: input.merchantId, code: input.templateCode } },
  });
  if (!template) {
    return { ok: false, code: 'TEMPLATE_NOT_FOUND', message: '등록되지 않은 템플릿 코드입니다.' };
  }
  if (template.status !== 'APPROVED') {
    return {
      ok: false,
      code: 'TEMPLATE_NOT_APPROVED',
      message:
        template.status === 'PENDING'
          ? '검수 대기 중인 템플릿입니다. 승인 후 발송할 수 있습니다.'
          : '반려된 템플릿입니다. 본문을 고쳐 다시 등록해 주세요.',
      detail: template.reviewNote ? [template.reviewNote] : undefined,
    };
  }

  const required = template.variables ? template.variables.split(',').filter(Boolean) : [];
  const missing = required.filter((name) => input.variables[name] === undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'MISSING_VARIABLES',
      message: '템플릿에 필요한 치환값이 빠졌습니다.',
      detail: missing,
    };
  }

  // 3) 수신자 — 이 사회복지기관에 거래 이력이 있는 후원자만
  const recipient = await resolveRecipient(input.merchantId, input.recipient);
  if (!recipient) {
    return {
      ok: false,
      code: 'RECIPIENT_NOT_FOUND',
      message: '이 사회복지기관에 거래 이력이 있는 후원자가 아닙니다. payerRef 또는 transactionNo 를 확인해 주세요.',
    };
  }

  // 세 가지 차단을 모두 본다. 하나라도 빠지면 차단한 사람에게 문자가 계속 간다.
  //  1) 후원자가 이 사회복지기관을 차단  2) 사회복지기관이 후원자를 차단  3) 플랫폼이 후원자를 차단
  const [link, blocked, payer] = await Promise.all([
    prisma.payerMerchantLink.findUnique({
      where: { payerId_merchantId: { payerId: recipient.payerId, merchantId: input.merchantId } },
      select: { payerBlockedAt: true },
    }),
    prisma.blockedPayer.findFirst({
      where: { merchantId: input.merchantId, payerId: recipient.payerId },
      select: { id: true },
    }),
    prisma.payerProfile.findUnique({
      where: { id: recipient.payerId },
      select: { blockedAt: true },
    }),
  ]);
  if (link?.payerBlockedAt || blocked || payer?.blockedAt) {
    return { ok: false, code: 'RECIPIENT_BLOCKED', message: '차단된 후원자에게는 발송할 수 없습니다.' };
  }

  // 4) 한도
  const quota = await merchantMtQuota(input.merchantId);
  if (quota.remaining <= 0) {
    return {
      ok: false,
      code: 'QUOTA_EXCEEDED',
      message: `하루 발송 한도(${quota.limit}건)를 모두 썼습니다. 내일 다시 시도해 주세요.`,
    };
  }

  // 5) 발송. 발신 주체 표기는 시스템이 붙인다(사회복지기관이 지울 수 없다).
  const rendered = renderMerchantTemplate(template.body, input.variables, input.merchantName);
  const text = `[기브싸인] ${rendered}`;

  // 멱등키 확인(1)과 발송 사이에 같은 키의 요청이 하나 더 들어오면 둘 다 통과한다.
  // 그때는 (merchantId, idempotencyKey) 유니크 제약이 뒤에 온 쪽을 P2002 로 막는데,
  // 그대로 두면 재시도 클라이언트가 가장 흔히 만드는 상황이 500 으로 돌아간다.
  // 문자는 이미 앞선 요청이 보내고 있으므로, 진 쪽은 그 결과를 돌려주면 된다.
  let result: { ok: boolean; id: string };
  try {
    result = await sendMtDetailed({
    phone: recipient.phone,
    template: {
      code: MT_TEMPLATE.MERCHANT_NOTICE,
      text,
      masked: text,
      // vars 를 넘기지 않는다. 넘기면 관리자 공통 문구 오버라이드가 사회복지기관 문구를 덮어쓴다.
    },
    // 이력에는 어느 사회복지기관 템플릿이었는지 남긴다.
    templateCodeLabel: `MERCHANT:${template.code}`,
    merchantId: input.merchantId,
    idempotencyKey: input.idempotencyKey,
    merchantSent: true,
    });
  } catch (e) {
    if ((e as { code?: string }).code !== 'P2002') throw e;
    const winner = await prisma.mtOutboundMessage.findFirst({
      where: { merchantId: input.merchantId, idempotencyKey: input.idempotencyKey },
      select: { id: true, status: true, bodyMasked: true, phoneMasked: true },
    });
    if (!winner) throw e;
    return {
      ok: true,
      id: winner.id,
      status: winner.status,
      reused: true,
      bodyMasked: winner.bodyMasked,
      phoneMasked: winner.phoneMasked,
    };
  }

  // 실제로 나간 것만 센다. 실패까지 세면 "이 템플릿으로 몇 통 나갔나"를 못 본다.
  if (result.ok) {
    await prisma.merchantMtTemplate
      .update({ where: { id: template.id }, data: { sentCount: { increment: 1 } } })
      .catch(() => undefined);
  }

  return {
    ok: true,
    id: result.id,
    status: result.ok ? 'SENT' : 'FAILED',
    reused: false,
    bodyMasked: text,
    phoneMasked: recipient.phoneMasked,
  };
}

/** 발송 이력 조회(사회복지기관 API 발송분만). */
export async function listMerchantMtMessages(merchantId: string, limit: number, cursor?: string) {
  const rows = await prisma.mtOutboundMessage.findMany({
    where: { merchantId, merchantSent: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true, templateCode: true, phoneMasked: true, bodyMasked: true,
      status: true, resultCode: true, resultMessage: true, sentAt: true, createdAt: true,
    },
  });
  return {
    items: rows.map((r) => ({
      id: r.id,
      templateCode: r.templateCode?.replace(/^MERCHANT:/, '') ?? null,
      phoneMasked: r.phoneMasked,
      body: r.bodyMasked,
      status: r.status,
      resultCode: r.resultCode,
      resultMessage: r.resultMessage,
      sentAt: r.sentAt ? r.sentAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    })),
    nextCursor: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
  };
}
