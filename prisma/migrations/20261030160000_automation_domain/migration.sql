-- 자동화 도메인: 자원봉사·구성원 명단·알림톡 채널·월간 안내·전자 약정서·콘텐츠 생성·SNS 게시 (2026-10-30)
-- CreateEnum
CREATE TYPE "volunteer_application_status" AS ENUM ('RECEIVED', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "alimtalk_channel_status" AS ENUM ('NOT_CONNECTED', 'PENDING', 'ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "agreement_kind" AS ENUM ('RECURRING_PLEDGE', 'VOLUNTEER_APPLICATION');

-- CreateEnum
CREATE TYPE "esign_status" AS ENUM ('NONE', 'REQUESTED', 'SIGNED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "content_kind" AS ENUM ('SHORTFORM', 'IMAGE_SQUARE', 'IMAGE_STORY');

-- CreateEnum
CREATE TYPE "content_status" AS ENUM ('DRAFT', 'GENERATING', 'REVIEW', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "social_platform" AS ENUM ('YOUTUBE', 'INSTAGRAM', 'FACEBOOK');

-- AlterEnum
ALTER TYPE "consent_type" ADD VALUE 'VOLUNTEER_PRIVACY';

-- AlterTable
ALTER TABLE "charge" ADD COLUMN     "content_item_id" TEXT,
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "merchant_profile" ADD COLUMN     "monthly_notice_enabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "receipt_cycle" TEXT NOT NULL DEFAULT 'YEARLY';

-- AlterTable
ALTER TABLE "mt_outbound_message" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'SMS',
ADD COLUMN     "fallback" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payer_merchant_link" ADD COLUMN     "notice_opt_out_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "recurring_donation" ADD COLUMN     "agreement_doc_id" TEXT,
ADD COLUMN     "content_item_id" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "volunteer_profile" (
    "payer_id" TEXT NOT NULL,
    "interests" TEXT[],
    "available_days" TEXT[],
    "time_slot" TEXT,
    "experience" TEXT,
    "emergency_name" TEXT,
    "emergency_phone_enc" TEXT,
    "emergency_phone_masked" TEXT,
    "safety_pledged_at" TIMESTAMPTZ(3),
    "consent_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "volunteer_profile_pkey" PRIMARY KEY ("payer_id")
);

-- CreateTable
CREATE TABLE "volunteer_application" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "status" "volunteer_application_status" NOT NULL DEFAULT 'RECEIVED',
    "wish" TEXT,
    "message" TEXT,
    "memo" TEXT,
    "assignment" TEXT,
    "source" TEXT,
    "content_item_id" TEXT,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" TEXT,
    "withdrawn_at" TIMESTAMPTZ(3),
    "agreement_doc_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "volunteer_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "volunteer_activity" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "activity_date" DATE NOT NULL,
    "minutes" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "note" TEXT,
    "confirmed_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "volunteer_activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supporter_import" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "accepted_count" INTEGER NOT NULL,
    "duplicate_count" INTEGER NOT NULL,
    "error_count" INTEGER NOT NULL,
    "consent_confirmed_at" TIMESTAMPTZ(3) NOT NULL,
    "consent_basis" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supporter_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supporter_contact" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "import_id" TEXT,
    "name" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'OTHER',
    "tags" TEXT[],
    "note" TEXT,
    "payer_id" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "supporter_contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_alimtalk_channel" (
    "merchant_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "sender_key_enc" TEXT,
    "sender_key_masked" TEXT,
    "status" "alimtalk_channel_status" NOT NULL DEFAULT 'PENDING',
    "template_codes" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "verified_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_alimtalk_channel_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "notice_run" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "month_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "recipient_count" INTEGER NOT NULL DEFAULT 0,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "alimtalk_count" INTEGER NOT NULL DEFAULT 0,
    "fallback_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "receipts_issued" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "notice_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notice_delivery" (
    "id" TEXT NOT NULL,
    "notice_run_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "channel" TEXT,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "mt_message_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notice_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreement_document" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "kind" "agreement_kind" NOT NULL,
    "subject_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "doc_no" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "consent_at" TIMESTAMPTZ(3) NOT NULL,
    "consent_ip" TEXT,
    "user_agent" TEXT,
    "terms_version" TEXT,
    "esign_provider" TEXT,
    "esign_request_id" TEXT,
    "esign_status" "esign_status" NOT NULL DEFAULT 'NONE',
    "signed_at" TIMESTAMPTZ(3),
    "supersedes_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreement_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_content_setting" (
    "merchant_id" TEXT NOT NULL,
    "tone" TEXT NOT NULL DEFAULT 'WARM',
    "banned_words" TEXT[],
    "auto_approve" BOOLEAN NOT NULL DEFAULT false,
    "monthly_limit" INTEGER NOT NULL DEFAULT 30,
    "hashtags" TEXT[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_content_setting_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "content_item" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "kind" "content_kind" NOT NULL,
    "status" "content_status" NOT NULL DEFAULT 'DRAFT',
    "title" TEXT NOT NULL,
    "script" TEXT,
    "scenes" JSONB NOT NULL DEFAULT '[]',
    "caption" TEXT,
    "hashtags" TEXT[],
    "cover_svg" TEXT,
    "ai_labeled" BOOLEAN NOT NULL DEFAULT true,
    "reg_no_included" BOOLEAN NOT NULL DEFAULT false,
    "provider" TEXT NOT NULL,
    "cost_krw" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_job" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "cost_krw" INTEGER NOT NULL DEFAULT 0,
    "output" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "social_channel" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "platform" "social_platform" NOT NULL,
    "account_name" TEXT NOT NULL,
    "external_id" TEXT,
    "access_token_enc" TEXT,
    "refresh_token_enc" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL DEFAULT 'CONNECTED',
    "mock" BOOLEAN NOT NULL DEFAULT true,
    "connected_by" TEXT NOT NULL,
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "social_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_publish" (
    "id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "platform" "social_platform" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "mock" BOOLEAN NOT NULL DEFAULT true,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "published_at" TIMESTAMPTZ(3),
    "external_post_id" TEXT,
    "url" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "metrics_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_publish_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "volunteer_application_merchant_id_status_created_at_idx" ON "volunteer_application"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "volunteer_application_payer_id_idx" ON "volunteer_application"("payer_id");

-- CreateIndex
CREATE INDEX "volunteer_activity_merchant_id_activity_date_idx" ON "volunteer_activity"("merchant_id", "activity_date");

-- CreateIndex
CREATE INDEX "volunteer_activity_payer_id_activity_date_idx" ON "volunteer_activity"("payer_id", "activity_date");

-- CreateIndex
CREATE INDEX "supporter_import_merchant_id_created_at_idx" ON "supporter_import"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "supporter_contact_merchant_id_role_idx" ON "supporter_contact"("merchant_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "supporter_contact_merchant_id_phone_hash_key" ON "supporter_contact"("merchant_id", "phone_hash");

-- CreateIndex
CREATE INDEX "notice_run_started_at_idx" ON "notice_run"("started_at");

-- CreateIndex
CREATE UNIQUE INDEX "notice_run_merchant_id_month_key_key" ON "notice_run"("merchant_id", "month_key");

-- CreateIndex
CREATE UNIQUE INDEX "notice_delivery_notice_run_id_payer_id_key" ON "notice_delivery"("notice_run_id", "payer_id");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_document_doc_no_key" ON "agreement_document"("doc_no");

-- CreateIndex
CREATE INDEX "agreement_document_merchant_id_created_at_idx" ON "agreement_document"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "agreement_document_payer_id_created_at_idx" ON "agreement_document"("payer_id", "created_at");

-- CreateIndex
CREATE INDEX "agreement_document_esign_request_id_idx" ON "agreement_document"("esign_request_id");

-- CreateIndex
CREATE UNIQUE INDEX "agreement_document_kind_subject_id_version_key" ON "agreement_document"("kind", "subject_id", "version");

-- CreateIndex
CREATE INDEX "content_item_merchant_id_status_created_at_idx" ON "content_item"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "content_item_campaign_id_idx" ON "content_item"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "content_job_item_id_step_key" ON "content_job"("item_id", "step");

-- CreateIndex
CREATE UNIQUE INDEX "social_channel_merchant_id_platform_key" ON "social_channel"("merchant_id", "platform");

-- CreateIndex
CREATE INDEX "content_publish_status_scheduled_at_idx" ON "content_publish"("status", "scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "content_publish_item_id_platform_key" ON "content_publish"("item_id", "platform");

-- CreateIndex
CREATE INDEX "charge_content_item_id_idx" ON "charge"("content_item_id");

-- AddForeignKey
ALTER TABLE "volunteer_profile" ADD CONSTRAINT "volunteer_profile_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_application" ADD CONSTRAINT "volunteer_application_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_application" ADD CONSTRAINT "volunteer_application_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_activity" ADD CONSTRAINT "volunteer_activity_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "volunteer_activity" ADD CONSTRAINT "volunteer_activity_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_import" ADD CONSTRAINT "supporter_import_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_contact" ADD CONSTRAINT "supporter_contact_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_contact" ADD CONSTRAINT "supporter_contact_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "supporter_import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_alimtalk_channel" ADD CONSTRAINT "merchant_alimtalk_channel_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_run" ADD CONSTRAINT "notice_run_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notice_delivery" ADD CONSTRAINT "notice_delivery_notice_run_id_fkey" FOREIGN KEY ("notice_run_id") REFERENCES "notice_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_document" ADD CONSTRAINT "agreement_document_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreement_document" ADD CONSTRAINT "agreement_document_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_content_setting" ADD CONSTRAINT "merchant_content_setting_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_item" ADD CONSTRAINT "content_item_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_job" ADD CONSTRAINT "content_job_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "content_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "social_channel" ADD CONSTRAINT "social_channel_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_publish" ADD CONSTRAINT "content_publish_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "content_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- 진행 중(접수·승인) 자원봉사 신청은 후원자당 기관당 1건. 두 번 눌러도 신청이 둘로 갈라지지 않게 한다.
CREATE UNIQUE INDEX "volunteer_application_live_uniq"
  ON "volunteer_application" ("merchant_id", "payer_id")
  WHERE "status" IN ('RECEIVED', 'APPROVED');
