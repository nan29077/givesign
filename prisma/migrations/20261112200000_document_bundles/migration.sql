-- 2026-11-12 4차 J — 업무별 문서 묶음(한 번의 본인확인으로 여러 문서 서명)
-- 기관·후원자 표에는 FK 를 걸지 않는다(공용 모델 무변경). 묶음 내부 표끼리만 CASCADE.

CREATE TABLE "document_bundle" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "preset_key" TEXT,
    "use_for_recurring" BOOLEAN NOT NULL DEFAULT false,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_bundle_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "document_bundle_merchant_id_archived_at_idx" ON "document_bundle"("merchant_id", "archived_at");

-- 기본 묶음은 기관당 같은 preset 1개(동시 생성 멱등)
CREATE UNIQUE INDEX "document_bundle_merchant_preset_one" ON "document_bundle" ("merchant_id", "preset_key")
  WHERE "preset_key" IS NOT NULL;

-- 정기후원 약정에 쓰는 묶음은 기관당 1개
CREATE UNIQUE INDEX "document_bundle_merchant_recurring_one" ON "document_bundle" ("merchant_id")
  WHERE "use_for_recurring" = true AND "archived_at" IS NULL;

CREATE TABLE "document_bundle_item" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "document_bundle_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_bundle_item_bundle_id_purpose_key" ON "document_bundle_item"("bundle_id", "purpose");

ALTER TABLE "document_bundle_item" ADD CONSTRAINT "document_bundle_item_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "document_bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "document_bundle_send" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PREPARING',
    "blocked" TEXT,
    "blocked_reason" TEXT,
    "token_hash" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "subject_type" TEXT,
    "subject_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "otp_verified_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_bundle_send_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_bundle_send_dedupe_key_key" ON "document_bundle_send"("dedupe_key");
CREATE UNIQUE INDEX "document_bundle_send_token_hash_key" ON "document_bundle_send"("token_hash");
CREATE INDEX "document_bundle_send_merchant_id_status_created_at_idx" ON "document_bundle_send"("merchant_id", "status", "created_at");
CREATE INDEX "document_bundle_send_bundle_id_created_at_idx" ON "document_bundle_send"("bundle_id", "created_at");

ALTER TABLE "document_bundle_send" ADD CONSTRAINT "document_bundle_send_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "document_bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "document_bundle_send_item" (
    "id" TEXT NOT NULL,
    "send_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "template_id" TEXT,
    "template_revision" TEXT,
    "issued_document_id" TEXT,
    "envelope_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,

    CONSTRAINT "document_bundle_send_item_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "document_bundle_send_item_send_id_purpose_key" ON "document_bundle_send_item"("send_id", "purpose");
CREATE INDEX "document_bundle_send_item_envelope_id_idx" ON "document_bundle_send_item"("envelope_id");

ALTER TABLE "document_bundle_send_item" ADD CONSTRAINT "document_bundle_send_item_send_id_fkey" FOREIGN KEY ("send_id") REFERENCES "document_bundle_send"("id") ON DELETE CASCADE ON UPDATE CASCADE;
