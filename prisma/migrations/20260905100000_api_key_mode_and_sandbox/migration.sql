-- 연동 API 키에 모드(LIVE/TEST)를 두고, 샌드박스 전용 저장소를 만든다.
--
-- 테스트 데이터를 charge 테이블에 플래그로 섞으면 정산·통계·한도 집계 가운데
-- 한 곳만 빠뜨려도 테스트 금액이 실제 정산에 들어간다. 그래서 별도 테이블로 분리한다.
-- 기존 키는 모두 LIVE 로 남는다(동작 변화 없음).

CREATE TYPE "api_key_mode" AS ENUM ('LIVE', 'TEST');

ALTER TABLE "merchant_api_key" ADD COLUMN "mode" "api_key_mode" NOT NULL DEFAULT 'LIVE';

CREATE TABLE "sandbox_charge" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "transaction_no" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "shipping_fee" BIGINT NOT NULL DEFAULT 0,
    "message" TEXT NOT NULL DEFAULT '',
    "payer_phone_masked" TEXT NOT NULL,
    "payer_ref" TEXT NOT NULL,
    "product_name" TEXT,
    "product_kind" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
    "fail_reason" TEXT,
    "point_status" TEXT NOT NULL DEFAULT 'PENDING',
    "point_note" TEXT,
    "shipment_status" TEXT,
    "carrier" TEXT,
    "tracking_no" TEXT,
    "paid_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sandbox_charge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sandbox_charge_transaction_no_key" ON "sandbox_charge"("transaction_no");
CREATE INDEX "sandbox_charge_merchant_id_paid_at_idx" ON "sandbox_charge"("merchant_id", "paid_at");
CREATE INDEX "sandbox_charge_merchant_id_point_status_idx" ON "sandbox_charge"("merchant_id", "point_status");

ALTER TABLE "sandbox_charge" ADD CONSTRAINT "sandbox_charge_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sandbox_message" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "template_code" TEXT,
    "body" TEXT NOT NULL,
    "transaction_no" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sandbox_message_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "sandbox_message_merchant_id_created_at_idx" ON "sandbox_message"("merchant_id", "created_at");

ALTER TABLE "sandbox_message" ADD CONSTRAINT "sandbox_message_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
