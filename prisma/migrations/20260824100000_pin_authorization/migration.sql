-- PIN 인증 결제 흐름.
--
-- MO 수신 → (빌키 있음) → 후원 생성 → 결제사에 PIN 링크 요청 → MT 발송 →
-- 후원자 PIN 입력 → 결제사 콜백 → 승인(executePayment).
--
-- 기존 CONFIRM_LINK(토네이도 자체 확인 페이지) 경로는 그대로 남겨 두고
-- ALLOW_LEGACY_CONFIRM_LINK 플래그로만 사용한다. 따라서 PENDING_CONFIRM 은 삭제하지 않는다.

-- 후원 상태에 'PIN 인증 대기' 추가.
-- 값 추가만 하고 같은 마이그레이션 안에서 그 값을 사용하지 않는다(PostgreSQL 제약).
ALTER TYPE "donation_status" ADD VALUE IF NOT EXISTS 'PENDING_PIN' AFTER 'PENDING_CONFIRM';

CREATE TYPE "pin_session_status" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'FAILED');

CREATE TABLE "payment_pin_session" (
  "id"               TEXT NOT NULL,
  "donation_id"      TEXT NOT NULL,
  "provider"         TEXT NOT NULL,
  "method"           "payment_method_kind" NOT NULL DEFAULT 'ACCOUNT',
  "session_id"       TEXT NOT NULL,
  "pin_url_masked"   TEXT NOT NULL,
  "amount"           BIGINT NOT NULL,
  "status"           "pin_session_status" NOT NULL DEFAULT 'PENDING',
  "mock"             BOOLEAN NOT NULL DEFAULT false,
  "callback_count"   INTEGER NOT NULL DEFAULT 0,
  "result_note"      TEXT,
  "expires_at"       TIMESTAMPTZ(3) NOT NULL,
  "completed_at"     TIMESTAMPTZ(3),
  "last_callback_at" TIMESTAMPTZ(3),
  "created_at"       TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "payment_pin_session_pkey" PRIMARY KEY ("id")
);

-- 후원 1건당 인증 세션 1건. 콜백 중복 수신에 대한 DB 레벨 마지막 방어선이다.
CREATE UNIQUE INDEX "payment_pin_session_donation_id_key" ON "payment_pin_session"("donation_id");
CREATE UNIQUE INDEX "payment_pin_session_session_id_key" ON "payment_pin_session"("session_id");
CREATE INDEX "payment_pin_session_status_expires_at_idx" ON "payment_pin_session"("status", "expires_at");

ALTER TABLE "payment_pin_session"
  ADD CONSTRAINT "payment_pin_session_donation_id_fkey"
  FOREIGN KEY ("donation_id") REFERENCES "donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
