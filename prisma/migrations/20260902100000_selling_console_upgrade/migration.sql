-- 판매 관리(상품·주문/판매·후원 설정) 개편.
--
-- 상품 등록 폼을 일반 커머스 어드민 수준으로 올리면서 필요한 값들을 추가한다.
-- 기존 데이터는 모두 기본값으로 채워지므로 되돌릴 필요가 없다.

-- ── 열거형 확장 ────────────────────────────────────────────────
-- 비실물 4번째 유형: 디지털 컨텐츠
ALTER TYPE "digital_product_type" ADD VALUE IF NOT EXISTS 'CONTENT';

-- 반품·교환 상태. 지금까지는 배송 취소로만 처리해 반품 진행 상황을 남길 수 없었다.
ALTER TYPE "shipment_status" ADD VALUE IF NOT EXISTS 'RETURN_REQUESTED';
ALTER TYPE "shipment_status" ADD VALUE IF NOT EXISTS 'RETURNING';
ALTER TYPE "shipment_status" ADD VALUE IF NOT EXISTS 'RETURNED';
ALTER TYPE "shipment_status" ADD VALUE IF NOT EXISTS 'EXCHANGE_REQUESTED';
ALTER TYPE "shipment_status" ADD VALUE IF NOT EXISTS 'EXCHANGE_SHIPPED';

-- 비실물 지급 방식.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'fulfillment_mode') THEN
    CREATE TYPE "fulfillment_mode" AS ENUM ('MANUAL', 'API', 'INSTANT');
  END IF;
END
$$;

-- ── 상품 ───────────────────────────────────────────────────────
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "images" JSONB;
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "tax_free" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "notice_info" JSONB;
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "dispatch_days" INTEGER;
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "return_fee" BIGINT;
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "exchange_fee" BIGINT;
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "fulfillment" "fulfillment_mode" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "fulfillment_note" TEXT;
ALTER TABLE "charge_product" ADD COLUMN IF NOT EXISTS "withdrawal_notice" TEXT;

-- ── 배송 정책 ──────────────────────────────────────────────────
ALTER TABLE "merchant_shipping_policy" ADD COLUMN IF NOT EXISTS "dispatch_days" INTEGER NOT NULL DEFAULT 2;
ALTER TABLE "merchant_shipping_policy" ADD COLUMN IF NOT EXISTS "return_fee" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "merchant_shipping_policy" ADD COLUMN IF NOT EXISTS "exchange_fee" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "merchant_shipping_policy" ADD COLUMN IF NOT EXISTS "return_receiver" TEXT;
ALTER TABLE "merchant_shipping_policy" ADD COLUMN IF NOT EXISTS "return_phone" TEXT;
ALTER TABLE "merchant_shipping_policy" ADD COLUMN IF NOT EXISTS "return_zip_code" TEXT;
ALTER TABLE "merchant_shipping_policy" ADD COLUMN IF NOT EXISTS "return_address" TEXT;

-- ── 배송(주문) ─────────────────────────────────────────────────
ALTER TABLE "charge_shipment" ADD COLUMN IF NOT EXISTS "return_reason" TEXT;
ALTER TABLE "charge_shipment" ADD COLUMN IF NOT EXISTS "return_requested_at" TIMESTAMPTZ(3);
ALTER TABLE "charge_shipment" ADD COLUMN IF NOT EXISTS "return_tracking_no" TEXT;
ALTER TABLE "charge_shipment" ADD COLUMN IF NOT EXISTS "return_closed_at" TIMESTAMPTZ(3);

-- ── 사회복지기관 프로필: 직접 입력 세부 설정 ─────────────────────────
-- 지금까지 직접 입력은 플랫폼 정책 범위를 그대로 썼다.
-- 사회복지기관이 자기 상품 구성에 맞춰 범위를 좁히고 배수 단위를 둘 수 있게 한다.
ALTER TABLE "merchant_profile" ADD COLUMN IF NOT EXISTS "custom_min_amount" BIGINT;
ALTER TABLE "merchant_profile" ADD COLUMN IF NOT EXISTS "custom_max_amount" BIGINT;
ALTER TABLE "merchant_profile" ADD COLUMN IF NOT EXISTS "custom_amount_step" INTEGER;

-- ── 연동 API ───────────────────────────────────────────────────
ALTER TABLE "merchant_api_key" ADD COLUMN IF NOT EXISTS "allowed_ips" TEXT;

CREATE TABLE IF NOT EXISTS "merchant_api_call_log" (
  "id"          TEXT NOT NULL,
  "merchant_id" TEXT NOT NULL,
  "key_id"      TEXT,
  "method"      TEXT NOT NULL,
  "path"        TEXT NOT NULL,
  "status"      INTEGER NOT NULL,
  "error_code"  TEXT,
  "message"     TEXT,
  "ip"          TEXT,
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "merchant_api_call_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "merchant_api_call_log_merchant_id_created_at_idx"
  ON "merchant_api_call_log" ("merchant_id", "created_at");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'merchant_api_call_log_merchant_id_fkey'
  ) THEN
    ALTER TABLE "merchant_api_call_log"
      ADD CONSTRAINT "merchant_api_call_log_merchant_id_fkey"
      FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;

-- ── 실물 주문은 포인트 지급 대상이 아니다 ──────────────────────
-- charge.point_status 기본값이 PENDING 이라 실물 주문까지 "포인트 지급 대기" 에 섞였다.
-- 이미 쌓인 실물 주문 건을 SKIPPED 로 정리한다(이후 생성분은 애플리케이션이 처리).
UPDATE "charge" c
   SET "point_status" = 'SKIPPED'
  FROM "charge_product" p
 WHERE c."product_id" = p."id"
   AND p."kind" = 'PHYSICAL'
   AND c."point_status" = 'PENDING';
