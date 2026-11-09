-- 2026-11-12 4차 과제 I: 캠페인 전 과정 연결(종료 후 처리 방침·결과 보고 예정일·진행 속도 제안 1회·캠페인 감사 문구·콘텐츠 일정·마법사 제출 키)
-- + 기관 도입 자동(서류 자동 읽기 기록·도입 시험 기록·자가 진단 알림 1회). 새 표는 기관 FK 없이(다른 표 정리와 무관) 기관 id 로만 찾는다.

-- AlterTable
ALTER TABLE "campaign" ADD COLUMN     "after_end_policy" TEXT NOT NULL DEFAULT 'GENERAL',
ADD COLUMN     "content_plan" JSONB,
ADD COLUMN     "pace_alert_at" TIMESTAMPTZ(3),
ADD COLUMN     "result_report_due_on" DATE,
ADD COLUMN     "setup_key" TEXT,
ADD COLUMN     "thanks_message" TEXT;

-- CreateTable
CREATE TABLE "org_doc_scan" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "object_name" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "candidates" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_doc_scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_test_run" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "simulated" BOOLEAN NOT NULL DEFAULT true,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "mo_ok" BOOLEAN NOT NULL DEFAULT false,
    "payment_ok" BOOLEAN NOT NULL DEFAULT false,
    "document_ok" BOOLEAN NOT NULL DEFAULT false,
    "transaction_no" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_test_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "self_check_alert" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "self_check_alert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "org_doc_scan_merchant_id_created_at_idx" ON "org_doc_scan"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "onboarding_test_run_merchant_id_created_at_idx" ON "onboarding_test_run"("merchant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "self_check_alert_dedupe_key_key" ON "self_check_alert"("dedupe_key");

-- CreateIndex
CREATE INDEX "self_check_alert_merchant_id_kind_created_at_idx" ON "self_check_alert"("merchant_id", "kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_setup_key_key" ON "campaign"("setup_key");

