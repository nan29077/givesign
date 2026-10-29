-- 웹훅(사회복지기관 이벤트 구독)과 사회복지기관 회원 ID 연결.
--
-- 웹훅 발행은 본 흐름을 막지 않는다. 이벤트를 적재만 하고 전송은 따로 돈다.
-- 결제 성공 처리가 사회복지기관 서버 사정 때문에 실패하면 안 되기 때문이다.

CREATE TYPE "webhook_delivery_status" AS ENUM ('PENDING', 'SENT', 'DEAD');

CREATE TABLE "merchant_webhook" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT '',
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_status" INTEGER,
    "last_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_webhook_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "merchant_webhook_merchant_id_active_idx" ON "merchant_webhook"("merchant_id", "active");

ALTER TABLE "merchant_webhook" ADD CONSTRAINT "merchant_webhook_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "webhook_id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "response_status" INTEGER,
    "error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "webhook_delivery_status_next_attempt_at_idx" ON "webhook_delivery"("status", "next_attempt_at");
CREATE INDEX "webhook_delivery_merchant_id_created_at_idx" ON "webhook_delivery"("merchant_id", "created_at");

ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_webhook_id_fkey"
    FOREIGN KEY ("webhook_id") REFERENCES "merchant_webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 사회복지기관 사이트의 회원 ID 를 후원자에 연결해 둘 수 있게 한다(선택).
ALTER TABLE "payer_merchant_link" ADD COLUMN "merchant_member_id" TEXT;
CREATE INDEX "payer_merchant_link_merchant_id_merchant_member_id_idx"
    ON "payer_merchant_link"("merchant_id", "merchant_member_id");
