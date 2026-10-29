import Link from 'next/link';
import { FileSignature, Plus } from 'lucide-react';
import {
  Badge, Card, EmptyState, LinkButton, Notice, SectionTitle, StatTile, Table, Td, Th, cx,
} from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { InlineActionForm } from '@/components/studio/action-form';
import {
  archiveDocumentTemplateAction,
  restoreDocumentTemplateAction,
  toggleDocumentTemplateActiveAction,
} from '@/app/actions/studio-documents';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import {
  DOCUMENT_LINK_TTL_DAYS, documentStatusLabel, documentTemplateTypeLabel, parseDocumentFields,
} from '@/server/services/documents';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';

export const dynamic = 'force-dynamic';

/**
 * 문서 관리 — 서식 목록과 제출된 문서.
 *
 * 등록·수정은 별도 화면(/studio/documents/new, /studio/documents/[id])에서 한다.
 * 후원 항목 관리와 같은 규칙이다 — 목록에 폼을 펼치면 저장 버튼이 여러 개 생겨
 * 무엇을 저장했는지 알 수 없다.
 */

const TABS = [
  { key: 'templates', label: '문서 서식' },
  { key: 'submissions', label: '제출된 문서' },
  { key: 'archived', label: '보관함' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export default async function StudioDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const tab: Tab = TABS.some((t) => t.key === sp.tab) ? (sp.tab as Tab) : 'templates';

  const [templates, archived, archivedTotal, submissions, submissionTotal, pendingCount, draftCount, productCounts] =
    await Promise.all([
      prisma.documentTemplate.findMany({
        where: { merchantId, archivedAt: null },
        orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
        include: { _count: { select: { submissions: true, products: true } } },
      }),
      prisma.documentTemplate.findMany({
        where: { merchantId, archivedAt: { not: null } },
        orderBy: { archivedAt: 'desc' },
        take: 50,
      }),
      prisma.documentTemplate.count({ where: { merchantId, archivedAt: { not: null } } }),
      prisma.documentSubmission.findMany({
        where: { merchantId },
        orderBy: [{ createdAt: 'desc' }],
        take: 100,
        include: {
          template: { select: { name: true } },
          charge: { select: { transactionNo: true, product: { select: { name: true } } } },
        },
      }),
      prisma.documentSubmission.count({ where: { merchantId } }),
      prisma.documentSubmission.count({ where: { merchantId, status: 'SUBMITTED' } }),
      prisma.documentSubmission.count({ where: { merchantId, status: 'DRAFT' } }),
      prisma.chargeProduct.count({ where: { merchantId, kind: 'DOCUMENT', archivedAt: null } }),
    ]);

  const activeTemplates = templates.filter((t) => t.active);

  return (
    <>
      <PageHeader
        title="문서 관리"
        description="약정서·주문서·계약서 서식을 등록하면, 그 서식을 쓰는 문서 상품을 결제한 후원자에게 작성 링크가 문자로 갑니다."
        action={
          <LinkButton href="/studio/documents/new" variant="primary">
            <Plus size={15} strokeWidth={1.6} />
            서식 등록
          </LinkButton>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile
          label="문서 서식"
          value={formatNumber(templates.length)}
          sub={`사용 중 ${activeTemplates.length}개`}
          tone="brand"
        />
        <StatTile
          label="문서 상품"
          value={formatNumber(productCounts)}
          sub={productCounts > 0 ? '후원 항목 관리에서 연결됨' : '아직 없음'}
        />
        <StatTile
          label="확인 대기"
          value={formatNumber(pendingCount)}
          sub={pendingCount > 0 ? '제출되었고 아직 확인 전' : '없음'}
          tone={pendingCount > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="작성 대기"
          value={formatNumber(draftCount)}
          sub={draftCount > 0 ? '후원자가 아직 작성하지 않음' : '없음'}
        />
      </div>

      <nav
        aria-label="문서 관리 메뉴"
        className="mb-4 grid grid-cols-3 overflow-hidden rounded-2xl border border-ink-100 bg-white p-1 shadow-[0_8px_24px_rgba(23,22,26,0.05)]"
      >
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/studio/documents?tab=${t.key}`}
            aria-current={tab === t.key ? 'page' : undefined}
            className={cx(
              'flex min-h-11 items-center justify-center rounded-xl px-1 text-center text-[12px] font-bold transition-colors sm:px-3 sm:text-[13px]',
              tab === t.key ? 'bg-brand-400 text-ink-900 shadow-sm' : 'text-ink-400 hover:bg-ink-50 hover:text-ink-800',
            )}
          >
            {t.label}
            <span className="ml-1 tabular-nums opacity-60">
              {t.key === 'templates' ? templates.length : t.key === 'submissions' ? submissionTotal : archivedTotal}
            </span>
          </Link>
        ))}
      </nav>

      {/* ── 서식 목록 ─────────────────────────────────────────── */}
      {tab === 'templates' ? (
        <>
          <div className="mb-4">
            <SectionTitle
              title="문서 서식"
              description="서식을 등록한 뒤 후원 항목 관리에서 [문서] 상품을 만들고 이 서식을 연결하세요."
            />
          </div>

          {templates.length === 0 ? (
            <EmptyState
              title="등록된 서식이 없습니다"
              description="약정서·주문서 같은 서식을 먼저 등록해야 문서 상품을 만들 수 있습니다."
              action={
                <LinkButton href="/studio/documents/new" variant="primary">
                  <Plus size={15} strokeWidth={1.6} />
                  첫 서식 등록하기
                </LinkButton>
              }
            />
          ) : (
            <ul className="space-y-2.5">
              {templates.map((t) => {
                const fields = parseDocumentFields(t.fields);
                return (
                  <li key={t.id}>
                    <Card>
                      <div className="flex flex-wrap items-start gap-3">
                        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border border-ink-100 bg-ink-50 text-ink-400">
                          <FileSignature size={20} strokeWidth={1.7} />
                        </span>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Link
                              href={`/studio/documents/${t.id}`}
                              className="text-[14px] font-bold text-ink-900 hover:text-brand-700 hover:underline"
                            >
                              {t.name}
                            </Link>
                            <Badge tone="brand">{documentTemplateTypeLabel[t.templateType].text}</Badge>
                            {t.active ? <Badge tone="success">사용 중</Badge> : <Badge tone="neutral">중지</Badge>}
                            {t.requireSignature ? <Badge tone="neutral">서명 받음</Badge> : null}
                          </div>

                          {t.description ? (
                            <p className="mt-1 truncate text-[12.5px] text-ink-500">{t.description}</p>
                          ) : null}

                          <p className="mt-0.5 text-[11.5px] text-ink-400">
                            입력 항목 {fields.length}개 · 연결된 상품 {t._count.products}개 · 제출{' '}
                            {formatNumber(t._count.submissions)}건 · 등록 {formatKst(t.createdAt, false)}
                          </p>

                          {t._count.products === 0 ? (
                            <p className="mt-1 text-[11.5px] font-bold text-warning-500">
                              연결된 상품이 없어 아직 아무도 이 서식을 받지 않습니다.
                            </p>
                          ) : null}
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                          <InlineActionForm
                            action={toggleDocumentTemplateActiveAction}
                            submitLabel={t.active ? '중지' : '사용'}
                            variant="secondary"
                            fields={{ templateId: t.id }}
                          />
                          <InlineActionForm
                            action={archiveDocumentTemplateAction}
                            submitLabel="보관"
                            variant="ghost"
                            fields={{ templateId: t.id }}
                            confirmMessage={`${t.name} 서식을 보관합니다. 제출된 문서는 그대로 남고, 보관함에서 되살릴 수 있습니다.`}
                          />
                        </div>
                      </div>
                    </Card>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4">
            <Notice tone="neutral" title="문서는 사회복지기관이 확인합니다">
              기브싸인는 결제와 작성 링크 전달까지만 맡습니다. 제출된 내용의 검토·보관·후속 처리는 사회복지기관이 하며,
              작성 링크는 발송 시점부터 {DOCUMENT_LINK_TTL_DAYS}일간 유효합니다.
            </Notice>
          </div>
        </>
      ) : null}

      {/* ── 제출된 문서 ───────────────────────────────────────── */}
      {tab === 'submissions' ? (
        <>
          <div className="mb-4">
            <SectionTitle
              title="제출된 문서"
              description="최근 100건입니다. 제출자 성명·연락처와 입력 내용은 상세 화면에서 열람할 때마다 기록이 남습니다."
            />
          </div>

          {submissions.length === 0 ? (
            <EmptyState
              title="아직 제출된 문서가 없습니다"
              description="문서 상품이 결제되면 후원자에게 작성 링크가 문자로 가고, 제출된 문서가 여기에 쌓입니다."
            />
          ) : (
            <Table>
                <thead>
                  <tr>
                    <Th>상태</Th>
                    <Th>서식</Th>
                    <Th>제출자</Th>
                    <Th>거래번호</Th>
                    <Th>제출 시각</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {submissions.map((s) => {
                    const label = documentStatusLabel[s.status];
                    return (
                      <tr key={s.id}>
                        <Td>
                          <Badge tone={label.tone}>{label.text}</Badge>
                        </Td>
                        <Td>
                          <span className="block text-[12.5px] font-bold text-ink-800">{s.template.name}</span>
                          {s.charge?.product?.name ? (
                            <span className="block text-[11px] text-ink-400">{s.charge.product.name}</span>
                          ) : null}
                        </Td>
                        <Td>
                          <span className="text-[12.5px] text-ink-700">{s.payerNameMasked ?? '-'}</span>
                          {s.payerPhoneMasked ? (
                            <span className="block text-[11px] tabular-nums text-ink-400">{s.payerPhoneMasked}</span>
                          ) : null}
                        </Td>
                        <Td className="font-mono text-[11.5px] text-ink-500">{s.charge?.transactionNo ?? '-'}</Td>
                        <Td className="text-[11.5px] text-ink-500">
                          {s.submittedAt ? formatKst(s.submittedAt, false) : '작성 대기'}
                        </Td>
                        <Td className="text-right">
                          <Link
                            href={`/studio/documents/submissions/${s.id}`}
                            className="text-[12px] font-bold text-brand-700 hover:underline"
                          >
                            보기
                          </Link>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
            </Table>
          )}
        </>
      ) : null}

      {/* ── 보관함 ───────────────────────────────────────────── */}
      {tab === 'archived' ? (
        <>
          <div className="mb-4">
            <SectionTitle
              title="보관함"
              description="보관한 서식입니다. 제출된 문서는 그대로 남아 있고, 언제든 되살릴 수 있습니다."
            />
          </div>

          {archived.length === 0 ? (
            <EmptyState
              title="보관한 서식이 없습니다"
              description="서식을 보관하면 여기에서 되살릴 수 있습니다."
            />
          ) : (
            <ul className="space-y-2.5">
              {archived.map((t) => (
                <li key={t.id}>
                  <Card>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[14px] font-bold text-ink-700">{t.name}</span>
                          <Badge tone="neutral">보관됨</Badge>
                          <Badge tone="neutral">{documentTemplateTypeLabel[t.templateType].text}</Badge>
                        </div>
                        <p className="mt-0.5 text-[11.5px] text-ink-400">
                          보관 {t.archivedAt ? formatKst(t.archivedAt, false) : '-'}
                        </p>
                      </div>
                      <InlineActionForm
                        action={restoreDocumentTemplateAction}
                        submitLabel="되살리기"
                        variant="secondary"
                        fields={{ templateId: t.id }}
                        confirmMessage={`${t.name} 서식을 되살립니다. 중지 상태로 돌아오니 내용을 확인한 뒤 사용을 켜 주세요.`}
                      />
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </>
  );
}
