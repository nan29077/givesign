-- AlterEnum
ALTER TYPE "user_role" ADD VALUE 'GIVER';

-- CreateTable
CREATE TABLE "in_kind_donor" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "donor_type" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "business_no" TEXT,
    "representative_name" TEXT,
    "contact_name" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "address" TEXT,
    "legal_name" TEXT,
    "resident_no_enc" TEXT,
    "resident_no_hash" TEXT,
    "resident_no_masked" TEXT,
    "hometax_opt_in" BOOLEAN NOT NULL DEFAULT true,
    "admin_note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "in_kind_donor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_donation" (
    "id" TEXT NOT NULL,
    "donation_no" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "merchant_id" TEXT,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "match_mode" TEXT NOT NULL,
    "preferred_merchant_id" TEXT,
    "brand_public" BOOLEAN NOT NULL DEFAULT false,
    "min_sale_price" BIGINT,
    "unsold_action" TEXT NOT NULL,
    "delivery_method" TEXT NOT NULL,
    "donor_message" TEXT,
    "declared_total" BIGINT NOT NULL,
    "confirmed_total" BIGINT,
    "valuation_confirmed_at" TIMESTAMPTZ(3),
    "pledge_name" TEXT,
    "pledge_snapshot" JSONB,
    "pledge_hash" TEXT,
    "pledged_at" TIMESTAMPTZ(3),
    "shipping_carrier" TEXT,
    "shipping_tracking_no" TEXT,
    "shipped_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "closed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "in_kind_donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_item" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "condition" TEXT NOT NULL,
    "expiry_date" DATE,
    "declared_unit_value" BIGINT NOT NULL,
    "unit_value" BIGINT,
    "received_qty" INTEGER,
    "accepted_qty" INTEGER,
    "inspect_note" TEXT,

    CONSTRAINT "in_kind_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_valuation" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "kind" TEXT NOT NULL,
    "total" BIGINT NOT NULL,
    "item_values" JSONB NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "in_kind_valuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_match" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "proposed_by" TEXT NOT NULL,
    "proposed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline" TIMESTAMPTZ(3) NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" TEXT,
    "reason" TEXT,

    CONSTRAINT "in_kind_match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_status_log" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_user_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "in_kind_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_file" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "object_name" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "in_kind_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_inbound" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "warehouse" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "inspected_by" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "note" TEXT,
    "return_cost" BIGINT NOT NULL DEFAULT 0,
    "return_cost_bearer" TEXT NOT NULL DEFAULT 'NONE',
    "disposition" TEXT,
    "merchant_confirmed_at" TIMESTAMPTZ(3),
    "merchant_confirmed_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "in_kind_inbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "in_kind_receipt" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "tax_year" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "receipt_no" TEXT NOT NULL,
    "total_amount" BIGINT NOT NULL,
    "donation_code" TEXT NOT NULL,
    "donor_type" TEXT NOT NULL,
    "donor_snapshot" JSONB NOT NULL,
    "issuer_snapshot" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "resident_no_enc" TEXT,
    "donated_at" TIMESTAMPTZ(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "issued_by" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMPTZ(3),
    "void_reason" TEXT,
    "voided_by" TEXT,

    CONSTRAINT "in_kind_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_bazaar" (
    "merchant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "needed_items" TEXT,
    "consignment_name" TEXT NOT NULL,
    "consignment_agreed_at" TIMESTAMPTZ(3) NOT NULL,
    "consignment_version" TEXT NOT NULL,
    "mail_order_reg_no" TEXT,
    "applied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" TEXT,
    "note" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_bazaar_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "bazaar_seller" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sellerbricks_id" TEXT NOT NULL,
    "phone_enc" TEXT,
    "phone_masked" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bazaar_seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bazaar_product" (
    "id" TEXT NOT NULL,
    "tracking_code" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sale_price" BIGINT NOT NULL,
    "shipping_fee" BIGINT NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL,
    "per_person_limit" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "external_ref" TEXT,
    "listed_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "remaining_action" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bazaar_product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bazaar_live" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "seller_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "scheduled_at" TIMESTAMPTZ(3) NOT NULL,
    "broadcast_url" TEXT,
    "product_ids" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bazaar_live_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bazaar_sale_batch" (
    "id" TEXT NOT NULL,
    "live_id" TEXT,
    "title" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT NOT NULL,
    "approved_by" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "month" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bazaar_sale_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bazaar_sale_line" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "sold_qty" INTEGER NOT NULL,
    "gross_amount" BIGINT NOT NULL,
    "refund_qty" INTEGER NOT NULL DEFAULT 0,
    "refund_amount" BIGINT NOT NULL DEFAULT 0,
    "return_cost" BIGINT NOT NULL DEFAULT 0,
    "return_bearer" TEXT NOT NULL DEFAULT 'NONE',
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bazaar_sale_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bazaar_ledger" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "entry_type" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "supply_amount" BIGINT,
    "vat_amount" BIGINT,
    "product_id" TEXT,
    "batch_id" TEXT,
    "settlement_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bazaar_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bazaar_settlement" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "gross" BIGINT NOT NULL,
    "refund" BIGINT NOT NULL,
    "fee" BIGINT NOT NULL,
    "fee_vat" BIGINT NOT NULL,
    "return_cost" BIGINT NOT NULL,
    "payout" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "due_date" DATE NOT NULL,
    "confirmed_at" TIMESTAMPTZ(3),
    "confirmed_by" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "paid_by" TEXT,
    "transfer_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bazaar_settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bazaar_reconcile" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "external_amount" BIGINT NOT NULL,
    "internal_amount" BIGINT NOT NULL,
    "diff" BIGINT NOT NULL,
    "note" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bazaar_reconcile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_donor_user_id_key" ON "in_kind_donor"("user_id");

-- CreateIndex
CREATE INDEX "in_kind_donor_donor_type_created_at_idx" ON "in_kind_donor"("donor_type", "created_at");

-- CreateIndex
CREATE INDEX "in_kind_donor_phone_hash_idx" ON "in_kind_donor"("phone_hash");

-- CreateIndex
CREATE INDEX "in_kind_donor_business_no_idx" ON "in_kind_donor"("business_no");

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_donation_donation_no_key" ON "in_kind_donation"("donation_no");

-- CreateIndex
CREATE INDEX "in_kind_donation_donor_id_created_at_idx" ON "in_kind_donation"("donor_id", "created_at");

-- CreateIndex
CREATE INDEX "in_kind_donation_merchant_id_status_created_at_idx" ON "in_kind_donation"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "in_kind_donation_status_created_at_idx" ON "in_kind_donation"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_item_donation_id_seq_key" ON "in_kind_item"("donation_id", "seq");

-- CreateIndex
CREATE INDEX "in_kind_valuation_donation_id_created_at_idx" ON "in_kind_valuation"("donation_id", "created_at");

-- CreateIndex
CREATE INDEX "in_kind_match_merchant_id_status_proposed_at_idx" ON "in_kind_match"("merchant_id", "status", "proposed_at");

-- CreateIndex
CREATE INDEX "in_kind_match_donation_id_proposed_at_idx" ON "in_kind_match"("donation_id", "proposed_at");

-- CreateIndex
CREATE INDEX "in_kind_status_log_donation_id_created_at_idx" ON "in_kind_status_log"("donation_id", "created_at");

-- CreateIndex
CREATE INDEX "in_kind_file_donation_id_kind_idx" ON "in_kind_file"("donation_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_inbound_donation_id_key" ON "in_kind_inbound"("donation_id");

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_receipt_receipt_no_key" ON "in_kind_receipt"("receipt_no");

-- CreateIndex
CREATE INDEX "in_kind_receipt_merchant_id_tax_year_status_idx" ON "in_kind_receipt"("merchant_id", "tax_year", "status");

-- CreateIndex
CREATE INDEX "in_kind_receipt_donor_id_issued_at_idx" ON "in_kind_receipt"("donor_id", "issued_at");

-- CreateIndex
CREATE INDEX "in_kind_receipt_donation_id_idx" ON "in_kind_receipt"("donation_id");

-- CreateIndex
CREATE UNIQUE INDEX "in_kind_receipt_merchant_id_tax_year_seq_key" ON "in_kind_receipt"("merchant_id", "tax_year", "seq");

-- CreateIndex
CREATE INDEX "merchant_bazaar_status_applied_at_idx" ON "merchant_bazaar"("status", "applied_at");

-- CreateIndex
CREATE UNIQUE INDEX "bazaar_product_tracking_code_key" ON "bazaar_product"("tracking_code");

-- CreateIndex
CREATE UNIQUE INDEX "bazaar_product_item_id_key" ON "bazaar_product"("item_id");

-- CreateIndex
CREATE INDEX "bazaar_product_merchant_id_status_idx" ON "bazaar_product"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "bazaar_product_donation_id_idx" ON "bazaar_product"("donation_id");

-- CreateIndex
CREATE INDEX "bazaar_live_merchant_id_scheduled_at_idx" ON "bazaar_live"("merchant_id", "scheduled_at");

-- CreateIndex
CREATE INDEX "bazaar_live_status_scheduled_at_idx" ON "bazaar_live"("status", "scheduled_at");

-- CreateIndex
CREATE INDEX "bazaar_sale_batch_status_created_at_idx" ON "bazaar_sale_batch"("status", "created_at");

-- CreateIndex
CREATE INDEX "bazaar_sale_line_batch_id_idx" ON "bazaar_sale_line"("batch_id");

-- CreateIndex
CREATE INDEX "bazaar_sale_line_product_id_idx" ON "bazaar_sale_line"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "bazaar_ledger_idempotency_key_key" ON "bazaar_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "bazaar_ledger_merchant_id_month_idx" ON "bazaar_ledger"("merchant_id", "month");

-- CreateIndex
CREATE INDEX "bazaar_ledger_batch_id_idx" ON "bazaar_ledger"("batch_id");

-- CreateIndex
CREATE INDEX "bazaar_settlement_status_due_date_idx" ON "bazaar_settlement"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "bazaar_settlement_merchant_id_month_key" ON "bazaar_settlement"("merchant_id", "month");

-- CreateIndex
CREATE INDEX "bazaar_reconcile_month_created_at_idx" ON "bazaar_reconcile"("month", "created_at");

-- AddForeignKey
ALTER TABLE "in_kind_donor" ADD CONSTRAINT "in_kind_donor_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_donation" ADD CONSTRAINT "in_kind_donation_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "in_kind_donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_donation" ADD CONSTRAINT "in_kind_donation_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_item" ADD CONSTRAINT "in_kind_item_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_valuation" ADD CONSTRAINT "in_kind_valuation_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_match" ADD CONSTRAINT "in_kind_match_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_status_log" ADD CONSTRAINT "in_kind_status_log_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_file" ADD CONSTRAINT "in_kind_file_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_inbound" ADD CONSTRAINT "in_kind_inbound_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_receipt" ADD CONSTRAINT "in_kind_receipt_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_receipt" ADD CONSTRAINT "in_kind_receipt_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "in_kind_receipt" ADD CONSTRAINT "in_kind_receipt_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "in_kind_donor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_bazaar" ADD CONSTRAINT "merchant_bazaar_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_product" ADD CONSTRAINT "bazaar_product_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_product" ADD CONSTRAINT "bazaar_product_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "in_kind_donation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_product" ADD CONSTRAINT "bazaar_product_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "in_kind_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_live" ADD CONSTRAINT "bazaar_live_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "bazaar_seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_sale_batch" ADD CONSTRAINT "bazaar_sale_batch_live_id_fkey" FOREIGN KEY ("live_id") REFERENCES "bazaar_live"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_sale_line" ADD CONSTRAINT "bazaar_sale_line_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "bazaar_sale_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_sale_line" ADD CONSTRAINT "bazaar_sale_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "bazaar_product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bazaar_settlement" ADD CONSTRAINT "bazaar_settlement_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 라이브 바자회 원장·상태 이력 append-only. 정정은 반대 기록을 새로 남긴다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION givesign_block_bazaar_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '바자회 정산 원장(bazaar_ledger)은 수정/삭제할 수 없습니다. 정정은 반대 기록으로 남기십시오.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bazaar_ledger_append_only
  BEFORE UPDATE OR DELETE ON "bazaar_ledger"
  FOR EACH ROW EXECUTE FUNCTION givesign_block_bazaar_ledger_mutation();

CREATE OR REPLACE FUNCTION givesign_block_in_kind_log_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '현물 기부 상태 이력(in_kind_status_log)은 수정/삭제할 수 없습니다.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER in_kind_status_log_append_only
  BEFORE UPDATE OR DELETE ON "in_kind_status_log"
  FOR EACH ROW EXECUTE FUNCTION givesign_block_in_kind_log_mutation();

-- 수량·금액 하한(최후 방어선)
ALTER TABLE "in_kind_item" ADD CONSTRAINT "in_kind_item_qty_nonneg" CHECK ("quantity" > 0 AND "declared_unit_value" >= 0);
ALTER TABLE "bazaar_product" ADD CONSTRAINT "bazaar_product_price_nonneg" CHECK ("sale_price" > 0 AND "shipping_fee" >= 0 AND "quantity" >= 0 AND "per_person_limit" > 0);
ALTER TABLE "bazaar_sale_line" ADD CONSTRAINT "bazaar_sale_line_nonneg" CHECK ("sold_qty" >= 0 AND "gross_amount" >= 0 AND "refund_qty" >= 0 AND "refund_amount" >= 0 AND "return_cost" >= 0);
