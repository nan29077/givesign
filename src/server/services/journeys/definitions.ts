import { prisma } from '@/server/db';
import { env } from '@/lib/env';
import { formatWon } from '@/lib/money';
import { kstDateKey } from '@/lib/datetime';
import { PAID_STATUSES } from '@/components/studio/shared';
import { sendMtForPayer } from '../charge-flow';
import * as tpl from '../mt-templates';
import { issuerReadiness } from '../receipts';
import { issuePurposeDocument, DOCUMENT_PURPOSE_LABEL, type DocumentPurpose, type MergeContext } from '../purpose-documents';
import type { JourneyDef, StepDef, StepEnv, StepOutcome, ParamValue } from './types';
import type { StoredDomainEvent } from '../events';
import { JourneyBlockedError } from './types';
import { sendRelational } from '../outbound/coordinator';
import type { RelationalKind } from '../outbound/classify';
import type { TemplateOutput } from '../mt-templates';

/**
 * 기본 저니 정의.
 *
 * 모든 발송은 **정보성**이다(감사·발급·등록 방법·재개 방법·일정). 후원 권유(광고성) 단계는 없다.
 * 발송 단계(sends)는 엔진이 공통으로 수신 거부·차단·탈퇴·야간·후원자당 주간 상한을 적용한다.
 */

const DAY = 86_400_000;

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null;
}
function numOr(v: unknown, d = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}
function big(v: string | undefined): bigint {
  try {
    return BigInt(v ?? '0');
  } catch {
    return 0n;
  }
}

async function payerName(payerId: string | null): Promise<string | null> {
  if (!payerId) return null;
  const p = await prisma.payerProfile.findUnique({ where: { id: payerId }, select: { displayName: true } });
  return p?.displayName ?? null;
}

/** 문서 단계 공통: 용도별 서식으로 발급하고 결과를 단계 결과로 바꾼다. */
function documentStep(input: {
  key: string;
  purpose: DocumentPurpose;
  label?: string;
  approvable?: boolean;
  defaultApproval?: boolean;
  when?: StepDef['when'];
  merge(env: StepEnv): Promise<MergeContext>;
  subject?(env: StepEnv): { type: string; id: string } | undefined;
  /** 같은 문서를 여러 실행에서 한 번만 보내야 할 때(연말 감사장 등) */
  dedupeKey?(env: StepEnv): string;
}): StepDef {
  const label = input.label ?? `${DOCUMENT_PURPOSE_LABEL[input.purpose]} 발송`;
  return {
    key: input.key,
    label,
    kind: 'document',
    sends: true,
    approvable: input.approvable ?? true,
    defaultApproval: input.defaultApproval ?? false,
    describe: () => `기관 서식(없으면 기본 세트)의 ${DOCUMENT_PURPOSE_LABEL[input.purpose]}을(를) 만들어 열람 링크를 보냅니다.`,
    when: input.when,
    approvalTitle: async (e) => `${label} — ${(await payerName(e.run.payerId)) ?? '후원자'}님`,
    async run(e): Promise<StepOutcome> {
      if (!e.run.payerId) return { type: 'stop', detail: '후원자 없음' };
      const r = await issuePurposeDocument({
        merchantId: e.run.merchantId,
        purpose: input.purpose,
        payerId: e.run.payerId,
        context: { donorName: await payerName(e.run.payerId), ...(await input.merge(e)) },
        subject: input.subject?.(e),
        dedupeKey: input.dedupeKey?.(e) ?? `journey:${e.run.triggerKey}:${input.key}`,
      });
      if (r.ok) return { type: 'done', sent: !r.already, detail: r.already ? '이미 보낸 문서' : r.signature ? '서명 요청 발송' : '열람 링크 발송' };
      if (r.blocked === 'EDOC_BALANCE') return { type: 'retry', until: new Date(e.now.getTime() + DAY), detail: '전자문서 이용 잔액 부족 — 충전 후 다시 시도' };
      if (r.blocked === 'WITHDRAWN') return { type: 'stop', detail: '탈퇴한 후원자' };
      // 발송 전 점검에서 막힘(필수 항목 빈칸·연락처 없음 등, 2026-11-09 C2): 건너뛰지 않고 실행을 "막힌 일" 로 남긴다.
      // 승인 대기함이 journey_run.status=FAILED + last_error(PREFLIGHT_BLOCK_PREFIX) 로 모아 보여 주고, 기관이 고친 뒤 "다시 실행" 한다.
      if (r.blocked === 'PREFLIGHT') throw new JourneyBlockedError(r.reason);
      return { type: 'skip', detail: r.reason };
    },
  };
}

