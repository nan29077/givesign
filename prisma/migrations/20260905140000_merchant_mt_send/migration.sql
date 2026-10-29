-- 사회복지기관 MT 발송 v1.
--
-- 사회복지기관이 자기 후원자에게 거래 안내 문자를 보낼 수 있게 한다.
-- 범위를 좁혀서 연다(발신번호 고정 · 정보성만 · 거래 이력 있는 후원자만 · 등록 템플릿만).
-- 기존 발송 흐름은 그대로다. 추가되는 컬럼은 모두 기본값이 있어 옛 행에 영향이 없다.

CREATE TYPE "merchant_mt_template_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

CREATE TABLE "merchant_mt_template" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "variables" TEXT NOT NULL DEFAULT '',
    "status" "merchant_mt_template_status" NOT NULL DEFAULT 'PENDING',
    "review_note" TEXT,
    "reviewed_at" TIMESTAMPTZ(3),
    "reviewed_by" TEXT,
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "merchant_mt_template_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_mt_template_merchant_id_code_key" ON "merchant_mt_template"("merchant_id", "code");
CREATE INDEX "merchant_mt_template_status_created_at_idx" ON "merchant_mt_template"("status", "created_at");

ALTER TABLE "merchant_mt_template" ADD CONSTRAINT "merchant_mt_template_merchant_id_fkey"
    FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- payerRef 는 HMAC 이라 되돌릴 수 없다. 그 값으로 후원자를 찾으려면 미리 저장해 둬야 한다.
-- 옛 행은 비어 있고, 필요할 때 애플리케이션이 채운다(HMAC 비밀키가 앱에만 있어 SQL 로는 못 채운다).
ALTER TABLE "payer_merchant_link" ADD COLUMN "payer_ref" TEXT;
CREATE INDEX "payer_merchant_link_merchant_id_payer_ref_idx" ON "payer_merchant_link"("merchant_id", "payer_ref");

-- 재시도로 같은 문자가 두 번 나가는 것을 막는다. 시스템 발송에는 멱등키가 없다(NULL).
-- PostgreSQL 에서 NULL 은 유니크 제약에 걸리지 않으므로 기존 발송에는 영향이 없다.
ALTER TABLE "mt_outbound_message" ADD COLUMN "idempotency_key" TEXT;
ALTER TABLE "mt_outbound_message" ADD COLUMN "merchant_sent" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX "mt_outbound_message_merchant_id_idempotency_key_key"
    ON "mt_outbound_message"("merchant_id", "idempotency_key");
