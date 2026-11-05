-- 고도화 2단계: 전자문서 통일 — 서식 용도·자동 발송 토글·기본 세트 표시, 용도별 자동 발송 문서 발급 대장

ALTER TABLE "document_template" ADD COLUMN "purpose" TEXT;
ALTER TABLE "document_template" ADD COLUMN "auto_send" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "document_template" ADD COLUMN "default_set" BOOLEAN NOT NULL DEFAULT false;

-- 기관×용도마다 자동 발송에 쓰는 서식은 보관 전 1개(중지·자동 발송 끔도 그 1개가 용도를 쥔다).
CREATE UNIQUE INDEX "document_template_merchant_purpose_one" ON "document_template" ("merchant_id", "purpose")
  WHERE "purpose" IS NOT NULL AND "archived_at" IS NULL;

CREATE TABLE "issued_document" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "template_revision" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snapshot_enc" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "pdf_object" TEXT,
    "pdf_hash" TEXT,
    "signature" BOOLEAN NOT NULL DEFAULT false,
    "envelope_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "token_hash" TEXT,
    "expires_at" TIMESTAMPTZ(3),
    "first_viewed_at" TIMESTAMPTZ(3),
    "last_viewed_at" TIMESTAMPTZ(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "send_count" INTEGER NOT NULL DEFAULT 0,
    "send_error" TEXT,
    "missing_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dedupe_key" TEXT NOT NULL,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "signed_at" TIMESTAMPTZ(3),
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "issued_document_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "issued_document_envelope_id_key" ON "issued_document"("envelope_id");
CREATE UNIQUE INDEX "issued_document_token_hash_key" ON "issued_document"("token_hash");
CREATE UNIQUE INDEX "issued_document_dedupe_key_key" ON "issued_document"("dedupe_key");
CREATE INDEX "issued_document_merchant_id_created_at_idx" ON "issued_document"("merchant_id", "created_at");
CREATE INDEX "issued_document_payer_id_created_at_idx" ON "issued_document"("payer_id", "created_at");
CREATE INDEX "issued_document_merchant_id_purpose_subject_type_subject_id_idx" ON "issued_document"("merchant_id", "purpose", "subject_type", "subject_id");
