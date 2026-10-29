import Link from 'next/link';
import { Clock, MessageSquareText, Monitor, Smartphone, Undo2 } from 'lucide-react';
import { Badge, cx } from '@/components/ui';
import { formatWon } from '@/lib/money';
import { formatKst } from '@/lib/datetime';
import { channelLabel, deliveryStatusLabel, chargeStatusLabel, refundStatusLabel } from '@/lib/labels';
import type { DeliveryStatus, ChargeStatus, RefundStatus } from '@/generated/prisma/enums';

/**
 * 문자 후원 내역 카드.
 *
 * 대시보드(최근 몇 건)와 후원 내역(전체 목록) 두 곳에서 같은 카드를 쓴다.
 * 표는 컬럼이 많아 모바일에서 가로 스크롤이 필요하지만, 카드는 한 건씩 세로로
 * 읽히므로 이동 중에 휴대폰으로 확인하기 좋다.
 *
 * 개인정보 규칙
 *  - 전화번호는 저장 시점에 마스킹된 값(`payer.phoneMasked`, 010-****-1234)만 받는다.
 *    이 컴포넌트는 복호화나 원문 접근을 하지 않는다.
 *  - 문자 내용도 금칙어 필터를 거친 노출용 본문(`charge.message`)만 받는다.
 *    분쟁 대응용 원문(messageRawEnc)은 사회복지기관에 제공하지 않는다.
 */

export interface ChargeCardItem {
  id: string;
  transactionNo: string;
  /** 문자 수신(= 결제 접수) 시각 */
  receivedAt: Date;
  displayName: string;
  anonymous: boolean;
  /** 필터링을 마친 문자 내용 */
  message: string;
  amount: bigint;
  status: ChargeStatus;
  /** MO(문자) | WEB(PC 웹 결제) */
  channel: string;
  /** 마스킹된 후원자 전화번호. 웹 결제 등으로 후원자 정보가 없으면 null */
  phoneMasked: string | null;
  /** 전달 상태를 함께 보여줄 때만 넘긴다 (대시보드에서는 생략) */
  delivery?: { mt: DeliveryStatus; point?: DeliveryStatus } | null;
  refundStatus?: RefundStatus | null;
}

export function ChargeCard({ item }: { item: ChargeCardItem }) {
  const status = chargeStatusLabel[item.status];
  const isWeb = item.channel === 'WEB';
  const refund = item.refundStatus ? refundStatusLabel[item.refundStatus] : null;

  return (
    <Link
      href={`/studio/charges/${item.id}`}
      // 카드 전체가 터치 영역이다. 모바일에서 작은 링크를 조준하지 않아도 되게 한다.
      className={cx(
        'group flex h-full min-h-[168px] flex-col rounded-2xl border border-ink-100 bg-white p-4',
        'transition-all hover:-translate-y-0.5 hover:border-brand-200 hover:shadow-[var(--shadow-lift)]',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500',
      )}
    >
      {/* 후원자 전화번호 + 결제 상태 */}
      <div className="flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {isWeb ? (
            <Monitor size={15} strokeWidth={1.7} className="shrink-0 text-ink-300" />
          ) : (
            <Smartphone size={15} strokeWidth={1.7} className="shrink-0 text-brand-700" />
          )}
          <span className="truncate font-mono text-[13.5px] font-bold tabular-nums text-ink-900">
            {item.phoneMasked ?? '번호 없음'}
          </span>
        </span>
        <Badge tone={status.tone}>{status.text}</Badge>
      </div>

      {/* 표시명 + 접수 채널 */}
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-400">
        <span className="font-semibold text-ink-500">
          {item.anonymous ? '익명의 후원자' : item.displayName}
        </span>
        <span aria-hidden>·</span>
        <span>{channelLabel(item.channel, 'long')}</span>
      </p>

      {/* 문자 내용 */}
      <div className="mt-2.5 flex flex-1 gap-1.5 rounded-xl bg-ink-50 px-3 py-2.5">
        <MessageSquareText size={14} strokeWidth={1.6} className="mt-0.5 shrink-0 text-ink-300" />
        <p className="line-clamp-3 text-[13px] leading-relaxed break-words text-ink-700">
          {item.message || '(내용 없음)'}
        </p>
      </div>

      {/* 결제 일시 + 금액 */}
      <div className="mt-3 flex items-end justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] tabular-nums text-ink-400">
          <Clock size={13} strokeWidth={1.7} className="shrink-0" />
          <span className="truncate">{formatKst(item.receivedAt, false)}</span>
        </span>
        <span className="shrink-0 text-[17px] font-black tracking-[-0.02em] tabular-nums text-ink-900">
          {formatWon(item.amount)}
        </span>
      </div>

      {/* 전달 상태 (후원 내역 화면에서만) */}
      {item.delivery ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-ink-100 pt-3">
          <DeliveryChip label="MT" status={item.delivery.mt} />
          {item.delivery.point ? <DeliveryChip label="지급" status={item.delivery.point} /> : null}
          {refund ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-danger-50 px-2 py-0.5 text-[11px] font-semibold text-danger-500">
              <Undo2 size={12} strokeWidth={1.8} />
              환불 {refund.text}
            </span>
          ) : null}
        </div>
      ) : null}

      <span className="mt-2 block font-mono text-[10.5px] text-ink-300">{item.transactionNo}</span>
    </Link>
  );
}

/** 전달 상태 한 칸. 뱃지보다 작고 담백하게 표시한다. */
function DeliveryChip({ label, status }: { label: string; status: DeliveryStatus }) {
  const s = deliveryStatusLabel[status];
  const tone =
    s.tone === 'success' ? 'text-success-500'
    : s.tone === 'danger' ? 'text-danger-500'
    : s.tone === 'warning' ? 'text-warning-500'
    : 'text-ink-400';
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-ink-50 px-2 py-0.5 text-[11px] font-semibold text-ink-500">
      {label}
      <span className={tone}>{s.text}</span>
    </span>
  );
}

/**
 * 카드 그리드.
 * 모바일 1열(풀 width) → 태블릿 2열 → 넓은 화면 3열.
 * `dense` 는 대시보드처럼 폭이 좁은 자리에서 2열까지만 늘린다.
 */
export function ChargeCardGrid({
  items,
  dense = false,
}: {
  items: ChargeCardItem[];
  dense?: boolean;
}) {
  return (
    <div className={cx('grid gap-3', dense ? 'sm:grid-cols-2' : 'sm:grid-cols-2 xl:grid-cols-3')}>
      {items.map((item) => (
        <ChargeCard key={item.id} item={item} />
      ))}
    </div>
  );
}
