import Link from 'next/link';
import { requirePayerContext, NO_PAYER_TITLE, NO_PAYER_DESC } from '@/components/my/payer';
import { prisma } from '@/server/db';
import { Badge, Card, EmptyState } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import { ISSUED_STATUS_LABEL } from '@/server/services/issued-documents';

export const dynamic = 'force-dynamic';

/** 받은 문서 — 기관이 보낸 감사장·확인서(열람 링크가 만료돼도 여기서 다시 연다)와 서명 요청 */
export default async function MyDocumentsPage() {
  const { payerId } = await requirePayerContext('/my/documents');
  if (!payerId) return <EmptyState title={NO_PAYER_TITLE} description={NO_PAYER_DESC} />;
  const rows = await prisma.issuedDocument.findMany({
    where: { payerId, archivedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, merchantId: true, title: true, status: true, signature: true, createdAt: true },
  });
  const merchants = await prisma.merchantProfile.findMany({
    where: { id: { in: Array.from(new Set(rows.map((r) => r.merchantId))) } },
    select: { id: true, displayName: true },
  });
  const nameOf = new Map(merchants.map((m) => [m.id, m.displayName]));
  return (
    <Card>
      <h2 className="text-[16px] font-black text-ink-900">받은 문서</h2>
      <p className="mt-1 text-[13px] text-ink-500">기관이 보낸 감사장·활동 확인서입니다. 문자 링크의 열람 기간이 지나도 여기서 다시 열 수 있습니다. 기부금영수증은 영수증 탭에서 확인해 주세요.</p>
      {rows.length === 0 ? (
        <p className="mt-4 text-[13px] text-ink-400">아직 받은 문서가 없습니다.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {rows.map((r) => {
            const st = ISSUED_STATUS_LABEL[r.status] ?? ISSUED_STATUS_LABEL.ISSUED!;
            return (
              <li key={r.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-bold text-ink-900">{nameOf.get(r.merchantId) ?? '기관'} {r.title}</p>
                  <p className="text-[12px] text-ink-400">{formatKst(r.createdAt, false)} {r.signature ? <Badge tone={st.tone} className="ml-1">{st.text}</Badge> : null}</p>
                </div>
                {r.signature ? (
                  <span className="shrink-0 text-[12px] text-ink-400">문자로 받은 서명 링크에서 서명</span>
                ) : (
                  <Link href={`/my/documents/${r.id}`} className="shrink-0 text-[13px] font-bold text-brand-700">열람</Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
