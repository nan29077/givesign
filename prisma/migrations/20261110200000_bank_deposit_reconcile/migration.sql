-- 2026-11-09 과제 E: 입금 자동 대사(기관 통장 거래내역 파일) — 거래내역 업로드·입금·계좌이체 후원 기록·계좌이체 약정
-- 기브싸인 결제(charge)·정산 원장과 분리된 표다. 계좌번호 원문은 저장하지 않는다.


-- CreateEnum
CREATE TYPE "BankDepositStatus" AS ENUM ('UNMATCHED', 'SUGGESTED', 'MATCHED', 'IGNORED');

-- CreateEnum
CREATE TYPE "OfflineDonationSource" AS ENUM ('BANK_FILE', 'MANUAL');

-- CreateEnum
CREATE TYPE "OfflineDonationStatus" AS ENUM ('CONFIRMED', 'REVERTED');

-- AlterTable
ALTER TABLE "merchant_profile" ADD COLUMN     "receipt_include_offline" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "bank_statement_import" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_hash" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "encoding" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "new_count" INTEGER NOT NULL DEFAULT 0,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "skipped_count" INTEGER NOT NULL DEFAULT 0,
    "error_count" INTEGER NOT NULL DEFAULT 0,
    "auto_matched_count" INTEGER NOT NULL DEFAULT 0,
    "suggested_count" INTEGER NOT NULL DEFAULT 0,
    "unmatched_count" INTEGER NOT NULL DEFAULT 0,
    "period_from" TIMESTAMPTZ(3),
    "period_to" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_statement_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_deposit" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "import_id" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "depositor_name" TEXT NOT NULL,
    "depositor_key" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "memo" TEXT,
    "balance" BIGINT,
    "tx_hash" TEXT NOT NULL,
    "status" "BankDepositStatus" NOT NULL DEFAULT 'UNMATCHED',
    "auto_matched" BOOLEAN NOT NULL DEFAULT false,
    "payer_id" TEXT,
    "pledge_id" TEXT,
    "candidates" JSONB NOT NULL DEFAULT '[]',
    "duplicate_warning" BOOLEAN NOT NULL DEFAULT false,
    "confirmed_by" TEXT,
    "confirmed_at" TIMESTAMPTZ(3),
    "ignored_by" TEXT,
    "ignored_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offline_donation" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "deposit_id" TEXT,
    "source" "OfflineDonationSource" NOT NULL DEFAULT 'BANK_FILE',
    "amount" BIGINT NOT NULL,
    "donated_at" TIMESTAMPTZ(3) NOT NULL,
    "campaign_id" TEXT,
    "pledge_id" TEXT,
    "status" "OfflineDonationStatus" NOT NULL DEFAULT 'CONFIRMED',
    "auto_matched" BOOLEAN NOT NULL DEFAULT false,
    "receipt_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reverted_at" TIMESTAMPTZ(3),
    "reverted_by" TEXT,
    "revert_reason" TEXT,

    CONSTRAINT "offline_donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offline_pledge" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "day_of_month" INTEGER NOT NULL,
    "campaign_id" TEXT,
    "memo" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "offline_pledge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bank_statement_import_merchant_id_created_at_idx" ON "bank_statement_import"("merchant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "bank_statement_import_merchant_id_file_hash_key" ON "bank_statement_import"("merchant_id", "file_hash");

-- CreateIndex
CREATE INDEX "bank_deposit_merchant_id_status_occurred_at_idx" ON "bank_deposit"("merchant_id", "status", "occurred_at");

-- CreateIndex
CREATE INDEX "bank_deposit_merchant_id_payer_id_idx" ON "bank_deposit"("merchant_id", "payer_id");

-- CreateIndex
CREATE INDEX "bank_deposit_import_id_idx" ON "bank_deposit"("import_id");

-- CreateIndex
CREATE UNIQUE INDEX "bank_deposit_merchant_id_tx_hash_key" ON "bank_deposit"("merchant_id", "tx_hash");

-- CreateIndex
CREATE INDEX "offline_donation_merchant_id_donated_at_idx" ON "offline_donation"("merchant_id", "donated_at");

-- CreateIndex
CREATE INDEX "offline_donation_merchant_id_payer_id_status_idx" ON "offline_donation"("merchant_id", "payer_id", "status");

-- CreateIndex
CREATE INDEX "offline_donation_deposit_id_idx" ON "offline_donation"("deposit_id");

-- CreateIndex
CREATE INDEX "offline_donation_receipt_id_idx" ON "offline_donation"("receipt_id");

-- CreateIndex
CREATE INDEX "offline_pledge_merchant_id_archived_at_idx" ON "offline_pledge"("merchant_id", "archived_at");

-- AddForeignKey
ALTER TABLE "bank_statement_import" ADD CONSTRAINT "bank_statement_import_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_deposit" ADD CONSTRAINT "bank_deposit_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_deposit" ADD CONSTRAINT "bank_deposit_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "bank_statement_import"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_deposit" ADD CONSTRAINT "bank_deposit_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_deposit" ADD CONSTRAINT "bank_deposit_pledge_id_fkey" FOREIGN KEY ("pledge_id") REFERENCES "offline_pledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_donation" ADD CONSTRAINT "offline_donation_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_donation" ADD CONSTRAINT "offline_donation_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_donation" ADD CONSTRAINT "offline_donation_deposit_id_fkey" FOREIGN KEY ("deposit_id") REFERENCES "bank_deposit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_donation" ADD CONSTRAINT "offline_donation_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "donation_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_donation" ADD CONSTRAINT "offline_donation_pledge_id_fkey" FOREIGN KEY ("pledge_id") REFERENCES "offline_pledge"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_pledge" ADD CONSTRAINT "offline_pledge_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offline_pledge" ADD CONSTRAINT "offline_pledge_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "payer_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 입금 1건에 확정(CONFIRMED) 계좌이체 후원 기록은 1건만(되돌린 REVERTED 기록은 여러 건 남을 수 있다)
CREATE UNIQUE INDEX "offline_donation_deposit_confirmed_one" ON "offline_donation"("deposit_id") WHERE "status" = 'CONFIRMED' AND "deposit_id" IS NOT NULL;

-- 기관·후원자당 보관 전 계좌이체 약정 1건
CREATE UNIQUE INDEX "offline_pledge_live_one" ON "offline_pledge"("merchant_id", "payer_id") WHERE "archived_at" IS NULL;
