import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireMerchant } from '@/server/auth';
import { prisma } from '@/server/db';
import { PageHeader } from '@/components/layout/console-shell';
import { ReceiptDocument } from '@/components/receipts/receipt-document';
import { PrintButton } from '@/components/receipts/print-button';

export const dynamic = 'force-dynamic';

export default async function StudioReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { merchantId } = await requireMerchant();
  const { id } = await params;
  const receipt = await prisma.donationReceipt.findFirst({ where: { id, merchantId } });
  if (!receipt) notFound();
  return (
    <>
      <div className="print:hidden">
        <PageHeader title={`영수증 ${receipt.receiptNo}`} description="발급 당시 정보로 고정된 서식입니다. 인쇄하거나 PDF 로 저장할 수 있습니다." action={<PrintButton />} />
        <p className="mb-4 text-[12.5px]"><Link href="/studio/receipts" className="font-bold text-brand-700">← 발급 대장으로</Link></p>
      </div>
      <ReceiptDocument receipt={receipt} />
    </>
  );
}
