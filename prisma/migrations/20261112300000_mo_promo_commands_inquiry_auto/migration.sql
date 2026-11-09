-- 2026-11-12 4차 K: 홍보물 코드(campaign_promo)·캠페인 별칭·결제 건/단계 기록 홍보물 id, 문자 명령·의도 해석 회신 링크(mo_reply_link), 문의 자동 응대(inquiry_auto_setting + support_inquiry 응대 열)
-- AlterTable
ALTER TABLE "campaign" ADD COLUMN     "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "charge" ADD COLUMN     "promo_id" TEXT;

-- AlterTable
ALTER TABLE "funnel_step" ADD COLUMN     "promo_id" TEXT;

-- AlterTable
ALTER TABLE "support_inquiry" ADD COLUMN     "auto_answered_at" TIMESTAMPTZ(3),
ADD COLUMN     "auto_category" TEXT,
ADD COLUMN     "auto_category_by" TEXT,
ADD COLUMN     "due_at" TIMESTAMPTZ(3),
ADD COLUMN     "handled_by" TEXT,
ADD COLUMN     "history_summary" JSONB,
ADD COLUMN     "needs_staff_at" TIMESTAMPTZ(3),
ADD COLUMN     "payer_id" TEXT,
ADD COLUMN     "triage_locked_at" TIMESTAMPTZ(3),
ADD COLUMN     "triaged_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "support_message" ADD COLUMN     "author_kind" TEXT;

-- CreateTable
CREATE TABLE "campaign_promo" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyword" TEXT,
    "expires_on" DATE,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaign_promo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mo_reply_link" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "merchant_id" TEXT,
    "phone_hash" TEXT NOT NULL,
    "mo_message_id" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "opened_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mo_reply_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiry_auto_setting" (
    "merchant_id" TEXT NOT NULL,
    "auto_categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "templates" JSONB NOT NULL DEFAULT '{}',
    "due_business_days" INTEGER NOT NULL DEFAULT 2,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inquiry_auto_setting_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateIndex
CREATE INDEX "campaign_promo_campaign_id_archived_at_idx" ON "campaign_promo"("campaign_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_promo_merchant_id_keyword_key" ON "campaign_promo"("merchant_id", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "mo_reply_link_token_hash_key" ON "mo_reply_link"("token_hash");

-- CreateIndex
CREATE INDEX "mo_reply_link_phone_hash_created_at_idx" ON "mo_reply_link"("phone_hash", "created_at");

-- CreateIndex
CREATE INDEX "mo_reply_link_expires_at_idx" ON "mo_reply_link"("expires_at");

-- CreateIndex
CREATE INDEX "charge_promo_id_idx" ON "charge"("promo_id");

-- CreateIndex
CREATE INDEX "funnel_step_promo_id_idx" ON "funnel_step"("promo_id");

-- CreateIndex
CREATE INDEX "support_inquiry_handled_by_merchant_id_status_idx" ON "support_inquiry"("handled_by", "merchant_id", "status");

