-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('DONOR', 'CREATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'SUSPENDED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "creator_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "mo_number_status" AS ENUM ('AVAILABLE', 'RESERVED', 'ASSIGNED', 'RECLAIMED', 'DISABLED');

-- CreateEnum
CREATE TYPE "mo_route_mode" AS ENUM ('DEDICATED', 'SHARED_PREFIX');

-- CreateEnum
CREATE TYPE "message_type" AS ENUM ('SMS', 'LMS', 'MMS');

-- CreateEnum
CREATE TYPE "mo_process_result" AS ENUM ('PENDING', 'ROUTED', 'UNKNOWN_ROUTE', 'DUPLICATE', 'UNREGISTERED_DONOR', 'BLOCKED', 'ERROR');

-- CreateEnum
CREATE TYPE "donation_status" AS ENUM ('RECEIVED', 'UNREGISTERED', 'LIMIT_BLOCKED', 'CONTENT_BLOCKED', 'PENDING_CONFIRM', 'PENDING_PAYMENT', 'PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'BROADCAST_PENDING', 'BROADCASTED', 'PARTIAL_DELIVERY_FAILED', 'REFUND_REQUESTED', 'REFUNDED', 'SETTLEMENT_PENDING', 'SETTLED');

-- CreateEnum
CREATE TYPE "payment_mode" AS ENUM ('DIRECT_TRIGGER', 'CONFIRM_LINK');

-- CreateEnum
CREATE TYPE "payment_tx_status" AS ENUM ('REQUESTED', 'APPROVED', 'FAILED', 'CANCELED', 'TIMEOUT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "payment_token_status" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "registration_status" AS ENUM ('STARTED', 'AUTH_DONE', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "refund_status" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "secure_link_purpose" AS ENUM ('REGISTER_ACCOUNT', 'CONFIRM_PAYMENT', 'MANAGE_DONOR');

-- CreateEnum
CREATE TYPE "policy_scope" AS ENUM ('GLOBAL', 'CREATOR', 'DONOR');

-- CreateEnum
CREATE TYPE "ledger_entry_type" AS ENUM ('DONATION_GROSS', 'PG_FEE', 'PLATFORM_FEE', 'REFUND', 'REFUND_FEE_RETURN', 'ADJUSTMENT', 'PAYOUT', 'PAYOUT_WITHHOLDING');

-- CreateEnum
CREATE TYPE "settlement_request_status" AS ENUM ('REQUESTED', 'REVIEWING', 'APPROVED', 'PAID', 'REJECTED');

-- CreateEnum
CREATE TYPE "consent_type" AS ENUM ('TERMS_SERVICE', 'PRIVACY', 'E_FINANCE', 'WITHDRAWAL_AGREE', 'AGE_CONFIRM', 'MARKETING');

-- CreateEnum
CREATE TYPE "risk_level" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "risk_type" AS ENUM ('VELOCITY', 'DAILY_LIMIT', 'MONTHLY_LIMIT', 'REPEATED_FAILURE', 'NEW_DONOR', 'MANUAL_REVIEW', 'DUPLICATE_WEBHOOK', 'ABNORMAL_AMOUNT');

-- CreateEnum
CREATE TYPE "content_action" AS ENUM ('BLOCK', 'MASK', 'FLAG');

-- CreateEnum
CREATE TYPE "youtube_connection_status" AS ENUM ('CONNECTED', 'EXPIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "stream_key_status" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "report_status" AS ENUM ('OPEN', 'REVIEWING', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('MT_SMS', 'EMAIL', 'IN_APP');

-- CreateEnum
CREATE TYPE "admin_permission" AS ENUM ('SUPER_ADMIN', 'OPERATION', 'FINANCE', 'SUPPORT', 'READ_ONLY');

-- CreateTable
CREATE TABLE "app_user" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "password_hash" TEXT,
    "role" "user_role" NOT NULL DEFAULT 'DONOR',
    "status" "user_status" NOT NULL DEFAULT 'ACTIVE',
    "name" TEXT,
    "phone_hash" TEXT,
    "phone_enc" TEXT,
    "phone_masked" TEXT,
    "age_verified" BOOLEAN NOT NULL DEFAULT false,
    "last_login_at" TIMESTAMPTZ(3),
    "two_factor_secret" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_session" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_profile" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "permission" "admin_permission" NOT NULL DEFAULT 'READ_ONLY',
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "admin_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donor_profile" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "display_name" TEXT,
    "age_verified" BOOLEAN NOT NULL DEFAULT false,
    "daily_limit" BIGINT,
    "monthly_limit" BIGINT,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "blocked_at" TIMESTAMPTZ(3),
    "blocked_reason" TEXT,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "registered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "donor_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donor_creator_link" (
    "id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "consented_at" TIMESTAMPTZ(3),
    "blocked_at" TIMESTAMPTZ(3),
    "daily_limit" BIGINT,
    "total_amount" BIGINT NOT NULL DEFAULT 0,
    "total_count" INTEGER NOT NULL DEFAULT 0,
    "last_donated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "donor_creator_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_donor" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "reason" TEXT,
    "blocked_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_donor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_profile" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "channel_name" TEXT,
    "avatar_url" TEXT,
    "description" TEXT,
    "status" "creator_status" NOT NULL DEFAULT 'PENDING',
    "donation_amount" BIGINT NOT NULL DEFAULT 3000,
    "min_amount" BIGINT NOT NULL DEFAULT 1000,
    "max_amount" BIGINT NOT NULL DEFAULT 50000,
    "payment_mode" "payment_mode",
    "business_no" TEXT,
    "approved_at" TIMESTAMPTZ(3),
    "suspended_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "creator_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_code" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "creator_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creator_mo_number" (
    "id" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "keyword" TEXT,
    "mode" "mo_route_mode" NOT NULL DEFAULT 'DEDICATED',
    "status" "mo_number_status" NOT NULL DEFAULT 'AVAILABLE',
    "provider_id" TEXT,
    "creator_id" TEXT,
    "monthly_cost" BIGINT NOT NULL DEFAULT 0,
    "assigned_at" TIMESTAMPTZ(3),
    "released_at" TIMESTAMPTZ(3),
    "memo" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "creator_mo_number_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mo_inbound_message" (
    "id" TEXT NOT NULL,
    "provider_message_id" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "received_number" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "message_type" "message_type" NOT NULL DEFAULT 'SMS',
    "content_enc" TEXT NOT NULL,
    "content_filtered" TEXT,
    "attachment_info" JSONB,
    "creator_id" TEXT,
    "matched_keyword" TEXT,
    "result" "mo_process_result" NOT NULL DEFAULT 'PENDING',
    "result_detail" TEXT,
    "received_at" TIMESTAMPTZ(3) NOT NULL,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mo_inbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mt_outbound_message" (
    "id" TEXT NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "phone_enc" TEXT NOT NULL,
    "phone_masked" TEXT NOT NULL,
    "from_number" TEXT NOT NULL,
    "message_type" "message_type" NOT NULL DEFAULT 'SMS',
    "template_code" TEXT,
    "body_masked" TEXT NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "provider_code" TEXT,
    "provider_message_id" TEXT,
    "result_code" TEXT,
    "result_message" TEXT,
    "donation_id" TEXT,
    "creator_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mt_outbound_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "secure_link" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" "secure_link_purpose" NOT NULL,
    "phone_hash" TEXT NOT NULL,
    "creator_id" TEXT,
    "donation_id" TEXT,
    "payload" JSONB,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "used_ip" TEXT,
    "used_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "secure_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_registration" (
    "id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "creator_id" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'HECTO',
    "provider_tid" TEXT,
    "status" "registration_status" NOT NULL DEFAULT 'STARTED',
    "result_code" TEXT,
    "result_message" TEXT,
    "raw_masked" JSONB,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_method_token" (
    "id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'HECTO',
    "bill_key_enc" TEXT NOT NULL,
    "bill_key_hint" TEXT NOT NULL,
    "bank_code" TEXT,
    "bank_name" TEXT,
    "account_tail4" TEXT,
    "status" "payment_token_status" NOT NULL DEFAULT 'ACTIVE',
    "registered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_method_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donation" (
    "id" TEXT NOT NULL,
    "transaction_no" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "donor_id" TEXT,
    "mo_message_id" TEXT,
    "amount" BIGINT NOT NULL,
    "display_name" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "message_raw_enc" TEXT,
    "status" "donation_status" NOT NULL DEFAULT 'RECEIVED',
    "status_reason" TEXT,
    "payment_mode" "payment_mode" NOT NULL DEFAULT 'CONFIRM_LINK',
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "pg_fee" BIGINT NOT NULL DEFAULT 0,
    "platform_fee" BIGINT NOT NULL DEFAULT 0,
    "net_amount" BIGINT NOT NULL DEFAULT 0,
    "mt_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "youtube_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "overlay_status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMPTZ(3),
    "broadcasted_at" TIMESTAMPTZ(3),
    "refunded_at" TIMESTAMPTZ(3),
    "settled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donation_status_log" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "from_status" "donation_status",
    "to_status" "donation_status" NOT NULL,
    "reason" TEXT,
    "actor" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "donation_status_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_transaction" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "order_no" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'HECTO',
    "provider_tid" TEXT,
    "amount" BIGINT NOT NULL,
    "status" "payment_tx_status" NOT NULL DEFAULT 'REQUESTED',
    "result_code" TEXT,
    "result_message" TEXT,
    "raw_masked" JSONB,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(3),
    "canceled_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_attempt" (
    "id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "request_masked" JSONB,
    "response_masked" JSONB,
    "latency_ms" INTEGER,
    "error_code" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT,
    "status" "refund_status" NOT NULL DEFAULT 'REQUESTED',
    "requested_by" TEXT,
    "approved_by" TEXT,
    "provider_tid" TEXT,
    "result_code" TEXT,
    "result_message" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "resource_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "result_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donation_limit_policy" (
    "id" TEXT NOT NULL,
    "scope" "policy_scope" NOT NULL DEFAULT 'GLOBAL',
    "creator_id" TEXT,
    "donor_id" TEXT,
    "default_amount" BIGINT NOT NULL DEFAULT 3000,
    "min_amount" BIGINT NOT NULL DEFAULT 1000,
    "max_amount" BIGINT NOT NULL DEFAULT 50000,
    "donor_daily_limit" BIGINT NOT NULL DEFAULT 100000,
    "donor_monthly_limit" BIGINT NOT NULL DEFAULT 1000000,
    "per_creator_daily_limit" BIGINT NOT NULL DEFAULT 50000,
    "velocity_window_sec" INTEGER NOT NULL DEFAULT 60,
    "velocity_max_count" INTEGER NOT NULL DEFAULT 3,
    "cooldown_after_count" INTEGER NOT NULL DEFAULT 5,
    "cooldown_sec" INTEGER NOT NULL DEFAULT 300,
    "failure_lock_threshold" INTEGER NOT NULL DEFAULT 3,
    "new_donor_first_day_limit" BIGINT NOT NULL DEFAULT 30000,
    "manual_review_amount" BIGINT NOT NULL DEFAULT 200000,
    "tts_min_amount" BIGINT NOT NULL DEFAULT 3000,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "donation_limit_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "donation_counter" (
    "id" TEXT NOT NULL,
    "donor_id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL DEFAULT 'ALL',
    "period_type" TEXT NOT NULL,
    "period_key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "donation_counter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_detection" (
    "id" TEXT NOT NULL,
    "donor_id" TEXT,
    "creator_id" TEXT,
    "donation_id" TEXT,
    "type" "risk_type" NOT NULL,
    "level" "risk_level" NOT NULL DEFAULT 'LOW',
    "detail" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_detection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banned_word" (
    "id" TEXT NOT NULL,
    "word" TEXT NOT NULL,
    "action" "content_action" NOT NULL DEFAULT 'MASK',
    "scope" "policy_scope" NOT NULL DEFAULT 'GLOBAL',
    "creator_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banned_word_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_connection" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "channel_title" TEXT,
    "channel_thumb" TEXT,
    "access_token_enc" TEXT NOT NULL,
    "refresh_token_enc" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "status" "youtube_connection_status" NOT NULL DEFAULT 'CONNECTED',
    "last_error" TEXT,
    "last_checked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "youtube_connection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_broadcast" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "broadcast_id" TEXT NOT NULL,
    "live_chat_id" TEXT,
    "title" TEXT,
    "life_cycle" TEXT,
    "chat_enabled" BOOLEAN NOT NULL DEFAULT true,
    "started_at" TIMESTAMPTZ(3),
    "ended_at" TIMESTAMPTZ(3),
    "detected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "youtube_chat_delivery" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT NOT NULL,
    "broadcast_id" TEXT,
    "live_chat_id" TEXT,
    "status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_message_id" TEXT,
    "quota_units" INTEGER NOT NULL DEFAULT 0,
    "error_code" TEXT,
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "youtube_chat_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_channel" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "ingest_url" TEXT NOT NULL,
    "playback_url" TEXT,
    "live" BOOLEAN NOT NULL DEFAULT false,
    "last_live_at" TIMESTAMPTZ(3),
    "simulcast" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "stream_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stream_key" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "key_masked" TEXT NOT NULL,
    "status" "stream_key_status" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "stream_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overlay_setting" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "token_masked" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "show_amount" BOOLEAN NOT NULL DEFAULT true,
    "show_message" BOOLEAN NOT NULL DEFAULT true,
    "max_message_len" INTEGER NOT NULL DEFAULT 80,
    "anonymize" BOOLEAN NOT NULL DEFAULT false,
    "position" TEXT NOT NULL DEFAULT 'BOTTOM_CENTER',
    "duration_ms" INTEGER NOT NULL DEFAULT 7000,
    "theme" TEXT NOT NULL DEFAULT 'TORNADO',
    "sticker_set" TEXT NOT NULL DEFAULT 'DEFAULT',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "overlay_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "overlay_event" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "donation_id" TEXT,
    "payload" JSONB NOT NULL,
    "status" "delivery_status" NOT NULL DEFAULT 'PENDING',
    "is_test" BOOLEAN NOT NULL DEFAULT false,
    "played_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "overlay_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tts_setting" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "voice" TEXT NOT NULL DEFAULT 'ko-KR-Standard-A',
    "speed" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "volume" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "read_amount" BOOLEAN NOT NULL DEFAULT true,
    "read_name" BOOLEAN NOT NULL DEFAULT true,
    "min_amount" BIGINT NOT NULL DEFAULT 3000,
    "max_chars" INTEGER NOT NULL DEFAULT 80,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tts_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_policy" (
    "id" TEXT NOT NULL,
    "scope" "policy_scope" NOT NULL DEFAULT 'GLOBAL',
    "creator_id" TEXT,
    "pg_fee_rate" DECIMAL(10,6) NOT NULL DEFAULT 0.018,
    "pg_fixed_fee" BIGINT NOT NULL DEFAULT 0,
    "platform_fee_rate" DECIMAL(10,6) NOT NULL DEFAULT 0.15,
    "sms_cost" BIGINT NOT NULL DEFAULT 0,
    "vat_included" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_to" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_account" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "bank_code" TEXT NOT NULL,
    "bank_name" TEXT NOT NULL,
    "account_enc" TEXT NOT NULL,
    "account_tail4" TEXT NOT NULL,
    "holder_name_enc" TEXT NOT NULL,
    "holder_masked" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlement_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_ledger" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "entry_type" "ledger_entry_type" NOT NULL,
    "amount" BIGINT NOT NULL,
    "donation_id" TEXT,
    "refund_id" TEXT,
    "request_id" TEXT,
    "memo" TEXT,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "settlement_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_request" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "status" "settlement_request_status" NOT NULL DEFAULT 'REQUESTED',
    "withholding" BIGINT NOT NULL DEFAULT 0,
    "payout_amount" BIGINT NOT NULL DEFAULT 0,
    "memo" TEXT,
    "admin_id" TEXT,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approved_at" TIMESTAMPTZ(3),
    "paid_at" TIMESTAMPTZ(3),
    "rejected_at" TIMESTAMPTZ(3),

    CONSTRAINT "settlement_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terms_version" (
    "id" TEXT NOT NULL,
    "type" "consent_type" NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "effective_from" TIMESTAMPTZ(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terms_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_record" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "phone_hash" TEXT,
    "terms_id" TEXT NOT NULL,
    "type" "consent_type" NOT NULL,
    "agreed" BOOLEAN NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "channel" "notification_channel" NOT NULL DEFAULT 'IN_APP',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link_url" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" TEXT NOT NULL,
    "donation_id" TEXT,
    "creator_id" TEXT,
    "reporter_hash" TEXT,
    "category" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" "report_status" NOT NULL DEFAULT 'OPEN',
    "handled_by" TEXT,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit_log" (
    "id" TEXT NOT NULL,
    "admin_id" TEXT,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "before_value" JSONB,
    "after_value" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_log" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "headers_mask" JSONB,
    "body_masked" JSONB,
    "signature_ok" BOOLEAN NOT NULL DEFAULT false,
    "ip" TEXT,
    "status_code" INTEGER,
    "response_note" TEXT,
    "latency_ms" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "memo" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "banner" (
    "id" TEXT NOT NULL,
    "position" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "image_url" TEXT,
    "link_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "starts_at" TIMESTAMPTZ(3),
    "ends_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "banner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_post" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "content_post_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_user_email_key" ON "app_user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_phone_hash_key" ON "app_user"("phone_hash");

-- CreateIndex
CREATE INDEX "app_user_role_status_idx" ON "app_user"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_session_token_hash_key" ON "user_session"("token_hash");

-- CreateIndex
CREATE INDEX "user_session_user_id_idx" ON "user_session"("user_id");

-- CreateIndex
CREATE INDEX "user_session_expires_at_idx" ON "user_session"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_profile_user_id_key" ON "admin_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "donor_profile_user_id_key" ON "donor_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "donor_profile_phone_hash_key" ON "donor_profile"("phone_hash");

-- CreateIndex
CREATE INDEX "donor_profile_locked_until_idx" ON "donor_profile"("locked_until");

-- CreateIndex
CREATE INDEX "donor_creator_link_creator_id_idx" ON "donor_creator_link"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "donor_creator_link_donor_id_creator_id_key" ON "donor_creator_link"("donor_id", "creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "blocked_donor_creator_id_donor_id_key" ON "blocked_donor"("creator_id", "donor_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_profile_user_id_key" ON "creator_profile"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_profile_code_key" ON "creator_profile"("code");

-- CreateIndex
CREATE INDEX "creator_profile_status_idx" ON "creator_profile"("status");

-- CreateIndex
CREATE UNIQUE INDEX "creator_code_code_key" ON "creator_code"("code");

-- CreateIndex
CREATE INDEX "creator_code_creator_id_idx" ON "creator_code"("creator_id");

-- CreateIndex
CREATE INDEX "creator_mo_number_status_idx" ON "creator_mo_number"("status");

-- CreateIndex
CREATE INDEX "creator_mo_number_creator_id_idx" ON "creator_mo_number"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "creator_mo_number_phone_number_keyword_key" ON "creator_mo_number"("phone_number", "keyword");

-- CreateIndex
CREATE UNIQUE INDEX "mo_inbound_message_provider_message_id_key" ON "mo_inbound_message"("provider_message_id");

-- CreateIndex
CREATE INDEX "mo_inbound_message_creator_id_received_at_idx" ON "mo_inbound_message"("creator_id", "received_at");

-- CreateIndex
CREATE INDEX "mo_inbound_message_phone_hash_received_at_idx" ON "mo_inbound_message"("phone_hash", "received_at");

-- CreateIndex
CREATE INDEX "mo_inbound_message_result_idx" ON "mo_inbound_message"("result");

-- CreateIndex
CREATE INDEX "mt_outbound_message_phone_hash_created_at_idx" ON "mt_outbound_message"("phone_hash", "created_at");

-- CreateIndex
CREATE INDEX "mt_outbound_message_status_idx" ON "mt_outbound_message"("status");

-- CreateIndex
CREATE INDEX "mt_outbound_message_donation_id_idx" ON "mt_outbound_message"("donation_id");

-- CreateIndex
CREATE UNIQUE INDEX "secure_link_token_hash_key" ON "secure_link"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "secure_link_donation_id_key" ON "secure_link"("donation_id");

-- CreateIndex
CREATE INDEX "secure_link_phone_hash_idx" ON "secure_link"("phone_hash");

-- CreateIndex
CREATE INDEX "secure_link_expires_at_idx" ON "secure_link"("expires_at");

-- CreateIndex
CREATE INDEX "payment_registration_donor_id_idx" ON "payment_registration"("donor_id");

-- CreateIndex
CREATE INDEX "payment_registration_status_idx" ON "payment_registration"("status");

-- CreateIndex
CREATE INDEX "payment_method_token_donor_id_status_idx" ON "payment_method_token"("donor_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "donation_transaction_no_key" ON "donation"("transaction_no");

-- CreateIndex
CREATE UNIQUE INDEX "donation_mo_message_id_key" ON "donation"("mo_message_id");

-- CreateIndex
CREATE INDEX "donation_creator_id_received_at_idx" ON "donation"("creator_id", "received_at");

-- CreateIndex
CREATE INDEX "donation_donor_id_received_at_idx" ON "donation"("donor_id", "received_at");

-- CreateIndex
CREATE INDEX "donation_status_idx" ON "donation"("status");

-- CreateIndex
CREATE INDEX "donation_received_at_idx" ON "donation"("received_at");

-- CreateIndex
CREATE INDEX "donation_status_log_donation_id_idx" ON "donation_status_log"("donation_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_transaction_order_no_key" ON "payment_transaction"("order_no");

-- CreateIndex
CREATE INDEX "payment_transaction_donation_id_idx" ON "payment_transaction"("donation_id");

-- CreateIndex
CREATE INDEX "payment_transaction_status_idx" ON "payment_transaction"("status");

-- CreateIndex
CREATE INDEX "payment_transaction_provider_tid_idx" ON "payment_transaction"("provider_tid");

-- CreateIndex
CREATE INDEX "payment_attempt_transaction_id_idx" ON "payment_attempt"("transaction_id");

-- CreateIndex
CREATE INDEX "refund_donation_id_idx" ON "refund"("donation_id");

-- CreateIndex
CREATE INDEX "refund_status_idx" ON "refund"("status");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_scope_key_key" ON "idempotency_key"("scope", "key");

-- CreateIndex
CREATE INDEX "donation_limit_policy_scope_active_idx" ON "donation_limit_policy"("scope", "active");

-- CreateIndex
CREATE INDEX "donation_counter_period_key_idx" ON "donation_counter"("period_key");

-- CreateIndex
CREATE UNIQUE INDEX "donation_counter_donor_id_creator_id_period_type_period_key_key" ON "donation_counter"("donor_id", "creator_id", "period_type", "period_key");

-- CreateIndex
CREATE INDEX "risk_detection_level_resolved_idx" ON "risk_detection"("level", "resolved");

-- CreateIndex
CREATE INDEX "risk_detection_created_at_idx" ON "risk_detection"("created_at");

-- CreateIndex
CREATE INDEX "banned_word_word_idx" ON "banned_word"("word");

-- CreateIndex
CREATE INDEX "banned_word_scope_active_idx" ON "banned_word"("scope", "active");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_connection_creator_id_key" ON "youtube_connection"("creator_id");

-- CreateIndex
CREATE INDEX "youtube_broadcast_creator_id_detected_at_idx" ON "youtube_broadcast"("creator_id", "detected_at");

-- CreateIndex
CREATE UNIQUE INDEX "youtube_broadcast_creator_id_broadcast_id_key" ON "youtube_broadcast"("creator_id", "broadcast_id");

-- CreateIndex
CREATE INDEX "youtube_chat_delivery_donation_id_idx" ON "youtube_chat_delivery"("donation_id");

-- CreateIndex
CREATE INDEX "youtube_chat_delivery_status_idx" ON "youtube_chat_delivery"("status");

-- CreateIndex
CREATE UNIQUE INDEX "stream_channel_creator_id_key" ON "stream_channel"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "stream_key_key_hash_key" ON "stream_key"("key_hash");

-- CreateIndex
CREATE INDEX "stream_key_channel_id_status_idx" ON "stream_key"("channel_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "overlay_setting_creator_id_key" ON "overlay_setting"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "overlay_setting_token_hash_key" ON "overlay_setting"("token_hash");

-- CreateIndex
CREATE INDEX "overlay_event_creator_id_created_at_idx" ON "overlay_event"("creator_id", "created_at");

-- CreateIndex
CREATE INDEX "overlay_event_status_idx" ON "overlay_event"("status");

-- CreateIndex
CREATE UNIQUE INDEX "tts_setting_creator_id_key" ON "tts_setting"("creator_id");

-- CreateIndex
CREATE INDEX "fee_policy_scope_active_idx" ON "fee_policy"("scope", "active");

-- CreateIndex
CREATE UNIQUE INDEX "settlement_account_creator_id_key" ON "settlement_account"("creator_id");

-- CreateIndex
CREATE INDEX "settlement_ledger_creator_id_occurred_at_idx" ON "settlement_ledger"("creator_id", "occurred_at");

-- CreateIndex
CREATE INDEX "settlement_ledger_settlement_key_idx" ON "settlement_ledger"("settlement_key");

-- CreateIndex
CREATE INDEX "settlement_ledger_donation_id_idx" ON "settlement_ledger"("donation_id");

-- CreateIndex
CREATE INDEX "settlement_request_creator_id_requested_at_idx" ON "settlement_request"("creator_id", "requested_at");

-- CreateIndex
CREATE INDEX "settlement_request_status_idx" ON "settlement_request"("status");

-- CreateIndex
CREATE INDEX "terms_version_type_active_idx" ON "terms_version"("type", "active");

-- CreateIndex
CREATE UNIQUE INDEX "terms_version_type_version_key" ON "terms_version"("type", "version");

-- CreateIndex
CREATE INDEX "consent_record_phone_hash_idx" ON "consent_record"("phone_hash");

-- CreateIndex
CREATE INDEX "consent_record_user_id_idx" ON "consent_record"("user_id");

-- CreateIndex
CREATE INDEX "notification_user_id_created_at_idx" ON "notification"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "report_status_created_at_idx" ON "report"("status", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_admin_id_created_at_idx" ON "admin_audit_log"("admin_id", "created_at");

-- CreateIndex
CREATE INDEX "admin_audit_log_target_type_target_id_idx" ON "admin_audit_log"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "webhook_log_source_created_at_idx" ON "webhook_log"("source", "created_at");

-- CreateIndex
CREATE INDEX "webhook_log_signature_ok_idx" ON "webhook_log"("signature_ok");

-- CreateIndex
CREATE INDEX "banner_position_active_idx" ON "banner"("position", "active");

-- CreateIndex
CREATE INDEX "content_post_type_published_idx" ON "content_post"("type", "published");

-- AddForeignKey
ALTER TABLE "user_session" ADD CONSTRAINT "user_session_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_profile" ADD CONSTRAINT "admin_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donor_profile" ADD CONSTRAINT "donor_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donor_creator_link" ADD CONSTRAINT "donor_creator_link_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donor_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donor_creator_link" ADD CONSTRAINT "donor_creator_link_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_donor" ADD CONSTRAINT "blocked_donor_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_donor" ADD CONSTRAINT "blocked_donor_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donor_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_profile" ADD CONSTRAINT "creator_profile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_code" ADD CONSTRAINT "creator_code_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creator_mo_number" ADD CONSTRAINT "creator_mo_number_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mo_inbound_message" ADD CONSTRAINT "mo_inbound_message_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mt_outbound_message" ADD CONSTRAINT "mt_outbound_message_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "secure_link" ADD CONSTRAINT "secure_link_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_registration" ADD CONSTRAINT "payment_registration_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donor_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_method_token" ADD CONSTRAINT "payment_method_token_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donor_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation" ADD CONSTRAINT "donation_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation" ADD CONSTRAINT "donation_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donor_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation" ADD CONSTRAINT "donation_mo_message_id_fkey" FOREIGN KEY ("mo_message_id") REFERENCES "mo_inbound_message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_status_log" ADD CONSTRAINT "donation_status_log_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_attempt" ADD CONSTRAINT "payment_attempt_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "payment_transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund" ADD CONSTRAINT "refund_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_limit_policy" ADD CONSTRAINT "donation_limit_policy_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "donation_counter" ADD CONSTRAINT "donation_counter_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donor_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_detection" ADD CONSTRAINT "risk_detection_donor_id_fkey" FOREIGN KEY ("donor_id") REFERENCES "donor_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banned_word" ADD CONSTRAINT "banned_word_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_connection" ADD CONSTRAINT "youtube_connection_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_broadcast" ADD CONSTRAINT "youtube_broadcast_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_chat_delivery" ADD CONSTRAINT "youtube_chat_delivery_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "youtube_chat_delivery" ADD CONSTRAINT "youtube_chat_delivery_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "youtube_broadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_channel" ADD CONSTRAINT "stream_channel_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stream_key" ADD CONSTRAINT "stream_key_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "stream_channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overlay_setting" ADD CONSTRAINT "overlay_setting_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "overlay_event" ADD CONSTRAINT "overlay_event_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tts_setting" ADD CONSTRAINT "tts_setting_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_policy" ADD CONSTRAINT "fee_policy_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_account" ADD CONSTRAINT "settlement_account_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_ledger" ADD CONSTRAINT "settlement_ledger_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_ledger" ADD CONSTRAINT "settlement_ledger_donation_id_fkey" FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_ledger" ADD CONSTRAINT "settlement_ledger_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "settlement_request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_request" ADD CONSTRAINT "settlement_request_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "creator_profile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_record" ADD CONSTRAINT "consent_record_terms_id_fkey" FOREIGN KEY ("terms_id") REFERENCES "terms_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit_log" ADD CONSTRAINT "admin_audit_log_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

