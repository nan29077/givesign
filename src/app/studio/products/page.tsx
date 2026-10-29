import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import {
  Badge, Card, EmptyState, LinkButton, Notice, SectionTitle, StatTile, cx,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { InlineActionForm } from '@/components/studio/action-form';
import {
  archiveChargeProductAction,
  duplicateChargeProductAction,
  moveChargeProductAction,
  restoreChargeProductAction,
  toggleChargeProductActiveAction,
} from '@/app/actions/studio';
import { PAID_STATUSES } from '@/components/studio/shared';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { resolvePolicy } from '@/server/services/limits';
import {
  digitalTypeLabel, giveText, quoteShipping, shippingPolicyOf, stockText,
} from '@/server/services/products';
import { formatWon, formatNumber } from '@/lib/money';
import { formatKst } from '@/lib/datetime';

export const dynamic = 'force-dynamic';

/**
 * 후원 항목 관리 — 목록.
 *
 * 등록·수정은 별도 화면(/studio/products/new, /studio/products/[id])에서 한다.
 * 목록에 폼을 펼쳐 두면 상품 수만큼 저장 버튼이 생겨 어느 것을 저장했는지 알 수 없다.
 */

const TABS = [
  { key: 'physical', label: '실물 상품' },
  { key: 'digital', label: '비실물(컨텐츠)' },
  { key: 'document', label: '문서' },
  { key: 'archived', label: '보관함' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export default async function StudioProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : 'physical';

  const [merchant, products, archived, archivedTotal, policy, shippingRow, soldByProduct] = await Promise.all([
    prisma.merchantProfile.findUnique({
      where: { id: merchantId },
      select: { id: true, displayName: true, allowCustomAmount: true, minAmount: true, maxAmount: true },
    }),
    prisma.chargeProduct.findMany({
      where: { merchantId, archivedAt: null },
      orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      // 문서 상품은 어떤 서식을 가리키는지 목록에서 바로 보여야 한다.
      include: { documentTemplate: { select: { name: true, active: true } } },
    }),
    prisma.chargeProduct.findMany({
      where: { merchantId, archivedAt: { not: null } },
      orderBy: { archivedAt: 'desc' },
      take: 50,
      // 보관 목록도 같은 카드로 그린다. include 가 다르면 두 목록의 타입이 갈린다.
      include: { documentTemplate: { select: { name: true, active: true } } },
    }),
    // 배지에 잘린 목록 길이를 쓰면 보관 상품이 50개를 넘을 때 숫자가 50 에서 멈춘다.
    prisma.chargeProduct.count({ where: { merchantId, archivedAt: { not: null } } }),
    resolvePolicy(merchantId, null),
    prisma.merchantShippingPolicy.findUnique({ where: { merchantId } }),
    prisma.charge.groupBy({
      by: ['productId'],
      // 상태를 걸지 않으면 PIN 실패·한도 차단·환불 건까지 "판매" 로 세어 부풀려진다.
      where: { merchantId, productId: { not: null }, status: { in: PAID_STATUSES } },
      _count: { _all: true },
    }),
  ]);
  if (!merchant) notFound();

  const shipping = shippingPolicyOf(shippingRow);
  const effMax = merchant.maxAmount < policy.maxAmount ? merchant.maxAmount : policy.maxAmount;

  const digital = products.filter((p) => p.kind === 'DIGITAL');
  const physical = products.filter((p) => p.kind === 'PHYSICAL');
  const documents = products.filter((p) => p.kind === 'DOCUMENT');
  const soldOf = (id: string) => soldByProduct.find((s) => s.productId === id)?._count._all ?? 0;

  const lowStock = physical.filter(
    (p) => p.stock !== null && p.stockAlert !== null && p.stock <= p.stockAlert,
  );
  const soldOut = physical.filter((p) => p.stock !== null && p.stock <= 0);

  const rows =
    tab === 'physical' ? physical : tab === 'digital' ? digital : tab === 'document' ? documents : archived;
  const newKind = tab === 'digital' ? 'DIGITAL' : tab === 'document' ? 'DOCUMENT' : 'PHYSICAL';

  return (
    <>
      <PageHeader
        title="후원 항목 관리"
        description="후원자가 문자를 보내면 여기에 등록한 상품 중에서 고르고 결제합니다."
      />

      <div className="mb-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="실물 상품"
          value={formatNumber(physical.length)}
          sub={`노출 중 ${physical.filter((p) => p.active).length}개`}
          tone="brand"
        />
        <StatTile
          label="비실물(컨텐츠)"
          value={formatNumber(digital.length)}
          sub={`노출 중 ${digital.filter((p) => p.active).length}개`}
        />
        <StatTile
          label="재고 부족"
          value={formatNumber(lowStock.length)}
          sub={lowStock.length > 0 ? lowStock.map((p) => p.name).slice(0, 2).join(', ') : '없음'}
          tone={lowStock.length > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="품절"
          value={formatNumber(soldOut.length)}
          sub={soldOut.length > 0 ? '선택 화면에서 품절 표시' : '없음'}
          tone={soldOut.length > 0 ? 'danger' : 'neutral'}
        />
      </div>

      <nav
        aria-label="후원 항목 관리 메뉴"
        className="mb-4 grid grid-cols-2 overflow-hidden rounded-2xl border border-ink-100 bg-white p-1 shadow-[0_8px_24px_rgba(23,22,26,0.05)] sm:grid-cols-4"
      >
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/studio/products?tab=${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cx(
              'flex min-h-11 items-center justify-center rounded-xl px-1 text-center text-[12px] font-bold transition-colors sm:px-3 sm:text-[13px]',
              tab === t.key ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-800',
            )}
          >
            {t.label}
            <span className="ml-1 tabular-nums opacity-60">
              {t.key === 'physical'
                ? physical.length
                : t.key === 'digital'
                  ? digital.length
                  : t.key === 'document'
                    ? documents.length
                    : archivedTotal}
            </span>
          </Link>
        ))}
      </nav>

      {tab !== 'archived' ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <SectionTitle
            title={tab === 'physical' ? '실물 상품' : tab === 'document' ? '문서 상품' : '비실물(컨텐츠) 상품'}
            description={
              tab === 'physical'
                ? '배송이 필요한 상품입니다. 배송비·재고·옵션·반품 조건을 상품별로 지정합니다.'
                : tab === 'document'
                  ? '약정서 · 주문서 · 계약서처럼 결제 뒤 후원자가 작성해 제출하는 상품입니다.'
                  : '후원금 · 상품권 · 이용권 · 컨텐츠처럼 배송이 없는 상품입니다.'
            }
          />
          <LinkButton href={`/studio/products/new?kind=${newKind.toLowerCase()}`} variant="primary">
            <Plus size={15} strokeWidth={1.6} />
            상품 등록
          </LinkButton>
        </div>
      ) : (
        <div className="mb-4">
          <SectionTitle
            title="보관함"
            description="보관한 상품입니다. 지난 후원 내역은 그대로 남아 있고, 언제든 되살릴 수 있습니다."
          />
        </div>
      )}

      {tab === 'digital' ? (
        <div className="mb-4">
          <Notice tone="neutral" title="지급은 사회복지기관이 합니다">
            기브싸인는 결제와 정산만 대행합니다. 후원금·상품권·이용권의 발행과 지급은 사회복지기관이 하며, 상품마다
            지급 방식(수동 / 연동 API / 결제 즉시 문자 발급)을 정할 수 있습니다.
          </Notice>
        </div>
      ) : null}

      {tab === 'document' ? (
        <div className="mb-4">
          <Notice tone="neutral" title="서식을 먼저 등록해야 합니다">
            문서 상품은{' '}
            <Link href="/studio/documents" className="font-bold text-brand-700">
              문서 관리
            </Link>{' '}
            에 등록한 서식을 가리킵니다. 결제가 끝나면 후원자에게 작성 링크가 문자로 가고, 제출된 문서는 문서 관리에서
            확인합니다. 배송과 후원금 지급은 일어나지 않습니다.
          </Notice>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title={tab === 'archived' ? '보관한 상품이 없습니다' : '등록된 상품이 없습니다'}
          description={
            tab === 'archived'
              ? '상품을 보관하면 여기에서 되살릴 수 있습니다.'
              : '상품이 하나도 없고 직접 입력도 꺼져 있으면 후원자가 결제를 진행할 수 없습니다.'
          }
          action={
            tab !== 'archived' ? (
              <LinkButton href={`/studio/products/new?kind=${newKind.toLowerCase()}`} variant="primary">
                <Plus size={15} strokeWidth={1.6} />
                첫 상품 등록하기
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-2.5">
          {rows.map((p, i) => {
            const stock = stockText(p);
            const quote =
              p.kind === 'PHYSICAL'
                ? quoteShipping(p, 1, shipping)
                : { total: p.amount, fee: 0n, freeReason: null };
            // 비실물은 한도를 넘으면 결제 화면 목록에서 아예 빠진다(charge-select).
            // 목록에서 경고하지 않으면 "노출 중" 으로 보이는데 결제 화면에 없는 이유를 찾을 수 없다.
            const overLimit = quote.total > effMax;
            return (
              <li key={p.id}>
                <Card>
                  {/* 모바일: 세로 스택(정보→액션 바), sm 이상: 가로 한 줄 */}
                  <div className="flex flex-col gap-0 sm:flex-row sm:items-start sm:gap-3">
                    {/* 이미지 + 상품 정보 */}
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      {p.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={p.imageUrl}
                          alt=""
                          className="h-16 w-16 shrink-0 rounded-xl border border-ink-100 object-cover"
                        />
                      ) : (
                        <span className="grid h-16 w-16 shrink-0 place-items-center rounded-xl border border-dashed border-ink-200 text-[10.5px] font-bold text-ink-300">
                          이미지 없음
                        </span>
                      )}

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {tab === 'archived' ? (
                            <span className="text-[14px] font-bold text-ink-700">{p.name}</span>
                          ) : (
                            <Link
                              href={`/studio/products/${p.id}`}
                              className="text-[14px] font-bold text-ink-900 hover:text-brand-700 hover:underline"
                            >
                              {p.name}
                            </Link>
                          )}
                          {p.kind === 'DIGITAL' ? (
                            <Badge tone="brand">{digitalTypeLabel[p.digitalType ?? 'POINT']}</Badge>
                          ) : p.kind === 'DOCUMENT' ? (
                            <Badge tone="brand">문서</Badge>
                          ) : null}
                          {tab === 'archived' ? (
                            <Badge tone="neutral">보관됨</Badge>
                          ) : p.active ? (
                            <Badge tone="success">노출 중</Badge>
                          ) : (
                            <Badge tone="neutral">숨김</Badge>
                          )}
                          {p.kind === 'PHYSICAL' ? (
                            <Badge
                              tone={
                                p.stock !== null && p.stock <= 0
                                  ? 'danger'
                                  : p.stockAlert !== null && p.stock !== null && p.stock <= p.stockAlert
                                    ? 'warning'
                                    : 'neutral'
                              }
                            >
                              {stock ?? '재고 무제한'}
                            </Badge>
                          ) : null}
                          {p.taxFree ? <Badge tone="neutral">면세</Badge> : null}
                        </div>

                        {/* 가격 정보 — 실물 상품은 2줄로 나눠 가독성 확보 */}
                        {p.kind === 'PHYSICAL' ? (
                          <div className="mt-1 space-y-0.5 text-[12.5px] text-ink-500">
                            <p>
                              <span className="font-bold tabular-nums text-ink-900">{formatWon(p.amount)}</span>
                              {p.sku ? (
                                <span className="ml-1.5 font-mono text-[11px] text-ink-400">{p.sku}</span>
                              ) : null}
                            </p>
                            <p>
                              배송비{' '}
                              {quote.fee === 0n ? (
                                <span className="text-ink-400">무료</span>
                              ) : (
                                formatWon(quote.fee)
                              )}{' '}
                              · 결제{' '}
                              <span className="font-bold tabular-nums text-ink-800">{formatWon(quote.total)}</span>
                            </p>
                          </div>
                        ) : (
                          <p className="mt-1 text-[12.5px] text-ink-500">
                            <span className="font-bold tabular-nums text-ink-900">{formatWon(p.amount)}</span>
                            {p.kind === 'DOCUMENT' ? (
                              <span className="ml-1.5">
                                {p.documentTemplate ? `${p.documentTemplate.name} 작성` : '서식 미연결'}
                              </span>
                            ) : (
                              <span className="ml-1.5">{giveText(p) ? `${giveText(p)} 지급` : ''}</span>
                            )}
                            {p.sku ? (
                              <span className="ml-1.5 font-mono text-[11px] text-ink-400">{p.sku}</span>
                            ) : null}
                          </p>
                        )}

                        <p className="mt-0.5 text-[11.5px] text-ink-400">
                          판매 {formatNumber(soldOf(p.id))}건
                          {tab === 'archived' && p.archivedAt ? ` · 보관 ${formatKst(p.archivedAt, false)}` : ''}
                        </p>

                        {overLimit ? (
                          <p className="mt-1 text-[11.5px] font-bold text-danger-500">
                            배송비를 더하면 결제 한도({formatWon(effMax)})를 넘어 후원자가 결제할 수 없습니다.
                          </p>
                        ) : null}

                        {p.kind === 'DOCUMENT' && (!p.documentTemplate || !p.documentTemplate.active) ? (
                          <p className="mt-1 text-[11.5px] font-bold text-danger-500">
                            연결된 문서 서식이 없거나 중지 상태입니다. 후원자가 결제해도 작성할 문서가 없습니다.
                          </p>
                        ) : null}
                      </div>
                    </div>

                    {/* 액션 버튼 — 모바일: 구분선 아래 가로 바 / sm 이상: 우측 정렬 */}
                    <div className="mt-2.5 flex shrink-0 flex-wrap items-center gap-1.5 border-t border-ink-100 pt-2.5 sm:mt-0 sm:border-0 sm:pt-0">
                      {tab === 'archived' ? (
                        <InlineActionForm
                          action={restoreChargeProductAction}
                          submitLabel="되살리기"
                          variant="secondary"
                          fields={{ productId: p.id }}
                          confirmMessage={`${p.name} 상품을 되살립니다. 숨김 상태로 돌아오니 값을 확인한 뒤 노출해 주세요.`}
                        />
                      ) : (
                        <>
                          <div className="flex gap-0.5">
                            <InlineActionForm
                              action={moveChargeProductAction}
                              submitLabel="위로"
                              variant="ghost"
                              fields={{ productId: p.id, direction: 'up' }}
                              disabled={i === 0}
                              disabledReason="맨 위"
                            />
                            <InlineActionForm
                              action={moveChargeProductAction}
                              submitLabel="아래로"
                              variant="ghost"
                              fields={{ productId: p.id, direction: 'down' }}
                              disabled={i === rows.length - 1}
                              disabledReason="맨 아래"
                            />
                          </div>
                          <InlineActionForm
                            action={toggleChargeProductActiveAction}
                            submitLabel={p.active ? '숨기기' : '노출'}
                            variant="secondary"
                            fields={{ productId: p.id }}
                          />
                          <InlineActionForm
                            action={duplicateChargeProductAction}
                            submitLabel="복제"
                            variant="ghost"
                            fields={{ productId: p.id }}
                            confirmMessage={`${p.name} 을(를) 그대로 복제합니다. 복제본은 숨김 상태로 만들어집니다.`}
                          />
                          <InlineActionForm
                            action={archiveChargeProductAction}
                            submitLabel="보관"
                            variant="ghost"
                            fields={{ productId: p.id }}
                            confirmMessage={`${p.name} 상품을 보관합니다. 선택 화면에서 사라지며, 지난 후원 내역은 그대로 남습니다. 보관함에서 되살릴 수 있습니다.`}
                          />
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {tab !== 'archived' && rows.length > 1 ? (
        <p className="mt-3 flex items-center gap-1.5 text-[11.5px] text-ink-400">
          <ArrowUp size={13} strokeWidth={1.8} />
          <ArrowDown size={13} strokeWidth={1.8} />
          위/아래 버튼으로 결제 화면에 보이는 순서를 바꿉니다.
        </p>
      ) : null}
    </>
  );
}
