-- CreateEnum
CREATE TYPE "edoc_ledger_kind" AS ENUM ('TOPUP', 'PLAN_GRANT', 'TRIAL_GRANT', 'USE', 'REFUND', 'EXPIRE', 'ADJUST');

-- CreateEnum
CREATE TYPE "edoc_use_source" AS ENUM ('MONTHLY', 'TRIAL', 'PREPAID');

-- CreateEnum
CREATE TYPE "edoc_billing_kind" AS ENUM ('TOPUP', 'MONTHLY');

-- CreateEnum
CREATE TYPE "edoc_billing_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "edoc_subscription_status" AS ENUM ('ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "edoc_envelope_status" AS ENUM ('SENT', 'IN_PROGRESS', 'COMPLETED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "edoc_signer_status" AS ENUM ('WAITING', 'SENT', 'VIEWED', 'SIGNED', 'DECLINED');

-- CreateEnum
CREATE TYPE "edoc_signer_role" AS ENUM ('DONOR', 'GUARDIAN', 'VOLUNTEER', 'PARTICIPANT', 'STAFF', 'OTHER');

-- CreateEnum
CREATE TYPE "edoc_signing_order" AS ENUM ('PARALLEL', 'SEQUENTIAL');

-- CreateTable
CREATE TABLE "edoc_plan" (
    "id" TEXT NOT NULL,
    "per_document" INTEGER NOT NULL,
    "monthly_price" INTEGER NOT NULL,
    "monthly_quota" INTEGER NOT NULL,
    "trial_quota" INTEGER NOT NULL,
    "topup_bonus" JSONB,
    "low_balance" INTEGER NOT NULL DEFAULT 2000,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edoc_plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edoc_wallet" (
    "merchant_id" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "trial_remaining" INTEGER NOT NULL DEFAULT 0,
    "total_used" INTEGER NOT NULL DEFAULT 0,
    "low_balance_notified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "edoc_wallet_pkey" PRIMARY KEY ("merchant_id")
);

