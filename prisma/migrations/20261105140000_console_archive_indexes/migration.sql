-- AlterTable
ALTER TABLE "banned_word" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "merchant_mt_template" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "merchant_webhook" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "public_holiday" ADD COLUMN     "archived_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "banned_word_merchant_id_idx" ON "banned_word"("merchant_id");

-- CreateIndex
CREATE INDEX "charge_limit_policy_scope_merchant_id_effective_from_idx" ON "charge_limit_policy"("scope", "merchant_id", "effective_from");

-- CreateIndex
CREATE INDEX "charge_limit_policy_payer_id_idx" ON "charge_limit_policy"("payer_id");

-- CreateIndex
CREATE INDEX "donor_session_merchant_id_idx" ON "donor_session"("merchant_id");

-- CreateIndex
CREATE INDEX "fee_policy_scope_merchant_id_effective_from_idx" ON "fee_policy"("scope", "merchant_id", "effective_from");

-- CreateIndex
CREATE INDEX "payment_registration_merchant_id_idx" ON "payment_registration"("merchant_id");

-- CreateIndex
CREATE INDEX "report_merchant_id_idx" ON "report"("merchant_id");

-- CreateIndex
CREATE INDEX "risk_detection_merchant_id_idx" ON "risk_detection"("merchant_id");

-- CreateIndex
CREATE INDEX "risk_detection_payer_id_idx" ON "risk_detection"("payer_id");

-- CreateIndex
CREATE INDEX "risk_detection_charge_id_idx" ON "risk_detection"("charge_id");

-- CreateIndex
CREATE INDEX "support_inquiry_merchant_id_idx" ON "support_inquiry"("merchant_id");

-- 2026-11-05 점검 E: 사용 중(보관되지 않은) 후원 항목끼리 이름 유일.
-- 콘솔은 앱에서만 같은 이름을 막아 동시 요청·파트너 API 로 중복이 생길 수 있었다.
-- 이미 겹친 행이 있으면(개발 DB) 먼저 만든 1건을 남기고 나머지 이름 뒤에 id 앞 6자를 붙인다.
UPDATE "charge_product" p
   SET "name" = LEFT(p."name", 32) || ' #' || LEFT(p."id", 6)
  FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "merchant_id", "name" ORDER BY "created_at", "id") AS rn
      FROM "charge_product"
     WHERE "archived_at" IS NULL
  ) d
 WHERE p."id" = d."id" AND d.rn > 1;

CREATE UNIQUE INDEX "charge_product_merchant_name_live_key"
    ON "charge_product" ("merchant_id", "name")
 WHERE "archived_at" IS NULL;

