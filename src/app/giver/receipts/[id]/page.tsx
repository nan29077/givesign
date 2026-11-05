import { notFound } from 'next/navigation';
import { InKindReceiptDocument } from '@/components/bazaar/in-kind-receipt-document';
import { PrintButton } from '@/components/receipts/print-button';
import { prisma } from '@/server/db';
import { giverPageContext } from '@/server/giver-context';

export const dynamic = 'force-dynamic';

export default async function GiverReceiptView({ params }: { params: Promise<{ id: string }> }) {
  const { donor } = await giverPageContext();
  const { id } = await params;
  const r = await prisma.inKindReceipt.findFirst({ where: { id, donorId: donor.id } });
  if (!r) notFound();
  return (
    <div>
      <div className="mb-3 flex justify-end print:hidden"><PrintButton /></div>
      <InKindReceiptDocument receipt={r} />
    </div>
  );
}
