import Link from 'next/link';
import { FileText } from 'lucide-react';
import { Badge } from '@/components/ui';
import { formatKst } from '@/lib/datetime';
import type { ReceivedDocument } from '@/server/services/donor-documents';

/** 받은 문서 목록(감사장·확인서·약정서). base 아래 /documents/[id], /agreements/[id] 로 연다. */
export function ReceivedDocumentsList({ docs, base, showMerchant }: { docs: ReceivedDocument[]; base: string; showMerchant: boolean }) {
  if (docs.length === 0) return <p className="mt-3 text-[16px] text-ink-500">아직 받은 문서가 없습니다.</p>;
  return (
    <ul className="mt-3 space-y-2">
      {docs.map((d) => (
        <li key={`${d.kind}:${d.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-ink-50 px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-[16px] font-bold text-ink-900">
              <FileText size={18} strokeWidth={1.7} className="shrink-0 text-ink-500" />
              <span className="truncate">{showMerchant ? `${d.merchantName} ` : ''}{d.title}</span>
              {d.version ? <Badge className="text-[12px]">제{d.version}판</Badge> : null}
            </p>
            <p className="mt-0.5 text-[14px] text-ink-500">{formatKst(d.createdAt, false)}{d.statusText ? ` · ${d.statusText}` : ''}</p>
          </div>
          {d.needsSignature ? (
            <span className="text-[14px] text-ink-500">문자로 받은 서명 링크에서 서명</span>
          ) : (
            <Link href={`${base}/${d.kind === 'AGREEMENT' ? 'agreements' : 'documents'}/${d.id}`} className="inline-flex h-11 items-center rounded-xl border border-ink-200 bg-white px-4 text-[15px] font-bold text-ink-900">열람</Link>
          )}
        </li>
      ))}
    </ul>
  );
}
