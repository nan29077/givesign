-- 2026-11-13 5차 L: 본인인증(identity_verification)·시점확인(document_timestamp)·카드 일시후원(card_checkout_session·card_fee_policy·charge.payment_method)·계좌 자동 조회(bank_feed_link)·관계 확장 안내(relationship_message_setting·relationship_message). 모두 꺼짐 기본 — 기존 행·동작 무변화
-- AlterTable
ALTER TABLE "charge" ADD COLUMN     "payment_method" TEXT;

-- CreateTable
CREATE TABLE "identity_verification" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "request_token_hash" TEXT NOT NULL,
    "return_path" TEXT NOT NULL,
    "phone_hash" TEXT,
    "name_hash" TEXT,
    "birth_hash" TEXT,
    "ci_hash" TEXT,
    "failure_reason" TEXT,
    "verified_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_timestamp" (
    "envelope_id" TEXT NOT NULL,
    "document_hash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "token_enc" TEXT,
    "stamped_at" TIMESTAMPTZ(3),
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_timestamp_pkey" PRIMARY KEY ("envelope_id")
);

-- CreateTable
CREATE TABLE "card_checkout_session" (
    "id" TEXT NOT NULL,
    "charge_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "mock" BOOLEAN NOT NULL DEFAULT false,
    "checkout_url_masked" TEXT NOT NULL,
    "result_note" TEXT,
    "callback_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "card_checkout_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "card_fee_policy" (
    "id" TEXT NOT NULL,
    "scope" "policy_scope" NOT NULL DEFAULT 'GLOBAL',
    "merchant_id" TEXT,
    "pg_fee_rate" DECIMAL(10,6) NOT NULL,
    "pg_fixed_fee" BIGINT NOT NULL DEFAULT 0,
    "platform_fee_rate" DECIMAL(10,6) NOT NULL,
    "vat_included" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(3),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "card_fee_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bank_feed_link" (
    "merchant_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_masked" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "last_result" TEXT,
    "last_message" TEXT,
    "last_synced_at" TIMESTAMPTZ(3),
    "fetched_to" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bank_feed_link_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "relationship_message_setting" (
    "merchant_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "kinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "paused_at" TIMESTAMPTZ(3),
    "pause_reason" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "relationship_message_setting_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "relationship_message" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "approval_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "skip_reason" TEXT,
    "not_before" TIMESTAMPTZ(3),
    "mt_message_id" TEXT,
    "opt_out_token_hash" TEXT,
    "opted_out_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "relationship_message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "identity_verification_request_token_hash_key" ON "identity_verification"("request_token_hash");

-- CreateIndex
CREATE INDEX "identity_verification_phone_hash_purpose_verified_at_idx" ON "identity_verification"("phone_hash", "purpose", "verified_at");

-- CreateIndex
CREATE INDEX "identity_verification_status_expires_at_idx" ON "identity_verification"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "card_checkout_session_charge_id_key" ON "card_checkout_session"("charge_id");

-- CreateIndex
CREATE UNIQUE INDEX "card_checkout_session_session_id_key" ON "card_checkout_session"("session_id");

-- CreateIndex
CREATE INDEX "card_checkout_session_status_expires_at_idx" ON "card_checkout_session"("status", "expires_at");

-- CreateIndex
CREATE INDEX "card_fee_policy_scope_merchant_id_effective_from_idx" ON "card_fee_policy"("scope", "merchant_id", "effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_message_dedupe_key_key" ON "relationship_message"("dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_message_opt_out_token_hash_key" ON "relationship_message"("opt_out_token_hash");

-- CreateIndex
CREATE INDEX "relationship_message_merchant_id_status_idx" ON "relationship_message"("merchant_id", "status");

-- CreateIndex
CREATE INDEX "relationship_message_approval_id_idx" ON "relationship_message"("approval_id");

-- CreateIndex
CREATE INDEX "relationship_message_payer_id_sent_at_idx" ON "relationship_message"("payer_id", "sent_at");

