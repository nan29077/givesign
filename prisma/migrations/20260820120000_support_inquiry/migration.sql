-- 1:1 문의 (고객지원 채팅)
CREATE TYPE "InquiryStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');
CREATE TYPE "InquirySender" AS ENUM ('USER', 'ADMIN');

CREATE TABLE "support_inquiry" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "guest_token" TEXT,
    "guest_name" TEXT,
    "contact_enc" TEXT,
    "contact_masked" TEXT,
    "category" TEXT NOT NULL DEFAULT '일반',
    "status" "InquiryStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "last_message_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "support_inquiry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "support_inquiry_guest_token_key" ON "support_inquiry"("guest_token");
CREATE INDEX "support_inquiry_status_last_message_at_idx" ON "support_inquiry"("status", "last_message_at");
CREATE INDEX "support_inquiry_user_id_idx" ON "support_inquiry"("user_id");

CREATE TABLE "support_message" (
    "id" TEXT NOT NULL,
    "inquiry_id" TEXT NOT NULL,
    "sender" "InquirySender" NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_by_user_at" TIMESTAMPTZ(3),
    "read_by_admin_at" TIMESTAMPTZ(3),
    CONSTRAINT "support_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_message_inquiry_id_created_at_idx" ON "support_message"("inquiry_id", "created_at");

ALTER TABLE "support_message" ADD CONSTRAINT "support_message_inquiry_id_fkey" FOREIGN KEY ("inquiry_id") REFERENCES "support_inquiry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
