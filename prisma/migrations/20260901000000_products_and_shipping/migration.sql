-- 상품 설정 고도화: 비실물(포인트·상품권·이용권) / 실물(배송비·조건부무료·재고·옵션)
-- 기존 charge_product 는 전부 포인트 상품이었으므로 kind=DIGITAL, digital_type=POINT 로 채운다.

CREATE TYPE "product_kind" AS ENUM ('DIGITAL', 'PHYSICAL');
CREATE TYPE "digital_product_type" AS ENUM ('POINT', 'VOUCHER', 'PASS');
CREATE TYPE "shipment_status" AS ENUM ('PREPARING', 'SHIPPED', 'DELIVERED', 'CANCELED');

-- ── 상품 ─────────────────────────────────────────────────────────────
ALTER TABLE "charge_product" ADD COLUMN "kind" "product_kind" NOT NULL DEFAULT 'DIGITAL';
ALTER TABLE "charge_product" ADD COLUMN "digital_type" "digital_product_type";
ALTER TABLE "charge_product" ADD COLUMN "give_amount" BIGINT;
ALTER TABLE "charge_product" ADD COLUMN "give_unit" TEXT;
ALTER TABLE "charge_product" ADD COLUMN "valid_days" INTEGER;
ALTER TABLE "charge_product" ADD COLUMN "description" TEXT;
ALTER TABLE "charge_product" ADD COLUMN "image_url" TEXT;
ALTER TABLE "charge_product" ADD COLUMN "sku" TEXT;
ALTER TABLE "charge_product" ADD COLUMN "stock" INTEGER;
ALTER TABLE "charge_product" ADD COLUMN "stock_alert" INTEGER;
ALTER TABLE "charge_product" ADD COLUMN "shipping_fee" BIGINT;
ALTER TABLE "charge_product" ADD COLUMN "free_ship_over" BIGINT;
ALTER TABLE "charge_product" ADD COLUMN "free_shipping" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "charge_product" ADD COLUMN "max_per_order" INTEGER;
ALTER TABLE "charge_product" ADD COLUMN "options" JSONB;

-- 기존 상품은 모두 포인트 상품이었다.
UPDATE "charge_product" SET "digital_type" = 'POINT' WHERE "digital_type" IS NULL;

CREATE INDEX "charge_product_merchant_id_kind_active_idx"
  ON "charge_product"("merchant_id", "kind", "active");

-- 실물 상품은 재고·배송비가 음수일 수 없다. 잘못된 값이 들어오면 결제 금액이 어긋난다.
ALTER TABLE "charge_product" ADD CONSTRAINT "charge_product_stock_non_negative"
  CHECK ("stock" IS NULL OR "stock" >= 0);
ALTER TABLE "charge_product" ADD CONSTRAINT "charge_product_shipping_fee_non_negative"
  CHECK ("shipping_fee" IS NULL OR "shipping_fee" >= 0);

-- ── 사회복지기관 기본 배송정책 ──────────────────────────────────────────────
CREATE TABLE "merchant_shipping_policy" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "base_fee" BIGINT NOT NULL DEFAULT 3000,
    "free_over" BIGINT,
    "remote_fee" BIGINT NOT NULL DEFAULT 0,
    "carrier" TEXT,
    "guide" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_shipping_policy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "merchant_shipping_policy_fee_non_negative"
      CHECK ("base_fee" >= 0 AND "remote_fee" >= 0 AND ("free_over" IS NULL OR "free_over" >= 0))
);
CREATE UNIQUE INDEX "merchant_shipping_policy_merchant_id_key"
  ON "merchant_shipping_policy"("merchant_id");
ALTER TABLE "merchant_shipping_policy" ADD CONSTRAINT "merchant_shipping_policy_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 결제(주문) 확장 ───────────────────────────────────────────────────
ALTER TABLE "charge" ADD COLUMN "product_id" TEXT;
ALTER TABLE "charge" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "charge" ADD COLUMN "option_text" TEXT;
ALTER TABLE "charge" ADD COLUMN "shipping_fee" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "charge" ADD CONSTRAINT "charge_quantity_positive" CHECK ("quantity" >= 1);
ALTER TABLE "charge" ADD CONSTRAINT "charge_shipping_fee_non_negative" CHECK ("shipping_fee" >= 0);

CREATE INDEX "charge_product_id_idx" ON "charge"("product_id");
-- 상품을 지워도 과거 주문 기록은 남아야 한다(집계·분쟁 대응). 그래서 SET NULL 이 아니라 RESTRICT 다.
ALTER TABLE "charge" ADD CONSTRAINT "charge_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "charge_product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 배송 정보 ────────────────────────────────────────────────────────
CREATE TABLE "charge_shipment" (
    "id" TEXT NOT NULL,
    "charge_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "receiver_enc" TEXT NOT NULL,
    "receiver_masked" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "zip_code" TEXT NOT NULL,
    "address_enc" TEXT NOT NULL,
    "address_masked" TEXT NOT NULL,
    "memo" TEXT,
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "status" "shipment_status" NOT NULL DEFAULT 'PREPARING',
    "carrier" TEXT,
    "tracking_no" TEXT,
    "shipped_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "charge_shipment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "charge_shipment_charge_id_key" ON "charge_shipment"("charge_id");
CREATE INDEX "charge_shipment_merchant_id_status_idx" ON "charge_shipment"("merchant_id", "status");
ALTER TABLE "charge_shipment" ADD CONSTRAINT "charge_shipment_charge_id_fkey"
  FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "charge_shipment" ADD CONSTRAINT "charge_shipment_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── MO 안내 문자 (감사 문자와 별개) ───────────────────────────────────
ALTER TABLE "merchant_profile" ADD COLUMN "mo_guide_mt_message" TEXT;
