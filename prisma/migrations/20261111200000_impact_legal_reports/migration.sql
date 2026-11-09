-- 2026-11-09 3차 과제 H: 후원금 사용 결과(사업 진행 기록) 보고 + 법정 서류(수입·사용 명세, 연 1회 통보)
-- 기관·캠페인 FK 는 두지 않는다(다른 2026-11-09 표와 같은 방식 — 원천은 각 표, 기관 삭제는 소프트 삭제).

-- CreateTable
CREATE TABLE "impact_update" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "photos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "photo_rule_ack_at" TIMESTAMPTZ(3),
    "period_from" DATE,
    "period_to" DATE,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "report" TEXT,
    "report_source" TEXT,
    "report_facts" JSONB,
    "public_visible" BOOLEAN NOT NULL DEFAULT false,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "impact_update_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fund_expense" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "campaign_id" TEXT,
    "impact_update_id" TEXT,
    "used_on" DATE NOT NULL,
    "description" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "created_by" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "fund_expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_notice_delivery" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "tax_year" INTEGER NOT NULL,
    "payer_id" TEXT NOT NULL,
    "approval_id" TEXT,
    "issued_document_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "reason" TEXT,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_notice_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_report_setting" (
    "merchant_id" TEXT NOT NULL,
    "season_start_month" INTEGER NOT NULL DEFAULT 2,
    "season_end_month" INTEGER NOT NULL DEFAULT 3,
    "prepared_year" INTEGER,
    "prepared_at" TIMESTAMPTZ(3),
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "legal_report_setting_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateIndex
CREATE INDEX "impact_update_merchant_id_status_created_at_idx" ON "impact_update"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "impact_update_campaign_id_status_idx" ON "impact_update"("campaign_id", "status");

-- CreateIndex
CREATE INDEX "fund_expense_merchant_id_used_on_idx" ON "fund_expense"("merchant_id", "used_on");

-- CreateIndex
CREATE INDEX "fund_expense_merchant_id_campaign_id_idx" ON "fund_expense"("merchant_id", "campaign_id");

-- CreateIndex
CREATE INDEX "fund_expense_impact_update_id_idx" ON "fund_expense"("impact_update_id");

-- CreateIndex
CREATE INDEX "legal_notice_delivery_merchant_id_tax_year_status_idx" ON "legal_notice_delivery"("merchant_id", "tax_year", "status");

-- CreateIndex
CREATE UNIQUE INDEX "legal_notice_delivery_merchant_id_tax_year_payer_id_key" ON "legal_notice_delivery"("merchant_id", "tax_year", "payer_id");

-- AddForeignKey
ALTER TABLE "fund_expense" ADD CONSTRAINT "fund_expense_impact_update_id_fkey" FOREIGN KEY ("impact_update_id") REFERENCES "impact_update"("id") ON DELETE SET NULL ON UPDATE CASCADE;

