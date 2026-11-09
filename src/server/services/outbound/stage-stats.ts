import { prisma } from '@/server/db';
import { NOTICE_STAGE_GROUPS, OUTBOUND_BUNDLE_TEMPLATE } from './classify';

/**
 * 안내 상태 5단계 집계 (2026-11-09 D2-5) — 기관 콘솔 "자동 안내"(/studio/journeys).
 *
 *   요청(대기열 등록·발송 시도) → 접수(공급자 ACCEPTED 이상) → 전달(SENT) → 열람(링크 첫 열람) → 완료(그 안내가 요구한 일)
 *
 *  - 요청·접수·전달은 발송 이력(mt_outbound_message)과 발송 대기열(outbound_queue)에서 센다. 묶음으로 나간 안내는 안내마다 센다.
 *  - 열람·완료는 기존 열람·완료 기록을 잇는다(새로 만들어 내지 않는다):
 *      열람 문서 = issued_document.first_viewed_at(/l/ 열람, 미리보기 봇 제외는 열람 화면 규칙 그대로)
 *      서명 요청 = edoc_signer.viewed_at / signed_at
 *      정기후원 복구 안내 = recurring_recovery_link.last_opened_at / 안내 뒤 결제수단 등록(payment_method_token.registered_at)
 *      영수증 정보 안내 = 안내 뒤 영수증 정보 등록(payer_receipt_profile.created_at) — 열람 기록이 없어 열람은 "-"
 *    열람·완료 기록이 없는 안내(월간 안내·감사 문자 등)는 "-" 로 둔다(지어내지 않음).
 */

export interface StageRow {
  key: string;
  label: string;
  relational: boolean;
  requested: number;
  accepted: number;
  delivered: number;
  opened: number | null;
  completed: number | null;
  /** 완료율(%) = 완료 ÷ 전달. 완료 기록이 없는 안내는 null */
  completionRate: number | null;
}

const ACCEPTED = new Set(['ACCEPTED', 'SENT', 'UNKNOWN']);
const ROW_CAP = 20_000;

