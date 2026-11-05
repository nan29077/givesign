import Link from 'next/link';
import { ChevronLeft } from 'lucide-react';
import { Badge, EmptyState, Notice, SectionTitle, Table, Td, Th, cx } from '@/components/ui';
import { PageHeader } from '@/components/layout/console-shell';
import { InlineActionForm } from '@/components/studio/action-form';
import {
  archiveIssuedDocumentAction, resendIssuedDocumentAction, restoreIssuedDocumentAction,
} from '@/app/actions/studio-documents';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { DOCUMENT_PURPOSE_LABEL, DOCUMENT_PURPOSES, type DocumentPurpose } from '@/server/services/purpose-documents';
import { ISSUED_STATUS_LABEL } from '@/server/services/issued-documents';
import { formatKst } from '@/lib/datetime';
import { formatNumber } from '@/lib/money';
import { maskName } from '@/lib/crypto';

export const dynamic = 'force-dynamic';

/**
 * 용도별 자동 발송 문서 — 발급 목록·재발송·보관.
 * 후원자는 표시 이름(가림)과 마스킹 번호로만 보인다. 문서 본문(후원자 이름이 든 스냅샷)은 여기서 펼치지 않는다.
 */
export default async function IssuedDocumentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; purpose?: string }>;
}) {
  const { merchantId } = await requireMerchant();
  const sp = await searchParams;
  const archived = sp.tab === 'archived';
  const purpose = (DOCUMENT_PURPOSES as readonly string[]).includes(sp.purpose ?? '') ? (sp.purpose as DocumentPurpose) : null;

  const where = { merchantId, archivedAt: archived ? { not: null } : null, ...(purpose ? { purpose } : {}) };
  const [rows, total, archivedTotal] = await Promise.all([
    prisma.issuedDocument.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.issuedDocument.count({ where: { merchantId, archivedAt: null } }),
    prisma.issuedDocument.count({ where: { merchantId, archivedAt: { not: null } } }),
  ]);
  const payers = await prisma.payerProfile.findMany({
    where: { id: { in: Array.from(new Set(rows.map((r) => r.payerId))) } },
    select: { id: true, displayName: true, phoneMasked: true },
  });
  const payerOf = new Map(payers.map((p) => [p.id, p]));

  return (
    <>
      <Link href="/studio/documents?tab=purposes" className="mb-2 inline-flex items-center gap-1 text-[12.5px] font-bold text-ink-500 hover:text-ink-900">
        <ChevronLeft size={15} strokeWidth={1.8} />
        자동 발송 현황으로
      </Link>
      <PageHeader title="발급 문서" description="감사장·확인서·서명 요청처럼 용도별 자동 발송으로 만든 문서입니다. 최근 200건." />

      <nav aria-label="발급 문서 구분" className="mb-3 flex flex-wrap gap-1.5">
        {[
          { href: '/studio/documents/issued', label: `발급 ${formatNumber(total)}`, on: !archived && !purpose },
          { href: '/studio/documents/issued?tab=archived', label: `보관함 ${formatNumber(archivedTotal)}`, on: archived },
        ].map((t) => (
          <Link key={t.href} href={t.href} className={cx('rounded-full px-3 py-1.5 text-[12px] font-bold', t.on ? 'bg-brand-400 text-ink-900' : 'bg-ink-50 text-ink-500 hover:text-ink-800')}>
            {t.label}
          </Link>
        ))}
        {DOCUMENT_PURPOSES.map((p) => (
          <Link
            key={p}
            href={`/studio/documents/issued?purpose=${p}${archived ? '&tab=archived' : ''}`}
            className={cx('rounded-full px-3 py-1.5 text-[12px] font-bold', purpose === p ? 'bg-ink-900 text-white' : 'bg-ink-50 text-ink-500 hover:text-ink-800')}
          >
            {DOCUMENT_PURPOSE_LABEL[p]}
          </Link>
        ))}
      </nav>

      <div className="mb-3">
        <SectionTitle
          title={archived ? '보관한 문서' : '발급한 문서'}
          description="재발송하면 새 열람 링크를 보내고 이전 링크는 더 열리지 않습니다. 서명 문서는 전자문서 센터에서 재안내합니다."
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title={archived ? '보관한 문서가 없습니다' : '아직 발급한 문서가 없습니다'}
          description="후원·약정·봉사 활동에 맞춰 자동 발송이 시작되면 여기에 쌓입니다."
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>발급</Th>
              <Th>문서</Th>
              <Th>후원자</Th>
              <Th>상태</Th>
              <Th>안내 · 열람</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = ISSUED_STATUS_LABEL[r.status] ?? ISSUED_STATUS_LABEL.ISSUED!;
              const p = payerOf.get(r.payerId);
              const label = DOCUMENT_PURPOSE_LABEL[r.purpose as DocumentPurpose] ?? r.purpose;
              return (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-[11.5px] text-ink-500">{formatKst(r.createdAt, false)}</Td>
                  <Td>
                    <span className="block text-[12.5px] font-bold text-ink-800">{r.title}</span>
                    <span className="block text-[11px] text-ink-400">{label}{r.missingFields.length ? ` · 빈칸 ${r.missingFields.join(', ')}` : ''}</span>
                  </Td>
                  <Td>
                    <span className="block text-[12.5px] text-ink-700">{p?.displayName ? maskName(p.displayName) : '후원자'}</span>
                    <span className="block text-[11px] tabular-nums text-ink-400">{p?.phoneMasked ?? '-'}</span>
                  </Td>
                  <Td><Badge tone={st.tone}>{st.text}</Badge></Td>
                  <Td className="text-[11.5px] text-ink-500">
                    {r.signature ? (
                      r.envelopeId ? <Link href={`/studio/e-documents/${r.envelopeId}`} className="font-bold text-brand-700 hover:underline">서명 진행 보기</Link> : '-'
                    ) : (
                      <>
                        <span className="block">{r.sentAt ? `보냄 ${formatKst(r.sentAt, false)}` : r.sendError ? <span className="text-danger-500">{r.sendError}</span> : '보내지 않음'}</span>
                        <span className="block">{r.viewCount ? `열람 ${r.viewCount}회` : '열람 전'}{r.expiresAt && r.expiresAt < new Date() ? ' · 링크 만료' : ''}</span>
                      </>
                    )}
                  </Td>
                  <Td className="text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {archived ? (
                        <InlineActionForm action={restoreIssuedDocumentAction} submitLabel="되살리기" variant="secondary" fields={{ issuedId: r.id }} />
                      ) : (
                        <>
                          {!r.signature ? (
                            <InlineActionForm
                              action={resendIssuedDocumentAction}
                              submitLabel="재발송"
                              variant="secondary"
                              fields={{ issuedId: r.id }}
                              confirmMessage="새 열람 링크를 문자로 보냅니다. 이전 링크는 더 열리지 않습니다."
                            />
                          ) : null}
                          <InlineActionForm
                            action={archiveIssuedDocumentAction}
                            submitLabel="보관"
                            variant="ghost"
                            fields={{ issuedId: r.id }}
                            confirmMessage="이 문서를 보관합니다. 열람 링크가 더 열리지 않고, 보관함에서 되살릴 수 있습니다."
                          />
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <div className="mt-4">
        <Notice tone="neutral" title="문서 내용은 발급 당시로 고정됩니다">
          발급할 때 서식과 머지 값을 스냅샷으로 고정하고 확인값(SHA-256)을 남깁니다. 나중에 서식을 고쳐도 이미 보낸 문서는 바뀌지 않습니다.
        </Notice>
      </div>
    </>
  );
}
