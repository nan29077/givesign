import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { receiptByToken } from '@/server/services/receipts';
import { ReceiptDocument } from '@/components/receipts/receipt-document';
import { PrintButton } from '@/components/receipts/print-button';
import { Logo } from '@/components/brand/logo';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '기부금영수증', robots: { index: false, follow: false } };

/**
 * 후원자가 문자 링크·마이페이지에서 여는 영수증 열람 화면.
 * 토큰은 발급 때 1회 생성되고 마이페이지에서 재발급할 수 있다. 토큰이 없으면 404.
 */
export default async function PublicReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const receipt = await receiptByToken(token);
  if (!receipt) notFound();
  return (
    <main className="min-h-screen bg-ink-50 px-4 py-6 print:bg-white print:p-0">
      <div className="mx-auto mb-4 flex max-w-[760px] items-center justify-between print:hidden">
        <Logo />
        <PrintButton />
      </div>
      <ReceiptDocument receipt={receipt} />
      <p className="mx-auto mt-4 max-w-[760px] text-[12px] text-ink-400 print:hidden">
        연말정산 간소화 서비스(홈택스)에는 기관이 제출한 명세가 반영됩니다. 반영 여부는 다음 해 1월 중순 이후 홈택스에서 확인하세요.
      </p>
    </main>
  );
}