function waitStep(key: string, label: string, paramKey: string): StepDef {
  return {
    key,
    label,
    kind: 'wait',
    describe: (p) => `${numOr(p[paramKey], 0)}일 기다립니다.`,
    async run(e) {
      const days = Math.max(0, numOr(e.params[paramKey], 0));
      return { type: 'wait', until: new Date(e.now.getTime() + days * DAY), detail: `${days}일 대기` };
    },
  };
}

/** 이 후원자에게 이 기관이 올해(KST) 이 단계로 이미 보냈는가 — 영수증 정보 안내를 해마다 한 번만. */
async function sentThisYear(merchantId: string, payerId: string, stepKeys: string[], now: Date) {
  const year = kstDateKey(now).slice(0, 4);
  const start = new Date(`${year}-01-01T00:00:00+09:00`);
  const n = await prisma.journeyStepLog.count({ where: { merchantId, payerId, stepKey: { in: stepKeys }, sent: true, at: { gte: start } } });
  return n > 0;
}

const RECEIPT_INFO_KEYS = ['receipt-info'];

/**
 * 관계·정보형 문자 단계 발송(2026-11-09 D2). 통합 발송 관리가 켜져 있으면 발송 대기열에 쌓아 같은 날 안내와 묶어 보낸다
 * (발송 키 = 엔진의 발송 예약 키 `journey:{runId}:{stepKey}` — 대기열 결과가 이 단계 기록에 되돌아온다). 꺼져 있으면 지금처럼 바로.
 * 엔진이 예약하며 7일 상한에 이미 셌으므로 precounted.
 */
async function sendRelationalStep(e: StepEnv, stepKey: string, kind: RelationalKind, template: TemplateOutput, retryMs: number, okDetail: string): Promise<StepOutcome> {
  const r = await sendRelational({
    merchantId: e.run.merchantId,
    payerId: e.run.payerId!,
    kind,
    template,
    sendKey: `journey:${e.run.id}:${stepKey}`,
    source: 'journey',
    sourceId: e.run.id,
    precounted: true,
    now: e.now,
  });
  if (r.mode === 'queued') return { type: 'done', sent: true, detail: r.detail };
  if (r.mode === 'skipped') return { type: 'skip', detail: r.reason };
  return r.ok ? { type: 'done', sent: true, detail: okDetail } : { type: 'retry', until: new Date(e.now.getTime() + retryMs), detail: retryMs >= 3_600_000 ? '문자 발송 실패 — 1시간 뒤 재시도' : '문자 발송 실패' };
}

const receiptInfoStep: StepDef = {
  key: 'receipt-info',
  label: '기부금영수증 정보 등록 안내',
  kind: 'message',
  sends: true,
  describe: () => '영수증 정보(성명·주민등록번호)를 아직 등록하지 않은 분께 등록 방법을 안내합니다. 기관이 영수증을 발급할 수 있을 때만, 한 해에 한 번만.',
  async when(e) {
    if (!e.run.payerId) return '후원자 없음';
    const m = await prisma.merchantProfile.findUniqueOrThrow({
      where: { id: e.run.merchantId },
      select: { businessNo: true, representativeName: true, address: true, designatedDonee: true, designatedDoneeVerifiedAt: true, designatedDoneeUntil: true },
    });
    if (!issuerReadiness(m).ok) return '기관이 아직 영수증을 발급할 수 없음';
    const profile = await prisma.payerReceiptProfile.findUnique({ where: { payerId: e.run.payerId }, select: { payerId: true } });
    if (profile) return '이미 영수증 정보 등록';
    if (await sentThisYear(e.run.merchantId, e.run.payerId, RECEIPT_INFO_KEYS, e.now)) return '올해 이미 안내함';
    return true;
  },
  async run(e) {
    return sendRelationalStep(e, 'receipt-info', 'RECEIPT_INFO', tpl.tplReceiptInfoRequest({ merchantName: e.merchant.displayName, link: `${env.baseUrl}/my/receipts` }), 3_600_000, '등록 안내 발송');
  },
};