-- CreateTable
CREATE TABLE "edoc_ledger" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "kind" "edoc_ledger_kind" NOT NULL,
    "amount" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "source" "edoc_use_source",
    "supply_amount" INTEGER NOT NULL DEFAULT 0,
    "vat_amount" INTEGER NOT NULL DEFAULT 0,
    "balance_after" INTEGER NOT NULL,
    "trial_after" INTEGER NOT NULL,
    "envelope_id" TEXT,
    "billing_request_id" TEXT,
    "subscription_id" TEXT,
    "idempotency_key" TEXT NOT NULL,
    "memo" TEXT,
    "actor_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edoc_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edoc_subscription" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "billing_request_id" TEXT,
    "price" INTEGER NOT NULL,
    "quota" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "edoc_subscription_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "edoc_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edoc_billing_request" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "kind" "edoc_billing_kind" NOT NULL,
    "amount" INTEGER NOT NULL,
    "quota" INTEGER NOT NULL DEFAULT 0,
    "bonus" INTEGER NOT NULL DEFAULT 0,
    "status" "edoc_billing_status" NOT NULL DEFAULT 'PENDING',
    "depositor_name" TEXT,
    "wants_tax_invoice" BOOLEAN NOT NULL DEFAULT true,
    "tax_invoice_issued" BOOLEAN NOT NULL DEFAULT false,
    "requested_by" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "edoc_billing_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edoc_envelope" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snapshot_enc" TEXT NOT NULL,
    "snapshot_hash" TEXT NOT NULL,
    "prefill_enc" TEXT,
    "signing_order" "edoc_signing_order" NOT NULL DEFAULT 'PARALLEL',
    "status" "edoc_envelope_status" NOT NULL DEFAULT 'SENT',
    "message" TEXT,
    "charge_source" "edoc_use_source",
    "batch_id" TEXT,
    "created_by" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "document_hash" TEXT,
    "last_event_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "edoc_envelope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edoc_signer" (
    "id" TEXT NOT NULL,
    "envelope_id" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 1,
    "role" "edoc_signer_role" NOT NULL DEFAULT 'DONOR',
    "name_enc" TEXT NOT NULL,
    "name_masked" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "status" "edoc_signer_status" NOT NULL DEFAULT 'SENT',
    "auth_method" TEXT NOT NULL DEFAULT 'SMS_OTP',
    "otp_verified_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "viewed_at" TIMESTAMPTZ(3),
    "signed_at" TIMESTAMPTZ(3),
    "declined_at" TIMESTAMPTZ(3),
    "decline_reason" TEXT,
    "values_enc" TEXT,
    "signature_url" TEXT,
    "sign_ip" TEXT,
    "sign_agent" TEXT,
    "remind_count" INTEGER NOT NULL DEFAULT 0,
    "last_reminded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "edoc_signer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "edoc_event" (
    "id" TEXT NOT NULL,
    "envelope_id" TEXT NOT NULL,
    "signer_id" TEXT,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "detail" JSONB,
    "prev_hash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edoc_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "edoc_plan_effective_from_idx" ON "edoc_plan"("effective_from");

-- CreateIndex
CREATE UNIQUE INDEX "edoc_ledger_idempotency_key_key" ON "edoc_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "edoc_ledger_merchant_id_created_at_idx" ON "edoc_ledger"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "edoc_ledger_kind_created_at_idx" ON "edoc_ledger"("kind", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "edoc_subscription_billing_request_id_key" ON "edoc_subscription"("billing_request_id");

-- CreateIndex
CREATE INDEX "edoc_subscription_merchant_id_status_ends_at_idx" ON "edoc_subscription"("merchant_id", "status", "ends_at");

-- CreateIndex
CREATE INDEX "edoc_billing_request_status_created_at_idx" ON "edoc_billing_request"("status", "created_at");

-- CreateIndex
CREATE INDEX "edoc_billing_request_merchant_id_created_at_idx" ON "edoc_billing_request"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "edoc_envelope_merchant_id_status_created_at_idx" ON "edoc_envelope"("merchant_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "edoc_envelope_batch_id_idx" ON "edoc_envelope"("batch_id");

-- CreateIndex
CREATE INDEX "edoc_envelope_status_expires_at_idx" ON "edoc_envelope"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "edoc_signer_token_hash_key" ON "edoc_signer"("token_hash");

-- CreateIndex
CREATE INDEX "edoc_signer_envelope_id_order_idx" ON "edoc_signer"("envelope_id", "order");

-- CreateIndex
CREATE INDEX "edoc_signer_phone_hash_idx" ON "edoc_signer"("phone_hash");

-- CreateIndex
CREATE INDEX "edoc_event_envelope_id_created_at_idx" ON "edoc_event"("envelope_id", "created_at");

-- AddForeignKey
ALTER TABLE "edoc_wallet" ADD CONSTRAINT "edoc_wallet_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edoc_ledger" ADD CONSTRAINT "edoc_ledger_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edoc_subscription" ADD CONSTRAINT "edoc_subscription_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edoc_billing_request" ADD CONSTRAINT "edoc_billing_request_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edoc_envelope" ADD CONSTRAINT "edoc_envelope_merchant_id_fkey" FOREIGN KEY ("merchant_id") REFERENCES "merchant_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edoc_envelope" ADD CONSTRAINT "edoc_envelope_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "document_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edoc_signer" ADD CONSTRAINT "edoc_signer_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "edoc_envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edoc_event" ADD CONSTRAINT "edoc_event_envelope_id_fkey" FOREIGN KEY ("envelope_id") REFERENCES "edoc_envelope"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 전자문서 원장·감사추적 append-only
--   어떤 경로로도 UPDATE/DELETE 할 수 없다. 정정은 ADJUST 행을 새로 남긴다.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION givesign_block_edoc_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '전자문서 이용 원장(edoc_ledger)은 수정/삭제할 수 없습니다. 정정은 조정 기록으로 남기십시오.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edoc_ledger_append_only
  BEFORE UPDATE OR DELETE ON "edoc_ledger"
  FOR EACH ROW EXECUTE FUNCTION givesign_block_edoc_ledger_mutation();

CREATE OR REPLACE FUNCTION givesign_block_edoc_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '전자문서 감사추적(edoc_event)은 수정/삭제할 수 없습니다.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER edoc_event_append_only
  BEFORE UPDATE OR DELETE ON "edoc_event"
  FOR EACH ROW EXECUTE FUNCTION givesign_block_edoc_event_mutation();

-- 지갑 잔액은 음수가 될 수 없다(동시 발송 경합 최후 방어선).
ALTER TABLE "edoc_wallet" ADD CONSTRAINT "edoc_wallet_balance_nonneg" CHECK ("balance" >= 0 AND "trial_remaining" >= 0);
ALTER TABLE "edoc_subscription" ADD CONSTRAINT "edoc_subscription_used_range" CHECK ("used" >= 0 AND "used" <= "quota");

-- 같은 기관에 진행 중 정액 이용은 1건만
CREATE UNIQUE INDEX "edoc_subscription_one_active" ON "edoc_subscription" ("merchant_id") WHERE "status" = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- system_setting 에 임시로 저장하던 전자문서 요금·잔액·신청을 새 테이블로 옮긴다.
-- (원본 설정 행은 지우지 않는다. 새 코드는 더 이상 읽지 않는다.)
-- ---------------------------------------------------------------------------

-- 1) 요금 정책: 저장된 값이 있으면 그 값, 없으면 기본값
INSERT INTO "edoc_plan" ("id", "per_document", "monthly_price", "monthly_quota", "trial_quota", "low_balance", "effective_from", "note")
SELECT 'edoc-plan-initial',
       COALESCE((s.value->>'perDocument')::int, 200),
       COALESCE((s.value->>'monthlyPrice')::int, 30000),
       COALESCE((s.value->>'monthlyQuota')::int, 200),
       COALESCE((s.value->>'trialQuota')::int, 5),
       2000,
       TIMESTAMPTZ '2026-01-01 00:00:00+09',
       '초기 요금(이관)'
FROM (SELECT 1) one
LEFT JOIN "system_setting" s ON s.key = 'givesign:edoc:policy';

-- 2) 기관 잔액 → 지갑 + 기초 잔액 원장
INSERT INTO "edoc_wallet" ("merchant_id", "balance", "trial_remaining", "total_used", "updated_at")
SELECT m.id,
       GREATEST(COALESCE((s.value->>'balance')::int, 0), 0),
       GREATEST(COALESCE((s.value->>'trialRemaining')::int, 0), 0),
       GREATEST(COALESCE((s.value->>'totalUsed')::int, 0), 0),
       now()
