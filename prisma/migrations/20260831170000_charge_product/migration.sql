-- 후원 항목 도입 (문자PG 전환)
--
-- 문자 1건당 고정 금액(donation_amount) 대신, 사회복지기관이 등록한 후원 항목 중에서
-- 후원자가 금액을 고른다. 결제 금액과 지급 포인트는 1:1 이므로 금액 컬럼 하나만 둔다.

CREATE TABLE "charge_product" (
  "id"          TEXT NOT NULL,
  "creator_id"  TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "amount"      BIGINT NOT NULL,
  "sort_order"  INTEGER NOT NULL DEFAULT 0,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "archived_at" TIMESTAMPTZ(3),
  "created_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "charge_product_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "charge_product_creator_id_active_sort_order_idx"
  ON "charge_product" ("creator_id", "active", "sort_order");

ALTER TABLE "charge_product"
  ADD CONSTRAINT "charge_product_creator_id_fkey"
  FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 직접 입력 허용 여부 (기본 허용)
ALTER TABLE "creator_profile"
  ADD COLUMN "allow_custom_amount" BOOLEAN NOT NULL DEFAULT true;

-- 기존 고정 금액을 첫 상품으로 옮겨 사회복지기관이 빈 화면을 보지 않게 한다.
INSERT INTO "charge_product" ("id", "creator_id", "name", "amount", "sort_order", "active", "created_at", "updated_at")
SELECT
  gen_random_uuid()::text,
  "id",
  to_char("donation_amount", 'FM999,999,999') || '원 충전',
  "donation_amount",
  0,
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "creator_profile"
WHERE "donation_amount" > 0;

ALTER TABLE "creator_profile" DROP COLUMN "donation_amount";