function milestoneList(params: Record<string, ParamValue>): number[] {
  return Array.isArray(params.milestones) ? (params.milestones as number[]) : [];
}

/** 봉사 전날 안내를 보내기 직전: 신청이 아직 승인 상태이고 같은 회차이며, 회차가 시작 전(30분 이상 남음)인가. */
const REMINDER_MIN_LEAD_MS = 30 * 60_000;
async function reminderStillValid(e: StepEnv): Promise<true | string> {
  const c = e.run.context;
  if (!c.applicationId) return true;
  const a = await prisma.volunteerApplication.findFirst({
    where: { id: c.applicationId, merchantId: e.run.merchantId },
    select: { status: true, shiftId: true, shift: { select: { startsAt: true, archivedAt: true } } },
  });
  if (!a || a.status !== 'APPROVED') return '신청이 철회·반려되었거나 승인 상태가 아님';
  if (c.shiftId && a.shiftId !== c.shiftId) return '회차가 바뀜';
  if (!a.shift || a.shift.archivedAt) return '회차가 보관됨';
  if (a.shift.startsAt.getTime() - e.now.getTime() < REMINDER_MIN_LEAD_MS) return '회차가 이미 시작했거나 곧 시작함';
  return true;
}

// ---------------------------------------------------------------------------