FROM "system_setting" s
JOIN "merchant_profile" m ON m.id = substring(s.key FROM length('givesign:edoc:account:') + 1)
WHERE s.key LIKE 'givesign:edoc:account:%';

INSERT INTO "edoc_ledger" ("id", "merchant_id", "kind", "amount", "units", "supply_amount", "vat_amount", "balance_after", "trial_after", "idempotency_key", "memo")
SELECT 'edoc-migrate-' || w.merchant_id, w.merchant_id, 'ADJUST', w.balance, w.trial_remaining,
       round(w.balance / 1.1)::int, w.balance - round(w.balance / 1.1)::int,
       w.balance, w.trial_remaining, 'migrate:wallet:' || w.merchant_id, '이전 설정값에서 이관한 기초 잔액'
FROM "edoc_wallet" w;

-- 3) 남아 있는 30일 정액 → 정액 이용
INSERT INTO "edoc_subscription" ("id", "merchant_id", "price", "quota", "used", "starts_at", "ends_at", "status", "updated_at")
SELECT 'edoc-sub-migrate-' || m.id, m.id,
       (SELECT "monthly_price" FROM "edoc_plan" WHERE id = 'edoc-plan-initial'),
       GREATEST((s.value->>'monthlyRemaining')::int, 0), 0,
       ((s.value->>'monthlyUntil')::timestamptz - interval '30 days'),
       (s.value->>'monthlyUntil')::timestamptz, 'ACTIVE', now()
FROM "system_setting" s
JOIN "merchant_profile" m ON m.id = substring(s.key FROM length('givesign:edoc:account:') + 1)
WHERE s.key LIKE 'givesign:edoc:account:%'
  AND s.value->>'monthlyUntil' IS NOT NULL
  AND (s.value->>'monthlyUntil')::timestamptz > now()
  AND COALESCE((s.value->>'monthlyRemaining')::int, 0) > 0;

-- 4) 충전·정액 신청
INSERT INTO "edoc_billing_request" ("id", "merchant_id", "kind", "amount", "quota", "status", "resolved_at", "created_at", "updated_at")
SELECT s.value->>'id', m.id,
       (s.value->>'kind')::"edoc_billing_kind",
       (s.value->>'amount')::int,
       COALESCE((s.value->>'quota')::int, 0),
       (s.value->>'status')::"edoc_billing_status",
       (s.value->>'resolvedAt')::timestamptz,
       COALESCE((s.value->>'createdAt')::timestamptz, s.updated_at),
       s.updated_at
FROM "system_setting" s
JOIN "merchant_profile" m ON m.id = s.value->>'merchantId'
WHERE s.key LIKE 'givesign:edoc:billing:%'
  AND s.value->>'kind' IN ('TOPUP', 'MONTHLY')
  AND s.value->>'status' IN ('PENDING', 'APPROVED', 'REJECTED')
  AND s.value->>'id' IS NOT NULL
ON CONFLICT ("id") DO NOTHING;
