-- 2026-11-09 1차 과제 A
--  A1 정기후원 실패 원인별 복구: 약정 복구 상태·실패 원인, 실행 기록의 원인·결과 코드·복구 여부, 후원자 복구 링크, 일시정지 재개 예정일
--  A2 (선택) 기관 소식·후원 안내 수신 동의: 후원자x기관 동의 시각·철회 시각·받은 곳, 동의·철회 이력, 결제 성공 시 반영할 동의 의사
--  추가만 한다(기존 컬럼·행을 바꾸지 않는다). 새 컬럼의 기본값은 지금 동작과 같다(recovery_state=NONE, recovered=false).

-- CreateEnum
CREATE TYPE "recurring_recovery_state" AS ENUM ('NONE', 'RETRYING', 'ACTION_REQUIRED');

-- AlterTable
ALTER TABLE "payer_merchant_link" ADD COLUMN     "marketing_consent_at" TIMESTAMPTZ(3),
ADD COLUMN     "marketing_consent_source" TEXT,
ADD COLUMN     "marketing_consent_withdrawn_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "recurring_donation" ADD COLUMN     "action_deadline_on" DATE,
ADD COLUMN     "last_failure_class" TEXT,
ADD COLUMN     "recovery_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "recovery_state" "recurring_recovery_state" NOT NULL DEFAULT 'NONE',
ADD COLUMN     "resume_notice_sent_at" TIMESTAMPTZ(3),
ADD COLUMN     "resume_on" DATE;

-- AlterTable
ALTER TABLE "recurring_run" ADD COLUMN     "failure_class" TEXT,
ADD COLUMN     "recovered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "result_code" TEXT;

-- CreateTable
CREATE TABLE "recurring_recovery_link" (
    "id" TEXT NOT NULL,
    "recurring_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "last_opened_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_recovery_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consent_log" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "agreed" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "wording_version" TEXT NOT NULL,
    "wording" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_consent_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marketing_consent_intent" (
    "charge_id" TEXT NOT NULL,
    "payer_id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "applied_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_consent_intent_pkey" PRIMARY KEY ("charge_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recurring_recovery_link_token_hash_key" ON "recurring_recovery_link"("token_hash");

-- CreateIndex
CREATE INDEX "recurring_recovery_link_recurring_id_revoked_at_idx" ON "recurring_recovery_link"("recurring_id", "revoked_at");

-- CreateIndex
CREATE INDEX "marketing_consent_log_merchant_id_created_at_idx" ON "marketing_consent_log"("merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "marketing_consent_log_payer_id_merchant_id_created_at_idx" ON "marketing_consent_log"("payer_id", "merchant_id", "created_at");

-- CreateIndex
CREATE INDEX "payer_merchant_link_merchant_id_marketing_consent_at_idx" ON "payer_merchant_link"("merchant_id", "marketing_consent_at");

-- CreateIndex
CREATE INDEX "recurring_donation_status_resume_on_idx" ON "recurring_donation"("status", "resume_on");

-- CreateIndex
CREATE INDEX "recurring_donation_merchant_id_recovery_state_idx" ON "recurring_donation"("merchant_id", "recovery_state");

-- AddForeignKey
ALTER TABLE "recurring_recovery_link" ADD CONSTRAINT "recurring_recovery_link_recurring_id_fkey" FOREIGN KEY ("recurring_id") REFERENCES "recurring_donation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consent_log" ADD CONSTRAINT "marketing_consent_log_link_id_fkey" FOREIGN KEY ("link_id") REFERENCES "payer_merchant_link"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marketing_consent_intent" ADD CONSTRAINT "marketing_consent_intent_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "charge"("id") ON DELETE CASCADE ON UPDATE CASCADE;

