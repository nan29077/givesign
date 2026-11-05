-- 고도화 3단계: 저니(자동 안내 흐름) 설정 · 실행 · 단계 기록

CREATE TABLE "journey_setting" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "journey_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "approvals" JSONB NOT NULL DEFAULT '{}',
    "params" JSONB NOT NULL DEFAULT '{}',
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "journey_setting_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "journey_setting_merchant_id_journey_key_key" ON "journey_setting"("merchant_id", "journey_key");

CREATE TABLE "journey_run" (
    "id" TEXT NOT NULL,
    "merchant_id" TEXT NOT NULL,
    "journey_key" TEXT NOT NULL,
    "trigger_key" TEXT NOT NULL,
    "event_id" TEXT,
    "payer_id" TEXT,
    "subject_type" TEXT,
    "subject_id" TEXT,
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "due_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_at" TIMESTAMPTZ(3),
    "locked_by" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "journey_run_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "journey_run_trigger_key_key" ON "journey_run"("trigger_key");
CREATE INDEX "journey_run_status_due_at_idx" ON "journey_run"("status", "due_at");
CREATE INDEX "journey_run_merchant_id_journey_key_started_at_idx" ON "journey_run"("merchant_id", "journey_key", "started_at");
CREATE INDEX "journey_run_merchant_id_payer_id_started_at_idx" ON "journey_run"("merchant_id", "payer_id", "started_at");

CREATE TABLE "journey_step_log" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "step_index" INTEGER NOT NULL,
    "step_key" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "sent" BOOLEAN NOT NULL DEFAULT false,
    "detail" TEXT,
    "merchant_id" TEXT NOT NULL,
    "payer_id" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "journey_step_log_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "journey_step_log_run_id_at_idx" ON "journey_step_log"("run_id", "at");
CREATE INDEX "journey_step_log_merchant_id_payer_id_sent_at_idx" ON "journey_step_log"("merchant_id", "payer_id", "sent", "at");
ALTER TABLE "journey_step_log" ADD CONSTRAINT "journey_step_log_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "journey_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
