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
import { purposeStatus } from '@/server/services/purpose-templates';
import { MANUAL_ONLY_PURPOSES } from '@/server/services/purpose-documents';

export const dynamic = 'force-dynamic';

/**
 * 문서 관리 — 서식 목록과 제출된 문서.
 *
 * 등록·수정은 별도 화면(/studio/documents/new, /studio/documents/[id])에서 한다.
 * 후원 항목 관리와 같은 규칙이다 — 목록에 폼을 펼치면 저장 버튼이 여러 개 생겨
 * 무엇을 저장했는지 알 수 없다.
 */

const TABS = [
  { key: 'purposes', label: '자동 발송' },
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

  const [templates, archived, archivedTotal, submissions, submissionTotal, pendingCount, draftCount, _productCounts] =
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
  const purposes = tab === 'purposes' ? await purposeStatus(merchantId) : [];
  const issuedTotal = await prisma.issuedDocument.count({ where: { merchantId, archivedAt: null } });

  return (
    <>
      <PageHeader
        title="문서 관리"
        description="후원약정서·봉사 신청서 등 기관 서식을 등록하고 전자문서 센터에서 작성 요청을 보냅니다."
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
          label="기관 서식"
          value={formatNumber(activeTemplates.length)}
          sub="전자문서 센터에서 작성 요청"
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
        className="mb-4 grid grid-cols-4 overflow-hidden rounded-2xl border border-ink-100 bg-white p-1 shadow-[0_8px_24px_rgba(23,22,26,0.05)]"
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
              {t.key === 'purposes' ? issuedTotal : t.key === 'templates' ? templates.length : t.key === 'submissions' ? submissionTotal : archivedTotal}
            </span>
          </Link>
        ))}
      </nav>

      {/* ── 용도별 자동 발송 현황 ─────────────────────────────── */}
      {tab === 'purposes' ? (
        <>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <SectionTitle
              title="용도별 자동 발송"
              description="후원·약정·봉사 활동이 생기면 용도마다 걸린 서식으로 문서를 만들어 보냅니다. 서식이 없으면 기본 서식을 복사해 씁니다."
            />
            <LinkButton href="/studio/documents/issued" variant="secondary">
              발급 문서 {formatNumber(issuedTotal)}건
            </LinkButton>
          </div>
          <Table>
            <thead>
              <tr>
                <Th>용도</Th>
                <Th>보내는 방법</Th>
                <Th>서식</Th>
                <Th>상태</Th>
              </tr>
            </thead>
            <tbody>
              {purposes.map((p) => (
                <tr key={p.purpose}>
                  <Td className="text-[12.5px] font-bold text-ink-800">{p.label}</Td>
                  <Td className="text-[12px] text-ink-500">
                    {p.signature ? '전자서명 요청(이용요금 1건)' : '열람 링크 문자'}
                    {MANUAL_ONLY_PURPOSES.includes(p.purpose) ? <span className="block text-ink-400">자동 발송 없음 — 전자문서 센터에서 직접 보냅니다</span> : null}
                  </Td>
                  <Td>
                    {p.template ? (
                      <Link href={`/studio/documents/${p.template.id}`} className="text-[12.5px] font-bold text-brand-700 hover:underline">
                        {p.template.name}
                      </Link>
                    ) : (
                      <span className="text-[12px] text-ink-400">없음 — 첫 발송 때 기본 서식을 복사합니다</span>
                    )}
                    {p.template?.defaultSet ? (
                      <span className="ml-1.5"><Badge tone="neutral">{p.template.unchanged ? '기본 서식 그대로' : '기본 서식에서 수정'}</Badge></span>
                    ) : p.template ? (
                      <span className="ml-1.5"><Badge tone="brand">기관 서식</Badge></span>
                    ) : null}
                  </Td>
                  <Td>
                    {!p.template ? (
                      <Badge tone="neutral">기본 서식 대기</Badge>
                    ) : p.sending ? (
                      <Badge tone="success">자동 발송 중</Badge>
                    ) : !p.template.active ? (
                      <Badge tone="warning">서식 중지</Badge>
                    ) : (
                      <Badge tone="warning">자동 발송 끔</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4">
            <Notice tone="neutral" title="자동 발송 규칙">
              감사장·확인서는 서명 없이 열람 링크로 보내며 링크는 30일 동안 열립니다(지나면 후원자 마이페이지에서 다시 엽니다).
              약정서·신청서·변경 신청서는 전자문서 센터 서명 요청으로 보내고 이용요금이 1건 차감됩니다. 잔액이 없으면 보내지 않고 승인 대기함에 올라갑니다.
              기부금영수증은 이 기능으로 만들지 않고 영수증 대장에서만 발급합니다. 탈퇴한 후원자에게는 보내지 않습니다.
            </Notice>
          </div>
        </>
      ) : null}

      {/* ── 서식 목록 ─────────────────────────────────────────── */}
      {tab === 'templates' ? (
        <>
          <div className="mb-4">
            <SectionTitle
              title="문서 서식"
              description="기관 서식을 등록한 뒤 전자문서 센터에서 수신인을 지정해 작성 요청 링크를 발급하세요."
            />
          </div>

          {templates.length === 0 ? (
            <EmptyState
              title="등록된 서식이 없습니다"
              description="후원약정서·자원봉사 신청서 등 필요한 기관 서식을 먼저 등록해 주세요."
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
                            {t.purpose ? <Badge tone={t.autoSend ? 'success' : 'warning'}>{t.autoSend ? '자동 발송' : '자동 발송 끔'}</Badge> : null}
                          </div>

                          {t.description ? (
                            <p className="mt-1 truncate text-[12.5px] text-ink-500">{t.description}</p>
                          ) : null}

                          <p className="mt-0.5 text-[11.5px] text-ink-400">
                            입력 항목 {fields.length}개 · 작성 요청용 기관 서식 · 제출{' '}
                            {formatNumber(t._count.submissions)}건 · 등록 {formatKst(t.createdAt, false)}
                          </p>

                          {t._count.products === 0 ? (
                            <p className="mt-1 text-[11.5px] font-bold text-warning-500">
                              전자문서 센터에서 수신인에게 작성 요청을 보낼 수 있습니다.
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
              기브싸인은 결제와 작성 링크 전달까지만 맡습니다. 제출된 내용의 검토·보관·후속 처리는 사회복지기관이 하며,
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
