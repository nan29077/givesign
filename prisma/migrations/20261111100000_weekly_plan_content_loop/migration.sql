-- 2026-11-11 과제 G: 기관 목표·주간 운영 계획·월요일 보고 설정, 콘텐츠 2안 비교(A/B)·소재(초상권 동의서 연결)
-- 수치만 저장한다(후원자 이름·연락처 없음). 소재 파일은 비공개 저장소에만 둔다.


-- AlterTable
ALTER TABLE "content_item" ADD COLUMN     "asset_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "variant_group_id" TEXT,
ADD COLUMN     "variant_label" TEXT;

-- AlterTable
ALTER TABLE "merchant_content_setting" ADD COLUMN     "ab_test_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "merchant_goal" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "target" BIGINT NOT NULL DEFAULT 0,
    "campaign_id" TEXT,
    "starts_on" DATE NOT NULL,
    "due_on" DATE,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_plan" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "week_start" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "generated_by" TEXT NOT NULL DEFAULT 'RULES',
    "evaluation" JSONB NOT NULL,
    "suggestions" JSONB NOT NULL,
    "report_claimed_at" TIMESTAMPTZ(3),
    "report_sent_at" TIMESTAMPTZ(3),
    "report_channel" TEXT,
    "report_mt_id" TEXT,
    "report_note" TEXT,
    "acked_at" TIMESTAMPTZ(3),
    "acked_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "weekly_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "weekly_report_setting" (
    "merchant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "weekly_report_setting_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "content_asset" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "object_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "people" TEXT NOT NULL DEFAULT 'NONE',
    "has_face" BOOLEAN NOT NULL DEFAULT false,
    "blur_required" BOOLEAN NOT NULL DEFAULT false,
    "consent_envelope_id" TEXT,
    "note" TEXT,
    "uploaded_by" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_asset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_goal_merchant_id_archived_at_idx" ON "merchant_goal"("merchant_id", "archived_at");

-- CreateIndex
CREATE INDEX "weekly_plan_week_start_status_idx" ON "weekly_plan"("week_start", "status");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_plan_merchant_id_week_start_key" ON "weekly_plan"("merchant_id", "week_start");

-- CreateIndex
CREATE INDEX "content_asset_merchant_id_archived_at_created_at_idx" ON "content_asset"("merchant_id", "archived_at", "created_at");

-- CreateIndex
CREATE INDEX "content_item_variant_group_id_idx" ON "content_item"("variant_group_id");

-- AddForeignKey
ALTER TABLE "merchant_goal" ADD CONSTRAINT "merchant_goal_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_plan" ADD CONSTRAINT "weekly_plan_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_report_setting" ADD CONSTRAINT "weekly_report_setting_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "content_asset" ADD CONSTRAINT "content_asset_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