export async function noticeStageStats(merchantId: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const [mts, items] = await Promise.all([
    prisma.mtOutboundMessage.findMany({
      where: { merchantId, merchantSent: false, createdAt: { gte: since } },
      select: { id: true, templateCode: true, status: true, phoneHash: true, createdAt: true },
      take: ROW_CAP,
    }),
    prisma.outboundQueue.findMany({
      where: { merchantId, createdAt: { gte: since } },
      select: { id: true, templateCode: true, status: true, mtMessageId: true, payerId: true, createdAt: true, bundleId: true },
      take: ROW_CAP,
    }),
  ]);
  const mtById = new Map(mts.map((m) => [m.id, m]));
  const viaQueue = new Set(items.map((i) => i.mtMessageId).filter(Boolean) as string[]);

  // 후원자 매핑(발송 이력은 번호 해시만 있다)
  const hashes = [...new Set(mts.map((m) => m.phoneHash))];
  const payers = hashes.length ? await prisma.payerProfile.findMany({ where: { phoneHash: { in: hashes } }, select: { id: true, phoneHash: true } }) : [];
  const payerByHash = new Map(payers.map((p) => [p.phoneHash, p.id]));

  type Rec = { template: string; payerId: string | null; at: Date; mtStatus: string | null };
  const recs: Rec[] = [];
  for (const it of items) {
    const mt = it.mtMessageId ? mtById.get(it.mtMessageId) : undefined;
    recs.push({ template: it.templateCode, payerId: it.payerId, at: it.createdAt, mtStatus: mt?.status ?? (it.status === 'SENT' ? 'SENT' : null) });
  }
  for (const m of mts) {
    if (viaQueue.has(m.id) || m.templateCode === OUTBOUND_BUNDLE_TEMPLATE || !m.templateCode) continue;
    recs.push({ template: m.templateCode, payerId: payerByHash.get(m.phoneHash) ?? null, at: m.createdAt, mtStatus: m.status });
  }

  // 열람·완료 원천(기관 단위로 한 번씩)
  const recoveryPayers = new Set<string>();
  const receiptPayers = new Set<string>();
  for (const g of NOTICE_STAGE_GROUPS) {
    for (const r of recs) {
      if (!g.templates.includes(r.template) || !r.payerId) continue;
      if (g.opened === 'recovery' || g.completed === 'payment-method') recoveryPayers.add(r.payerId);
      if (g.completed === 'receipt-profile') receiptPayers.add(r.payerId);
    }
  }
  const [docs, signers, links, tokens, profiles] = await Promise.all([
    prisma.issuedDocument.findMany({ where: { merchantId, signature: false, sentAt: { gte: since } }, select: { firstViewedAt: true } }),
    prisma.eDocSigner.findMany({ where: { envelope: { merchantId }, sentAt: { gte: since } }, select: { viewedAt: true, signedAt: true } }),
    recoveryPayers.size ? prisma.recurringRecoveryLink.findMany({ where: { payerId: { in: [...recoveryPayers] }, recurring: { merchantId }, lastOpenedAt: { gte: since } }, select: { payerId: true, lastOpenedAt: true } }) : [],
    recoveryPayers.size ? prisma.paymentMethodToken.findMany({ where: { payerId: { in: [...recoveryPayers] }, registeredAt: { gte: since } }, select: { payerId: true, registeredAt: true } }) : [],
    receiptPayers.size ? prisma.payerReceiptProfile.findMany({ where: { payerId: { in: [...receiptPayers] }, createdAt: { gte: since } }, select: { payerId: true, createdAt: true } }) : [],
  ]);
  const after = (rows: Array<{ payerId: string; t: Date | null }>) => {
    const m = new Map<string, Date[]>();
    for (const r of rows) if (r.t) m.set(r.payerId, [...(m.get(r.payerId) ?? []), r.t]);
    return (payerId: string | null, at: Date) => Boolean(payerId && (m.get(payerId) ?? []).some((t) => t >= at));
  };
  const openedRecovery = after(links.map((l) => ({ payerId: l.payerId, t: l.lastOpenedAt })));
  const registered = after(tokens.map((t) => ({ payerId: t.payerId, t: t.registeredAt })));
  const receiptDone = after(profiles.map((p) => ({ payerId: p.payerId, t: p.createdAt })));

  const rows: StageRow[] = NOTICE_STAGE_GROUPS.map((g) => {
    const mine = recs.filter((r) => g.templates.includes(r.template));
    const requested = mine.length;
    const accepted = mine.filter((r) => r.mtStatus && ACCEPTED.has(r.mtStatus)).length;
    const delivered = mine.filter((r) => r.mtStatus === 'SENT').length;
    let opened: number | null = null;
    let completed: number | null = null;
    if (g.opened === 'document') opened = docs.filter((d) => d.firstViewedAt).length;
    if (g.opened === 'sign') opened = signers.filter((s) => s.viewedAt).length;
    if (g.opened === 'recovery') opened = mine.filter((r) => openedRecovery(r.payerId, r.at)).length;
    if (g.completed === 'sign') completed = signers.filter((s) => s.signedAt).length;
    if (g.completed === 'payment-method') completed = mine.filter((r) => registered(r.payerId, r.at)).length;
    if (g.completed === 'receipt-profile') completed = mine.filter((r) => receiptDone(r.payerId, r.at)).length;
    const base = g.completed === 'sign' ? signers.length : delivered;
    return {
      key: g.key,
      label: g.label,
      relational: g.relational,
      requested,
      accepted,
      delivered,
      opened,
      completed,
      completionRate: completed === null ? null : base > 0 ? Math.round((completed / base) * 1000) / 10 : 0,
    };
  });

  const sentInBundles = items.filter((i) => i.status === 'SENT' && i.bundleId);
  const queue = {
    waiting: items.filter((i) => i.status === 'QUEUED').length,
    sent: items.filter((i) => i.status === 'SENT').length,
    skipped: items.filter((i) => i.status === 'SKIPPED').length,
    failed: items.filter((i) => i.status === 'FAILED' || i.status === 'UNKNOWN').length,
    /** 묶음으로 줄인 문자 수 = 묶음에 든 안내 수 − 묶음 수 */
    saved: sentInBundles.length - new Set(sentInBundles.map((i) => i.bundleId)).size,
  };
  return { rows, queue, since };
}
