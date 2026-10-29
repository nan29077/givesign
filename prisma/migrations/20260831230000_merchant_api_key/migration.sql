-- 사회복지기관 연동 API 키 (선택 기능)
CREATE TABLE "merchant_api_key" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "signing_enc" TEXT NOT NULL,
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_api_key_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "merchant_api_key_prefix_key" ON "merchant_api_key"("prefix");
CREATE UNIQUE INDEX "merchant_api_key_key_hash_key" ON "merchant_api_key"("key_hash");
CREATE INDEX "merchant_api_key_merchant_id_revoked_at_idx" ON "merchant_api_key"("merchant_id", "revoked_at");

ALTER TABLE "merchant_api_key" ADD CONSTRAINT "merchant_api_key_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
