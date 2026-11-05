import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { InKindReceiptDocument } from '@/components/bazaar/in-kind-receipt-document';
import { PrintButton } from '@/components/receipts/print-button';

export const dynamic = 'force-dynamic';

/** 현물 기부금영수증 보기(기관). 법정 서류라 바자회 스위치와 무관하게 연다. */
export default async function StudioInKindReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const receipt = await prisma.inKindReceipt.findFirst({ where: { id, merchantId } });
  if (!receipt) notFound();
  return (
    <>
      <div className="print:hidden">
        <PageHeader title={`영수증 ${receipt.receiptNo}`} description="발급 당시 정보로 고정된 현물 기부금영수증입니다." action={<PrintButton />} />
        <p className="mb-4 text-[12.5px]"><Link href="/studio/receipts" className="font-bold text-brand-700">← 발급 대장으로</Link></p>
      </div>
      <InKindReceiptDocument receipt={receipt} />
    </>
  );
}
