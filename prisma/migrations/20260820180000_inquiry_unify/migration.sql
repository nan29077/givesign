-- 문의 채널 일원화: /support 접수 폼도 SupportInquiry 스레드로 저장해 답변할 수 있게 한다.
ALTER TABLE "support_inquiry" ADD COLUMN "transaction_no" TEXT;
ALTER TABLE "support_inquiry" ADD COLUMN "donation_id" TEXT;
ALTER TABLE "support_inquiry" ADD COLUMN "creator_id" TEXT;
ALTER TABLE "support_inquiry" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'WIDGET';
CREATE INDEX "support_inquiry_category_idx" ON "support_inquiry"("category");
