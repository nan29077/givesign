-- 2026-11-05 점검 D: 기관이 올린 글꼴 대장(소유·한도) + /doc 제출 당시 서식 스냅샷
CREATE TABLE "document_font_asset" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "match" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_font_asset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_font_asset_name_key" ON "document_font_asset"("name");
CREATE INDEX "document_font_asset_merchant_id_created_at_idx" ON "document_font_asset"("merchant_id", "created_at");

ALTER TABLE "document_font_asset" ADD CONSTRAINT "document_font_asset_merchant_id_fkey"
  FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "document_submission"
  ADD COLUMN "template_snapshot_enc" TEXT,
  ADD COLUMN "template_snapshot_hash" TEXT;