export const JOURNEYS: JourneyDef[] = [
  {
    key: 'donation-thanks',
    label: '후원 감사',
    group: '후원',
    description: '일시후원이 확인되면 감사장을 보내고, 다음 날 영수증 정보 등록 방법을 안내합니다(이미 등록했거나 올해 안내했으면 생략). 감사 문자는 결제 직후 따로 나갑니다.',
    triggers: ['charge.paid'],
    triggerLabel: '일시후원 결제 완료',
    defaultEnabled: true,
    params: [
      { key: 'minAmount', label: '감사장 기준 금액', type: 'number', default: 50000, min: 0, max: 100_000_000, unit: '원', hint: '이 금액 이상이거나 이 기관 첫 후원이면 감사장을 보냅니다. 0 이면 모든 후원.' },
      { key: 'receiptInfoDelayDays', label: '영수증 정보 안내까지', type: 'number', default: 1, min: 0, max: 30, unit: '일' },
    ],
    accept: (ev) => ev.payload.recurring !== true && ev.payload.isTest !== true,
    buildContext: (ev) => ({
      amount: String(ev.payload.amount ?? '0'),
      campaignId: str(ev.payload.campaignId),
      channel: str(ev.payload.channel),
      // 보내기 직전 결제가 아직 성공 상태인지 엔진이 다시 본다(환불된 후원에는 감사장·안내를 보내지 않음 — 점검 A-M3).
      chargeId: ev.subjectType === 'charge' ? ev.subjectId : null,
    }),
    steps: [
      documentStep({
        key: 'thanks-letter',
        purpose: 'THANKS_LETTER',
        async when(e) {
          if (!e.run.payerId) return '후원자 없음';
          const amount = big(e.run.context.amount);
          if (amount >= BigInt(Math.max(0, numOr(e.params.minAmount, 0)))) return true;
          const paid = await prisma.charge.count({
            where: { merchantId: e.run.merchantId, payerId: e.run.payerId, status: { in: PAID_STATUSES }, isTest: false },
          });
          return paid <= 1 ? true : `기준 금액 미만이고 첫 후원이 아님`;
        },
        async merge(e) {
          const c = e.run.context.campaignId
            ? await prisma.campaign.findFirst({ where: { id: e.run.context.campaignId, merchantId: e.run.merchantId }, select: { title: true } })
            : null;
          return { amount: big(e.run.context.amount), campaignTitle: c?.title ?? null, date: kstDateKey(e.run.startedAt) };
        },
      }),
      waitStep('wait-receipt', '영수증 안내 전 대기', 'receiptInfoDelayDays'),
      receiptInfoStep,
    ],
  },
  {
    key: 'recurring-milestone',
    label: '정기후원 누적 감사',
    group: '정기후원',
    description: '정기후원 출금이 정한 횟수(예: 12회·24회)에 닿으면 누적 감사장을 보냅니다.',
    triggers: ['recurring.milestone'],
    triggerLabel: '정기후원 누적 횟수 도달',
    defaultEnabled: true,
    params: [{ key: 'milestones', label: '감사장을 보낼 누적 횟수', type: 'numberList', default: [12, 24, 36, 60, 120], unit: '회', hint: '쉼표로 구분(1~1000, 12개까지). 적은 횟수마다 보냅니다. 1 을 넣으면 첫 출금 때도 보냅니다.' }],
    // 이벤트는 출금이 성공할 때마다 난다(횟수 포함). 기관이 적은 횟수일 때만 실행을 만든다(점검 A-M4).
    accept: (ev, params) => milestoneList(params).includes(numOr(ev.payload.count, -1)),
    buildContext: (ev) => ({ count: numOr(ev.payload.count), totalAmount: String(ev.payload.totalAmount ?? '0'), amount: String(ev.payload.amount ?? '0') }),
    steps: [
      documentStep({
        key: 'recurring-thanks',
        purpose: 'RECURRING_THANKS',
        async when(e) {
          return milestoneList(e.params).includes(e.run.context.count ?? -1) ? true : '설정한 누적 횟수가 아님';
        },
        async merge(e) {
          return { count: e.run.context.count ?? null, totalAmount: big(e.run.context.totalAmount), amount: big(e.run.context.amount), date: kstDateKey(e.now) };
        },
      }),
    ],
  },
  {
    key: 'recurring-resume',
    label: '정기후원 정지 후 재개 안내',
    group: '정기후원',
    description: '출금 실패가 이어져 정기후원이 정지되면, 며칠 뒤에도 정지 상태일 때 재개 방법을 한 번 안내합니다(후원 권유가 아니라 본인 약정의 상태 안내).',
    triggers: ['recurring.suspended'],
    triggerLabel: '출금 실패로 정기후원 정지',
    defaultEnabled: true,
    params: [{ key: 'delayDays', label: '안내까지 대기', type: 'number', default: 3, min: 1, max: 30, unit: '일' }],
    accept: (ev) => ev.payload.reason === 'PAYMENT_FAILED',
    buildContext: (ev) => ({ reason: str(ev.payload.reason) }),
    steps: [
      waitStep('wait', '정지 후 대기', 'delayDays'),
      {
        key: 'resume-guide',
        label: '재개 방법 안내',
        kind: 'message',
        sends: true,
        describe: () => '아직 정지 상태이면 마이페이지에서 결제수단을 확인하고 재개하는 방법을 안내합니다.',
        async when(e) {
          const r = await prisma.recurringDonation.findFirst({ where: { merchantId: e.run.merchantId, payerId: e.run.payerId ?? '', status: 'SUSPENDED' }, select: { id: true } });
          return r ? true : '이미 재개·해지됨';
        },
        async run(e) {
          const ok = await sendMtForPayer(e.run.payerId!, tpl.tplRecurringResumeGuide({ merchantName: e.merchant.displayName, link: `${env.baseUrl}/my/recurring` }), null, e.run.merchantId);
          return ok ? { type: 'done', sent: true, detail: '재개 안내 발송' } : { type: 'retry', until: new Date(e.now.getTime() + 3_600_000), detail: '문자 발송 실패' };
        },
      },
    ],
  },
  {
    key: 'volunteer-thanks',
    label: '봉사 활동 감사·확인서',
    group: '자원봉사',
    description: '봉사 활동이 기록되면 감사 문자(누적 시간)를 보내고, 봉사활동 확인서를 발급합니다. 확인서는 기본적으로 담당자 승인 후 발급됩니다.',
    triggers: ['volunteer.activity_recorded'],
    triggerLabel: '봉사 활동 기록',
    defaultEnabled: true,
    params: [{ key: 'confirmation', label: '활동 확인서 발급', type: 'boolean', default: true }],
    buildContext: (ev) => ({
      minutes: numOr(ev.payload.minutes),
      totalMinutes: numOr(ev.payload.totalMinutes),
      activityTitle: str(ev.payload.title),
      activityDate: str(ev.payload.activityDate),
    }),
    steps: [
      {
        key: 'volunteer-thanks-msg',
        label: '감사 문자',
        kind: 'message',
        sends: true,
        describe: () => '활동에 감사 인사와 누적 봉사 시간을 보냅니다.',
        async run(e) {
          const r = await sendRelationalStep(
            e,
            'volunteer-thanks-msg',
            'VOLUNTEER_THANKS',
            tpl.tplVolunteerThanks({ merchantName: e.merchant.displayName, totalHours: (e.run.context.totalMinutes ?? 0) / 60 }),
            3_600_000,
            '감사 문자 발송',
          );
          return r.type === 'retry' ? { ...r, detail: '문자 발송 실패' } : r;
        },
      },
      documentStep({
        key: 'volunteer-confirmation',
        purpose: 'VOLUNTEER_CONFIRMATION',
        defaultApproval: true,
        async when(e) {
          return e.params.confirmation === false ? '확인서 발급 꺼짐' : true;
        },
        async merge(e) {
          const c = e.run.context;
          return {
            activityTitle: c.activityTitle ?? null,
            activityDate: c.activityDate ?? null,
            activityHours: Math.round(((c.minutes ?? 0) / 60) * 10) / 10,
            totalHours: Math.round(((c.totalMinutes ?? 0) / 60) * 10) / 10,
            date: kstDateKey(e.now),
          };
        },
      }),
    ],
  },
  {
    key: 'volunteer-milestone',
    label: '봉사 누적 감사장',
    group: '자원봉사',
    description: '누적 봉사 시간이 10·30·50·100시간 등에 닿으면 자원봉사 감사장을 보냅니다.',
    triggers: ['volunteer.milestone'],
    triggerLabel: '누적 봉사 시간 도달',
    defaultEnabled: true,
    params: [],
    buildContext: (ev) => ({ hours: numOr(ev.payload.hours), totalMinutes: numOr(ev.payload.totalMinutes) }),
    steps: [
      documentStep({
        key: 'volunteer-thanks-letter',
        purpose: 'VOLUNTEER_THANKS',
        async merge(e) {
          return { totalHours: e.run.context.hours ?? null, date: kstDateKey(e.now) };
        },
      }),
    ],
  },
  {
    key: 'volunteer-reminder',
    label: '봉사 전날 안내',
    group: '자원봉사',
    description: '승인된 봉사 회차 하루 전 오전에 일정·장소를 다시 알려 드립니다.',
    triggers: ['volunteer.shift_reminder_due'],
    triggerLabel: '봉사 회차 전날',
    defaultEnabled: true,
    params: [],
    buildContext: (ev) => ({
      schedule: str(ev.payload.schedule),
      applicationId: ev.subjectType === 'volunteer_application' ? ev.subjectId : null,
      shiftId: str(ev.payload.shiftId),
      startsAt: str(ev.payload.startsAt),
    }),
    steps: [
      {
        key: 'reminder',
        label: '일정 안내 문자',
        kind: 'message',
        sends: true,
        describe: () => '내일 봉사 일정·장소를 문자로 안내합니다. 보내기 직전에 신청이 승인 상태이고 회차가 아직 시작 전인지 다시 확인합니다.',
        async when(e) {
          if (!e.run.context.schedule) return '일정 정보 없음';
          return reminderStillValid(e);
        },
        async run(e) {
          const ok = await sendMtForPayer(e.run.payerId!, tpl.tplVolunteerReminder({ merchantName: e.merchant.displayName, schedule: e.run.context.schedule! }), null, e.run.merchantId);
          return ok ? { type: 'done', sent: true, detail: '전날 안내 발송' } : { type: 'retry', until: new Date(e.now.getTime() + 1_800_000), detail: '문자 발송 실패' };
        },
      },
    ],
  },
  {
    key: 'year-end-thanks',
    label: '연말 감사장',
    group: '영수증',
    description: '지난 한 해의 기부금영수증이 발급되면 그해 후원에 대한 연말 감사장을 보냅니다(한 사람에게 한 해 한 번). 연 1회 발급 기관은 그 영수증 발급 때, 매월 발급 기관은 12월분까지 모두 발급된 뒤(1~2월) 한 해 합계로 보냅니다.',
    triggers: ['receipt.issued', 'receipt.year_closed'],
    triggerLabel: '지난해 기부금영수증 발급 완료',
    defaultEnabled: true,
    params: [],
    // 매월 발급 기관의 월별 영수증으로는 시작하지 않는다(한 달 금액으로 "한 해 동안" 감사장이 나가던 문제 — 점검 A-4).
    // 그 기관은 receipt.year_closed(한 해 합계)로만 시작한다.
    accept: (ev) => ev.type === 'receipt.year_closed' || ev.payload.receiptCycle !== 'MONTHLY',
    buildContext: (ev) => ({
      taxYear: numOr(ev.payload.taxYear),
      totalAmount: String(ev.payload.totalAmount ?? '0'),
      count: numOr(ev.payload.chargeCount),
      receiptNo: str(ev.payload.receiptNo),
    }),
    steps: [
      documentStep({
        key: 'year-end-letter',
        purpose: 'YEAR_END_THANKS',
        dedupeKey: (e) => `year-end:${e.run.merchantId}:${e.run.payerId}:${e.run.context.taxYear}`,
        async when(e) {
          // 아직 끝나지 않은 해(올해 귀속 수동 발급 등)에는 보내지 않는다 — 그해 감사장 키를 미리 써 버리지 않게.
          const year = Number(kstDateKey(e.now).slice(0, 4));
          if (!e.run.context.taxYear || e.run.context.taxYear >= year) return '아직 끝나지 않은 해의 영수증';
          if (e.run.subjectType === 'donation_receipt') {
            const m = await prisma.merchantProfile.findUnique({ where: { id: e.run.merchantId }, select: { receiptCycle: true } });
            if (m?.receiptCycle === 'MONTHLY') return '매월 발급 기관은 한 해 발급이 끝난 뒤 보냄';
          }
          return true;
        },
        async merge(e) {
          return {
            taxYear: e.run.context.taxYear ?? null,
            totalAmount: big(e.run.context.totalAmount),
            count: e.run.context.count ?? null,
            receiptNo: e.run.context.receiptNo ?? null,
            date: kstDateKey(e.now),
          };
        },
      }),
    ],
  },
  {
    key: 'receipt-info-yearend',
    label: '연초 영수증 정보 등록 안내',
    group: '영수증',
    description: '연 1회 발급 기관이 전년도 영수증을 준비할 때, 정보를 등록하지 않은 지난해 후원자에게 등록 방법을 한 번 안내합니다.',
    triggers: ['receipt.info_needed'],
    triggerLabel: '연초 영수증 준비',
    defaultEnabled: true,
    params: [],
    buildContext: (ev) => ({ taxYear: numOr(ev.payload.taxYear) }),
    steps: [receiptInfoStep],
  },
];

export function journeyDef(key: string): JourneyDef | undefined {
  return JOURNEYS.find((j) => j.key === key);
}

export function defaultParams(def: JourneyDef): Record<string, ParamValue> {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

/** 화면 표시용 금액 */
export function contextAmountLabel(ctx: { amount?: string }) {
  return ctx.amount ? formatWon(big(ctx.amount)) : '';
}

export type { StoredDomainEvent };
