-- 기브싸인 사회복지기관 후원 도메인
--  * 기관 정보(기관유형·대표자·소재지·공익법인 지정·모집등록번호)
--  * 공개 후원페이지 설정(merchant_donation_page)
--  * 캠페인(campaign) + charge.campaign_id 로 캠페인별 모금액 집계
--  * 정기후원(recurring_donation / recurring_run) + charge.recurring_id
--  * 기부금영수증(payer_receipt_profile / donation_receipt / receipt_export) + charge.receipt_id
-- 마지막 절은 초안 단계에서 system_setting JSON 에 저장하던 후원페이지·캠페인을 새 테이블로 옮긴다.

-- CreateEnum
CREATE TYPE "organization_type" AS ENUM ('WELFARE_CORPORATION', 'WELFARE_FACILITY', 'NONPROFIT_ORG', 'PUBLIC_INTEREST_CORP', 'RELIGIOUS', 'OTHER');

-- CreateEnum
CREATE TYPE "campaign_status" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "recurring_status" AS ENUM ('ACTIVE', 'PAUSED', 'SUSPENDED', 'CANCELED');

-- CreateEnum
CREATE TYPE "recurring_run_status" AS ENUM ('SUCCESS', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "receipt_status" AS ENUM ('ISSUED', 'VOID');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "consent_type" ADD VALUE 'RECEIPT_ISSUANCE';
ALTER TYPE "consent_type" ADD VALUE 'RECURRING_DEBIT';

-- AlterTable
ALTER TABLE "charge" ADD COLUMN     "campaign_id" TEXT,
ADD COLUMN     "receipt_id" TEXT,
ADD COLUMN     "recurring_id" TEXT;

-- AlterTable
ALTER TABLE "merchant_profile" ADD COLUMN     "address" TEXT,
ADD COLUMN     "contact_email" TEXT,
ADD COLUMN     "contact_name" TEXT,
ADD COLUMN     "contact_phone" TEXT,
ADD COLUMN     "designated_donee" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "designated_donee_until" DATE,
ADD COLUMN     "donation_code" TEXT NOT NULL DEFAULT '40',
ADD COLUMN     "fundraising_reg_authority" TEXT,
ADD COLUMN     "fundraising_reg_no" TEXT,
ADD COLUMN     "org_type" "organization_type",
ADD COLUMN     "representative_name" TEXT;

-- CreateTable
CREATE TABLE "merchant_donation_page" (
    "merchant_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "intro" TEXT,
    "hero_url" TEXT,
    "logo_url" TEXT,
    "color" TEXT NOT NULL DEFAULT '#28634e',
    "thanks" TEXT,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "show_campaigns" BOOLEAN NOT NULL DEFAULT true,
    "show_progress" BOOLEAN NOT NULL DEFAULT true,
    "show_recent_donors" BOOLEAN NOT NULL DEFAULT true,
    "transparency_url" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_donation_page_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "campaign" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "story" TEXT,
    "beneficiary" TEXT,
    "usage_plan" TEXT,
    "image_url" TEXT,
    "goal_amount" BIGINT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "status" "campaign_status" NOT NULL DEFAULT 'DRAFT',
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "result_report" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_donation" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "amount" BIGINT NOT NULL,
    "day_of_month" INTEGER NOT NULL,
    "message" TEXT NOT NULL DEFAULT '정기후원',
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "status" "recurring_status" NOT NULL DEFAULT 'ACTIVE',
    "next_charge_on" DATE NOT NULL,
    "last_charged_at" TIMESTAMPTZ(3),
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "last_failure" TEXT,
    "success_count" INTEGER NOT NULL DEFAULT 0,
    "total_amount" BIGINT NOT NULL DEFAULT 0,
    "consent_id" TEXT,
    "paused_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "canceled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "recurring_donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_run" (
    "id" TEXT NOT NULL,
    "recurring_id" TEXT NOT NULL,
    "month_key" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "recurring_run_status" NOT NULL,
    "charge_id" TEXT,
    "reason" TEXT,
    "ran_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payer_receipt_profile" (
    "payer_id" TEXT NOT NULL,
    "legal_name" TEXT NOT NULL,
    "resident_no_enc" TEXT NOT NULL,
    "resident_no_hash" TEXT NOT NULL,
    "resident_no_masked" TEXT NOT NULL,
    "address" TEXT,
    "hometax_opt_in" BOOLEAN NOT NULL DEFAULT true,
    "consent_id" TEXT,
    "consent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payer_receipt_profile_pkey" PRIMARY KEY ("payer_id")
);

-- CreateTable
CREATE TABLE "donation_receipt" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "tax_year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "charge_count" INTEGER NOT NULL,
    "donation_code" TEXT NOT NULL,
    "status" "receipt_status" NOT NULL DEFAULT 'ISSUED',
    "donor_snapshot" JSONB NOT NULL,
    "issuer_snapshot" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "view_token_hash" TEXT,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "superseded_by_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donation_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_export" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "tax_year" INTEGER NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'HOMETAX_CSV',
    "file_name" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_export_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_merchant_id_status_sort_order_idx" ON "campaign"("merchant_id", "status", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_merchant_id_code_key" ON "campaign"("merchant_id", "code");

-- CreateIndex
CREATE INDEX "recurring_donation_status_next_charge_on_idx" ON "recurring_donation"("status", "next_charge_on");

-- CreateIndex
CREATE INDEX "recurring_donation_merchant_id_status_idx" ON "recurring_donation"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "recurring_donation_payer_id_status_idx" ON "recurring_donation"("payer_id", "status");

-- CreateIndex
CREATE INDEX "recurring_run_ran_at_idx" ON "recurring_run"("ran_at");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_run_recurring_id_month_key_attempt_key" ON "recurring_run"("recurring_id", "month_key", "attempt");

-- CreateIndex
CREATE INDEX "payer_receipt_profile_resident_no_hash_idx" ON "payer_receipt_profile"("resident_no_hash");

-- CreateIndex
CREATE UNIQUE INDEX "donation_receipt_receipt_no_key" ON "donation_receipt"("receipt_no");

-- CreateIndex
CREATE INDEX "donation_receipt_payer_id_tax_year_idx" ON "donation_receipt"("payer_id", "tax_year");

-- CreateIndex
CREATE INDEX "donation_receipt_merchant_id_tax_year_status_idx" ON "donation_receipt"("merchant_id", "tax_year", "status");

-- CreateIndex
CREATE UNIQUE INDEX "donation_receipt_merchant_id_tax_year_seq_key" ON "donation_receipt"("merchant_id", "tax_year", "seq");

-- CreateIndex
CREATE INDEX "receipt_export_merchant_id_tax_year_created_at_idx" ON "receipt_export"("merchant_id", "tax_year", "created_at");

-- CreateIndex
CREATE INDEX "charge_campaign_id_status_idx" ON "charge"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "charge_recurring_id_idx" ON "charge"("recurring_id");

-- CreateIndex
CREATE INDEX "charge_receipt_id_idx" ON "charge"("receipt_id");

-- AddForeignKey
ALTER TABLE "charge" ADD CONSTRAINT "charge_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge" ADD CONSTRAINT "charge_recurring_id_fkey" FOREIGN KEY ("recurring_id") REFERENCES "recurring_donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "charge" ADD CONSTRAINT "charge_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "donation_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_donation_page" ADD CONSTRAINT "merchant_donation_page_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_donation" ADD CONSTRAINT "recurring_donation_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_donation" ADD CONSTRAINT "recurring_donation_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_donation" ADD CONSTRAINT "recurring_donation_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_run" ADD CONSTRAINT "recurring_run_recurring_id_fkey" FOREIGN KEY ("recurring_id") REFERENCES "recurring_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payer_receipt_profile" ADD CONSTRAINT "payer_receipt_profile_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_receipt" ADD CONSTRAINT "donation_receipt_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_receipt" ADD CONSTRAINT "donation_receipt_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_export" ADD CONSTRAINT "receipt_export_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 데이터 이관: system_setting 의 givesign:page:{merchantId} / givesign:campaign:{merchantId}:{id}
-- ---------------------------------------------------------------------------
INSERT INTO "merchant_donation_page" ("merchant_id", "title", "subtitle", "intro", "hero_url", "logo_url", "color", "thanks", "published", "show_campaigns", "updated_at")
SELECT substring(s."key" from 15),
       COALESCE(NULLIF(s."value"->>'title', ''), '후원페이지'),
       NULLIF(s."value"->>'subtitle', ''),
       NULLIF(s."value"->>'intro', ''),
       NULLIF(s."value"->>'hero', ''),
       NULLIF(s."value"->>'logo', ''),
       COALESCE(NULLIF(s."value"->>'color', ''), '#28634e'),
       NULLIF(s."value"->>'thanks', ''),
       COALESCE((s."value"->>'published')::boolean, false),
       COALESCE((s."value"->>'showCampaigns')::boolean, true),
       now()
FROM "system_setting" s
JOIN "merchant_profile" m ON m."id" = substring(s."key" from 15)
WHERE s."key" LIKE 'givesign:page:%'
ON CONFLICT ("merchant_id") DO NOTHING;

INSERT INTO "campaign" ("id", "merchant_id", "code", "title", "summary", "story", "beneficiary", "usage_plan", "image_url", "goal_amount", "starts_on", "ends_on", "status", "created_at", "updated_at")
SELECT COALESCE(NULLIF(s."value"->>'id', ''), md5(s."key")),
       s."value"->>'merchantId',
       'C' || lpad((row_number() OVER (PARTITION BY s."value"->>'merchantId' ORDER BY s."updated_at"))::text, 3, '0'),
       COALESCE(NULLIF(s."value"->>'title', ''), '캠페인'),
       COALESCE(NULLIF(s."value"->>'summary', ''), ''),
       NULLIF(s."value"->>'story', ''),
       NULLIF(s."value"->>'beneficiary', ''),
       NULLIF(s."value"->>'usage', ''),
       NULLIF(s."value"->>'image', ''),
       COALESCE(NULLIF(s."value"->>'goal', '')::bigint, 1000000),
       COALESCE(NULLIF(s."value"->>'start', '')::date, CURRENT_DATE),
       COALESCE(NULLIF(s."value"->>'end', '')::date, CURRENT_DATE),
       CASE WHEN COALESCE((s."value"->>'published')::boolean, false) THEN 'ACTIVE'::"campaign_status" ELSE 'DRAFT'::"campaign_status" END,
       COALESCE(NULLIF(s."value"->>'createdAt', '')::timestamptz, now()),
       now()
FROM "system_setting" s
JOIN "merchant_profile" m ON m."id" = s."value"->>'merchantId'
WHERE s."key" LIKE 'givesign:campaign:%'
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "system_setting" WHERE "key" LIKE 'givesign:page:%' OR "key" LIKE 'givesign:campaign:%';
