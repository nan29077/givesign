-- 라이브 바자회 정밀 점검(2026-11-06) 조치.

-- B-M4: 기부자에게 돌려준 수량(현물 영수증 정정 근거)
ALTER TABLE "bazaar_product" ADD COLUMN     "returned_qty" INTEGER NOT NULL DEFAULT 0;

-- B-M3: 판매 줄마다 적용한 수수료 요율·부가세 방식(환불 환입은 원래 판매 요율로)
ALTER TABLE "bazaar_sale_line" ADD COLUMN     "fee_rate_percent" TEXT,
ADD COLUMN     "fee_vat_mode" TEXT,
ADD COLUMN     "refund_fee_rate_percent" TEXT,
ADD COLUMN     "refund_fee_vat_mode" TEXT;

-- B-1: 0원 이하 정산 이월(CARRIED)
ALTER TABLE "bazaar_settlement" ADD COLUMN     "carried_to_month" TEXT,
ADD COLUMN     "carry_amount" BIGINT NOT NULL DEFAULT 0;

-- B-M1: 기부 건당 발급 상태 현물 영수증은 1장(동시 재발급 방지 최후 방어선)
CREATE UNIQUE INDEX "in_kind_receipt_donation_issued_one" ON "in_kind_receipt" ("donation_id") WHERE "status" = 'ISSUED';

-- B-M4: 반환 수량은 0 이상, 상품 수량 이하
ALTER TABLE "bazaar_product" ADD CONSTRAINT "bazaar_product_returned_qty_range" CHECK ("returned_qty" >= 0);
